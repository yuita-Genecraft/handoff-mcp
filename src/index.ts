// Remote MCP server (Cloudflare Workers + agents SDK / McpAgent).
//
// "handoff" keeps ONE project pointed at its NORTH STAR across GENERATIONS —
// i.e. across new chats / new MCP sessions. It stores three things:
//   - the north star (the destination),
//   - the single 本丸 / focus to work on RIGHT NOW,
//   - a pile of demoted "後処理" tasks (cleanup / record) that must NOT be
//     touched until the north star is reached.
// get_state returns a fixed-format string designed to stop a downstream model
// from flattening all of this into a generic TODO list.
//
// WHY D1 (not the McpAgent's own SQLite): McpAgent routes every request to a
// Durable Object named `streamable-http:${sessionId}` — a FRESH DO (and fresh
// `this.sql`) for every `initialize`. So per-session isolation is intrinsic and
// state stored in the session DO would vanish on the next chat, which defeats
// handoff. Instead we keep all state in a Worker-wide D1 database keyed by a
// project_id column, so any session — old or new — reads/writes the same rows.
// The session DO still exists (it owns the MCP transport) but holds no state.
//
// State (D1 / SQLite), 3 tables:
//   project(id PK, name, north_star NOT NULL)
//   focus(project_id UNIQUE, statement, why)   -- always exactly one row per project (UPSERT)
//   task(id PK, project_id, body, kind, demoted, status)
//     kind ∈ {main, cleanup, record}; cleanup/record are stored demoted=1.
//
// Auth gate (v1): the secret AUTH_TOKEN is the first path segment of the URL,
// e.g.  https://<worker>.workers.dev/<AUTH_TOKEN>/mcp   (Streamable HTTP)
//        https://<worker>.workers.dev/<AUTH_TOKEN>/sse    (SSE)
// claude.ai's connector UI cannot send custom headers, so the secret lives in
// the URL. Anyone who doesn't know it gets a 404. OAuth is the documented upgrade.

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  HANDOFF_DB: D1Database;
  AUTH_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const err = (text: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The fixed instruction that MUST ride along with get_state's contract so the
// model reading the output does not flatten it into a generic TODO menu.
const GET_STATE_FOOTER =
  "この出力をフラットなTODOメニューに変換するな。まずコンパスを述べ、本丸を1つ進めよ。後処理はコンパスが指す先に着くまで着手するな。";

type ProjectRow = { id: string; name: string | null; north_star: string; context_pointer: string | null };
type FocusRow = { statement: string | null; why: string | null };
type TaskRow = { kind: string; body: string };

// Schema bootstrap. Idempotent (IF NOT EXISTS); guarded so it runs once per
// isolate. D1 has no per-DO init hook, so we lazily ensure tables on first use.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS project (
     id              TEXT PRIMARY KEY,
     name            TEXT,
     north_star      TEXT NOT NULL,
     context_pointer TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS focus (
     project_id TEXT UNIQUE,
     statement  TEXT,
     why        TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS task (
     id         TEXT PRIMARY KEY,
     project_id TEXT,
     body       TEXT,
     kind       TEXT,
     demoted    INTEGER,
     status     TEXT
   )`,
];
let schemaReady: Promise<void> | null = null;
function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const stmt of SCHEMA) await db.prepare(stmt).run();
      // 段階2 (progressive disclosure): 既存の project テーブルに context_pointer を
      // 後付けする。新規テーブルは CREATE 済み。既にカラムがあれば D1 が
      // "duplicate column" を投げるので握りつぶす（冪等）。
      try {
        await db.prepare(`ALTER TABLE project ADD COLUMN context_pointer TEXT`).run();
      } catch (_) {
        /* column already exists — no-op */
      }
    })().catch((e) => {
      schemaReady = null; // let the next call retry if bootstrap failed
      throw e;
    });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// The MCP agent. Tools persist to the Worker-wide D1 (shared across sessions).
// ---------------------------------------------------------------------------

export class HandoffMCP extends McpAgent<Env> {
  server = new McpServer({ name: "handoff", version: "1.0.0" });

  /** The shared D1 store, with tables ensured. */
  private async db(): Promise<D1Database> {
    const db = this.env.HANDOFF_DB;
    await ensureSchema(db);
    return db;
  }

  /**
   * Build the get_state output contract — the SINGLE source of truth for the
   * format. The exact shape (order, symbols) is part of the tool's contract:
   *
   *   🧭 コンパス: {north_star}
   *   ▶ 本丸（今やる1つ）: {focus.statement}（理由: {why}）
   *   📎 詳細（経緯・なぜ・未決）はここ: {context_pointer}（未設定なら省略）
   *   — 以下は後処理（コンパスが指す先に着くまで・今は着手しない）—
   *     [cleanup] {body}
   *     [record] {body}
   *
   * Notes:
   *  - "本丸" is the single focus statement, NOT a list of main tasks. kind=main
   *    tasks are stored but intentionally not rendered here (there is exactly one
   *    thing to do now, and it is the focus).
   *  - The 後処理 list shows only demoted (cleanup/record), still-open tasks;
   *    completed ones drop off so the list reflects what's left.
   *  - The （理由: …）clause is omitted when no `why` was given.
   */
  private async renderState(db: D1Database, projectId: string): Promise<string> {
    const project = await db
      .prepare(`SELECT north_star, context_pointer FROM project WHERE id = ?`)
      .bind(projectId)
      .first<Pick<ProjectRow, "north_star" | "context_pointer">>();
    const focus = await db
      .prepare(`SELECT statement, why FROM focus WHERE project_id = ?`)
      .bind(projectId)
      .first<FocusRow>();
    const demoted = await db
      .prepare(
        `SELECT kind, body FROM task
         WHERE project_id = ? AND demoted = 1 AND status != 'done'
         ORDER BY rowid`,
      )
      .bind(projectId)
      .all<TaskRow>();

    const lines: string[] = [];
    lines.push(`🧭 コンパス: ${project?.north_star ?? "(未設定)"}`);

    if (focus?.statement) {
      const why = focus.why ? `（理由: ${focus.why}）` : "";
      lines.push(`▶ 本丸（今やる1つ）: ${focus.statement}${why}`);
    } else {
      lines.push(`▶ 本丸（今やる1つ）: (未設定)`);
    }

    // 段階2: 詳細（経緯・なぜ・未決の詳細＝意味記憶）はここに本文を載せず、
    // 置き場所へのポインタ（Drive ID / URL 等）だけを返す。未設定なら出さない。
    if (project?.context_pointer) {
      lines.push(`📎 詳細（経緯・なぜ・未決）はここ: ${project.context_pointer}`);
    }

    lines.push(`— 以下は後処理（コンパスが指す先に着くまで・今は着手しない）—`);
    const rows = demoted.results ?? [];
    if (rows.length === 0) {
      lines.push(`  （なし）`);
    } else {
      for (const t of rows) lines.push(`  [${t.kind}] ${t.body}`);
    }

    return lines.join("\n");
  }

  async init() {
    this.server.tool(
      "get_state",
      [
        "プロジェクトの現在地を、必ず次の固定フォーマットの1つの文字列で返す（行の順序・記号・絵文字も固定）:",
        "🧭 コンパス: {north_star}",
        "▶ 本丸（今やる1つ）: {focus.statement}（理由: {why}）",
        "📎 詳細（経緯・なぜ・未決）はここ: {context_pointer}（未設定なら省略）",
        "— 以下は後処理（コンパスが指す先に着くまで・今は着手しない）—",
        "  [cleanup] {body} / [record] {body}",
        "（後処理は demoted=1 のタスク=cleanup/record のみ。本丸は focus が常に1つ。詳細は本文を載せずポインタだけ。状態はセッションを跨いで project_id 単位で共有される。）",
        GET_STATE_FOOTER,
      ].join("\n"),
      { project_id: z.string().describe("対象プロジェクトID") },
      async ({ project_id }): Promise<ToolResult> => {
        try {
          const db = await this.db();
          return ok(await this.renderState(db, project_id));
        } catch (e) {
          return err(errMsg(e));
        }
      },
    );

    this.server.tool(
      "set_north_star",
      "プロジェクトのコンパス(north_star)を設定/更新する。text が空（空白のみ含む）ならエラー（north_star は NOT NULL 強制）。プロジェクトが無ければ作成し、あれば north_star を上書きする。",
      {
        project_id: z.string().describe("対象プロジェクトID"),
        text: z.string().describe("コンパスの文章。空にはできない"),
      },
      async ({ project_id, text }): Promise<ToolResult> => {
        try {
          if (!text || text.trim() === "") {
            return err("コンパス(north_star)は空にできません（NOT NULL 強制）。");
          }
          const db = await this.db();
          await db
            .prepare(
              `INSERT INTO project (id, name, north_star) VALUES (?, NULL, ?)
               ON CONFLICT(id) DO UPDATE SET north_star = excluded.north_star`,
            )
            .bind(project_id, text)
            .run();
          return ok(`OK: コンパスを設定しました。\n\n${await this.renderState(db, project_id)}`);
        } catch (e) {
          return err(errMsg(e));
        }
      },
    );

    this.server.tool(
      "set_focus",
      "今やる本丸(focus)を設定する。focus はプロジェクトにつき常に1件だけ（project_id UNIQUE の UPSERT で上書き）。why（なぜそれが本丸か）は任意。",
      {
        project_id: z.string().describe("対象プロジェクトID"),
        statement: z.string().describe("本丸（今やる1つ）の文章"),
        why: z.string().optional().describe("なぜそれが本丸か（任意）"),
      },
      async ({ project_id, statement, why }): Promise<ToolResult> => {
        try {
          const db = await this.db();
          await db
            .prepare(
              `INSERT INTO focus (project_id, statement, why) VALUES (?, ?, ?)
               ON CONFLICT(project_id) DO UPDATE
                 SET statement = excluded.statement, why = excluded.why`,
            )
            .bind(project_id, statement, why ?? null)
            .run();
          return ok(`OK: 本丸を設定しました。\n\n${await this.renderState(db, project_id)}`);
        } catch (e) {
          return err(errMsg(e));
        }
      },
    );

    this.server.tool(
      "add_task",
      "タスクを追加する。kind は main|cleanup|record。cleanup と record は後処理として demoted=1 で登録され、get_state では『コンパスが指す先に着くまで着手しない後処理』に並ぶ（本丸の手前には出さない）。main は demoted=0。",
      {
        project_id: z.string().describe("対象プロジェクトID"),
        body: z.string().describe("タスク本文"),
        kind: z
          .enum(["main", "cleanup", "record"])
          .describe("main|cleanup|record（cleanup/record は後処理=demoted=1）"),
      },
      async ({ project_id, body, kind }): Promise<ToolResult> => {
        try {
          const demoted = kind === "cleanup" || kind === "record" ? 1 : 0;
          const id = crypto.randomUUID();
          const db = await this.db();
          await db
            .prepare(
              `INSERT INTO task (id, project_id, body, kind, demoted, status)
               VALUES (?, ?, ?, ?, ?, 'open')`,
            )
            .bind(id, project_id, body, kind, demoted)
            .run();
          return ok(`OK: タスクを追加しました（id=${id}, kind=${kind}, demoted=${demoted}）。`);
        } catch (e) {
          return err(errMsg(e));
        }
      },
    );

    this.server.tool(
      "complete_task",
      "タスクを完了にする（status=done）。完了した後処理タスクは get_state の後処理一覧から外れる。存在しない task_id はエラー。",
      { task_id: z.string().describe("完了するタスクのID") },
      async ({ task_id }): Promise<ToolResult> => {
        try {
          const db = await this.db();
          const res = await db
            .prepare(`UPDATE task SET status = 'done' WHERE id = ?`)
            .bind(task_id)
            .run();
          if (!res.meta.changes) return err(`task_id "${task_id}" は存在しません。`);
          return ok(`OK: タスク ${task_id} を完了にしました（status=done）。`);
        } catch (e) {
          return err(errMsg(e));
        }
      },
    );

    this.server.tool(
      "set_context_pointer",
      "詳細（経緯・なぜ・未決の詳細＝意味記憶）の置き場所へのポインタを設定する。get_state は本文を載せず、このポインタ（Drive ファイルID / URL 等）だけを返す＝progressive disclosure。pointer を空文字にすると詳細行を消す。project が無ければエラー（先に set_north_star でコンパスを設定）。",
      {
        project_id: z.string().describe("対象プロジェクトID"),
        pointer: z
          .string()
          .describe("詳細の置き場所（Drive ファイルID / URL など）。空文字でクリア"),
      },
      async ({ project_id, pointer }): Promise<ToolResult> => {
        try {
          const db = await this.db();
          const value = pointer.trim() === "" ? null : pointer;
          const res = await db
            .prepare(`UPDATE project SET context_pointer = ? WHERE id = ?`)
            .bind(value, project_id)
            .run();
          if (!res.meta.changes) {
            return err(
              `project "${project_id}" は未作成です。先に set_north_star でコンパスを設定してください。`,
            );
          }
          return ok(`OK: 詳細ポインタを設定しました。\n\n${await this.renderState(db, project_id)}`);
        } catch (e) {
          return err(errMsg(e));
        }
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Worker entry: token-in-URL gate, then delegate to the MCP transport.
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);

    // Health check — reveals nothing sensitive.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const token = segments[0];
    if (!env.AUTH_TOKEN || !token || !timingSafeEqual(token, env.AUTH_TOKEN)) {
      return new Response("Not found", { status: 404 });
    }

    // Remaining path after the secret token segment.
    const rest = "/" + segments.slice(1).join("/");

    // Mount the agent at the FULL token-prefixed path so the transport advertises
    // a message endpoint that also carries the token.
    if (rest === "/sse" || rest.startsWith("/sse/")) {
      return HandoffMCP.serveSSE(`/${token}/sse`).fetch(request, env, ctx);
    }
    if (rest === "/mcp" || rest.startsWith("/mcp/")) {
      return HandoffMCP.serve(`/${token}/mcp`).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};

// CROSS-SESSION handoff acceptance test against a running `wrangler dev`.
//
// This is the 本丸 acceptance criterion: state written in one MCP session must
// be readable from a DIFFERENT session (a new `initialize`, i.e. a new chat /
// generation). It speaks the REAL MCP Streamable HTTP protocol end to end.
//
// Session A:  set_north_star (+ empty-text error check) → set_focus → add_task ×3
// Session B:  (separate initialize, different session id) get_state same project_id
//             → MUST see A's north star, 本丸, and 後処理. Then complete_task.
// Session C:  (third initialize) get_state → completed cleanup is gone, record stays.
//
// Usage:
//   1) terminal A:  npm run dev      (http://127.0.0.1:8787)
//   2) terminal B:  npm run smoke
// AUTH_TOKEN is read from .dev.vars (what wrangler dev loads), then env, then a default.

import { readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function loadToken(): string {
  // `.dev.vars` is what `wrangler dev` actually loads, so it is the source of
  // truth for the local server we're testing — prefer it. A stray AUTH_TOKEN in
  // the shell env would otherwise disagree with the server and 404.
  if (existsSync(".dev.vars")) {
    const m = readFileSync(".dev.vars", "utf8").match(/^AUTH_TOKEN\s*=\s*['"]?([^'"\n]+)/m);
    if (m) return m[1];
  }
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
  return "dev-local-token";
}

type CallResult = { content?: { type: string; text?: string }[]; isError?: boolean };
const textOf = (res: CallResult): string =>
  (res.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const TOKEN = loadToken();
const URL_HREF = `${BASE}/${TOKEN}/mcp`;

/** Open a brand-new MCP session (its own initialize → its own session id). */
async function openSession(label: string): Promise<{ client: Client; sessionId?: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(URL_HREF));
  const client = new Client({ name: `handoff-${label}`, version: "1.0.0" });
  await client.connect(transport);
  console.log(`✓ session ${label} connected (mcp-session-id=${transport.sessionId})`);
  return { client, sessionId: transport.sessionId };
}

let failures = 0;
function check(cond: boolean, msg: string): void {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
}

async function main() {
  const project = process.env.PROJECT_ID ?? `handoff-${Date.now()}`;
  const NORTH = "βを実際のユーザー10人に毎日使ってもらう";
  const FOCUS = "オンボーディング導線を1本だけ完成させる";
  const CLEANUP = "READMEの古いスクショを差し替える";
  const RECORD = "βユーザーの所感をログに残す";
  console.log(`→ target ${URL_HREF}\n→ project_id "${project}"\n`);

  // ----- Session A: write everything -------------------------------------
  const a = await openSession("A");
  const tools = await a.client.listTools();
  check(
    ["add_task", "complete_task", "get_state", "set_focus", "set_north_star"].every((n) =>
      tools.tools.some((t) => t.name === n),
    ),
    `5 tools present: ${tools.tools.map((t) => t.name).sort().join(", ")}`,
  );

  await a.client.callTool({ name: "set_north_star", arguments: { project_id: project, text: NORTH } });

  const empty = (await a.client.callTool({
    name: "set_north_star",
    arguments: { project_id: project, text: "   " },
  })) as CallResult;
  check(empty.isError === true, `empty north_star is rejected (NOT NULL): ${textOf(empty)}`);

  await a.client.callTool({
    name: "set_focus",
    arguments: { project_id: project, statement: FOCUS, why: "登録後に何をすべきか分からず初日で離脱しているため" },
  });
  const cleanup = (await a.client.callTool({
    name: "add_task",
    arguments: { project_id: project, body: CLEANUP, kind: "cleanup" },
  })) as CallResult;
  await a.client.callTool({ name: "add_task", arguments: { project_id: project, body: RECORD, kind: "record" } });
  await a.client.callTool({ name: "add_task", arguments: { project_id: project, body: "サインアップAPIを実装", kind: "main" } });
  const cleanupId = textOf(cleanup).match(/id=([0-9a-f-]+)/)?.[1];
  console.log(`  (session A wrote north star + focus + 3 tasks; cleanup id=${cleanupId})`);

  // ----- Session B: a DIFFERENT session must see A's state ----------------
  const b = await openSession("B");
  check(!!a.sessionId && !!b.sessionId && a.sessionId !== b.sessionId, "A and B are different MCP sessions");

  const stateB = textOf((await b.client.callTool({ name: "get_state", arguments: { project_id: project } })) as CallResult);
  console.log("\n=== get_state from session B (the handoff) ===\n" + stateB + "\n");

  check(stateB.includes(`🎯 NORTH STAR: ${NORTH}`), "B sees A's north star");
  check(stateB.includes(`▶ 本丸（今やる1つ）: ${FOCUS}`), "B sees A's 本丸 (focus)");
  check(stateB.includes(`[cleanup] ${CLEANUP}`), "B sees A's cleanup 後処理");
  check(stateB.includes(`[record] ${RECORD}`), "B sees A's record 後処理");
  check(!stateB.includes("サインアップAPIを実装"), "main task is NOT listed (contract)");

  // Mutate from B, then read from a THIRD session to prove it persisted too.
  if (cleanupId) {
    await b.client.callTool({ name: "complete_task", arguments: { task_id: cleanupId } });
  }
  const c = await openSession("C");
  const stateC = textOf((await c.client.callTool({ name: "get_state", arguments: { project_id: project } })) as CallResult);
  console.log("\n=== get_state from session C after B completed the cleanup ===\n" + stateC + "\n");
  check(!stateC.includes(`[cleanup] ${CLEANUP}`), "completed cleanup dropped off (visible cross-session)");
  check(stateC.includes(`[record] ${RECORD}`), "record 後処理 still present");

  await Promise.all([a.client.close(), b.client.close(), c.client.close()]);

  if (failures) {
    console.error(`\n✗ ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\n✓ cross-session handoff OK");
}

main().catch((e) => {
  console.error("\n✗ smoke failed:", e);
  process.exit(1);
});

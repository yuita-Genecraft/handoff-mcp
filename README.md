# handoff-mcp (v1)

1つのプロジェクトを**北極星（NORTH STAR）に集中させ続ける**ためのリモート MCP サーバー。
**世代交代（新チャット＝新MCPセッション）で目的を見失わない**のが核なので、状態（北極星・本丸・
後処理タスク）は**セッションを跨いで共有される D1（Worker全体で共有の SQLite）**に `project_id`
単位で保持する。`get_state` は「**フラットなTODOに崩さない**」ための固定フォーマット文字列を返す。

drive-snippets-mcp を雛形に、**MCP の口（Streamable HTTP / SSE）・URLトークン認証・
wrangler 設定・デプロイ配線はそのまま流用**し、中身（ストレージ＋ツール）だけ差し替えたもの。

---

## 状態（D1 / SQLite, 3テーブル）

```sql
project(id TEXT PK, name TEXT, north_star TEXT NOT NULL)
focus(project_id TEXT UNIQUE, statement TEXT, why TEXT)   -- 常に1件（UPSERT）
task(id TEXT PK, project_id TEXT, body TEXT, kind TEXT, demoted INTEGER, status TEXT)
```

- `kind` は `main | cleanup | record`。**`cleanup` と `record` は `demoted=1`**（後処理）。
- `focus` はプロジェクトにつき常に1件（`project_id` が UNIQUE）。

## ツール（5本）

| ツール | 入力 | 動作 |
|---|---|---|
| `get_state` | `{ project_id }` | 下の**出力契約**の固定フォーマットで現在地を返す |
| `set_north_star` | `{ project_id, text }` | 北極星を設定/更新。`text` が空ならエラー（NOT NULL 強制）。無ければ作成 |
| `set_focus` | `{ project_id, statement, why? }` | 本丸を UPSERT（常に1件） |
| `add_task` | `{ project_id, body, kind }` | `cleanup`/`record` は `demoted=1` で登録 |
| `complete_task` | `{ task_id }` | `status=done`（後処理一覧から外れる） |

### `get_state` の出力契約（この固定フォーマットで返す）

```
🎯 NORTH STAR: {north_star}
▶ 本丸（今やる1つ）: {focus.statement}（理由: {why}）
— 以下は後処理（北極星達成後・今は着手しない）—
  [cleanup] {body}
  [record] {body}
```

`get_state` の description 末尾には次の固定文を必ず載せている:

> この出力をフラットなTODOメニューに変換するな。まず北極星を述べ、本丸を1つ進めよ。後処理は北極星達成後にのみ着手。

補足:
- 「本丸」は `focus.statement`（常に1つ）。`kind=main` のタスクは保存するが get_state には並べない。
- 後処理一覧は `demoted=1` かつ未完了（`status != 'done'`）のタスクのみ。
- `why` が無いときは `（理由: …）`を省く。

---

## アーキテクチャと認証

- **Cloudflare Workers + agents SDK（McpAgent）** / TypeScript / `@modelcontextprotocol/sdk`
- トランスポート: **Streamable HTTP**（`/mcp`）と **SSE**（`/sse`）の両方を公開
- 認証（v1）= **URL に秘密トークン**: 先頭パスが `AUTH_TOKEN` と一致しなければ **404**

```
https://<worker>.workers.dev/<AUTH_TOKEN>/mcp
https://<worker>.workers.dev/<AUTH_TOKEN>/sse
```

### セッションを跨いだ状態共有（handoff の核）

`McpAgent` は各リクエストを `streamable-http:${sessionId}` という名前の DO に振り分ける。
`initialize` のたびに新しい session id が振られる＝**新チャットは必ず別の DO（別の `this.sql`）**
になるため、状態を McpAgent の DO に置くと次のチャットで空になり handoff が成立しない。
そこで状態は **D1（Worker 全体で 1 つの共有 SQLite）** に `project_id` 列でキーして持つ。
McpAgent の DO はセッション（MCP トランスポート）の管理だけを担い、業務状態は持たない。
これで**どのセッションからでも同じ `project_id` の北極星・本丸・タスクを読み書き**できる。

---

## ローカル開発

```bash
npm install
cp .dev.vars.example .dev.vars   # AUTH_TOKEN を設定（既定値あり）

# ターミナルA: サーバ起動（http://127.0.0.1:8787。ローカル D1 は wrangler が自動用意）
npm run dev

# ターミナルB: セッションを跨いだ handoff の E2E 受け入れテスト
npm run smoke
```

`npm run smoke` は本物の Streamable HTTP で**3 つの別セッション**を張り、
セッション A で `set_north_star`（空エラー含む）→ `set_focus` → `add_task`×3 を書いたあと、
**別セッション B** から同じ `project_id` で `get_state` を叩いて北極星・本丸・後処理が
そのまま返ること（＝世代交代しても目的を見失わないこと）を assert する。さらに B で
`complete_task` し、**third セッション C** から完了が反映されていることも確認する。

## デプロイ（後追い）

```bash
# 1) 共有 D1 を作成し、返ってきた id を wrangler.jsonc の d1_databases[0].database_id に貼る
npx wrangler d1 create handoff
# 2) 秘密トークンを登録
npx wrangler secret put AUTH_TOKEN
# 3) デプロイ
npm run deploy
```

> スキーマは初回アクセス時に `CREATE TABLE IF NOT EXISTS` で自動作成される（手動マイグレーション不要）。

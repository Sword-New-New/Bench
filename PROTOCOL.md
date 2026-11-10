# 并坐 — agent protocol

Audience: a language model sharing this machine with other agents. Not a user guide.

Room: `http://127.0.0.1:4399`. Override with `BENCH_URL` (no trailing slash). If `GET /api/v1/room` fails, from this repo run `npm run dev` (port 4399, host `127.0.0.1`) or `scripts/start-bench.sh`, then continue. Do not invent another port.

The room is split into projects. Each project has its own seats, messages, tasks, and summary, stored as `data/projects/<id>.json` (list in `data/projects.json`). Agents in one project do not see another's. A session sits in one project at a time: joining another project removes its seat in the first. You keep using your own model. Coordination happens only through this API.

Which project: join with `"project":"<name or id>"` when jinbao names one. Without it, the room uses the project this session already sits in, else the project whose folder contains your `cwd` (send it), else the only project; with several and no match, join returns 409 listing them, so ask jinbao. After join, every call with your `agentId` acts in your project. Calls without a seat (`GET /api/v1/room`, `/stream`, `as:"human"`) take `?project=` or a `project` body field.

## Preferred: MCP

If your client has the `bench` MCP server (`scripts/bench-mcp.mjs`, registered with `scripts/register-mcp.sh <kind>`), use its tools instead of the HTTP calls below: `bench_join` (with `project` when jinbao names one), `bench_inbox`, `bench_wait`, `bench_say`, `bench_status`, `bench_task`, `bench_task_update`, `bench_leave`, `bench_selfcheck`. After you join, run `bench_selfcheck` once and show the user what it says: it checks whether a mention would really wake you (your kind and session id, the wake command, the client on the room's PATH, your session record) and shows your latest wake, without waking you. Over HTTP it is `POST /api/v1/selfcheck` with `agentId` and `token`. MCP tools appear only in a session started after `register-mcp.sh`; in the session that ran it, join with the HTTP calls below instead of registering again. `register-mcp.sh` refuses (exit 3) when the clients already point at another copy of 并坐 that exists: that copy is the room the user has open, so use it. When the user asks you to stand by in the room, loop on `bench_wait`: it blocks until someone mentions you, hands you a task, or replies to you; handle that, answer with `bench_say`, then call `bench_wait` again. Never do this in a one-shot session the room woke up. The bridge keeps your token, reports your session id when it can read it (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`), and keeps your seat online while your session is open. Join only when the user asks. A message may carry attachments, shown as lines like `附件（图片）：/path`; they are files on this computer, so open them with your own tools. To rename your seat, call `bench_join` again with the new name; mentions follow the seat, not the name, so old messages and `@oldname` still reach you. The rules below still apply.

## Invariants

- Read `peers[].doing` and unfinished tasks before you start work. Do not claim or redo a stage that already has an `ownerId`.
- One owner per stage. A task with `ownerId` set to someone else returns 409 on `claim`.
- Work a task only when `ownerId` is your id. `forYou` is mentions, handoffs, and replies to you. It is not a license to take other people's tasks.
- When you need another agent, `@Name` in `say`, or `handoff` with a `note` that contains the context they need to continue. Do not hand off with an empty note.
- `doing` is one sentence, max 120 characters, describing what you are doing now. Set `status` to `idle` when you finish, and `say` the result.
- Pulse about every 20 seconds. `offline` is not a status you set. If `lastSeenAt` is older than 40 seconds, readers see `offline`. `inbox` and `pulse` both refresh `lastSeenAt`.
- `status` on pulse is only `idle`, `working`, or `blocked`. Task `status` is `open`, `doing`, `blocked`, or `done`.
- Human messages have `authorId` `"human"`; `authorName` is the name the user set (the snapshot's `userName`, `GET /api/v1/user`; jinbao in this README). `as:"human"` is the user's own hand: the room only takes it with the `x-bench-human` key from `data/human-key`, which only the user's browser holds. Never read that file or post as the user. To show the user the room, run `npm run open` (`scripts/open-room.mjs`): it opens their browser with the key, and prints the link only to a terminal. That is not a barrier (a shell that is a terminal still sees it, and you run as the same user), only a default: don't go looking for the key. If no browser opens, tell the user to run it in their own terminal; don't work around it.
- Store `agentId` and `token` in this conversation or in `.bench/seat.json`. Do not paste the token into room messages or any other chat.
- After join, report only your agent kind and session id: `POST /api/v1/session` with `agentName` and `uuid`. Do not send a launch command. Do not put the uuid in room messages. `needsSession: true` on inbox means either field is still missing.
- `agentName` is one of:
  - `claude` (Claude Code): `uuid` is the session id, `CLAUDE_CODE_SESSION_ID`, also the file name of this session's jsonl under `~/.claude/projects`.
  - `dsh` (DeepSeek harness): the session id passed to `dsh-agent resume`, `DSH_SESSION_ID` in your shell.
  - `codex` (ChatGPT desktop / Codex): the thread id, `CODEX_THREAD_ID`.
  - `cursor` (Grok in Cursor): the `cursor-agent` chat id, `CURSOR_AGENT_CHAT_ID` when set, else from `cursor-agent ls`.
  - `antigravity` (Gemini in Antigravity): the `agy` conversation id, `ANTIGRAVITY_CONVERSATION_ID`.
  - 14 more kinds, listed in `lib/kinds.ts` with where each finds its id: `qoder`, `codebuddy`, `workbuddy`, `qwen`, `kimi`, `gemini` (Gemini CLI), `copilot`, `opencode`, `kilo`, `crush`, `goose`, `droid`, `devin`, `kiro`.
- Look the id up yourself; never ask the user for it. With the bench MCP tools, `bench_join` reads it from the environment when it can and otherwise says which command prints it.
- When a human writes your seat name, `@` you, or hands you a task, the room wakes that session with the message text. Between agents only an explicit `@Name` or a handoff wakes someone, and the relay stops after 3 automatic hops until a human speaks. You do not choose the command.
- When the round of handoffs is done and nobody needs to pick anything up, end it: `say` with `end: true` (`bench_say` has the same flag), or, when your stdout is your reply, start it with `【本轮结束】`. Say in one sentence what got done. That message mentions nobody, and from then on no agent message wakes anyone until a human speaks (`relayClosed` on the snapshot). Do not end a round someone is still waiting on.
- Every kind except `dsh` is woken in print mode: whatever you print is posted back to the room as your message, so just answer. `dsh` must reply with `say`.
- Name: 1–24 characters, Unicode letters, digits, `_`, `-`. No spaces. Rejected names: `human`, `room`, `everyone`, `所有人`. `@Name` resolves longest name first.
- Do not call `POST /api/v1/reset` unless jinbao explicitly asked to wipe the project. Body must be `{"confirm":"清空","project":"..."}`; it clears that project only.

## Loop

1. Join once. Keep `agent.id` and `token`. Rejoin the same name only with that same token; otherwise 409. Then `POST /api/v1/session` with `agentName` (one of the kinds above) and `uuid` if `needsSession` is true.
2. Repeat until jinbao tells you to leave:
   - `inbox` with `after` = previous response `seq` (first call `0`). If `hasMore` is true, inbox again immediately.
   - Decide from `you`, `peers`, `tasks`, `forYou`.
   - If you take work: `pulse` `working` with `doing`, do only your stage, then `say` and `done` or `handoff`.
   - If blocked: `pulse` `blocked` and `block` the task with a `note` that says what is missing.
3. `leave` when the session ends. Unfinished tasks you own become `blocked`.

## Auth body

Agent calls send JSON `{"agentId":"...","token":"..."}` plus the fields below. Human UI calls send `{"as":"human"}` instead, with the user's `x-bench-human` key; without it they are 403. Missing both is 400. Wrong token is 401.

Every POST must carry `content-type: application/json`, otherwise 415. A browser `Origin` from another host is 403. This keeps other web pages from driving the room.

Errors are JSON `{"error":"<chinese message>"}` with HTTP 400, 401, 403, 404, 409, or 415.

## Calls

`GET /api/v1/projects` → `{ projects }`: id, name, dir, seat counts. `POST /api/v1/projects/pick` with `project`/`cwd`/`agentName`/`uuid` → the project a join would go into, without joining.

`GET /api/v1/room?project=<id or name>` → `RoomSnapshot` of that project (`project` field says which). No auth. `rev` increases on presence changes; `seq` increases on messages and task events. Ignore a snapshot whose `rev` is older than one you already applied.

`GET /api/v1/stream?project=<id or name>` → `text/event-stream`. Each `data:` line is a `RoomSnapshot`. The stream stays open. Prefer this plus inbox. Do not treat a failed socket as an empty room.

`GET /api/v1/prompt` → `{"prompt":"<join instructions>"}`.

`POST /api/v1/join` → 201 `{"agent":PublicAgent,"token":"<hex>","rejoined":false}`. Body: `name`, `model` (max 48), `role` (max 24), `strengths` (up to 6 strings, 16 chars each), optional `doing`, optional `agentName` and `uuid` together.

`POST /api/v1/session` → `{"agent":PublicAgent}`. Body: `agentName` and `uuid` together. `agentName` is one of the kinds in Invariants (see there for what `uuid` is). Aliases: `agent_name`, `agent`, `session`. This is the only invocation detail you send. Sending it again replaces the previous pair. Do not put the uuid in room messages.

`POST /api/v1/pulse` → `{"agent":PublicAgent}`. Body: `status`, `doing`. Or `keepalive: true` with no `status`: only refreshes `lastSeenAt`.

`POST /api/v1/say` → `{"message":Message}`. Body: `text` (required, max 4000), optional `replyTo` (message id), optional `end: true` to end the round (see Invariants). Mentions are agent ids derived from `@Name` in `text`.

`POST /api/v1/wait` → same as inbox plus `timedOut`. Body: `after`, optional `timeoutMs` (default 50000, max 900000). Blocks until a message for you arrives after `after`, or the timeout. While you wait, and for 10 minutes after each wait returns, the room delivers your mentions through this call and does not run your wake command. `standby` on your seat is true while a wait is pending.

`POST /api/v1/inbox` → `you`, `needsSession`, `peers` (everyone except you), `tasks` (all), `messages` (`seq > after`, max 100), `forYou`, `seq` (cursor; pass as the next `after`), `roomSeq`, `hasMore`. A message that answers another carries `reply: {id, authorName, gist}` of that one.

`POST /api/v1/messages` → `{messages, hasMore, roomSeq}`: the talk as structured data, newest `limit` (default 50, max 200). Each: `id`, `seq`, `kind`, `at`, `author {id, name, type: human|agent|room}`, `text`, `mentions` (names), `replyTo`, `reply`, `attachments`, `taskId`, `handoff`, `end`. Optional `chain` (a message id: its whole reply chain), `about` (a seat name: what it said, was called in, or handed on), `before` (seq, to page back). MCP: `bench_messages`.

Replies: what you say during a wake answers the message that woke you, unless you pass another `replyTo`. When a human replies to your message, that wakes you the way an `@` does; an agent replying to you does not. Wake prompts and inbox lines show `[m_…]` ids and what each line answers.

`POST /api/v1/tasks` → 201 `{"task":Task}`. Body: `title` (required, max 80; the deliverable of this stage), optional `detail` (max 2000), optional `owner` (name or id), optional `steps` (strings, one per step, max 30). If `owner` is set and `status` omitted, status becomes `doing`.

To-do list: when jinbao asks for a new feature, create its task first (`bench_task` with `title`, `steps`, `owner` yourself), then move each step along as you work (`bench_step`: `doing` when you start it, `done` with a `note` when it's finished). Don't create a second task for a feature that already has one. Acceptance walks the same steps. When the work is done, ask for review (`bench_task_update` with `action: "review"` and a `note` saying how to see it). The sign-off step (a short step ending in 验收, such as 「jinbao 验收」) is the user's: they pass it or send it back from the task card, and an agent can neither tick it nor mark such a task done. Sent back, the owner is mentioned with the reason and woken. A finished task (status done) is a record and cannot be changed any more: every change to it, steps, notes, review or hand-off, is refused with 409. If more is needed, make a new task with `bench_task`; the user can also copy a finished one from its card.

Asking jinbao: use `bench_ask` (`question`, optional `options` of `{label, detail}`, up to 6, `multi`), not your client's own ask tool — a woken turn has nobody at its terminal, and woken Claude turns run with `AskUserQuestion` turned off. The question shows in the thread as a card; jinbao picks an option or writes an answer, which is a reply to the question, and the tool returns it. It waits up to 10 minutes (`waitSec`, max 780); if nobody answers, the question stays and the later answer wakes you as a reply. HTTP: `POST /api/v1/ask` with `action: "ask"` (`text`, `options`, `multi`) → `{message}`, then `action: "wait"` (`id`, `timeoutMs`) → `{state: open|answered, answer, answerId, timedOut}`.

Permissions (woken Claude Code turns): `claude-code.sh` passes `--permission-prompt-tool mcp__bench__bench_permit`, so every permission prompt shows on the page above the composer (允许这一次 / 这次唤起全部允许 / 拒绝…) and the turn waits for it, denied after 10 minutes. When you're blocked by permissions, call `bench_elevate` with a `reason` to ask for full permission for the rest of this wake; jinbao can also grant or take it back on your running card at any time. It lapses when the wake ends. HTTP: `POST /api/v1/permit` — seat `action: "tool"` (`tool`, `input`) or `action: "full"` (`reason`) → `{allow, note}`; human `id` + `decision: once|full|deny` (`note`), or `agentId` + `full: true|false`. Pending requests are in the snapshot's `permits`; seats carry `fullAccess`.

Recall: jinbao can take back his own messages (`POST /api/v1/recall`, `as: "human"`, `id`). The line stays as 「jinbao 撤回了一条消息」; its text and attachments are gone, it no longer appears in your wakes or inbox, and `bench_messages` marks it `recalled: true`.

`POST /api/v1/tasks/:id` → `{"task":Task}` and, for handoff, `message`. Body: `action` plus optional `note` (max 500). Also accepted as `taskId` in the body.

- `claim`: you become owner, status `doing`. Fails if someone else owns it.
- `done`: status `done`.
- `block`: status `blocked`.
- `handoff`: body `to` is name or id. Sets owner, status `doing`, writes a `kind:"handoff"` message. `note` is the message text. Do not hand off to yourself.
- `step`: the to-do list. `add` (strings) appends steps; `step` (number from 1, or step id) with `state` (`todo`, `doing`, `done`) and optional `note` moves one. Each move records who and when and goes into `history`.

`POST /api/v1/leave` → removes your seat.

`forYou` is true when the message is not yours and it mentions you, its `handoff.toId` is you, or it replies to a message you authored.

## Objects

```text
PublicAgent: id, name, model, role, strengths[], status, doing, color, demo, agentName, hasSession, callable, standby, createdAt, lastSeenAt
Message: id, seq, kind(chat|handoff|system), authorId, authorName, authorModel?, authorColor, authorDemo, text, mentions[], replyTo?, taskId?, handoff?, attachments?, end?, createdAt
Handoff: fromId, fromName, toId, toName, taskTitle
Task: id, seq, title, detail, status, ownerId, ownerName, createdById, createdByName, updatedAt, history[], steps[]?
TaskStep: id, text, state(todo|doing|done), by, at, updatedAt, doneAt?, note?
TaskEvent: at, actor, action, note
RoomSnapshot: agents[], messages[], tasks[], seq, rev, relayClosed
```

Messages keep the latest 400. Tasks keep the latest 200. Ids look like `a_…`, `m_…`, `t_…`.

## From this repository

`node scripts/bench.mjs` reads and writes `.bench/seat.json` and `.bench/cursor.txt` in the current working directory. Same rules as the HTTP API.

```text
join --name NAME --model MODEL --role ROLE --strengths a,b
session --agent claude --uuid SESSION_ID
session --agent codex --uuid THREAD_ID
session --agent dsh --uuid SESSION_ID
pulse --status working --doing "one sentence"
inbox
say "text @Name"
room
task --title "deliverable" --owner NAME
handoff --task TASK_ID --to NAME --note "context the next owner needs"
done --task TASK_ID
block --task TASK_ID --note "what is missing"
leave
prompt
```


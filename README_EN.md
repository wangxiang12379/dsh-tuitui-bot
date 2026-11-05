<div align="center">

<img src="./assets/icons/tuitui.jpg" width="96" alt="Tuitui Bot" />

**A 360 Tuitui (推推) bot plugin for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh)**

Chat with DeepSeek Harness in Tuitui **direct messages, group chats and team channel posts**.

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.5-8A2BE2)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-339933)](https://nodejs.org)

**[简体中文](./README.md) | English**

</div>

---

## What it is

Turns a Tuitui bot into a **channel frontend** for dsh:
Tuitui message → normalized → middleware chain → dsh Agent; and dsh text/tools/approval/questions/deliverables
→ Tuitui messages, native interactive cards and in-place streaming edits.

Transport is the official Tuitui SDK ([`@qihoo/tuitui-bot-sdk`](https://www.npmjs.com/package/@qihoo/tuitui-bot-sdk));
on top sits a self-contained onion middleware chain: **access control → history buffer → trigger gate →
sanitize → rate limit → slash commands → concurrency → typing → quote ref → attachments → envelope**.
The order is the behaviour contract.

## Quick start

```bash
# 1. install a published release (recommended)
#    grab dsh-tuitui-bot-<version>.tgz from
#    https://github.com/EayonLee/dsh-tuitui-bot/releases/latest
dsh plugin --profile tuitui add ./dsh-tuitui-bot-0.1.29.tgz

# or track main (unreleased changes, may be mid-refactor)
dsh plugin --profile tuitui add github:EayonLee/dsh-tuitui-bot

# 2. configure credentials
export TUITUI_BOT_APPID="your-app-id"
export TUITUI_BOT_SECRET="your-app-secret"
export DEEPSEEK_API_KEY="your-deepseek-key"

# 3. run
dsh --profile tuitui
```

Build output (`lib/`) is committed, so installing straight from GitHub needs no local build.

Alternatively leave the env vars unset and fill **Settings → Tuitui Bot** in the GUI; the plugin verifies the
credentials with `property.info()` and writes them into the profile's `cordis.patch.yml`.

Then talk to the bot: DM it, @-mention it in a group, or post in a team channel and @-mention it.

Group trigger modes (`mentionPolicy`). The default is **smart** — the bot decides from its own
personality and the conversation:

- `require` (default): only @-mentions count.
- `smart`: a model reads recent context and decides whether to join in — it stays quiet when others
  talk to each other, and speaks up when addressed or when it clearly matters. The judging prompt is editable.
- `always`: answer every group message (dedicated rooms only).

### Upgrade & uninstall

Re-install the same spec to upgrade (the profile is replaced in place), then restart that profile:

```bash
dsh plugin --profile <name> add github:EayonLee/dsh-tuitui-bot
dsh --profile <name>                                      # restart to load the new build
```

`dsh --profile <name> --dump-config | grep -A3 im-tuitui` confirms the plugin row is in the combined tree.

```bash
dsh plugin --profile <name> remove @eayonlee/dsh-tuitui-bot
# credentials live in the profile's cordis.patch.yml — delete them there if you want a clean slate
```

## What it can do

### Features

| Capability | Details |
| --- | --- |
| 💬 Three chat scopes | Direct chat, group chat, team channel posts (threaded replies), each with its own context |
| ⚡ Streaming | First message returns `msgid`, then `modifyText` refreshes in place; falls back to appended deltas |
| 🃏 Native cards | Approval / questions as Tuitui interactive cards, updated via `modifyInteractive` |
| 🖼️ Rich media | Images / files / voice / video are fetched into a local media dir for the agent |
| 📎 File delivery | `tuitui_send_file` tool plus automatic `present` deliverable delivery |
| 🧭 Context awareness | Group history buffer, quoted-message parsing, sender dept path, mention cleaning |
| 🧩 Slash commands | `/new` `/compact` `/model` `/preset` `/status` `/stop` …, synced as Tuitui quick commands |
| 🧠 Native step reporting | Model/tool steps and available token usage reported through `client.agent` for the Tuitui client UI |
| 🔐 Four access modes | open / allowlist / blocklist / disabled per scope, allow/deny lists entered as chips |
| 🗣️ Smart interjection | In `smart` mode a model reads the group context and decides whether to speak up — **the judging prompt is fully editable in Settings** |
| 🛠️ In-app settings | Credential binding plus every common option, saved to the profile and hot-reloaded; lists are chips, workspace is a dropdown |

### Commands

`/new` (`/reset`, `/clear`), `/compact`, `/model`, `/preset`, `/status`, `/stop`, `/bot-ping`,
`/bot-version`, `/bot-help`, `/auth`.

### Tools

| Tool | Description |
| --- | --- |
| `tuitui_send_file` | Send a local file, URL or in-memory payload to the current chat (path allowlist enforced) |
| `tuitui_group` | Group admin: `info` / `members` / `robot_in` / `user_is_in` read-only; `create` / `member_add` / `member_remove` need `confirm=true` |
| `tuitui_history` | Read chat records (group or private) with `limit` (1–100), `cursor`, `order_asc`. Read-only |
| `tuitui_file` | Files: `upload` / `query` / `batch_query` / `list_nodes` / `list_files` / `list_team_files`; space writes need `confirm=true` |
| `tuitui_send` | Rich messages: `link` / `page` / `mixed`; `recall` / `modify` / `strong_notice` / `phone_alarm` need `confirm=true` |
| `tuitui_teams` | Team channels: `channel_info` / `channel_posts` / `post_chain` / `post_tags` / `members` / `member_names` / `announcement` read-only; `send_post` / `edit_post` / `send_file` need `confirm=true` |
| `tuitui_bot` | The bot itself: `info` / `get_shortcuts` read-only; `set_name` / `set_avatar` / `set_shortcuts` / `set_workspace_menus` need `confirm=true` |
| `tuitui_describe_image` | Image understanding (requires `vision.enabled`): uses `vision.baseUrl` when set, otherwise dsh llm |
| `tuitui_draw` | Image generation (requires `imageGeneration.enabled`): draws, sends to the current chat, returns the local path |

### Smart interjection

With `mentionPolicy: 'smart'`, every group message (mentioned or not) goes through one judgement:

1. **Cooldown** — at most one judgement per `smartJudge.cooldownMs` per conversation; the rest are treated as "do not join" without spending tokens.
2. **Context** — the last `smartJudge.maxHistory` entries from the history buffer (with speakers; the bot's own lines are tagged `[you]`).
3. **Ask the model** — using the conversation's effective model, send `smartJudge.prompt` + history + the new message together with the JSON Schema of a `join_decision` tool (`act` enum: text / emoji / silent). The model calls the tool and its arguments *are* the verdict — **the format is fixed in code, not left to the model's discipline**. Text-JSON parsing stays as a fallback (legacy `{"join":true|false}` included). The prompt only carries personality.
4. **Fail closed** — timeouts, unparsable output, model errors, missing service: all mean `join:false`. Missing a reply beats spamming the room.
5. **No deterministic fallback** — no name matching, no "someone the bot just talked to keeps going". If judgement is unavailable, the bot stays quiet.

The prompt is first-class configuration: different rooms need different personalities. Edit it in Settings;
clearing the box restores the factory default ([source](./src/shared/smart-prompt.ts)).

## Configuration

All options live in [`src/config.ts`](./src/config.ts). In a profile, override them in `cordis.patch.yml`
(a patch replaces the whole `config` object, so restate every key you want to keep).

### Settings page (recommended)

dsh Settings → **Tuitui Bot** edits everything common in place; saving writes the profile and hot-reloads:

- **Scope**: per-scope access mode; allow/deny lists are **chip inputs** — Enter or a comma commits a chip,
  `Backspace` removes the last one, `×` removes one. No format to memorise.
- **When to reply**: the three trigger modes; in `smart` you also get bot aliases, the follow-up window,
  and the **judging prompt editor** (multi-line, monospace, one-click restore to factory default).
- **Context & sessions**: group history size and idle eviction, with unit suffixes and plain-language help.
- **Workspace**: a dropdown of real directories (default workspace, projects under `~/workspace`, current value).
- **Tuitui-native switches**: interactive cards, step reporting, debug logs.

> Long free-text values (lists, prompt) are re-validated server-side before writing: length, control
> characters and types. Client-side checks are UX only — the security boundary is the host.

### Core

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `appId` | string | `''` | Bot AppID (or `TUITUI_BOT_APPID`) |
| `appSecret` | string | `''` | Bot AppSecret (or `TUITUI_BOT_SECRET`) |
| `provider` / `model` | string | - | Override the LLM route; empty inherits the host default |
| `preset` | string | - | Agent preset id (applies to new sessions) |
| `cwd` | string | `~/.dsh-tuitui/workspace` | Agent working directory |
| `requireMention` | boolean | `true` | Require @bot in groups (fallback when `mentionPolicy` is unset) |
| `mentionPolicy` | `'smart'` | `smart` / `require` / `always`: persona-driven judgement (default) / @ only / everything |
| `smartJudge.prompt` | built-in | **Judging prompt, fully editable** (Settings UI; empty restores default) |
| `smartJudge.maxHistory` | `50` | History messages handed to the model |
| `smartJudge.cooldownMs` | `5000` | Minimum gap between judgements per conversation |
| `concurrency.c2c` | `merge` | Direct chats: interrupt the running turn and take the new message (queue / drop / merge also available) |
| `concurrency.group` | `merge` | Groups: queue one at a time |
| `concurrency.post` | `queue` | Team posts: queue |

All four strategies act at the **turn** level, not just in the middleware chain: `queue` waits, `abort` cancels the in-flight turn (its answer gets truncated), `merge` buffers while busy and sends one combined message afterwards, `drop` discards (logged).
| `concurrency.group` | `queue` | Groups: process one at a time |
| `concurrency.post` | `queue` | Team posts: process one at a time |
| `reactions.enabled` | `true` | React on receipt (working / done / failed) |
| `reactions.inGroup` | `true` | Also react in groups |
| `reactions.ack` / `done` / `fail` | `微笑` / `OK` / `委屈` | Emoji **name** per stage — Tuitui only accepts its built-in names (微笑 / 强 / OK / 奶茶…); unicode is rejected. Empty disables it |
| `smartJudge.timeoutMs` | `20000` | Judgement timeout (timeout = do not join; thinking models often need more than 8s) |
| `requireMentionInPost` | boolean | `true` | Require @bot in team posts |
| `groupPrompt` / `directPrompt` / `postPrompt` | string | - | Per-scope extra system prompt |
| `textChunkLimit` | number | `4000` | Max characters per message |
| `debug` | boolean | `false` | Verbose logs (includes raw event bodies) |

### Sessions & concurrency

| Key | Default | Description |
| --- | --- | --- |
| `streaming` | `true` | Streaming output (in-place edits) |
| `streamIntervalMs` | `600` | Streaming refresh throttle |
| `sessionIdleTimeout` | `1800000` | Idle session eviction (ms) |
| `maxQueue` | `20` | Per-peer queue limit |
| `processingTimeoutMs` | `1800000` | Turn timeout (ms) |
| `askTimeoutMs` | `300000` | Pending question timeout (ms) |
| `historyLimit` | `50` | Group/post history buffer size (rolling window; nothing is cleared after a reply, only undelivered messages are added) |
| `showToolResults` | `false` | Show successful tool output (errors always shown) |

### Access control

`access.c2cMode` / `access.groupMode` / `access.postMode` accept
`open` | `allowlist` | `blocklist` | `disabled`; the matching `c2cAllow`/`c2cBlock`,
`groupAllow`/`groupBlock`, `postAllow`/`postBlock` arrays take accounts or UIDs, group ids, and
channel/team ids. Deny lists win over everything. An empty allowlist in `allowlist` mode
**denies everyone** (fail-closed). Team posts are **disabled by default**
(`access.postMode = 'disabled'`); switch them on when you actually use channels.

### Media, vision, attachments

`media.enabled` / `media.maxMB` / `media.ttlHours`, `vision.enabled` / `vision.baseUrl` /
`vision.apiKey` / `vision.model` (image understanding), `imageGeneration.enabled` /
`imageGeneration.baseUrl` / `imageGeneration.apiKey` / `imageGeneration.model` /
`imageGeneration.size` (image generation), `sendFile.restrictPaths` / `sendFile.extraRoots` /
`sendFile.sendPresentedFiles`. Endpoint API keys are write-only: they never come back from the
config API and the settings page only shows whether one is stored.

### Tuitui-native switches

`interactive.enabled` (cards for approval/questions), `interactive.headBgColor` / `headTextColor`,
`agentSteps.enabled` (off by default) / `includeToolPayload` / `maxResultChars`, and `apiBaseUrl` / `websocketBaseUrl`
for private deployments (also `TUITUI_BOT_API_BASE` / `TUITUI_BOT_WS_BASE`).

### FAQ

**The bot stays silent in a group.** Run `/auth` first, then check the trigger mode: `require` needs an
@-mention, `smart` depends on the judgement, only `always` answers everything. Posts also honour
`requireMentionInPost`.

**Smart mode is too quiet / too chatty.** Quiet: lower `smartJudge.cooldownMs` or make the prompt more
eager. Chatty: the opposite, or switch back to `require`.

**Settings refuses to unbind because credentials come from env vars.** Environment variables win over the
profile; remove `TUITUI_BOT_APPID` / `TUITUI_BOT_SECRET` in the deployment environment and restart.

**Config changes do not apply.** Saving in Settings writes the profile and triggers a reload; hand edits to
`cordis.patch.yml` need a restart.

**Why did one reply arrive as several messages?** Anything longer than `textChunkLimit` is split, and the
streaming fallback appends deltas instead of editing in place.

## Architecture

```
Tuitui events (WebSocket)
   │  src/tuitui/inbound.ts      normalize single_chat / group_chat / teams_post_create / interactive_action
   ▼
Middleware onion (src/gateway/middleware/)
   errorHandler → messageFilter → accessPolicy → historyBuffer → mentionGate →
   contentSanitizer → rateLimiter → slashCommand → questionAnswer →
   concurrencyGuard → typingIndicator → quoteRef → attachmentProcessor → envelopeFormatter
   ▼
src/transport/inbound.ts   5-layer assembly → agent.followup
   ▼
dsh Agent (session/**, host/**, model/**)
   ▼
dsh events (session/event, agent/assistant-stream)
   │  src/transport/{outbound,streaming-writer,outbound-buffer,tool-presenter,deliverables}.ts
   ▼
src/tuitui/sender.ts   im.sendText / modifyText / sendInteractive / modifyInteractive / sendFile / recall / emojiReaction
                       teams.sendPost / editPost / sendFile / emojiReaction
```

**Only `src/tuitui/` imports the Tuitui SDK.** Everything else depends on the `TuituiSender` abstraction in
[`src/types.ts`](./src/types.ts), which keeps the transport replaceable and testable.

### Sessions & context

| Behaviour | Details |
| --- | --- |
| Session isolation | Key is `tuitui:<scope>:<peerId>`: direct by peer account, group by `group_id`, post by `channel_id` — separate contexts |
| Group context | Non-mentioned messages still enter the history buffer (`historyLimit`), and ship with the request when the bot is addressed |
| Idle eviction | After `sessionIdleTimeout` the in-memory agent is released; the next message restores the same session, context intact |
| Long-task protection | Sessions whose agent is not idle are never evicted, so long runs are not cut in half |
| Serial per peer | Messages from one peer queue up (`maxQueue`); different peers do not block each other |
| Quote resolution | The replied-to message travels along as a quote, so "what it said earlier" style references still resolve |
| Outbound @ resolution | `@name` in the reply text becomes real Tuitui `at` metadata (code blocks, e-mail addresses and `@all` excluded), merged with any explicit `at`; plain text without `at` never notifies the target |
| Inbound dedupe | Handled msgids persist to `~/.dsh/tuitui-bot/tuitui-seen.json` (FIFO, 1000), so a reconnect/restart that replays recent messages never double-answers |
| Zombie connection self-healing | Connected but zero events for 30 minutes ⇒ treated as stale and resubscribed; a `[tuitui/watch]` status line every 5 minutes (uptime / last event / last error / rebuild count) |
| Turn ceiling | Waiting for a turn to settle is capped at 15 minutes, then logged and released, so one hung turn cannot block a conversation forever |

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest
npm run build            # tsc → lib/ + tsdown → lib/client.js

# live smoke test against the real bot API
TUITUI_BOT_APPID=xxx TUITUI_BOT_SECRET=yyy node scripts/smoke-live.mjs
node scripts/smoke-live.mjs --send group:<groupId>   # also exercises send / edit / recall

# bootstrap wiring self-check (no dsh CLI, no LLM key): client, sender, middleware
# chain, tool registration, WS subscription, property.info, shortcuts, disposal
TUITUI_BOT_APPID=xxx TUITUI_BOT_SECRET=yyy node scripts/verify-bootstrap.mjs
```

Local source debugging without installing the package:

```bash
dsh web --patch /path/to/dsh-tuitui-bot/cordis.dev.yml
```

## Contributing

Issues and PRs are welcome — read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

- Bugs: use the [bug report](https://github.com/EayonLee/dsh-tuitui-bot/issues/new?template=bug_report.yml) template with the dsh version, plugin version and redacted logs;
- Features: use the [feature request](https://github.com/EayonLee/dsh-tuitui-bot/issues/new?template=feature_request.yml) template, and name the Tuitui SDK capability you would reuse;
- Before opening a PR: `npm run typecheck`, `npm test` and `npm run build` must pass;
- Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md); report security issues privately per [SECURITY.md](./SECURITY.md).

See [CHANGELOG_EN.md](./CHANGELOG_EN.md) for changes (Chinese: [CHANGELOG.md](./CHANGELOG.md)).

## Credits

- Host framework: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness);
- Platform SDK: [@qihoo/tuitui-bot-sdk](https://www.npmjs.com/package/@qihoo/tuitui-bot-sdk).

## License

[MIT](./LICENSE) © 2026 EayonLee and dsh-tuitui-bot contributors

<div align="center">

<img src="./assets/icons/tuitui.jpg" width="96" alt="Tuitui Bot" />

**基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 360 推推机器人插件**

在推推（Tuitui）**单聊、群聊、团队频道帖子**里直接对话 DeepSeek Harness。

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.1--rc.5-8A2BE2)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%3E%3D20.3-339933)](https://nodejs.org)

**简体中文 | [English](./README_EN.md)**

</div>

---

## 这是什么

把推推机器人做成 dsh 的一个**渠道前端**：推推消息 → 归一化 → 中间件链 → dsh Agent；
dsh 的文本/工具/审批/问答/交付物 → 推推消息、原生交互卡片、原地编辑流式输出。

传输层用推推官方 SDK（[`@qihoo/tuitui-bot-sdk`](https://www.npmjs.com/package/@qihoo/tuitui-bot-sdk)），
上层是自带的洋葱中间件链：**访问控制 → 历史缓冲 → 触发门控 → 清洗 → 限流 → 命令 →
并发串行 → 打字状态 → 引用解析 → 附件处理 → 上下文组包**，顺序即行为契约。

## 快速开始

### 1. 准备机器人凭据

在推推机器人后台创建机器人，拿到 **AppID** 与 **AppSecret**。

### 2. 安装插件

**推荐装 Release 里的正式包**——只有维护者打过 tag 的版本才算发布，跑过完整测试，
装上就是稳定的。

1. 打开 [最新 Release](https://github.com/EayonLee/dsh-tuitui-bot/releases/latest)，
   下载 `dsh-tuitui-bot-<版本>.tgz`（例如 `0.1.29`）
2. 装进 profile：

```bash
dsh plugin --profile tuitui add ./dsh-tuitui-bot-0.1.29.tgz
```

想跟着主干走（能拿到还没发版的改动，也可能撞上正在改的东西）：

```bash
dsh plugin --profile tuitui add github:EayonLee/dsh-tuitui-bot
```

仓库已提交构建产物 `lib/`，两种装法都不需要本地构建。

### 3. 配置凭据并启动

```bash
export TUITUI_BOT_APPID="你的AppID"
export TUITUI_BOT_SECRET="你的AppSecret"
export DEEPSEEK_API_KEY="你的 DeepSeek Key"

dsh --profile tuitui            # 启动 agent + 推推长连接
```

> 也可以不配环境变量：直接启动后在 **设置 → 推推机器人** 里填写 appId/appSecret，
> 插件会调用 `property.info()` 校验并把凭据写进 profile 的 `cordis.patch.yml`。

### 4. 在推推里聊

- 私聊机器人：直接发消息
- 群聊：把机器人拉进群。默认是**智能模式**——它按自己的性格和上下文判断要不要说话；三档触发方式（`mentionPolicy`）：
  - `require`（默认）：只有 @ 才算叫它。
  - `smart`：**模型读最近对话自己判断要不要插嘴**——别人互相聊天不接话，轮到自己或被问到才开口；判定提示词可在设置页改写。
  - `always`：群里每条消息都回（只建议专用小群）。
- 团队频道：在频道里发帖并 `@机器人`（或回复机器人的帖子）

### 升级与卸载

想升级就下新版本的正式包再装一次（profile 会原地替换），然后重启：

```bash
dsh plugin --profile <name> add ./dsh-tuitui-bot-<新版本>.tgz
dsh --profile <name>                                      # 重启让新版本加载
```

跟着主干走的，重装 `github:EayonLee/dsh-tuitui-bot` 即可。

`dsh --profile <name> --dump-config | grep -A3 im-tuitui` 可以确认插件行已进入组合树。

卸载：

```bash
dsh plugin --profile <name> remove @eayonlee/dsh-tuitui-bot
# 凭据写在 profile 的 cordis.patch.yml 里，需要的话一并手动删除
```

## 能做什么

### 功能一览

| 能力 | 说明 |
| --- | --- |
| 💬 三种会话形态 | 单聊、群聊、团队频道帖子（含回帖串），各自独立的会话上下文 |
| ⚡ 流式输出 | 首条消息拿到 `msgid` 后用 `modifyText` 原地刷新，不刷屏；降级时自动切成追加片段 |
| 🃏 原生交互卡片 | 审批 / 提问用推推交互卡片，点击后 `modifyInteractive` 原地更新为最终状态 |
| 🖼️ 富媒体理解 | 图片/文件/语音/视频落地到本地媒体目录，交给 agent 读取（视觉工具可选） |
| 📎 文件回传 | `tuitui_send_file` 工具 + `present` 交付物自动投递到当前会话 |
| 🧭 上下文感知 | 群历史缓冲、引用消息解析、发送者部门路径、@ 标记清洗 |
| 🧩 斜杠命令 | `/new` `/compact` `/model` `/preset` `/status` `/stop` 等，同步为推推快捷指令 |
| 🧠 原生步骤上报 | 通过 `client.agent` 上报模型/工具调用及可用的 Token 用量，推推客户端原生展示执行过程 |
| 🔐 四档访问控制 | open / allowlist / blocklist / disabled，单聊 / 群聊 / 帖子分别配置，黑白名单以标签录入 |
| 🗣️ 智能插话 | smart 模式下由模型读群聊上下文自行判断要不要开口，**判定提示词可在设置页整段改写** |
| 🛠️ 端内设置页 | 凭据绑定 + 全部常用配置可视化编辑，保存即写 profile 并自动重载；名单是标签，工作区是下拉 |

### 内置命令


| 命令 | 说明 |
| --- | --- |
| `/new`（别名 `/reset` `/clear`） | 开始新会话（清空上下文） |
| `/compact` | 压缩会话历史（摘要替换旧记录） |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/status` | 当前会话状态（会话 id、模型、preset、消息数） |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 延迟检测（传输 + 处理耗时） |
| `/bot-version` | 版本信息 |
| `/bot-help` | 全部命令 |
| `/auth` | 访问控制自检（当前 peer 是否被允许） |

> 常用命令会同步到推推的**快捷指令**面板，用户无需记忆。


### 工具


| 工具 | 说明 |
| --- | --- |
| `tuitui_send_file` | 把本地文件/URL/内存内容发到当前会话；默认不限制路径，想发什么发什么 |
| `tuitui_describe_image` | 图像理解（需 `vision.enabled`）：配了 `vision.baseUrl` 就走自己的端点，否则退回 dsh llm |
| `tuitui_draw` | 图像生成（需 `imageGeneration.enabled`）：出图并直接发到当前会话，返回本地文件路径 |
| `tuitui_group` | 群管理：`info` / `members` / `robot_in` / `user_is_in` 只读；`create` / `member_add` / `member_remove` 要 `confirm=true` |
| `tuitui_history` | 拉聊天记录：群或私聊，支持 `limit`（1–100）、`cursor`、`order_asc`。只读 |
| `tuitui_file` | 文件：`upload` / `query` / `batch_query` / `list_nodes` / `list_files` / `list_team_files`；空间增删（`add_node` / `delete_node` / `add_file`）要 `confirm=true` |
| `tuitui_send` | 消息花样：`link` / `page` / `mixed`；`recall` / `modify` / `strong_notice` / `phone_alarm` 要 `confirm=true` |
| `tuitui_teams` | 团队频道：`channel_info` / `channel_posts` / `post_chain` / `post_tags` / `members` / `member_names` / `announcement` 只读；`send_post` / `edit_post` / `send_file` 要 `confirm=true` |
| `tuitui_bot` | 机器人自身：`info` / `get_shortcuts` 只读；`set_name` / `set_avatar` / `set_shortcuts` / `set_workspace_menus` 要 `confirm=true` |

> 写操作统一规则：不带 `confirm=true` 直接报错退回。模型自己不会"顺手"改群、改身份、发强通知——
> 它得先拿到一句明确的「执行」。


### 智能插话


`mentionPolicy: 'smart'` 时，群里**每条**消息（未 @ 也算）会走一次判定：

1. **冷却**：同一会话 `smartJudge.cooldownMs` 内只判一次，超出的消息直接按「不插嘴」处理，不烧 token。
2. **取上下文**：从历史缓冲拿最近 `smartJudge.maxHistory` 条（带说话人，机器人自己标 `[你]`）。
3. **问模型**：用该会话当前生效的模型，把 `smartJudge.prompt` + 历史 + 新消息发过去，
   同时把 `join_decision` 工具的 JSON Schema 一起下发（`act` 枚举 text / emoji / silent），
   模型按 schema 调工具，参数就是判定结果——**格式由代码定死，不靠模型自觉写 JSON**。
   工具不可用或参数不合约时退回文本 JSON 解析（老 `{"join":true|false}` 也认）。
   提示词只管性格，改提示词改不出解析错误。
4. **失败即闭嘴**：超时（`timeoutMs`）、输出解析不了、模型报错、服务缺失——一律 `join:false`。
   宁可漏答一句，也不在群里刷屏。
5. **没有确定性兜底**：既不看名字，也不看「刚聊过的人接着说话」。判定不可用 = 不插嘴。

提示词里**没有判断清单**——写成清单，它就变成按表格打勾的机器人。出厂文案给的是处境和动机
（感兴趣、不同意、觉得好笑、无聊、手上有信息、被叫到、该有人拍板），让它自己拿主意。
提示词是**一等配置**：不同群需要不同的「人设」，在设置页整段改，改完保存即生效；
清空输入框恢复出厂默认（见 [`src/shared/smart-prompt.ts`](./src/shared/smart-prompt.ts)）。

## 配置解读

配置项定义在 [`src/config.ts`](./src/config.ts)，可在 profile 的 `cordis.patch.yml` 中覆盖
（**patch 是整体替换 config，需写全你要保留的键**）。

### 设置页（推荐）

dsh 设置 → **推推机器人**，所有常用配置都在这里，保存后写回 profile 并自动重载：

- **服务范围**：单聊 / 群聊 / 团队帖子各选四档模式；白名单、黑名单都是**标签输入**——
  回车或逗号成标签，`Backspace` 删最后一个，点 `×` 删单个，不用记格式。
- **什么时候回话**：触发方式三档；选「智能」时展开判定提示词、判定间隔与上下文条数，以及
  **判定提示词编辑器**（多行、等宽字体、可一键恢复出厂默认）。
- **上下文与会话**：群聊上下文条数、闲置回收分钟数，带单位后缀与用途说明。
- **工作区**：下拉直接选目录（默认工作区 / `~/workspace` 下的项目 / 当前值），不用手打绝对路径。
- **推推原生能力**：交互卡片、中间步骤上报、调试日志三个开关。

> 名单、提示词这类长文本提交前都在服务端重新校验（长度、控制字符、类型），
> 客户端校验只负责体验，安全边界在宿主。

### 基础

| 配置 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `appId` | string | `''` | 推推机器人 AppID（可用 `TUITUI_BOT_APPID`） |
| `appSecret` | string | `''` | 推推机器人 AppSecret（可用 `TUITUI_BOT_SECRET`） |
| `provider` / `model` | string | - | 覆盖 LLM 路由；留空继承宿主默认，可 `/model` 切换 |
| `preset` | string | - | Agent preset id（新会话生效） |
| `cwd` | string | `~/.dsh-tuitui/workspace` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否必须 @bot（`mentionPolicy` 未设置时用它推导） |
| `requireMentionInPost` | boolean | `true` | 团队帖子是否必须 @bot |
| `mentionPolicy` | `'smart'` | `smart` / `require` / `always`：按人格与上下文自主判断（默认）/ 仅 @ / 全部 |
| `smartJudge.prompt` | 内置文案 | **判定提示词，可整段改写**（设置页可视化编辑，留空恢复默认） |
| `smartJudge.maxHistory` | `50` | 判定时交给模型的历史消息条数 |
| `smartJudge.cooldownMs` | `5000` | 同一会话两次判定的最小间隔，防止每条消息都调模型 |
| `concurrency.c2c` | `merge` | 单聊忙时：攒着，这一轮完了合并成一条一起回（可选 queue / abort / drop） |
| `concurrency.group` | `merge` | 群聊忙时：攒着，这一轮完了合并成一条一起回 |
| `concurrency.post` | `queue` | 团队帖子忙时：排队 |

四种策略在**回合这一层**执行（不只是中间件链）：

| 策略 | 行为 | 代价 |
| --- | --- | --- |
| `queue` | 新消息排到当前回合之后 | 上一轮的答案完整 |
| `abort` | 取消在飞的回合，新消息立即开新回合 | 上一轮答案会被截断 |
| `merge` | 忙时先攒着，这一轮结束后**合并成一条**投递 | 几条消息只回一次 |
| `drop` | 忙时直接丢弃，只记日志 | 那条消息不会被回答 |
| `reactions.enabled` | `true` | 收到消息先挂表情回执（在算 / 好了 / 出错） |
| `reactions.inGroup` | `true` | 群聊里也挂回执 |
| `reactions.ack` / `done` / `fail` | `微笑` / `OK` / `委屈` | 三个阶段的表情**名**（推推只认内置名：微笑 / 强 / OK / 奶茶…；传 unicode 会被服务端拒）；留空表示不挂 |
| `smartJudge.timeoutMs` | `20000` | 判定超时（超时视为不插嘴；思考型模型 8 秒经常卡在推理里） |
| `groupPrompt` / `directPrompt` / `postPrompt` | string | - | 按作用域追加的 system prompt |
| `textChunkLimit` | number | `4000` | 单条消息最大字符数 |
| `debug` | boolean | `false` | 调试日志（含原始事件体） |

### 会话与并发

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `streaming` | `true` | 流式输出（原地编辑） |
| `streamIntervalMs` | `600` | 流式刷新节流 |
| `sessionIdleTimeout` | `1800000` | 会话闲置回收（ms） |
| `maxQueue` | `20` | 同 peer 消息队列上限 |
| `processingTimeoutMs` | `1800000` | 单轮处理超时（ms） |
| `askTimeoutMs` | `300000` | 待答问题超时（ms） |
| `historyLimit` | `50` | 群 / 帖子历史缓冲条数（滚动保留，回复后不清空，只补没投递过的新消息） |
| `showToolResults` | `false` | 是否展示工具成功结果（错误始终展示） |

### 访问控制

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `access.c2cMode` | `open` | `open` / `allowlist` / `blocklist` / `disabled` |
| `access.c2cAllow` / `c2cBlock` | `[]` | 单聊白名单 / **黑名单**（域账号或 UID，黑名单优先） |
| `access.groupMode` | `open` | 群聊模式（同上四档） |
| `access.groupAllow` / `groupBlock` | `[]` | 群白名单 / **黑名单**（group_id） |
| `access.postMode` | `disabled` | 团队帖子模式（同上四档；默认禁用，要用再开） |
| `access.postAllow` / `postBlock` | `[]` | 帖子白名单 / **黑名单**（channel_id 或 team_id） |

> `allowlist` 模式下名单为空 = **拒绝所有人**（fail-closed）。

### 富媒体 / 视觉 / 附件

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `media.enabled` | `true` | 是否下载并理解富媒体 |
| `media.maxMB` | `200` | 单文件上限（MB） |
| `media.ttlHours` | `24` | 媒体保留时长，0 = 永久 |
| `vision.enabled` | `false` | 启用图像理解（`tuitui_describe_image` 工具） |
| `vision.baseUrl` / `vision.apiKey` / `vision.model` | - | 图像理解端点（任意 OpenAI 兼容网关）。密钥只存服务端，设置页与接口都不回显 |
| `vision.provider` | `''` | 旧字段：dsh llm adapter 名；配了 `baseUrl` 后不再使用 |
| `imageGeneration.enabled` | `false` | 启用图像生成（`tuitui_draw` 工具） |
| `imageGeneration.baseUrl` / `apiKey` / `model` | - | 图像生成端点，与理解各配一套 |
| `imageGeneration.size` | `1024x1024` | 出图尺寸，留空用服务端默认 |
| `sendFile.restrictPaths` | `false` | 是否限制可发送的文件路径；默认放开，打开后只允许 media + cwd + extraRoots |
| `sendFile.extraRoots` | `[]` | 额外允许发送的目录 |
| `sendFile.sendPresentedFiles` | `true` | 轮末投递 `present` 声明的文件 |

### 推推原生能力开关

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `interactive.enabled` | `true` | 用交互卡片做审批/提问（关闭后走编号文本应答） |
| `interactive.headBgColor` / `headTextColor` | `#1F6FEB` / `#FFFFFF` | 卡片头部配色 |
| `agentSteps.enabled` | `false` | 上报模型/工具步骤给推推客户端原生展示（默认关） |
| `agentSteps.includeToolPayload` | `false` | 是否上报工具参数/结果原文 |
| `agentSteps.maxResultChars` | `800` | 工具结果截断长度 |
| `apiBaseUrl` / `websocketBaseUrl` | - | 私有化部署端点覆盖（亦可用 `TUITUI_BOT_API_BASE` / `TUITUI_BOT_WS_BASE`） |


### 常见问题

**群里不回应？** 先看 `/auth` 自检，再确认触发方式：`require` 只认 @；`smart` 要看模型判定；
`always` 才全回。帖子还要确认 `requireMentionInPost`。

**智能模式太安静 / 太吵？** 安静就调小 `smartJudge.cooldownMs`、把提示词写得更积极；
太吵就反过来，或者直接把 `mentionPolicy` 调回 `require`。

**设置页说「凭据来自环境变量」不能解绑？** 环境变量优先于 profile，端内解绑删不掉它。
去部署环境删掉 `TUITUI_BOT_APPID` / `TUITUI_BOT_SECRET` 再重启。

**改了配置没生效？** 设置页保存会写 profile 并触发重载；手改 `cordis.patch.yml` 需要重启。

**为什么有时回复变成好几条？** 单条超过 `textChunkLimit` 会被切成多段；流式降级时也会追加片段。

## 架构

```
推推事件 (WebSocket)
   │  src/tuitui/inbound.ts      归一化：single_chat / group_chat / teams_post_create / interactive_action
   ▼
中间件洋葱 (src/gateway/middleware/)
   errorHandler → messageFilter → accessPolicy → historyBuffer → mentionGate →
   contentSanitizer → rateLimiter → slashCommand → questionAnswer →
   concurrencyGuard → typingIndicator → quoteRef → attachmentProcessor → envelopeFormatter
   ▼
src/transport/inbound.ts   5 层组装（用户内容/引用/发送者标签/媒体元数据/历史 envelope）→ agent.followup
   ▼
dsh Agent（session/**、host/**、model/**）
   ▼
dsh 事件 (session/event, agent/assistant-stream)
   │  src/transport/{outbound,streaming-writer,outbound-buffer,tool-presenter,deliverables}.ts
   ▼
src/tuitui/sender.ts   im.sendText / modifyText / sendInteractive / modifyInteractive / sendFile / recall / emojiReaction
                       teams.sendPost / editPost / sendFile / emojiReaction
```

关键设计：**全插件只有 `src/tuitui/` 直接 import 推推 SDK**，其余模块只依赖
[`src/types.ts`](./src/types.ts) 里的 `TuituiSender` 抽象，便于替换与测试。


### 发送可靠性

推推的 `/message/custom/send` 偶尔会回 `errcode 10503`（消息发送失败），绝大多数是服务端瞬时故障或瞬时限流。插件对这条链路做了三层保护：

| 层 | 做法 | 作用 |
| --- | --- | --- |
| 重试 | 最多 6 次，指数退避 + Full Jitter（0.5s 起、单次上限 15s、总预算 75s） | 瞬时故障自动恢复，不丢已经生成好的回复 |
| 分类 | `10503` / `429` / `5xx` / 网络错误才重试；参数、鉴权、权限类错误直接放弃 | 不让人白等 75 秒 |
| 队列 | 同一会话串行发送，不同会话并行；每会话最多积压 20 条 | 重试期间后一条不会插队，顺序不乱 |

服务端返回 `Retry-After` 时按它的时间等（只受总预算约束）。长文本切成多条时，片与片之间留 250ms，避免密集发送触发限流。

策略放在 [`src/tuitui/retry-policy.ts`](src/tuitui/retry-policy.ts)，队列在 [`src/tuitui/send-queue.ts`](src/tuitui/send-queue.ts)，参考了 [p-retry](https://github.com/sindresorhus/p-retry) 与 AWS 的 [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)。

### 会话与上下文

| 行为 | 说明 |
| --- | --- |
| 会话隔离 | 会话键是 `tuitui:<scope>:<peerId>`：单聊按对方账号、群聊按 `group_id`、帖子按 `channel_id`，各自独立上下文 |
| 群上下文 | 未 @ 的群消息也会进历史缓冲（受 `historyLimit` 约束），被叫到时随消息一起交给 agent |
| 闲置回收 | 超过 `sessionIdleTimeout` 没消息就回收内存里的 agent；下次说话自动恢复原会话，上下文不丢 |
| 长任务保护 | agent 正在跑（非 idle）的会话不会被回收，避免长任务被中途清掉 |
| 并发串行 | 同一 peer 的消息排队串行处理（`maxQueue`），不同 peer 互不阻塞 |
| 引用解析 | 被回复的那条消息会作为引用一起交给 agent，群里「它刚才说」这类指代不会丢 |
| 出站 @ 解析 | 正文里写 `@某某` 会解析成推推的 `at` 元数据（代码块、邮箱、`@all` 不算），跟显式 `at` 合并去重；只写文字不带 `at`，对方收不到通知 |
| 入站去重 | 已处理的 msgid 落盘到 `~/.dsh/tuitui-bot/tuitui-seen.json`（FIFO 1000 条），重启后推推重推同一批消息也不会答两遍 |
| 僵尸连接自愈 | 连上后 30 分钟一条事件都没收到 → 判定僵死，重建订阅；每 5 分钟打一行 `[tuitui/watch]` 状态（连了多久 / 最近事件多久前 / 最后错误 / 重建次数） |
| 收敛上限 | 等回合收敛最多 15 分钟，超时记一笔放行，避免一个卡死的 turn 把会话槽位永久占住 |

## 开发

```bash
npm install
npm run typecheck        # tsc --noEmit
npm test                 # vitest（纯逻辑模块单测）
npm run build            # tsc → lib/ + tsdown → lib/client.js（浏览器端面板）

# 真实环境冒烟（真实凭据验证：事件归一化 / 凭据 / 长连接 / 发送 / 编辑 / 撤回）
TUITUI_BOT_APPID=xxx TUITUI_BOT_SECRET=yyy node scripts/smoke-live.mjs
node scripts/smoke-live.mjs --send group:<groupId>      # 额外做真实收发 + 编辑 + 撤回

# 启动接线自检（不需要 dsh CLI / LLM Key：验证客户端、发送器、中间件链、工具注册、
# WS 订阅、property.info 自检、快捷指令同步、生命周期清理整条接线）
TUITUI_BOT_APPID=xxx TUITUI_BOT_SECRET=yyy node scripts/verify-bootstrap.mjs
```

本地调试（不装包，直接用源码，dsh ≥ 0.2.1 用 `--patch` 叠加层）：

```bash
dsh web --patch /path/to/dsh-tuitui-bot/cordis.dev.yml
```

> 本插件的 bundle 层会随 `dsh plugin --profile <name> add` 自动生效；
> 用 `dsh --profile <name> --dump-config` 可以确认 `im-tuitui` 行已进入组合树。

## 贡献

欢迎提 issue / PR，动手前请先读 [贡献指南](./CONTRIBUTING.md)：

- Bug 请用 [Bug 报告](https://github.com/EayonLee/dsh-tuitui-bot/issues/new?template=bug_report.yml) 模板，附上 dsh 版本、插件版本与脱敏日志；
- 功能建议请用 [功能建议](https://github.com/EayonLee/dsh-tuitui-bot/issues/new?template=feature_request.yml) 模板，说明推推侧可复用的原生能力；
- 提交前请跑通 `npm run typecheck`、`npm test`、`npm run build`；
- 参与即表示遵守 [行为准则](./CODE_OF_CONDUCT.md)；安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告，不要开公开 issue。

变更记录见 [CHANGELOG.md](./CHANGELOG.md)（英文：[CHANGELOG_EN.md](./CHANGELOG_EN.md)）。

## 致谢

- 宿主框架 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；
- 推推开放平台 [@qihoo/tuitui-bot-sdk](https://www.npmjs.com/package/@qihoo/tuitui-bot-sdk)。

## 许可

[MIT](./LICENSE) © 2026 EayonLee and dsh-tuitui-bot contributors

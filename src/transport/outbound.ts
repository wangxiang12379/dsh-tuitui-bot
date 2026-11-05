/**
 * 出站处理器 — dsh session/event → 推推消息发送
 *
 * 采用路由器模式：OutboundRouter 持有会话级状态（文本缓冲、工具调用记录），
 * 事件解析归一化在 events.ts，路由按事件类型分发到私有方法。
 *
 * 推推增量：工具调用同时喂给 agent-reporter（client.agent 原生步骤上报），
 * 让推推客户端在执行过程面板里显示"正在调用哪个工具"，而不是只能靠文本刷屏。
 * 上报是尽力而为——reporter 自身吞异常，不影响消息主流程。
 */
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImTuituiConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import type { AgentStepReporter, ToolCallReport } from '../tuitui/agent-reporter.ts';
import { chunkMarkdownText } from './chunker.ts';
import { OutboundBuffer, type OutboundSenderLike } from './outbound-buffer.ts';
import { ReplyLimiter } from './reply-limiter.ts';
import { formatToolResult, type ToolsRegistryLike, type ToolResultData } from './tool-presenter.ts';
import { markBotReply } from '../features/followup-store.ts';
import type { DeliverablesDelivererLike } from './deliverables.ts';
import {
  parseEvent,
  extractTurnError,
  type ChunkEvent,
  type MessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnEndEvent,
  type DeliverablesPresentedEvent,
  type PresentedFileRef,
  type RawSessionEvent,
} from './events.ts';

export type { OutboundSenderLike } from './outbound-buffer.ts';
export type { ToolsRegistryLike } from './tool-presenter.ts';
export { parseStreamFrame } from './events.ts';

/** 出站处理器签名（注册到 ctx.on('session/event')） */
export type OutboundHandler = (session: SessionLike, event: RawSessionEvent) => void;

/** 出站事件入口集合：durable 事件 + 实时流式帧 */
export interface OutboundHandlers {
  /** durable session 事件入口（注册到 ctx.on('session/event')） */
  routeSessionEvent(session: SessionLike, event: RawSessionEvent): void;
  /**
   * 实时流式帧入口（注册到 ctx.on('agent/assistant-stream', ..., { global: true })）。
   *
   * delta 为空串代表"新 attempt 开始"（见 events.parseStreamFrame）：清空累积文本
   * 但保留已开的流式消息——推推 modifyText 是全量替换，用户看到同一条消息被
   * 新内容重写，不会出现两条。
   */
  routeStreamFrame(agentId: string, delta: string): void;
}

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/** 工具调用记录（tool/call 建立，tool/result 消费） */
interface ToolCallRecord {
  name: string;
  args: string;
}

/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);

/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
  private readonly buffers = new Map<string, OutboundBuffer>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 每会话本轮已声明的交付文件（deliverables/presented，轮末清空） */
  private readonly presentedFiles = new Map<string, PresentedFileRef[]>();
  /** 每会话已见过的 present callId（轮内去重，防事件重放导致重复投递） */
  private readonly presentedCalls = new Map<string, Set<string>>();
  /**
   * 每会话最后一笔在途文本发送（assistant/message 的 flush 是 fire-and-forget，
   * turn/end 时需等待其完成再投递交付文件，保证回复文本先于文件到达用户）。
   */
  private readonly pendingText = new Map<string, Promise<void>>();
  private readonly manager: SessionManager;
  private readonly bot: OutboundSenderLike;
  private readonly config: ImTuituiConfig;
  private readonly logger: Logger;
  private readonly toolsRegistry: ToolsRegistryLike | undefined;
  private readonly deliverer: DeliverablesDelivererLike | undefined;
  private readonly agentSteps: AgentStepReporter | undefined;

  public constructor(
    manager: SessionManager,
    bot: OutboundSenderLike,
    config: ImTuituiConfig,
    logger: Logger,
    toolsRegistry: ToolsRegistryLike | undefined,
    deliverer: DeliverablesDelivererLike | undefined,
    agentSteps: AgentStepReporter | undefined,
  ) {
    this.manager = manager;
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this.toolsRegistry = toolsRegistry;
    this.deliverer = deliverer;
    this.agentSteps = agentSteps;
  }

  /** 事件分发入口 */
  public route(session: SessionLike, raw: RawSessionEvent): void {
    const event = parseEvent(raw);
    if (event === undefined) return;

    const record = this.manager.findBySessionId(session.header.id);
    if (record === undefined) return;

    switch (event.type) {
      case 'assistant/chunk':
        this.onChunk(session.header.id, record, event);
        break;
      case 'assistant/message':
        // 记一笔「机器人刚在这个会话说过话」，供 smart 模式的追问判定使用
        markBotReply(record.scope, record.peerId, record.senderId);
        this.onMessage(session.header.id, record, event);
        break;
      case 'tool/call':
        this.onToolCall(record, event);
        break;
      case 'tool/result':
        this.onToolResult(record, event);
        break;
      case 'deliverables/presented':
        this.onPresented(session.header.id, event);
        break;
      case 'turn/end':
        this.onTurnEnd(session.header.id, record, event);
        break;
    }
  }

  /** durable assistant/chunk 事件的流式增量（历史格式兼容保留，当前宿主不再生产该事件） */
  private onChunk(sessionId: string, record: SessionRecord, event: ChunkEvent): void {
    this.appendChunk(sessionId, record, event.text);
  }

  /**
   * 实时流式帧入口（瞬态 agent/assistant-stream 事件）。
   *
   * 空串 delta = 新 attempt 起点：无条件重置该会话累积文本，保留流式会话本身
   * （推推 modifyText 全量替换，用户看到同一条消息被新内容重写）。
   * 迟到帧过滤依赖 attemptId，而集成契约把帧归一化成纯文本后拿不到 attemptId，
   * 因此改为"重置即冲掉"：新 attempt 的起点帧到达时先清空旧内容，旧 attempt
   * 残留的尾巴随后被 append 进来也会落在重置之后，不会与前一轮拼接。
   */
  public routeStreamFrame(agentId: string, delta: string): void {
    if (delta === '') {
      this.buffers.get(agentId)?.reset();
      return;
    }

    const record = this.manager.findBySessionId(agentId);
    if (record === undefined) return;
    markBotReply(record.scope, record.peerId, record.senderId);
    this.appendChunk(agentId, record, delta);
  }

  /** 获取或创建会话 buffer 并追加增量 */
  private appendChunk(sessionId: string, record: SessionRecord, text: string): void {
    let buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      buffer = new OutboundBuffer(
        record,
        this.bot,
        this.config.textChunkLimit,
        this.logger,
        this.shouldStream(record),
      );
      this.buffers.set(sessionId, buffer);
    }
    buffer.append(text);
  }

  /** 是否启用流式：配置开启 + 单聊（群聊/团队帖子始终不流式，配置页已写明） */
  private shouldStream(record: SessionRecord): boolean {
    return this.config.streaming && record.replyTarget.scope === 'c2c';
  }

  /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
  private onMessage(sessionId: string, record: SessionRecord, event: MessageEvent): void {
    this.reportLlmOutput(record, event);
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined && buffer.text.trim()) {
      this.trackText(sessionId, buffer.flush());
      this.buffers.delete(sessionId);
      return;
    }

    const textParts: string[] = [];
    for (const block of event.content) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
    }
    const fullText = textParts.join('\n');
    if (!fullText.trim()) return;

    this.trackText(sessionId, this.send(record, fullText, 'sendMarkdown'));
    this.buffers.delete(sessionId);
  }

  /** 上报模型可见回复（推推客户端展示用；reporter 自身吞异常） */
  private reportLlmOutput(record: SessionRecord, event: MessageEvent): void {
    if (this.agentSteps === undefined) return;
    const texts = event.content
      .filter((block) => block.type === 'text' && Boolean(block.text))
      .map((block) => block.text as string);
    const usage = event.usage;
    this.agentSteps.llmOutput(record.replyTarget, agentMessageId(record.replyTarget), texts, '', usage === undefined ? {} : {
      input: usage.inputTokens,
      output: usage.outputTokens,
      ...(usage.totalTokens === undefined ? {} : { total: usage.totalTokens }),
      ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    });
  }

  /** 记录每会话最后一笔在途文本任务（自身吞错：错误已由 send/flush 内部记录） */
  private trackText(sessionId: string, task: Promise<void>): void {
    this.pendingText.set(sessionId, task.catch(() => {}));
  }

  /** 工具调用：文本不发送（避免刷屏，等待结果），但上报给推推原生步骤面板 */
  private onToolCall(record: SessionRecord, event: ToolCallEvent): void {
    this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
    this.reportTool(record, event.callId, event.name, toToolParams(event.arguments), true, true);
  }

  /** 工具结果：错误始终发送，成功结果按开关；步骤上报与文本展示互不影响 */
  private onToolResult(record: SessionRecord, event: ToolResultEvent): void {
    const call = this.toolCalls.get(event.callId);
    this.toolCalls.delete(event.callId);
    if (call === undefined) return;

    const resultPayload = (event.raw as { message?: { content?: unknown } }).message?.content ?? event.raw;
    this.reportTool(record, event.callId, call.name, resultPayload, event.error === undefined, false);

    if (event.error === undefined && !this.config.showToolResults) return;

    const text = formatToolResult(
      call.name,
      call.args,
      event.raw as unknown as ToolResultData,
      this.toolsRegistry,
      record.agent,
    );
    if (!text) return;

    void this.send(record, text, 'sendToolResult');
  }

  /** 把工具调用喂给 agent-reporter（start / end 成对，callId 全轮唯一） */
  private reportTool(
    record: SessionRecord,
    callId: string,
    toolName: string,
    payload: unknown,
    ok: boolean,
    start: boolean,
  ): void {
    if (this.agentSteps === undefined) return;
    const report: ToolCallReport = {
      toolCallId: callId,
      toolName,
      ...(start && isRecord(payload) ? { params: payload } : {}),
      ...(start ? {} : { result: payload }),
      ok,
    };
    const target = record.replyTarget;
    const messageId = agentMessageId(target);
    if (start) {
      this.agentSteps.toolStart(target, messageId, report);
    } else {
      this.agentSteps.toolEnd(target, messageId, report);
    }
  }

  /** 收集本轮声明的交付文件：事件总是先于 turn/end 到达，轮末统一投递 */
  private onPresented(sessionId: string, event: DeliverablesPresentedEvent): void {
    if (this.config.sendFile?.sendPresentedFiles === false) return;
    let calls = this.presentedCalls.get(sessionId);
    if (calls === undefined) {
      calls = new Set();
      this.presentedCalls.set(sessionId, calls);
    }
    if (calls.has(event.callId)) return;
    calls.add(event.callId);
    const files = this.presentedFiles.get(sessionId) ?? [];
    files.push(...event.files);
    this.presentedFiles.set(sessionId, files);
  }

  /**
   * 轮次结束：文本先送达、再投递交付文件、最后清理状态，异常结束时告知用户。
   * 外层轮次失败不撤销已完成的声明（宿主契约），故失败轮的文件仍投递。
   */
  private onTurnEnd(sessionId: string, record: SessionRecord, event: TurnEndEvent): void {
    const reportTarget = { ...record.replyTarget };
    const buffer = this.buffers.get(sessionId);
    // 文本 flush 可等待，保证回复先于交付文件到达用户
    let flushTask: Promise<void> = Promise.resolve();
    if (buffer !== undefined) {
      if (buffer.text.trim()) {
        flushTask = buffer.flush();
      } else {
        buffer.cancel();
      }
      this.buffers.delete(sessionId);
    }
    const files = this.presentedFiles.get(sessionId) ?? [];
    this.presentedFiles.delete(sessionId);
    this.presentedCalls.delete(sessionId);
    // assistant/message 已在轮内先行发送的文本可能仍在途：与 turn/end 自身的 flush 一起等待
    const pending = this.pendingText.get(sessionId) ?? Promise.resolve();
    this.pendingText.delete(sessionId);

    const failure = extractTurnError(event.reason);
    void (async () => {
      try {
        await Promise.all([flushTask, pending]);
        if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
          await this.send(record, `⚠️ 本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
        }
        if (files.length > 0 && this.deliverer !== undefined) {
          await this.deliverer.deliver(record, files);
        }
      } catch (error) {
        this.logger.error(`im-tuitui: turn/end delivery failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.agentSteps?.agentEnd(reportTarget, agentMessageId(reportTarget));
        this.logger.debug(`im-tuitui: turn/end sessionId=${sessionId}`);
      }
    })();
  }

  /** 统一发送：切分 + 逐 chunk 发送 + 错误记录 */
  private async send(record: SessionRecord, text: string, tag: string): Promise<void> {
    const chunks = chunkMarkdownText(text, this.config.textChunkLimit);
    for (const chunk of chunks) {
      try {
        await this.bot.sendMarkdown(record.replyTarget, chunk);
      } catch (err) {
        this.logger.error(`im-tuitui: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** 用节流守卫包住 markdown 发送（openStream 原样透传） */
function throttledSender(bot: OutboundSenderLike, limiter: ReplyLimiter): OutboundSenderLike {
  return {
    sendMarkdown: async (target, content, opts) => {
      const result = await limiter.run(
        `${target.scope}:${target.targetId}`,
        content,
        // 不传 opts 时保持两参调用：下游适配器与测试都按"没有可选参数"判等
        () => (opts === undefined ? bot.sendMarkdown(target, content) : bot.sendMarkdown(target, content, opts)),
      );
      // 命中同内容去重：本次不发，但对调用方等价于"已处理"
      return result ?? {};
    },
    openStream: (target) => bot.openStream(target),
  };
}

/** 推推步骤上报需要的消息 id：优先入站 msgId，帖子退到 postId */
function agentMessageId(target: ReplyTarget): string {
  return target.msgId ?? target.postId ?? '';
}

/** tool/call 的参数串（JSON）解析为对象，解析失败就不带参数 */
function toToolParams(rawArgs: string): unknown {
  if (!rawArgs) return undefined;
  try {
    return JSON.parse(rawArgs);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示；deliverer 用于轮末投递 present 声明的交付文件；
 * agentSteps 是推推原生的执行步骤上报器（可空，关闭上报时不传）。
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: OutboundSenderLike | import('../types.ts').TuituiSender,
  config: ImTuituiConfig,
  logger: Logger,
  toolsRegistry?: ToolsRegistryLike,
  deliverer?: DeliverablesDelivererLike,
  agentSteps?: AgentStepReporter,
): OutboundHandlers {
  // 出站节流在这里接线（而不是要求 gateway 再包一层）：文本回复、切分后的多个
  // chunk、工具结果、轮次错误提示全都经过这条路，是刷屏的唯一来源。
  // 流式 openStream 不经过节流——原地编辑本来就不会刷屏，节流只会让首字变慢。
  const limited = throttledSender(bot, new ReplyLimiter());
  const router = new OutboundRouter(manager, limited, config, logger, toolsRegistry, deliverer, agentSteps);
  return {
    routeSessionEvent: (session, event) => router.route(session, event),
    routeStreamFrame: (agentId, delta) => router.routeStreamFrame(agentId, delta),
  };
}

/**
 * Agent 步骤上报 — client.agent → 推推客户端原生执行过程展示
 *
 * 推推 SDK 提供 message_received / llm_input / llm_output / before_tool_call /
 * after_tool_call / agent_end 事件上报，推推客户端据此渲染"AI 正在做什么"；
 * 这里优先用这条原生通道，而不是用文本消息模拟。
 *
 * 约束：
 * - 上报是尽力而为：任何失败只记 debug，绝不影响消息主流程。
 * - 默认不上报完整工具参数/结果（可能含隐私），由 config.agentSteps.includeToolPayload 控制。
 */
import type { TuituiAgentEventContext, TuituiAgentEventLlmUsage, TuituiBotClient } from '@qihoo/tuitui-bot-sdk';
import type { ImTuituiConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { describeApiError } from './client.ts';
import { truncate } from '../shared/index.ts';

/** 一次工具调用的上报载荷 */
export interface ToolCallReport {
  toolCallId: string;
  toolName: string;
  params?: Readonly<Record<string, unknown>>;
  result?: unknown;
  ok: boolean;
}

/** 上报器接口（transport/tool-presenter 依赖） */
export interface AgentStepReporter {
  messageReceived(target: ReplyTarget, messageId: string): void;
  llmOutput(target: ReplyTarget, messageId: string, texts: readonly string[], thinking: string, usage?: TuituiAgentEventLlmUsage): void;
  toolStart(target: ReplyTarget, messageId: string, report: ToolCallReport): void;
  toolEnd(target: ReplyTarget, messageId: string, report: ToolCallReport): void;
  agentEnd(target: ReplyTarget, messageId: string): void;
}

/**
 * 构造上下文（SDK 按 target 类型生成可路由的 sessionKey）。
 *
 * 帖子目标用 channel 形态（channelId + postId），群聊用 group，单聊用 direct。
 * 目标不完整（缺 teamId/postId 等）时返回 undefined，调用方放弃上报。
 */
export function buildAgentContext(
  client: TuituiBotClient,
  target: ReplyTarget,
  messageId: string,
): TuituiAgentEventContext | undefined {
  try {
    if (target.scope === 'post') {
      if (!target.channelId || !target.postId) return undefined;
      return client.agent.buildContext({
        target: {
          type: 'channel',
          channelId: target.channelId,
          postId: target.postId,
          ...(target.parentPostId ? { parentPostId: target.parentPostId } : {}),
        },
        messageId,
      });
    }
    if (target.scope === 'group') {
      return client.agent.buildContext({
        target: { type: 'group', groupId: target.targetId },
        messageId,
      });
    }
    return client.agent.buildContext({
      target: { type: 'direct', account: target.targetId },
      messageId,
    });
  } catch {
    return undefined;
  }
}

class TuituiAgentStepReporter implements AgentStepReporter {
  private readonly client: TuituiBotClient;
  private readonly config: ImTuituiConfig;
  private readonly logger: Logger;
  private readonly contexts = new Map<string, TuituiAgentEventContext>();

  public constructor(client: TuituiBotClient, config: ImTuituiConfig, logger: Logger) {
    this.client = client;
    this.config = config;
    this.logger = logger;
  }

  public messageReceived(target: ReplyTarget, messageId: string): void {
    this.report('message_received', target, messageId, (context) => {
      this.client.agent.report.message_received(context);
    });
  }

  public llmOutput(target: ReplyTarget, messageId: string, texts: readonly string[], thinking: string, usage: TuituiAgentEventLlmUsage = {}): void {
    this.report('llm_output', target, messageId, (context) => {
      this.client.agent.report.llm_output(context, { assistantTexts: texts, thinking, usage });
    });
  }

  public toolStart(target: ReplyTarget, messageId: string, report: ToolCallReport): void {
    this.report('before_tool_call', target, messageId, (context) => {
      this.client.agent.report.before_tool_call(context, {
        toolCallId: report.toolCallId,
        toolName: report.toolName,
        ...(this.config.agentSteps.includeToolPayload && report.params ? { params: report.params } : {}),
      });
    });
  }

  public toolEnd(target: ReplyTarget, messageId: string, report: ToolCallReport): void {
    this.report('after_tool_call', target, messageId, (context) => {
      const result = this.config.agentSteps.includeToolPayload
        ? summarizeResult(report.result, this.config.agentSteps.maxResultChars)
        : { ok: report.ok };
      this.client.agent.report.after_tool_call(context, {
        toolCallId: report.toolCallId,
        toolName: report.toolName,
        result,
      });
    });
  }

  public agentEnd(target: ReplyTarget, messageId: string): void {
    this.report('agent_end', target, messageId, (context) => {
      this.client.agent.report.agent_end(context);
    });
    this.contexts.delete(this.contextKey(target, messageId));
  }

  private contextKey(target: ReplyTarget, messageId: string): string {
    return JSON.stringify([target.scope, target.targetId, target.channelId, target.postId, target.parentPostId, messageId]);
  }

  /**
   * 统一守卫：
   * - 关闭上报时直接返回
   * - 上下文构造失败（目标不合法）时返回
   * - SDK 入队/校验异常只记 debug
   */
  private report(
    event: string,
    target: ReplyTarget,
    messageId: string,
    action: (context: TuituiAgentEventContext) => void,
  ): void {
    if (!this.config.agentSteps.enabled) return;
    const key = this.contextKey(target, messageId);
    let context = this.contexts.get(key);
    try {
      if (!context) {
        context = buildAgentContext(this.client, target, messageId);
        if (!context) return;
        this.contexts.set(key, context);
        if (event !== 'message_received') this.client.agent.report.message_received(context);
      } else if (event === 'message_received') {
        return;
      }
      action(context);
    } catch (error) {
      this.logger.debug?.(`agent step report failed (event=${event}): ${describeApiError(error)}`);
    }
  }
}

/** 工具结果摘要：字符串直取、对象 JSON、超长截断（避免卡片被撑爆） */
export function summarizeResult(result: unknown, maxChars: number): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return truncate(result, maxChars);
  try {
    return truncate(JSON.stringify(result), maxChars);
  } catch {
    return '[unserializable result]';
  }
}

/** 创建上报器；关闭时返回 undefined，调用方据此跳过 */
export function createAgentStepReporter(
  client: TuituiBotClient,
  config: ImTuituiConfig,
  logger: Logger,
): AgentStepReporter | undefined {
  if (!config.agentSteps.enabled) return undefined;
  return new TuituiAgentStepReporter(client, config, logger);
}

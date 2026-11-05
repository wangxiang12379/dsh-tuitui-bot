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
export declare function buildAgentContext(client: TuituiBotClient, target: ReplyTarget, messageId: string): TuituiAgentEventContext | undefined;
/** 工具结果摘要：字符串直取、对象 JSON、超长截断（避免卡片被撑爆） */
export declare function summarizeResult(result: unknown, maxChars: number): string;
/** 创建上报器；关闭时返回 undefined，调用方据此跳过 */
export declare function createAgentStepReporter(client: TuituiBotClient, config: ImTuituiConfig, logger: Logger): AgentStepReporter | undefined;
//# sourceMappingURL=agent-reporter.d.ts.map
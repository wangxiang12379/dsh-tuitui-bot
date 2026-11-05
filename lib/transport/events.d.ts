/**
 * 出站事件解析 — 将 dsh session/event 与实时流式帧归一化为强类型
 *
 * 原始事件（ctx.on('session/event') 回调参数）是弱类型：
 *   { type: string, data: Record<string, unknown> }
 * 这里把可识别的事件解析为 discriminated union，未知类型或字段缺失返回 undefined。
 *
 * 推推侧的差异只在流式帧的归一化形态上（见 parseStreamFrame 注释），事件语义
 * 与 dsh 宿主契约保持不变。
 */
/** 原始 dsh 事件（弱类型，来自 ctx.on('session/event')） */
export interface RawSessionEvent {
    type: string;
    data: Record<string, unknown>;
}
/** turn/end 事件的 reason 结构（兼容 error/failure/顶层 message 三种形态） */
export interface TurnEndReason {
    kind?: string;
    error?: {
        message?: string;
        code?: string;
    };
    failure?: {
        message?: string;
        code?: string;
    };
    message?: string;
    code?: string;
}
/** assistant/chunk 事件（仅保留 text-delta） */
export interface ChunkEvent {
    type: 'assistant/chunk';
    text: string;
}
/** assistant/message 事件 */
export interface MessageEvent {
    type: 'assistant/message';
    content: Array<{
        type: string;
        text?: string;
    }>;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
}
/** tool/call 事件 */
export interface ToolCallEvent {
    type: 'tool/call';
    callId: string;
    name: string;
    arguments: string;
}
/** tool/result 事件 */
export interface ToolResultEvent {
    type: 'tool/result';
    callId: string;
    error?: {
        name: string;
        code: string;
    };
    /** 原始 data 透传给 presenter 做结构化展示 */
    raw: Record<string, unknown>;
}
/** turn/end 事件 */
export interface TurnEndEvent {
    type: 'turn/end';
    reason: TurnEndReason;
}
/** present 工具声明的一个交付文件 */
export interface PresentedFileRef {
    /** 绝对路径，或相对 Session 工作目录的路径（仅历史声明） */
    path: string;
    /** 模型提供的可选说明 */
    description?: string;
}
/** deliverables/presented 事件（present 声明的交付文件，含嵌套调用） */
export interface DeliverablesPresentedEvent {
    type: 'deliverables/presented';
    turn: number;
    callId: string;
    files: PresentedFileRef[];
}
/** 出站事件联合类型 */
export type OutboundEvent = ChunkEvent | MessageEvent | ToolCallEvent | ToolResultEvent | TurnEndEvent | DeliverablesPresentedEvent;
/**
 * 解析原始事件为强类型
 *
 * 未知类型或缺失关键字段时返回 undefined，由调用方直接跳过。
 */
export declare function parseEvent(raw: RawSessionEvent): OutboundEvent | undefined;
/**
 * 从 turn/end reason 提取错误信息
 *
 * 兼容三种形态：error（新格式）、failure（旧格式）、顶层 message/code（最旧格式）。
 */
export declare function extractTurnError(reason: TurnEndReason): {
    code: string;
    message: string;
} | undefined;
/** 归一化后的流式增量（文本；空串代表新 attempt 开始） */
export interface StreamFrameDelta {
    agentId: string;
    delta: string;
}
/**
 * 解析 `agent/assistant-stream` 的 payload（对齐 @deepseek-ai/dsh-agent 的
 * AssistantStreamFrame 最小契约，避免硬依赖）。
 *
 * 集成契约取"增量即字符串"，于是用空串编码 attempt 边界：
 *   - start 帧 → `delta: ''`，出站路由器收到空串即重置该会话累积文本；
 *   - chunk 的 text-delta → `delta: <text>`；
 *   - 其余（reasoning-delta / tool-call-delta / end / 未知形态）→ undefined。
 *
 * 这样 gateway 只需 `routeStreamFrame(agentId, delta)` 两个位置参数，而 reset
 * 语义仍然保留：LLM 重试发布新 attempt 时不会把旧内容和新内容拼在一起。
 * reasoning-delta / tool-call-delta 不进用户消息；end 帧不处理——收尾由 durable
 * `assistant/message` / `turn/end` 事件负责。
 */
export declare function parseStreamFrame(raw: unknown): StreamFrameDelta | undefined;
//# sourceMappingURL=events.d.ts.map
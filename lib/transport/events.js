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
/**
 * 解析原始事件为强类型
 *
 * 未知类型或缺失关键字段时返回 undefined，由调用方直接跳过。
 */
export function parseEvent(raw) {
    switch (raw.type) {
        case 'assistant/chunk': {
            const chunk = raw.data.chunk;
            if (chunk === undefined || chunk.type !== 'text-delta' || !chunk.text)
                return undefined;
            return { type: 'assistant/chunk', text: chunk.text };
        }
        case 'assistant/message': {
            const message = raw.data.message;
            if (message === undefined || !Array.isArray(message.content))
                return undefined;
            const usage = raw.data.usage;
            return { type: 'assistant/message', content: message.content, ...(usage === undefined ? {} : { usage }) };
        }
        case 'tool/call': {
            const data = raw.data;
            if (!data.callId || !data.name)
                return undefined;
            return { type: 'tool/call', callId: data.callId, name: data.name, arguments: data.arguments ?? '' };
        }
        case 'tool/result': {
            const data = raw.data;
            const callId = data.message?.source?.callId;
            if (!callId)
                return undefined;
            return {
                type: 'tool/result',
                callId,
                ...(data.error !== undefined ? { error: data.error } : {}),
                raw: raw.data,
            };
        }
        case 'turn/end': {
            const reason = raw.data.reason ?? {};
            return { type: 'turn/end', reason };
        }
        case 'deliverables/presented': {
            const data = raw.data;
            if (typeof data.turn !== 'number' || typeof data.callId !== 'string' || !data.callId)
                return undefined;
            if (!Array.isArray(data.files) || data.files.length === 0)
                return undefined;
            const files = [];
            for (const file of data.files) {
                if (file === null || typeof file !== 'object' || Array.isArray(file))
                    return undefined;
                const { path, description } = file;
                if (typeof path !== 'string' || !path)
                    return undefined;
                if (description !== undefined && typeof description !== 'string')
                    return undefined;
                files.push(description === undefined ? { path } : { path, description });
            }
            return {
                type: 'deliverables/presented',
                turn: data.turn,
                callId: data.callId,
                files,
            };
        }
        default:
            return undefined;
    }
}
/**
 * 从 turn/end reason 提取错误信息
 *
 * 兼容三种形态：error（新格式）、failure（旧格式）、顶层 message/code（最旧格式）。
 */
export function extractTurnError(reason) {
    if (reason.kind !== 'error')
        return undefined;
    const detail = reason.error ?? reason.failure;
    return {
        code: detail?.code ?? reason.code ?? 'UNKNOWN',
        message: detail?.message ?? reason.message ?? 'unknown error',
    };
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
export function parseStreamFrame(raw) {
    if (raw === null || typeof raw !== 'object')
        return undefined;
    const agentId = raw.agent?.id;
    if (typeof agentId !== 'string' || !agentId)
        return undefined;
    const frame = raw.frame;
    if (frame === null || typeof frame !== 'object')
        return undefined;
    const { type, attemptId } = frame;
    if (typeof attemptId !== 'string' || !attemptId)
        return undefined;
    if (type === 'start') {
        return { agentId, delta: '' };
    }
    if (type === 'chunk') {
        const chunk = frame.chunk;
        if (chunk?.type !== 'text-delta' || typeof chunk.text !== 'string' || !chunk.text)
            return undefined;
        return { agentId, delta: chunk.text };
    }
    return undefined;
}
//# sourceMappingURL=events.js.map
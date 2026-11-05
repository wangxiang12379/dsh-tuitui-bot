import { describeApiError } from "./client.js";
import { truncate } from "../shared/index.js";
/**
 * 构造上下文（SDK 按 target 类型生成可路由的 sessionKey）。
 *
 * 帖子目标用 channel 形态（channelId + postId），群聊用 group，单聊用 direct。
 * 目标不完整（缺 teamId/postId 等）时返回 undefined，调用方放弃上报。
 */
export function buildAgentContext(client, target, messageId) {
    try {
        if (target.scope === 'post') {
            if (!target.channelId || !target.postId)
                return undefined;
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
    }
    catch {
        return undefined;
    }
}
class TuituiAgentStepReporter {
    client;
    config;
    logger;
    contexts = new Map();
    constructor(client, config, logger) {
        this.client = client;
        this.config = config;
        this.logger = logger;
    }
    messageReceived(target, messageId) {
        this.report('message_received', target, messageId, (context) => {
            this.client.agent.report.message_received(context);
        });
    }
    llmOutput(target, messageId, texts, thinking, usage = {}) {
        this.report('llm_output', target, messageId, (context) => {
            this.client.agent.report.llm_output(context, { assistantTexts: texts, thinking, usage });
        });
    }
    toolStart(target, messageId, report) {
        this.report('before_tool_call', target, messageId, (context) => {
            this.client.agent.report.before_tool_call(context, {
                toolCallId: report.toolCallId,
                toolName: report.toolName,
                ...(this.config.agentSteps.includeToolPayload && report.params ? { params: report.params } : {}),
            });
        });
    }
    toolEnd(target, messageId, report) {
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
    agentEnd(target, messageId) {
        this.report('agent_end', target, messageId, (context) => {
            this.client.agent.report.agent_end(context);
        });
        this.contexts.delete(this.contextKey(target, messageId));
    }
    contextKey(target, messageId) {
        return JSON.stringify([target.scope, target.targetId, target.channelId, target.postId, target.parentPostId, messageId]);
    }
    /**
     * 统一守卫：
     * - 关闭上报时直接返回
     * - 上下文构造失败（目标不合法）时返回
     * - SDK 入队/校验异常只记 debug
     */
    report(event, target, messageId, action) {
        if (!this.config.agentSteps.enabled)
            return;
        const key = this.contextKey(target, messageId);
        let context = this.contexts.get(key);
        try {
            if (!context) {
                context = buildAgentContext(this.client, target, messageId);
                if (!context)
                    return;
                this.contexts.set(key, context);
                if (event !== 'message_received')
                    this.client.agent.report.message_received(context);
            }
            else if (event === 'message_received') {
                return;
            }
            action(context);
        }
        catch (error) {
            this.logger.debug?.(`agent step report failed (event=${event}): ${describeApiError(error)}`);
        }
    }
}
/** 工具结果摘要：字符串直取、对象 JSON、超长截断（避免卡片被撑爆） */
export function summarizeResult(result, maxChars) {
    if (result === undefined || result === null)
        return '';
    if (typeof result === 'string')
        return truncate(result, maxChars);
    try {
        return truncate(JSON.stringify(result), maxChars);
    }
    catch {
        return '[unserializable result]';
    }
}
/** 创建上报器；关闭时返回 undefined，调用方据此跳过 */
export function createAgentStepReporter(client, config, logger) {
    if (!config.agentSteps.enabled)
        return undefined;
    return new TuituiAgentStepReporter(client, config, logger);
}
//# sourceMappingURL=agent-reporter.js.map
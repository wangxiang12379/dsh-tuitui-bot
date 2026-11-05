import { describe, expect, it, vi } from 'vitest';
import type { TuituiBotClient } from '@qihoo/tuitui-bot-sdk';
import type { ImTuituiConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import {
  buildAgentContext,
  createAgentStepReporter,
  summarizeResult,
} from './agent-reporter.ts';
import type { ToolCallReport } from './agent-reporter.ts';

interface ReportedEvent {
  event: string;
  args: unknown[];
}

/** 假 SDK：记录 buildContext 入参与每个上报事件 */
function createFakeClient(options: { throwOnBuild?: boolean } = {}) {
  const buildCalls: any[] = [];
  const reports: ReportedEvent[] = [];
  const record = (event: string) => (...args: unknown[]) => {
    reports.push({ event, args });
  };

  const client = {
    agent: {
      buildContext: (args: any) => {
        buildCalls.push(args);
        if (options.throwOnBuild) throw new Error('bad context');
        return { sessionKey: `sk:${args.target.type}`, messageId: args.messageId, runId: `run-${buildCalls.length}` };
      },
      report: {
        message_received: record('message_received'),
        llm_output: record('llm_output'),
        before_tool_call: record('before_tool_call'),
        after_tool_call: record('after_tool_call'),
        agent_end: record('agent_end'),
      },
    },
  };

  return { client: client as unknown as TuituiBotClient, buildCalls, reports };
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } satisfies Logger;
}

function createConfig(over: Partial<ImTuituiConfig['agentSteps']> = {}): ImTuituiConfig {
  return {
    agentSteps: { enabled: true, includeToolPayload: false, maxResultChars: 8, ...over },
  } as unknown as ImTuituiConfig;
}

const c2c: ReplyTarget = { scope: 'c2c', targetId: 'zhangsan' };
const group: ReplyTarget = { scope: 'group', targetId: 'g-1' };
const post: ReplyTarget = { scope: 'post', targetId: 'ch-1', teamId: 't-1', channelId: 'ch-1', postId: 'p-1' };

const report: ToolCallReport = {
  toolCallId: 'call-1',
  toolName: 'read_file',
  params: { path: '/tmp/a.txt' },
  result: { ok: true },
  ok: true,
};

describe('buildAgentContext', () => {
  it('单聊用 direct(account) 并透传 messageId', () => {
    const { client, buildCalls } = createFakeClient();

    const context = buildAgentContext(client, c2c, 'm-1');

    expect(buildCalls).toEqual([{ target: { type: 'direct', account: 'zhangsan' }, messageId: 'm-1' }]);
    expect(context).toEqual({ sessionKey: 'sk:direct', messageId: 'm-1', runId: 'run-1' });
  });

  it('群聊用 group(groupId)', () => {
    const { client, buildCalls } = createFakeClient();

    const context = buildAgentContext(client, group, 'm-2');

    expect(buildCalls).toEqual([{ target: { type: 'group', groupId: 'g-1' }, messageId: 'm-2' }]);
    expect(context).toEqual({ sessionKey: 'sk:group', messageId: 'm-2', runId: 'run-1' });
  });

  it('帖子用 channel(channelId+postId)，回帖带 parentPostId', () => {
    const { client, buildCalls } = createFakeClient();
    const target: ReplyTarget = { ...post, parentPostId: 'p-0' };

    buildAgentContext(client, target, 'p-1');

    expect(buildCalls[0]).toEqual({
      target: { type: 'channel', channelId: 'ch-1', postId: 'p-1', parentPostId: 'p-0' },
      messageId: 'p-1',
    });
  });

  it('帖子没有 parentPostId 时不塞该字段', () => {
    const { client, buildCalls } = createFakeClient();

    buildAgentContext(client, post, 'p-1');

    expect(buildCalls[0]?.target).not.toHaveProperty('parentPostId');
  });

  it('帖子缺 postId / channelId 时返回 undefined 且不调用 buildContext', () => {
    const missingPost = createFakeClient();
    expect(buildAgentContext(missingPost.client, { ...post, postId: undefined }, 'p-1')).toBeUndefined();
    expect(missingPost.buildCalls).toHaveLength(0);

    const missingChannel = createFakeClient();
    expect(buildAgentContext(missingChannel.client, { ...post, channelId: '' }, 'p-1')).toBeUndefined();
    expect(missingChannel.buildCalls).toHaveLength(0);
  });

  it('SDK 构造上下文抛错时返回 undefined，不向上抛', () => {
    const { client } = createFakeClient({ throwOnBuild: true });

    expect(buildAgentContext(client, group, 'm-1')).toBeUndefined();
  });
});

describe('createAgentStepReporter', () => {
  it('关闭上报时返回 undefined', () => {
    const { client } = createFakeClient();

    expect(createAgentStepReporter(client, createConfig({ enabled: false }), createLogger())).toBeUndefined();
  });
});

describe('TuituiAgentStepReporter 上报载荷', () => {
  it('messageReceived / agentEnd 分别上报对应事件', () => {
    const { client, reports } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig(), createLogger())!;

    reporter.messageReceived(group, 'm-1');
    reporter.agentEnd(group, 'm-1');

    expect(reports.map((item) => item.event)).toEqual(['message_received', 'agent_end']);
    expect(reports[0]?.args).toEqual([{ sessionKey: 'sk:group', messageId: 'm-1', runId: 'run-1' }]);
  });

  it('llmOutput 上报正文/thinking 与空 usage', () => {
    const { client, reports } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig(), createLogger())!;

    reporter.llmOutput(c2c, 'm-1', ['第一段', '第二段'], '思考中');

    expect(reports[1]?.event).toBe('llm_output');
    expect(reports[1]?.args[1]).toEqual({
      assistantTexts: ['第一段', '第二段'],
      thinking: '思考中',
      usage: {},
    });
  });

  it('toolStart 默认不上报工具参数', () => {
    const { client, reports } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig({ includeToolPayload: false }), createLogger())!;

    reporter.toolStart(group, 'm-1', report);

    expect(reports[1]?.event).toBe('before_tool_call');
    expect(reports[1]?.args[1]).toEqual({ toolCallId: 'call-1', toolName: 'read_file' });
  });

  it('includeToolPayload=true 时原样带上参数', () => {
    const { client, reports } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig({ includeToolPayload: true }), createLogger())!;

    reporter.toolStart(group, 'm-1', report);

    expect(reports[1]?.args[1]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'read_file',
      params: { path: '/tmp/a.txt' },
    });
  });

  it('toolEnd 默认只上报 ok 状态', () => {
    const { client, reports } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig({ includeToolPayload: false }), createLogger())!;

    reporter.toolEnd(group, 'm-1', { ...report, ok: false });

    expect(reports[1]?.event).toBe('after_tool_call');
    expect(reports[1]?.args[1]).toEqual({ toolCallId: 'call-1', toolName: 'read_file', result: { ok: false } });
  });

  it('includeToolPayload=true 时结果按 maxResultChars 截断', () => {
    const { client, reports } = createFakeClient();
    const reporter = createAgentStepReporter(
      client,
      createConfig({ includeToolPayload: true, maxResultChars: 8 }),
      createLogger(),
    )!;

    reporter.toolEnd(group, 'm-1', { ...report, result: 'abcdefghij' });

    expect(reports[1]?.args[1]).toEqual({
      toolCallId: 'call-1',
      toolName: 'read_file',
      result: 'abcdefg…',
    });
  });

  it('SDK 上报抛错时只记 debug，不影响主流程', () => {
    const { client } = createFakeClient();
    const logger = createLogger();
    const reporter = createAgentStepReporter(client, createConfig(), logger)!;
    vi.spyOn(client.agent.report, 'agent_end').mockImplementation(() => {
      throw new Error('queue full');
    });

    expect(() => reporter.agentEnd(group, 'm-1')).not.toThrow();

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(String(logger.debug.mock.calls[0]?.[0])).toContain('event=agent_end');
  });

  it('运行中关闭 agentSteps 后不再上报', () => {
    const { client, reports } = createFakeClient();
    const config = createConfig();
    const reporter = createAgentStepReporter(client, config, createLogger())!;

    config.agentSteps.enabled = false;
    reporter.agentEnd(group, 'm-1');

    expect(reports).toHaveLength(0);
  });

  it('目标不合法（帖子缺 postId）时静默跳过', () => {
    const { client, reports, buildCalls } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig(), createLogger())!;

    reporter.messageReceived({ ...post, postId: undefined }, 'm-1');

    expect(buildCalls).toHaveLength(0);
    expect(reports).toHaveLength(0);
  });

  it('同一消息的模型、工具和完成事件使用同一个 runId，下一次运行重新生成', () => {
    const { client, reports, buildCalls } = createFakeClient();
    const reporter = createAgentStepReporter(client, createConfig(), createLogger())!;
    reporter.llmOutput(group, 'm-1', [], '', { input: 10, output: 2, total: 12 });
    reporter.toolStart(group, 'm-1', report);
    reporter.toolEnd(group, 'm-1', report);
    reporter.agentEnd(group, 'm-1');
    expect(reports.map((item) => item.event)).toEqual(['message_received', 'llm_output', 'before_tool_call', 'after_tool_call', 'agent_end']);
    expect(reports.map((item) => (item.args[0] as { runId: string }).runId)).toEqual(Array(5).fill('run-1'));
    expect(reports[1]?.args[1]).toMatchObject({ usage: { input: 10, output: 2, total: 12 } });
    reporter.llmOutput(group, 'm-2', ['ok'], '');
    reporter.agentEnd(group, 'm-2');
    expect(buildCalls).toHaveLength(2);
    expect((reports[5]?.args[0] as { runId: string }).runId).toBe('run-2');
  });
});

describe('summarizeResult', () => {
  it('null/undefined 返回空串，短字符串原样返回', () => {
    expect(summarizeResult(undefined, 100)).toBe('');
    expect(summarizeResult(null, 100)).toBe('');
    expect(summarizeResult('done', 100)).toBe('done');
  });

  it('对象序列化为 JSON，超长则截断', () => {
    expect(summarizeResult({ a: 1 }, 100)).toBe('{"a":1}');
    expect(summarizeResult({ a: 'x'.repeat(20) }, 10)).toHaveLength(10);
  });

  it('不可序列化（循环引用）时返回占位文案', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(summarizeResult(circular, 100)).toBe('[unserializable result]');
  });
});

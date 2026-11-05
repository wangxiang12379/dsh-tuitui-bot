import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutboundHandler } from './outbound.ts';
import type { OutboundSenderLike } from './outbound-buffer.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImTuituiConfig } from '../config.ts';
import type { AgentStepReporter } from '../tuitui/agent-reporter.ts';
import type { Logger, ReplyTarget, StreamSessionLike } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined) };
}

function createBot(session: StreamSessionLike = createSession()): OutboundSenderLike {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(() => session),
  };
}

function createReporter(): AgentStepReporter {
  return {
    messageReceived: vi.fn(),
    llmOutput: vi.fn(),
    toolStart: vi.fn(),
    toolEnd: vi.fn(),
    agentEnd: vi.fn(),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };
const groupTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: 'msg1' };
const postTarget: ReplyTarget = {
  scope: 'post',
  targetId: 'ch1',
  channelId: 'ch1',
  teamId: 'team1',
  postId: 'post1',
  msgId: 'post1',
};

const SID = 'sess-tuitui';

function createRecord(target: ReplyTarget, sessionId = SID): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    scope: target.scope,
    peerId: target.targetId,
    senderId: 'sender',
    lastActivity: 0,
    agent: {},
    handle: {},
  } as unknown as SessionRecord;
}

function createConfig(overrides?: Partial<ImTuituiConfig>): ImTuituiConfig {
  return {
    streaming: true,
    textChunkLimit: 4500,
    showToolResults: false,
    ...overrides,
  } as unknown as ImTuituiConfig;
}

/** 组装 handler：manager 按 sessionId 返回 record（默认 c2c 私聊） */
function setup(opts?: {
  record?: SessionRecord | undefined;
  config?: ImTuituiConfig;
  deliverer?: { deliver: ReturnType<typeof vi.fn> };
  reporter?: AgentStepReporter;
  bot?: OutboundSenderLike;
  session?: StreamSessionLike;
}) {
  const session = opts?.session ?? createSession();
  const bot = opts?.bot ?? createBot(session);
  const record = 'record' in (opts ?? {}) ? opts?.record : createRecord(c2cTarget);
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === SID ? record : undefined)),
  } as unknown as SessionManager;
  const reporter = opts?.reporter ?? createReporter();
  const outbound = createOutboundHandler(
    manager,
    bot,
    opts?.config ?? createConfig(),
    createLogger(),
    undefined,
    opts?.deliverer,
    reporter,
  );
  return { outbound, bot, session, reporter };
}

/** 流式帧：空串 = 新 attempt 起点（见 events.parseStreamFrame） */
const delta = (text: string) => text;
const start = () => '';
const sessionRef = { header: { id: SID } };

describe('OutboundRouter.routeStreamFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式帧路由到会话 buffer：openStream + update', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
  });

  it('attempt 切换 reset：同一条流式消息被新内容全量重写', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('partial'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('partial');

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('full'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 流式会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'full'); // 全量替换
  });

  it('新 attempt 起点重置累积文本（agent replacement 语义）', async () => {
    const { outbound, session } = setup();

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('stale'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('stale');

    // 新 attempt 起点：清空累积文本，旧内容不会与新内容拼接
    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('fresh'));
    await vi.advanceTimersByTimeAsync(200);

    expect(session.update).toHaveBeenNthCalledWith(2, 'fresh');
  });

  it('非本会话（无 record）忽略流式帧', async () => {
    const { outbound, bot } = setup({ record: undefined });

    outbound.routeStreamFrame('sess-web', start());
    outbound.routeStreamFrame('sess-web', delta('hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('未知会话的重置帧不抛错', () => {
    const { outbound } = setup();
    expect(() => outbound.routeStreamFrame('sess-unknown', start())).not.toThrow();
  });

  it('群聊不流式：帧累积后由 assistant/message 静态发送', async () => {
    const { outbound, bot } = setup({ record: createRecord(groupTarget) });

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('group reply'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'group reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, 'group reply');
  });

  it('团队帖子不流式：静态走 sendMarkdown（发送器内部转 teams 发帖）', async () => {
    const { outbound, bot } = setup({ record: createRecord(postTarget) });

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('post reply'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'post reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(postTarget, 'post reply');
  });

  it('assistant/message 到达时收尾流式：complete 且不重复静态发送', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame(SID, start());
    outbound.routeStreamFrame(SID, delta('hello'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('旧通道回归：durable assistant/chunk 事件仍进 buffer', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'legacy' } },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('legacy');
  });

  it('流式关闭时 assistant/message 直接静态发送', async () => {
    const { outbound, bot } = setup({ config: createConfig({ streaming: false }) });

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'no stream' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, 'no stream');
  });

  it('超长回复按 textChunkLimit 切分为多条消息（出站节流逐条放行）', async () => {
    const { outbound, bot } = setup({ config: createConfig({ textChunkLimit: 20 }) });
    const long = Array.from({ length: 4 }, (_, i) => `line-${i}`).join('\n');

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: long }] } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // 首条立即

    await vi.advanceTimersByTimeAsync(300); // 节流窗口后放行下一条
    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('相同内容在去重窗口内只发一次（重放/重试不重复刷屏）', async () => {
    const { outbound, bot } = setup();
    const event = {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '同样的话' }] } },
    };

    outbound.routeSessionEvent(sessionRef, event);
    await vi.advanceTimersByTimeAsync(0);
    outbound.routeSessionEvent(sessionRef, event);
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);

    // 超过去重窗口（2s）后同一内容可以再次发送
    await vi.advanceTimersByTimeAsync(2001);
    outbound.routeSessionEvent(sessionRef, event);
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2);
  });
});

describe('OutboundRouter: 工具调用展示与步骤上报', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const toolCall = (callId: string, name: string, args = '{}') => ({
    type: 'tool/call',
    data: { callId, name, arguments: args },
  });
  const toolResult = (callId: string, text: string, error?: { name: string; code: string }) => ({
    type: 'tool/result',
    data: {
      message: { source: { callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] },
      ...(error !== undefined ? { error } : {}),
    },
  });

  it('config.showToolResults=false 时成功结果不发送，但仍上报步骤', async () => {
    const { outbound, bot, reporter } = setup();

    outbound.routeSessionEvent(sessionRef, toolCall('c1', 'bash', '{"cmd":"ls"}'));
    outbound.routeSessionEvent(sessionRef, toolResult('c1', 'done'));
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
    expect(reporter.toolStart).toHaveBeenCalledWith(c2cTarget, 'msg1', {
      toolCallId: 'c1',
      toolName: 'bash',
      params: { cmd: 'ls' },
      ok: true,
    });
    expect(reporter.toolEnd).toHaveBeenCalledWith(c2cTarget, 'msg1', expect.objectContaining({
      toolCallId: 'c1',
      toolName: 'bash',
      ok: true,
    }));
  });

  it('成功结果按开关发送（showToolResults=true）', async () => {
    const { outbound, bot } = setup({ config: createConfig({ showToolResults: true }) });

    outbound.routeSessionEvent(sessionRef, toolCall('c2', 'bash'));
    outbound.routeSessionEvent(sessionRef, toolResult('c2', 'output text'));
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('bash'));
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('output text'));
  });

  it('错误结果始终发送，即使 showToolResults=false', async () => {
    const { outbound, bot, reporter } = setup();

    outbound.routeSessionEvent(sessionRef, toolCall('c3', 'bash'));
    outbound.routeSessionEvent(sessionRef, toolResult('c3', '', { name: 'ToolError', code: 'E_FAIL' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('E_FAIL'));
    expect(reporter.toolEnd).toHaveBeenCalledWith(c2cTarget, 'msg1', expect.objectContaining({ ok: false }));
  });

  it('未登记的 callId 直接忽略（无 name 可展示）', async () => {
    const { outbound, bot } = setup({ config: createConfig({ showToolResults: true }) });

    outbound.routeSessionEvent(sessionRef, toolResult('unknown-call', 'x'));
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('assistant/message 上报 llmOutput，turn/end 上报 agentEnd', async () => {
    const { outbound, reporter } = setup();

    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'answer' }, { type: 'text', text: 'more' }] } },
    });
    outbound.routeSessionEvent(sessionRef, { type: 'turn/end', data: { reason: { kind: 'stop' } } });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(reporter.llmOutput).toHaveBeenCalledWith(c2cTarget, 'msg1', ['answer', 'more'], '', {});
    expect(reporter.agentEnd).toHaveBeenCalledWith(c2cTarget, 'msg1');
  });

  it('将每次模型调用的 Token 用量上报，包括只有工具调用的空文本消息', () => {
    const { outbound, reporter } = setup();
    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [] }, usage: { inputTokens: 9, outputTokens: 3, totalTokens: 15, cacheReadTokens: 3 } },
    });
    expect(reporter.llmOutput).toHaveBeenCalledWith(c2cTarget, 'msg1', [], '', {
      input: 9, output: 3, total: 15, cacheRead: 3,
    });
  });

  it('未提供上报器时一切照常（老环境降级）', async () => {
    const session = createSession();
    const bot = createBot(session);
    const manager = {
      findBySessionId: vi.fn(() => createRecord(c2cTarget)),
    } as unknown as SessionManager;
    const outbound = createOutboundHandler(manager, bot, createConfig(), createLogger());

    outbound.routeSessionEvent(sessionRef, toolCall('c4', 'bash'));
    outbound.routeSessionEvent(sessionRef, toolResult('c4', 'ok'));
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});

describe('OutboundRouter: deliverables/presented', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const presentedEvent = (callId: string, files: Array<{ path: string; description?: string }>) => ({
    type: 'deliverables/presented',
    data: { turn: 1, callId, files },
  });
  const turnEnd = { type: 'turn/end', data: { reason: { kind: 'stop' } } };
  const record = createRecord(c2cTarget);

  it('交付文件失败时仍结束原任务，且不误结束后续消息的任务', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('delivery failed'));
    const activeRecord = createRecord(c2cTarget);
    const { outbound, reporter } = setup({ record: activeRecord, deliverer: { deliver } });
    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, turnEnd);
    activeRecord.replyTarget = { ...c2cTarget, msgId: 'next-message' };
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(reporter.agentEnd).toHaveBeenCalledWith(c2cTarget, 'msg1');
    expect(reporter.agentEnd).toHaveBeenCalledTimes(1);
  });

  it('轮末投递声明的文件，且在文本之后', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, bot } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/report.xlsx' }]));
    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'final reply' }] } },
    });
    outbound.routeSessionEvent(sessionRef, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(record, [{ path: '/tmp/report.xlsx' }]);
    // 文本先于文件：markdown 发送的调用序在 deliver 之前
    const textOrder = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(textOrder).toBeLessThan(deliver.mock.invocationCallOrder[0]);
  });

  it('同 callId 去重：事件重放不重复投递', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, presentedEvent('c2', [{ path: '/tmp/b.png' }]));
    outbound.routeSessionEvent(sessionRef, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(record, [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }]);
  });

  it('assistant/message 在途文本未送达前不投递文件（等待 pending 发送完成）', async () => {
    let resolveText: (() => void) | undefined;
    const textTask = new Promise<void>((resolve) => {
      resolveText = resolve;
    });
    const bot: OutboundSenderLike = {
      sendMarkdown: vi.fn(() => textTask),
      openStream: vi.fn(() => createSession()),
    };
    const manager = { findBySessionId: vi.fn(() => createRecord(c2cTarget)) } as unknown as SessionManager;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const outbound = createOutboundHandler(manager, bot, createConfig(), createLogger(), undefined, { deliver });

    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply' }] } },
    });
    outbound.routeSessionEvent(sessionRef, turnEnd);
    await Promise.resolve();
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled(); // 文本仍在途

    resolveText?.();
    for (let i = 0; i < 10; i += 1) await Promise.resolve(); // 冲刷 catch 派生 + Promise.all 的微任务链
    expect(deliver).toHaveBeenCalledTimes(1); // 文本送达后才投递
  });

  it('配置关闭时不投递', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound } = setup({
      config: createConfig({
        sendFile: { restrictPaths: true, extraRoots: [], sendPresentedFiles: false, maxFiles: 4 },
      }),
      deliverer: { deliver },
    });

    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).not.toHaveBeenCalled();
  });

  it('异常结束的轮次仍投递已声明的文件（宿主契约：失败不撤销声明）', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const { outbound, bot } = setup({ deliverer: { deliver } });

    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'E_BROKEN', message: 'boom' } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, expect.stringContaining('E_BROKEN'));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('未提供投递器时静默跳过（老环境降级）', async () => {
    const { outbound, bot } = setup();

    outbound.routeSessionEvent(sessionRef, presentedEvent('c1', [{ path: '/tmp/a.png' }]));
    outbound.routeSessionEvent(sessionRef, turnEnd);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });
});

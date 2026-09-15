import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../server/session-store.js';

const PNG_FIXTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-sessions-'));
  const make = async (id, meta, messages = []) => {
    const directory = path.join(root, id);
    await fs.mkdir(path.join(directory, 'messages'), { recursive: true });
    await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify({ id, ...meta }), 'utf8');
    for (let index = 0; index < messages.length; index += 1) {
      await fs.writeFile(
        path.join(directory, 'messages', `${String(index).padStart(64, 'a')}.json`),
        JSON.stringify(messages[index]),
        'utf8'
      );
    }
  };
  return { root, make };
}

test('lists only normal sessions and selects the current live normal session', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await make('2026-09-13-aaaa1111', {
    title: 'Older live', conversationId: 'conversation-older', startedAt: 10, updatedAt: 20,
    endedAt: null, activeTurnId: null, origin: { kind: 'desktop' }
  });
  await make('2026-09-13-bbbb2222', {
    title: 'Current live', conversationId: 'conversation-current', startedAt: 15, updatedAt: 30,
    endedAt: null, activeTurnId: 'turn-1', lastTurnOutcome: 'completed', contextTokens: 12345,
    selectedModel: { model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: 29 }, origin: { kind: 'desktop' }
  });
  await make('2026-09-13-cccc3333', {
    title: 'Worker', conversationId: 'conversation-worker', startedAt: 50, updatedAt: 100,
    endedAt: null, activeTurnId: 'turn-worker', origin: { kind: 'worker' }
  });

  const store = new SessionStore(root);
  const result = await store.listNormalSessions();
  assert.deepEqual(result.sessions.map((session) => session.id), ['2026-09-13-bbbb2222', '2026-09-13-aaaa1111']);
  assert.equal(result.currentSessionId, '2026-09-13-bbbb2222');
  assert.equal(result.sessions[0].activity.state, 'active');
  assert.equal(result.sessions[0].selectedModel.provider.id, 'openai');
  assert.equal(result.sessions[0].selectedModel.provider.source, 'inferred');
  assert.equal(result.sessions[0].usage.contextTokens, 12345);

  const status = await store.statusSnapshot();
  assert.equal(status.normalSessions, 2);
  assert.equal(status.liveSessions, 2);
  assert.equal(status.currentSession.id, '2026-09-13-bbbb2222');
  assert.deepEqual(status.models, [{ id: 'gpt-5.6-sol', sessions: 1 }]);
  assert.equal(status.providers[0].label, 'OpenAI');
});

test('prefers the actually active live session over a newer idle live session', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await make('2026-09-13-active111', {
    title: 'Active', conversationId: 'conversation-active', startedAt: 10, updatedAt: 20,
    endedAt: null, activeTurnId: 'turn-active', origin: { kind: 'desktop' }
  });
  await make('2026-09-13-idle2222', {
    title: 'Newer idle', conversationId: 'conversation-idle', startedAt: 15, updatedAt: 99,
    endedAt: null, activeTurnId: null, origin: { kind: 'desktop' }
  });

  const result = await new SessionStore(root).listNormalSessions();
  assert.equal(result.currentSessionId, '2026-09-13-active111');
});

test('mirrors canonical user/assistant message files in durable sequence order', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-dddd4444';
  await make(id, {
    title: 'Transcript', conversationId: 'conversation-transcript', startedAt: 1, updatedAt: 5,
    endedAt: null, origin: { kind: 'desktop' }
  }, [
    { kind: 'assistant_message', seq: 8, time: 80, messageId: 'assistant-8', message: { text: 'Eight' }, state: 'final', final: true },
    { kind: 'page_tool', seq: 4, time: 40, messageId: 'tool-4', message: { text: 'Ignore tool' } },
    { kind: 'user_message', seq: 3, time: 30, messageId: 'user-3', message: { text: 'Three' } },
    { kind: 'assistant_message', seq: 6, time: 60, messageId: 'assistant-6', message: { text: 'Six' }, state: 'streaming', final: false }
  ]);

  const store = new SessionStore(root);
  const result = await store.messages(id, { afterSeq: 3 });
  assert.deepEqual(result.messages.map((message) => [message.seq, message.role, message.text, message.final]), [
    [6, 'assistant', 'Six', false],
    [8, 'assistant', 'Eight', true]
  ]);
  assert.equal(result.nextSeq, 8);
});

test('orders late-persisted messages by causal origin while keeping persistence seq as the cursor', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-order001';
  await make(id, {
    title: 'Causal order', conversationId: 'conversation-order', startedAt: 1, updatedAt: 50,
    endedAt: null, activeTurnId: 'turn-live', origin: { kind: 'desktop' }
  }, [
    { kind: 'assistant_message', seq: 20, origin: '20', time: 200, messageId: 'assistant-20', message: { text: 'Answer' }, state: 'final', final: true },
    { kind: 'user_message', seq: 30, origin: '10', time: 100, messageId: 'late-user-10', authoredText: 'Older prompt', inputDelivery: 'confirmed', message: { text: 'Older prompt' } },
    { kind: 'user_message', seq: 40, origin: '40', time: 400, messageId: 'user-40', authoredText: 'Current prompt', inputDelivery: 'confirmed', message: { text: 'Current prompt' } }
  ]);

  const store = new SessionStore(root);
  const full = await store.messages(id);
  assert.deepEqual(full.messages.map((message) => [message.id, message.order, message.seq]), [
    ['late-user-10', 10, 30],
    ['assistant-20', 20, 20],
    ['user-40', 40, 40]
  ]);
  assert.equal(full.nextSeq, 40);

  const delta = await store.messages(id, { afterSeq: 20 });
  assert.deepEqual(delta.messages.map((message) => [message.id, message.order, message.seq]), [
    ['late-user-10', 10, 30],
    ['user-40', 40, 40]
  ]);
  assert.equal(delta.nextSeq, 40);
});

test('projects one opaque response key across assistant progress, final answer, tools and visuals without exposing raw turn id', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-14-response1';
  const turnId = 'PRIVATE-TURN-ID-123';
  await make(id, {
    title: 'Response grouping', conversationId: 'conversation-response', startedAt: 1, updatedAt: 20,
    endedAt: null, activeTurnId: turnId, origin: { kind: 'desktop' }
  }, [
    { kind: 'assistant_message', seq: 6, time: 60, turnId, messageId: 'progress-1', message: { text: 'Visible progress' }, state: 'streaming', final: false },
    { kind: 'assistant_message', seq: 10, time: 100, turnId, messageId: 'final-1', message: { text: 'Final answer' }, state: 'final', final: true }
  ]);
  const directory = path.join(root, id);
  await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
  await fs.writeFile(path.join(directory, 'assets', 'proof.png'), PNG_FIXTURE);
  await fs.writeFile(path.join(directory, 'events.jsonl'), JSON.stringify({
    kind: 'tool_call', seq: 8, time: 80, turnId,
    call: { tool: 'view_image', outcome: 'ok', assets: [{ id: 'proof.png', mimeType: 'image/png', bytes: PNG_FIXTURE.length }] }
  }) + '\n', 'utf8');

  const store = new SessionStore(root);
  const [messages, activity] = await Promise.all([store.messages(id), store.activity(id)]);
  const keys = [
    messages.session.activity.activeResponseKey,
    messages.messages[0].responseKey,
    messages.messages[1].responseKey,
    activity.tools[0].responseKey,
    activity.visuals[0].responseKey
  ];
  assert.ok(keys.every((key) => /^response-[0-9a-f]{20}$/.test(key)));
  assert.equal(new Set(keys).size, 1);
  assert.equal(JSON.stringify({ messages: messages.messages, tools: activity.tools, visuals: activity.visuals }).includes(turnId), false);
});

test('idle message cache notices a newly persisted file even when meta updatedAt does not change', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-cache001';
  await make(id, {
    title: 'Cache invalidation', conversationId: 'conversation-cache', startedAt: 1, updatedAt: 50,
    endedAt: null, activeTurnId: null, origin: { kind: 'desktop' }
  }, [
    { kind: 'user_message', seq: 10, origin: 10, time: 100, messageId: 'user-10', authoredText: 'First', inputDelivery: 'confirmed', message: { text: 'First' } }
  ]);
  const directory = path.join(root, id, 'messages');
  const store = new SessionStore(root);
  const first = await store.messages(id);
  assert.deepEqual(first.messages.map((message) => message.id), ['user-10']);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.writeFile(path.join(directory, `${'f'.repeat(64)}.json`), JSON.stringify({
    kind: 'user_message', seq: 30, origin: '20', time: 200, messageId: 'late-user-20',
    authoredText: 'Late persisted', inputDelivery: 'confirmed', message: { text: 'Late persisted' }
  }), 'utf8');

  const second = await store.messages(id);
  assert.deepEqual(second.messages.map((message) => message.id), ['user-10', 'late-user-20']);
  assert.equal(second.nextSeq, 30);
});

test('active message polling indexes immutable files and returns only appended deltas', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-index001';
  await make(id, {
    title: 'Live index', conversationId: 'conversation-index', startedAt: 1, updatedAt: 50,
    endedAt: null, activeTurnId: 'turn-live', origin: { kind: 'desktop' }
  }, [
    { kind: 'user_message', seq: 10, origin: 10, time: 100, messageId: 'user-10', authoredText: 'First', inputDelivery: 'confirmed', message: { text: 'First' } }
  ]);
  const directory = path.join(root, id, 'messages');
  const store = new SessionStore(root);
  const first = await store.messages(id);
  assert.deepEqual(first.messages.map((message) => message.id), ['user-10']);
  assert.equal(store.messageFileCache.get(id)?.rows.size, 1);

  await fs.writeFile(path.join(directory, `${'e'.repeat(64)}.json`), JSON.stringify({
    kind: 'assistant_message', seq: 20, origin: 20, time: 200, messageId: 'assistant-20',
    message: { text: 'Second' }, state: 'final', final: true
  }), 'utf8');

  const delta = await store.messages(id, { afterSeq: 10 });
  assert.deepEqual(delta.messages.map((message) => message.id), ['assistant-20']);
  assert.equal(delta.nextSeq, 20);
  assert.equal(store.messageFileCache.get(id)?.rows.size, 2);
});

test('projects task plan and tool activity without raw tool payloads or local paths', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-activity1';
  await make(id, {
    title: 'Activity', conversationId: 'conversation-activity', startedAt: 1, updatedAt: 4,
    endedAt: null, origin: { kind: 'desktop' }
  });
  const directory = path.join(root, id);
  await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
  await fs.writeFile(path.join(directory, 'assets', 'private-screen.png'), PNG_FIXTURE);
  await fs.writeFile(path.join(directory, 'assets', 'private-vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify({
    updatedAt: 50,
    explanation: 'do not expose this explanation',
    plan: [
      { step: 'Inspect C:\\Users\\private\\secret.txt', status: 'completed', details: 'hidden details' },
      { step: 'Polish the mobile UI', status: 'in_progress' }
    ]
  }), 'utf8');
  await fs.writeFile(path.join(directory, 'events.jsonl'), [
    JSON.stringify({
      kind: 'tool_call', seq: 7, time: 70,
      call: {
        tool: 'exec_command', args: { cmd: 'private command' }, result: 'private result', durationMs: 123,
        outcome: 'ok', summary: { kind: 'run', tone: 'good', title: 'Ran a command', detail: 'C:\\Users\\private\\secret.txt', metric: '✓ 123ms' }
      }
    }),
    JSON.stringify({
      kind: 'tool_call', seq: 8, time: 80,
      call: { tool: 'read', durationMs: 10, outcome: 'failed', summary: { kind: 'read', tone: 'bad', title: 'Read failed' } }
    }),
    JSON.stringify({
      kind: 'tool_call', seq: 9, time: 90,
      call: {
        tool: 'view_image', args: { path: 'C:\\Users\\private\\private-screen.png' }, outcome: 'ok',
        assets: [
          { id: 'private-screen.png', mimeType: 'image/png', bytes: PNG_FIXTURE.length },
          { id: 'private-vector.svg', mimeType: 'image/svg+xml', bytes: 46 }
        ]
      }
    })
  ].join('\n') + '\n', 'utf8');

  const store = new SessionStore(root);
  const activity = await store.activity(id);
  assert.equal(activity.plan.steps.length, 2);
  assert.equal(activity.plan.steps[0].status, 'completed');
  assert.match(activity.plan.steps[0].step, /\[local path\]/);
  assert.equal(activity.tools[0].category, 'terminal');
  assert.equal(activity.tools[0].status, 'completed');
  assert.equal(activity.tools[0].title, 'Command execution');
  assert.equal(activity.tools[0].detail, null);
  assert.equal(activity.tools[0].metric, '123 ms');
  assert.equal(activity.tools[1].status, 'failed');
  assert.equal(activity.visuals.length, 1);
  assert.match(activity.visuals[0].id, /^visual-[0-9a-f]{24}$/);
  assert.equal(activity.visuals[0].mimeType, 'image/png');
  assert.equal(activity.visuals[0].bytes, PNG_FIXTURE.length);
  assert.equal(activity.visuals[0].label, 'Visual proof');
  const visual = await store.visual(id, activity.visuals[0].id);
  assert.equal(visual.mimeType, 'image/png');
  assert.equal(visual.bytes, PNG_FIXTURE.length);
  await assert.rejects(() => store.visual(id, 'visual-000000000000000000000000'), { code: 'VISUAL_NOT_FOUND' });
  assert.equal(JSON.stringify(activity).includes('Ran a command'), false);
  assert.equal(JSON.stringify(activity).includes('Read failed'), false);
  assert.equal(JSON.stringify(activity).includes('secret.txt'), false);
  assert.equal(JSON.stringify(activity).includes('private command'), false);
  assert.equal(JSON.stringify(activity).includes('private result'), false);
  assert.equal(JSON.stringify(activity).includes('private-screen.png'), false);
  assert.equal(JSON.stringify(activity).includes('private-vector.svg'), false);
  assert.equal(JSON.stringify(activity).includes('hidden details'), false);
  assert.equal(JSON.stringify(activity).includes('do not expose this explanation'), false);
});

test('projects linked worker lifecycle without exposing worker task or result text', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parentId = '2026-09-13-parent001';
  await make(parentId, {
    title: 'Parent', conversationId: 'conversation-parent', startedAt: 1, updatedAt: 20,
    endedAt: null, activeTurnId: 'turn-parent', origin: { kind: 'desktop' }
  });
  await make('2026-09-13-worker001', {
    title: 'worker-2 · PRIVATE TITLE', conversationId: 'conversation-worker', startedAt: 5, updatedAt: 18,
    endedAt: null, activeTurnId: 'turn-worker', lastTurnOutcome: null,
    origin: { kind: 'worker', fromSessionId: parentId, agentId: 'worker-2', task: 'PRIVATE TASK C:\\secret.txt' },
    result: 'PRIVATE RESULT'
  });
  await make('2026-09-13-worker002', {
    title: 'worker-5 · PRIVATE TITLE', conversationId: 'conversation-worker-2', startedAt: 6, updatedAt: 17,
    endedAt: null, activeTurnId: null, lastTurnOutcome: 'completed',
    origin: { kind: 'worker', fromSessionId: parentId, agentId: 'worker-5', task: 'PRIVATE TASK 2' },
    result: 'PRIVATE RESULT 2'
  });

  const agents = await new SessionStore(root).relatedWorkers(parentId);
  assert.deepEqual(agents.map((agent) => [agent.id, agent.status]), [['worker-2', 'working'], ['worker-5', 'done']]);
  const serialized = JSON.stringify(agents);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('secret.txt'), false);
  assert.equal(serialized.includes('conversation-worker'), false);
});

test('tool activity scans full history once and then notices appended events even when meta timestamp does not change', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-activity2';
  await make(id, {
    title: 'Long activity', conversationId: 'conversation-long-activity', startedAt: 1, updatedAt: 4,
    endedAt: null, activeTurnId: 'turn-live', origin: { kind: 'desktop' }
  });
  const directory = path.join(root, id);
  const oldTool = JSON.stringify({
    kind: 'tool_call', seq: 5, time: 50,
    call: { tool: 'web_search', durationMs: 20, outcome: 'ok', args: { q: 'private' }, result: 'private' }
  });
  const padding = Array.from({ length: 900 }, (_, index) => JSON.stringify({
    kind: 'debug_event', seq: 10 + index, note: 'x'.repeat(700)
  })).join('\n');
  await fs.writeFile(path.join(directory, 'events.jsonl'), `${oldTool}\n${padding}\n`, 'utf8');

  const store = new SessionStore(root);
  const first = await store.activity(id, { limit: 5000 });
  assert.deepEqual(first.tools.map((tool) => tool.seq), [5]);
  assert.equal(first.tools[0].title, 'Web activity');

  const newTool = JSON.stringify({
    kind: 'tool_call', seq: 1200, time: 12000,
    call: { tool: 'read', durationMs: 9, outcome: 'ok', args: { file: 'private' }, result: 'private' }
  });
  await fs.appendFile(path.join(directory, 'events.jsonl'), `${newTool}\n`, 'utf8');
  const delta = await store.activity(id, { limit: 5000, afterSeq: 5 });
  assert.deepEqual(delta.tools.map((tool) => tool.seq), [1200]);
  assert.equal(delta.nextToolSeq, 1200);
  assert.equal(JSON.stringify(delta).includes('private'), false);
});

test('activity projects safe response lifecycle and revision resync recovers a lost lower-seq append', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-14-life0001';
  const turnId = 'PRIVATE-TURN-LIFECYCLE';
  await make(id, {
    title: 'Lifecycle', conversationId: 'conversation-lifecycle', startedAt: 1, updatedAt: 4,
    endedAt: null, activeTurnId: turnId, origin: { kind: 'desktop' }
  });
  const directory = path.join(root, id);
  const eventFile = path.join(directory, 'events.jsonl');
  await fs.writeFile(eventFile, [
    JSON.stringify({ kind: 'turn_start', seq: 10, time: 100, turnId }),
    JSON.stringify({ kind: 'tool_call', seq: 100, time: 200, turnId, call: { tool: 'read', durationMs: 5, outcome: 'ok' } }),
    JSON.stringify({ kind: 'turn_end', seq: 110, time: 300, turnId, outcome: 'completed' })
  ].join('\n') + '\n', 'utf8');

  const store = new SessionStore(root);
  const first = await store.activity(id);
  assert.equal(first.responses.length, 1);
  assert.match(first.responses[0].responseKey, /^response-[0-9a-f]{20}$/);
  assert.deepEqual(
    { startedSeq: first.responses[0].startedSeq, startedAt: first.responses[0].startedAt, endedSeq: first.responses[0].endedSeq, endedAt: first.responses[0].endedAt, outcome: first.responses[0].outcome },
    { startedSeq: 10, startedAt: 100, endedSeq: 110, endedAt: 300, outcome: 'completed' }
  );
  assert.equal(JSON.stringify(first.responses).includes(turnId), false);
  const acknowledgedRevision = first.revision;

  await fs.appendFile(eventFile, JSON.stringify({
    kind: 'tool_call', seq: 50, time: 250, turnId,
    call: { tool: 'web_search', durationMs: 7, outcome: 'ok' }
  }) + '\n', 'utf8');
  const deliveredButLost = await store.activity(id, { afterSeq: 100, revision: acknowledgedRevision });
  assert.equal(deliveredButLost.resync, false);
  assert.deepEqual(deliveredButLost.tools.map((tool) => tool.seq), [50]);
  assert.ok(deliveredButLost.revision > acknowledgedRevision);

  // Simulate the phone losing that HTTP response: it retries with the old append
  // revision. The server cache is already newer, so return a full safe projection.
  const recovered = await store.activity(id, { afterSeq: 100, revision: acknowledgedRevision });
  assert.equal(recovered.resync, true);
  assert.deepEqual(recovered.tools.map((tool) => tool.seq), [50, 100]);
});

test('user messages prefer authored text, strip COS context, and hide handoff bootstrap rows', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-visible1';
  const hiddenContext = 'PRIVATE CONTEXT';
  const screenContext = 'A screenshot is at C:\\PRIVATE\\desktop.jpg';
  await make(id, {
    title: 'Visible prompts', conversationId: 'conversation-visible', startedAt: 1, updatedAt: 9,
    endedAt: null, origin: { kind: 'desktop' }
  }, [
    {
      kind: 'user_message', seq: 2, time: 20, messageId: 'authored', authoredText: 'Show only this prompt',
      message: { text: 'wrapped text that should lose' }
    },
    {
      kind: 'user_message', seq: 3, time: 30, messageId: 'context',
      message: { text: `[[COS_CONTEXT:${hiddenContext.length}]]\n${hiddenContext}\n[[/COS_CONTEXT]]\n\nReal user prompt` }
    },
    {
      kind: 'user_message', seq: 4, time: 40, messageId: 'handoff',
      message: { text: '[[CLF-HANDOFF:abcdefghijklmnop]]\n\nInternal bootstrap' }
    },
    {
      kind: 'user_message', seq: 5, time: 50, messageId: 'screen-context',
      message: { text: `[[OPENDRAW_SCREEN_CONTEXT:${screenContext.length}]]\n${screenContext}\n[[/OPENDRAW_SCREEN_CONTEXT]]\n\nWhat is on my screen?` }
    }
  ]);
  const rows = (await new SessionStore(root).messages(id)).messages;
  assert.deepEqual(rows.map((row) => row.text), ['Show only this prompt', 'Real user prompt', 'What is on my screen?']);
  assert.equal(JSON.stringify(rows).includes(hiddenContext), false);
  assert.equal(JSON.stringify(rows).includes(screenContext), false);
  assert.equal(JSON.stringify(rows).includes('OPENDRAW_SCREEN_CONTEXT'), false);
  assert.equal(JSON.stringify(rows).includes('Internal bootstrap'), false);
});

test('message wait returns immediately when a new durable assistant update appears', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-stream1';
  await make(id, {
    title: 'Streaming', conversationId: 'conversation-stream', startedAt: 1, updatedAt: 2,
    endedAt: null, activeTurnId: 'turn-stream', origin: { kind: 'desktop' }
  }, [{ kind: 'user_message', seq: 2, time: 20, messageId: 'u2', message: { text: 'Go' } }]);
  const store = new SessionStore(root);
  const pending = store.waitForMessages(id, { afterSeq: 2, waitMs: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 70));
  const directory = path.join(root, id);
  await fs.writeFile(path.join(directory, 'messages', `${'f'.repeat(64)}.json`), JSON.stringify({
    kind: 'assistant_message', seq: 5, time: 50, messageId: 'assistant-live',
    message: { text: 'First durable streaming update' }, state: 'streaming', final: false
  }), 'utf8');
  const meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
  await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify({ ...meta, updatedAt: 50 }), 'utf8');
  const result = await pending;
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, 'First durable streaming update');
  assert.equal(result.messages[0].final, false);
  assert.equal(result.nextSeq, 5);
});

test('message wait times out with an empty delta even when no filesystem event arrives', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-stream2';
  await make(id, {
    title: 'Wait timeout', conversationId: 'conversation-stream-timeout', startedAt: 1, updatedAt: 2,
    endedAt: null, activeTurnId: 'turn-stream', origin: { kind: 'desktop' }
  }, [{ kind: 'user_message', seq: 2, time: 20, messageId: 'u2', message: { text: 'Go' } }]);
  const store = new SessionStore(root);
  const started = Date.now();
  const result = await store.waitForMessages(id, { afterSeq: 2, waitMs: 90 });
  const elapsed = Date.now() - started;
  assert.deepEqual(result.messages, []);
  assert.equal(result.nextSeq, 2);
  assert.ok(elapsed >= 60 && elapsed < 1000, `unexpected wait ${elapsed}ms`);
});

test('message wait aborts promptly so a disconnected phone cannot leave a watcher behind', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-stream3';
  await make(id, {
    title: 'Wait abort', conversationId: 'conversation-stream-abort', startedAt: 1, updatedAt: 2,
    endedAt: null, activeTurnId: 'turn-stream', origin: { kind: 'desktop' }
  }, [{ kind: 'user_message', seq: 2, time: 20, messageId: 'u2', message: { text: 'Go' } }]);
  const store = new SessionStore(root);
  const controller = new AbortController();
  const pending = store.waitForMessages(id, { afterSeq: 2, waitMs: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 45);
  await assert.rejects(pending, (error) => error?.code === 'ABORT_ERR');
});

test('requires exact durable conversation target', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-eeee5555';
  await make(id, {
    title: 'Exact target', conversationId: 'conversation-exact', startedAt: 1, updatedAt: 2,
    endedAt: null, origin: { kind: 'desktop' }
  });
  const store = new SessionStore(root);
  await store.assertExactTarget(id, 'conversation-exact');
  await assert.rejects(() => store.assertExactTarget(id, 'conversation-wrong'), /does not match/);
});

test('requires the exact current active turn before exposing a stop action', async (t) => {
  const { root, make } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-13-stop6666';
  await make(id, {
    title: 'Stopping', conversationId: 'conversation-stop', startedAt: 1, updatedAt: 2,
    endedAt: null, activeTurnId: 'turn-current', origin: { kind: 'desktop' }
  });
  const store = new SessionStore(root);
  assert.equal((await store.assertActiveTurn(id, 'turn-current')).activity.activeTurnId, 'turn-current');
  await assert.rejects(
    () => store.assertActiveTurn(id, 'turn-stale'),
    (error) => error?.code === 'ACTIVE_TURN_CHANGED'
  );
});

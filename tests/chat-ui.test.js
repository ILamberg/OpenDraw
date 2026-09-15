import assert from 'node:assert/strict';
import test from 'node:test';
import { contextPressure, groupPromptTimeline, messageChronology, messageSignature, nearBottomMetrics, pendingDraftAttempt, pendingMessageAttempt, promptPreview, sendReceiptTerminal, streamWordChunks, streamWordsPerSecond } from '../public/chat-ui.js';

test('near-bottom uses a threshold rather than exact scroll equality', () => {
  assert.equal(nearBottomMetrics({ scrollHeight: 1000, scrollTop: 390, clientHeight: 500 }, 120), true);
  assert.equal(nearBottomMetrics({ scrollHeight: 1000, scrollTop: 300, clientHeight: 500 }, 120), false);
});

test('prompt preview normalizes long whitespace without leaking giant prompts', () => {
  assert.equal(promptPreview('  hello\n\nworld  ', 20), 'hello world');
  assert.equal(promptPreview('a'.repeat(30), 10), 'aaaaaaaaa…');
});

test('context pressure uses real thresholds and current context only', () => {
  assert.equal(contextPressure(200, 1000, 700, 800).level, 'normal');
  assert.equal(contextPressure(800, 1000, 700, 800).level, 'warn');
  assert.equal(contextPressure(960, 1000, 700, 800).level, 'danger');
  assert.equal(Math.round(contextPressure(500, 1000, null, null).percent), 50);
});

test('message signature changes when a streaming message grows or becomes final', () => {
  const first = messageSignature([{ id: 'a', seq: 1, text: 'hello', final: false }]);
  const grown = messageSignature([{ id: 'a', seq: 1, text: 'hello world', final: false }]);
  const final = messageSignature([{ id: 'a', seq: 1, text: 'hello world', final: true }]);
  assert.notEqual(first, grown);
  assert.notEqual(grown, final);
});

test('message signature notices causal timeline order changes independently from persistence seq', () => {
  const first = messageSignature([{ id: 'a', seq: 30, order: 10, text: 'hello', final: true }]);
  const moved = messageSignature([{ id: 'a', seq: 30, order: 20, text: 'hello', final: true }]);
  assert.notEqual(first, moved);
});

test('message chronology prefers authored time so late persistence cannot move an old prompt to the bottom', () => {
  assert.equal(messageChronology({ seq: 900, order: 100, time: 2000 }), 2000);
  assert.equal(messageChronology({ seq: 900, order: 100 }), 100);
  assert.equal(messageChronology({ seq: 900 }), 900);
});

test('send receipts stay retry-idempotent until COS reports terminal delivery or failure', () => {
  assert.equal(sendReceiptTerminal({ status: 'accepted' }), false);
  assert.equal(sendReceiptTerminal({ state: 'queued' }), false);
  assert.equal(sendReceiptTerminal({ state: 'browser' }), false);
  assert.equal(sendReceiptTerminal({ state: 'sent' }), true);
  assert.equal(sendReceiptTerminal({ status: 'accepted', deliveredAt: 123 }), true);
  assert.equal(sendReceiptTerminal({ state: 'failed' }), true);
  assert.equal(sendReceiptTerminal({ state: 'cancelled' }), true);
});

test('ambiguous message retries preserve the original screen attachment flag and UUID semantics', () => {
  const expected = {
    sessionId: '2026-09-13-abcd1234',
    conversationId: 'conversation-live-123',
    text: 'Inspect this',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    mode: 'auto'
  };
  const legacyScreen = {
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: 10,
    fingerprint: JSON.stringify({ source: 'screen', ...expected })
  };
  assert.deepEqual(pendingMessageAttempt([legacyScreen], expected), {
    id: legacyScreen.id,
    fingerprint: legacyScreen.fingerprint,
    screen: true
  });

  const plain = {
    id: '22222222-2222-4222-8222-222222222222',
    createdAt: 20,
    fingerprint: JSON.stringify(expected)
  };
  assert.equal(pendingMessageAttempt([plain], expected)?.screen, false);
  assert.equal(pendingMessageAttempt([legacyScreen], { ...expected, text: 'Different text' }), null);
});

test('new-chat ambiguous retries keep their original screen attachment when viewer state changes', () => {
  const expected = {
    projectId: '11111111-1111-4111-8111-111111111111',
    text: 'Start here',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high'
  };
  const id = '33333333-3333-4333-8333-333333333333';
  const fingerprint = JSON.stringify({ ...expected, screen: true });
  assert.deepEqual(pendingDraftAttempt(id, fingerprint, expected), { id, fingerprint, screen: true });
  assert.equal(pendingDraftAttempt(id, fingerprint, { ...expected, model: 'other-model' }), null);
});

test('message signature notices same-length corrections in the middle of a durable revision', () => {
  const first = messageSignature([{ id: 'a', seq: 1, text: 'alpha bravo omega', final: false, state: 'streaming' }]);
  const corrected = messageSignature([{ id: 'a', seq: 1, text: 'alpha crane omega', final: false, state: 'streaming' }]);
  assert.notEqual(first, corrected);
});

test('message signature notices response ownership corrections without text changes', () => {
  const first = messageSignature([{ id: 'a', seq: 8, order: 8, text: 'same text', final: false, responseKey: 'response-one' }]);
  const moved = messageSignature([{ id: 'a', seq: 8, order: 8, text: 'same text', final: false, responseKey: 'response-two' }]);
  assert.notEqual(first, moved);
});

test('prompt timeline keeps late response A work with prompt A after queued prompt B arrives', () => {
  const messages = [
    { id: 'prompt-a', role: 'user', seq: 10, order: 10, time: 100, text: 'A', final: true },
    { id: 'a-progress-1', role: 'assistant', seq: 14, order: 14, time: 140, text: 'A progress', final: false, responseKey: 'response-a' },
    { id: 'prompt-b', role: 'user', seq: 20, order: 20, time: 200, text: 'B', final: true },
    { id: 'a-progress-2', role: 'assistant', seq: 24, order: 24, time: 240, text: 'A still working', final: false, responseKey: 'response-a' },
    { id: 'a-final', role: 'assistant', seq: 28, order: 28, time: 280, text: 'A final', final: true, responseKey: 'response-a' },
    { id: 'b-progress', role: 'assistant', seq: 34, order: 34, time: 340, text: 'B progress', final: false, responseKey: 'response-b' },
    { id: 'b-final', role: 'assistant', seq: 38, order: 38, time: 380, text: 'B final', final: true, responseKey: 'response-b' }
  ];
  const responses = [
    { responseKey: 'response-a', startedSeq: 12, endedSeq: 30, outcome: 'completed' },
    { responseKey: 'response-b', startedSeq: 32, endedSeq: 40, outcome: 'completed' }
  ];
  const tools = [
    { id: 'tool-a-1', seq: 16, responseKey: 'response-a', status: 'completed' },
    { id: 'tool-a-late', seq: 26, responseKey: 'response-a', status: 'completed' },
    { id: 'tool-b', seq: 36, responseKey: 'response-b', status: 'completed' }
  ];
  const visuals = [{ id: 'visual-a', seq: 27, responseKey: 'response-a' }];

  const { bundles } = groupPromptTimeline({ messages, responses, tools, visuals });
  assert.equal(bundles.length, 2);
  const a = bundles[0];
  const b = bundles[1];
  assert.equal(a.prompt.id, 'prompt-a');
  assert.deepEqual([...a.responseKeys], ['response-a']);
  assert.deepEqual(a.workRows.map((row) => row.kind === 'tool' ? row.tool.id : row.message.id), [
    'a-progress-1', 'tool-a-1', 'a-progress-2', 'tool-a-late'
  ]);
  assert.deepEqual(a.finals.map((message) => message.id), ['a-final']);
  assert.deepEqual(a.visuals.map((visual) => visual.id), ['visual-a']);
  assert.equal(b.prompt.id, 'prompt-b');
  assert.deepEqual([...b.responseKeys], ['response-b']);
  assert.deepEqual(b.workRows.map((row) => row.kind === 'tool' ? row.tool.id : row.message.id), ['b-progress', 'tool-b']);
  assert.deepEqual(b.finals.map((message) => message.id), ['b-final']);
});

test('prompt timeline merges multiple response turns into one prompt bundle and ignores ambiguous orphan tools', () => {
  const messages = [
    { id: 'prompt-a', role: 'user', seq: 10, order: 10, text: 'A', final: true },
    { id: 'a1-progress', role: 'assistant', seq: 13, order: 13, text: 'one', final: false, responseKey: 'response-a1' },
    { id: 'a1-final', role: 'assistant', seq: 16, order: 16, text: 'one done', final: true, responseKey: 'response-a1' },
    { id: 'a2-progress', role: 'assistant', seq: 19, order: 19, text: 'two', final: false, responseKey: 'response-a2' },
    { id: 'a2-final', role: 'assistant', seq: 23, order: 23, text: 'two done', final: true, responseKey: 'response-a2' },
    { id: 'prompt-b', role: 'user', seq: 30, order: 30, text: 'B', final: true }
  ];
  const responses = [
    { responseKey: 'response-a1', startedSeq: 12, endedSeq: 17 },
    { responseKey: 'response-a2', startedSeq: 18, endedSeq: 24 }
  ];
  const tools = [
    { id: 'owned-legacy', seq: 15, responseKey: null, status: 'completed' },
    { id: 'orphan-after-turns', seq: 27, responseKey: null, status: 'completed' }
  ];
  const { bundles } = groupPromptTimeline({ messages, responses, tools });
  assert.deepEqual([...bundles[0].responseKeys].sort(), ['response-a1', 'response-a2']);
  assert.equal(bundles[0].workRows.some((row) => row.tool?.id === 'owned-legacy'), true);
  assert.equal(bundles.some((bundle) => bundle.workRows.some((row) => row.tool?.id === 'orphan-after-turns')), false);
  assert.deepEqual(bundles[0].finals.map((message) => message.id), ['a1-final', 'a2-final']);
});

test('prompt timeline never puts late progress or tools into Thinking after a response has finalized', () => {
  const messages = [
    { id: 'prompt-a', role: 'user', seq: 10, order: 10, text: 'A', final: true },
    { id: 'a-progress', role: 'assistant', seq: 13, order: 13, text: 'working', final: false, responseKey: 'response-a' },
    { id: 'a-final', role: 'assistant', seq: 20, order: 20, text: 'final answer', final: true, responseKey: 'response-a' },
    { id: 'a-late-progress', role: 'assistant', seq: 22, order: 22, text: 'late progress that must stay hidden', final: false, responseKey: 'response-a' }
  ];
  const responses = [{ responseKey: 'response-a', startedSeq: 12, endedSeq: 24, outcome: 'completed' }];
  const tools = [
    { id: 'tool-before-final', seq: 15, responseKey: 'response-a', status: 'completed' },
    { id: 'tool-after-final', seq: 23, responseKey: 'response-a', status: 'completed' }
  ];

  const { bundles } = groupPromptTimeline({ messages, responses, tools });
  assert.deepEqual(bundles[0].workRows.map((row) => row.kind === 'tool' ? row.tool.id : row.message.id), [
    'a-progress',
    'tool-before-final'
  ]);
  assert.deepEqual(bundles[0].finals.map((message) => message.id), ['a-final']);
  assert.equal(bundles[0].workRows.some((row) => row.message?.id === 'a-late-progress'), false);
  assert.equal(bundles[0].workRows.some((row) => row.tool?.id === 'tool-after-final'), false);
});

test('completed response promotes a terminal final:false assistant row out of Thinking', () => {
  const messages = [
    { id: 'prompt-a', role: 'user', seq: 10, order: 10, text: 'A', final: true },
    { id: 'a-progress', role: 'assistant', seq: 13, order: 13, text: 'Still checking', final: false, responseKey: 'response-a' },
    { id: 'a-answer', role: 'assistant', seq: 19, order: 19, text: 'This is the actual final response', final: false, state: 'streaming', responseKey: 'response-a' },
    { id: 'a-late', role: 'assistant', seq: 22, order: 22, text: 'late persistence must stay hidden', final: false, responseKey: 'response-a' }
  ];
  const responses = [{ responseKey: 'response-a', startedSeq: 12, endedSeq: 20, outcome: 'completed' }];

  const { bundles } = groupPromptTimeline({ messages, responses });
  assert.deepEqual(bundles[0].workRows.map((row) => row.message?.id), ['a-progress']);
  assert.deepEqual(bundles[0].finals.map((message) => [message.id, message.final, message.state]), [
    ['a-answer', true, 'final']
  ]);
  assert.equal(bundles[0].workRows.some((row) => row.message?.id === 'a-answer'), false);
  assert.equal(bundles[0].workRows.some((row) => row.message?.id === 'a-late'), false);
});

test('completed lifecycle claims keyless terminal assistant text and keeps it outside Thinking', () => {
  const messages = [
    { id: 'prompt-a', role: 'user', seq: 10, order: 10, text: 'A', final: true },
    { id: 'legacy-progress', role: 'assistant', seq: 13, order: 13, text: 'Working', final: false },
    { id: 'legacy-answer', role: 'assistant', seq: 19, order: 19, text: 'Final response without turnId', final: false, state: 'streaming' },
    { id: 'legacy-late', role: 'assistant', seq: 22, order: 22, text: 'late row', final: false }
  ];
  const responses = [{ responseKey: 'response-a', startedSeq: 12, endedSeq: 20, outcome: 'completed' }];

  const { bundles } = groupPromptTimeline({ messages, responses });
  assert.deepEqual(bundles[0].workRows.map((row) => row.message?.id), ['legacy-progress']);
  assert.deepEqual(bundles[0].finals.map((message) => [message.id, message.final]), [['legacy-answer', true]]);
  assert.equal(bundles[0].workRows.some((row) => row.message?.id === 'legacy-answer'), false);
  assert.equal(bundles[0].workRows.some((row) => row.message?.id === 'legacy-late'), false);
});

test('queued later prompt cannot steal a keyless terminal answer from the earlier completed response', () => {
  const messages = [
    { id: 'prompt-a', role: 'user', seq: 10, order: 10, text: 'A', final: true },
    { id: 'a-progress', role: 'assistant', seq: 15, order: 15, text: 'A working', final: false },
    { id: 'prompt-b', role: 'user', seq: 20, order: 20, text: 'B', final: true },
    { id: 'a-answer', role: 'assistant', seq: 24, order: 24, text: 'A actual answer', final: false, state: 'streaming' },
    { id: 'b-answer', role: 'assistant', seq: 34, order: 34, text: 'B answer', final: true, responseKey: 'response-b' }
  ];
  const responses = [
    { responseKey: 'response-a', startedSeq: 12, endedSeq: 25, outcome: 'completed' },
    { responseKey: 'response-b', startedSeq: 30, endedSeq: 35, outcome: 'completed' }
  ];

  const { bundles } = groupPromptTimeline({ messages, responses });
  assert.deepEqual(bundles[0].workRows.map((row) => row.message?.id), ['a-progress']);
  assert.deepEqual(bundles[0].finals.map((message) => message.id), ['a-answer']);
  assert.deepEqual(bundles[1].finals.map((message) => message.id), ['b-answer']);
  assert.equal(bundles[1].workRows.some((row) => row.message?.id === 'a-answer'), false);
});

test('stream word chunks preserve exact whitespace while revealing whole words', () => {
  const text = 'Hello  world\nnext line.';
  const chunks = streamWordChunks(text);
  assert.equal(chunks.join(''), text);
  assert.deepEqual(chunks.filter((chunk) => /\S/.test(chunk)).map((chunk) => chunk.trim()), ['Hello', 'world', 'next', 'line.']);
});

test('stream reveal rate catches up large or final backlogs without unbounded lag', () => {
  assert.ok(streamWordsPerSecond(80, false) > streamWordsPerSecond(8, false));
  assert.ok(streamWordsPerSecond(8, true) >= streamWordsPerSecond(8, false));
  assert.ok(streamWordsPerSecond(500, true) <= 78);
  assert.ok(streamWordsPerSecond(20, false) <= 30);
  assert.ok(streamWordsPerSecond(20, false) >= 23);
});

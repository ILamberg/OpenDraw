import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AnswerPushWatcher } from '../server/answer-push-watcher.js';
import { SessionStore } from '../server/session-store.js';

async function waitFor(check, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

test('answer push watcher ignores historical idle state and sends exactly once after active turn gets a new final answer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-answer-watch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = '2026-09-14-watch001';
  const dir = path.join(root, id);
  const messages = path.join(dir, 'messages');
  await fs.mkdir(messages, { recursive: true });
  const metaPath = path.join(dir, 'meta.json');
  await fs.writeFile(metaPath, JSON.stringify({
    id, title: 'Watch', conversationId: 'conversation-watch', startedAt: 1, updatedAt: 10,
    endedAt: null, activeTurnId: 'turn-current', lastTurnEndAt: 5, origin: { kind: 'desktop' }
  }), 'utf8');
  await fs.writeFile(path.join(messages, `${'a'.repeat(64)}.json`), JSON.stringify({
    kind: 'assistant_message', seq: 2, time: 4, turnId: 'turn-old', messageId: 'old-final',
    message: { text: 'Old answer' }, state: 'final', final: true
  }), 'utf8');
  const pushes = [];
  const watcher = await new AnswerPushWatcher({
    sessionStore: new SessionStore(root),
    pushService: { async broadcast(payload) { pushes.push(payload); return { sent: 1, failed: 0 }; } },
    heartbeatMs: 80
  }).start();
  t.after(() => watcher.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pushes.length, 0);

  await fs.writeFile(path.join(messages, `${'b'.repeat(64)}.json`), JSON.stringify({
    kind: 'assistant_message', seq: 9, time: 20, turnId: 'turn-current', messageId: 'new-final',
    message: { text: 'New answer' }, state: 'final', final: true
  }), 'utf8');
  await fs.writeFile(metaPath, JSON.stringify({
    id, title: 'Watch', conversationId: 'conversation-watch', startedAt: 1, updatedAt: 21,
    endedAt: null, activeTurnId: null, lastTurnEndAt: 21, origin: { kind: 'desktop' }
  }), 'utf8');
  await waitFor(() => pushes.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'OpenDraw · Answer ready');
  assert.equal(JSON.stringify(pushes[0]).includes('New answer'), false);
  assert.equal(JSON.stringify(pushes[0]).includes(id), false);
});

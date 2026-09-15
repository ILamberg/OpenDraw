import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CosStateStore } from '../server/cos-state-store.js';

test('COS state projection exposes useful phone metadata without secrets or prompt bodies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-cos-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  await fs.writeFile(path.join(root, 'state', 'chat-models.json'), JSON.stringify({
    observedAt: 123,
    models: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['none', 'high'], aliases: ['gpt-5-6-thinking'] }]
  }));
  await fs.writeFile(path.join(root, 'state', 'projects.json'), JSON.stringify([
    { id: 'project-1', name: 'OpenDraw', path: 'C:\\private\\project', createdAt: 50 }
  ]));
  await fs.writeFile(path.join(root, 'state', 'session-input.json'), JSON.stringify([
    { id: 'input-1', sessionId: 'session-1', state: 'sent', text: 'private message body', createdAt: 90, deliveredAt: 100 }
  ]));
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    readOnly: false,
    ui: { finishTool: true, autoConnect: true },
    sessions: { advisoryTokens: 1000, limitTokens: 2000, retainDays: 7 },
    compaction: { auto: true, autoTokens: 1200 },
    multiAgent: { enabled: true, maxWorkers: 3, defaultModel: '5.6', defaultReasoning: 'high' },
    goal: { enabled: true, backend: 'chatgpt', prompt: 'do not expose me', provider: { kind: 'custom', apiKey: 'secret' } },
    tunnel: { kind: 'cloud' }
  }));

  const snapshot = await new CosStateStore(root).snapshot({ sessionId: 'session-1' });
  assert.equal(snapshot.catalog.models[0].label, 'GPT-5.6 Sol');
  assert.equal(snapshot.projects[0].name, 'OpenDraw');
  assert.equal('path' in snapshot.projects[0], false);
  assert.equal(snapshot.outbox[0].state, 'sent');
  assert.equal('text' in snapshot.outbox[0], false);
  assert.equal(snapshot.settings.goal.backend, 'chatgpt');
  assert.equal('prompt' in snapshot.settings.goal, false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
});

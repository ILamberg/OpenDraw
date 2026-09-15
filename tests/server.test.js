import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createOpenDrawServer } from '../server/app.js';

const PNG_FIXTURE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

class MemoryCosBridge {
  constructor() {
    this.messages = new Map();
    this.inputs = [];
    this.controls = {
      activeTurnId: 'turn-live',
      automation: 'off',
      objective: '',
      canInject: true,
      canSendDirectly: true,
      queueAtFinish: false,
      blocked: false,
      job: null
    };
  }

  async getState() {
    return { connected: true, appVersion: 'test', provider: 'openai' };
  }

  async getModels() {
    return [{ id: 'gpt-5.6-sol', provider: 'openai' }];
  }

  async listProjects() {
    return [{
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Live project',
      path: 'C:\\must-not-leak',
      createdAt: 123,
      ungrouped: false
    }];
  }

  async listInputs() {
    return this.inputs;
  }

  async listSessions() {
    return { sessions: [], activeId: null };
  }

  async getSession(sessionId) {
    return { id: sessionId, live: true, provider: 'openai' };
  }

  async getSessionControls() {
    return { ...this.controls };
  }

  async getSwarm() {
    return {
      enabled: true,
      running: 1,
      retainedHistory: 4,
      agents: [
        {
          id: 'worker-2', role: 'worker', label: 'Streaming audit', state: 'active',
          primeConversationId: 'conversation-live-123', createdAt: 100, activatedAt: 110, lastSeenAt: 120,
          task: 'PRIVATE AGENT TASK C:\\secret.txt', result: 'PRIVATE AGENT RESULT', conversationId: 'PRIVATE CHILD CONVERSATION',
          runId: 'PRIVATE RUN', contextTokens: 99999, revivable: false
        },
        {
          id: 'worker-other', role: 'worker', label: 'Other chat', state: 'active',
          primeConversationId: 'other-conversation', task: 'PRIVATE OTHER TASK'
        }
      ]
    };
  }

  async getUsage() {
    return {
      days: 7,
      sessions: 3,
      limits: [{ model: 'gpt-5.6-sol', scope: 'model', remainingPercent: 73, remaining: 730, resetAt: 5000 }],
      tokens: [{ model: 'gpt-5.6-sol', tokens: 999999, prompt: 'must-not-leak' }]
    };
  }

  async setSessionAutomation(_sessionId, automation) {
    this.controls = { ...this.controls, automation };
    return { ...this.controls };
  }

  async setSessionObjective(_sessionId, objective, mode) {
    this.controls = { ...this.controls, objective, automation: objective ? mode : 'off' };
    return { ...this.controls };
  }

  async compactSession() {
    this.controls = { ...this.controls, job: { stage: 'preparing', busy: true, startedAt: 100, sourceSend: 'must-not-leak' } };
    return { ...this.controls };
  }

  async cancelSessionCompaction() {
    this.controls = { ...this.controls, job: null };
    return { ...this.controls };
  }

  async cancelInput(id) {
    const row = this.inputs.find((input) => input.id === id);
    if (!row) return false;
    row.state = 'cancelled';
    return true;
  }

  async sendInput(message) {
    const existing = this.messages.get(message.id);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(message)) {
        const error = new Error('Idempotency conflict');
        error.code = 'IDEMPOTENCY_CONFLICT';
        throw error;
      }
      return { id: message.id, status: 'sent', idempotent: true };
    }
    this.messages.set(message.id, { input: { ...message } });
    this.inputs.push({ ...message, state: 'sent', createdAt: Date.now(), deliveredSessionId: message.sessionId });
    return { id: message.id, status: 'sent', idempotent: false };
  }

  async stopSessionTurn(sessionId, expectedTurnId) {
    this.stopped = { sessionId, expectedTurnId };
    return { stopped: true };
  }
}

class MemoryCosStateStore {
  async projects() {
    return [
      { id: '11111111-1111-4111-8111-111111111111', name: 'OpenDraw', ungrouped: false },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Old project', ungrouped: true }
    ];
  }

  async snapshot() {
    return { catalog: null, projects: await this.projects(), settings: null, outbox: [] };
  }
}

class MemoryPushService {
  constructor() {
    this.subscriptions = new Map();
    this.sent = [];
  }
  publicKey() { return 'BTEST_PUBLIC_KEY'; }
  hasSubscription(deviceId) { return this.subscriptions.has(deviceId); }
  async setSubscription(deviceId, subscription) {
    this.subscriptions.set(deviceId, structuredClone(subscription));
    return true;
  }
  async removeSubscription(deviceId) { return this.subscriptions.delete(deviceId); }
  async sendToDevice(deviceId, payload) {
    if (!this.subscriptions.has(deviceId)) return { sent: 0, failed: 0, missing: true };
    this.sent.push({ deviceId, payload });
    return { sent: 1, failed: 0, missing: false };
  }
}

class MemoryScreenService {
  constructor() {
    this.subscriptions = 0;
    this.frameSubscriptions = 0;
    this.snapshots = [];
  }
  status() {
    return {
      available: true,
      capturing: false,
      viewers: 0,
      targetFps: 30,
      maxWidth: 1280,
      codec: 'mjpeg',
      latestAt: null,
      error: null,
      privatePath: 'C:\\must-not-leak\\desktop.jpg'
    };
  }
  async subscribe(_req, res) {
    this.subscriptions += 1;
    res.writeHead(200, {
      'content-type': 'application/x-opendraw-screen-stream',
      'cache-control': 'no-store'
    });
    res.end(Buffer.from([0, 0, 0, 0]));
  }
  async subscribeFrames(_req, res) {
    this.frameSubscriptions += 1;
    res.writeHead(200, {
      'content-type': 'application/x-opendraw-screen-frames',
      'cache-control': 'no-store'
    });
    res.end(Buffer.from([1, 2, 3, 4]));
  }
  async snapshotForPrompt(id) {
    const snapshot = { path: `C:\\private\\screen\\${id}.jpg`, capturedAt: 12345 };
    this.snapshots.push(snapshot);
    return snapshot;
  }
}

async function serverFixture(t, { cosBridge, cosStateStore, pushService, screenService, controlSecret, requestShutdown } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-api-'));
  const sessionsDir = path.join(root, 'sessions');
  const dataDir = path.join(root, 'data');
  const sessionId = '2026-09-13-abcd1234';
  const conversationId = 'conversation-live-123';
  const sessionDir = path.join(sessionsDir, sessionId);
  await fs.mkdir(path.join(sessionDir, 'messages'), { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'meta.json'), JSON.stringify({
    id: sessionId,
    title: 'Live fixture',
    conversationId,
    startedAt: 10,
    updatedAt: 20,
    endedAt: null,
    activeTurnId: 'turn-live',
    lastTurnOutcome: 'completed',
    estimatedTokens: 1234,
    contextTokens: 2345,
    selectedModel: { model: 'gpt-5.6-sol', reasoningEffort: 'high', observedAt: 19 },
    origin: { kind: 'desktop' }
  }), 'utf8');
  await fs.writeFile(path.join(sessionDir, 'messages', `${'a'.repeat(64)}.json`), JSON.stringify({
    kind: 'user_message', seq: 3, time: 10, messageId: 'user-fixture', message: { text: 'Hi' }
  }), 'utf8');

  const built = await createOpenDrawServer({
    sessionsDir,
    dataDir,
    exposeErrors: true,
    cosBridge,
    cosStateStore,
    pushService,
    screenService,
    controlSecret,
    requestShutdown
  });
  await new Promise((resolve, reject) => {
    built.server.once('error', reject);
    built.server.listen(0, '127.0.0.1', resolve);
  });
  const address = built.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => built.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { ...built, base, sessionId, conversationId, sessionDir };
}

async function pair(base, secret) {
  const response = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingSecret: secret, deviceName: 'Test phone' })
  });
  assert.equal(response.status, 201);
  return response.json();
}

async function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('health is public while COS status/session details require a device bearer', async (t) => {
  const fx = await serverFixture(t);
  const health = await fetch(`${fx.base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal('currentSessionId' in healthBody, false);
  assert.equal('normalSessions' in healthBody, false);
  assert.equal('bootId' in healthBody, false);

  assert.equal((await fetch(`${fx.base}/api/status`)).status, 401);
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}` };
  const status = await fetch(`${fx.base}/api/status`, { headers });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.cos.currentSession.id, fx.sessionId);
  assert.equal(body.cos.currentSession.selectedModel.model, 'gpt-5.6-sol');
  assert.equal(body.cos.currentSession.selectedModel.provider.id, 'openai');
  assert.equal(body.cos.live.configured, false);
  assert.equal(body.cos.live.send.available, false);
});

test('live screen status and stream require the paired device bearer and expose only safe metadata', async (t) => {
  const screenService = new MemoryScreenService();
  const fx = await serverFixture(t, { screenService });
  assert.equal((await fetch(`${fx.base}/api/screen/status`)).status, 401);
  assert.equal((await fetch(`${fx.base}/api/screen/stream`)).status, 401);
  assert.equal((await fetch(`${fx.base}/api/screen/frames`)).status, 401);

  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}` };
  const statusResponse = await fetch(`${fx.base}/api/screen/status`, { headers });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.available, true);
  assert.equal(status.targetFps, 30);
  assert.equal(status.maxWidth, 1280);
  assert.equal(status.codec, 'mjpeg');
  assert.equal(JSON.stringify(status).includes('must-not-leak'), false);
  assert.equal('privatePath' in status, false);

  const streamResponse = await fetch(`${fx.base}/api/screen/stream`, { headers });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get('content-type') || '', /application\/x-opendraw-screen-stream/);
  await streamResponse.arrayBuffer();
  assert.equal(screenService.subscriptions, 1);

  const frameResponse = await fetch(`${fx.base}/api/screen/frames`, { headers });
  assert.equal(frameResponse.status, 200);
  assert.match(frameResponse.headers.get('content-type') || '', /application\/x-opendraw-screen-frames/);
  await frameResponse.arrayBuffer();
  assert.equal(screenService.frameSubscriptions, 1);
});

test('screen prompt snapshots the current desktop privately and sends only through the exact COS session', async (t) => {
  const bridge = new MemoryCosBridge();
  const screenService = new MemoryScreenService();
  const fx = await serverFixture(t, { cosBridge: bridge, screenService });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const id = '12345678-1234-4234-9234-1234567890ab';
  const text = 'Tell me what is open on my screen and what I should do next.';
  const response = await fetch(`${fx.base}/api/screen/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id,
      sessionId: fx.sessionId,
      conversationId: fx.conversationId,
      text,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    })
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.screenAttached, true);
  assert.equal(JSON.stringify(body).includes('C:\\private'), false);
  assert.equal(screenService.snapshots.length, 1);
  assert.equal(screenService.snapshots[0].path.endsWith(`${id}.jpg`), true);

  const sent = bridge.messages.get(id).input;
  assert.equal(sent.sessionId, fx.sessionId);
  assert.equal(sent.mode, 'auto');
  assert.equal(sent.model, 'gpt-5.6-sol');
  assert.equal(sent.reasoningEffort, 'high');
  assert.match(sent.text, /^\[\[OPENDRAW_SCREEN_CONTEXT:\d+\]\]/);
  assert.match(sent.text, /delete that exact screenshot file from disk before answering/);
  assert.match(sent.text, /C:\\private\\screen\\12345678-1234-4234-9234-1234567890ab\.jpg/);
  assert.match(sent.text, /successfully inspected the image and extracted the information you need/);
  assert.match(sent.text, /delete that exact screenshot file from disk before answering/);
  assert.match(sent.text, /If inspection fails, leave the file in place so the same request can retry safely/);
  assert.equal(sent.text.endsWith(`\n\n${text}`), true);

  const wrongTarget = await fetch(`${fx.base}/api/screen/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: '22345678-1234-4234-9234-1234567890ab',
      sessionId: fx.sessionId,
      conversationId: 'different-conversation',
      text: 'Do not send this.'
    })
  });
  assert.equal(wrongTarget.status, 409);
});

test('normal session send can attach the current screen without exposing its private path', async (t) => {
  const bridge = new MemoryCosBridge();
  const screenService = new MemoryScreenService();
  const fx = await serverFixture(t, { cosBridge: bridge, screenService });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const id = '32345678-1234-4234-9234-1234567890ab';
  const text = 'Use my current screen and answer normally.';
  const response = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id,
      conversationId: fx.conversationId,
      text,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      mode: 'auto',
      screen: true
    })
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.screenAttached, true);
  assert.equal(JSON.stringify(body).includes('C:\\private'), false);
  assert.equal(screenService.snapshots.length, 1);

  const sent = bridge.messages.get(id).input;
  assert.equal(sent.sessionId, fx.sessionId);
  assert.equal(sent.conversationId, fx.conversationId);
  assert.equal(sent.mode, 'auto');
  assert.equal(sent.model, 'gpt-5.6-sol');
  assert.equal(sent.reasoningEffort, 'high');
  assert.match(sent.text, /^\[\[OPENDRAW_SCREEN_CONTEXT:\d+\]\]/);
  assert.match(sent.text, /delete that exact screenshot file from disk before answering/);
  assert.equal(sent.text.endsWith(`\n\n${text}`), true);

  const wrongTarget = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: '42345678-1234-4234-9234-1234567890ab',
      conversationId: 'different-conversation',
      text: 'Do not capture or send this.',
      screen: true
    })
  });
  assert.equal(wrongTarget.status, 409);
  assert.equal(screenService.snapshots.length, 1);
});

test('internal restart endpoint requires the private control secret and schedules exactly one shutdown', async (t) => {
  const controlSecret = 'restart-secret-fixture';
  let shutdownCalls = 0;
  let resolveShutdown;
  const shutdownScheduled = new Promise((resolve) => { resolveShutdown = resolve; });
  const fx = await serverFixture(t, {
    controlSecret,
    requestShutdown: () => {
      shutdownCalls += 1;
      resolveShutdown();
    }
  });

  const missing = await fetch(`${fx.base}/api/internal/restart`, { method: 'POST' });
  assert.equal(missing.status, 404);
  assert.equal(shutdownCalls, 0);

  const wrong = await fetch(`${fx.base}/api/internal/restart`, {
    method: 'POST',
    headers: { 'x-opendraw-control': 'wrong-secret' }
  });
  assert.equal(wrong.status, 404);
  assert.equal(shutdownCalls, 0);

  const accepted = await fetch(`${fx.base}/api/internal/restart`, {
    method: 'POST',
    headers: { 'x-opendraw-control': controlSecret }
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true });
  await shutdownScheduled;
  assert.equal(shutdownCalls, 1);
});

test('phone Web Push subscription is bearer-bound and test push exposes no private payload', async (t) => {
  const pushService = new MemoryPushService();
  const fx = await serverFixture(t, { pushService });
  assert.equal((await fetch(`${fx.base}/api/push/status`)).status, 401);
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };

  const status = await (await fetch(`${fx.base}/api/push/status`, { headers })).json();
  assert.equal(status.available, true);
  assert.equal(status.publicKey, 'BTEST_PUBLIC_KEY');
  assert.equal(status.subscribed, false);

  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test',
    expirationTime: null,
    keys: { p256dh: 'public-key', auth: 'auth-key' }
  };
  const subscribe = await fetch(`${fx.base}/api/push/subscription`, {
    method: 'PUT', headers, body: JSON.stringify({ subscription })
  });
  assert.equal(subscribe.status, 200);
  const subscribedStatus = await (await fetch(`${fx.base}/api/push/status`, { headers })).json();
  assert.equal(subscribedStatus.subscribed, true);

  const testPush = await fetch(`${fx.base}/api/push/test`, { method: 'POST', headers });
  assert.equal(testPush.status, 200);
  assert.equal(pushService.sent.length, 1);
  assert.deepEqual(pushService.sent[0].payload, {
    type: 'answer-ready',
    title: 'OpenDraw · Answer ready',
    body: 'Chat On Steroids finished its response.',
    tag: 'opendraw-answer-ready',
    url: '/'
  });
  assert.equal(JSON.stringify(pushService.sent).includes('conversation-live-123'), false);

  const remove = await fetch(`${fx.base}/api/push/subscription`, { method: 'DELETE', headers });
  assert.equal(remove.status, 200);
  assert.equal((await (await fetch(`${fx.base}/api/push/status`, { headers })).json()).subscribed, false);
});

test('private phone shell is served no-store so HTML and handlers cannot drift for an hour', async (t) => {
  const fx = await serverFixture(t);
  for (const resource of ['/', '/app.js?v=10', '/app.css?v=10']) {
    const response = await fetch(`${fx.base}${resource}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.arrayBuffer();
  }
});

test('default phone-only server reports direct send unavailable without creating a relay queue', async (t) => {
  const fx = await serverFixture(t);
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const response = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: '4a0ef171-d017-4be6-a3f7-81034bd9c3b3',
      conversationId: fx.conversationId,
      text: 'Hello'
    })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'send_unavailable');
});

test('injected direct transport receives exact target and UUID while target mismatch is rejected first', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const id = 'dddcfc5c-f920-4aed-bd74-903bb938dc9a';

  const wrong = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({ id, conversationId: 'wrong-conversation', text: 'Hello' })
  });
  assert.equal(wrong.status, 409);
  assert.equal(bridge.messages.size, 0);

  const first = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({
      id, conversationId: fx.conversationId, text: 'Hello', model: '5.6', reasoningEffort: 'high'
    })
  });
  assert.equal(first.status, 202);
  const accepted = await first.json();
  assert.equal(accepted.result.status, 'sent');
  assert.deepEqual(bridge.messages.get(id).input, {
    id, sessionId: fx.sessionId, conversationId: fx.conversationId, text: 'Hello', mode: 'auto',
    model: '5.6', reasoningEffort: 'high'
  });

  const repeat = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({
      id, conversationId: fx.conversationId, text: 'Hello', model: '5.6', reasoningEffort: 'high'
    })
  });
  assert.equal(repeat.status, 202);
  assert.equal((await repeat.json()).result.idempotent, true);

  const whitespaceId = '77777777-7777-4777-8777-777777777777';
  const whitespaceText = '\n  Keep my formatting exactly.  \n';
  const whitespace = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({
      id: whitespaceId,
      conversationId: fx.conversationId,
      text: whitespaceText,
      model: '5.6',
      reasoningEffort: 'high'
    })
  });
  assert.equal(whitespace.status, 202);
  assert.equal(bridge.messages.get(whitespaceId).input.text, whitespaceText);

  const afterTurnId = '88888888-8888-4888-8888-888888888888';
  const afterTurn = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({
      id: afterTurnId,
      conversationId: fx.conversationId,
      text: 'Follow up later',
      mode: 'after-turn',
      model: '5.6',
      reasoningEffort: 'high'
    })
  });
  assert.equal(afterTurn.status, 202);
  assert.equal(bridge.messages.get(afterTurnId).input.mode, 'after-turn');

  const invalidMode = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages`, {
    method: 'POST', headers, body: JSON.stringify({
      id: '99999999-9999-4999-8999-999999999999',
      conversationId: fx.conversationId,
      text: 'Do not expose finish mode',
      mode: 'finish'
    })
  });
  assert.equal(invalidMode.status, 400);
});

test('authenticated status and models endpoints surface live COS adapter information', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}` };

  const status = await (await fetch(`${fx.base}/api/status`, { headers })).json();
  assert.equal(status.cos.live.configured, true);
  assert.equal(status.cos.live.send.available, true);
  assert.equal(status.cos.live.state.provider, 'openai');
  assert.equal(status.cos.live.models[0].id, 'gpt-5.6-sol');
  assert.equal(status.cos.live.currentSession.id, fx.sessionId);

  const models = await (await fetch(`${fx.base}/api/models`, { headers })).json();
  assert.equal(models.liveAvailable, true);
  assert.equal(models.live[0].provider, 'openai');
  assert.equal(models.observed[0].id, 'gpt-5.6-sol');
});

test('message long-poll stays bearer protected and returns the next durable streaming update', async (t) => {
  const fx = await serverFixture(t, { cosBridge: new MemoryCosBridge() });
  const unauthorized = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages?afterSeq=3&waitMs=100`);
  assert.equal(unauthorized.status, 401);

  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}` };
  const pending = fetch(`${fx.base}/api/sessions/${fx.sessionId}/messages?afterSeq=3&waitMs=2000`, { headers });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await fs.writeFile(path.join(fx.sessionDir, 'messages', `${'b'.repeat(64)}.json`), JSON.stringify({
    kind: 'assistant_message', seq: 6, time: 60, messageId: 'assistant-stream',
    message: { text: 'Durable partial answer' }, state: 'streaming', final: false
  }), 'utf8');
  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.waited, true);
  assert.equal(body.messages[0].id, 'assistant-stream');
  assert.equal(body.messages[0].text, 'Durable partial answer');
  assert.equal(body.messages[0].final, false);
  assert.equal(body.nextSeq, 6);
});

test('live status projects COS inputs and sessions without leaking prompt bodies', async (t) => {
  const bridge = new MemoryCosBridge();
  bridge.getState = async () => ({
    connected: true,
    provider: 'openai',
    config: {
      readOnly: false,
      roots: [{ path: 'C:\\PRIVATE\\workspace' }],
      goal: { objectivePrompt: 'SECRET SYSTEM PROMPT' }
    }
  });
  bridge.inputs.push({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sessionId: '2026-09-13-abcd1234',
    state: 'queued',
    mode: 'auto',
    text: 'TOP SECRET PROMPT BODY',
    stages: ['SECRET STAGE'],
    attachments: [{ name: 'private.txt', preview: 'SECRET FILE' }],
    createdAt: 100
  });
  bridge.listSessions = async () => ({
    activeId: '2026-09-13-abcd1234',
    sessions: [{
      id: '2026-09-13-abcd1234', title: 'Safe title', conversationId: 'conversation-live-123',
      projectId: '11111111-1111-4111-8111-111111111111', activeTurnId: 'turn-live', updatedAt: 20,
      prompt: 'SESSION SECRET'
    }]
  });
  const fx = await serverFixture(t, { cosBridge: bridge });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const response = await fetch(`${fx.base}/api/status`, { headers: { authorization: `Bearer ${paired.token}` } });
  const body = await response.json();
  assert.equal(body.cos.live.inputs[0].id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(body.cos.live.sessions.sessions[0].title, 'Safe title');
  const serialized = JSON.stringify(body.cos.live);
  assert.equal(serialized.includes('TOP SECRET PROMPT BODY'), false);
  assert.equal(serialized.includes('SECRET STAGE'), false);
  assert.equal(serialized.includes('SECRET FILE'), false);
  assert.equal(serialized.includes('SESSION SECRET'), false);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('SECRET SYSTEM PROMPT'), false);
});

test('phone controls, usage, automation and compaction expose only projected COS state', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };

  const controlsResponse = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/controls`, { headers });
  assert.equal(controlsResponse.status, 200);
  assert.equal((await controlsResponse.json()).controls.automation, 'off');

  await fs.writeFile(path.join(fx.sessionDir, 'plan.json'), JSON.stringify({
    updatedAt: 50,
    explanation: 'PRIVATE PLAN EXPLANATION',
    plan: [{ step: 'Build the mobile task bar', status: 'in_progress', details: 'PRIVATE PLAN DETAIL' }]
  }), 'utf8');
  await fs.writeFile(path.join(fx.sessionDir, 'events.jsonl'), JSON.stringify({
    kind: 'tool_call', seq: 9, time: 90,
    call: {
      tool: 'read', args: { path: 'C:\\PRIVATE\\secret.txt' }, result: 'PRIVATE TOOL RESULT', durationMs: 22,
      outcome: 'ok', summary: { kind: 'read', tone: 'good', title: 'Read a file', detail: 'C:\\PRIVATE\\secret.txt', metric: '✓ 22ms' },
      assets: [{ id: 'private-proof.png', mimeType: 'image/png', bytes: PNG_FIXTURE.length }]
    }
  }) + '\n', 'utf8');
  await fs.mkdir(path.join(fx.sessionDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(fx.sessionDir, 'assets', 'private-proof.png'), PNG_FIXTURE);
  const activityResponse = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/activity`, { headers });
  const activityBody = await activityResponse.json();
  assert.equal(activityResponse.status, 200);
  assert.equal(activityBody.plan.steps[0].step, 'Build the mobile task bar');
  assert.equal(activityBody.tools[0].title, 'File activity');
  assert.equal(activityBody.visuals.length, 1);
  assert.match(activityBody.visuals[0].id, /^visual-[0-9a-f]{24}$/);
  assert.equal(activityBody.visuals[0].label, 'Visual proof');
  assert.deepEqual(activityBody.agents, [{
    id: 'worker-2', label: 'Streaming audit', status: 'working', revivable: false,
    startedAt: 110, finishedAt: null
  }]);
  assert.equal(activityBody.controls.activeTurnId, 'turn-live');
  const activitySerialized = JSON.stringify(activityBody);
  assert.equal(activitySerialized.includes('PRIVATE PLAN EXPLANATION'), false);
  assert.equal(activitySerialized.includes('PRIVATE PLAN DETAIL'), false);
  assert.equal(activitySerialized.includes('PRIVATE TOOL RESULT'), false);
  assert.equal(activitySerialized.includes('Read a file'), false);
  assert.equal(activitySerialized.includes('C:\\\\PRIVATE'), false);
  assert.equal(activitySerialized.includes('private-proof.png'), false);
  assert.equal(activitySerialized.includes('PRIVATE AGENT TASK'), false);
  assert.equal(activitySerialized.includes('PRIVATE AGENT RESULT'), false);
  assert.equal(activitySerialized.includes('PRIVATE CHILD CONVERSATION'), false);
  assert.equal(activitySerialized.includes('PRIVATE RUN'), false);
  assert.equal(activitySerialized.includes('contextTokens'), false);

  const visualId = activityBody.visuals[0].id;
  assert.equal((await fetch(`${fx.base}/api/sessions/${fx.sessionId}/visuals/${visualId}`)).status, 401);
  const visualResponse = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/visuals/${visualId}`, { headers });
  assert.equal(visualResponse.status, 200);
  assert.equal(visualResponse.headers.get('content-type'), 'image/png');
  assert.equal(visualResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await visualResponse.arrayBuffer()), PNG_FIXTURE);
  assert.equal((await fetch(`${fx.base}/api/sessions/${fx.sessionId}/visuals/visual-000000000000000000000000`, { headers })).status, 404);

  const foreignId = '2026-09-13-foreign1';
  const foreignDir = path.join(path.dirname(fx.sessionDir), foreignId);
  await fs.mkdir(path.join(foreignDir, 'messages'), { recursive: true });
  await fs.mkdir(path.join(foreignDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(foreignDir, 'meta.json'), JSON.stringify({
    id: foreignId, title: 'Foreign', conversationId: 'conversation-foreign', startedAt: 1, updatedAt: 2, endedAt: null, origin: { kind: 'desktop' }
  }), 'utf8');
  await fs.writeFile(path.join(foreignDir, 'events.jsonl'), JSON.stringify({
    kind: 'tool_call', seq: 9, time: 90,
    call: { tool: 'view_image', outcome: 'ok', assets: [{ id: 'private-proof.png', mimeType: 'image/png', bytes: PNG_FIXTURE.length }] }
  }) + '\n', 'utf8');
  await fs.writeFile(path.join(foreignDir, 'assets', 'private-proof.png'), PNG_FIXTURE);
  assert.equal((await fetch(`${fx.base}/api/sessions/${foreignId}/visuals/${visualId}`, { headers })).status, 404);

  const automationResponse = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/automation`, {
    method: 'POST', headers, body: JSON.stringify({ automation: 'goal', objective: 'Ship the phone UX' })
  });
  const automationBody = await automationResponse.json();
  assert.equal(automationResponse.status, 200);
  assert.equal(automationBody.controls.automation, 'goal');
  assert.equal(automationBody.controls.objective, 'Ship the phone UX');

  const compactResponse = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/compact`, { method: 'POST', headers });
  const compactBody = await compactResponse.json();
  assert.equal(compactResponse.status, 200);
  assert.equal(compactBody.controls.job.stage, 'preparing');
  assert.equal(JSON.stringify(compactBody).includes('must-not-leak'), false);

  const usageResponse = await fetch(`${fx.base}/api/usage`, { headers });
  const usageBody = await usageResponse.json();
  assert.equal(usageBody.available, true);
  assert.equal(usageBody.limits[0].remainingPercent, 73);
  assert.equal(JSON.stringify(usageBody).includes('must-not-leak'), false);
});

test('durable-only activity exposes safe response lifecycle without waiting for live COS controls', async (t) => {
  const bridge = new MemoryCosBridge();
  let controlCalls = 0;
  let swarmCalls = 0;
  bridge.getSessionControls = async () => { controlCalls += 1; throw new Error('must not run'); };
  bridge.getSwarm = async () => { swarmCalls += 1; throw new Error('must not run'); };
  const fx = await serverFixture(t, { cosBridge: bridge });
  const privateTurnId = 'turn-live';
  await fs.writeFile(path.join(fx.sessionDir, 'events.jsonl'), [
    JSON.stringify({ kind: 'turn_start', seq: 4, time: 40, turnId: privateTurnId }),
    JSON.stringify({ kind: 'tool_call', seq: 5, time: 50, turnId: privateTurnId, call: { tool: 'read', outcome: 'ok', durationMs: 3 } }),
    JSON.stringify({ kind: 'turn_end', seq: 6, time: 60, turnId: privateTurnId, outcome: 'completed' })
  ].join('\n') + '\n', 'utf8');
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const response = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/activity?durableOnly=1`, {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(controlCalls, 0);
  assert.equal(swarmCalls, 0);
  assert.equal(body.controlsAvailable, false);
  assert.equal(body.controls, null);
  assert.equal(body.responses.length, 1);
  assert.match(body.responses[0].responseKey, /^response-[0-9a-f]{20}$/);
  assert.deepEqual(
    { startedSeq: body.responses[0].startedSeq, endedSeq: body.responses[0].endedSeq, outcome: body.responses[0].outcome },
    { startedSeq: 4, endedSeq: 6, outcome: 'completed' }
  );
  assert.equal(JSON.stringify(body).includes(privateTurnId), false);
  assert.ok(Number.isInteger(body.revision) && body.revision > 0);
});

test('large JSON API responses negotiate Brotli or gzip and preserve exact projected body', async (t) => {
  const fx = await serverFixture(t);
  const events = Array.from({ length: 220 }, (_, index) => JSON.stringify({
    kind: 'tool_call',
    seq: 10 + index,
    time: 1000 + index,
    call: { tool: index % 2 ? 'read' : 'web_search', outcome: 'ok', durationMs: index + 1 }
  })).join('\n') + '\n';
  await fs.writeFile(path.join(fx.sessionDir, 'events.jsonl'), events, 'utf8');
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const authorization = `Bearer ${paired.token}`;
  const url = `${fx.base}/api/sessions/${fx.sessionId}/activity?durableOnly=1`;

  const identity = await rawGet(url, { authorization, 'accept-encoding': 'identity' });
  assert.equal(identity.status, 200);
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.match(String(identity.headers.vary || ''), /Accept-Encoding/i);
  const expected = JSON.parse(identity.body.toString('utf8'));

  const br = await rawGet(url, { authorization, 'accept-encoding': 'br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.match(String(br.headers.vary || ''), /Accept-Encoding/i);
  assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString('utf8')), expected);

  const gzip = await rawGet(url, { authorization, 'accept-encoding': 'gzip' });
  assert.equal(gzip.status, 200);
  assert.equal(gzip.headers['content-encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(gzip.body).toString('utf8')), expected);
});

test('queue endpoint is exact-session scoped and cancel requires ownership', async (t) => {
  const bridge = new MemoryCosBridge();
  const ownedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  bridge.inputs.push(
    { id: ownedId, sessionId: '2026-09-13-abcd1234', state: 'queued', mode: 'finish', text: 'Owned follow-up', createdAt: 10 },
    { id: otherId, sessionId: '2026-09-13-other999', state: 'queued', mode: 'finish', text: 'Other private follow-up', createdAt: 20 }
  );
  const fx = await serverFixture(t, { cosBridge: bridge });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };

  const queue = await (await fetch(`${fx.base}/api/sessions/${fx.sessionId}/queue`, { headers })).json();
  assert.deepEqual(queue.queue.map((row) => row.id), [ownedId]);
  assert.equal(JSON.stringify(queue).includes('Other private follow-up'), false);

  const foreignCancel = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/queue/${otherId}`, { method: 'DELETE', headers });
  assert.equal(foreignCancel.status, 404);
  const ownedCancel = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/queue/${ownedId}`, { method: 'DELETE', headers });
  assert.equal(ownedCancel.status, 200);
  assert.equal(bridge.inputs.find((row) => row.id === ownedId).state, 'cancelled');
});

test('COS info prefers live project names but never exposes project filesystem paths', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge, cosStateStore: new MemoryCosStateStore() });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const response = await fetch(`${fx.base}/api/cos-info`, {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.projects[0].name, 'Live project');
  assert.equal('path' in body.projects[0], false);
  assert.equal(JSON.stringify(body).includes('must-not-leak'), false);
});

test('new chat sends through COS with a null session target and an approved project', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge, cosStateStore: new MemoryCosStateStore() });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const id = '9a6b07aa-3726-43ce-bd1d-0dd244305299';
  const projectId = '11111111-1111-4111-8111-111111111111';
  const response = await fetch(`${fx.base}/api/chats`, {
    method: 'POST', headers, body: JSON.stringify({
      id, text: 'Start a fresh chat', projectId, model: '5.6', reasoningEffort: 'ultra'
    })
  });
  assert.equal(response.status, 202);
  assert.deepEqual(bridge.messages.get(id).input, {
    id, sessionId: null, projectId, text: 'Start a fresh chat', mode: 'auto', model: '5.6', reasoningEffort: 'ultra'
  });

  const formattedId = '88888888-8888-4888-8888-888888888888';
  const formattedText = '\n  Start with intentional spacing.  \n';
  const formatted = await fetch(`${fx.base}/api/chats`, {
    method: 'POST', headers, body: JSON.stringify({
      id: formattedId,
      text: formattedText,
      projectId,
      model: '5.6',
      reasoningEffort: 'ultra'
    })
  });
  assert.equal(formatted.status, 202);
  assert.equal(bridge.messages.get(formattedId).input.text, formattedText);
});

test('new chat can attach the current screen through the normal create-chat path', async (t) => {
  const bridge = new MemoryCosBridge();
  const screenService = new MemoryScreenService();
  const fx = await serverFixture(t, { cosBridge: bridge, cosStateStore: new MemoryCosStateStore(), screenService });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const id = '5a6b07aa-3726-43ce-bd1d-0dd244305299';
  const projectId = '11111111-1111-4111-8111-111111111111';
  const text = 'Start a new chat using what is on my screen.';
  const response = await fetch(`${fx.base}/api/chats`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, text, projectId, model: '5.6', reasoningEffort: 'high', screen: true })
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.screenAttached, true);
  assert.equal(JSON.stringify(body).includes('C:\\private'), false);
  assert.equal(screenService.snapshots.length, 1);

  const sent = bridge.messages.get(id).input;
  assert.equal(sent.sessionId, null);
  assert.equal(sent.projectId, projectId);
  assert.equal(sent.mode, 'auto');
  assert.equal(sent.model, '5.6');
  assert.equal(sent.reasoningEffort, 'high');
  assert.match(sent.text, /^\[\[OPENDRAW_SCREEN_CONTEXT:\d+\]\]/);
  assert.equal(sent.text.endsWith(`\n\n${text}`), true);
});

test('new chat trusts the current live COS project catalog before a lagging durable project file', async (t) => {
  const bridge = new MemoryCosBridge();
  const liveOnlyProject = '33333333-3333-4333-8333-333333333333';
  bridge.listProjects = async () => [{ id: liveOnlyProject, name: 'Just added', ungrouped: false }];
  const fx = await serverFixture(t, { cosBridge: bridge, cosStateStore: new MemoryCosStateStore() });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const id = '44444444-4444-4444-8444-444444444444';
  const response = await fetch(`${fx.base}/api/chats`, {
    method: 'POST', headers, body: JSON.stringify({ id, text: 'Use the live project', projectId: liveOnlyProject })
  });
  assert.equal(response.status, 202);
  assert.equal(bridge.messages.get(id).input.projectId, liveOnlyProject);
});

test('new chat rejects unknown or removed projects before reaching COS', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge, cosStateStore: new MemoryCosStateStore() });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const response = await fetch(`${fx.base}/api/chats`, {
    method: 'POST', headers, body: JSON.stringify({
      id: '15e73f54-2b90-4018-90e0-b6861db96c47', text: 'Do not send', projectId: '22222222-2222-4222-8222-222222222222'
    })
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'project_not_found');
  assert.equal(bridge.messages.size, 0);
});

test('stop response is guarded by the exact current durable turn id', async (t) => {
  const bridge = new MemoryCosBridge();
  const fx = await serverFixture(t, { cosBridge: bridge });
  const paired = await pair(fx.base, fx.dataStore.pairingSecret());
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };

  const stale = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/stop`, {
    method: 'POST', headers, body: JSON.stringify({ expectedTurnId: 'wrong-turn' })
  });
  assert.equal(stale.status, 409);
  assert.equal(bridge.stopped, undefined);

  const current = await fetch(`${fx.base}/api/sessions/${fx.sessionId}/stop`, {
    method: 'POST', headers, body: JSON.stringify({ expectedTurnId: 'turn-live' })
  });
  assert.equal(current.status, 200);
  assert.deepEqual(bridge.stopped, { sessionId: fx.sessionId, expectedTurnId: 'turn-live' });
});

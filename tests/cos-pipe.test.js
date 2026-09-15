import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { CosPipeBridge } from '../server/cos-pipe.js';

const NO_RESPONSE = Symbol('no-response');

function parseApiInvocation(expression) {
  const match = expression.match(/api\[("(?:\\.|[^"])*")\]\(\.\.\.(\[.*\])\); \}\)\(\)$/s);
  if (!match) return null;
  return { method: JSON.parse(match[1]), args: JSON.parse(match[2]) };
}

class FakeCosProcess extends EventEmitter {
  constructor(onPacket) {
    super();
    this.exitCode = null;
    this.readPipe = new PassThrough();
    let buffered = '';
    this.writePipe = new Writable({
      write: (chunk, _encoding, callback) => {
        buffered += chunk.toString('utf8');
        const packets = buffered.split('\0');
        buffered = packets.pop();
        for (const raw of packets) {
          if (!raw) continue;
          const packet = JSON.parse(raw);
          Promise.resolve(onPacket(packet)).then((result) => {
            if (result === NO_RESPONSE) return;
            const response = result?.error
              ? { id: packet.id, error: result.error }
              : { id: packet.id, result: result ?? {} };
            this.readPipe.write(`${JSON.stringify(response)}\0`);
          });
        }
        callback();
      }
    });
    this.stdio = [null, null, null, this.writePipe, this.readPipe];
  }

  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  event(method, params) {
    this.readPipe.write(`${JSON.stringify({ method, params })}\0`);
  }
}

function createFakeChild(state) {
  let child;
  child = new FakeCosProcess((packet) => {
    state.calls.push(packet.method);
    if (packet.method === 'Browser.close') {
      queueMicrotask(() => child.exit(0));
      return {};
    }
    if (packet.method === 'Target.getTargets') {
      return { targetInfos: [{ targetId: state.rendererTargetId, type: 'page', title: 'Chat On Steroids' }] };
    }
    if (packet.method === 'Target.attachToTarget') {
      state.attachCount += 1;
      return { sessionId: state.rendererSessionId };
    }
    if (packet.method === 'Target.detachFromTarget') return {};
    if (packet.method !== 'Runtime.evaluate') return { error: { message: `Unexpected ${packet.method}` } };
    if (packet.sessionId && packet.sessionId !== state.rendererSessionId) {
      return { error: { message: 'No session with given id' } };
    }

    const expression = packet.params?.expression ?? '';
    if (expression.startsWith('Boolean(globalThis.api')) {
      return { result: { type: 'boolean', value: state.probeReady } };
    }

    const invocation = parseApiInvocation(expression);
    if (!invocation) return { error: { message: 'Unrecognized Runtime.evaluate expression' } };
    const [arg] = invocation.args;
    if (invocation.method === 'getChatModels') {
      return { result: { type: 'object', value: [{ id: '5.6', label: 'GPT-5.6 Sol', efforts: ['none', 'high'] }] } };
    }
    if (invocation.method === 'getUsage') {
      return { result: { type: 'object', value: { limits: [{ model: '5.6', remainingPercent: 80 }] } } };
    }
    if (invocation.method === 'getSessionControls') {
      return { result: { type: 'object', value: { sessionId: arg, automation: state.automation ?? 'off', objective: state.objective ?? '' } } };
    }
    if (invocation.method === 'getSwarm') {
      return { result: { type: 'object', value: { enabled: true, running: 1, agents: [{ id: 'worker-2', role: 'worker', state: 'active' }] } } };
    }
    if (invocation.method === 'setSessionAutomation') {
      state.automation = invocation.args[1];
      return { result: { type: 'object', value: { sessionId: invocation.args[0], automation: state.automation, objective: state.objective ?? '' } } };
    }
    if (invocation.method === 'setSessionObjective') {
      state.objective = invocation.args[1];
      state.automation = state.objective ? invocation.args[2] : 'off';
      return { result: { type: 'object', value: { sessionId: invocation.args[0], automation: state.automation, objective: state.objective } } };
    }
    if (invocation.method === 'compactSession') {
      state.compacting = true;
      return { result: { type: 'object', value: { sessionId: arg, job: { stage: 'preparing', busy: true } } } };
    }
    if (invocation.method === 'cancelSessionCompaction') {
      state.compacting = false;
      return { result: { type: 'object', value: { sessionId: arg, job: null } } };
    }
    if (invocation.method === 'cancelInput') {
      const row = state.inputs.find((item) => item.id === arg);
      if (row) row.state = 'cancelled';
      return { result: { type: 'boolean', value: Boolean(row) } };
    }
    if (invocation.method === 'listInputs') {
      if (state.listInputsErrorOnce) {
        state.listInputsErrorOnce = false;
        return { error: { message: 'temporary listInputs failure' } };
      }
      return { result: { type: 'object', value: structuredClone(state.inputs) } };
    }
    if (invocation.method === 'sendInput') {
      state.sendCount += 1;
      const existing = state.inputs.find((row) => row.id === arg.id);
      if (existing) {
        return { result: { type: 'object', value: structuredClone(existing) } };
      }
      const row = { ...arg, requestedMode: arg.mode, state: 'queued', conversationId: 'conversation-1' };
      state.inputs.push(row);
      if (state.hangNextSend) {
        state.hangNextSend = false;
        return NO_RESPONSE;
      }
      return { result: { type: 'object', value: structuredClone(row) } };
    }
    if (invocation.method === 'stopSessionTurn') {
      return { result: { type: 'object', value: { stopped: true, sessionId: invocation.args[0], turnId: invocation.args[1] } } };
    }
    return { error: { message: `Unexpected API method ${invocation.method}` } };
  });
  return child;
}

function fakeCos(options = {}) {
  const state = {
    inputs: [],
    hangNextSend: false,
    listInputsErrorOnce: false,
    probeReady: true,
    rendererSessionId: 'renderer-1',
    rendererTargetId: 'page-1',
    attachCount: 0,
    sendCount: 0,
    calls: [],
    ...(options.state || {})
  };
  const child = createFakeChild(state);
  let spawnCount = 0;

  const bridge = new CosPipeBridge({
    exePath: 'C:\\Fake\\Chat On Steroids.exe',
    spawnImpl: () => { spawnCount += 1; return child; },
    readTimeoutMs: 100,
    sendTimeoutMs: 25,
    startTimeoutMs: options.startTimeoutMs ?? 500,
    retryBackoffMs: options.retryBackoffMs ?? 50,
    sleepImpl: options.sleepImpl,
    ledgerPath: options.ledgerPath ?? null
  });
  return { bridge, child, state, get spawnCount() { return spawnCount; } };
}

test('private COS pipe discovers renderer and invokes live model API over NUL-framed CDP', async () => {
  const { bridge, state } = fakeCos();
  const models = await bridge.getModels();
  assert.equal(models[0].id, '5.6');
  assert.equal(bridge.status().available, true);
  assert.deepEqual(state.calls.slice(0, 3), ['Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate']);
});

test('private COS pipe preserves UUID idempotency and rejects conflicting reuse', async () => {
  const { bridge } = fakeCos();
  const input = {
    id: '9ce186fd-d7bd-487f-9298-742199227083',
    sessionId: 'session-1',
    projectId: null,
    conversationId: 'conversation-1',
    text: 'hello',
    mode: 'auto',
    model: '5.6',
    reasoningEffort: 'high'
  };

  const first = await bridge.sendInput(input);
  assert.equal(first.idempotent, false);
  assert.equal(first.status, 'queued');

  const repeat = await bridge.sendInput(input);
  assert.equal(repeat.idempotent, true);

  await assert.rejects(
    () => bridge.sendInput({ ...input, text: 'different text' }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT'
  );
});

test('private COS pipe forwards projectId for a new chat and projects eventual delivery session ids', async () => {
  const { bridge, state } = fakeCos();
  const projectId = '11111111-1111-4111-8111-111111111111';
  const input = {
    id: '6f63b286-f5c8-4b86-a42d-99acb22a9369',
    sessionId: null,
    projectId,
    text: 'new project chat',
    mode: 'auto',
    model: '5.6',
    reasoningEffort: 'high'
  };
  const first = await bridge.sendInput(input);
  assert.equal(state.inputs[0].projectId, projectId);
  assert.equal(first.sessionId, null);
  state.inputs[0].deliveredSessionId = '2026-09-13-newchat1';
  state.inputs[0].conversationId = 'conversation-new-1';
  state.inputs[0].state = 'sent';
  const repeated = await bridge.sendInput(input);
  assert.equal(repeated.deliveredSessionId, '2026-09-13-newchat1');
  assert.equal(repeated.conversationId, 'conversation-new-1');
  assert.equal(repeated.idempotent, true);
});

test('private COS pipe exposes only the guarded COS stop-turn primitive for stopping an active response', async () => {
  const { bridge } = fakeCos();
  const result = await bridge.stopSessionTurn('session-1', 'turn-123');
  assert.deepEqual(result, { stopped: true, sessionId: 'session-1', turnId: 'turn-123' });
});

test('private COS pipe exposes the narrow phone control wrappers with exact COS argument shapes', async () => {
  const { bridge, state } = fakeCos();
  assert.equal((await bridge.getUsage()).limits[0].remainingPercent, 80);
  assert.equal((await bridge.getSessionControls('session-1')).sessionId, 'session-1');
  assert.equal((await bridge.getSwarm()).agents[0].id, 'worker-2');
  assert.equal((await bridge.setSessionAutomation('session-1', 'goal')).automation, 'goal');
  assert.equal((await bridge.setSessionObjective('session-1', 'Finish it', 'loop')).objective, 'Finish it');
  assert.equal((await bridge.compactSession('session-1')).job.stage, 'preparing');
  assert.equal(state.compacting, true);
  assert.equal((await bridge.cancelSessionCompaction('session-1')).job, null);
  state.inputs.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'queued' });
  assert.equal(await bridge.cancelInput('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
  assert.equal(state.inputs.at(-1).state, 'cancelled');
});

test('ambiguous send timeout reconciles against COS outbox using the same UUID', async () => {
  const { bridge, state } = fakeCos();
  state.hangNextSend = true;
  const result = await bridge.sendInput({
    id: '17319389-6034-4915-815c-bf002058880c',
    sessionId: 'session-1',
    projectId: null,
    conversationId: 'conversation-1',
    text: 'timeout but accepted',
    mode: 'auto',
    model: null,
    reasoningEffort: null
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.status, 'queued');
  assert.equal(state.inputs.length, 1);
});

test('child exit makes the pipe unavailable instead of leaving stale ready state', async () => {
  const { bridge, child } = fakeCos();
  await bridge.getModels();
  assert.equal(bridge.status().available, true);
  child.exit(0);
  assert.equal(bridge.status().available, false);
  assert.equal(bridge.status().state, 'needs-restart');
});

test('renderer detach is recovered on the same live pipe without respawning COS', async () => {
  const fx = fakeCos();
  await fx.bridge.getModels();
  assert.equal(fx.state.attachCount, 1);
  fx.state.rendererSessionId = 'renderer-2';
  fx.state.rendererTargetId = 'page-2';
  fx.child.event('Target.detachedFromTarget', { sessionId: 'renderer-1', targetId: 'page-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const models = await fx.bridge.getModels();
  assert.equal(models[0].id, '5.6');
  assert.equal(fx.state.attachCount, 2);
  assert.equal(fx.spawnCount, 1);
});

test('stale renderer protocol error triggers rediscovery on the same pipe', async () => {
  const fx = fakeCos();
  await fx.bridge.getModels();
  fx.state.rendererSessionId = 'renderer-2';
  fx.state.rendererTargetId = 'page-2';
  const models = await fx.bridge.getModels();
  assert.equal(models[0].id, '5.6');
  assert.equal(fx.state.attachCount, 2);
  assert.equal(fx.spawnCount, 1);
});

test('slow renderer startup keeps the original child and later retries discovery on that pipe', async () => {
  const fx = fakeCos({
    startTimeoutMs: 8,
    retryBackoffMs: 100,
    sleepImpl: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1))),
    state: { probeReady: false }
  });
  await assert.rejects(() => fx.bridge.getModels(), /has not exposed its renderer API yet/);
  assert.equal(fx.spawnCount, 1);
  assert.equal(fx.child.exitCode, null);
  fx.state.probeReady = true;
  const models = await fx.bridge.getModels();
  assert.equal(models[0].id, '5.6');
  assert.equal(fx.spawnCount, 1);
});

test('a transient listInputs failure stops a send before COS sendInput is called', async () => {
  const fx = fakeCos({ state: { listInputsErrorOnce: true } });
  await assert.rejects(() => fx.bridge.sendInput({
    id: '3a733075-c7bf-4e00-a689-b686c29f6eb0',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    text: 'do not enqueue after failed reconciliation',
    mode: 'auto',
    model: null,
    reasoningEffort: null
  }));
  assert.equal(fx.state.sendCount, 0);
});

test('persistent UUID ledger prevents resend after bridge restart and COS outbox pruning', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-ledger-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledgerPath = path.join(root, 'cos-send-ledger.json');
  const input = {
    id: 'fe322d10-772c-42bc-af35-456e347ee8f3',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    text: 'persist me',
    mode: 'auto',
    model: '5.6',
    reasoningEffort: 'high'
  };

  const first = fakeCos({ ledgerPath });
  const accepted = await first.bridge.sendInput(input);
  assert.equal(accepted.idempotent, false);
  assert.equal(first.state.sendCount, 1);

  const second = fakeCos({ ledgerPath });
  const replay = await second.bridge.sendInput(input);
  assert.equal(replay.idempotent, true);
  assert.equal(second.state.sendCount, 0);
});

test('old child events cannot tear down a newer ready transport generation', async () => {
  const states = [0, 1].map((index) => ({
    inputs: [], hangNextSend: false, listInputsErrorOnce: false, probeReady: true,
    rendererSessionId: `renderer-${index + 1}`, rendererTargetId: `page-${index + 1}`,
    attachCount: 0, sendCount: 0, calls: []
  }));
  const children = states.map((state) => createFakeChild(state));
  let spawnIndex = 0;
  const bridge = new CosPipeBridge({
    exePath: 'C:\\Fake\\Chat On Steroids.exe',
    spawnImpl: () => children[spawnIndex++],
    readTimeoutMs: 100,
    startTimeoutMs: 200,
    retryBackoffMs: 0,
    ledgerPath: null
  });

  await bridge.getModels();
  children[0].exit(0);
  await bridge.getModels();
  assert.equal(bridge.status().available, true);
  children[0].emit('error', new Error('late old-child error'));
  assert.equal(bridge.status().available, true);
  assert.equal((await bridge.getModels())[0].id, '5.6');
});

test('normal bridge close asks COS to exit and prevents an accidental respawn', async () => {
  const fx = fakeCos();
  await fx.bridge.getModels();
  await fx.bridge.close({ closeCos: true, timeoutMs: 100 });
  assert.equal(fx.child.exitCode, 0);
  await assert.rejects(
    () => fx.bridge.getModels(),
    (error) => error?.code === 'COS_BRIDGE_UNAVAILABLE' && /closed/i.test(error.message)
  );
  assert.equal(fx.spawnCount, 1);
});

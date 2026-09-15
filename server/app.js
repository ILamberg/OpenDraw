import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';
import { DataStore } from './data-store.js';
import { answerReadyPayload } from './push-service.js';
import { SessionStore, defaultSessionsDir } from './session-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.resolve(HERE, '..', 'public');
const DEFAULT_DATA_DIR = path.resolve(HERE, '..', '.data');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const MAX_BODY = 64 * 1024;
const JSON_COMPRESSION_THRESHOLD = 2048;
const PAIR_WINDOW = { startedAt: 0, count: 0 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function headers(extra = {}) {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'x-permitted-cross-domain-policies': 'none',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
    'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra
  };
}

function acceptedEncoding(header, name) {
  if (typeof header !== 'string' || !header) return 0;
  let wildcard = 0;
  for (const part of header.split(',')) {
    const [tokenRaw, ...params] = part.trim().toLowerCase().split(';');
    let quality = 1;
    for (const param of params) {
      const match = /^q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(param.trim());
      if (match) quality = Number(match[1]);
    }
    if (tokenRaw === name) return quality;
    if (tokenRaw === '*') wildcard = quality;
  }
  return wildcard;
}

function json(res, status, body) {
  const raw = Buffer.from(JSON.stringify(body));
  let payload = raw;
  let contentEncoding = null;
  if (raw.length >= JSON_COMPRESSION_THRESHOLD) {
    const acceptEncoding = res.req?.headers?.['accept-encoding'];
    const brQuality = acceptedEncoding(acceptEncoding, 'br');
    const gzipQuality = acceptedEncoding(acceptEncoding, 'gzip');
    try {
      if (brQuality > 0 && brQuality >= gzipQuality) {
        const compressed = brotliCompressSync(raw, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 }
        });
        if (compressed.length < raw.length) {
          payload = compressed;
          contentEncoding = 'br';
        }
      } else if (gzipQuality > 0) {
        const compressed = gzipSync(raw, { level: 5 });
        if (compressed.length < raw.length) {
          payload = compressed;
          contentEncoding = 'gzip';
        }
      }
    } catch {
      payload = raw;
      contentEncoding = null;
    }
  }
  res.writeHead(status, headers({
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'vary': 'Accept-Encoding',
    ...(contentEncoding ? { 'content-encoding': contentEncoding } : {})
  }));
  res.end(payload);
}

function bearer(req) {
  const raw = req.headers.authorization;
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error('body_too_large');
        error.status = 413;
        req.removeAllListeners('data');
        req.resume();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('invalid_json');
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function pairRateLimited() {
  const now = Date.now();
  if (now - PAIR_WINDOW.startedAt > 5 * 60_000) {
    PAIR_WINDOW.startedAt = now;
    PAIR_WINDOW.count = 0;
  }
  PAIR_WINDOW.count += 1;
  return PAIR_WINDOW.count > 20;
}

function cleanString(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function projectInputMetadata(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).map((row) => ({
    id: cleanString(row?.id, 80),
    sessionId: cleanString(row?.sessionId ?? row?.deliveredSessionId, 80),
    deliveredSessionId: cleanString(row?.deliveredSessionId, 80),
    state: cleanString(row?.state, 40),
    mode: cleanString(row?.requestedMode ?? row?.mode, 40),
    transportIntent: cleanString(row?.transportIntent, 40),
    model: cleanString(row?.model, 80),
    reasoningEffort: cleanString(row?.reasoningEffort, 40),
    createdAt: Number.isFinite(row?.createdAt) ? row.createdAt : null,
    deliveredAt: Number.isFinite(row?.deliveredAt) ? row.deliveredAt : null,
    error: cleanString(row?.error, 300)
  })).filter((row) => row.id);
}

function projectLiveState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw.status && typeof raw.status === 'object' ? raw.status : null;
  const bridge = raw.bridge && typeof raw.bridge === 'object' ? raw.bridge : null;
  const update = raw.update && typeof raw.update === 'object' ? raw.update : null;
  return {
    connected: raw.connected === true || status?.connected === true,
    appVersion: cleanString(raw.appVersion ?? raw.version, 80),
    provider: cleanString(raw.provider ?? raw.config?.provider?.kind, 80),
    readOnly: raw.config?.readOnly === true,
    status: status ? {
      state: cleanString(status.state, 80),
      connected: status.connected === true
    } : null,
    bridge: bridge ? {
      state: cleanString(bridge.state, 80),
      connected: bridge.connected === true,
      paired: bridge.paired === true
    } : null,
    update: update ? {
      state: cleanString(update.state, 80),
      available: update.available === true,
      version: cleanString(update.version, 80)
    } : null
  };
}

function projectLiveSessionCatalog(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.sessions) ? raw.sessions : [];
  return {
    count: rows.length,
    activeId: cleanString(raw?.activeId, 80),
    sessions: rows.slice(0, 100).map((row) => ({
      id: cleanString(row?.id, 80),
      title: cleanString(row?.title, 160),
      conversationId: cleanString(row?.conversationId, 256),
      projectId: cleanString(row?.projectId, 80),
      activeTurnId: cleanString(row?.activeTurnId, 256),
      endedAt: Number.isFinite(row?.endedAt) ? row.endedAt : null,
      updatedAt: Number.isFinite(row?.updatedAt) ? row.updatedAt : null
    })).filter((row) => row.id)
  };
}

function projectLiveCurrentSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: cleanString(raw.id ?? raw.session?.id, 80),
    conversationId: cleanString(raw.conversationId ?? raw.session?.conversationId, 256),
    projectId: cleanString(raw.projectId ?? raw.session?.projectId, 80),
    activeTurnId: cleanString(raw.activeTurnId ?? raw.session?.activeTurnId, 256)
  };
}

function projectControls(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const job = raw.job && typeof raw.job === 'object' ? raw.job : null;
  return {
    activeTurnId: cleanString(raw.activeTurnId, 256),
    finishHeld: raw.finishHeld === true,
    queueAtFinish: raw.queueAtFinish === true,
    canInject: raw.canInject === true,
    canSendDirectly: raw.canSendDirectly === true,
    finishWaiting: raw.finishWaiting === true,
    stopPending: raw.stopPending === true,
    objective: cleanString(raw.objective, 16_000) ?? '',
    automation: ['off', 'goal', 'loop'].includes(raw.automation) ? raw.automation : 'off',
    blocked: raw.blocked === true,
    job: job ? {
      stage: cleanString(job.stage, 80),
      startedAt: Number.isFinite(job.startedAt) ? job.startedAt : null,
      automatic: job.automatic === true,
      busy: job.busy === true,
      error: cleanString(job.error, 400)
    } : null
  };
}

function projectSwarmAgents(raw, conversationId) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.agents) || typeof conversationId !== 'string') return [];
  const stateMap = {
    invited: 'working',
    active: 'working',
    detached: 'working',
    waking: 'working',
    sleeping: 'sleeping',
    finished: 'done',
    failed: 'failed'
  };
  return raw.agents
    .filter((agent) => agent?.role === 'worker' && agent?.primeConversationId === conversationId)
    .slice(0, 24)
    .map((agent) => {
      const sourceState = cleanString(agent.state, 32);
      return {
        id: cleanString(agent.id, 80),
        label: cleanString(agent.label, 80),
        status: stateMap[sourceState] || 'idle',
        revivable: agent.revivable === true,
        startedAt: Number.isFinite(agent.activatedAt) ? agent.activatedAt : Number.isFinite(agent.createdAt) ? agent.createdAt : null,
        finishedAt: Number.isFinite(agent.finishedAt)
          ? agent.finishedAt
          : Number.isFinite(agent.sleptAt) ? agent.sleptAt : null
      };
    })
    .filter((agent) => agent.id)
    .sort((a, b) => {
      const rank = (status) => status === 'working' ? 0 : status === 'sleeping' ? 1 : status === 'idle' ? 2 : 3;
      return rank(a.status) - rank(b.status) || (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0) || a.id.localeCompare(b.id);
    });
}

function projectQueue(rows, sessionId) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && row.purpose !== 'decision' && (row.sessionId === sessionId || row.deliveredSessionId === sessionId))
    .sort((a, b) => (a.queueOrder ?? a.createdAt ?? 0) - (b.queueOrder ?? b.createdAt ?? 0))
    .slice(0, 100)
    .map((row) => {
      const mode = cleanString(row.requestedMode ?? row.mode, 40);
      const state = cleanString(row.state, 40);
      const text = cleanString(row.text, 500) ?? '';
      return {
        id: cleanString(row.id, 80),
        state,
        mode,
        textPreview: text,
        textTruncated: typeof row.text === 'string' && row.text.length > text.length,
        queueOrder: Number.isFinite(row.queueOrder) ? row.queueOrder : null,
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
        dueAt: Number.isFinite(row.dueAt) ? row.dueAt : null,
        model: cleanString(row.model, 80),
        reasoningEffort: cleanString(row.reasoningEffort, 40),
        transportIntent: cleanString(row.transportIntent, 40),
        error: cleanString(row.error, 300),
        cancelable: ['queued', 'browser'].includes(row.state),
        editable: row.state === 'queued' && ['finish', 'after-turn'].includes(row.mode)
      };
    })
    .filter((row) => row.id);
}

function projectUsage(raw) {
  if (!raw || typeof raw !== 'object') return { available: false, limits: [] };
  const limits = Array.isArray(raw.limits) ? raw.limits.slice(0, 60).map((row) => ({
    model: cleanString(row?.model, 120),
    scope: ['model', 'feature', 'shared'].includes(row?.scope) ? row.scope : null,
    remaining: Number.isFinite(row?.remaining) ? row.remaining : null,
    remainingPercent: Number.isFinite(row?.remainingPercent) ? row.remainingPercent : null,
    resetAt: Number.isFinite(row?.resetAt) ? row.resetAt : null,
    windowSeconds: Number.isFinite(row?.windowSeconds) ? row.windowSeconds : null,
    observedAt: Number.isFinite(row?.observedAt) ? row.observedAt : null
  })) : [];
  return {
    available: true,
    days: Number.isFinite(raw.days) ? raw.days : null,
    sessions: Number.isFinite(raw.sessions) ? raw.sessions : null,
    limits
  };
}

export async function createOpenDrawServer(options = {}) {
  const sessionStore = options.sessionStore ?? new SessionStore(options.sessionsDir ?? defaultSessionsDir(options.env));
  const dataStore = options.dataStore ?? await new DataStore(options.dataDir ?? DEFAULT_DATA_DIR).init();
  const cosBridge = options.cosBridge ?? null;
  const cosStateStore = options.cosStateStore ?? null;
  const pushService = options.pushService ?? null;
  const screenService = options.screenService ?? null;
  const publicDir = path.resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const bootId = randomUUID();
  const controlSecret = typeof options.controlSecret === 'string' ? options.controlSecret : '';
  const requestShutdown = typeof options.requestShutdown === 'function' ? options.requestShutdown : null;

  function validControlSecret(req) {
    if (!controlSecret) return false;
    const supplied = req.headers['x-opendraw-control'];
    if (typeof supplied !== 'string') return false;
    const expectedBytes = Buffer.from(controlSecret, 'utf8');
    const suppliedBytes = Buffer.from(supplied, 'utf8');
    return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
  }

  async function bridgeCall(method, ...args) {
    if (!cosBridge || typeof cosBridge[method] !== 'function') return { ok: false, value: null, error: 'adapter_unavailable' };
    try {
      return { ok: true, value: await cosBridge[method](...args), error: null };
    } catch (error) {
      return { ok: false, value: null, error: error?.message ?? String(error) };
    }
  }

  async function attachCurrentScreen(id, text, requested) {
    if (requested !== true) return { text, screenAttached: false };
    if (!screenService?.snapshotForPrompt) {
      const error = new Error('The local screen capture service is unavailable.');
      error.code = 'SCREEN_UNAVAILABLE';
      throw error;
    }
    const snapshot = await screenService.snapshotForPrompt(id);
    if (!snapshot || typeof snapshot.path !== 'string' || !snapshot.path) {
      const error = new Error('The current desktop frame could not be prepared.');
      error.code = 'SCREEN_UNAVAILABLE';
      throw error;
    }
    const context = `A current OpenDraw desktop screenshot for this user request is stored at ${snapshot.path}. Use the local file/image viewing tool to inspect that exact image before answering or taking requested computer actions. Treat it as the current screen context. After you have successfully inspected the image and extracted the information you need from it, delete that exact screenshot file from disk before answering. Delete only this screen-snapshot file, not its parent directory or any other file. If inspection fails, leave the file in place so the same request can retry safely. Do not reveal this internal path.`;
    return {
      text: `[[OPENDRAW_SCREEN_CONTEXT:${context.length}]]\n${context}\n[[/OPENDRAW_SCREEN_CONTEXT]]\n\n${text}`,
      screenAttached: true
    };
  }

  async function bridgeSnapshot(currentSessionId = null) {
    if (cosBridge && typeof cosBridge.snapshot === 'function') {
      try {
        const value = await cosBridge.snapshot(currentSessionId);
        return {
          configured: true,
          state: projectLiveState(value?.state),
          models: value?.models ?? null,
          inputs: projectInputMetadata(value?.inputs),
          sessions: projectLiveSessionCatalog(value?.sessions),
          currentSession: projectLiveCurrentSession(value?.currentSession),
          send: { available: true, error: null },
          errors: { state: null, models: null, inputs: null, sessions: null, currentSession: null }
        };
      } catch (error) {
        return {
          configured: true,
          state: null,
          models: null,
          inputs: null,
          sessions: null,
          currentSession: null,
          send: { available: false, error: error?.message ?? String(error) },
          errors: { state: error?.message ?? String(error), models: null, inputs: null, sessions: null, currentSession: null }
        };
      }
    }
    const [state, models, inputs, sessions, currentSession] = await Promise.all([
      bridgeCall('getState'),
      bridgeCall('getModels'),
      bridgeCall('listInputs'),
      bridgeCall('listSessions'),
      currentSessionId ? bridgeCall('getSession', currentSessionId) : Promise.resolve({ ok: false, value: null, error: 'no_current_session' })
    ]);
    const stateValue = state.ok ? state.value : null;
    const explicitlyDisconnected = stateValue && typeof stateValue === 'object'
      && (stateValue.connected === false || stateValue.available === false);
    return {
      configured: Boolean(cosBridge),
      state: projectLiveState(stateValue),
      models: models.ok ? models.value : null,
      inputs: inputs.ok ? projectInputMetadata(inputs.value) : [],
      sessions: sessions.ok ? projectLiveSessionCatalog(sessions.value) : null,
      currentSession: currentSession.ok ? projectLiveCurrentSession(currentSession.value) : null,
      send: {
        available: Boolean(cosBridge && typeof cosBridge.sendInput === 'function' && state.ok && stateValue !== null && !explicitlyDisconnected),
        error: state.ok ? null : state.error
      },
      errors: {
        state: state.ok ? null : state.error,
        models: models.ok ? null : models.error,
        inputs: inputs.ok ? null : inputs.error,
        sessions: sessions.ok ? null : sessions.error,
        currentSession: currentSession.ok ? null : currentSession.error
      }
    };
  }

  async function requireDevice(req, res) {
    const device = await dataStore.authorizeDevice(bearer(req));
    if (!device) {
      json(res, 401, { error: 'unauthorized' });
      return null;
    }
    return device;
  }

  async function api(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        app: 'opendraw',
        now: Date.now()
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/internal/restart') {
      if (!requestShutdown || !validControlSecret(req)) {
        return json(res, 404, { error: 'not_found' });
      }
      json(res, 202, { ok: true });
      setImmediate(() => requestShutdown());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (pairRateLimited()) return json(res, 429, { error: 'pair_rate_limited' });
      const body = await readBody(req);
      const paired = await dataStore.pairDevice(body.pairingSecret, body.deviceName);
      if (!paired) return json(res, 401, { error: 'invalid_pairing_secret' });
      return json(res, 201, { ...paired, bootId });
    }

    const device = await requireDevice(req, res);
    if (!device) return;

    if (req.method === 'GET' && url.pathname === '/api/screen/status') {
      const raw = screenService?.status?.() ?? null;
      return json(res, 200, {
        available: raw?.available === true,
        capturing: raw?.capturing === true,
        viewers: Number.isFinite(raw?.viewers) ? raw.viewers : 0,
        targetFps: Number.isFinite(raw?.targetFps) ? raw.targetFps : null,
        maxWidth: Number.isFinite(raw?.maxWidth) ? raw.maxWidth : null,
        codec: cleanString(raw?.codec, 32),
        latestAt: Number.isFinite(raw?.latestAt) ? raw.latestAt : null,
        error: cleanString(raw?.error, 240),
        bootId
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/screen/stream') {
      if (!screenService?.subscribe) return json(res, 503, { error: 'screen_unavailable' });
      try {
        await screenService.subscribe(req, res, { deviceId: device.id });
      } catch (error) {
        if (!res.headersSent) return json(res, 503, { error: 'screen_unavailable', message: cleanString(error?.message, 240) });
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/screen/frames') {
      if (!screenService?.subscribeFrames) return json(res, 503, { error: 'screen_unavailable' });
      try {
        await screenService.subscribeFrames(req, res, { deviceId: device.id });
      } catch (error) {
        if (!res.headersSent) return json(res, 503, { error: 'screen_unavailable', message: cleanString(error?.message, 240) });
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/screen/ask') {
      if (!screenService?.snapshotForPrompt) return json(res, 503, { error: 'screen_unavailable' });
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
      const text = typeof body.text === 'string' ? body.text : '';
      const model = body.model === null || body.model === undefined || body.model === ''
        ? null
        : typeof body.model === 'string' ? body.model.trim() : '__invalid__';
      const reasoningEffort = body.reasoningEffort === null || body.reasoningEffort === undefined || body.reasoningEffort === ''
        ? null
        : typeof body.reasoningEffort === 'string' ? body.reasoningEffort : '__invalid__';
      const validEfforts = new Set(['pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      if (!UUID.test(id) || !SESSION_ID.test(sessionId) || !text.trim() || text.length > 15_000
        || conversationId.length < 8 || conversationId.length > 256
        || (model !== null && !/^[a-zA-Z0-9 ._-]{1,80}$/.test(model))
        || (reasoningEffort !== null && !validEfforts.has(reasoningEffort))) {
        return json(res, 400, { error: 'invalid_screen_prompt' });
      }
      try {
        await sessionStore.assertExactTarget(sessionId, conversationId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'target_mismatch', message: error.message });
      }
      if (!cosBridge || typeof cosBridge.sendInput !== 'function') {
        return json(res, 503, { error: 'send_unavailable', message: 'The direct Chat On Steroids adapter is not connected yet.' });
      }
      try {
        const prepared = await attachCurrentScreen(id, text, true);
        const result = await cosBridge.sendInput({
          id,
          sessionId,
          conversationId,
          text: prepared.text,
          mode: 'auto',
          model,
          reasoningEffort
        });
        return json(res, 202, {
          result: result && typeof result === 'object' ? result : { id, status: 'accepted' },
          screenAttached: true,
          bootId
        });
      } catch (error) {
        if (error?.code === 'IDEMPOTENCY_CONFLICT') return json(res, 409, { error: 'idempotency_conflict' });
        if (error?.code === 'OUTBOUND_UNAVAILABLE' || error?.code === 'COS_BRIDGE_UNAVAILABLE') {
          return json(res, 503, { error: 'send_unavailable', message: error.message });
        }
        if (error?.code === 'SCREEN_UNAVAILABLE') {
          return json(res, 503, { error: 'screen_unavailable', message: cleanString(error?.message, 240) });
        }
        throw error;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/push/status') {
      return json(res, 200, {
        available: Boolean(pushService?.publicKey?.()),
        publicKey: pushService?.publicKey?.() ?? null,
        subscribed: Boolean(pushService?.hasSubscription?.(device.id)),
        bootId
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/push/subscription') {
      if (!pushService?.setSubscription) return json(res, 503, { error: 'push_unavailable' });
      const body = await readBody(req);
      try {
        await pushService.setSubscription(device.id, body?.subscription);
        return json(res, 200, { ok: true, subscribed: true, bootId });
      } catch (error) {
        return json(res, 400, { error: 'invalid_push_subscription', message: error?.message ?? 'Invalid push subscription' });
      }
    }

    if (req.method === 'DELETE' && url.pathname === '/api/push/subscription') {
      if (!pushService?.removeSubscription) return json(res, 503, { error: 'push_unavailable' });
      await pushService.removeSubscription(device.id);
      return json(res, 200, { ok: true, subscribed: false, bootId });
    }

    if (req.method === 'POST' && url.pathname === '/api/push/test') {
      if (!pushService?.sendToDevice) return json(res, 503, { error: 'push_unavailable' });
      const result = await pushService.sendToDevice(device.id, answerReadyPayload());
      if (result.missing) return json(res, 409, { error: 'push_not_subscribed' });
      if (!result.sent) return json(res, 503, { error: 'push_delivery_failed' });
      return json(res, 200, { ok: true, sent: result.sent, bootId });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      let cos;
      try {
        const durable = await sessionStore.statusSnapshot();
        const live = await bridgeSnapshot(durable.currentSessionId);
        cos = { readable: true, ...durable, live };
      } catch (error) {
        cos = { readable: false, error: 'sessions_unreadable', live: await bridgeSnapshot() };
      }
      return json(res, 200, {
        bootId,
        now: Date.now(),
        device,
        cos
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/models') {
      const durable = await sessionStore.statusSnapshot();
      const live = await bridgeCall('getModels');
      let catalog = null;
      if (cosStateStore && typeof cosStateStore.models === 'function') {
        try { catalog = await cosStateStore.models(); } catch { catalog = null; }
      }
      return json(res, 200, {
        bootId,
        observed: durable.models,
        providers: durable.providers,
        catalog,
        live: live.ok ? live.value : null,
        liveAvailable: live.ok,
        error: live.ok ? null : live.error
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/cos-info') {
      const requestedSessionId = url.searchParams.get('sessionId');
      const sessionId = requestedSessionId && SESSION_ID.test(requestedSessionId) ? requestedSessionId : null;
      if (!cosStateStore || typeof cosStateStore.snapshot !== 'function') {
        return json(res, 200, { bootId, available: false, catalog: null, projects: [], settings: null, outbox: [] });
      }
      const snapshot = await cosStateStore.snapshot({ sessionId });
      const liveProjects = await bridgeCall('listProjects');
      const projectedLiveProjects = Array.isArray(liveProjects.value)
        ? liveProjects.value.slice(0, 100).map((project) => ({
            id: typeof project?.id === 'string' ? project.id.slice(0, 80) : null,
            name: typeof project?.name === 'string' ? project.name.slice(0, 160) : 'Project',
            createdAt: Number.isFinite(project?.createdAt) ? project.createdAt : null,
            ungrouped: project?.ungrouped === true
          })).filter((project) => project.id)
        : null;
      return json(res, 200, {
        bootId,
        available: true,
        ...snapshot,
        projects: projectedLiveProjects ?? snapshot.projects
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return json(res, 200, { ...(await sessionStore.listNormalSessions()), bootId });
    }

    if (req.method === 'GET' && url.pathname === '/api/usage') {
      const usage = await bridgeCall('getUsage');
      return json(res, 200, {
        bootId,
        ...(usage.ok ? projectUsage(usage.value) : { available: false, limits: [], error: usage.error })
      });
    }

    const controlsMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/controls$/i.exec(url.pathname);
    if (controlsMatch && req.method === 'GET') {
      const sessionId = controlsMatch[1];
      try {
        await sessionStore.assertNormalSession(sessionId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'session_unavailable' });
      }
      const controls = await bridgeCall('getSessionControls', sessionId);
      if (!controls.ok) return json(res, 503, { error: 'controls_unavailable', message: controls.error });
      return json(res, 200, { bootId, controls: projectControls(controls.value) });
    }

    const activityMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/activity$/i.exec(url.pathname);
    if (activityMatch && req.method === 'GET') {
      const sessionId = activityMatch[1];
      let activity;
      try {
        const afterSeq = Math.max(0, Number.parseInt(url.searchParams.get('afterSeq') ?? '0', 10) || 0);
        const revisionParam = url.searchParams.get('revision');
        const revision = revisionParam === null ? null : Math.max(0, Number.parseInt(revisionParam, 10) || 0);
        activity = await sessionStore.activity(sessionId, { limit: 5000, afterSeq, revision });
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'session_unavailable' });
      }
      const durableOnly = url.searchParams.get('durableOnly') === '1';
      const [controls, swarm] = durableOnly
        ? [{ ok: false }, { ok: false }]
        : await Promise.all([
            bridgeCall('getSessionControls', sessionId),
            bridgeCall('getSwarm')
          ]);
      const liveAgents = !durableOnly && swarm.ok ? projectSwarmAgents(swarm.value, activity.session?.conversationId) : [];
      return json(res, 200, {
        bootId,
        plan: activity.plan,
        tools: activity.tools,
        visuals: activity.visuals,
        responses: activity.responses,
        agents: liveAgents.length ? liveAgents : activity.agents,
        revision: activity.revision,
        resync: activity.resync === true,
        nextToolSeq: activity.nextToolSeq,
        hasMore: activity.hasMore === true,
        controls: controls.ok ? projectControls(controls.value) : null,
        controlsAvailable: controls.ok
      });
    }

    const visualMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/visuals\/(visual-[0-9a-f]{24})$/i.exec(url.pathname);
    if (visualMatch && req.method === 'GET') {
      const sessionId = visualMatch[1];
      const visualId = visualMatch[2].toLowerCase();
      let visual;
      try {
        visual = await sessionStore.visual(sessionId, visualId);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'VISUAL_NOT_FOUND') return json(res, 404, { error: 'visual_not_found' });
        return json(res, 409, { error: 'visual_unavailable' });
      }
      res.writeHead(200, headers({
        'content-type': visual.mimeType,
        'content-length': visual.bytes
      }));
      const stream = createReadStream(visual.file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    const automationMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/automation$/i.exec(url.pathname);
    if (automationMatch && req.method === 'POST') {
      const sessionId = automationMatch[1];
      const body = await readBody(req);
      const automation = typeof body.automation === 'string' ? body.automation : '';
      const objectiveProvided = Object.hasOwn(body, 'objective');
      const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
      if (!['off', 'goal', 'loop'].includes(automation) || (objectiveProvided && objective.length > 16_000)) {
        return json(res, 400, { error: 'invalid_automation' });
      }
      try {
        await sessionStore.assertNormalSession(sessionId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'session_unavailable' });
      }
      let changed;
      if (automation === 'off' && objectiveProvided) {
        changed = await bridgeCall('setSessionObjective', sessionId, '', 'goal');
      } else if (automation !== 'off' && objectiveProvided && objective) {
        changed = await bridgeCall('setSessionObjective', sessionId, objective, automation);
      } else {
        changed = await bridgeCall('setSessionAutomation', sessionId, automation);
      }
      if (!changed.ok) return json(res, 503, { error: 'automation_unavailable', message: changed.error });
      return json(res, 200, { bootId, controls: projectControls(changed.value) });
    }

    const compactMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/compact$/i.exec(url.pathname);
    if (compactMatch && ['POST', 'DELETE'].includes(req.method)) {
      const sessionId = compactMatch[1];
      try {
        await sessionStore.assertNormalSession(sessionId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'session_unavailable' });
      }
      const changed = req.method === 'POST'
        ? await bridgeCall('compactSession', sessionId)
        : await bridgeCall('cancelSessionCompaction', sessionId);
      if (!changed.ok) return json(res, 503, { error: 'compaction_unavailable', message: changed.error });
      return json(res, 200, { bootId, controls: projectControls(changed.value) });
    }

    const queueMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/queue$/i.exec(url.pathname);
    if (queueMatch && req.method === 'GET') {
      const sessionId = queueMatch[1];
      try {
        await sessionStore.assertNormalSession(sessionId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'session_unavailable' });
      }
      const rows = await bridgeCall('listInputs');
      if (!rows.ok) return json(res, 503, { error: 'queue_unavailable', message: rows.error });
      return json(res, 200, { bootId, queue: projectQueue(rows.value, sessionId) });
    }

    const queueItemMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/queue\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (queueItemMatch && req.method === 'DELETE') {
      const [, sessionId, inputId] = queueItemMatch;
      if (!UUID.test(inputId)) return json(res, 400, { error: 'invalid_input' });
      try {
        await sessionStore.assertNormalSession(sessionId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'session_unavailable' });
      }
      const rows = await bridgeCall('listInputs');
      if (!rows.ok) return json(res, 503, { error: 'queue_unavailable', message: rows.error });
      const row = Array.isArray(rows.value)
        ? rows.value.find((item) => item?.id === inputId && (item?.sessionId === sessionId || item?.deliveredSessionId === sessionId))
        : null;
      if (!row) return json(res, 404, { error: 'input_not_found' });
      if (!['queued', 'browser'].includes(row.state)) return json(res, 409, { error: 'input_not_cancelable' });
      const cancelled = await bridgeCall('cancelInput', inputId);
      if (!cancelled.ok) return json(res, 503, { error: 'queue_unavailable', message: cancelled.error });
      return json(res, 200, { bootId, ok: cancelled.value === true });
    }

    if (req.method === 'POST' && url.pathname === '/api/chats') {
      const body = await readBody(req);
      const id = typeof body.id === 'string' ? body.id : '';
      const text = typeof body.text === 'string' ? body.text : '';
      const projectId = body.projectId === null || body.projectId === undefined || body.projectId === ''
        ? null
        : typeof body.projectId === 'string' ? body.projectId.trim() : '__invalid__';
      const model = body.model === null || body.model === undefined || body.model === ''
        ? null
        : typeof body.model === 'string' ? body.model.trim() : '__invalid__';
      const reasoningEffort = body.reasoningEffort === null || body.reasoningEffort === undefined || body.reasoningEffort === ''
        ? null
        : typeof body.reasoningEffort === 'string' ? body.reasoningEffort : '__invalid__';
      const screen = body.screen === undefined ? false : typeof body.screen === 'boolean' ? body.screen : null;
      const validEfforts = new Set(['pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      if (!UUID.test(id) || !text.trim() || text.length > 16_000
        || (projectId !== null && !PROJECT_ID.test(projectId))
        || (model !== null && !/^[a-zA-Z0-9 ._-]{1,80}$/.test(model))
        || (reasoningEffort !== null && !validEfforts.has(reasoningEffort))
        || screen === null) {
        return json(res, 400, { error: 'invalid_new_chat' });
      }
      if (projectId !== null) {
        // Prefer COS's live project catalog. The durable projects file can lag behind the
        // desktop UI briefly after a project is added/removed, which made a phone button
        // look valid but then fail when tapped.
        const liveProjects = await bridgeCall('listProjects');
        let projects = Array.isArray(liveProjects.value) ? liveProjects.value : null;
        if (!projects && cosStateStore && typeof cosStateStore.projects === 'function') {
          try { projects = await cosStateStore.projects(); } catch { projects = null; }
        }
        if (!projects) {
          return json(res, 503, { error: 'projects_unavailable', message: 'Chat On Steroids projects are not available yet.' });
        }
        const project = projects.find((row) => row?.id === projectId && row?.ungrouped !== true);
        if (!project) return json(res, 404, { error: 'project_not_found' });
      }
      if (!cosBridge || typeof cosBridge.sendInput !== 'function') {
        return json(res, 503, { error: 'send_unavailable', message: 'The direct Chat On Steroids adapter is not connected yet.' });
      }
      try {
        const prepared = await attachCurrentScreen(id, text, screen);
        const result = await cosBridge.sendInput({
          id,
          sessionId: null,
          projectId,
          text: prepared.text,
          mode: 'auto',
          model,
          reasoningEffort
        });
        return json(res, 202, {
          result: result && typeof result === 'object' ? result : { id, status: 'accepted' },
          screenAttached: prepared.screenAttached,
          bootId
        });
      } catch (error) {
        if (error?.code === 'IDEMPOTENCY_CONFLICT') return json(res, 409, { error: 'idempotency_conflict' });
        if (error?.code === 'OUTBOUND_UNAVAILABLE' || error?.code === 'COS_BRIDGE_UNAVAILABLE') {
          return json(res, 503, { error: 'send_unavailable', message: error.message });
        }
        if (error?.code === 'SCREEN_UNAVAILABLE') {
          return json(res, 503, { error: 'screen_unavailable', message: cleanString(error?.message, 240) });
        }
        throw error;
      }
    }

    const stopMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/stop$/i.exec(url.pathname);
    if (stopMatch && req.method === 'POST') {
      const sessionId = stopMatch[1];
      const body = await readBody(req);
      const expectedTurnId = typeof body.expectedTurnId === 'string' ? body.expectedTurnId : '';
      if (!expectedTurnId || expectedTurnId.length > 256) return json(res, 400, { error: 'invalid_turn' });
      try {
        await sessionStore.assertActiveTurn(sessionId, expectedTurnId);
      } catch (error) {
        if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
        return json(res, 409, { error: 'active_turn_changed' });
      }
      if (!cosBridge || typeof cosBridge.stopSessionTurn !== 'function') {
        return json(res, 503, { error: 'stop_unavailable', message: 'The live Chat On Steroids adapter is not connected yet.' });
      }
      try {
        const result = await cosBridge.stopSessionTurn(sessionId, expectedTurnId);
        return json(res, 200, { ok: true, result: result ?? true, bootId });
      } catch (error) {
        if (/active_turn_changed/i.test(error?.message ?? '')) return json(res, 409, { error: 'active_turn_changed' });
        if (error?.code === 'COS_BRIDGE_UNAVAILABLE') return json(res, 503, { error: 'stop_unavailable', message: error.message });
        throw error;
      }
    }

    const messagesMatch = /^\/api\/sessions\/([0-9a-z-]{8,64})\/messages$/i.exec(url.pathname);
    if (messagesMatch && SESSION_ID.test(messagesMatch[1])) {
      const sessionId = messagesMatch[1];
      if (req.method === 'GET') {
        const afterSeq = Math.max(0, Number.parseInt(url.searchParams.get('afterSeq') ?? '0', 10) || 0);
        const waitMs = Math.max(0, Math.min(20_000, Number.parseInt(url.searchParams.get('waitMs') ?? '0', 10) || 0));
        try {
          if (waitMs > 0 && afterSeq > 0 && typeof sessionStore.waitForMessages === 'function') {
            const controller = new AbortController();
            const abort = () => {
              if (!res.writableEnded) controller.abort();
            };
            res.once('close', abort);
            try {
              const result = await sessionStore.waitForMessages(sessionId, { afterSeq, waitMs, signal: controller.signal });
              if (controller.signal.aborted || res.destroyed) return;
              return json(res, 200, { ...result, bootId, waited: true });
            } catch (error) {
              if (error?.code === 'ABORT_ERR') return;
              throw error;
            } finally {
              res.removeListener('close', abort);
            }
          }
          return json(res, 200, { ...(await sessionStore.messages(sessionId, { afterSeq })), bootId, waited: false });
        } catch (error) {
          if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
          throw error;
        }
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const id = typeof body.id === 'string' ? body.id : '';
        const text = typeof body.text === 'string' ? body.text : '';
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
        const model = body.model === null || body.model === undefined || body.model === ''
          ? null
          : typeof body.model === 'string' ? body.model.trim() : '__invalid__';
        const reasoningEffort = body.reasoningEffort === null || body.reasoningEffort === undefined || body.reasoningEffort === ''
          ? null
          : typeof body.reasoningEffort === 'string' ? body.reasoningEffort : '__invalid__';
        const mode = body.mode === undefined || body.mode === null || body.mode === ''
          ? 'auto'
          : typeof body.mode === 'string' ? body.mode : '__invalid__';
        const screen = body.screen === undefined ? false : typeof body.screen === 'boolean' ? body.screen : null;
        const validEfforts = new Set(['pro', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
        if (!UUID.test(id) || !text.trim() || text.length > 16_000 || conversationId.length < 8 || conversationId.length > 256
          || (model !== null && (!/^[a-zA-Z0-9 ._-]{1,80}$/.test(model)))
          || (reasoningEffort !== null && !validEfforts.has(reasoningEffort))
          || !['auto', 'after-turn'].includes(mode)
          || screen === null) {
          return json(res, 400, { error: 'invalid_outbound_message' });
        }
        try {
          await sessionStore.assertExactTarget(sessionId, conversationId);
        } catch (error) {
          if (error?.code === 'ENOENT') return json(res, 404, { error: 'session_not_found' });
          return json(res, 409, { error: 'target_mismatch', message: error.message });
        }
        try {
          if (!cosBridge || typeof cosBridge.sendInput !== 'function') {
            return json(res, 503, {
              error: 'send_unavailable',
              message: 'The direct Chat On Steroids adapter is not connected yet.'
            });
          }
          const prepared = await attachCurrentScreen(id, text, screen);
          const result = await cosBridge.sendInput({ id, sessionId, conversationId, text: prepared.text, mode, model, reasoningEffort });
          return json(res, 202, {
            result: result && typeof result === 'object' ? result : { id, status: 'accepted' },
            screenAttached: prepared.screenAttached,
            bootId
          });
        } catch (error) {
          if (error?.code === 'IDEMPOTENCY_CONFLICT') return json(res, 409, { error: 'idempotency_conflict' });
          if (error?.code === 'OUTBOUND_UNAVAILABLE' || error?.code === 'COS_BRIDGE_UNAVAILABLE') {
            return json(res, 503, {
              error: 'send_unavailable',
              message: error.message
            });
          }
          if (error?.code === 'SCREEN_UNAVAILABLE') {
            return json(res, 503, { error: 'screen_unavailable', message: cleanString(error?.message, 240) });
          }
          throw error;
        }
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      return json(res, 200, { device, bootId });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/me') {
      if (pushService?.removeSubscription) await pushService.removeSubscription(device.id).catch(() => undefined);
      await dataStore.revokeDevice(device.id);
      return json(res, 200, { ok: true, revoked: true, bootId });
    }

    return json(res, 404, { error: 'not_found' });
  }

  async function staticFile(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'method_not_allowed' });
    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: 'invalid_path' });
    }
    const relative = pathname.replace(/^\/+/, '');
    const file = path.resolve(publicDir, relative);
    if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) return json(res, 403, { error: 'forbidden' });
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return json(res, 404, { error: 'not_found' });
    }
    if (!stat.isFile()) return json(res, 404, { error: 'not_found' });
    const ext = path.extname(file).toLowerCase();
    // This is a private companion UI, not a CDN. Keeping JS/CSS for an hour can mix an
    // older cached app.js with a newer index.html (or vice versa), leaving buttons dead.
    // Freshness is more important than shaving a tiny local/tailnet transfer here.
    const cache = 'no-store';
    res.writeHead(200, headers({
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': cache
    }));
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) return api(req, res, url);
      return staticFile(req, res, url);
    })().catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, error?.status ?? 500, {
        error: error?.status ? error.message : 'internal_error',
        ...(options.exposeErrors ? { message: error?.message ?? String(error) } : {})
      });
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 35_000;

  return { server, sessionStore, dataStore, cosBridge, cosStateStore, pushService, bootId };
}

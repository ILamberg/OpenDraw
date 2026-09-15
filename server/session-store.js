import { createHash } from 'node:crypto';
import { promises as fs, watch as fsWatch } from 'node:fs';
import path from 'node:path';

const SESSION_ID = /^[0-9a-z-]{8,64}$/i;
const VISUAL_ID = /^visual-[0-9a-f]{24}$/;
const VISUAL_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const MAX_VISUAL_BYTES = 16 * 1024 * 1024;
const VISUAL_MIME_EXTENSIONS = new Map([
  ['image/png', new Set(['.png'])],
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/webp', new Set(['.webp'])]
]);

export function defaultSessionsDir(env = process.env) {
  if (env.COS_SESSIONS_DIR) return path.resolve(env.COS_SESSIONS_DIR);
  if (!env.APPDATA) throw new Error('APPDATA is not set and COS_SESSIONS_DIR was not provided');
  return path.join(env.APPDATA, 'chat-on-steroids', 'sessions');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalJson(file, fallback = null) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readJsonlAppend(file, { offset = 0, carry = Buffer.alloc(0) } = {}) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    let start = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    let pending = Buffer.isBuffer(carry) ? carry : Buffer.alloc(0);
    if (stat.size < start) {
      start = 0;
      pending = Buffer.alloc(0);
    }
    if (stat.size === start) return { lines: [], offset: start, carry: pending, stat };

    const lines = [];
    const chunkSize = 256 * 1024;
    let position = start;
    while (position < stat.size) {
      const length = Math.min(chunkSize, stat.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      while (true) {
        const newline = pending.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        const line = pending.subarray(lineStart, newline);
        if (line.length) lines.push(line.toString('utf8'));
        lineStart = newline + 1;
      }
      pending = lineStart ? pending.subarray(lineStart) : pending;
    }
    return { lines, offset: position, carry: pending, stat };
  } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], offset: 0, carry: Buffer.alloc(0), stat: null };
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function safeDisplayText(value, max = 180) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/[A-Za-z]:\\[^\s,;)]*/g, '[local path]')
    .replace(/\/(?:home|Users)\/[^\s,;)]*/g, '[local path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || null;
}

function toolCategory(tool, summaryKind) {
  const value = `${tool ?? ''} ${summaryKind ?? ''}`.toLowerCase();
  if (/web|browser|search|lookup|fetch|http/.test(value)) return 'web';
  if (/read|write|file|drive|document/.test(value)) return 'file';
  if (/exec|command|terminal|shell|python|code/.test(value)) return 'terminal';
  if (/image|vision|photo/.test(value)) return 'image';
  if (/calendar|schedule|automation|reminder/.test(value)) return 'calendar';
  if (/agent|worker/.test(value)) return 'agent';
  if (/plan/.test(value)) return 'plan';
  return 'activity';
}

function toolTitle(category) {
  return ({
    web: 'Web activity',
    file: 'File activity',
    terminal: 'Command execution',
    image: 'Image activity',
    calendar: 'Scheduling activity',
    agent: 'Agent activity',
    plan: 'Plan update',
    activity: 'Tool activity'
  })[category] || 'Tool activity';
}

function projectPlan(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plan)) return null;
  const steps = raw.plan.slice(0, 60).map((item, index) => {
    const status = ['pending', 'in_progress', 'completed', 'failed', 'skipped'].includes(item?.status)
      ? item.status
      : 'pending';
    return {
      id: `step-${index + 1}`,
      step: safeDisplayText(item?.step, 180) ?? `Step ${index + 1}`,
      status
    };
  });
  if (!steps.length) return null;
  return {
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    steps
  };
}

function projectToolEvent(sessionId, event) {
  if (!event || event.kind !== 'tool_call' || !event.call || typeof event.call !== 'object') return null;
  const call = event.call;
  const summary = call.summary && typeof call.summary === 'object' ? call.summary : null;
  const outcomeText = typeof call.outcome === 'string'
    ? call.outcome
    : typeof call.outcome?.kind === 'string' ? call.outcome.kind : '';
  const tone = safeDisplayText(summary?.tone, 20);
  const failed = tone === 'bad' || /fail|error|reject|cancel/i.test(outcomeText);
  const category = toolCategory(call.tool, summary?.kind);
  const seq = safeNumber(event.seq, 0);
  if (!seq) return null;
  return {
    id: `tool-${seq}`,
    seq,
    time: safeNumber(event.time, 0) || null,
    responseKey: responseHandle(sessionId, event.turnId),
    category,
    title: toolTitle(category),
    detail: null,
    metric: Number.isFinite(call.durationMs) ? `${Math.max(0, Math.round(call.durationMs))} ms` : null,
    durationMs: Number.isFinite(call.durationMs) ? Math.max(0, Math.round(call.durationMs)) : null,
    status: failed ? 'failed' : 'completed'
  };
}

function responseHandle(sessionId, turnId) {
  if (typeof turnId !== 'string' || !turnId) return null;
  return `response-${createHash('sha256')
    .update(`${sessionId}\0${turnId}`)
    .digest('hex')
    .slice(0, 20)}`;
}

function projectResponseLifecycle(sessionId, event) {
  if (!event || !['turn_start', 'turn_end'].includes(event.kind)) return null;
  const responseKey = responseHandle(sessionId, event.turnId);
  const seq = safeNumber(event.seq, 0);
  if (!responseKey || !seq) return null;
  const outcome = event.kind === 'turn_end' && typeof event.outcome === 'string'
    ? event.outcome.slice(0, 40)
    : null;
  return {
    responseKey,
    kind: event.kind,
    seq,
    time: safeNumber(event.time, 0) || null,
    outcome
  };
}

function visualHandle(sessionId, seq, index, assetId) {
  return `visual-${createHash('sha256')
    .update(`${sessionId}\0${seq}\0${index}\0${assetId}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function projectVisualAssets(sessionId, event) {
  if (!event || event.kind !== 'tool_call' || !event.call || typeof event.call !== 'object') return [];
  const seq = safeNumber(event.seq, 0);
  if (!seq || !Array.isArray(event.call.assets)) return [];
  const projected = [];
  for (let index = 0; index < event.call.assets.length && index < 24; index += 1) {
    const asset = event.call.assets[index];
    const assetId = typeof asset?.id === 'string' ? asset.id : '';
    const mimeType = typeof asset?.mimeType === 'string' ? asset.mimeType.toLowerCase() : '';
    const bytes = Number.isFinite(asset?.bytes) ? Math.max(0, Math.floor(asset.bytes)) : null;
    const allowedExtensions = VISUAL_MIME_EXTENSIONS.get(mimeType);
    const extension = path.extname(assetId).toLowerCase();
    if (!assetId || !VISUAL_ASSET_NAME.test(assetId) || assetId.includes('..')) continue;
    if (!allowedExtensions?.has(extension)) continue;
    if (bytes !== null && bytes > MAX_VISUAL_BYTES) continue;
    const id = visualHandle(sessionId, seq, index, assetId);
    projected.push({
      id,
      safe: {
        id,
        seq,
        time: safeNumber(event.time, 0) || null,
        responseKey: responseHandle(sessionId, event.turnId),
        kind: 'image',
        label: 'Visual proof',
        mimeType,
        bytes,
        status: 'ready'
      },
      ref: { id, seq, assetId, mimeType, bytes }
    });
  }
  return projected;
}

async function visualMagicMatches(file, mimeType) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const probe = Buffer.alloc(12);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    const bytes = probe.subarray(0, bytesRead);
    if (mimeType === 'image/png') {
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mimeType === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function projectWorkerSession(meta) {
  if (!meta || meta.origin?.kind !== 'worker') return null;
  const id = safeDisplayText(meta.origin?.agentId, 80);
  if (!id) return null;
  const outcome = typeof meta.lastTurnOutcome === 'string' ? meta.lastTurnOutcome : null;
  let status = meta.activeTurnId ? 'working' : 'idle';
  if (!meta.activeTurnId) {
    if (/fail|error/i.test(outcome || '')) status = 'failed';
    else if (/cancel|abort|stop/i.test(outcome || '')) status = 'cancelled';
    else if (outcome === 'completed' || Number.isFinite(meta.endedAt)) status = 'done';
  }
  return {
    id,
    status,
    startedAt: safeNumber(meta.startedAt, 0) || null,
    updatedAt: safeNumber(meta.updatedAt, 0) || null,
    outcome: outcome && ['completed', 'failed', 'cancelled'].includes(outcome) ? outcome : null
  };
}

function userVisibleText(row) {
  if (row?.source === 'internal' || row?.synthetic === true) return null;
  if (typeof row?.authoredText === 'string' && row.authoredText.trim()) return row.authoredText;
  if (typeof row?.message?.text !== 'string') return null;
  let text = row.message.text.replace(/\r\n?/g, '\n');
  const screenHeader = /^\[\[OPENDRAW_SCREEN_CONTEXT:(\d{1,6})\]\]\n/.exec(text);
  if (screenHeader) {
    const end = screenHeader[0].length + Number(screenHeader[1]);
    const boundary = '\n[[/OPENDRAW_SCREEN_CONTEXT]]\n\n';
    if (!text.startsWith(boundary, end)) return null;
    text = text.slice(end + boundary.length);
  }
  const continuation = /^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/.exec(text)?.[0] ?? '';
  const header = /^\[\[COS_CONTEXT:(\d{1,6})\]\]\n/.exec(text.slice(continuation.length));
  if (!header) return continuation ? null : text;
  const end = continuation.length + header[0].length + Number(header[1]);
  const boundary = '\n[[/COS_CONTEXT]]\n\n';
  if (!text.startsWith(boundary, end)) return null;
  const authored = `${continuation}${text.slice(end + boundary.length)}`;
  return authored.replace(/^\[\[CLF-(?:HANDOFF|RESUME):[A-Za-z0-9_-]{16,64}\]\]\n\n/, '') || null;
}

function inferProvider(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const value = model.trim();
  const lowered = value.toLowerCase();
  const providers = [
    [/^(gpt[-./]|chatgpt|o[1-9](?:[-./]|$))/, 'openai', 'OpenAI'],
    [/^claude(?:[-./]|$)/, 'anthropic', 'Anthropic'],
    [/^(?:models\/)?gemini(?:[-./]|$)/, 'google', 'Google'],
    [/^(grok|xai)(?:[-./]|$)/, 'xai', 'xAI'],
    [/^deepseek(?:[-./]|$)/, 'deepseek', 'DeepSeek'],
    [/^(mistral|codestral)(?:[-./]|$)/, 'mistral', 'Mistral AI'],
    [/^(qwen|alibaba)(?:[-./]|$)/, 'alibaba', 'Alibaba'],
    [/^(z-ai\/|glm(?:[-./]|$))/, 'z-ai', 'Z.ai']
  ];
  const found = providers.find(([pattern]) => pattern.test(lowered));
  return found ? { id: found[1], label: found[2], source: 'inferred' } : null;
}

export function isNormalSession(meta) {
  const kind = meta?.origin?.kind;
  return !kind || kind === 'desktop';
}

function projectSession(meta) {
  const selected = meta.selectedModel && typeof meta.selectedModel === 'object' ? meta.selectedModel : null;
  const model = selected && typeof selected.model === 'string' ? selected.model : null;
  const explicitProvider = selected?.provider && typeof selected.provider === 'string'
    ? { id: selected.provider, label: selected.provider, source: 'explicit' }
    : meta.provider && typeof meta.provider === 'string'
      ? { id: meta.provider, label: meta.provider, source: 'explicit' }
      : null;
  const endedAt = Number.isFinite(meta.endedAt) ? meta.endedAt : null;
  const activeTurnId = typeof meta.activeTurnId === 'string' ? meta.activeTurnId : null;
  const lastTurnOutcome = typeof meta.lastTurnOutcome === 'string' ? meta.lastTurnOutcome : null;
  return {
    id: meta.id,
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : 'Untitled session',
    conversationId: typeof meta.conversationId === 'string' ? meta.conversationId : null,
    startedAt: safeNumber(meta.startedAt),
    updatedAt: safeNumber(meta.updatedAt),
    endedAt,
    live: endedAt === null,
    activity: {
      state: endedAt !== null ? 'ended' : activeTurnId ? 'active' : 'idle',
      activeTurnId,
      activeResponseKey: responseHandle(meta.id, activeTurnId),
      lastTurnOutcome,
      lastToolCallAt: safeNumber(meta.lastToolCallAt, 0) || null,
      lastAssistantFinalAt: safeNumber(meta.lastAssistantFinalAt, 0) || null,
      lastTurnEndAt: safeNumber(meta.lastTurnEndAt, 0) || null,
      lastFinishReportAt: safeNumber(meta.lastFinishReportAt, 0) || null
    },
    selectedModel: selected
      ? {
          model,
          reasoningEffort: typeof selected.reasoningEffort === 'string' ? selected.reasoningEffort : null,
          observedAt: safeNumber(selected.observedAt, 0) || null,
          provider: explicitProvider ?? inferProvider(model)
        }
      : null,
    projectId: typeof meta.projectId === 'string' ? meta.projectId : null,
    usage: {
      estimatedTokens: safeNumber(meta.estimatedTokens, 0),
      contextTokens: safeNumber(meta.contextTokens, 0)
    },
    counters: {
      events: safeNumber(meta.events, 0),
      userMessages: safeNumber(meta.userMessages, 0),
      toolCalls: safeNumber(meta.toolCalls, 0),
      errors: safeNumber(meta.errors, 0),
      processExitNonzero: safeNumber(meta.processExitNonzero, 0),
      toolRejected: safeNumber(meta.toolRejected, 0),
      toolInternalErrors: safeNumber(meta.toolInternalErrors, 0)
    }
  };
}

export class SessionStore {
  constructor(sessionsDir = defaultSessionsDir()) {
    this.sessionsDir = path.resolve(sessionsDir);
    this.messageCache = new Map();
    this.messageFileCache = new Map();
    this.activityCache = new Map();
    this.metaCatalog = null;
    this.metaCatalogAt = 0;
  }

  sessionDir(id) {
    if (!SESSION_ID.test(id)) throw new Error('Invalid session id');
    return path.join(this.sessionsDir, id);
  }

  async readMeta(id) {
    const meta = await readJson(path.join(this.sessionDir(id), 'meta.json'));
    if (!meta || meta.id !== id) throw new Error('Session metadata does not match directory');
    return meta;
  }

  async sessionMetas({ maxAgeMs = 0 } = {}) {
    const now = Date.now();
    if (maxAgeMs > 0 && Array.isArray(this.metaCatalog) && now - this.metaCatalogAt <= maxAgeMs) {
      return this.metaCatalog;
    }
    let names;
    try {
      names = await fs.readdir(this.sessionsDir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const metas = (await Promise.all(names
      .filter((name) => SESSION_ID.test(name))
      .map(async (name) => {
        try { return await this.readMeta(name); } catch { return null; }
      })))
      .filter(Boolean);
    this.metaCatalog = metas;
    this.metaCatalogAt = now;
    return metas;
  }

  async relatedWorkers(sessionId) {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid session id');
    const metas = await this.sessionMetas({ maxAgeMs: 900 });
    return metas
      .filter((meta) => meta?.origin?.kind === 'worker' && meta.origin?.fromSessionId === sessionId)
      .map(projectWorkerSession)
      .filter(Boolean)
      .sort((a, b) => {
        const rank = (status) => status === 'working' ? 0 : status === 'idle' ? 1 : 2;
        return rank(a.status) - rank(b.status) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id);
      })
      .slice(0, 24);
  }

  async listNormalSessions() {
    const metas = await this.sessionMetas();

    const sessions = metas
      .filter((meta) => meta && isNormalSession(meta) && typeof meta.conversationId === 'string' && meta.conversationId.length >= 8)
      .map(projectSession)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || b.id.localeCompare(a.id));

    const active = sessions.find((session) => session.endedAt === null && session.activity?.activeTurnId)
      ?? sessions.find((session) => session.endedAt === null)
      ?? sessions[0]
      ?? null;

    return { sessions, currentSessionId: active?.id ?? null };
  }

  async statusSnapshot() {
    const listed = await this.listNormalSessions();
    const current = listed.sessions.find((session) => session.id === listed.currentSessionId) ?? null;
    const modelMap = new Map();
    const providerMap = new Map();
    for (const session of listed.sessions) {
      const model = session.selectedModel?.model;
      if (model) modelMap.set(model, (modelMap.get(model) ?? 0) + 1);
      const provider = session.selectedModel?.provider;
      if (provider?.id) {
        const held = providerMap.get(provider.id) ?? { id: provider.id, label: provider.label, sessions: 0, source: provider.source };
        held.sessions += 1;
        providerMap.set(provider.id, held);
      }
    }
    return {
      currentSessionId: listed.currentSessionId,
      currentSession: current,
      normalSessions: listed.sessions.length,
      liveSessions: listed.sessions.filter((session) => session.live).length,
      models: [...modelMap.entries()].map(([id, sessions]) => ({ id, sessions })).sort((a, b) => b.sessions - a.sessions || a.id.localeCompare(b.id)),
      providers: [...providerMap.values()].sort((a, b) => b.sessions - a.sessions || a.label.localeCompare(b.label))
    };
  }

  async assertExactTarget(sessionId, conversationId) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Target session is not a normal session');
    if (typeof conversationId !== 'string' || meta.conversationId !== conversationId) {
      throw new Error('conversationId does not match the durable session target');
    }
    return projectSession(meta);
  }

  async assertNormalSession(sessionId) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Target session is not a normal session');
    return projectSession(meta);
  }

  async assertActiveTurn(sessionId, expectedTurnId) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Target session is not a normal session');
    if (typeof expectedTurnId !== 'string' || !expectedTurnId || meta.activeTurnId !== expectedTurnId) {
      const error = new Error('active_turn_changed');
      error.code = 'ACTIVE_TURN_CHANGED';
      throw error;
    }
    return projectSession(meta);
  }

  async messages(sessionId, { afterSeq = 0 } = {}) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Session is not a normal session');
    const directory = path.join(this.sessionDir(sessionId), 'messages');
    let names = [];
    let directoryMtimeMs = 0;
    try {
      const [listed, stat] = await Promise.all([
        fs.readdir(directory),
        fs.stat(directory)
      ]);
      names = listed;
      directoryMtimeMs = Number.isFinite(stat?.mtimeMs) ? stat.mtimeMs : 0;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const cached = this.messageCache.get(sessionId);
    if (afterSeq === 0
      && !meta.activeTurnId
      && cached?.updatedAt === safeNumber(meta.updatedAt, 0)
      && cached?.directoryMtimeMs === directoryMtimeMs
      && cached?.fileCount === names.length) {
      return {
        session: projectSession(meta),
        messages: cached.messages,
        nextSeq: cached.nextSeq
      };
    }

    const messageNames = names.filter((name) => /^[a-f0-9]{64}\.json$/i.test(name));
    const nameSet = new Set(messageNames);
    let fileCache = this.messageFileCache.get(sessionId);
    const appendCompatible = fileCache
      && fileCache.names.size <= nameSet.size
      && [...fileCache.names].every((name) => nameSet.has(name));
    if (!appendCompatible) fileCache = { names: new Set(), rows: new Map() };
    const unreadNames = messageNames.filter((name) => !fileCache.rows.has(name));
    if (unreadNames.length) {
      const loaded = await Promise.all(unreadNames.map(async (name) => {
        try { return [name, await readJson(path.join(directory, name))]; }
        catch { return [name, null]; }
      }));
      for (const [name, row] of loaded) {
        if (row) fileCache.rows.set(name, row);
      }
    }
    fileCache.names = nameSet;
    this.messageFileCache.set(sessionId, fileCache);
    // COS message files are content-addressed by hash, so existing files are immutable.
    // During live long-polling only newly appeared files need to be read and parsed.
    const rows = messageNames.map((name) => fileCache.rows.get(name) ?? null);

    const byMessageId = new Map();
    for (const row of rows) {
      if (!row || !['user_message', 'assistant_message'].includes(row.kind)) continue;
      const rawText = row.kind === 'user_message' ? userVisibleText(row) : row.message?.text;
      if (typeof rawText !== 'string') continue;
      const text = rawText;
      const seq = safeNumber(row.seq, 0);
      if (seq <= afterSeq) continue;
      const rawOrder = Number(row.origin);
      const order = Number.isFinite(rawOrder) && rawOrder > 0 ? rawOrder : seq;
      const messageId = typeof row.messageId === 'string' && row.messageId ? row.messageId : `seq:${seq}:${row.kind}`;
      const projected = {
        id: messageId,
        seq,
        order,
        time: safeNumber(row.time),
        role: row.kind === 'user_message' ? 'user' : 'assistant',
        responseKey: row.kind === 'assistant_message' ? responseHandle(sessionId, row.turnId) : null,
        text,
        state: row.kind === 'assistant_message' && typeof row.state === 'string' ? row.state : 'final',
        final: row.kind === 'user_message' ? true : row.final === true || row.state === 'final'
      };
      const held = byMessageId.get(messageId);
      if (!held || projected.seq > held.seq || projected.time > held.time) byMessageId.set(messageId, projected);
    }

    const messages = [...byMessageId.values()].sort((a, b) => a.order - b.order || a.seq - b.seq || a.time - b.time || a.id.localeCompare(b.id));
    const result = {
      session: projectSession(meta),
      messages,
      nextSeq: messages.reduce((max, message) => Math.max(max, message.seq), afterSeq)
    };
    if (afterSeq === 0 && !meta.activeTurnId) {
      this.messageCache.set(sessionId, {
        updatedAt: safeNumber(meta.updatedAt, 0),
        directoryMtimeMs,
        fileCount: names.length,
        messages: result.messages,
        nextSeq: result.nextSeq
      });
    }
    return result;
  }

  async waitForMessages(sessionId, { afterSeq = 0, waitMs = 15_000, signal = null } = {}) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Session is not a normal session');
    const directory = path.join(this.sessionDir(sessionId), 'messages');
    const boundedWait = Math.max(0, Math.min(20_000, Number.isFinite(waitMs) ? waitMs : 15_000));
    if (!boundedWait) return this.messages(sessionId, { afterSeq });

    let watcher = null;
    try {
      watcher = fsWatch(directory, { persistent: false });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return this.messages(sessionId, { afterSeq });
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let checking = false;
      let timeoutExpired = false;
      let debounce = null;
      const cleanup = () => {
        if (debounce) clearTimeout(debounce);
        clearTimeout(timeout);
        clearInterval(heartbeat);
        signal?.removeEventListener?.('abort', onAbort);
        try { watcher?.close(); } catch { /* already closed */ }
      };
      const finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const check = async ({ allowEmpty = false } = {}) => {
        if (settled) return;
        if (checking) {
          if (allowEmpty) timeoutExpired = true;
          return;
        }
        checking = true;
        const mayFinishEmpty = allowEmpty || timeoutExpired;
        try {
          const result = await this.messages(sessionId, { afterSeq });
          if (result.messages.length || mayFinishEmpty) finish(result);
        } catch (error) {
          finish(null, error);
        } finally {
          checking = false;
          if (!settled && timeoutExpired && !mayFinishEmpty) void check({ allowEmpty: true });
        }
      };
      const scheduleCheck = () => {
        if (settled) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => { void check(); }, 28);
      };
      const onAbort = () => {
        const error = new Error('message_wait_aborted');
        error.code = 'ABORT_ERR';
        finish(null, error);
      };
      watcher.on('change', scheduleCheck);
      watcher.on('error', scheduleCheck);
      const timeout = setTimeout(() => {
        timeoutExpired = true;
        void check({ allowEmpty: true });
      }, boundedWait);
      // fs.watch is the fast path. A sparse heartbeat only protects against a missed
      // filesystem notification; it must not turn long-polling back into a 1 Hz history scan.
      const heartbeat = setInterval(() => { void check(); }, Math.min(4500, Math.max(1500, Math.floor(boundedWait / 3))));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) return onAbort();
      void check();
    });
  }

  async activity(sessionId, { limit = 5000, afterSeq = 0, revision = null } = {}) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Session is not a normal session');
    const boundedLimit = Math.max(1, Math.min(5000, Number.isFinite(limit) ? Math.floor(limit) : 5000));
    const requestedAfterSeq = Math.max(0, Number.isFinite(afterSeq) ? Math.floor(afterSeq) : 0);
    let cached = this.activityCache.get(sessionId) ?? null;
    const priorEventOffset = cached?.eventOffset ?? 0;
    const requestedRevision = Number.isFinite(revision) ? Math.max(0, Math.floor(revision)) : null;
    const directory = this.sessionDir(sessionId);
    const [planRaw, appended, agents] = await Promise.all([
      readOptionalJson(path.join(directory, 'plan.json'), null),
      readJsonlAppend(path.join(directory, 'events.jsonl'), {
        offset: cached?.eventOffset ?? 0,
        carry: cached?.eventCarry ?? Buffer.alloc(0)
      }),
      this.relatedWorkers(sessionId)
    ]);
    const reset = Boolean(cached && appended.offset < (cached.eventOffset ?? 0));
    // `afterSeq` alone is not a reliable delta cursor: a newly appended event may
    // legitimately carry an older/lower durable seq. The append revision lets a
    // client prove which events.jsonl byte offset it has acknowledged. If a prior
    // response was lost (or this server restarted), fall back to a full projected
    // snapshot so no lower-seq tool can disappear forever.
    const resync = reset || (requestedRevision !== null && requestedRevision !== priorEventOffset);
    if (!cached || reset) cached = { tools: [], visuals: [], visualRefs: new Map(), responses: [], eventOffset: 0, eventCarry: Buffer.alloc(0) };
    const bySeq = new Map((cached.tools || []).map((tool) => [tool.seq, tool]));
    const visualsById = new Map((cached.visuals || []).map((visual) => [visual.id, visual]));
    const visualRefs = cached.visualRefs instanceof Map ? new Map(cached.visualRefs) : new Map();
    const responsesByKey = new Map((cached.responses || []).map((response) => [response.responseKey, { ...response }]));
    const appendedToolSeqs = new Set();
    const appendedVisualIds = new Set();
    for (const line of appended.lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const projected = projectToolEvent(sessionId, event);
      if (projected) {
        bySeq.set(projected.seq, projected);
        appendedToolSeqs.add(projected.seq);
      }
      const lifecycle = projectResponseLifecycle(sessionId, event);
      if (lifecycle) {
        const held = responsesByKey.get(lifecycle.responseKey) || {
          responseKey: lifecycle.responseKey,
          startedSeq: null,
          startedAt: null,
          endedSeq: null,
          endedAt: null,
          outcome: null
        };
        if (lifecycle.kind === 'turn_start') {
          held.startedSeq = lifecycle.seq;
          held.startedAt = lifecycle.time;
        } else {
          held.endedSeq = lifecycle.seq;
          held.endedAt = lifecycle.time;
          held.outcome = lifecycle.outcome;
        }
        responsesByKey.set(lifecycle.responseKey, held);
      }
      if (event?.kind === 'tool_call' && safeNumber(event.seq, 0)) {
        const seq = safeNumber(event.seq, 0);
        for (const [id, ref] of visualRefs) {
          if (ref.seq === seq) {
            visualRefs.delete(id);
            visualsById.delete(id);
          }
        }
        for (const visual of projectVisualAssets(sessionId, event)) {
          visualsById.set(visual.id, visual.safe);
          visualRefs.set(visual.id, visual.ref);
          appendedVisualIds.add(visual.id);
        }
      }
    }
    const tools = [...bySeq.values()].sort((a, b) => a.seq - b.seq || (a.time ?? 0) - (b.time ?? 0));
    const visuals = [...visualsById.values()].sort((a, b) => a.seq - b.seq || (a.time ?? 0) - (b.time ?? 0) || a.id.localeCompare(b.id));
    const responses = [...responsesByKey.values()]
      .sort((a, b) => (a.startedSeq ?? a.endedSeq ?? 0) - (b.startedSeq ?? b.endedSeq ?? 0) || a.responseKey.localeCompare(b.responseKey));
    const plan = projectPlan(planRaw);
    this.activityCache.set(sessionId, {
      eventOffset: appended.offset,
      eventCarry: appended.carry,
      eventMtimeMs: appended.stat?.mtimeMs ?? null,
      plan,
      tools,
      visuals,
      visualRefs,
      responses
    });
    // A newly appended event can carry an older durable seq. Include rows that were
    // observed in this append even when their seq is below the client's seq cursor,
    // otherwise ownership corrections/tools can be cached server-side but never reach
    // the phone.
    const filtered = requestedAfterSeq > 0 && !resync
      ? tools.filter((tool) => tool.seq > requestedAfterSeq || appendedToolSeqs.has(tool.seq))
      : tools;
    const filteredVisuals = requestedAfterSeq > 0 && !resync
      ? visuals.filter((visual) => visual.seq > requestedAfterSeq || appendedVisualIds.has(visual.id))
      : visuals;
    const selected = filtered.slice(0, boundedLimit);
    const result = {
      session: projectSession(meta),
      plan,
      tools: selected,
      visuals: filteredVisuals.slice(0, boundedLimit),
      responses,
      agents,
      revision: appended.offset,
      resync,
      nextToolSeq: selected.reduce((max, tool) => Math.max(max, tool.seq), requestedAfterSeq),
      hasMore: filtered.length > boundedLimit
    };
    return result;
  }

  async visual(sessionId, visualId) {
    const meta = await this.readMeta(sessionId);
    if (!isNormalSession(meta)) throw new Error('Session is not a normal session');
    if (!VISUAL_ID.test(visualId)) {
      const error = new Error('Visual not found');
      error.code = 'VISUAL_NOT_FOUND';
      throw error;
    }
    await this.activity(sessionId, { limit: 1 });
    const ref = this.activityCache.get(sessionId)?.visualRefs?.get(visualId);
    if (!ref) {
      const error = new Error('Visual not found');
      error.code = 'VISUAL_NOT_FOUND';
      throw error;
    }
    const allowedExtensions = VISUAL_MIME_EXTENSIONS.get(ref.mimeType);
    const extension = path.extname(ref.assetId).toLowerCase();
    if (!VISUAL_ASSET_NAME.test(ref.assetId) || ref.assetId.includes('..') || !allowedExtensions?.has(extension)) {
      const error = new Error('Visual not found');
      error.code = 'VISUAL_NOT_FOUND';
      throw error;
    }
    const file = path.join(this.sessionDir(sessionId), 'assets', ref.assetId);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (error?.code === 'ENOENT') error.code = 'VISUAL_NOT_FOUND';
      throw error;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_VISUAL_BYTES || (Number.isFinite(ref.bytes) && ref.bytes !== stat.size)) {
      const error = new Error('Visual not found');
      error.code = 'VISUAL_NOT_FOUND';
      throw error;
    }
    if (!await visualMagicMatches(file, ref.mimeType)) {
      const error = new Error('Visual not found');
      error.code = 'VISUAL_NOT_FOUND';
      throw error;
    }
    return { file, mimeType: ref.mimeType, bytes: stat.size };
  }
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READ_TIMEOUT_MS = 8_000;
const SEND_TIMEOUT_MS = 90_000;
const START_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 15_000;
const LEDGER_MAX_ENTRIES = 1_000;
const LEDGER_TTL_MS = 30 * 24 * 60 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEDGER_PATH = path.resolve(HERE, '..', '.data', 'cos-send-ledger.json');

const ALLOWED_METHODS = new Set([
  'getState', 'getUsage', 'listSessions', 'listProjects', 'getSession',
  'getChatModels', 'getSessionControls', 'getSwarm', 'listInputs', 'sendInput', 'stopSessionTurn',
  'setSessionAutomation', 'setSessionObjective', 'compactSession',
  'cancelSessionCompaction', 'cancelInput'
]);

function coded(message, code, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function compactError(error) {
  return String(error?.message ?? error ?? 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, 260);
}

function rendererSessionStale(error) {
  return /no session with given id|session.*(?:closed|not found|does not exist)|target.*(?:closed|not found)|cannot find context|execution context was destroyed/i
    .test(String(error?.message ?? error ?? ''));
}

function executableCandidates(env = process.env) {
  return [
    env.OPENDRAW_COS_EXE,
    'D:\\Program Files\\Chat On Steroids\\Chat On Steroids.exe',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Chat On Steroids', 'Chat On Steroids.exe') : null,
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Chat On Steroids', 'Chat On Steroids.exe') : null
  ].filter(Boolean);
}

export function findCosExecutable(env = process.env) {
  return executableCandidates(env).find((candidate) => fs.existsSync(candidate)) ?? null;
}

export class CosPipeBridge {
  constructor(options = {}) {
    this.exePath = options.exePath ?? findCosExecutable(options.env);
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.now = options.now ?? (() => Date.now());
    this.readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ledgerPath = options.ledgerPath === undefined ? null : options.ledgerPath;
    this.ledgerLoaded = false;
    this.ledgerLoading = null;
    this.ledgerWriting = Promise.resolve();
    this.closed = false;
    this.child = null;
    this.pipeWrite = null;
    this.pipeRead = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 0;
    this.rendererSessionId = null;
    this.rendererTargetId = null;
    this.transportGeneration = 0;
    this.starting = null;
    this.nextStartAt = 0;
    this.sentInputs = new Map();
    this.last = {
      kind: 'cos-pipe', available: false, state: 'checking', label: 'Chat On Steroids',
      detail: 'Checking the private Chat On Steroids companion pipe.'
    };
  }

  status() { return { ...this.last }; }

  async refresh() {
    try {
      await this.#ensureRenderer();
      this.#ready();
    } catch (error) {
      this.#offline(error);
    }
    return this.status();
  }

  async invoke(method, args = [], { timeoutMs = this.readTimeoutMs } = {}) {
    if (!ALLOWED_METHODS.has(method)) throw new Error('That Chat On Steroids operation is not exposed to OpenDraw');
    if (!Array.isArray(args)) throw new Error('COS method arguments must be an array');
    await this.#ensureRenderer();
    const expression = `(() => { const api = globalThis.api; if (!api || typeof api[${JSON.stringify(method)}] !== 'function') throw new Error('COS method unavailable'); return api[${JSON.stringify(method)}](...${JSON.stringify(args)}); })()`;
    try {
      const value = await this.#evaluateWithRecovery(expression, timeoutMs);
      this.#ready();
      return value;
    } catch (error) {
      if (error?.code === 'COS_TIMEOUT') throw error;
      this.#offline(error);
      throw coded(compactError(error), 'COS_BRIDGE_UNAVAILABLE', error);
    }
  }

  async getState() { return this.invoke('getState'); }
  async getUsage() { return this.invoke('getUsage'); }
  async getModels() { return this.invoke('getChatModels'); }
  async listProjects() { return this.invoke('listProjects'); }
  async listInputs() { return this.invoke('listInputs'); }
  async listSessions(options = {}) { return this.invoke('listSessions', [options]); }
  async getSession(sessionId, options = {}) { return this.invoke('getSession', [sessionId, options]); }
  async getSessionControls(sessionId) { return this.invoke('getSessionControls', [sessionId]); }
  async getSwarm() { return this.invoke('getSwarm'); }
  async stopSessionTurn(sessionId, expectedTurnId) { return this.invoke('stopSessionTurn', [sessionId, expectedTurnId]); }
  async setSessionAutomation(sessionId, automation) {
    return this.invoke('setSessionAutomation', [sessionId, automation]);
  }
  async setSessionObjective(sessionId, text, mode) {
    return this.invoke('setSessionObjective', [sessionId, text, mode]);
  }
  async compactSession(sessionId) {
    return this.invoke('compactSession', [sessionId], { timeoutMs: 30_000 });
  }
  async cancelSessionCompaction(sessionId) {
    return this.invoke('cancelSessionCompaction', [sessionId], { timeoutMs: 15_000 });
  }
  async cancelInput(inputId) { return this.invoke('cancelInput', [inputId]); }

  async snapshot(sessionId = null) {
    await this.#ensureRenderer();
    const expression = `(() => { const api = globalThis.api; if (!api) throw new Error('COS API unavailable'); return Promise.all([api.getState(), api.getChatModels(), api.listInputs(), api.listSessions({ limit: 60 }), ${sessionId ? `api.getSession(${JSON.stringify(sessionId)}, { limit: 1 })` : 'Promise.resolve(null)'}]).then(([state, models, inputs, sessions, currentSession]) => ({ state, models, inputs, sessions, currentSession })); })()`;
    try {
      const value = await this.#evaluateWithRecovery(expression, this.readTimeoutMs);
      this.#ready();
      return value;
    } catch (error) {
      this.#offline(error);
      throw coded(compactError(error), 'COS_BRIDGE_UNAVAILABLE', error);
    }
  }

  async sendInput(raw) {
    await this.#loadLedger();
    const mode = raw.mode === 'after-turn' || raw.mode === 'finish' ? raw.mode : 'auto';
    const fingerprint = JSON.stringify({
      sessionId: raw.sessionId,
      projectId: raw.projectId ?? null,
      text: raw.text,
      model: raw.model ?? null,
      reasoningEffort: raw.reasoningEffort ?? null,
      mode
    });
    const remembered = this.sentInputs.get(raw.id);
    if (remembered && remembered.fingerprint !== fingerprint) {
      throw coded('Message id already belongs to different input', 'IDEMPOTENCY_CONFLICT');
    }

    const existing = await this.#findInput(raw.id);
    if (existing) {
      this.#assertSame(existing, fingerprint);
      const receipt = this.#projectInput(existing, true);
      await this.#rememberInput(raw.id, { fingerprint, dueAt: existing.dueAt ?? remembered?.dueAt ?? this.now(), receipt });
      return receipt;
    }
    if (remembered) {
      if (remembered.receipt) return { ...remembered.receipt, idempotent: true };
      throw coded('This message id was already attempted and is no longer present in the COS outbox. OpenDraw will not resend it automatically.', 'COS_BRIDGE_UNAVAILABLE');
    }

    await this.#ensureRenderer();
    const dueAt = this.now();
    await this.#rememberInput(raw.id, { fingerprint, dueAt, receipt: null });
    const input = {
      id: raw.id,
      sessionId: raw.sessionId,
      projectId: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null,
      text: raw.text,
      mode,
      dueAt,
      model: typeof raw.model === 'string' && raw.model ? raw.model : null,
      reasoningEffort: typeof raw.reasoningEffort === 'string' && raw.reasoningEffort ? raw.reasoningEffort : null
    };

    try {
      const result = await this.invoke('sendInput', [input], { timeoutMs: this.sendTimeoutMs });
      const receipt = this.#projectInput(result, false);
      await this.#rememberInput(raw.id, { fingerprint, dueAt, receipt });
      return receipt;
    } catch (error) {
      if (/already belongs to different input/i.test(error?.message ?? '')) error.code = 'IDEMPOTENCY_CONFLICT';
      if (error?.code === 'COS_TIMEOUT') {
        const reconciled = await this.#findInput(raw.id).catch(() => null);
        if (reconciled) {
          this.#assertSame(reconciled, fingerprint);
          const receipt = this.#projectInput(reconciled, true);
          await this.#rememberInput(raw.id, { fingerprint, dueAt, receipt });
          return receipt;
        }
        throw coded('Chat On Steroids is still preparing this send; retry with the same message id.', 'COS_BRIDGE_UNAVAILABLE', error);
      }
      throw error;
    }
  }

  async close({ closeCos = true, timeoutMs = 5_000 } = {}) {
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.#disposeTransport(new Error('OpenDraw companion closed'));
      return;
    }
    const exited = child.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    if (closeCos && child.exitCode === null && this.pipeWrite?.writable) {
      void this.#command('Browser.close', {}, null, Math.min(2_000, timeoutMs)).catch(() => undefined);
      await Promise.race([exited, this.sleepImpl(timeoutMs)]);
    }
    this.#disposeTransport(new Error('OpenDraw companion closed'));
  }

  async #loadLedger() {
    if (this.ledgerLoaded) return;
    if (this.ledgerLoading) return this.ledgerLoading;
    this.ledgerLoading = (async () => {
      if (!this.ledgerPath) {
        this.ledgerLoaded = true;
        return;
      }
      try {
        const parsed = JSON.parse(await fs.promises.readFile(this.ledgerPath, 'utf8'));
        const cutoff = this.now() - LEDGER_TTL_MS;
        for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) {
          if (typeof row?.id !== 'string' || typeof row?.fingerprint !== 'string') continue;
          if (Number.isFinite(row.updatedAt) && row.updatedAt < cutoff) continue;
          let fingerprint = row.fingerprint;
          try {
            const decoded = JSON.parse(fingerprint);
            if (decoded && typeof decoded === 'object' && !Object.hasOwn(decoded, 'projectId')) {
              fingerprint = JSON.stringify({
                sessionId: decoded.sessionId ?? null,
                projectId: null,
                text: decoded.text,
                model: decoded.model ?? null,
                reasoningEffort: decoded.reasoningEffort ?? null,
                mode: decoded.mode ?? 'auto'
              });
            }
          } catch { /* preserve malformed legacy fingerprint; normal conflict handling remains conservative */ }
          this.sentInputs.set(row.id, {
            fingerprint,
            dueAt: Number.isFinite(row.dueAt) ? row.dueAt : this.now(),
            receipt: row.receipt && typeof row.receipt === 'object' ? row.receipt : null,
            updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : this.now()
          });
        }
        this.#pruneLedger();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw coded(`Could not read OpenDraw send ledger: ${compactError(error)}`, 'COS_BRIDGE_UNAVAILABLE', error);
      }
      this.ledgerLoaded = true;
    })().finally(() => { this.ledgerLoading = null; });
    return this.ledgerLoading;
  }

  async #rememberInput(id, value) {
    this.sentInputs.set(id, { ...value, updatedAt: this.now() });
    this.#pruneLedger();
    if (!this.ledgerPath) return;
    const write = async () => {
      await fs.promises.mkdir(path.dirname(this.ledgerPath), { recursive: true });
      const entries = [...this.sentInputs.entries()].map(([entryId, row]) => ({ id: entryId, ...row }));
      const body = `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;
      const temp = `${this.ledgerPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temp, this.ledgerPath);
    };
    this.ledgerWriting = this.ledgerWriting.then(write, write);
    try {
      await this.ledgerWriting;
    } catch (error) {
      throw coded(`Could not persist OpenDraw send ledger: ${compactError(error)}`, 'COS_BRIDGE_UNAVAILABLE', error);
    }
  }

  #pruneLedger() {
    const cutoff = this.now() - LEDGER_TTL_MS;
    for (const [id, row] of this.sentInputs) {
      if (Number.isFinite(row.updatedAt) && row.updatedAt < cutoff) this.sentInputs.delete(id);
    }
    if (this.sentInputs.size <= LEDGER_MAX_ENTRIES) return;
    const ordered = [...this.sentInputs.entries()].sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0));
    for (const [id] of ordered.slice(0, this.sentInputs.size - LEDGER_MAX_ENTRIES)) this.sentInputs.delete(id);
  }

  async #findInput(id) {
    const rows = await this.listInputs();
    return Array.isArray(rows) ? rows.find((row) => row?.id === id) ?? null : null;
  }

  #assertSame(row, expectedFingerprint) {
    const prior = JSON.stringify({
      sessionId: row.sessionId,
      projectId: row.projectId ?? null,
      text: row.text,
      model: row.model ?? null,
      reasoningEffort: row.reasoningEffort ?? null,
      mode: row.requestedMode ?? row.mode ?? 'auto'
    });
    if (prior !== expectedFingerprint) throw coded('Message id already belongs to different input', 'IDEMPOTENCY_CONFLICT');
  }

  #projectInput(row, idempotent) {
    return {
      id: row?.id ?? null,
      status: typeof row?.state === 'string' ? row.state : 'accepted',
      state: typeof row?.state === 'string' ? row.state : null,
      sessionId: typeof row?.sessionId === 'string' ? row.sessionId : null,
      deliveredSessionId: typeof row?.deliveredSessionId === 'string' ? row.deliveredSessionId : null,
      conversationId: typeof row?.conversationId === 'string' ? row.conversationId : null,
      transportIntent: typeof row?.transportIntent === 'string' ? row.transportIntent : null,
      deliveredAt: Number.isFinite(row?.deliveredAt) ? row.deliveredAt : null,
      error: typeof row?.error === 'string' ? row.error : null,
      idempotent
    };
  }

  async #ensureRenderer() {
    if (this.closed) throw coded('OpenDraw has closed the Chat On Steroids companion pipe.', 'COS_BRIDGE_UNAVAILABLE');
    if (this.#transportUsable() && this.rendererSessionId) return;
    if (this.starting) return this.starting;
    if (this.#transportUsable()) {
      this.starting = this.#discoverRenderer(this.startTimeoutMs).finally(() => { this.starting = null; });
      return this.starting;
    }
    if (this.now() < this.nextStartAt) {
      throw coded('Chat On Steroids is already open outside OpenDraw. Fully quit it once; OpenDraw will launch it privately on the next retry.', 'COS_BRIDGE_UNAVAILABLE');
    }
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    if (!this.exePath) throw coded('Chat On Steroids executable was not found.', 'COS_BRIDGE_UNAVAILABLE');
    this.#disposeTransport();
    this.nextStartAt = this.now() + this.retryBackoffMs;
    const generation = ++this.transportGeneration;
    const child = this.spawnImpl(this.exePath, ['--remote-debugging-pipe'], {
      windowsHide: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']
    });
    this.child = child;
    this.pipeWrite = child.stdio?.[3] ?? null;
    this.pipeRead = child.stdio?.[4] ?? null;
    if (!this.pipeWrite || !this.pipeRead) {
      this.#disposeTransport();
      throw coded('Could not create the private COS debugging pipes.', 'COS_BRIDGE_UNAVAILABLE');
    }
    this.pipeRead.on('data', (chunk) => this.#receive(chunk));
    this.pipeRead.on('error', (error) => this.#transportFailed(error, generation));
    this.pipeWrite.on('error', (error) => this.#transportFailed(error, generation));
    child.once('exit', () => this.#transportFailed(new Error('Chat On Steroids companion process exited'), generation));
    child.once('error', (error) => this.#transportFailed(error, generation));

    try {
      await this.#discoverRenderer(this.startTimeoutMs);
      return;
    } catch (error) {
      if (child.exitCode !== null || !this.#transportUsable()) {
        this.#disposeTransport(error);
        throw coded('Chat On Steroids is already running outside OpenDraw. Fully quit it once, then OpenDraw can own the private companion pipe.', 'COS_BRIDGE_UNAVAILABLE', error);
      }
      throw error;
    }
  }

  async #discoverRenderer(timeoutMs) {
    const deadline = this.now() + timeoutMs;
    let lastError = null;
    while (this.now() < deadline) {
      if (!this.#transportUsable()) break;
      try {
        const response = await this.#command('Target.getTargets', {}, null, 1_500);
        const pages = (response?.targetInfos ?? []).filter((target) => target?.type === 'page');
        for (const page of pages) {
          const attached = await this.#command('Target.attachToTarget', { targetId: page.targetId, flatten: true }, null, 1_500);
          const sessionId = attached?.sessionId;
          if (!sessionId) continue;
          try {
            const probe = await this.#command('Runtime.evaluate', {
              expression: 'Boolean(globalThis.api && typeof globalThis.api.sendInput === "function" && typeof globalThis.api.listSessions === "function")',
              returnByValue: true,
              silent: true
            }, sessionId, 1_500);
            if (probe?.result?.value === true) {
              this.rendererSessionId = sessionId;
              this.rendererTargetId = page.targetId;
              this.nextStartAt = 0;
              this.#ready();
              return;
            }
          } catch (error) { lastError = error; }
          await this.#command('Target.detachFromTarget', { sessionId }, null, 1_500).catch(() => undefined);
        }
      } catch (error) { lastError = error; }
      await this.sleepImpl(250);
    }
    throw coded(
      !this.#transportUsable()
        ? 'Chat On Steroids is already running outside OpenDraw. Fully quit it once, then OpenDraw can own the private companion pipe.'
        : `Chat On Steroids has not exposed its renderer API yet${lastError ? `: ${compactError(lastError)}` : '.'} OpenDraw will retry on the same private pipe.`,
      'COS_BRIDGE_UNAVAILABLE'
    );
  }

  #transportUsable() {
    return Boolean(this.child && this.child.exitCode === null && this.pipeWrite?.writable && this.pipeRead?.readable);
  }

  #clearRenderer() {
    this.rendererSessionId = null;
    this.rendererTargetId = null;
  }

  async #evaluateWithRecovery(expression, timeoutMs) {
    try {
      return await this.#evaluate(expression, timeoutMs);
    } catch (error) {
      if (!rendererSessionStale(error) || !this.#transportUsable()) throw error;
      this.#clearRenderer();
      await this.#ensureRenderer();
      return this.#evaluate(expression, timeoutMs);
    }
  }

  async #evaluate(expression, timeoutMs) {
    const response = await this.#command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      silent: true
    }, this.rendererSessionId, timeoutMs);
    if (response?.exceptionDetails) {
      const message = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Chat On Steroids rejected the request';
      throw new Error(message);
    }
    const remote = response?.result;
    if (remote?.subtype === 'error') throw new Error(remote.description ?? 'Chat On Steroids returned an error');
    return remote?.value;
  }

  #command(method, params = {}, sessionId = null, timeoutMs = this.readTimeoutMs) {
    if (!this.pipeWrite?.writable) return Promise.reject(coded('COS companion pipe is closed.', 'COS_BRIDGE_UNAVAILABLE'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(coded(`Timed out waiting for Chat On Steroids (${method})`, 'COS_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      const packet = { id, method, params };
      if (sessionId) packet.sessionId = sessionId;
      this.pipeWrite.write(`${JSON.stringify(packet)}\0`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(coded(compactError(error), 'COS_BRIDGE_UNAVAILABLE', error));
      });
    });
  }

  #receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    let index;
    while ((index = this.buffer.indexOf(0)) !== -1) {
      const raw = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 1);
      if (!raw) continue;
      let packet;
      try { packet = JSON.parse(raw); } catch { continue; }
      if (packet?.method === 'Target.detachedFromTarget' && packet.params?.sessionId === this.rendererSessionId) {
        this.#clearRenderer();
        continue;
      }
      if (packet?.method === 'Target.targetDestroyed' && packet.params?.targetId === this.rendererTargetId) {
        this.#clearRenderer();
        continue;
      }
      if (!Number.isInteger(packet?.id)) continue;
      const pending = this.pending.get(packet.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(packet.id);
      if (packet.error) pending.reject(new Error(packet.error.message ?? 'COS protocol error'));
      else pending.resolve(packet.result);
    }
  }

  #transportFailed(error, generation = this.transportGeneration) {
    if (generation !== this.transportGeneration) return;
    if (!this.child && !this.pipeWrite && !this.pipeRead) return;
    this.#offline(error);
    this.#disposeTransport(error);
  }

  #disposeTransport(reason = null) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(coded(compactError(reason ?? 'COS companion pipe closed'), 'COS_BRIDGE_UNAVAILABLE'));
    }
    this.pending.clear();
    this.#clearRenderer();
    this.buffer = Buffer.alloc(0);
    try { this.pipeWrite?.destroy(); } catch {}
    try { this.pipeRead?.destroy(); } catch {}
    this.pipeWrite = null;
    this.pipeRead = null;
    this.child = null;
  }

  #ready() {
    this.last = {
      kind: 'cos-pipe', available: true, state: 'ready', label: 'Chat On Steroids',
      detail: 'Private process-owned COS companion pipe is ready.'
    };
  }

  #offline(error) {
    this.last = {
      kind: 'cos-pipe', available: false, state: 'needs-restart', label: 'Chat On Steroids',
      detail: 'Fully quit Chat On Steroids once; OpenDraw will launch it privately for phone sending.',
      error: compactError(error)
    };
  }
}

export function createCosPipeBridgeFromEnv(env = process.env, options = {}) {
  return new CosPipeBridge({
    env,
    exePath: findCosExecutable(env),
    ...options,
    ledgerPath: options.ledgerPath ?? DEFAULT_LEDGER_PATH
  });
}

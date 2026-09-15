import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { answerReadyPayload } from './push-service.js';
import { isNormalSession } from './session-store.js';

function sessionIdFromWatchName(filename) {
  if (!filename) return null;
  const parts = String(filename).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2 || parts.at(-1).toLowerCase() !== 'meta.json') return null;
  return parts[0] || null;
}

export class AnswerPushWatcher {
  constructor(options = {}) {
    this.sessionStore = options.sessionStore;
    this.pushService = options.pushService;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.states = new Map();
    this.notified = new Map();
    this.watcher = null;
    this.heartbeat = null;
    this.pending = new Map();
    this.closed = false;
  }

  async #latestFinalId(sessionId) {
    try {
      const snapshot = await this.sessionStore.messages(sessionId);
      const final = [...(snapshot?.messages ?? [])].reverse().find((message) => message?.role === 'assistant' && message.final === true);
      return final?.id ?? null;
    } catch {
      return null;
    }
  }

  async #seedSession(session) {
    const activeTurnId = session?.activity?.activeTurnId || null;
    const baselineFinalId = activeTurnId ? await this.#latestFinalId(session.id) : null;
    this.states.set(session.id, {
      activeTurnId,
      lastTurnEndAt: Number(session?.activity?.lastTurnEndAt) || 0,
      baselineFinalId
    });
  }

  async start() {
    const listed = await this.sessionStore.listNormalSessions();
    await Promise.all((listed.sessions || []).map((session) => this.#seedSession(session)));
    if (this.closed) return this;
    try {
      this.watcher = fsWatch(this.sessionStore.sessionsDir, { recursive: true, persistent: false }, (_event, filename) => {
        const sessionId = sessionIdFromWatchName(filename);
        if (sessionId) this.#schedule(sessionId, 35);
        else this.#scheduleAll(120);
      });
      this.watcher.on('error', () => this.#scheduleAll(250));
    } catch {
      this.watcher = null;
    }
    this.heartbeat = setInterval(() => { void this.#reconcileAll(); }, this.heartbeatMs);
    this.heartbeat.unref?.();
    return this;
  }

  #schedule(sessionId, delay) {
    if (this.closed || !sessionId) return;
    const held = this.pending.get(sessionId);
    if (held) clearTimeout(held);
    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.#checkSession(sessionId);
    }, delay);
    timer.unref?.();
    this.pending.set(sessionId, timer);
  }

  #scheduleAll(delay) {
    const timer = setTimeout(() => { void this.#reconcileAll(); }, delay);
    timer.unref?.();
  }

  async #reconcileAll() {
    if (this.closed) return;
    try {
      const listed = await this.sessionStore.listNormalSessions();
      for (const session of listed.sessions || []) await this.#checkProjectedSession(session);
    } catch { /* heartbeat is best-effort; fs.watch remains the fast path */ }
  }

  async #checkSession(sessionId) {
    if (this.closed) return;
    try {
      const meta = await this.sessionStore.readMeta(sessionId);
      if (!isNormalSession(meta)) return;
      await this.#checkProjectedSession({
        id: sessionId,
        activity: {
          activeTurnId: typeof meta.activeTurnId === 'string' ? meta.activeTurnId : null,
          lastTurnEndAt: Number(meta.lastTurnEndAt) || 0
        }
      });
    } catch { /* session can disappear while a watcher event is in flight */ }
  }

  async #checkProjectedSession(session) {
    if (!session?.id) return;
    const nextActive = session.activity?.activeTurnId || null;
    const nextEnd = Number(session.activity?.lastTurnEndAt) || 0;
    const held = this.states.get(session.id);
    if (!held) {
      await this.#seedSession(session);
      return;
    }

    if (!held.activeTurnId && nextActive) {
      held.activeTurnId = nextActive;
      held.lastTurnEndAt = nextEnd;
      held.baselineFinalId = await this.#latestFinalId(session.id);
      return;
    }

    if (held.activeTurnId && !nextActive) {
      const baselineFinalId = held.baselineFinalId;
      held.activeTurnId = null;
      held.lastTurnEndAt = nextEnd;
      held.baselineFinalId = null;
      void this.#notifyWhenFinalArrives(session.id, baselineFinalId);
      return;
    }

    if (held.activeTurnId && nextActive !== held.activeTurnId) {
      held.activeTurnId = nextActive;
      held.lastTurnEndAt = nextEnd;
      held.baselineFinalId = await this.#latestFinalId(session.id);
      return;
    }

    held.lastTurnEndAt = nextEnd;
  }

  async #notifyWhenFinalArrives(sessionId, baselineFinalId) {
    const delays = [0, 250, 900, 2200];
    for (const delay of delays) {
      if (this.closed) return;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const finalId = await this.#latestFinalId(sessionId);
      if (!finalId || finalId === baselineFinalId) continue;
      if (this.notified.get(sessionId) === finalId) return;
      this.notified.set(sessionId, finalId);
      await this.pushService.broadcast(answerReadyPayload()).catch(() => undefined);
      return;
    }
  }

  async close() {
    this.closed = true;
    try { this.watcher?.close(); } catch { /* already closed */ }
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}

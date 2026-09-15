import { promises as fs } from 'node:fs';
import path from 'node:path';

export function defaultCosRoot(env = process.env) {
  if (env.COS_DATA_DIR) return path.resolve(env.COS_DATA_DIR);
  if (!env.APPDATA) throw new Error('APPDATA is not set and COS_DATA_DIR was not provided');
  return path.join(env.APPDATA, 'chat-on-steroids');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

function cleanString(value, max = 256) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

export class CosStateStore {
  constructor(root = defaultCosRoot()) {
    this.root = path.resolve(root);
    this.stateDir = path.join(this.root, 'state');
  }

  async models() {
    const raw = await readJson(path.join(this.stateDir, 'chat-models.json'), null);
    if (!raw || !Array.isArray(raw.models)) return { observedAt: null, models: [] };
    const models = raw.models.slice(0, 50).map((model) => ({
      id: cleanString(model?.id, 80),
      label: cleanString(model?.label, 120) ?? cleanString(model?.id, 80),
      efforts: Array.isArray(model?.efforts)
        ? model.efforts.filter((effort) => typeof effort === 'string').slice(0, 12)
        : [],
      aliases: Array.isArray(model?.aliases)
        ? model.aliases.filter((alias) => typeof alias === 'string').slice(0, 20)
        : []
    })).filter((model) => model.id);
    return { observedAt: Number.isFinite(raw.observedAt) ? raw.observedAt : null, models };
  }

  async projects() {
    const raw = await readJson(path.join(this.stateDir, 'projects.json'), []);
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 100).map((project) => ({
      id: cleanString(project?.id, 80),
      name: cleanString(project?.name, 160) ?? 'Project',
      createdAt: Number.isFinite(project?.createdAt) ? project.createdAt : null,
      ungrouped: project?.ungrouped === true
    })).filter((project) => project.id);
  }

  async outbox({ sessionId = null, limit = 40 } = {}) {
    const raw = await readJson(path.join(this.stateDir, 'session-input.json'), []);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((row) => row && row.purpose !== 'decision' && (!sessionId || row.sessionId === sessionId || row.deliveredSessionId === sessionId))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, Math.max(1, Math.min(100, limit)))
      .map((row) => ({
        id: cleanString(row.id, 80),
        sessionId: cleanString(row.sessionId ?? row.deliveredSessionId, 80),
        conversationId: cleanString(row.conversationId, 256),
        state: cleanString(row.state, 40),
        mode: cleanString(row.mode, 40),
        transportIntent: cleanString(row.transportIntent, 40),
        model: cleanString(row.model, 80),
        reasoningEffort: cleanString(row.reasoningEffort, 40),
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null,
        offeredAt: Number.isFinite(row.offeredAt) ? row.offeredAt : null,
        deliveredAt: Number.isFinite(row.deliveredAt) ? row.deliveredAt : null,
        error: cleanString(row.error, 300)
      }));
  }

  async settings() {
    const raw = await readJson(path.join(this.root, 'config.json'), {});
    return {
      readOnly: raw?.readOnly === true,
      ui: {
        finishTool: raw?.ui?.finishTool === true,
        backgroundChats: raw?.ui?.backgroundChats === true,
        browserOnly: raw?.ui?.browserOnly === true,
        autoConnect: raw?.ui?.autoConnect === true
      },
      sessions: {
        advisoryTokens: Number.isFinite(raw?.sessions?.advisoryTokens) ? raw.sessions.advisoryTokens : null,
        limitTokens: Number.isFinite(raw?.sessions?.limitTokens) ? raw.sessions.limitTokens : null,
        retainDays: Number.isFinite(raw?.sessions?.retainDays) ? raw.sessions.retainDays : null
      },
      compaction: {
        auto: raw?.compaction?.auto === true,
        autoTokens: Number.isFinite(raw?.compaction?.autoTokens) ? raw.compaction.autoTokens : null
      },
      multiAgent: {
        enabled: raw?.multiAgent?.enabled === true,
        maxWorkers: Number.isFinite(raw?.multiAgent?.maxWorkers) ? raw.multiAgent.maxWorkers : null,
        defaultModel: cleanString(raw?.multiAgent?.defaultModel, 80),
        defaultReasoning: cleanString(raw?.multiAgent?.defaultReasoning, 40)
      },
      goal: {
        enabled: raw?.goal?.enabled === true,
        mode: cleanString(raw?.goal?.mode, 40),
        backend: cleanString(raw?.goal?.backend, 80),
        loopBackend: cleanString(raw?.goal?.loopBackend, 80),
        provider: cleanString(raw?.goal?.provider?.kind, 80),
        model: cleanString(raw?.goal?.model, 120),
        reasoning: cleanString(raw?.goal?.reasoning, 40)
      },
      tunnel: { kind: cleanString(raw?.tunnel?.kind, 80) }
    };
  }

  async snapshot({ sessionId = null } = {}) {
    const [catalog, projects, settings, outbox] = await Promise.all([
      this.models(), this.projects(), this.settings(), this.outbox({ sessionId })
    ]);
    return { catalog, projects, settings, outbox };
  }
}

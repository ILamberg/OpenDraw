import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

function safeSubscription(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : null;
  const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys?.auth === 'string' ? keys.auth.trim() : '';
  if (!endpoint || endpoint.length > 4096 || !/^https:\/\//i.test(endpoint)) return null;
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { return null; }
  const host = endpointUrl.hostname.toLowerCase();
  const trustedPushHost = host === 'fcm.googleapis.com'
    || host === 'updates.push.services.mozilla.com'
    || host === 'push.services.mozilla.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.apple.com');
  if (!trustedPushHost || endpointUrl.username || endpointUrl.password || endpointUrl.hash) return null;
  if (endpointUrl.port && endpointUrl.port !== '443') return null;
  if (!p256dh || p256dh.length > 512 || !auth || auth.length > 256) return null;
  const expirationTime = raw.expirationTime === null || raw.expirationTime === undefined
    ? null
    : Number.isFinite(raw.expirationTime) ? raw.expirationTime : null;
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

export class PushService {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir);
    this.file = path.join(this.dataDir, 'push.json');
    this.webpush = options.webpush ?? webpush;
    this.subject = options.subject ?? 'mailto:opendraw@example.com';
    this.state = null;
    this.mutations = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const publicKey = typeof parsed?.vapid?.publicKey === 'string' ? parsed.vapid.publicKey : '';
      const privateKey = typeof parsed?.vapid?.privateKey === 'string' ? parsed.vapid.privateKey : '';
      if (!publicKey || !privateKey) throw new Error('Invalid OpenDraw push configuration');
      this.state = {
        version: 1,
        vapid: { publicKey, privateKey, createdAt: Number(parsed?.vapid?.createdAt) || Date.now() },
        subscriptions: Array.isArray(parsed?.subscriptions)
          ? parsed.subscriptions
            .map((row) => ({
              deviceId: typeof row?.deviceId === 'string' ? row.deviceId : '',
              subscription: safeSubscription(row?.subscription),
              createdAt: Number(row?.createdAt) || Date.now(),
              updatedAt: Number(row?.updatedAt) || Date.now()
            }))
            .filter((row) => row.deviceId && row.subscription)
          : []
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const vapid = this.webpush.generateVAPIDKeys();
      this.state = {
        version: 1,
        vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, createdAt: Date.now() },
        subscriptions: []
      };
      await atomicJson(this.file, this.state);
    }
    this.webpush.setVapidDetails(this.subject, this.state.vapid.publicKey, this.state.vapid.privateKey);
    return this;
  }

  publicKey() {
    return this.state?.vapid?.publicKey ?? null;
  }

  hasSubscription(deviceId) {
    return Boolean(this.state?.subscriptions?.some((row) => row.deviceId === deviceId));
  }

  #mutate(fn) {
    const work = this.mutations.then(fn, fn);
    this.mutations = work.then(() => undefined, () => undefined);
    return work;
  }

  async setSubscription(deviceId, rawSubscription) {
    if (typeof deviceId !== 'string' || !deviceId) throw new Error('invalid_device');
    const subscription = safeSubscription(rawSubscription);
    if (!subscription) throw new Error('invalid_push_subscription');
    await this.#mutate(async () => {
      const now = Date.now();
      const held = this.state.subscriptions.find((row) => row.deviceId === deviceId);
      if (held) {
        held.subscription = subscription;
        held.updatedAt = now;
      } else {
        this.state.subscriptions.push({ deviceId, subscription, createdAt: now, updatedAt: now });
      }
      if (this.state.subscriptions.length > 64) this.state.subscriptions = this.state.subscriptions.slice(-64);
      await atomicJson(this.file, this.state);
    });
    return true;
  }

  async removeSubscription(deviceId) {
    if (typeof deviceId !== 'string' || !deviceId) return false;
    return this.#mutate(async () => {
      const before = this.state.subscriptions.length;
      this.state.subscriptions = this.state.subscriptions.filter((row) => row.deviceId !== deviceId);
      if (before === this.state.subscriptions.length) return false;
      await atomicJson(this.file, this.state);
      return true;
    });
  }

  async #sendRow(row, payload) {
    try {
      // Wake the phone service worker without sending conversation/session content
      // through the browser vendor's push relay. The SW renders fixed local copy.
      await this.webpush.sendNotification(row.subscription, undefined, {
        TTL: 300,
        urgency: 'high'
      });
      return { ok: true, stale: false };
    } catch (error) {
      const status = Number(error?.statusCode) || 0;
      return { ok: false, stale: status === 404 || status === 410, error };
    }
  }

  async sendToDevice(deviceId, payload) {
    const row = this.state.subscriptions.find((candidate) => candidate.deviceId === deviceId);
    if (!row) return { sent: 0, failed: 0, missing: true };
    const result = await this.#sendRow(row, payload);
    if (result.stale) await this.removeSubscription(deviceId);
    return { sent: result.ok ? 1 : 0, failed: result.ok ? 0 : 1, missing: false };
  }

  async broadcast(payload) {
    const rows = [...this.state.subscriptions];
    if (!rows.length) return { sent: 0, failed: 0 };
    const results = await Promise.all(rows.map(async (row) => ({ row, result: await this.#sendRow(row, payload) })));
    const staleIds = results.filter(({ result }) => result.stale).map(({ row }) => row.deviceId);
    if (staleIds.length) {
      await this.#mutate(async () => {
        const stale = new Set(staleIds);
        this.state.subscriptions = this.state.subscriptions.filter((row) => !stale.has(row.deviceId));
        await atomicJson(this.file, this.state);
      });
    }
    return {
      sent: results.filter(({ result }) => result.ok).length,
      failed: results.filter(({ result }) => !result.ok).length
    };
  }
}

export function answerReadyPayload() {
  return {
    type: 'answer-ready',
    title: 'OpenDraw · Answer ready',
    body: 'Chat On Steroids finished its response.',
    tag: 'opendraw-answer-ready',
    url: '/'
  };
}

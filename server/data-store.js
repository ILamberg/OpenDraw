import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function token(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualText(a, b) {
  const one = Buffer.from(String(a ?? ''), 'utf8');
  const two = Buffer.from(String(b ?? ''), 'utf8');
  return one.length === two.length && timingSafeEqual(one, two);
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}

function validConfig(value) {
  return value
    && typeof value.pairingSecret === 'string'
    && (value.devices === null || value.devices === undefined || Array.isArray(value.devices));
}

export class DataStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.configFile = path.join(this.dataDir, 'config.json');
    this.config = null;
    this.mutations = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.config = await this.#readOrCreateConfig();
    return this;
  }

  async #readOrCreateConfig() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      if (!validConfig(parsed)) throw new Error('Invalid OpenDraw config.json');

      // Version 1 included a Chrome-relay bearer. The phone-only companion no
      // longer has a relay surface, so migrate in place while preserving every
      // paired device and the existing high-entropy phone pairing secret.
      if (parsed.version !== 2 || Object.hasOwn(parsed, 'relayToken') || !Array.isArray(parsed.devices)) {
        const { relayToken: _obsoleteRelayToken, ...rest } = parsed;
        const migrated = {
          ...rest,
          version: 2,
          pairingSecret: parsed.pairingSecret,
          devices: Array.isArray(parsed.devices) ? parsed.devices : []
        };
        await atomicJson(this.configFile, migrated);
        return migrated;
      }
      return parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const created = {
        version: 2,
        pairingSecret: token(32),
        devices: []
      };
      await atomicJson(this.configFile, created);
      return created;
    }
  }

  #mutate(fn) {
    const work = this.mutations.then(fn, fn);
    this.mutations = work.then(() => undefined, () => undefined);
    return work;
  }

  pairingSecret() {
    return this.config.pairingSecret;
  }

  async pairDevice(pairingSecret, deviceName = 'Phone') {
    if (!safeEqualText(pairingSecret, this.config.pairingSecret)) return null;
    const bearer = token(32);
    const now = Date.now();
    const device = {
      id: randomUUID(),
      name: String(deviceName || 'Phone').trim().slice(0, 80) || 'Phone',
      tokenHash: digest(bearer),
      createdAt: now,
      lastSeenAt: now
    };
    await this.#mutate(async () => {
      this.config.devices.push(device);
      if (this.config.devices.length > 32) this.config.devices = this.config.devices.slice(-32);
      await atomicJson(this.configFile, this.config);
    });
    return { token: bearer, device: { id: device.id, name: device.name, createdAt: device.createdAt } };
  }

  async authorizeDevice(bearer) {
    if (typeof bearer !== 'string' || bearer.length < 32) return null;
    const hashed = digest(bearer);
    const device = this.config.devices.find((candidate) => safeEqualText(candidate.tokenHash, hashed));
    if (!device) return null;
    const now = Date.now();
    if (!Number.isFinite(device.lastSeenAt) || now - device.lastSeenAt > 60_000) {
      device.lastSeenAt = now;
      void this.#mutate(() => atomicJson(this.configFile, this.config));
    }
    return { id: device.id, name: device.name };
  }

  async revokeDevice(id) {
    if (typeof id !== 'string' || !id) return false;
    return this.#mutate(async () => {
      const before = this.config.devices.length;
      this.config.devices = this.config.devices.filter((device) => device.id !== id);
      if (this.config.devices.length === before) return false;
      await atomicJson(this.configFile, this.config);
      return true;
    });
  }
}

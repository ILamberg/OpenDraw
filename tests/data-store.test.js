import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DataStore } from '../server/data-store.js';

async function storeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await new DataStore(root).init() };
}

test('pairs devices with a high entropy secret and validates issued bearer', async (t) => {
  const { store } = await storeFixture(t);
  assert.ok(store.pairingSecret().length >= 40);
  assert.equal(await store.pairDevice('wrong', 'Phone'), null);
  const paired = await store.pairDevice(store.pairingSecret(), 'Phone');
  assert.ok(paired.token.length >= 40);
  assert.equal((await store.authorizeDevice(paired.token)).name, 'Phone');
  assert.equal(await store.authorizeDevice(`${paired.token}x`), null);
});

test('migrates legacy relay config to phone-only config without rotating phone credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-migrate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = {
    version: 1,
    port: 4783,
    createdAt: '2026-09-13T00:00:00Z',
    pairingSecret: 'p'.repeat(43),
    relayToken: 'r'.repeat(43),
    devices: [{ id: 'device-1', name: 'Phone', tokenHash: 'abc', createdAt: 1, lastSeenAt: 1 }]
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(legacy), 'utf8');

  const store = await new DataStore(root).init();
  assert.equal(store.pairingSecret(), legacy.pairingSecret);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.port, 4783);
  assert.equal(saved.createdAt, legacy.createdAt);
  assert.equal(saved.pairingSecret, legacy.pairingSecret);
  assert.equal(saved.devices.length, 1);
  assert.equal(Object.hasOwn(saved, 'relayToken'), false);
});

test('paired phone can be revoked without rotating other credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-data-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new DataStore(root).init();
  const first = await store.pairDevice(store.pairingSecret(), 'Phone');
  assert.ok(await store.authorizeDevice(first.token));
  assert.equal(await store.revokeDevice(first.device.id), true);
  assert.equal(await store.authorizeDevice(first.token), null);
  assert.equal(await store.revokeDevice(first.device.id), false);
  assert.equal(store.pairingSecret().length >= 40, true);
});

test('repairs setup-created null devices without rotating the pairing secret', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-null-devices-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pairingSecret = 'p'.repeat(43);
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    version: 2,
    port: 4783,
    pairingSecret,
    devices: null,
    createdAt: '2026-09-13T00:00:00Z'
  }), 'utf8');

  const store = await new DataStore(root).init();
  assert.equal(store.pairingSecret(), pairingSecret);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8'));
  assert.deepEqual(saved.devices, []);
  assert.equal(saved.pairingSecret, pairingSecret);
});

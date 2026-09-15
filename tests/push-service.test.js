import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PushService } from '../server/push-service.js';

function fakeWebPush() {
  const state = { sends: [], details: null };
  return {
    state,
    generateVAPIDKeys() { return { publicKey: 'PUBLIC_KEY', privateKey: 'PRIVATE_KEY' }; },
    setVapidDetails(subject, publicKey, privateKey) { state.details = { subject, publicKey, privateKey }; },
    async sendNotification(subscription, payload, options) {
      state.sends.push({ subscription: structuredClone(subscription), payload, options });
      return { statusCode: 201 };
    }
  };
}

test('push service persists VAPID keys and sends an empty privacy-safe wake push', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-push-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const webpush = fakeWebPush();
  const service = await new PushService({ dataDir: root, webpush }).init();
  assert.equal(service.publicKey(), 'PUBLIC_KEY');
  assert.equal(webpush.state.details.privateKey, 'PRIVATE_KEY');

  await service.setSubscription('device-1', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/example',
    expirationTime: null,
    keys: { p256dh: 'p256dh', auth: 'auth' }
  });
  const result = await service.sendToDevice('device-1', { private: 'must-not-cross-push-relay' });
  assert.equal(result.sent, 1);
  assert.equal(webpush.state.sends.length, 1);
  assert.equal(webpush.state.sends[0].payload, undefined);
  assert.equal(webpush.state.sends[0].options.urgency, 'high');

  const persisted = JSON.parse(await fs.readFile(path.join(root, 'push.json'), 'utf8'));
  assert.equal(persisted.vapid.privateKey, 'PRIVATE_KEY');
  const secondWebPush = fakeWebPush();
  const second = await new PushService({ dataDir: root, webpush: secondWebPush }).init();
  assert.equal(second.publicKey(), 'PUBLIC_KEY');
  assert.equal(secondWebPush.state.details.privateKey, 'PRIVATE_KEY');
});

test('push service rejects arbitrary HTTPS endpoints instead of becoming an SSRF sender', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-push-safe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = await new PushService({ dataDir: root, webpush: fakeWebPush() }).init();
  await assert.rejects(() => service.setSubscription('device-1', {
    endpoint: 'https://127.0.0.1/private',
    keys: { p256dh: 'p256dh', auth: 'auth' }
  }));
  await assert.rejects(() => service.setSubscription('device-1', {
    endpoint: 'https://evil.example/push',
    keys: { p256dh: 'p256dh', auth: 'auth' }
  }));
  assert.equal(service.hasSubscription('device-1'), false);
});

test('push service removes stale subscriptions after a 410 response', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opendraw-push-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const webpush = fakeWebPush();
  webpush.sendNotification = async () => {
    const error = new Error('gone');
    error.statusCode = 410;
    throw error;
  };
  const service = await new PushService({ dataDir: root, webpush }).init();
  await service.setSubscription('device-1', {
    endpoint: 'https://web.push.apple.com/Q123',
    keys: { p256dh: 'p256dh', auth: 'auth' }
  });
  const result = await service.sendToDevice('device-1', {});
  assert.equal(result.failed, 1);
  assert.equal(service.hasSubscription('device-1'), false);
});

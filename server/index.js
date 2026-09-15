import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenDrawServer } from './app.js';
import { AnswerPushWatcher } from './answer-push-watcher.js';
import { createCosPipeBridgeFromEnv } from './cos-pipe.js';
import { CosStateStore, defaultCosRoot } from './cos-state-store.js';
import { PushService } from './push-service.js';
import { createScreenStreamService } from './screen-stream.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const host = process.env.OPENDRAW_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.OPENDRAW_PORT || '4783', 10);
const controlSecret = process.env.OPENDRAW_CONTROL_SECRET || '';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('OPENDRAW_PORT must be an integer from 1 to 65535');
}

const cosBridge = createCosPipeBridgeFromEnv(process.env);
const cosStateStore = new CosStateStore(defaultCosRoot(process.env));
const pushService = await new PushService({ dataDir: path.join(ROOT, '.data') }).init();
const screenService = createScreenStreamService({
  ffmpegPath: path.join(ROOT, '.tools', 'ffmpeg', 'runtime', 'ffmpeg.exe'),
  dataDir: path.join(ROOT, '.data'),
  targetFps: 30,
  maxWidth: 1280,
  frameMaxWidth: 1024,
  bitrate: 3_000_000,
  slowClientMs: 450
});
void cosBridge.refresh();

let server = null;
let answerPushWatcher = null;

const built = await createOpenDrawServer({
  dataDir: path.join(ROOT, '.data'),
  publicDir: path.join(ROOT, 'public'),
  cosBridge,
  cosStateStore,
  pushService,
  screenService,
  controlSecret,
  requestShutdown: () => { void stop('restart'); }
});
server = built.server;
const { dataStore, sessionStore } = built;
answerPushWatcher = new AnswerPushWatcher({ sessionStore, pushService });
void answerPushWatcher.start().catch((error) => {
  console.warn(`Answer push watcher unavailable: ${error?.message ?? String(error)}`);
});

server.listen(port, host, () => {
  const shownHost = host.includes(':') ? `[${host}]` : host;
  console.log(`OpenDraw listening on http://${shownHost}:${port}`);
  console.log(`Pairing secret: ${dataStore.pairingSecret()}`);
  console.log('Phone credentials are stored privately in .data/config.json.');
  setTimeout(() => {
    const cos = cosBridge.status();
    console.log(`COS companion: ${cos.available ? 'ready' : cos.state}${cos.detail ? ` — ${cos.detail}` : ''}`);
  }, 750).unref();
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down OpenDraw`);
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([
    serverClosed,
    answerPushWatcher?.close?.() ?? Promise.resolve(),
    screenService.close(),
    typeof cosBridge.close === 'function' ? cosBridge.close({ closeCos: true }) : Promise.resolve()
  ]);
  clearTimeout(deadline);
  process.exit(0);
}

process.on('SIGINT', () => { void stop('SIGINT'); });
process.on('SIGTERM', () => { void stop('SIGTERM'); });

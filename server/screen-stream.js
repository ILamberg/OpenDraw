import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const STREAM_MIME = 'video/mp4; codecs="avc1.42C020"';
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function streamError(message, code = 'SCREEN_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stderrDetail(value) {
  return String(value || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
}

export class ScreenStreamService {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath;
    this.dataDir = options.dataDir;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => Date.now());
    this.targetFps = Math.max(5, Math.min(60, options.targetFps ?? 30));
    this.maxWidth = Math.max(640, Math.min(1920, options.maxWidth ?? 1280));
    this.frameMaxWidth = Math.max(640, Math.min(this.maxWidth, options.frameMaxWidth ?? 1024));
    this.bitrate = Math.max(1_000_000, Math.min(12_000_000, options.bitrate ?? 3_000_000));
    this.slowClientMs = Math.max(250, Math.min(3_000, options.slowClientMs ?? 450));
    this.clients = new Set();
    this.snapshotProcesses = new Set();
    this.lastDataAt = 0;
    this.lastError = null;
    this.closing = false;
  }

  available() {
    return typeof this.ffmpegPath === 'string' && existsSync(this.ffmpegPath);
  }

  status() {
    return {
      available: this.available(),
      capturing: this.clients.size > 0 || this.snapshotProcesses.size > 0,
      viewers: this.clients.size,
      targetFps: this.targetFps,
      maxWidth: this.maxWidth,
      frameMaxWidth: this.frameMaxWidth,
      codec: 'h264',
      mime: STREAM_MIME,
      bitrate: this.bitrate,
      latestAt: this.lastDataAt || null,
      error: this.lastError
    };
  }

  #captureGraph({ duplicate = true, maxWidth = this.maxWidth } = {}) {
    return [
      `ddagrab=framerate=${this.targetFps}:draw_mouse=1:dup_frames=${duplicate ? 'true' : 'false'}`,
      'hwdownload',
      'format=bgra',
      `scale=${maxWidth}:-2:flags=fast_bilinear`
    ].join(',');
  }

  #streamArgs() {
    const bitrate = String(this.bitrate);
    const gop = String(Math.max(5, Math.round(this.targetFps / 2)));
    const bufferSize = String(Math.max(500_000, Math.round(this.bitrate * 0.3)));
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'warning',
      '-filter_complex', `${this.#captureGraph({ duplicate: false })},format=yuv420p`,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level:v', '3.2',
      '-g', gop,
      '-keyint_min', gop,
      '-sc_threshold', '0',
      '-b:v', bitrate,
      '-maxrate', bitrate,
      '-bufsize', bufferSize,
      '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
      '-frag_duration', '100000',
      '-flush_packets', '1',
      '-f', 'mp4',
      'pipe:1'
    ];
  }

  #snapshotArgs() {
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'warning',
      '-filter_complex', this.#captureGraph({ duplicate: false }),
      '-frames:v', '1',
      '-c:v', 'mjpeg',
      '-q:v', '8',
      '-f', 'image2pipe',
      'pipe:1'
    ];
  }

  #frameArgs() {
    return [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'warning',
      '-filter_complex', this.#captureGraph({ duplicate: false, maxWidth: this.frameMaxWidth }),
      '-an',
      '-c:v', 'mjpeg',
      '-q:v', '18',
      '-flush_packets', '1',
      '-f', 'image2pipe',
      'pipe:1'
    ];
  }

  #spawn(args) {
    if (this.closing) throw streamError('Screen service is shutting down');
    if (!this.available()) throw streamError('The local screen capture runtime is unavailable');
    return this.spawnProcess(this.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  }

  async subscribe(req, res) {
    const startedAt = this.now();
    const child = this.#spawn(this.#streamArgs());
    let stderr = '';
    let blockedTimer = null;
    let paused = false;
    let finished = false;
    const client = { child, res, startedAt };
    this.clients.add(client);
    this.lastError = null;

    const finish = ({ kill = true } = {}) => {
      if (finished) return;
      finished = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      blockedTimer = null;
      this.clients.delete(client);
      if (kill && !child.killed) child.kill();
      if (!res.writableEnded) res.end();
    };

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1600);
    });
    child.once('error', (error) => {
      this.lastError = `Screen capture failed: ${error?.message ?? String(error)}`;
      finish({ kill: false });
    });
    child.once('exit', (code, signal) => {
      if (!finished && !this.closing && code !== 0) {
        this.lastError = stderrDetail(stderr) || `Screen capture exited (${code ?? signal ?? 'unknown'})`;
      }
      finish({ kill: false });
    });

    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'video/mp4',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'content-encoding': 'identity',
      'x-accel-buffering': 'no',
      'x-opendraw-screen-codec': 'avc1.42C020',
      'x-opendraw-screen-started-at': String(startedAt),
      'x-opendraw-screen-target-fps': String(this.targetFps)
    });

    child.stdout.on('data', (chunk) => {
      if (finished || res.destroyed || res.writableEnded) return finish();
      this.lastDataAt = this.now();
      const writable = res.write(chunk);
      if (writable || paused) return;
      paused = true;
      child.stdout.pause();
      blockedTimer = setTimeout(() => {
        blockedTimer = null;
        // A client that cannot clear TCP backpressure quickly would otherwise replay
        // old video. End this stream instead; the browser reconnects to a fresh GOP.
        finish();
      }, this.slowClientMs);
      blockedTimer.unref?.();
      res.once('drain', () => {
        if (finished) return;
        if (blockedTimer) clearTimeout(blockedTimer);
        blockedTimer = null;
        paused = false;
        child.stdout.resume();
      });
    });

    const remove = () => finish();
    req.once('close', remove);
    res.once('close', remove);
  }

  async subscribeFrames(req, res) {
    const child = this.#spawn(this.#frameArgs());
    const client = { child, res };
    this.clients.add(client);
    this.lastError = null;
    let stderr = '';
    let buffer = Buffer.alloc(0);
    let blocked = false;
    let pending = null;
    let blockedTimer = null;
    let finished = false;

    const finish = ({ kill = true } = {}) => {
      if (finished) return;
      finished = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      blockedTimer = null;
      pending = null;
      this.clients.delete(client);
      if (kill && !child.killed) child.kill();
      if (!res.writableEnded) res.end();
    };

    const packetForBrowser = (frame, capturedAt) => {
      const packet = Buffer.allocUnsafe(12 + frame.length);
      packet.writeUInt32LE(frame.length, 0);
      packet.writeDoubleLE(capturedAt, 4);
      frame.copy(packet, 12);
      return packet;
    };

    const writePacket = (packet) => {
      if (finished || res.destroyed || res.writableEnded) return finish();
      if (blocked) {
        pending = packet;
        return;
      }
      if (res.write(packet)) return;
      blocked = true;
      blockedTimer = setTimeout(() => finish(), this.slowClientMs);
      blockedTimer.unref?.();
      res.once('drain', () => {
        if (finished) return;
        if (blockedTimer) clearTimeout(blockedTimer);
        blockedTimer = null;
        blocked = false;
        const latest = pending;
        pending = null;
        if (latest) writePacket(latest);
      });
    };

    const publish = (frame) => {
      const capturedAt = this.now();
      this.lastDataAt = capturedAt;
      writePacket(packetForBrowser(frame, capturedAt));
    };

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1600);
    });
    child.stdout.on('data', (chunk) => {
      if (finished || !chunk?.length) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= 4) {
        const start = buffer.indexOf(JPEG_SOI);
        if (start < 0) {
          buffer = buffer.subarray(Math.max(0, buffer.length - 1));
          return;
        }
        if (start > 0) buffer = buffer.subarray(start);
        const end = buffer.indexOf(JPEG_EOI, 2);
        if (end < 0) {
          if (buffer.length > MAX_FRAME_BYTES) buffer = Buffer.alloc(0);
          return;
        }
        const frame = Buffer.from(buffer.subarray(0, end + 2));
        buffer = buffer.subarray(end + 2);
        if (frame.length <= MAX_FRAME_BYTES) publish(frame);
      }
    });
    child.once('error', (error) => {
      this.lastError = `Screen capture failed: ${error?.message ?? String(error)}`;
      finish({ kill: false });
    });
    child.once('exit', (code, signal) => {
      if (!finished && !this.closing && code !== 0) {
        this.lastError = stderrDetail(stderr) || `Screen capture exited (${code ?? signal ?? 'unknown'})`;
      }
      finish({ kill: false });
    });

    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/x-opendraw-screen-frames',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'content-encoding': 'identity',
      'x-accel-buffering': 'no',
      'x-opendraw-screen-codec': 'mjpeg-frames',
      'x-opendraw-screen-target-fps': String(this.targetFps)
    });

    const remove = () => finish();
    req.once('close', remove);
    res.once('close', remove);
  }

  async #captureJpeg(timeoutMs = 3_500) {
    const child = this.#spawn(this.#snapshotArgs());
    this.snapshotProcesses.add(child);
    let stderr = '';
    const chunks = [];
    let size = 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        this.snapshotProcesses.delete(child);
        reject(streamError('Timed out capturing the current desktop frame'));
      }, timeoutMs);
      timer.unref?.();
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.snapshotProcesses.delete(child);
        if (error) reject(error);
        else resolve(value);
      };
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1600);
      });
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SNAPSHOT_BYTES) {
          child.kill();
          done(streamError('Desktop snapshot exceeded the safe size limit'));
          return;
        }
        chunks.push(chunk);
      });
      child.once('error', (error) => done(streamError(`Screen capture failed: ${error?.message ?? String(error)}`)));
      child.once('exit', (code) => {
        if (settled) return;
        const frame = Buffer.concat(chunks);
        if (code !== 0 || frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) {
          done(streamError(stderrDetail(stderr) || `Could not capture desktop frame (${code ?? 'unknown'})`));
          return;
        }
        done(null, { frame, capturedAt: this.now() });
      });
    });
  }

  async snapshotForPrompt(messageId) {
    if (!this.dataDir) throw streamError('Screen snapshot storage is unavailable');
    const dir = path.join(this.dataDir, 'screen-snapshots');
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${messageId}.jpg`);
    try {
      const stat = await fs.stat(target);
      if (stat.isFile() && stat.size > 0) return { path: target, capturedAt: stat.mtimeMs };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const { frame, capturedAt } = await this.#captureJpeg();
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, frame, { mode: 0o600 });
    await fs.rename(temp, target);
    void this.#pruneSnapshots(dir).catch(() => undefined);
    return { path: target, capturedAt };
  }

  async #pruneSnapshots(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const rows = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(full);
        rows.push({ full, mtimeMs: stat.mtimeMs });
      } catch { }
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    await Promise.all(rows.slice(40).map((row) => fs.unlink(row.full).catch(() => undefined)));
  }

  async close() {
    this.closing = true;
    for (const client of [...this.clients]) {
      this.clients.delete(client);
      if (!client.child.killed) client.child.kill();
      if (!client.res.writableEnded) client.res.end();
    }
    for (const child of [...this.snapshotProcesses]) {
      this.snapshotProcesses.delete(child);
      if (!child.killed) child.kill();
    }
  }
}

export function createScreenStreamService(options = {}) {
  return new ScreenStreamService(options);
}

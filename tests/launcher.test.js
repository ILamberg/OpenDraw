import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

test('launcher restarts an existing OpenDraw service using authenticated control with a verified compatibility fallback', async () => {
  const [startScript, signalScript, setupScript, cmdScript, remoteScript] = await Promise.all([
    fs.readFile(path.join(ROOT, 'scripts', 'start.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'scripts', 'signal-console.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'scripts', 'setup.ps1'), 'utf8'),
    fs.readFile(path.join(ROOT, 'Start OpenDraw.cmd'), 'utf8'),
    fs.readFile(path.join(ROOT, 'scripts', 'remote.ps1'), 'utf8')
  ]);

  assert.match(setupScript, /controlSecret/);
  assert.match(startScript, /OPENDRAW_CONTROL_SECRET/);
  assert.match(startScript, /Restarting the existing private OpenDraw service/);
  assert.match(startScript, /api\/internal\/restart/);
  assert.match(startScript, /X-OpenDraw-Control/);
  assert.match(startScript, /signal-console\.ps1/);
  assert.match(startScript, /Get-ListeningProcessId[\s\S]*restartDeadline/);
  assert.match(startScript, /Get-ProcessStartTicks/);
  assert.match(startScript, /Test-SameProcess/);
  assert.match(startScript, /verified old OpenDraw process tree/);
  assert.match(startScript, /taskkill\.exe \/PID \$existingPid \/T \/F/);
  assert.match(startScript, /verifiedPid -ne \$existingPid/);
  assert.doesNotMatch(startScript, /Reusing the existing private OpenDraw service/);

  assert.match(signalScript, /GenerateConsoleCtrlEvent\(CTRL_C_EVENT, 0\)/);
  assert.match(signalScript, /AttachConsole\(\(uint\)processId\)/);
  assert.doesNotMatch(signalScript, /Stop-Process|taskkill/i);

  assert.match(cmdScript, /if not "%OPENDRAW_EXIT%"=="0"/i);
  assert.match(cmdScript, /pause >nul/i);
  assert.match(cmdScript, /exit \/b %OPENDRAW_EXIT%/i);

  assert.match(remoteScript, /tailscale funnel --bg --yes \$Port/i);
  assert.match(remoteScript, /public HTTPS fallback enabled/i);
  assert.match(remoteScript, /Funnel could not be enabled[\s\S]*tailscale serve --bg --yes \$Port/i);
  assert.match(remoteScript, /\[switch\]\$PrivateOnly/);
});

# OpenDraw

OpenDraw is a secure, phone-first web companion for Chat On Steroids (COS). It mirrors normal COS conversations, shows useful model/session/project state, and can send text into the exact selected COS session when the private live bridge is available.

OpenDraw does not need its own browser extension. The Node service stays on `127.0.0.1`; remote phone access uses Tailscale HTTPS. By default the launcher enables **Tailscale Funnel** for the same `*.ts.net` URL so the phone can still reach OpenDraw through ordinary HTTPS when a restrictive Wi-Fi blocks Tailscale client traffic. Protected OpenDraw APIs always require a separately paired per-device bearer.

## Install and start

Requirements:

- Windows with Chat On Steroids installed
- Node.js 22 or newer
- Tailscale signed in on the PC. Tailscale on the phone is optional but preferred; when Funnel is enabled, the same HTTPS URL also works through ordinary internet access.

### First-time setup

After cloning or downloading OpenDraw, install the locked npm dependencies once:

```powershell
npm ci
```

Then start OpenDraw by double-clicking:

```text
Start OpenDraw.cmd
```

That runs the setup, enables/refreshes the Tailscale HTTPS proxy for the loopback OpenDraw port, enables Funnel as the public HTTPS fallback when available, shows the local pairing secret, and starts the Node service.

`Start OpenDraw.cmd` intentionally does not install npm dependencies on every launch, so a fresh clone needs the one-time `npm ci` step above.

The first time, Tailscale may ask you to enable HTTPS sharing for the tailnet. Approve the URL it prints, then run OpenDraw again. OpenDraw will use Funnel when your tailnet permits it; if Funnel is unavailable, startup automatically falls back to private Serve.

If COS was already running before OpenDraw, fully quit COS once from its tray menu and restart OpenDraw. OpenDraw needs to launch COS itself to own the private Chromium debugging pipe used for the companion API. It does not force-kill COS.

On the phone:

1. Open the `https://<machine>.<tailnet>.ts.net/` URL printed by the startup script. Keeping Tailscale signed in on the phone is still preferred, but the same URL can fall back to ordinary public HTTPS when Funnel is enabled.
2. If the current Wi-Fi blocks Tailscale traffic, the browser can still use the same URL through the Funnel fallback; you do not need to change bookmarks or re-pair.
3. Pair once with the secret shown locally on the PC.
4. Browse projects/chats, pick a model and reasoning effort, then send. You can also start a fresh chat from any active project.

### Optional Live Screen support

The Live Screen feature uses a local FFmpeg executable. The current implementation expects it at:

```text
.tools/ffmpeg/runtime/ffmpeg.exe
```

`.tools/` is intentionally excluded from Git because it is a machine-local binary/runtime directory. Without FFmpeg, the rest of OpenDraw still works; only desktop screen streaming and snapshots are unavailable.

### Answer notifications

OpenDraw can register privacy-safe Web Push notifications for paired devices. VAPID keys and browser push subscriptions are generated locally under `.data/`, which is excluded from Git. Notification payloads do not include prompt or response text.

## Files that stay local

Do not commit runtime credentials or machine-specific artifacts. `.data/`, `.tools/`, `node_modules/`, QA screenshots, generated PDFs, personal documents, backups, prompt scratch files, and editor settings are intentionally excluded. Review `git status` and the staged diff before publishing a fork.

## Architecture

OpenDraw deliberately separates durable read access from live send access.

### Durable COS mirror

`server/session-store.js` reads `%APPDATA%/chat-on-steroids/sessions` read-only. It exposes only normal desktop sessions, excludes worker/helper sessions, reads canonical `messages/*.json`, and projects:

- session and conversation IDs
- title and live/active/idle/ended state
- selected model, reasoning effort and provider
- context/estimated tokens and counters
- project ID and timestamps

The active-session chooser prefers a genuinely active live turn over a newer idle session.

`server/cos-state-store.js` safely reads selected non-secret COS state such as the model catalog, project names, selected settings, and outbound delivery state. It does not expose prompt bodies, project paths, provider secrets, or `secrets.bin`.

### Private live COS bridge

`server/cos-pipe.js` launches Chat On Steroids with:

```text
--remote-debugging-pipe
```

Chromium DevTools Protocol traffic stays on inherited parent/child pipes. OpenDraw does **not** open a DevTools TCP port. The bridge finds the COS renderer, verifies the narrow preload API, and allowlists only the COS calls OpenDraw needs.

The important send path is the real COS path:

```text
OpenDraw -> COS preload api.sendInput -> sessions:send -> COS enqueue/delivery
```

Before an existing-session send reaches that bridge, OpenDraw verifies that the supplied `conversationId` exactly matches the selected durable COS `sessionId`. Each send also carries a UUID idempotency key. Ambiguous long send timeouts are reconciled against COS's own input list, and OpenDraw keeps a bounded 30-day local send ledger so the same UUID cannot silently become a fresh send after a restart or COS outbox pruning. The phone also reuses the same UUID when retrying an unconfirmed send.

For a new chat, OpenDraw uses COS's supported input shape with `sessionId: null` and an optional validated `projectId`. COS creates/binds the actual ChatGPT conversation when the first message is delivered. OpenDraw tracks the exact outbound UUID and switches the phone into the resulting COS session only after that delivery is correlated; it never guesses by choosing the newest session.

One COS limitation remains: on COS 2.0.9, an idle/new ChatGPT turn can still choose COS's own browser transport internally. OpenDraw itself has no browser relay or extension, but it does not bypass that internal COS transport policy.

### Phone security

`server/app.js` binds to loopback by default. Tailscale publishes that loopback service over HTTPS. The default launcher asks Tailscale Funnel to make the same HTTPS hostname reachable from restrictive networks; if Funnel cannot be enabled it falls back to private Serve only.

Pairing works as follows:

- setup creates a high-entropy pairing secret
- the phone exchanges it for a unique high-entropy device bearer
- only the SHA-256 bearer digest is stored server-side
- the raw bearer remains in that phone browser's local storage
- protected APIs require `Authorization: Bearer <device token>`
- pairing attempts are rate-limited
- one phone can revoke itself with `DELETE /api/me`
- `scripts/reset-phone-access.ps1` revokes every phone and rotates the pairing secret

The public `/api/health` route is intentionally minimal and does not reveal COS session state, session counts, conversation IDs, or the server boot ID.

When Funnel is enabled, the static phone shell and `/api/health` are reachable from the public internet, but conversation/session APIs are not: every protected route still requires the high-entropy paired device bearer. The pairing secret remains local to the PC startup terminal and pairing attempts remain rate-limited.

Static/API responses use restrictive security headers, API responses are not cached, request bodies are bounded, and the PWA has no third-party script dependency. The application shell is also served `no-store` and revisioned together with the service-worker cache so a phone cannot accidentally combine a new HTML shell with stale JavaScript/CSS and leave controls unbound.

Live COS state is projected before it reaches the phone. OpenDraw does not return COS's raw config, project/root paths, prompt bodies, attachment previews, queued stages or raw event payloads from `/api/status`. Queue data is exposed only through an exact-session endpoint and only with a bounded text preview plus the metadata required for phone controls.

## Phone UI

The PWA is designed for a narrow phone screen rather than a desktop layout squeezed smaller. The main chat surface intentionally stays simple; heavier COS controls live in a bottom sheet instead of permanently occupying chat space. It includes:

- searchable COS session drawer grouped by project, including projects that do not have a chat yet
- per-project **New** actions plus a current-project **New chat** action
- a real new-chat draft that becomes a COS/ChatGPT conversation on first send
- background-safe new-chat delivery correlation: you can navigate to another chat while COS is still creating the new one, and OpenDraw surfaces it when the exact UUID resolves
- live/durable model selector with alias resolution
- reasoning-effort selector, including COS's current `ultra` value, remembered per session
- microphone dictation when the phone browser exposes the Web Speech recognition API
- result-index-aware voice composition so interim/final speech updates replace each other instead of duplicating dictated text
- an exact-turn Stop control while the selected COS response is active
- a chat-controls sheet with refresh, open-in-ChatGPT, COS compaction/start-cancel, Goal/Loop automation + objective, exact-session queued-message status/cancel, and current COS usage/limit information
- canonical conversation transcript
- safe DOM-only Markdown rendering
- whole-message copy actions for both user and assistant messages, with a mobile/PWA clipboard fallback
- fenced code blocks with language labels and copy buttons
- sticky mobile composer and safe-area-aware top/bottom spacing for phone notches, gesture bars and home indicators
- PWA installation support
- per-device unpair/revoke

The Markdown renderer never uses untrusted `innerHTML`; links are emitted only for `http:` and `https:` URLs.

Voice dictation is progressive enhancement: it requires a secure browser context plus a browser that provides `SpeechRecognition`/`webkitSpeechRecognition`. The microphone permission policy is restricted to OpenDraw's own origin. Depending on the phone/browser, speech recognition may use that browser vendor's speech service; OpenDraw itself does not upload microphone audio to its Node server.

OpenDraw can target existing COS projects, including starting a new chat inside one. Creating a brand-new COS project is intentionally not exposed on the phone because COS 2.0.9's supported `addProject` action opens a native Windows folder picker on the PC; OpenDraw does not invent an arbitrary remote filesystem-path API around it.

If the live COS bridge is unavailable, the transcript and durable state remain readable while the composer truthfully reports send as unavailable.

OpenDraw owns the private COS pipe for its lifetime. On a normal OpenDraw shutdown it asks COS to close through the private protocol and waits briefly, but it does not hard-kill COS. If Windows or OpenDraw is terminated abruptly and COS remains running, fully quit COS once before restarting OpenDraw so a fresh private pipe can be created.

## Current limitations

- Windows is currently required by the launcher, COS integration, and desktop capture path.
- Chat On Steroids must be installed locally; live send/control depends on COS behavior and may need updates when COS changes.
- Creating a brand-new COS project from the phone is not exposed because COS opens a native Windows folder picker for that action.
- Voice dictation depends on browser support for `SpeechRecognition` / `webkitSpeechRecognition`.
- Live Screen requires the optional local FFmpeg runtime described above.
- Tailscale Funnel depends on the tailnet/account configuration. OpenDraw falls back to private Tailscale Serve when Funnel is unavailable.
- If COS is already running without OpenDraw's private pipe, fully quit COS once and restart OpenDraw.

## Troubleshooting

### Missing `web-push`

Run `npm ci` in the OpenDraw directory, then start OpenDraw again.

### Phone cannot reach the OpenDraw URL

Check that Tailscale is signed in on the PC and rerun `Start OpenDraw.cmd`. If Funnel is unavailable, the phone must be connected to the same tailnet for private Serve.

### Chats are readable but sending is unavailable

Fully quit Chat On Steroids from its tray menu, then restart OpenDraw so it can launch COS with the private process-owned pipe.

### Live Screen capture is unavailable

Verify that FFmpeg exists at `.tools/ffmpeg/runtime/ffmpeg.exe`. Live Screen is optional and does not affect normal chat/session controls.

### Revoke every paired phone

Stop OpenDraw and run:

```powershell
./scripts/reset-phone-access.ps1
```

Then start OpenDraw again and pair devices with the new local pairing secret.

## API

`GET /api/health` is public and intentionally minimal. All other state/action endpoints below require the paired device bearer, except `POST /api/pair`.

- `POST /api/pair` — pair a phone with `{ pairingSecret, deviceName }`
- `GET /api/status` — durable COS status plus live bridge/session/input state
- `GET /api/models` — live model catalog plus durable/observed fallback data
- `GET /api/usage` — projected COS usage/limit information
- `GET /api/cos-info?sessionId=...` — safe project/settings/outbound metadata
- `GET /api/sessions` — normal durable session summaries
- `GET /api/sessions/:id/messages` — canonical user/assistant transcript
- `POST /api/sessions/:id/messages` — exact-target send with `{ id, conversationId, text, model, reasoningEffort }`
- `GET /api/sessions/:id/controls` — projected COS controls for one normal session
- `POST /api/sessions/:id/automation` — set `off`, `goal` or `loop`, optionally with an objective
- `POST /api/sessions/:id/compact` — start COS compaction/continuation for one normal session
- `DELETE /api/sessions/:id/compact` — cancel that session's compaction/continuation
- `GET /api/sessions/:id/queue` — exact-session projected COS outbound queue
- `DELETE /api/sessions/:id/queue/:inputId` — cancel an owned queued/browser input when COS still permits cancellation
- `POST /api/chats` — create a new chat through COS on first send with `{ id, text, projectId, model, reasoningEffort }`
- `POST /api/sessions/:id/stop` — stop only the exact currently active turn using `{ expectedTurnId }`
- `GET /api/me` — current paired-device identity
- `DELETE /api/me` — revoke this phone's bearer

## Manual local start

For local development without configuring Tailscale Serve automatically:

```powershell
./scripts/setup.ps1 -SkipNpm
$env:OPENDRAW_HOST = '127.0.0.1'
$env:OPENDRAW_PORT = '4783'
npm start
```

`npm start` launches the private COS pipe bridge, but it does not run `scripts/remote.ps1`; use `Start OpenDraw.cmd` or `./scripts/start.ps1 -Remote` for remote phone access.

## Tests

```powershell
npm test
```

Tests cover secure pairing/migration/revocation, exact durable targeting, current-session election, canonical transcript order, safe COS state/input projection, project-safe new-chat creation, exact-turn stop protection, exact-session queue ownership, automation/compaction/usage projections, matching DOM-handler IDs, shell/service-worker revision consistency, no unsafe HTML mutation APIs, authenticated API behavior, and a fake private COS pipe including NUL-framed CDP discovery, live model/control calls, project-aware UUID idempotency, new-chat delivery correlation, conflicting reuse, send-timeout reconciliation, and child-exit handling.

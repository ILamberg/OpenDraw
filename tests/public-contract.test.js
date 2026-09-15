import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', 'public');

test('phone script only binds DOM ids that exist in the matching HTML shell', async () => {
  const [html, script] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8')
  ]);
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const scriptIds = new Set([...script.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]));
  const missing = [...scriptIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('HTML, service worker and shell assets share one explicit cache revision', async () => {
  const [html, worker] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'sw.js'), 'utf8')
  ]);
  const cssRevision = /app\.css\?v=(\d+)/.exec(html)?.[1];
  const jsRevision = /app\.js\?v=(\d+)/.exec(html)?.[1];
  const workerRevision = /opendraw-shell-v(\d+)/.exec(worker)?.[1];
  assert.ok(cssRevision);
  assert.equal(cssRevision, jsRevision);
  assert.equal(cssRevision, workerRevision);
  assert.match(worker, new RegExp(`app\\.css\\?v=${cssRevision}`));
  assert.match(worker, new RegExp(`app\\.js\\?v=${cssRevision}`));
  assert.match(worker, new RegExp(`chat-ui\\.js\\?v=${cssRevision}`));
  assert.match(worker, new RegExp(`voice-text\\.js\\?v=${cssRevision}`));
  const script = await fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(script, new RegExp(`chat-ui\\.js\\?v=${cssRevision}`));
  assert.match(script, new RegExp(`voice-text\\.js\\?v=${cssRevision}`));
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(html, /id="conversationSearchButton" class="icon-button conversation-search-button"/);
});

test('public client avoids unsafe HTML mutation APIs', async () => {
  const files = await Promise.all(['index.html', 'app.js', 'sw.js'].map((name) => fs.readFile(path.join(PUBLIC, name), 'utf8')));
  const joined = files.join('\n');
  assert.doesNotMatch(joined, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
});

test('phone buttons do not directly autofocus text controls and closed surfaces release hidden focus', async () => {
  const script = await fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(script, /function avoidProgrammaticTextFocus\(\)/);
  assert.match(script, /isMobileLayout\(\) \|\| window\.matchMedia\?\.\('\(pointer: coarse\)'\)\.matches === true/);
  assert.match(script, /function releaseTextFocus\(container = null\)/);
  assert.doesNotMatch(script, /els\.(?:modelSearchInput|messageInput|conversationPanelInput|sessionSearch)\.focus\s*\(/);
  assert.match(script, /if \(state\.conversationPanel\.mode === 'search'\) focusTextControl\(els\.conversationPanelInput\)/);
  assert.match(script, /const composerFocused = focused === els\.messageInput/);
  assert.match(script, /const keyboardOpen = Boolean\(composerFocused && viewport/);
});

test('active response composer switches between End and COS Send based on typed text', async () => {
  const [html, script] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8')
  ]);
  assert.equal(html.includes('id="stopTurnButton"'), false);
  assert.equal(html.includes('id="newlineButton"'), false);
  assert.match(script, /end:\s*\['End response',\s*'stop'\]/);
  assert.match(script, /function primaryComposerAction\(\)/);
  assert.match(script, /session\?\.activity\?\.activeTurnId && !hasText/);
  assert.match(script, /activeTurnId && !hasText\) mode = 'end'/);
  assert.match(script, /const mode = 'auto';[\s\S]*pendingMessageAttempt\(readPendingSends\(session\.id\)/);
  assert.match(script, /outboundFingerprint\(session, text, model, reasoningEffort, mode, screen\)/);
  assert.match(script, /JSON\.stringify\(\{ id, conversationId: session\.conversationId, text, model, reasoningEffort, mode, screen \}\)/);
  assert.match(script, /Queued in Chat On Steroids/);
  assert.doesNotMatch(script, /insertComposerNewline|newlineButton/);
});

test('answer notifications are opt-in, privacy-safe, and handled by the service worker', async () => {
  const [html, script, worker] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'sw.js'), 'utf8')
  ]);
  assert.match(html, /id="notificationButton"/);
  assert.match(script, /Notification\.requestPermission\(\)/);
  assert.match(script, /navigator\.serviceWorker\.ready/);
  assert.match(script, /registration\.pushManager\.subscribe\(\{/);
  assert.match(script, /userVisibleOnly:\s*true/);
  assert.match(script, /\/api\/push\/subscription/);
  assert.match(script, /\/api\/push\/test/);
  assert.doesNotMatch(script, /showNotification\([^)]*(?:message\.text|authoredText|prompt)/s);
  assert.match(worker, /addEventListener\('push'/);
  assert.match(worker, /OpenDraw · Answer ready/);
  assert.match(worker, /Chat On Steroids finished its response\./);
  assert.match(worker, /addEventListener\('notificationclick'/);
  assert.match(worker, /clients\.matchAll\(\{ type: 'window', includeUncontrolled: true \}\)/);
});

test('response work groups public progress and tools while keeping final answers and visuals outside', async () => {
  const script = await fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(script, /title\.textContent = 'Thinking'/);
  assert.match(script, /groupPromptTimeline\(\{/);
  assert.match(script, /responses:\s*state\.activity\?\.responses \|\| \[\]/);
  assert.match(script, /const activeResponseKey = session\?\.activity\?\.activeResponseKey/);
  assert.match(script, /const key = `run:prompt:\$\{bundle\.prompt\.id\}`/);
  assert.match(script, /wasRunning && !item\.active\s*\? false/);
  assert.match(script, /for \(const visual of bundle\.visuals\) result\.push\(\{ kind: 'visual'/);
  assert.match(script, /for \(const message of bundle\.finals\) result\.push\(\{ kind: 'message'/);
  assert.doesNotMatch(script, /if \(!item\.active\) state\.workOpen\.set\(item\.key, false\)/);
  assert.match(script, /setOpen\(state\.workOpen\.has\(item\.key\) \? state\.workOpen\.get\(item\.key\) : item\.active\)/);
  assert.match(script, /let bodyMaterialized = false/);
});

test('agent surfaces use the compact loading, trace, streaming and prompt-bar system', async () => {
  const [html, script, css] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.css'), 'utf8')
  ]);
  assert.match(script, /function createAiLoadingState\(item\)/);
  assert.match(script, /className = 'ai-loading-grid'/);
  assert.match(script, /className = 'ai-loading-elapsed'/);
  assert.match(script, /if \(item\.active && !item\.rows\.length\) return createAiLoadingState\(item\)/);
  assert.match(script, /title\.textContent = item\.elapsed \? `Thought for \$\{item\.elapsed\}` : 'Thought'/);
  assert.match(script, /className = 'run-details-trace'/);
  assert.match(script, /className = 'run-tool-chip'/);
  assert.match(script, /function renderStreamingTextInto\(bubble, text\)/);
  assert.match(script, /tail\.className = 'stream-tail'/);
  assert.match(script, /caret\.className = 'stream-caret is-streaming'/);
  assert.match(script, /bubble\.replaceChildren\(\.\.\.nodes\)/);
  assert.match(css, /\.run-details-group,[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(css, /\.run-details-trace::before/);
  assert.match(css, /\.ai-loading-cell[\s\S]*?opendraw-pixel-on/);
  assert.match(css, /\.stream-tail[\s\S]*?filter:\s*blur\(1\.5px\)/);
  assert.match(css, /\.composer-actions-row/);
  assert.match(css, /\.composer-shell\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(css, /\.composer-actions-row\s*\{\s*display:\s*contents;/);
  assert.match(css, /\.composer\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,1fr\) auto 32px 32px 32px;/);
  assert.match(script, /const minHeight = Math\.max\(32, Number\.parseFloat\(getComputedStyle\(els\.messageInput\)\.minHeight\) \|\| 32\)/);
  assert.match(script, /const contentHeight = els\.messageInput\.value \? els\.messageInput\.scrollHeight : minHeight/);
  const composer = html.match(/<form id="composer" class="composer">([\s\S]*?)<\/form>/)?.[1] || '';
  assert.match(composer, /id="messageInput"/);
  assert.match(composer, /id="modelPickerButton"/);
  assert.match(composer, /id="screenModeButton"/);
  assert.match(composer, /id="voiceButton"/);
  assert.match(composer, /id="sendButton"/);
  assert.ok(composer.indexOf('id="screenModeButton"') < composer.indexOf('id="voiceButton"'));
});

test('live screen mode is minimized by default, bearer-authenticated, low-latency and screen-aware', async () => {
  const [html, script, css, screenServer, serverIndex] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.css'), 'utf8'),
    fs.readFile(path.resolve(PUBLIC, '..', 'server', 'screen-stream.js'), 'utf8'),
    fs.readFile(path.resolve(PUBLIC, '..', 'server', 'index.js'), 'utf8')
  ]);
  assert.match(html, /id="screenMode"/);
  assert.match(html, /id="screenModeButton"/);
  assert.match(html, /id="screenModeExpanded" class="screen-mode-expanded hidden"/);
  assert.match(html, /id="screenCanvas"/);
  assert.match(html, /id="screenVideo"/);
  assert.match(html, /id="screenFps">30 FPS max/);
  assert.doesNotMatch(html, /id="screenAsk(?:Form|Input|Send|Model|Hint|Status)"/);
  assert.doesNotMatch(html, /id="screenModeToggle"/);
  assert.match(script, /fetch\('\/api\/screen\/stream',[\s\S]*?headers:\s*authHeaders\(\)/);
  assert.match(script, /fetch\('\/api\/screen\/frames',[\s\S]*?headers:\s*authHeaders\(\)/);
  assert.match(script, /state\.screen\.forceFrames = true/);
  assert.match(script, /const SCREEN_DEFAULT_FPS = 30;/);
  assert.match(script, /Math\.min\(SCREEN_DEFAULT_FPS, Math\.round\(numeric\)\)/);
  assert.match(script, /Math\.min\(SCREEN_DEFAULT_FPS, Math\.round\(Number\(state\.screen\.fps\)/);
  assert.match(script, /const SCREEN_H264_QUEUE_MAX_BYTES = 320_000;/);
  assert.match(script, /const SCREEN_STALL_MS = 1_800;/);
  assert.match(script, /const SCREEN_HUD_UPDATE_MS = 250;/);
  assert.match(script, /state\.screen\.forceFrames \|\| isMobileLayout\(\)/);
  assert.match(script, /Decode only the newest[\s\S]*?const latestFrame = buffer\.slice\(latestStart, latestEnd\)/);
  assert.match(script, /scheduleScreenWatchdog\(generation\)/);
  assert.match(script, /SCREEN_LIVE_EDGE_MAX_LAG = 0\.32/);
  assert.match(script, /error\?\.message === 'SCREEN_LATENCY_RESET'/);
  assert.doesNotMatch(script, /api\('\/api\/screen\/ask'/);
  assert.match(script, /state\.screen\.pendingFrame = \{ bytes, capturedAt \}/);
  assert.match(script, /const screen = pendingAttempt \? pendingAttempt\.screen : state\.screen\.open/);
  assert.match(script, /screen:\s*screen === true/);
  assert.match(script, /stopScreenStream\(\{ keepOpen: true \}\)/);
  assert.doesNotMatch(script, /\/api\/screen\/stream\?[^'"`]*token/i);
  assert.doesNotMatch(script, /\/api\/screen\/frames\?[^'"`]*token/i);
  assert.match(css, /\.chat-pane\.screen-mode-open\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0,1fr\) auto !important;/);
  assert.match(css, /\.chat-pane\.screen-mode-open > \.transcript\s*\{[\s\S]*?grid-row:\s*3;[\s\S]*?display:\s*block !important;/);
  assert.match(css, /\.chat-pane\.screen-mode-open > \.composer-shell\s*\{[\s\S]*?grid-row:\s*4;/);
  assert.doesNotMatch(css, /\.chat-pane\.screen-mode-open[\s\S]{0,500}> \.composer-shell\s*\{?[^}]*display:\s*none\s*!important/);
  assert.match(css, /\.screen-viewport\s*\{[\s\S]*?aspect-ratio:\s*var\(--screen-aspect,16 \/ 9\)/);
  assert.match(script, /function syncScreenViewportGeometry\(\)/);
  assert.match(script, /visualHeight \* 0\.42 \* ratio/);
  assert.match(script, /reconcileTranscriptAfterScreenLayout\(\)/);
  assert.match(script, /function openScreenMode\(\)[\s\S]*?state\.screen\.open = true;[\s\S]*?closeVisualViewer\(\);[\s\S]*?renderTranscript\(\{ preserveScroll: true \}\)/);
  assert.match(script, /function closeScreenMode\(\)[\s\S]*?stopScreenStream\(\{ keepOpen: false \}\);[\s\S]*?renderTranscript\(\{ preserveScroll: true \}\)/);
  assert.match(script, /if \(!state\.screen\.open\) \{[\s\S]*?for \(const visual of bundle\.visuals\) result\.push\(\{ kind: 'visual'/);
  assert.match(script, /async function loadVisualResult\(card, visual, sessionId\) \{[\s\S]*?if \(state\.screen\.open \|\| !card\?\.isConnected/);
  assert.match(script, /function toggleScreenMode\(\)[\s\S]*?if \(state\.screen\.open\)[\s\S]*?closeScreenMode\(\)[\s\S]*?openScreenMode\(\)/);
  assert.match(script, /screenModeButton\.addEventListener\('click', toggleScreenMode\)/);
  assert.match(script, /function renderScreenMetrics\(\{ force = false \} = \{\}\)/);
  assert.match(script, /now - state\.screen\.hudLastAt < SCREEN_HUD_UPDATE_MS/);
  assert.match(css, /\.screen-viewport/);
  assert.doesNotMatch(css, /\.screen-ask-/);
  assert.match(css, /\.screen-hud-live/);
  assert.match(css, /\.prompt-section-bar\s*\{[\s\S]*?background:\s*#0d0f12 !important;/);
  assert.match(css, /v48 stability:[\s\S]*?\.prompt-section-bar\s*\{[\s\S]*?height:\s*40px;[\s\S]*?max-height:\s*40px;/);
  assert.match(serverIndex, /targetFps:\s*30/);
  assert.match(serverIndex, /frameMaxWidth:\s*1024/);
  assert.match(serverIndex, /bitrate:\s*3_000_000/);
  assert.match(serverIndex, /slowClientMs:\s*450/);
  assert.match(screenServer, /options\.targetFps \?\? 30/);
  assert.match(screenServer, /options\.bitrate \?\? 3_000_000/);
  assert.match(screenServer, /options\.frameMaxWidth \?\? 1024/);
  assert.match(screenServer, /maxWidth: this\.frameMaxWidth/);
  assert.match(screenServer, /'-q:v', '18'/);
  assert.match(screenServer, /'-frag_duration', '100000'/);
});

test('cold transcript hydration is atomic and visuals remain viewport-or-tap lazy', async () => {
  const script = await fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8');
  assert.match(script, /const coldTranscript = Boolean/);
  assert.match(script, /refreshMessages\(\{ force: true, preserveScroll: true, animateChanges: false, deferRender: true \}\)/);
  assert.match(script, /refreshActivity\(\{ durableOnly: true, render: false, forceFull: true \}\)/);
  assert.match(script, /renderTranscript\(\{ preserveScroll: true, animateMessageIds: messageResult\?\.animateMessageIds \|\| new Set\(\) \}\)/);
  assert.match(script, /new IntersectionObserver/);
  assert.match(script, /Visual ready · tap to load/);
  assert.doesNotMatch(script, /queueMicrotask\(\(\) => \{ void loadVisualResult/);
});

test('the installed revision shell is cache-first and release discovery remains explicit', async () => {
  const [worker, script] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'sw.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8')
  ]);
  assert.match(worker, /const cached = await cache\.match\(event\.request\)/);
  assert.match(worker, /if \(cached\) return cached/);
  assert.match(worker, /fetch\(event\.request, \{ cache: 'no-store' \}\)/);
  assert.doesNotMatch(worker, /event\.waitUntil\(network/);
  assert.match(script, /serviceWorker\.register\('\/sw\.js', \{ updateViaCache: 'none' \}\)/);
  assert.match(script, /\.then\(\(registration\) => registration\.update\(\)\)/);
  assert.match(script, /serviceWorker\.addEventListener\('controllerchange'/);
});

test('live response reveal and subagent status use progressive safe UI paths', async () => {
  const [html, script, css] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.css'), 'utf8')
  ]);
  assert.match(html, /id="agentBar"/);
  assert.match(html, /id="agentList"/);
  assert.match(script, /function renderAgentBar\(\)/);
  assert.match(script, /animateMessageIds instanceof Set/);
  assert.match(script, /createMessageNode\(item\.message, \{ animateStreaming: animateMessage \}\)/);
  assert.match(script, /animateChanges && hadMessages && !bootChanged/);
  assert.match(script, /refresh\(\{ forceMessages: true, animateMessages: false \}\)/);
  assert.match(css, /\.agent-bar/);
  assert.match(css, /\.agent-row\.working/);
});

test('mobile interaction system has drag-safe disclosure activation, live dismiss gestures, and a current prompt section bar', async () => {
  const [html, script, css] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.css'), 'utf8')
  ]);
  assert.match(html, /id="promptSectionBar"/);
  assert.match(html, /class="panel-drag-handle"/);
  assert.match(script, /function bindDragSafeActivation\(/);
  assert.match(script, /function installDismissGesture\(/);
  assert.match(script, /function syncActivePromptFromScroll\(/);
  assert.match(script, /const targetScrollTop = Math\.max\(0, Math\.min\(maxScrollTop, els\.transcript\.scrollTop/);
  assert.match(script, /els\.transcript\.scrollTo\(\{ top: targetScrollTop/);
  assert.doesNotMatch(script, /node\.scrollIntoView\(/);
  assert.match(script, /let suppressClickUntil = 0;/);
  assert.doesNotMatch(script, /interactionSuppressClickUntil/);
  assert.match(script, /surface\.style\.transform = axis === 'x'/);
  assert.match(script, /distance >= Math\.min\(100, size \* 0\.26\) \|\| outwardVelocity > 0\.58/);
  assert.match(script, /size: axis === 'x' \? Math\.max\(1, rect\.width\) : Math\.max\(1, rect\.height\)/);
  assert.match(script, /scheduleDragPaint\(\)/);
  assert.doesNotMatch(script, /backdrop\.style\.backdropFilter/);
  assert.match(css, /\.prompt-section-bar/);
  assert.match(css, /\.panel-drag-handle/);
  assert.match(css, /\.panel-dragging/);
  assert.match(css, /\.sidebar,\s*\n\s*\.sidebar \.session-list \{ touch-action: pan-y; \}/);
  assert.doesNotMatch(css, /newline-button/);
});

test('context meter exposes a lightweight animated wave surface and respects reduced motion', async () => {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.css'), 'utf8')
  ]);
  assert.match(html, /class="context-gauge-wave"/);
  assert.match(html, /class="context-sheet-wave"/);
  assert.match(css, /@keyframes context-wave-slide/);
  assert.match(css, /\.context-gauge-wave[\s\S]*animation:\s*context-wave-slide/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.context-gauge-wave/);
});

test('chat markdown renderer covers common rich output without unsafe HTML injection paths', async () => {
  const [script, css] = await Promise.all([
    fs.readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
    fs.readFile(path.join(PUBLIC, 'app.css'), 'utf8')
  ]);
  assert.match(script, /function horizontalRule\(line\)/);
  assert.match(script, /function tableAlignments\(line\)/);
  assert.match(script, /function appendTaskOrInline\(item, raw\)/);
  assert.match(script, /type: 'strike'/);
  assert.match(script, /type: 'image'/);
  assert.match(script, /\^<\(https\?:/);
  assert.match(script, /image\.referrerPolicy = 'no-referrer'/);
  assert.match(script, /candidate\.type === 'escape'/);
  assert.match(css, /\.md-table-wrap/);
  assert.match(css, /\.md-task-item/);
  assert.match(css, /\.md-image-fallback/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
});

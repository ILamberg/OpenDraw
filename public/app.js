import { combineBaseAndSpeech, speechPartsText, updateSpeechParts } from './voice-text.js?v=54';
import { contextPressure, groupPromptTimeline, messageChronology, messageSignature, nearBottomMetrics, pendingDraftAttempt, pendingMessageAttempt, promptPreview, sendReceiptTerminal, streamWordChunks, streamWordsPerSecond } from './chat-ui.js?v=54';

const state = {
  token: localStorage.getItem('opendraw.deviceToken') || '',
  sessions: [],
  activeId: localStorage.getItem('opendraw.activeSession') || '',
  messages: [],
  bootId: null,
  status: null,
  sessionsRefreshedAt: 0,
  sessionsSignature: '',
  statusRefreshedAt: 0,
  modelCatalog: [],
  modelCatalogState: null,
  modelCatalogSource: null,
  modelsRefreshedAt: 0,
  cosInfo: null,
  cosInfoRefreshedAt: 0,
  projectFilter: localStorage.getItem('opendraw.projectFilter') || 'all',
  draft: null,
  pendingNewChat: null,
  stoppingTurn: false,
  controls: null,
  queue: [],
  usage: null,
  activity: { plan: null, tools: [], visuals: [], responses: [], agents: [] },
  activityFor: '',
  activityRevision: null,
  activityTimelineSignature: '',
  lastLiveActivityRefresh: 0,
  visualObjectUrls: new Map(),
  visualObserver: null,
  visualViewer: null,
  sheetOpen: false,
  sheetBusy: false,
  modelPickerOpen: false,
  contextSheetOpen: false,
  contextSheetBusy: false,
  connectionRetryBusy: false,
  sendInFlight: false,
  sendUiState: 'idle',
  sendUiTimer: null,
  draftSaveTimer: null,
  toastTimer: null,
  conversationPanel: { open: false, mode: 'prompts', query: '', results: [], index: 0 },
  scroll: { atBottom: true, followLatest: true, unread: 0, activePromptId: null, raf: 0, programmaticUntil: 0, anchor: null, userIntent: false, epoch: 0 },
  scrollMemory: new Map(),
  promptObserver: null,
  activityRequestId: 0,
  activitySignature: '',
  taskSignature: '',
  messageSignature: '',
  messagePollTimer: null,
  messageRefreshInFlight: false,
  messageRefreshGeneration: 0,
  messagePollAbort: null,
  lastFullMessageRefresh: 0,
  streamUntil: 0,
  wordReveal: new Map(),
  wordRevealRaf: 0,
  wordRevealLastAt: 0,
  composerHeight: 0,
  viewportBaseline: 0,
  viewportRaf: 0,
  voice: {
    supported: false,
    recognition: null,
    starting: false,
    listening: false,
    stopping: false,
    acceptResults: false,
    baseText: '',
    parts: [],
    finalText: '',
    status: 'idle',
    error: ''
  },
  screen: {
    open: false,
    available: null,
    controller: null,
    generation: 0,
    reconnectTimer: null,
    watchdogTimer: null,
    lastFrameAt: 0,
    streaming: false,
    connecting: false,
    error: '',
    transport: '',
    forceFrames: false,
    mediaSource: null,
    sourceBuffer: null,
    objectUrl: '',
    appendQueue: [],
    appendBytes: 0,
    streamStartedAt: 0,
    videoFrameCallback: 0,
    pendingFrame: null,
    decodeBusy: false,
    frameTimes: [],
    fps: 0,
    latency: null,
    width: 0,
    height: 0,
    hasFrame: false,
    targetFps: 30,
    latencyStrikes: 0,
    layoutKey: '',
    hudLastAt: 0
  },
  online: false,
  installPrompt: null,
  notificationsEnabled: localStorage.getItem('opendraw.notificationsEnabled') === '1',
  pushAvailable: false,
  pushSubscribed: false,
  pushPublicKey: null,
  workOpen: new Map(),
  refreshTimer: null
};

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const COMPOSER_DRAFTS_KEY = 'opendraw.composerDrafts.v1';
const COMPOSER_TARGET_KEY = 'opendraw.composerTarget.v1';
const NOTIFICATIONS_KEY = 'opendraw.notificationsEnabled';
const NOTIFIED_MESSAGE_PREFIX = 'opendraw.notifiedMessage.';
const MAX_SAVED_COMPOSER_DRAFTS = 40;
const SCREEN_DEFAULT_FPS = 30;
const SCREEN_H264_QUEUE_MAX_BYTES = 320_000;
const SCREEN_LIVE_EDGE_MAX_LAG = 0.32;
const SCREEN_LIVE_EDGE_TARGET_LAG = 0.08;
const SCREEN_H264_MAX_LATENCY_MS = 750;
const SCREEN_H264_LATENCY_STRIKES = 10;
const SCREEN_RECONNECT_MS = 450;
const SCREEN_STALL_MS = 1_800;
const SCREEN_WATCHDOG_MS = 700;
const SCREEN_HUD_UPDATE_MS = 250;
const ICON_PATHS = {
  copy: 'M9 8.25V6.5A2.5 2.5 0 0 1 11.5 4h6A2.5 2.5 0 0 1 20 6.5v6a2.5 2.5 0 0 1-2.5 2.5h-1.75M6.5 9h6A2.5 2.5 0 0 1 15 11.5v6a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 4 17.5v-6A2.5 2.5 0 0 1 6.5 9Z',
  folder: 'M3.75 7.5A2.25 2.25 0 0 1 6 5.25h3.05c.55 0 1.08.2 1.49.57l1.55 1.43H18A2.25 2.25 0 0 1 20.25 9.5v7A2.25 2.25 0 0 1 18 18.75H6a2.25 2.25 0 0 1-2.25-2.25v-9Z',
  layers: 'M12 4.5 4.5 8.75 12 13l7.5-4.25L12 4.5ZM4.5 12.25 12 16.5l7.5-4.25M4.5 15.75 12 20l7.5-4.25',
  check: 'm5.5 12.5 4 4 9-9',
  search: 'M10.75 16.5a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5Zm4.45-1.3 4.3 4.3',
  down: 'm6 9 6 6 6-6',
  list: 'M8.5 6.5H19M8.5 12H19M8.5 17.5H19M5 6.5h.01M5 12h.01M5 17.5h.01',
  globe: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0 0c2 0 3.5-3.58 3.5-8S14 4 12 4s-3.5 3.58-3.5 8S10 20 12 20ZM4.5 12h15',
  file: 'M7 3.75h6l4 4v12.5H7V3.75Zm6 0v4h4M9.5 12h5M9.5 15.5h5',
  terminal: 'm6 8 4 4-4 4M11.5 16H18',
  image: 'M4.5 5.5h15v13h-15v-13Zm2.5 10 3.5-3.5 2.5 2.5 2-2 2.5 3M9 9h.01',
  calendar: 'M5 7h14v12H5V7Zm3-3v5M16 4v5M5 10h14',
  spark: 'm12 4 .9 3.1L16 8l-3.1.9L12 12l-.9-3.1L8 8l3.1-.9L12 4Zm6 9 .6 2.1L21 16l-2.4.9L18 19l-.6-2.1L15 16l2.4-.9L18 13Z',
  refresh: 'M19 8a7 7 0 1 0 1 6M19 4v4h-4',
  stop: 'M7 7h10v10H7V7Z',
  return: 'M18.5 6.5v5.25A3.25 3.25 0 0 1 15.25 15H7m3.25-3.25L7 15l3.25 3.25',
  alert: 'M12 4.5 20 19H4L12 4.5Zm0 5v4.5M12 17h.01',
  clock: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-11v4l3 2',
  bell: 'M7 10a5 5 0 0 1 10 0v3.4l1.5 2.6h-13L7 13.4V10Zm3.5 8h3',
  close: 'm6.75 6.75 10.5 10.5M17.25 6.75l-10.5 10.5'
};

function createUiIcon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ui-icon');
  if (extraClass) svg.classList.add(extraClass);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.folder);
  svg.append(path);
  return svg;
}

const els = {
  chatPane: document.querySelector('.chat-pane'),
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  sessionList: $('sessionList'),
  sessionSearch: $('sessionSearch'),
  projectNav: $('projectNav'),
  newChatButton: $('newChatButton'),
  activeTitle: $('activeTitle'),
  activeMeta: $('activeMeta'),
  openChatLink: $('openChatLink'),
  moreButton: $('moreButton'),
  promptNavigatorButton: $('promptNavigatorButton'),
  promptSectionBar: $('promptSectionBar'),
  promptSectionIndex: $('promptSectionIndex'),
  promptSectionTotal: $('promptSectionTotal'),
  promptSectionText: $('promptSectionText'),
  promptSectionProgress: $('promptSectionProgress'),
  conversationSearchButton: $('conversationSearchButton'),
  connectionBadge: $('connectionBadge'),
  sessionFacts: $('sessionFacts'),
  cosInfo: $('cosInfo'),
  cosSummary: $('cosSummary'),
  contextStatus: $('contextStatus'),
  contextStatusButton: $('contextStatusButton'),
  contextStatusTitle: $('contextStatusTitle'),
  contextStatusValue: $('contextStatusValue'),
  contextStatusDetail: $('contextStatusDetail'),
  contextMeterFill: $('contextMeterFill'),
  screenMode: $('screenMode'),
  screenModeButton: $('screenModeButton'),
  screenModeExpanded: $('screenModeExpanded'),
  screenLiveStatus: $('screenLiveStatus'),
  screenFullscreenButton: $('screenFullscreenButton'),
  screenCloseButton: $('screenCloseButton'),
  screenViewport: $('screenViewport'),
  screenVideo: $('screenVideo'),
  screenCanvas: $('screenCanvas'),
  screenPlaceholder: $('screenPlaceholder'),
  screenFps: $('screenFps'),
  screenLatency: $('screenLatency'),
  transcript: $('transcript'),
  jumpLatestButton: $('jumpLatestButton'),
  jumpLatestLabel: $('jumpLatestLabel'),
  emptyState: $('emptyState'),
  emptyTitle: $('emptyTitle'),
  emptyDescription: $('emptyDescription'),
  composer: $('composer'),
  composerShell: $('composerShell'),
  agentBar: $('agentBar'),
  agentSummary: $('agentSummary'),
  agentCount: $('agentCount'),
  agentList: $('agentList'),
  taskBar: $('taskBar'),
  taskSummary: $('taskSummary'),
  taskProgress: $('taskProgress'),
  taskSteps: $('taskSteps'),
  messageInput: $('messageInput'),
  sendButton: $('sendButton'),
  sendStatus: $('sendStatus'),
  composerNote: $('composerNote'),
  composerOptions: $('composerOptions'),
  composerSummary: $('composerSummary'),
  modelPickerButton: $('modelPickerButton'),
  voiceButton: $('voiceButton'),
  voiceStatus: $('voiceStatus'),
  modelSelect: $('modelSelect'),
  reasoningSelect: $('reasoningSelect'),
  mobileProjectButton: $('mobileProjectButton'),
  mobileProjectName: $('mobileProjectName'),
  mobileSessionCount: $('mobileSessionCount'),
  mobileNewChatButton: $('mobileNewChatButton'),
  sessionSheetBackdrop: $('sessionSheetBackdrop'),
  sessionSheet: $('sessionSheet'),
  closeSessionSheet: $('closeSessionSheet'),
  sheetTitle: $('sheetTitle'),
  sheetStatus: $('sheetStatus'),
  sheetOpenChatLink: $('sheetOpenChatLink'),
  sheetSearchButton: $('sheetSearchButton'),
  notificationButton: $('notificationButton'),
  notificationButtonTitle: $('notificationButtonTitle'),
  notificationButtonDetail: $('notificationButtonDetail'),
  refreshButton: $('refreshButton'),
  compactButton: $('compactButton'),
  cancelCompactButton: $('cancelCompactButton'),
  automationSelect: $('automationSelect'),
  objectiveInput: $('objectiveInput'),
  saveAutomationButton: $('saveAutomationButton'),
  queueCount: $('queueCount'),
  queueList: $('queueList'),
  usageList: $('usageList'),
  sheetMessage: $('sheetMessage'),
  modelPickerBackdrop: $('modelPickerBackdrop'),
  modelPickerSheet: $('modelPickerSheet'),
  closeModelPicker: $('closeModelPicker'),
  modelSearchInput: $('modelSearchInput'),
  modelPickerMeta: $('modelPickerMeta'),
  modelPickerList: $('modelPickerList'),
  reasoningPickerList: $('reasoningPickerList'),
  contextSheetBackdrop: $('contextSheetBackdrop'),
  contextSheet: $('contextSheet'),
  closeContextSheet: $('closeContextSheet'),
  contextSheetGauge: $('contextSheetGauge'),
  contextSheetFill: $('contextSheetFill'),
  contextSheetPercent: $('contextSheetPercent'),
  contextCurrentValue: $('contextCurrentValue'),
  contextStageValue: $('contextStageValue'),
  contextLimitValue: $('contextLimitValue'),
  contextAdvisoryValue: $('contextAdvisoryValue'),
  contextAutoValue: $('contextAutoValue'),
  contextModeValue: $('contextModeValue'),
  contextCompactButton: $('contextCompactButton'),
  contextCancelCompactButton: $('contextCancelCompactButton'),
  contextSheetMessage: $('contextSheetMessage'),
  conversationPanelBackdrop: $('conversationPanelBackdrop'),
  conversationPanel: $('conversationPanel'),
  conversationPanelTitle: $('conversationPanelTitle'),
  closeConversationPanel: $('closeConversationPanel'),
  promptPanelTab: $('promptPanelTab'),
  searchPanelTab: $('searchPanelTab'),
  conversationPanelInput: $('conversationPanelInput'),
  conversationSearchControls: $('conversationSearchControls'),
  conversationSearchSummary: $('conversationSearchSummary'),
  conversationSearchPrev: $('conversationSearchPrev'),
  conversationSearchNext: $('conversationSearchNext'),
  conversationPanelList: $('conversationPanelList'),
  toast: $('toast'),
  pairing: $('pairing'),
  pairForm: $('pairForm'),
  pairError: $('pairError'),
  deviceName: $('deviceName'),
  pairingSecret: $('pairingSecret'),
  installButton: $('installButton')
};

function authHeaders(extra = {}) {
  return state.token ? { authorization: `Bearer ${state.token}`, ...extra } : extra;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: authHeaders({ ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) })
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/pair') {
    state.token = '';
    localStorage.removeItem('opendraw.deviceToken');
    showPairing();
  }
  if (!response.ok) {
    const error = new Error(data.message || data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function normalizedScreenTargetFps(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return SCREEN_DEFAULT_FPS;
  return Math.max(5, Math.min(SCREEN_DEFAULT_FPS, Math.round(numeric)));
}

function renderScreenFps() {
  if (!els.screenFps) return;
  const fps = Math.max(0, Math.min(SCREEN_DEFAULT_FPS, Math.round(Number(state.screen.fps) || 0)));
  els.screenFps.textContent = fps > 0 ? `${fps} FPS · ${SCREEN_DEFAULT_FPS} max` : `${SCREEN_DEFAULT_FPS} FPS max`;
}

function renderScreenMetrics({ force = false } = {}) {
  const now = performance.now();
  if (!force && now - state.screen.hudLastAt < SCREEN_HUD_UPDATE_MS) return;
  state.screen.hudLastAt = now;
  renderScreenFps();
  els.screenLatency.textContent = Number.isFinite(state.screen.latency)
    ? `${Math.round(state.screen.latency)} ms`
    : '— ms';
}

function syncScreenViewportGeometry() {
  if (!els.screenViewport) return;
  const width = Number(state.screen.width) > 0 ? Number(state.screen.width) : 16;
  const height = Number(state.screen.height) > 0 ? Number(state.screen.height) : 9;
  const ratio = Math.max(0.5, Math.min(4, width / height));
  const viewport = window.visualViewport;
  const visualHeight = viewport && viewport.scale === 1 && Number.isFinite(viewport.height)
    ? viewport.height
    : window.innerHeight || 720;
  // Keep enough room for the live transcript below the screen. The inline cap is
  // derived from the captured aspect ratio, so the viewport itself does not become
  // a tall letterbox on phones or a full-height wall on desktop.
  const maxInline = Math.max(280, Math.min(920, Math.round(visualHeight * 0.42 * ratio)));
  const key = `${width}x${height}:${maxInline}`;
  if (state.screen.layoutKey === key) return;
  state.screen.layoutKey = key;
  els.screenViewport.style.setProperty('--screen-aspect', `${width} / ${height}`);
  els.screenViewport.style.setProperty('--screen-max-inline', `${maxInline}px`);
}

function clearScreenWatchdog() {
  clearTimeout(state.screen.watchdogTimer);
  state.screen.watchdogTimer = null;
}

function markScreenFrame() {
  state.screen.lastFrameAt = Date.now();
}

function scheduleScreenWatchdog(generation) {
  clearScreenWatchdog();
  if (generation !== state.screen.generation || !state.screen.open || document.hidden) return;
  state.screen.watchdogTimer = setTimeout(() => {
    state.screen.watchdogTimer = null;
    if (generation !== state.screen.generation || !state.screen.open || document.hidden) return;
    const stalled = state.screen.streaming
      && state.screen.lastFrameAt > 0
      && Date.now() - state.screen.lastFrameAt > SCREEN_STALL_MS;
    if (stalled) {
      if (state.screen.transport === 'h264') state.screen.forceFrames = true;
      state.screen.error = '';
      state.screen.controller?.abort();
      return;
    }
    scheduleScreenWatchdog(generation);
  }, SCREEN_WATCHDOG_MS);
}

function renderScreenMode() {
  if (!els.screenMode) return;
  const screen = state.screen;
  els.chatPane.classList.toggle('screen-mode-open', screen.open);
  els.screenMode.classList.toggle('expanded', screen.open);
  els.screenMode.classList.toggle('hidden', !screen.open);
  els.screenModeButton?.classList.toggle('active', screen.open);
  els.screenModeButton?.setAttribute('aria-pressed', String(screen.open));
  if (els.screenModeButton) {
    const actionLabel = screen.open ? 'Close live screen' : 'Open live screen';
    els.screenModeButton.disabled = screen.available === false;
    els.screenModeButton.title = screen.available === false ? 'Live screen unavailable' : actionLabel;
    els.screenModeButton.setAttribute('aria-label', screen.available === false ? 'Live screen unavailable' : actionLabel);
  }
  els.screenModeExpanded.classList.toggle('hidden', !screen.open);
  const status = screen.error
    ? screen.error
    : screen.connecting
      ? 'Connecting…'
      : screen.streaming
        ? screen.transport === 'frames'
          ? 'Live · 30 FPS · low latency'
          : 'Live · H.264 · low latency'
        : screen.open
          ? 'Paused'
          : 'Ready';
  els.screenLiveStatus.textContent = status;
  els.screenLiveStatus.dataset.tone = screen.error ? 'bad' : screen.streaming ? 'live' : '';
  renderScreenMetrics({ force: true });
  syncScreenViewportGeometry();
  els.screenPlaceholder.classList.toggle('hidden', screen.hasFrame);
}

async function refreshScreenStatus() {
  if (!state.token || !els.screenMode) return;
  try {
    const status = await api('/api/screen/status');
    state.screen.available = status.available === true;
    state.screen.targetFps = normalizedScreenTargetFps(status.targetFps);
    if (!status.available && status.error) state.screen.error = status.error;
  } catch (error) {
    if (error.status === 401) return;
    state.screen.available = false;
  }
  renderScreenMode();
}

function updateScreenFrameMetrics(mediaTime = null) {
  const now = performance.now();
  state.screen.frameTimes.push(now);
  while (state.screen.frameTimes.length && state.screen.frameTimes[0] < now - 1000) state.screen.frameTimes.shift();
  state.screen.fps = state.screen.frameTimes.length;
  if (Number.isFinite(mediaTime) && state.screen.streamStartedAt) {
    state.screen.latency = Math.max(0, Date.now() - (state.screen.streamStartedAt + mediaTime * 1000));
  }
  if (state.screen.transport === 'h264' && Number.isFinite(state.screen.latency)) {
    state.screen.latencyStrikes = state.screen.latency > SCREEN_H264_MAX_LATENCY_MS
      ? state.screen.latencyStrikes + 1
      : 0;
    if (state.screen.latencyStrikes >= SCREEN_H264_LATENCY_STRIKES) {
      state.screen.latencyStrikes = 0;
      state.screen.forceFrames = true;
      state.screen.controller?.abort();
    }
  }
  markScreenFrame();
  renderScreenMetrics();
}

function appendScreenBytes(left, right) {
  if (!left?.length) return right;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

async function decodeScreenFrame(frame) {
  const blob = new Blob([frame], { type: 'image/jpeg' });
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url)
    });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode the desktop frame'));
    };
    image.src = url;
  });
}

function queueScreenFrame(bytes, capturedAt) {
  state.screen.pendingFrame = { bytes, capturedAt };
  if (state.screen.decodeBusy) return;
  state.screen.decodeBusy = true;
  void (async () => {
    try {
      while (state.screen.pendingFrame && state.screen.open) {
        const next = state.screen.pendingFrame;
        state.screen.pendingFrame = null;
        const decoded = await decodeScreenFrame(next.bytes);
        try {
          if (!state.screen.open) return;
          const canvas = els.screenCanvas;
          if (canvas.width !== decoded.width || canvas.height !== decoded.height) {
            canvas.width = decoded.width;
            canvas.height = decoded.height;
            state.screen.width = decoded.width;
            state.screen.height = decoded.height;
            syncScreenViewportGeometry();
          }
          const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
          context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
          state.screen.hasFrame = true;
          els.screenPlaceholder.classList.add('hidden');
          const now = performance.now();
          state.screen.frameTimes.push(now);
          while (state.screen.frameTimes.length && state.screen.frameTimes[0] < now - 1000) state.screen.frameTimes.shift();
          state.screen.fps = state.screen.frameTimes.length;
          state.screen.latency = Math.max(0, Date.now() - next.capturedAt);
          markScreenFrame();
          renderScreenMetrics();
        } finally {
          decoded.close();
        }
      }
    } catch (error) {
      state.screen.error = error?.message || 'Screen decode failed';
      state.screen.controller?.abort();
      renderScreenMode();
    } finally {
      state.screen.decodeBusy = false;
      if (state.screen.pendingFrame && state.screen.open) {
        queueScreenFrame(state.screen.pendingFrame.bytes, state.screen.pendingFrame.capturedAt);
      }
    }
  })();
}

function stopScreenVideoMetrics() {
  if (state.screen.videoFrameCallback && typeof els.screenVideo?.cancelVideoFrameCallback === 'function') {
    els.screenVideo.cancelVideoFrameCallback(state.screen.videoFrameCallback);
  }
  state.screen.videoFrameCallback = 0;
}

function startScreenVideoMetrics(generation) {
  stopScreenVideoMetrics();
  const video = els.screenVideo;
  if (!video) return;
  const markFrame = (_now, metadata = {}) => {
    if (generation !== state.screen.generation || !state.screen.open) return;
    state.screen.hasFrame = true;
    const nextWidth = Number(metadata.width) || video.videoWidth || state.screen.width;
    const nextHeight = Number(metadata.height) || video.videoHeight || state.screen.height;
    if (nextWidth !== state.screen.width || nextHeight !== state.screen.height) {
      state.screen.width = nextWidth;
      state.screen.height = nextHeight;
      syncScreenViewportGeometry();
    }
    els.screenPlaceholder.classList.add('hidden');
    updateScreenFrameMetrics(Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : video.currentTime);
    state.screen.videoFrameCallback = video.requestVideoFrameCallback(markFrame);
  };
  if (typeof video.requestVideoFrameCallback === 'function') {
    state.screen.videoFrameCallback = video.requestVideoFrameCallback(markFrame);
  } else {
    const onPlaying = () => {
      if (generation !== state.screen.generation) return;
      state.screen.hasFrame = true;
      els.screenPlaceholder.classList.add('hidden');
      updateScreenFrameMetrics(video.currentTime);
    };
    video.addEventListener('timeupdate', onPlaying, { signal: state.screen.controller?.signal });
  }
}

function resetScreenMedia() {
  stopScreenVideoMetrics();
  state.screen.appendQueue = [];
  state.screen.appendBytes = 0;
  const sourceBuffer = state.screen.sourceBuffer;
  state.screen.sourceBuffer = null;
  if (sourceBuffer?.updating) {
    try { sourceBuffer.abort(); } catch { }
  }
  const mediaSource = state.screen.mediaSource;
  state.screen.mediaSource = null;
  if (mediaSource?.readyState === 'open') {
    try { mediaSource.endOfStream(); } catch { }
  }
  const video = els.screenVideo;
  if (video) {
    video.pause?.();
    video.removeAttribute('src');
    video.load?.();
    video.classList.remove('hidden');
  }
  els.screenCanvas?.classList.add('hidden');
  if (state.screen.objectUrl) URL.revokeObjectURL(state.screen.objectUrl);
  state.screen.objectUrl = '';
}

function pumpScreenMedia() {
  const sourceBuffer = state.screen.sourceBuffer;
  if (!sourceBuffer || sourceBuffer.updating || !state.screen.appendQueue.length) return;
  const chunk = state.screen.appendQueue.shift();
  state.screen.appendBytes = Math.max(0, state.screen.appendBytes - chunk.byteLength);
  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (error) {
    state.screen.forceFrames = true;
    state.screen.error = error?.message || 'Could not append live screen video';
    state.screen.controller?.abort();
  }
}

function maintainScreenLiveEdge() {
  const sourceBuffer = state.screen.sourceBuffer;
  const video = els.screenVideo;
  if (!sourceBuffer || !video || sourceBuffer.updating || !sourceBuffer.buffered?.length) return false;
  try {
    const index = sourceBuffer.buffered.length - 1;
    const start = sourceBuffer.buffered.start(index);
    const end = sourceBuffer.buffered.end(index);
    const lag = end - video.currentTime;
    if (Number.isFinite(lag) && lag > SCREEN_LIVE_EDGE_MAX_LAG) {
      video.currentTime = Math.max(start, end - SCREEN_LIVE_EDGE_TARGET_LAG);
    }
    const removeBefore = video.currentTime - 1.25;
    if (removeBefore > start + 0.35) {
      sourceBuffer.remove(start, removeBefore);
      return true;
    }
  } catch { }
  return false;
}

async function prepareScreenMedia(response, generation) {
  if (!('MediaSource' in window)) throw new Error('This browser does not support low-latency screen video.');
  const codec = response.headers.get('x-opendraw-screen-codec') || 'avc1.42C020';
  const mime = `video/mp4; codecs="${codec}"`;
  if (!MediaSource.isTypeSupported(mime)) throw new Error('This browser cannot decode the live screen H.264 stream.');
  resetScreenMedia();
  const mediaSource = new MediaSource();
  state.screen.mediaSource = mediaSource;
  const objectUrl = URL.createObjectURL(mediaSource);
  state.screen.objectUrl = objectUrl;
  const video = els.screenVideo;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.src = objectUrl;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out preparing live screen video.')), 900);
    mediaSource.addEventListener('sourceopen', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  if (generation !== state.screen.generation) return null;
  const sourceBuffer = mediaSource.addSourceBuffer(mime);
  sourceBuffer.mode = 'segments';
  sourceBuffer.addEventListener('updateend', () => {
    if (generation !== state.screen.generation) return;
    if (maintainScreenLiveEdge()) return;
    pumpScreenMedia();
  });
  sourceBuffer.addEventListener('error', () => {
    if (generation !== state.screen.generation) return;
    state.screen.forceFrames = true;
    state.screen.error = 'Live screen decoder lost the stream. Reconnecting…';
    state.screen.controller?.abort();
  });
  state.screen.sourceBuffer = sourceBuffer;
  const startedAt = Number(response.headers.get('x-opendraw-screen-started-at'));
  const targetFps = Number(response.headers.get('x-opendraw-screen-target-fps'));
  state.screen.targetFps = normalizedScreenTargetFps(targetFps);
  state.screen.streamStartedAt = Number.isFinite(startedAt) ? startedAt : Date.now();
  state.screen.hasFrame = false;
  state.screen.frameTimes = [];
  state.screen.fps = 0;
  state.screen.latency = null;
  state.screen.hudLastAt = 0;
  state.screen.latencyStrikes = 0;
  startScreenVideoMetrics(generation);
  void video.play().catch(() => undefined);
  return sourceBuffer;
}

async function startScreenFrameFallback(generation) {
  if (generation !== state.screen.generation || !state.screen.open || document.hidden || !state.token) return;
  const controller = new AbortController();
  state.screen.controller = controller;
  state.screen.transport = 'frames';
  state.screen.connecting = true;
  state.screen.streaming = false;
  state.screen.error = '';
  resetScreenMedia();
  els.screenVideo?.classList.add('hidden');
  els.screenCanvas?.classList.remove('hidden');
  renderScreenMode();
  try {
    const response = await fetch('/api/screen/frames', {
      cache: 'no-store',
      headers: authHeaders(),
      signal: controller.signal
    });
    if (response.status === 401) {
      state.token = '';
      localStorage.removeItem('opendraw.deviceToken');
      showPairing();
      throw new Error('This device needs to pair again');
    }
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || body.error || `Screen frame stream failed (${response.status})`);
    }
    if (generation !== state.screen.generation) return;
    const targetFps = Number(response.headers.get('x-opendraw-screen-target-fps'));
    state.screen.targetFps = normalizedScreenTargetFps(targetFps);
    state.screen.available = true;
    state.screen.connecting = false;
    state.screen.streaming = true;
    state.screen.lastFrameAt = Date.now();
    state.screen.hasFrame = false;
    state.screen.pendingFrame = null;
    state.screen.frameTimes = [];
    state.screen.fps = 0;
    state.screen.latency = null;
    state.screen.latencyStrikes = 0;
    renderScreenMode();
    scheduleScreenWatchdog(generation);
    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);
    while (generation === state.screen.generation && state.screen.open) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      buffer = appendScreenBytes(buffer, value);
      let offset = 0;
      let latestStart = -1;
      let latestEnd = -1;
      let latestCapturedAt = 0;
      while (buffer.length - offset >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset, buffer.byteLength - offset);
        const length = view.getUint32(0, true);
        if (length < 1 || length > 8 * 1024 * 1024) throw new Error('Invalid desktop frame');
        if (buffer.length - offset < 12 + length) break;
        latestCapturedAt = view.getFloat64(4, true);
        latestStart = offset + 12;
        latestEnd = latestStart + length;
        offset += 12 + length;
      }
      if (latestStart >= 0) {
        // A network read can contain several completed JPEGs. Decode only the newest
        // one so phone CPU time is spent on the live edge rather than obsolete frames.
        const latestFrame = buffer.slice(latestStart, latestEnd);
        buffer = buffer.slice(offset);
        queueScreenFrame(latestFrame, latestCapturedAt);
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError' || generation !== state.screen.generation) return;
    state.screen.error = error?.message || 'Live screen disconnected';
  } finally {
    if (generation !== state.screen.generation) return;
    if (state.screen.controller === controller) state.screen.controller = null;
    state.screen.streaming = false;
    state.screen.connecting = false;
    clearScreenWatchdog();
    renderScreenMode();
    scheduleScreenReconnect();
  }
}

function scheduleScreenReconnect() {
  clearTimeout(state.screen.reconnectTimer);
  state.screen.reconnectTimer = null;
  if (!state.screen.open || document.hidden || !state.token) return;
  state.screen.reconnectTimer = setTimeout(() => {
    state.screen.reconnectTimer = null;
    startScreenStream();
  }, SCREEN_RECONNECT_MS);
}

function stopScreenStream({ keepOpen = true } = {}) {
  state.screen.generation += 1;
  state.screen.controller?.abort();
  state.screen.controller = null;
  clearTimeout(state.screen.reconnectTimer);
  state.screen.reconnectTimer = null;
  state.screen.streaming = false;
  state.screen.connecting = false;
  clearScreenWatchdog();
  state.screen.lastFrameAt = 0;
  state.screen.frameTimes = [];
  state.screen.fps = 0;
  state.screen.latency = null;
  state.screen.latencyStrikes = 0;
  state.screen.pendingFrame = null;
  state.screen.decodeBusy = false;
  resetScreenMedia();
  if (!keepOpen) state.screen.open = false;
  renderScreenMode();
}

function startScreenStream() {
  if (!state.screen.open || document.hidden || !state.token || state.screen.controller) return;
  const generation = ++state.screen.generation;
  if (state.screen.forceFrames || isMobileLayout()) {
    void startScreenFrameFallback(generation);
    return;
  }
  const controller = new AbortController();
  state.screen.controller = controller;
  state.screen.transport = 'h264';
  state.screen.connecting = true;
  state.screen.streaming = false;
  state.screen.error = '';
  renderScreenMode();
  void (async () => {
    let handedOffToFrames = false;
    let mediaPrepared = false;
    try {
      const response = await fetch('/api/screen/stream', {
        cache: 'no-store',
        headers: authHeaders(),
        signal: controller.signal
      });
      if (response.status === 401) {
        state.token = '';
        localStorage.removeItem('opendraw.deviceToken');
        showPairing();
        throw new Error('This device needs to pair again');
      }
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || body.error || `Screen stream failed (${response.status})`);
      }
      if (generation !== state.screen.generation) return;
      await prepareScreenMedia(response, generation);
      if (generation !== state.screen.generation) return;
      mediaPrepared = true;
      state.screen.available = true;
      state.screen.connecting = false;
      state.screen.streaming = true;
      state.screen.lastFrameAt = Date.now();
      renderScreenMode();
      scheduleScreenWatchdog(generation);
      const reader = response.body.getReader();
      while (generation === state.screen.generation && state.screen.open) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        state.screen.appendQueue.push(chunk);
        state.screen.appendBytes += chunk.byteLength;
        if (state.screen.appendBytes > SCREEN_H264_QUEUE_MAX_BYTES) throw new Error('SCREEN_LATENCY_RESET');
        pumpScreenMedia();
      }
    } catch (error) {
      if (error?.name === 'AbortError' || generation !== state.screen.generation) return;
      if ((!mediaPrepared || error?.message === 'SCREEN_LATENCY_RESET') && state.screen.open && state.token) {
        handedOffToFrames = true;
        state.screen.forceFrames = true;
        state.screen.error = '';
        if (state.screen.controller === controller) state.screen.controller = null;
        controller.abort();
        resetScreenMedia();
        void startScreenFrameFallback(generation);
        return;
      }
      if (error?.message !== 'SCREEN_LATENCY_RESET') state.screen.error = error?.message || 'Live screen disconnected';
    } finally {
      if (handedOffToFrames) return;
      if (generation !== state.screen.generation) return;
      state.screen.controller = null;
      state.screen.streaming = false;
      state.screen.connecting = false;
      clearScreenWatchdog();
      resetScreenMedia();
      renderScreenMode();
      scheduleScreenReconnect();
    }
  })();
}

function openScreenMode() {
  releaseTextFocus();
  closeSidebar();
  closeSessionSheet();
  closeConversationPanel();
  closeModelPicker();
  closeContextSheet();
  state.screen.open = true;
  state.screen.error = '';
  closeVisualViewer();
  state.visualObserver?.disconnect?.();
  state.visualObserver = null;
  renderScreenMode();
  renderTranscript({ preserveScroll: true });
  reconcileTranscriptAfterScreenLayout();
  startScreenStream();
}

function closeScreenMode() {
  releaseTextFocus(els.screenMode);
  stopScreenStream({ keepOpen: false });
  renderTranscript({ preserveScroll: true });
  reconcileTranscriptAfterScreenLayout();
}

function toggleScreenMode() {
  if (state.screen.open) {
    closeScreenMode();
    return;
  }
  openScreenMode();
}

function reconcileTranscriptAfterScreenLayout() {
  const epoch = state.scroll.epoch;
  requestAnimationFrame(() => {
    if (epoch !== state.scroll.epoch) return;
    if (state.scroll.followLatest) {
      state.scroll.programmaticUntil = performance.now() + 160;
      els.transcript.scrollTop = els.transcript.scrollHeight;
    } else if (state.scroll.anchor) {
      restoreTranscriptAnchor(state.scroll.anchor, { settle: false, epoch });
    }
    renderJumpLatest();
    syncActivePromptFromScroll({ force: true });
  });
}

function setConnection(kind, text) {
  els.connectionBadge.className = `connection-badge ${kind}`;
  const dot = document.createElement('span');
  const label = document.createElement('b');
  label.textContent = text;
  els.connectionBadge.replaceChildren(dot, label);
  els.connectionBadge.setAttribute('aria-label', text);
  state.online = kind === 'online';
}

function sessionTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function shortNumber(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return Intl.NumberFormat([], { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function activeSession() {
  if (state.draft) return null;
  return state.sessions.find((session) => session.id === state.activeId) || null;
}

const FALLBACK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'];

function selectionKey(kind, sessionId) {
  return `opendraw.${kind}.${sessionId}`;
}

function pendingSendKey(sessionId) {
  return `opendraw.pendingSend.${sessionId}`;
}

function readPendingSends(sessionId) {
  if (!sessionId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingSendKey(sessionId)) || 'null');
    const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
    return rows
      .filter((row) => row && typeof row.id === 'string' && typeof row.fingerprint === 'string')
      .map((row) => ({
        id: row.id,
        fingerprint: row.fingerprint,
        createdAt: Number.isFinite(row.createdAt) ? row.createdAt : null
      }));
  } catch {
    return [];
  }
}

function writePendingSends(sessionId, rows) {
  if (!sessionId) return;
  const clean = Array.isArray(rows) ? rows : [];
  if (!clean.length) localStorage.removeItem(pendingSendKey(sessionId));
  else localStorage.setItem(pendingSendKey(sessionId), JSON.stringify(clean));
}

function outboundFingerprint(session, text, model, reasoningEffort, mode = 'auto', screen = false) {
  return JSON.stringify({
    sessionId: session.id,
    conversationId: session.conversationId,
    text,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    mode,
    screen: screen === true
  });
}

function messageIdForAttempt(session, fingerprint) {
  const rows = readPendingSends(session.id);
  const saved = rows.find((row) => row.fingerprint === fingerprint);
  if (saved?.id) return saved.id;
  const id = crypto.randomUUID();
  rows.push({ id, fingerprint, createdAt: Date.now() });
  writePendingSends(session.id, rows);
  return id;
}

function clearPendingSend(sessionId, inputId = null) {
  if (!inputId) {
    localStorage.removeItem(pendingSendKey(sessionId));
    return;
  }
  writePendingSends(sessionId, readPendingSends(sessionId).filter((row) => row.id !== inputId));
}

function pendingSendForSession(sessionId) {
  return readPendingSends(sessionId)[0] || null;
}

function reconcilePendingSendReceipts(rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  for (const session of state.sessions) {
    const pendingRows = readPendingSends(session.id);
    for (const pending of pendingRows) {
      const receipt = rows.find((row) => row?.id === pending.id);
      if (!receipt || !sendReceiptTerminal(receipt)) continue;
      clearPendingSend(session.id, pending.id);
      if (!/fail|cancel/i.test(String(receipt.state || receipt.status || ''))) continue;
      const recovery = (() => {
        try { return JSON.parse(pending.fingerprint) || {}; } catch { return {}; }
      })();
      const recoveryText = recovery?.text || '';
      const sameSession = activeSession()?.id === session.id && !state.draft;
      if (sameSession && recoveryText && !els.messageInput.value.trim()) {
        els.messageInput.value = recoveryText;
        saveComposerDraft();
        resizeComposer();
        setSendStatus('A queued message did not send. Your text was restored.', 'bad');
      } else {
        showToast(`A queued message in ${session.title || 'a chat'} did not send.`, 'bad');
      }
    }
  }
}

function uniqueStrings(values, limit = 30) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeModelRow(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id.trim()) return null;
  const id = row.id.trim();
  return {
    id,
    label: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : id,
    efforts: uniqueStrings(row.efforts, 12),
    aliases: uniqueStrings(row.aliases, 20)
  };
}

function normalizeModelCatalog(data) {
  let rows = null;
  let catalogState = null;
  let source = null;
  if (Array.isArray(data?.models) && data.models.length) {
    rows = data.models;
    catalogState = data.state ?? null;
    source = 'live';
  } else if (data?.live && !Array.isArray(data.live) && Array.isArray(data.live.models) && data.live.models.length) {
    rows = data.live.models;
    catalogState = data.live.state ?? null;
    source = 'live';
  } else if (Array.isArray(data?.live) && data.live.length) {
    rows = data.live;
    source = 'live';
  } else if (data?.catalog && Array.isArray(data.catalog.models)) {
    rows = data.catalog.models;
    catalogState = data.catalog.state ?? null;
    source = 'durable';
  } else if (Array.isArray(data?.observed)) {
    rows = data.observed.map((row) => ({ id: row?.id, label: row?.id, efforts: [], aliases: [] }));
    source = 'observed';
  }
  const models = [];
  const seen = new Set();
  for (const row of rows || []) {
    const model = normalizeModelRow(row);
    if (!model || seen.has(model.id.toLowerCase())) continue;
    seen.add(model.id.toLowerCase());
    models.push(model);
  }
  return { models, state: catalogState, source };
}

function resolveCatalogModel(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const wanted = value.trim().toLowerCase();
  return state.modelCatalog.find((model) => model.id.toLowerCase() === wanted
    || model.label.toLowerCase() === wanted
    || model.aliases.some((alias) => alias.toLowerCase() === wanted)) || null;
}

function reasoningLabel(value) {
  if (!value) return 'Default';
  if (value === 'xhigh') return 'Extra high';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function updateComposerSummary() {
  if (!els.composerSummary) return;
  const selected = els.modelSelect.value;
  const model = resolveCatalogModel(selected);
  const modelName = model?.label || selected || 'COS default';
  const effort = els.reasoningSelect.value;
  els.composerSummary.textContent = effort ? `${modelName} · ${reasoningLabel(effort)}` : modelName;
  if (els.modelPickerButton) {
    els.modelPickerButton.title = `Model: ${modelName}${effort ? ` · ${reasoningLabel(effort)}` : ''}`;
    els.modelPickerButton.disabled = (!(activeSession() || state.draft) || state.draft?.submitted === true);
  }
}

function rebuildReasoningSelect({ preferSession = true } = {}) {
  const session = activeSession();
  const draft = state.draft;
  const model = resolveCatalogModel(els.modelSelect.value);
  const selectedRawModel = session?.selectedModel?.model || draft?.model || '';
  const sessionModel = resolveCatalogModel(selectedRawModel);
  const sessionMatches = Boolean((session || draft) && (model?.id || els.modelSelect.value)
    && (sessionModel?.id || selectedRawModel) === (model?.id || els.modelSelect.value));
  let efforts = model?.efforts?.length ? [...model.efforts] : [];
  const sessionEffort = session?.selectedModel?.reasoningEffort || draft?.reasoningEffort || null;
  if (!efforts.length) efforts = [...FALLBACK_EFFORTS];
  if (sessionMatches && sessionEffort && !efforts.includes(sessionEffort)) efforts.unshift(sessionEffort);
  efforts = uniqueStrings(efforts, 16);

  const stored = session ? localStorage.getItem(selectionKey('reasoning', session.id)) : null;
  const desired = stored && efforts.includes(stored)
    ? stored
    : (draft || preferSession) && sessionMatches && sessionEffort && efforts.includes(sessionEffort) ? sessionEffort : '';
  els.reasoningSelect.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = '';
  automatic.textContent = 'Default';
  els.reasoningSelect.append(automatic);
  for (const effort of efforts) {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = reasoningLabel(effort);
    els.reasoningSelect.append(option);
  }
  els.reasoningSelect.value = desired;
  els.reasoningSelect.disabled = !(session || draft) || draft?.submitted === true;
  if (draft) draft.reasoningEffort = desired || null;
  updateComposerSummary();
}

function rebuildModelControls({ preferSession = true } = {}) {
  const session = activeSession();
  const draft = state.draft;
  const sessionRaw = session?.selectedModel?.model || draft?.model || '';
  const resolved = resolveCatalogModel(sessionRaw);
  const stored = session ? localStorage.getItem(selectionKey('model', session.id)) : null;
  let desired = stored && resolveCatalogModel(stored)?.id;
  if (!desired && (preferSession || draft)) desired = resolved?.id || sessionRaw;
  if (!desired) desired = state.modelCatalog[0]?.id || '';

  const rows = [...state.modelCatalog];
  if (sessionRaw && !resolveCatalogModel(sessionRaw)) {
    rows.unshift({ id: sessionRaw, label: sessionRaw, efforts: [], aliases: [] });
  }
  els.modelSelect.replaceChildren();
  if (!rows.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'COS default';
    els.modelSelect.append(option);
  } else {
    for (const model of rows) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      option.title = model.aliases.length ? `${model.id} · aliases: ${model.aliases.join(', ')}` : model.id;
      els.modelSelect.append(option);
    }
  }
  if ([...els.modelSelect.options].some((option) => option.value === desired)) els.modelSelect.value = desired;
  els.modelSelect.title = state.modelCatalogSource === 'live'
    ? 'Live Chat On Steroids model catalog'
    : state.modelCatalogSource === 'durable' ? 'Saved Chat On Steroids model catalog' : 'Observed Chat On Steroids models';
  els.modelSelect.disabled = (!(session || draft) || rows.length === 0 || draft?.submitted === true);
  if (draft) draft.model = els.modelSelect.value || null;
  rebuildReasoningSelect({ preferSession });
  if (state.modelPickerOpen) renderModelPicker();
}

function modelRowsForPicker() {
  const session = activeSession();
  const draft = state.draft;
  const currentRaw = session?.selectedModel?.model || draft?.model || els.modelSelect.value || '';
  const rows = [...state.modelCatalog];
  if (currentRaw && !resolveCatalogModel(currentRaw)) rows.unshift({ id: currentRaw, label: currentRaw, efforts: [], aliases: [] });
  return rows;
}

function applyModelSelection(modelId) {
  if (![...els.modelSelect.options].some((option) => option.value === modelId)) return;
  els.modelSelect.value = modelId;
  const session = activeSession();
  if (session) localStorage.setItem(selectionKey('model', session.id), modelId);
  if (state.draft) state.draft.model = modelId || null;
  rebuildReasoningSelect({ preferSession: false });
  updateComposerSummary();
  saveComposerDraft();
  renderModelPicker();
}

function applyReasoningSelection(value) {
  if (![...els.reasoningSelect.options].some((option) => option.value === value)) return;
  els.reasoningSelect.value = value;
  const session = activeSession();
  if (session) localStorage.setItem(selectionKey('reasoning', session.id), value);
  if (state.draft) state.draft.reasoningEffort = value || null;
  updateComposerSummary();
  saveComposerDraft();
  renderModelPicker();
}

function renderModelPicker() {
  if (!els.modelPickerBackdrop) return;
  if (!state.modelPickerOpen) {
    els.modelPickerBackdrop.classList.add('hidden');
    return;
  }
  els.modelPickerBackdrop.classList.remove('hidden');
  const query = els.modelSearchInput.value.trim().toLowerCase();
  const rows = modelRowsForPicker().filter((model) => !query
    || model.label.toLowerCase().includes(query)
    || model.id.toLowerCase().includes(query)
    || (Array.isArray(model.aliases) && model.aliases.some((alias) => alias.toLowerCase().includes(query))));
  els.modelPickerList.replaceChildren();
  els.modelPickerMeta.textContent = state.modelCatalogSource === 'live'
    ? 'Live COS catalog'
    : state.modelCatalogSource === 'durable' ? 'Saved COS catalog' : 'Observed in COS';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = query ? 'No models match this search.' : 'No model catalog is available right now.';
    els.modelPickerList.append(empty);
  }
  for (const model of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-picker-row${els.modelSelect.value === model.id ? ' selected' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(els.modelSelect.value === model.id));
    const icon = document.createElement('span');
    icon.className = 'model-picker-row-icon';
    icon.textContent = String(model.label || model.id || 'M').trim().slice(0, 1).toUpperCase() || 'M';
    const copy = document.createElement('span');
    copy.className = 'model-picker-row-copy';
    const title = document.createElement('strong');
    title.textContent = model.label;
    const id = document.createElement('small');
    id.textContent = model.id === model.label ? 'Available in Chat On Steroids' : model.id;
    copy.append(title, id);
    const check = document.createElement('span');
    check.className = 'model-picker-check';
    if (els.modelSelect.value === model.id) check.append(createUiIcon('check'));
    button.append(icon, copy, check);
    button.addEventListener('click', () => applyModelSelection(model.id));
    els.modelPickerList.append(button);
  }

  els.reasoningPickerList.replaceChildren();
  for (const option of els.reasoningSelect.options) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `reasoning-chip${els.reasoningSelect.value === option.value ? ' selected' : ''}`;
    chip.textContent = option.textContent;
    chip.setAttribute('aria-pressed', String(els.reasoningSelect.value === option.value));
    chip.addEventListener('click', () => applyReasoningSelection(option.value));
    els.reasoningPickerList.append(chip);
  }
}

function openModelPicker() {
  if (!(activeSession() || (state.draft && !state.draft.submitted))) return;
  releaseTextFocus();
  closeSidebar();
  closeSessionSheet();
  closeConversationPanel();
  closeContextSheet();
  state.modelPickerOpen = true;
  els.modelPickerSheet?._resetDismissGesture?.();
  els.modelSearchInput.value = '';
  renderModelPicker();
  focusTextControl(els.modelSearchInput);
}

function closeModelPicker() {
  releaseTextFocus(els.modelPickerSheet);
  els.modelPickerSheet?._resetDismissGesture?.();
  state.modelPickerOpen = false;
  els.modelPickerBackdrop?.classList.add('hidden');
  if (els.modelSearchInput) els.modelSearchInput.value = '';
}

function providerLabel(session) {
  return session?.selectedModel?.provider?.label || 'Unknown';
}

function modelLabel(session) {
  return session?.selectedModel?.model || 'Unknown model';
}

function sessionStateLabel(session) {
  const value = session?.activity?.state;
  if (value === 'active') return 'Active turn';
  if (value === 'idle') return 'Live · idle';
  if (value === 'ended') return 'Ended';
  return session?.live ? 'Live' : 'History';
}

const UNGROUPED_PROJECT = '__ungrouped__';
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function availableProjects() {
  return Array.isArray(state.cosInfo?.projects) ? state.cosInfo.projects : [];
}

function navigableProjects() {
  return availableProjects().filter((project) => project?.ungrouped !== true);
}

function isRemovedProject(projectId) {
  return Boolean(projectId && availableProjects().find((project) => project?.id === projectId)?.ungrouped === true);
}

function sessionProjectKey(session) {
  if (session?.projectId && !isRemovedProject(session.projectId)) return session.projectId;
  return UNGROUPED_PROJECT;
}

function projectByKey(key) {
  if (!key || key === 'all') return null;
  if (key === UNGROUPED_PROJECT) return { id: UNGROUPED_PROJECT, name: 'Ungrouped', ungrouped: true };
  return navigableProjects().find((project) => project?.id === key) || null;
}

function projectNameForSession(session) {
  const key = sessionProjectKey(session);
  const project = projectByKey(key);
  if (project?.name) return project.name;
  if (!session?.projectId) return 'Ungrouped';
  return `Project ${String(session.projectId).slice(0, 8)}`;
}

function projectTargetId(key) {
  if (!key || key === 'all' || key === UNGROUPED_PROJECT) return null;
  const project = navigableProjects().find((item) => item.id === key);
  if (project?.id) return project.id;
  // During initial boot the live project catalog may not have arrived yet. Preserve an
  // exact durable project id rather than silently creating the chat in Ungrouped; the
  // server performs the authoritative live-project validation before sending.
  if (!availableProjects().length && PROJECT_UUID.test(key)) return key;
  return null;
}

function projectNameFromKey(key) {
  if (!key || key === UNGROUPED_PROJECT) return 'Ungrouped';
  return projectByKey(key)?.name || `Project ${String(key).slice(0, 8)}`;
}

function isMobileLayout() {
  return window.matchMedia?.('(max-width: 760px)').matches === true;
}

function composerDraftTargetKey() {
  if (state.draft) return state.draft.storageKey || `new:${state.draft.projectId || UNGROUPED_PROJECT}`;
  return state.activeId ? `session:${state.activeId}` : null;
}

function newChatDraftBaseKey(projectId) {
  return `new:${projectId || UNGROUPED_PROJECT}`;
}

function newChatDraftStorageKey(projectId, preferredKey = null) {
  const base = newChatDraftBaseKey(projectId);
  if (preferredKey === base || preferredKey?.startsWith(`${base}:`)) return preferredKey;

  const pendingKey = state.pendingNewChat?.draftKey || null;
  const candidates = Object.entries(readComposerDrafts())
    .filter(([key, value]) => key !== pendingKey
      && (key === base || key.startsWith(`${base}:`))
      && value && typeof value.text === 'string' && value.text)
    .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0));
  if (candidates.length) return candidates[0][0];
  return pendingKey === base ? `${base}:${crypto.randomUUID()}` : base;
}

function readComposerDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPOSER_DRAFTS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeComposerDrafts(drafts) {
  try {
    const entries = Object.entries(drafts)
      .filter(([, value]) => value && typeof value === 'object')
      .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0))
      .slice(0, MAX_SAVED_COMPOSER_DRAFTS);
    localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* Storage can be unavailable in private/locked browser contexts. */ }
}

function savedComposerDraft(key = composerDraftTargetKey()) {
  if (!key) return null;
  const row = readComposerDrafts()[key];
  return row && typeof row.text === 'string' ? row : null;
}

function clearStoredComposerDraft(key) {
  if (!key) return;
  const drafts = readComposerDrafts();
  if (!(key in drafts)) return;
  delete drafts[key];
  writeComposerDrafts(drafts);
}

function rememberComposerTarget(key = composerDraftTargetKey()) {
  if (!key) return;
  try { localStorage.setItem(COMPOSER_TARGET_KEY, key); } catch { /* optional QoL state */ }
}

function saveComposerDraft({ clear = false, key = composerDraftTargetKey() } = {}) {
  if (!key || !els.messageInput) return;
  rememberComposerTarget(key);
  const drafts = readComposerDrafts();
  const text = clear ? '' : els.messageInput.value.slice(0, Number(els.messageInput.maxLength) || 16_000);
  if (!text) {
    delete drafts[key];
  } else {
    drafts[key] = {
      text,
      updatedAt: Date.now(),
      model: state.draft ? (els.modelSelect.value || state.draft.model || null) : null,
      reasoningEffort: state.draft ? (els.reasoningSelect.value || state.draft.reasoningEffort || null) : null,
      projectId: state.draft ? (state.draft.projectId || null) : null
    };
  }
  writeComposerDrafts(drafts);
}

function settleSentComposerTarget(targetKey, sentText) {
  const sameTarget = composerDraftTargetKey() === targetKey;
  if (!sameTarget) {
    const saved = savedComposerDraft(targetKey);
    if (saved?.text === sentText) clearStoredComposerDraft(targetKey);
    return { sameTarget: false, hasRemainingText: false };
  }

  if (els.messageInput.value === sentText) {
    clearStoredComposerDraft(targetKey);
    els.messageInput.value = '';
    resizeComposer();
    return { sameTarget: true, hasRemainingText: false };
  }

  saveComposerDraft({ key: targetKey });
  resizeComposer();
  return { sameTarget: true, hasRemainingText: Boolean(els.messageInput.value.trim()) };
}

function scheduleComposerDraftSave() {
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(() => {
    state.draftSaveTimer = null;
    saveComposerDraft();
  }, 140);
}

function restoreComposerDraft({ key = composerDraftTargetKey(), preferCurrent = false } = {}) {
  if (!key || !els.messageInput || (preferCurrent && els.messageInput.value)) return;
  rememberComposerTarget(key);
  const saved = savedComposerDraft(key);
  els.messageInput.value = saved?.text || '';
  if (state.draft && saved) {
    if (saved.model) state.draft.model = saved.model;
    if (saved.reasoningEffort) state.draft.reasoningEffort = saved.reasoningEffort;
  }
  resizeComposer();
}

function avoidProgrammaticTextFocus() {
  return isMobileLayout() || window.matchMedia?.('(pointer: coarse)').matches === true;
}

function focusTextControl(control) {
  if (!control || avoidProgrammaticTextFocus()) return;
  requestAnimationFrame(() => control.focus({ preventScroll: true }));
}

function releaseTextFocus(container = null) {
  const active = document.activeElement;
  const isTextControl = active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active?.isContentEditable === true;
  if (!isTextControl) return;
  if (!container || container.contains(active)) active.blur();
}

function pointInsideElement(element, clientX, clientY) {
  const rect = element?.getBoundingClientRect?.();
  return Boolean(rect && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
}

function bindDragSafeActivation(element, activate, { moveTolerance = 12 } = {}) {
  if (!element || typeof activate !== 'function') return;
  let pointer = null;
  let suppressClickUntil = 0;

  element.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button > 0) return;
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false
    };
    try { element.setPointerCapture?.(event.pointerId); } catch { /* capture is best effort */ }
  });

  element.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > moveTolerance) pointer.moved = true;
  });

  const finishPointer = (event, cancelled = false) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const shouldSuppress = cancelled || pointer.moved || !pointInsideElement(element, event.clientX, event.clientY);
    pointer = null;
    try { element.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    if (shouldSuppress) suppressClickUntil = performance.now() + 650;
  };
  element.addEventListener('pointerup', (event) => finishPointer(event, false));
  element.addEventListener('pointercancel', (event) => finishPointer(event, true));

  element.addEventListener('click', (event) => {
    if (performance.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    activate(event);
  });
}

function installDismissGesture({ surface, backdrop = null, axis = 'y', close, startSelector = '.panel-drag-handle' }) {
  if (!surface || typeof close !== 'function') return;
  let drag = null;
  let dragRaf = 0;

  const resetVisuals = () => {
    if (dragRaf) cancelAnimationFrame(dragRaf);
    dragRaf = 0;
    drag = null;
    surface.classList.remove('panel-dragging');
    surface.style.removeProperty('transform');
    surface.style.removeProperty('transition');
    if (backdrop) {
      backdrop.style.removeProperty('opacity');
    }
  };

  const paintDrag = (snapshot = drag) => {
    if (!snapshot?.locked) return;
    surface.style.transform = axis === 'x'
      ? `translate3d(${Math.round(snapshot.distance)}px,0,0)`
      : `translate3d(0,${Math.round(snapshot.distance)}px,0)`;
    if (backdrop) {
      const progress = Math.min(1, Math.abs(snapshot.distance) / Math.max(1, snapshot.size));
      backdrop.style.opacity = String(Math.max(0.2, 1 - progress * 0.72));
    }
  };

  const scheduleDragPaint = () => {
    if (dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
      dragRaf = 0;
      paintDrag();
    });
  };

  const animateTo = (distance, duration = 125, done = null) => {
    surface.classList.remove('panel-dragging');
    surface.style.transition = `transform ${duration}ms cubic-bezier(.2,.78,.22,1)`;
    surface.style.transform = axis === 'x'
      ? `translate3d(${Math.round(distance)}px,0,0)`
      : `translate3d(0,${Math.round(distance)}px,0)`;
    window.setTimeout(() => {
      resetVisuals();
      done?.();
    }, duration + 16);
  };

  const onPointerDown = (event) => {
    if (!isMobileLayout() || !event.isPrimary || event.button > 0) return;
    if (startSelector && !event.target.closest(startSelector)) return;
    const rect = surface.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      size: axis === 'x' ? Math.max(1, rect.width) : Math.max(1, rect.height),
      startAt: performance.now(),
      lastX: event.clientX,
      lastY: event.clientY,
      lastAt: performance.now(),
      locked: false,
      distance: 0,
      velocity: 0
    };
  };

  const onPointerMove = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const primary = axis === 'x' ? dx : dy;
    const cross = axis === 'x' ? dy : dx;
    if (!drag.locked) {
      if (Math.hypot(dx, dy) < 7) return;
      if (Math.abs(primary) < Math.abs(cross) * 1.05) {
        drag = null;
        return;
      }
      if (primary <= 0 && axis === 'y') {
        drag = null;
        return;
      }
      if (primary >= 0 && axis === 'x') {
        drag = null;
        return;
      }
      drag.locked = true;
      try { surface.setPointerCapture?.(event.pointerId); } catch { /* best effort */ }
      surface.classList.add('panel-dragging');
    }
    const now = performance.now();
    const elapsed = Math.max(1, now - drag.lastAt);
    const delta = axis === 'x' ? event.clientX - drag.lastX : event.clientY - drag.lastY;
    drag.velocity = delta / elapsed;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.lastAt = now;
    drag.distance = axis === 'x' ? Math.min(0, dx) : Math.max(0, dy);
    scheduleDragPaint();
    event.preventDefault();
  };

  const finish = (event, cancelled = false) => {
    if (!drag || event.pointerId !== drag.id) return;
    const held = drag;
    drag = null;
    if (dragRaf) {
      cancelAnimationFrame(dragRaf);
      dragRaf = 0;
      paintDrag(held);
    }
    try { surface.releasePointerCapture?.(event.pointerId); } catch { /* already released */ }
    if (!held.locked) return;
    const size = held.size;
    const distance = Math.abs(held.distance);
    const outwardVelocity = axis === 'x' ? -held.velocity : held.velocity;
    const shouldClose = !cancelled && (distance >= Math.min(100, size * 0.26) || outwardVelocity > 0.58);
    if (shouldClose) {
      const target = axis === 'x' ? -Math.max(size + 24, window.innerWidth) : Math.max(size + 24, window.innerHeight);
      animateTo(target, 105, close);
    } else {
      animateTo(0, 125);
    }
  };

  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove, { passive: false });
  surface.addEventListener('pointerup', (event) => finish(event, false));
  surface.addEventListener('pointercancel', (event) => finish(event, true));
  surface._resetDismissGesture = resetVisuals;
}

function projectEntries() {
  const counts = new Map();
  for (const session of state.sessions) {
    const key = sessionProjectKey(session);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const entries = navigableProjects().map((project) => ({
    key: project.id,
    name: project.name || 'Project',
    count: counts.get(project.id) || 0,
    ungrouped: false
  }));
  for (const [key, count] of counts) {
    if (entries.some((entry) => entry.key === key)) continue;
    entries.push({ key, name: key === UNGROUPED_PROJECT ? 'Ungrouped' : `Project ${String(key).slice(0, 8)}`, count, ungrouped: key === UNGROUPED_PROJECT });
  }
  if (state.draft && !state.draft.projectId && !entries.some((entry) => entry.key === UNGROUPED_PROJECT)) {
    entries.push({ key: UNGROUPED_PROJECT, name: 'Ungrouped', count: 0, ungrouped: true });
  }
  return entries.sort((a, b) => {
    const current = activeSession();
    const activeKey = state.draft ? (state.draft.projectId || UNGROUPED_PROJECT) : current ? sessionProjectKey(current) : null;
    if (a.key === activeKey && b.key !== activeKey) return -1;
    if (b.key === activeKey && a.key !== activeKey) return 1;
    if (a.ungrouped !== b.ungrouped) return a.ungrouped ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function setProjectFilter(key) {
  state.projectFilter = key || 'all';
  localStorage.setItem('opendraw.projectFilter', state.projectFilter);
  renderProjectNav();
  renderSessions();
}

function renderProjectNav() {
  els.projectNav.replaceChildren();
  const entries = projectEntries();
  if (state.projectFilter !== 'all' && !entries.some((entry) => entry.key === state.projectFilter)) {
    state.projectFilter = 'all';
    localStorage.setItem('opendraw.projectFilter', 'all');
  }
  const all = document.createElement('button');
  all.type = 'button';
  all.className = `project-chip${state.projectFilter === 'all' ? ' active' : ''}`;
  all.append(createUiIcon('layers', 'project-chip-icon'));
  const allName = document.createElement('span');
  allName.textContent = 'All chats';
  const allCount = document.createElement('small');
  allCount.textContent = String(state.sessions.length);
  all.append(allName, allCount);
  all.addEventListener('click', () => setProjectFilter('all'));
  els.projectNav.append(all);
  for (const entry of entries) {
    const wrap = document.createElement('div');
    wrap.className = 'project-chip-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-chip${state.projectFilter === entry.key ? ' active' : ''}`;
    button.title = entry.name;
    button.append(createUiIcon('folder', 'project-chip-icon'));
    const name = document.createElement('span');
    name.textContent = entry.name;
    const count = document.createElement('small');
    count.textContent = String(entry.count);
    button.append(name, count);
    button.addEventListener('click', () => setProjectFilter(entry.key));
    wrap.append(button);
    els.projectNav.append(wrap);
  }
}

function createSessionButton(session) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `session-item${!state.draft && session.id === state.activeId ? ' active' : ''}`;
  button.dataset.id = session.id;
  const row = document.createElement('div');
  row.className = 'row';
  const dot = document.createElement('span');
  dot.className = `live-dot${session.live ? ' live' : ''}`;
  const title = document.createElement('strong');
  title.textContent = session.title;
  row.append(dot, title);
  const meta = document.createElement('small');
  const model = document.createElement('span');
  model.textContent = `${providerLabel(session)} · ${modelLabel(session)}`;
  const time = document.createElement('span');
  time.textContent = sessionTime(session.updatedAt);
  meta.append(model, time);
  button.append(row, meta);
  button.addEventListener('click', () => selectSession(session.id));
  return button;
}

function renderSessions() {
  const query = els.sessionSearch.value.trim().toLowerCase();
  els.sessionList.replaceChildren();
  const filtered = state.sessions.filter((session) => {
    if (state.projectFilter !== 'all' && sessionProjectKey(session) !== state.projectFilter) return false;
    if (!query) return true;
    return `${session.title} ${modelLabel(session)} ${providerLabel(session)} ${projectNameForSession(session)}`.toLowerCase().includes(query);
  });
  const grouped = new Map();
  for (const session of filtered) {
    const key = sessionProjectKey(session);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(session);
  }
  const entries = projectEntries();
  const visibleEntries = state.projectFilter === 'all' ? entries : entries.filter((entry) => entry.key === state.projectFilter);
  const orderedKeys = query
    ? visibleEntries.map((entry) => entry.key).filter((key) => grouped.has(key))
    : visibleEntries.map((entry) => entry.key);
  for (const key of grouped.keys()) if (!orderedKeys.includes(key)) orderedKeys.push(key);
  for (const key of orderedKeys) {
    const sessions = grouped.get(key) || [];
    const section = document.createElement('section');
    section.className = 'session-group';
    section.setAttribute('role', 'group');
    const heading = document.createElement('div');
    heading.className = 'session-group-heading';
    heading.append(createUiIcon(key === UNGROUPED_PROJECT ? 'layers' : 'folder', 'session-group-icon'));
    const name = document.createElement('strong');
    const project = projectByKey(key);
    name.textContent = project?.name || (key === UNGROUPED_PROJECT ? 'Ungrouped' : `Project ${String(key).slice(0, 8)}`);
    const count = document.createElement('span');
    count.textContent = String(sessions.length);
    heading.append(name, count);
    const canTarget = key === UNGROUPED_PROJECT || PROJECT_UUID.test(key);
    if (canTarget) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'session-group-add';
      add.textContent = 'New';
      add.setAttribute('aria-label', `New chat in ${name.textContent}`);
      add.addEventListener('click', () => beginNewChat(key));
      heading.append(add);
    }
    section.append(heading);
    for (const session of sessions) section.append(createSessionButton(session));
    if (!sessions.length && !query) {
      const empty = document.createElement('div');
      empty.className = 'session-group-empty';
      empty.textContent = 'No chats yet';
      section.append(empty);
    }
    els.sessionList.append(section);
  }
  if (!filtered.length && !orderedKeys.length) {
    const empty = document.createElement('div');
    empty.className = 'session-list-empty';
    empty.textContent = query ? 'No chats match this search.' : 'No chats in this project yet.';
    els.sessionList.append(empty);
  }
}

function renderMobileToolbar() {
  const session = activeSession();
  const draftKey = state.draft ? (state.draft.projectId || UNGROUPED_PROJECT) : null;
  const projectName = state.draft ? projectNameFromKey(draftKey) : session ? projectNameForSession(session) : 'Choose project';
  els.mobileProjectName.textContent = projectName;
  els.mobileProjectButton.title = session || state.draft ? `Open ${projectName}` : 'Open projects';
  els.mobileProjectButton.setAttribute('aria-label', session || state.draft ? `Open chats in ${projectName}` : 'Open projects');
  const key = state.draft ? draftKey : session ? sessionProjectKey(session) : null;
  const count = key ? state.sessions.filter((item) => sessionProjectKey(item) === key).length : state.sessions.length;
  els.mobileSessionCount.textContent = `${count} ${count === 1 ? 'chat' : 'chats'}`;
}

function beginNewChat(projectKey = null, { storageKey = null } = {}) {
  releaseTextFocus();
  flushWordReveals();
  if (!state.sendInFlight && !state.connectionRetryBusy) {
    clearTimeout(state.sendUiTimer);
    state.sendUiTimer = null;
    state.sendUiState = 'idle';
  }
  const current = activeSession();
  const requestedKey = projectKey && projectKey !== 'all'
    ? projectKey
    : !isMobileLayout() && state.projectFilter !== 'all'
      ? state.projectFilter
      : current ? sessionProjectKey(current) : UNGROUPED_PROJECT;
  const projectId = projectTargetId(requestedKey);
  if (requestedKey !== UNGROUPED_PROJECT && requestedKey !== 'all' && !projectId && availableProjects().length) {
    setProjectFilter('all');
    showToast('That project is no longer available in Chat On Steroids.', 'bad');
    closeSidebar();
    return;
  }
  rememberSessionScroll();
  saveComposerDraft();
  const draftStorageKey = newChatDraftStorageKey(projectId, storageKey);
  const saved = savedComposerDraft(draftStorageKey);
  const seedModel = saved?.model || els.modelSelect.value || current?.selectedModel?.model || state.modelCatalog[0]?.id || null;
  const seedReasoning = saved?.reasoningEffort || els.reasoningSelect.value || current?.selectedModel?.reasoningEffort || null;
  stopVoiceRecognition();
  stopMessageStream();
  closeSessionSheet();
  closeConversationPanel();
  state.draft = {
    projectId,
    storageKey: draftStorageKey,
    model: seedModel,
    reasoningEffort: seedReasoning,
    firstText: '',
    pendingId: null,
    pendingFingerprint: null,
    submitted: false
  };
  state.activeId = '';
  state.messages = [];
  state.messageSignature = '';
  clearVisualObjectUrls();
  state.activity = { plan: null, tools: [], visuals: [], responses: [], agents: [] };
  state.activityFor = '';
  state.activityRevision = null;
  state.activityTimelineSignature = '';
  state.lastLiveActivityRefresh = 0;
  state.controls = null;
  state.queue = [];
  restoreComposerDraft({ key: draftStorageKey });
  setSendStatus('');
  renderProjectNav();
  renderSessions();
  rebuildModelControls({ preferSession: true });
  renderHeader();
  renderCosInfo();
  renderTranscript();
  closeSidebar();
  focusTextControl(els.messageInput);
}

function migrateCompletedNewChatDraft(sourceKey, sessionId, visibleText = '') {
  const destinationKey = `session:${sessionId}`;
  const drafts = readComposerDrafts();
  const source = drafts[sourceKey];
  const carryText = visibleText || source?.text || '';
  if (!carryText) {
    if (sourceKey in drafts) {
      delete drafts[sourceKey];
      writeComposerDrafts(drafts);
    }
    return { moved: false, conflict: false, destinationKey };
  }

  // If the delivered session is already visible, its live textarea is authoritative even
  // when currently empty (a pending debounced clear must not later erase migrated text).
  const destinationVisible = composerDraftTargetKey() === destinationKey;
  const destinationSaved = drafts[destinationKey];
  if (destinationVisible || destinationSaved?.text) {
    return { moved: false, conflict: true, destinationKey };
  }

  drafts[destinationKey] = {
    ...(source && typeof source === 'object' ? source : {}),
    text: carryText,
    updatedAt: Date.now(),
    model: null,
    reasoningEffort: null,
    projectId: null
  };
  delete drafts[sourceKey];
  writeComposerDrafts(drafts);
  return { moved: true, conflict: false, destinationKey };
}

function finalizePendingNewChat() {
  const pending = state.pendingNewChat;
  const sessionId = pending?.resolvedSessionId;
  if (!pending || !sessionId) return false;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return false;
  const visiblePendingDraft = state.draft?.pendingId === pending.id;
  const completedDraftKey = pending.draftKey || newChatDraftBaseKey(pending.projectId);
  state.pendingNewChat = null;
  if (!visiblePendingDraft) {
    const migration = migrateCompletedNewChatDraft(completedDraftKey, sessionId);
    showToast(`New chat ready: ${session.title}`, 'good');
    if (migration.conflict) showToast('Kept your newer draft in the created chat; the earlier follow-up draft was preserved separately.', 'good');
    renderSessions();
    return true;
  }
  const carryText = els.messageInput.value;
  const migration = migrateCompletedNewChatDraft(completedDraftKey, sessionId, carryText);
  const nextDraftKey = migration.destinationKey;
  state.draft = null;
  state.activeId = sessionId;
  localStorage.setItem('opendraw.activeSession', sessionId);
  state.messages = [];
  state.messageSignature = '';
  state.lastFullMessageRefresh = 0;
  clearVisualObjectUrls();
  state.activity = { plan: null, tools: [], visuals: [], responses: [], agents: [] };
  state.activityFor = '';
  state.activitySignature = '';
  state.activityRevision = null;
  state.activityTimelineSignature = '';
  state.lastLiveActivityRefresh = 0;
  state.scroll = { atBottom: true, followLatest: true, unread: 0, activePromptId: null, raf: 0, programmaticUntil: 0, anchor: null, userIntent: false, epoch: 0 };
  restoreComposerDraft({ key: nextDraftKey });
  setSendStatus('New chat created', 'good');
  showToast('New chat created', 'good');
  if (migration.conflict) showToast('Kept your newer draft in this chat; the earlier follow-up draft was preserved separately.', 'good');
  setTimeout(() => setSendStatus(''), 2200);
  renderProjectNav();
  renderSessions();
  rebuildModelControls();
  renderHeader();
  renderTranscript();
  void Promise.all([
    refreshMessages({ force: true, preserveScroll: false }),
    refreshActivity(),
    refreshCosInfo()
  ]).finally(() => startMessageStream());
  return true;
}

function resolvePendingNewChat(rows) {
  const pending = state.pendingNewChat;
  if (!pending || !Array.isArray(rows)) return false;
  const row = rows.find((item) => item?.id === pending.id);
  if (!row) return false;
  if (row && ['failed', 'cancelled'].includes(row.state)) {
    const draft = state.draft?.pendingId === pending.id ? state.draft : null;
    state.pendingNewChat = null;
    if (draft) {
      draft.submitted = false;
      draft.pendingId = null;
      draft.pendingFingerprint = null;
      if (!els.messageInput.value && pending.firstText) {
        els.messageInput.value = pending.firstText;
        saveComposerDraft();
        resizeComposer();
      }
      rebuildModelControls({ preferSession: true });
      renderHeader();
    }
    const message = row.error || 'The new chat was not delivered. You can retry safely.';
    setSendStatus(message, 'bad');
    showToast(message, 'bad');
    return false;
  }
  const sessionId = row?.deliveredSessionId || row?.sessionId || null;
  if (!sessionId) return false;
  pending.resolvedSessionId = sessionId;
  return finalizePendingNewChat();
}

function addFact(label, value, kind = '') {
  const item = document.createElement('div');
  item.className = `fact${kind ? ` ${kind}` : ''}`;
  const small = document.createElement('span');
  small.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value;
  item.append(small, strong);
  els.sessionFacts.append(item);
}

function addCosInfo(label, value, kind = '', title = '') {
  if (!value) return;
  const item = document.createElement('div');
  item.className = `cos-info-chip${kind ? ` ${kind}` : ''}`;
  if (title) item.title = title;
  const small = document.createElement('span');
  small.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value;
  item.append(small, strong);
  els.cosInfo.append(item);
}

function deliveryLabel(row) {
  if (!row) return null;
  const stateLabel = {
    sent: 'Sent',
    queued: 'Queued',
    browser: 'Sending',
    tool: 'Sending',
    failed: 'Failed',
    cancelled: 'Cancelled'
  }[row.state] || (row.state ? row.state.charAt(0).toUpperCase() + row.state.slice(1) : 'Pending');
  const at = row.deliveredAt || row.offeredAt || row.createdAt;
  return `${stateLabel}${at ? ` · ${sessionTime(at)}` : ''}`;
}

function settingsLabel(settings) {
  if (!settings) return null;
  const parts = [settings.readOnly ? 'Read-only' : 'Writable'];
  if (settings.compaction?.auto) parts.push('Auto compact');
  if (settings.multiAgent?.enabled) parts.push(settings.multiAgent.maxWorkers ? `${settings.multiAgent.maxWorkers} workers` : 'Workers on');
  else if (settings.ui?.backgroundChats) parts.push('Background chats');
  return parts.slice(0, 3).join(' · ');
}

function settingsTitle(settings) {
  if (!settings) return '';
  const parts = [settings.readOnly ? 'COS read-only mode is enabled' : 'COS read/write mode'];
  if (settings.ui?.backgroundChats) parts.push('background chats enabled');
  if (settings.ui?.browserOnly) parts.push('browser-only mode');
  if (settings.ui?.autoConnect) parts.push('auto-connect enabled');
  if (settings.compaction?.auto) parts.push('automatic compaction enabled');
  if (settings.tunnel?.kind) parts.push(`tunnel: ${settings.tunnel.kind}`);
  return parts.join(' · ');
}

function renderCosInfo() {
  const info = state.cosInfo;
  const session = activeSession();
  const draft = state.draft;
  els.cosInfo.replaceChildren();
  if ((!session && !draft) || !info?.available) {
    els.cosInfo.classList.add('hidden');
    return;
  }

  addCosInfo('Project', draft ? projectNameFromKey(draft.projectId || UNGROUPED_PROJECT) : projectNameForSession(session));

  const lastDelivery = Array.isArray(info.outbox)
    ? (draft ? (draft.pendingId ? info.outbox.find((row) => row?.id === draft.pendingId) || null : null) : info.outbox[0] || null)
    : null;
  const deliveryKind = lastDelivery?.state === 'failed' ? 'bad'
    : lastDelivery?.state === 'sent' ? 'good'
      : lastDelivery ? 'warn' : '';
  addCosInfo('Last send', deliveryLabel(lastDelivery) || 'No recent delivery', deliveryKind,
    lastDelivery?.error || (lastDelivery?.model ? `${lastDelivery.model}${lastDelivery.reasoningEffort ? ` · ${lastDelivery.reasoningEffort}` : ''}` : ''));

  addCosInfo('Settings', settingsLabel(info.settings), info.settings?.readOnly ? 'warn' : '', settingsTitle(info.settings));
  els.cosInfo.classList.toggle('hidden', els.cosInfo.children.length === 0);
}

function renderFacts() {
  const session = activeSession();
  const draft = state.draft;
  const send = state.status?.cos?.live?.send;
  els.sessionFacts.replaceChildren();
  if (draft) {
    addFact('Draft', draft.submitted ? 'Creating chat' : 'New chat', draft.submitted ? 'warn' : 'good');
    addFact('Project', projectNameFromKey(draft.projectId || UNGROUPED_PROJECT));
    addFact('Send', send?.available ? 'Ready' : 'Unavailable', send?.available ? 'good' : 'warn');
    return;
  }
  if (!session) {
    addFact('COS', state.status?.cos?.readable === false ? 'Unreadable' : 'Connected', state.status?.cos?.readable === false ? 'bad' : 'good');
    addFact('Sessions', String(state.status?.cos?.normalSessions ?? state.sessions.length));
    return;
  }
  addFact('Status', sessionStateLabel(session), session.activity?.state === 'active' ? 'good' : '');
  addFact('Provider', providerLabel(session));
  addFact('Context', shortNumber(session.usage?.contextTokens));
  addFact('Send', send?.available ? 'Ready' : 'Unavailable', send?.available ? 'good' : 'warn');
}

function sendUnavailableCopy() {
  const error = String(state.status?.cos?.live?.send?.error || '').trim();
  if (/already open outside OpenDraw|fully quit it once/i.test(error)) {
    return {
      title: 'COS connection required',
      detail: 'Quit Chat On Steroids once, then Retry to reconnect privately.'
    };
  }
  if (!state.status?.cos?.live?.configured) {
    return {
      title: 'Sending is not connected',
      detail: 'The private Chat On Steroids send bridge is not available yet.'
    };
  }
  return {
    title: 'COS is temporarily unavailable',
    detail: 'Chat history is still available. Retry the private COS connection when ready.'
  };
}

function updateComposerNote() {
  const session = activeSession();
  const draft = state.draft;
  const send = state.status?.cos?.live?.send;
  const activeTurnId = !draft ? session?.activity?.activeTurnId || null : null;
  const hasText = Boolean(els.messageInput.value.trim());
  if (activeTurnId) {
    if (state.stoppingTurn) {
      els.composerNote.textContent = 'Ending the current response…';
    } else if (hasText) {
      els.composerNote.textContent = 'Response in progress · Send hands this follow-up to COS to deliver at the right safe moment.';
    } else {
      els.composerNote.textContent = 'Response in progress · type a follow-up to send through COS, or tap End response.';
    }
  } else if (draft?.submitted) {
    els.composerNote.textContent = 'Creating the new Chat On Steroids chat…';
  } else if (draft && state.pendingNewChat && state.pendingNewChat.id !== draft.pendingId) {
    els.composerNote.textContent = 'Another new chat is still being created. This draft is safe to keep editing.';
  } else if (draft && send?.available) {
    els.composerNote.textContent = `Draft saved automatically · first send creates a chat in ${projectNameFromKey(draft.projectId || UNGROUPED_PROJECT)}.`;
  } else if (send?.available) {
    els.composerNote.textContent = 'Draft saved automatically · Enter adds a line · Ctrl/⌘+Enter sends.';
  } else {
    els.composerNote.textContent = `${sendUnavailableCopy().detail} Tap the send button to reconnect.`;
  }
}

async function retryCosConnection() {
  if (state.connectionRetryBusy) return;
  state.connectionRetryBusy = true;
  state.sendUiState = 'reconnecting';
  updateComposerSendState();
  setSendStatus('Retrying the private COS connection…');
  try {
    await refresh({ forceMessages: false, waitForBackground: true });
    if (state.status?.cos?.live?.send?.available) {
      setSendStatus('Chat On Steroids is connected for direct send.', 'good');
      setTransientSendButtonState('sent', 1200);
      showToast('COS connection ready', 'good');
      setTimeout(() => setSendStatus(''), 2200);
    } else {
      const copy = sendUnavailableCopy();
      state.sendUiState = 'reconnect';
      setSendStatus(copy.detail, 'bad');
    }
  } catch (error) {
    state.sendUiState = 'error';
    setSendStatus(`Could not reconnect: ${error.message}`, 'bad');
  } finally {
    state.connectionRetryBusy = false;
    renderHeader();
  }
}

function renderHeader() {
  const session = activeSession();
  const draft = state.draft;
  const send = state.status?.cos?.live?.send;
  const activeTurnId = !draft ? session?.activity?.activeTurnId || null : null;
  els.activeTitle.textContent = draft ? 'New chat' : session?.title || 'OpenDraw';
  els.activeMeta.textContent = draft
    ? `${projectNameFromKey(draft.projectId || UNGROUPED_PROJECT)} · ${draft.submitted ? 'Creating…' : 'Draft'}`
    : session
    ? `${providerLabel(session)} · ${modelLabel(session)} · ${sessionStateLabel(session)}`
    : 'Choose a Chat On Steroids session';
  if (session?.conversationId) {
    els.openChatLink.href = `https://chatgpt.com/c/${encodeURIComponent(session.conversationId)}`;
    els.openChatLink.classList.remove('hidden');
  } else {
    els.openChatLink.href = '#';
    els.openChatLink.classList.add('hidden');
  }
  updateComposerSendState();
  els.messageInput.disabled = draft?.submitted === true;
  els.messageInput.placeholder = draft ? 'Write the first message…' : 'Message this session…';
  updateComposerNote();
  els.moreButton.disabled = !session;
  els.promptNavigatorButton.disabled = !session;
  els.conversationSearchButton.disabled = !session;
  updateComposerSummary();
  renderVoiceState();
  renderMobileToolbar();
  renderFacts();
  renderAgentBar();
  renderTaskBar();
  renderContextStatus();
  renderJumpLatest();
  if (state.sheetOpen) renderSessionSheet();
}

function updateComposerSendState() {
  const session = activeSession();
  const draft = state.draft;
  const send = state.status?.cos?.live?.send;
  const hasTarget = Boolean(session || draft);
  const hasText = Boolean(els.messageInput.value.trim());
  const activeTurnId = !draft ? session?.activity?.activeTurnId || null : null;
  const anotherNewChatPending = Boolean(draft && state.pendingNewChat && state.pendingNewChat.id !== draft.pendingId);
  const blocked = !hasTarget || draft?.submitted || anotherNewChatPending || voiceIsActive() || !state.online;
  let mode = state.sendUiState;
  if (activeTurnId && state.stoppingTurn) mode = 'ending';
  else if (state.connectionRetryBusy) mode = 'reconnecting';
  else if (state.sendInFlight) mode = draft ? 'creating' : 'sending';
  else if (draft?.submitted || anotherNewChatPending) mode = 'creating';
  else if (activeTurnId && !hasText) mode = 'end';
  else if (!blocked && send?.available !== true) mode = mode === 'error' ? 'error' : 'reconnect';
  else if (!blocked && mode === 'reconnect') mode = 'idle';
  else if (!blocked && mode === 'reconnecting') mode = 'idle';
  if (!['sent', 'error'].includes(mode)) mode = mode || 'idle';
  if (mode === 'idle' && hasText && !blocked && send?.available === true) mode = 'ready';

  const reconnectMode = ['reconnect', 'error'].includes(mode) && send?.available !== true;
  const canAttempt = mode === 'end'
    ? Boolean(session && activeTurnId && state.online && !state.stoppingTurn)
    : reconnectMode
      ? Boolean(hasTarget && !draft?.submitted && state.online && !voiceIsActive())
      : Boolean(hasTarget && !draft?.submitted && state.online && !voiceIsActive() && hasText && send?.available === true && !state.sendInFlight && !state.connectionRetryBusy);
  const presentation = ({
    idle: ['Send message', 'send'],
    ready: ['Send message', 'send'],
    reconnect: ['Reconnect Chat On Steroids', 'refresh'],
    reconnecting: ['Reconnecting to Chat On Steroids', 'spinner'],
    sending: ['Sending message', 'spinner'],
    creating: ['Creating chat', 'spinner'],
    end: ['End response', 'stop'],
    ending: ['Ending response', 'spinner'],
    sent: ['Sent', 'check'],
    error: [send?.available === true ? 'Retry send' : 'Retry COS connection', 'alert']
  })[mode] || ['Send message', 'send'];

  els.sendButton.disabled = ['reconnecting', 'sending', 'creating', 'ending'].includes(mode) || !canAttempt;
  els.sendButton.dataset.state = mode;
  els.sendButton.classList.toggle('send-unavailable', reconnectMode);
  els.sendButton.classList.toggle('send-end', mode === 'end' || mode === 'ending');
  els.sendButton.setAttribute('aria-label', presentation[0]);
  els.sendButton.title = presentation[0];
  const currentIcon = els.sendButton.dataset.icon;
  if (currentIcon !== presentation[1]) {
    els.sendButton.dataset.icon = presentation[1];
    if (presentation[1] === 'spinner') {
      const spinner = document.createElement('span');
      spinner.className = 'send-button-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      els.sendButton.replaceChildren(spinner);
    } else if (presentation[1] === 'send') {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('ui-icon');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M12 18.5v-13M6.5 11 12 5.5 17.5 11');
      svg.append(path);
      els.sendButton.replaceChildren(svg);
    } else {
      els.sendButton.replaceChildren(createUiIcon(presentation[1]));
    }
  }
}

function setTransientSendButtonState(mode, ttl = 0) {
  clearTimeout(state.sendUiTimer);
  state.sendUiState = mode || 'idle';
  updateComposerSendState();
  if (ttl > 0) {
    state.sendUiTimer = setTimeout(() => {
      state.sendUiState = 'idle';
      updateComposerSendState();
    }, ttl);
  }
}

function renderStatusSummary() {
  const cos = state.status?.cos;
  if (!cos) {
    els.cosSummary.textContent = 'COS status unavailable';
    return;
  }
  if (cos.readable === false) {
    els.cosSummary.textContent = 'COS sessions unavailable';
    return;
  }
  const providers = (cos.providers || []).map((provider) => provider.label).slice(0, 2).join(', ');
  els.cosSummary.textContent = `${cos.liveSessions ?? 0} live · ${cos.normalSessions ?? 0} sessions${providers ? ` · ${providers}` : ''}`;
}

function notificationPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

function applicationServerKeyBytes(value) {
  const padding = '='.repeat((4 - String(value || '').length % 4) % 4);
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/') + padding;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function completionNotificationWatchEnabled() {
  // Real Web Push is detected server-side and does not need a suspended page to
  // keep a long-poll alive. Keep the old page-side watcher only as a fallback.
  return state.notificationsEnabled && !state.pushSubscribed && notificationPermission() === 'granted';
}

async function refreshPushStatus() {
  if (!state.token || !pushSupported()) {
    state.pushAvailable = false;
    state.pushSubscribed = false;
    state.pushPublicKey = null;
    renderNotificationButton();
    return;
  }
  try {
    const data = await api('/api/push/status');
    state.pushAvailable = data?.available === true && typeof data?.publicKey === 'string' && Boolean(data.publicKey);
    state.pushSubscribed = data?.subscribed === true;
    state.pushPublicKey = state.pushAvailable ? data.publicKey : null;
  } catch (error) {
    if (error.status === 401) throw error;
    state.pushAvailable = false;
    state.pushSubscribed = false;
    state.pushPublicKey = null;
  }
  renderNotificationButton();
}

function renderNotificationButton() {
  if (!els.notificationButton || !els.notificationButtonTitle || !els.notificationButtonDetail) return;
  const permission = notificationPermission();
  let title = 'Answer alerts';
  let detail = 'Notify this phone when a response finishes';
  let enabled = false;
  if (permission === 'unsupported' || !pushSupported()) {
    detail = 'Phone push is unavailable here · on iPhone install OpenDraw to the Home Screen first';
  } else if (permission === 'denied') {
    detail = 'Blocked by this browser · allow notifications in site/app settings';
  } else if (state.notificationsEnabled && state.pushSubscribed && permission === 'granted') {
    title = 'Answer alerts on';
    detail = 'Phone push is active · works even when OpenDraw is closed or suspended';
    enabled = true;
  } else if (state.notificationsEnabled && permission === 'granted') {
    detail = 'Tap to finish phone push setup';
  } else if (permission === 'granted') {
    detail = 'Notifications are allowed · tap to register this phone for push';
  } else {
    detail = 'Tap to allow and register a real phone “answer ready” push';
  }
  els.notificationButtonTitle.textContent = title;
  els.notificationButtonDetail.textContent = detail;
  els.notificationButton.classList.toggle('active', enabled);
  els.notificationButton.disabled = permission === 'unsupported' || !pushSupported();
  els.notificationButton.setAttribute('aria-pressed', String(enabled));
}

async function toggleCompletionNotifications() {
  const permission = notificationPermission();
  if (permission === 'unsupported' || !pushSupported()) {
    showToast('Real phone push is not available here. On iPhone, add OpenDraw to the Home Screen, open that app, and try again.', 'bad');
    renderNotificationButton();
    return;
  }
  if (state.notificationsEnabled && state.pushSubscribed && permission === 'granted') {
    try {
      await api('/api/push/subscription', { method: 'DELETE' });
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      await subscription?.unsubscribe?.().catch(() => false);
    } catch { /* disabling local preference still takes effect even if server is briefly offline */ }
    state.notificationsEnabled = false;
    state.pushSubscribed = false;
    localStorage.setItem(NOTIFICATIONS_KEY, '0');
    renderNotificationButton();
    showToast('Answer alerts turned off');
    if (document.hidden) stopMessageStream();
    return;
  }
  let nextPermission = permission;
  if (nextPermission === 'default') {
    try { nextPermission = await Notification.requestPermission(); } catch { nextPermission = 'denied'; }
  }
  if (nextPermission !== 'granted') {
    state.notificationsEnabled = false;
    localStorage.setItem(NOTIFICATIONS_KEY, '0');
    renderNotificationButton();
    showToast('Notification permission was not granted.', 'bad');
    return;
  }
  try {
    await refreshPushStatus();
    if (!state.pushAvailable || !state.pushPublicKey) throw new Error('OpenDraw phone push is not available from the server yet.');
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKeyBytes(state.pushPublicKey)
      });
    }
    await api('/api/push/subscription', {
      method: 'PUT',
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    state.notificationsEnabled = true;
    state.pushSubscribed = true;
    localStorage.setItem(NOTIFICATIONS_KEY, '1');
    renderNotificationButton();
    stopMessageStream();
    startMessageStream();
    try {
      await api('/api/push/test', { method: 'POST' });
      showToast('Phone push enabled · a test notification was sent', 'good');
    } catch {
      showToast('Phone push registered. The test push could not be confirmed yet.', 'bad');
    }
  } catch (error) {
    state.notificationsEnabled = false;
    state.pushSubscribed = false;
    localStorage.setItem(NOTIFICATIONS_KEY, '0');
    renderNotificationButton();
    showToast(`Could not enable phone push: ${error.message}`, 'bad');
  }
}

async function notifyAnswerReady(sessionId, message) {
  if (!sessionId || !message?.id || !message.final || message.role !== 'assistant') return;
  if (!state.notificationsEnabled || notificationPermission() !== 'granted') return;
  if (state.pushSubscribed) return;
  const dedupeKey = `${NOTIFIED_MESSAGE_PREFIX}${sessionId}`;
  try {
    if (localStorage.getItem(dedupeKey) === message.id) return;
  } catch { /* private mode may reject storage; notification can still work */ }
  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification('OpenDraw · Answer ready', {
        body: 'Chat On Steroids finished its response.',
        tag: 'opendraw-answer-ready',
        renotify: true,
        icon: '/icon.svg',
        badge: '/icon.svg',
        data: { url: '/' }
      });
    } else {
      new Notification('OpenDraw · Answer ready', { body: 'Chat On Steroids finished its response.' });
    }
    try { localStorage.setItem(dedupeKey, message.id); } catch { /* ignore */ }
  } catch {
    // Notification delivery is best-effort; keep the durable transcript authoritative.
  }
}

function appendSheetChip(text, kind = '') {
  if (!text) return;
  const chip = document.createElement('span');
  chip.className = `sheet-status-chip${kind ? ` ${kind}` : ''}`;
  chip.textContent = text;
  els.sheetStatus.append(chip);
}

function queueStateLabel(row) {
  return ({ queued: 'Queued', browser: 'Sending', tool: 'Delivering', sent: 'Sent', failed: 'Failed', cancelled: 'Cancelled' })[row?.state]
    || (row?.state ? row.state : 'Pending');
}

function renderSessionSheet() {
  if (!els.sessionSheetBackdrop) return;
  const session = activeSession();
  if (!state.sheetOpen || !session) {
    els.sessionSheetBackdrop.classList.add('hidden');
    return;
  }
  els.sessionSheetBackdrop.classList.remove('hidden');
  els.sheetTitle.textContent = session.title;
  renderNotificationButton();
  els.sheetStatus.replaceChildren();
  appendSheetChip(sessionStateLabel(session), session.activity?.state === 'active' ? 'good' : '');
  appendSheetChip(projectNameForSession(session));
  appendSheetChip(`${modelLabel(session)}${session.selectedModel?.reasoningEffort ? ` · ${reasoningLabel(session.selectedModel.reasoningEffort)}` : ''}`);
  const pressure = contextPressure(
    session.usage?.contextTokens ?? 0,
    state.cosInfo?.settings?.sessions?.limitTokens,
    state.cosInfo?.settings?.sessions?.advisoryTokens,
    state.cosInfo?.settings?.compaction?.autoTokens
  );
  if (session.usage?.contextTokens) {
    const contextLabel = pressure.limit
      ? `${formatTokenCount(pressure.context)} / ${formatTokenCount(pressure.limit)} context`
      : `${formatTokenCount(pressure.context)} context`;
    appendSheetChip(contextLabel, pressure.level === 'danger' ? 'bad' : pressure.level === 'warn' ? 'warn' : '');
  }
  if (state.controls?.automation && state.controls.automation !== 'off') appendSheetChip(`${state.controls.automation} automation`, 'good');
  if (state.controls?.blocked) appendSheetChip('Blocked', 'bad');

  if (session.conversationId) {
    els.sheetOpenChatLink.href = `https://chatgpt.com/c/${encodeURIComponent(session.conversationId)}`;
    els.sheetOpenChatLink.classList.remove('hidden');
  } else {
    els.sheetOpenChatLink.href = '#';
    els.sheetOpenChatLink.classList.add('hidden');
  }

  const job = state.controls?.job;
  const compactBusy = Boolean(job && (job.busy || !['done', 'failed', 'cancelled'].includes(job.stage)));
  if (compactBusy) appendSheetChip(compactionStageLabel(job?.stage), 'warn');
  else if (job?.stage === 'failed') appendSheetChip('Compaction interrupted', 'bad');
  els.compactButton.disabled = state.sheetBusy || !state.controls || state.controls?.blocked || compactBusy;
  els.compactButton.classList.toggle('hidden', compactBusy);
  els.cancelCompactButton.classList.toggle('hidden', !compactBusy);
  els.cancelCompactButton.disabled = state.sheetBusy || !compactBusy;

  els.automationSelect.disabled = state.sheetBusy || !state.controls || state.controls?.blocked;
  els.saveAutomationButton.disabled = state.sheetBusy || !state.controls || state.controls?.blocked;
  if (document.activeElement !== els.automationSelect) els.automationSelect.value = state.controls?.automation || 'off';
  if (document.activeElement !== els.objectiveInput) els.objectiveInput.value = state.controls?.objective || '';

  els.queueList.replaceChildren();
  const queue = (state.queue || []).filter((row) => ['queued', 'browser', 'tool', 'failed'].includes(row.state)).slice(0, 12);
  els.queueCount.textContent = String(queue.length);
  if (!queue.length) {
    const empty = document.createElement('div');
    empty.className = 'queue-empty';
    empty.textContent = 'Nothing is waiting for this chat.';
    els.queueList.append(empty);
  } else {
    for (const row of queue) {
      const item = document.createElement('div');
      item.className = 'queue-item';
      const content = document.createElement('div');
      const text = document.createElement('strong');
      text.textContent = row.textPreview || '(message content unavailable)';
      if (row.textTruncated) text.title = `${row.textPreview}…`;
      const meta = document.createElement('small');
      meta.textContent = `${queueStateLabel(row)}${row.mode ? ` · ${row.mode}` : ''}${row.createdAt ? ` · ${sessionTime(row.createdAt)}` : ''}`;
      content.append(text, meta);
      item.append(content);
      if (row.cancelable) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = 'Cancel';
        cancel.title = row.state === 'browser'
          ? 'Request cancellation; browser delivery may already have started'
          : 'Cancel queued message';
        cancel.addEventListener('click', () => { void cancelQueueItem(row.id, row.state); });
        item.append(cancel);
      }
      els.queueList.append(item);
    }
  }

  els.usageList.replaceChildren();
  const limits = Array.isArray(state.usage?.limits)
    ? [...state.usage.limits].sort((a, b) => (a.remainingPercent ?? 101) - (b.remainingPercent ?? 101)).slice(0, 6)
    : [];
  if (!state.usage?.available || !limits.length) {
    const empty = document.createElement('div');
    empty.className = 'usage-empty';
    empty.textContent = state.usage?.available === false ? 'COS usage data is not available right now.' : 'No current limit data.';
    els.usageList.append(empty);
  } else {
    for (const row of limits) {
      const line = document.createElement('div');
      line.className = 'usage-row';
      const model = document.createElement('strong');
      model.textContent = row.model || row.scope || 'Usage';
      const value = document.createElement('span');
      value.textContent = Number.isFinite(row.remainingPercent)
        ? `${Math.max(0, Math.round(row.remainingPercent))}% left`
        : Number.isFinite(row.remaining) ? `${row.remaining} left` : 'Available';
      if (row.resetAt) value.title = `Resets ${new Date(row.resetAt).toLocaleString()}`;
      line.append(model, value);
      els.usageList.append(line);
    }
  }
}

async function loadSessionSheet({ quiet = false } = {}) {
  const session = activeSession();
  if (!session || state.sheetBusy) return;
  state.sheetBusy = true;
  if (!quiet) setSheetMessage('Loading Chat On Steroids controls…');
  renderSessionSheet();
  try {
    const id = encodeURIComponent(session.id);
    const [controlsResult, queueResult, usageResult] = await Promise.allSettled([
      api(`/api/sessions/${id}/controls`),
      api(`/api/sessions/${id}/queue`),
      api('/api/usage')
    ]);
    if (activeSession()?.id !== session.id) return;
    if (controlsResult.status === 'fulfilled') state.controls = controlsResult.value.controls || null;
    if (queueResult.status === 'fulfilled') state.queue = Array.isArray(queueResult.value.queue) ? queueResult.value.queue : [];
    if (usageResult.status === 'fulfilled') state.usage = usageResult.value;
    else state.usage = { available: false, limits: [] };
    const failures = [controlsResult, queueResult, usageResult].filter((result) => result.status === 'rejected');
    if (!quiet) {
      if (failures.length) setSheetMessage(`${failures.length} COS control ${failures.length === 1 ? 'section is' : 'sections are'} temporarily unavailable.`, 'bad');
      else setSheetMessage('');
    }
  } catch (error) {
    setSheetMessage(`Could not load controls: ${error.message}`, 'bad');
  } finally {
    state.sheetBusy = false;
    renderSessionSheet();
    renderContextStatus();
  }
}

function openSessionSheet() {
  if (!activeSession()) return;
  releaseTextFocus();
  closeSidebar();
  closeConversationPanel();
  closeModelPicker();
  closeContextSheet();
  state.sheetOpen = true;
  els.sessionSheet?._resetDismissGesture?.();
  setSheetMessage('');
  renderSessionSheet();
  void loadSessionSheet();
}

function closeSessionSheet() {
  releaseTextFocus(els.sessionSheet);
  els.sessionSheet?._resetDismissGesture?.();
  state.sheetOpen = false;
  els.sessionSheetBackdrop?.classList.add('hidden');
}

async function saveAutomation() {
  const session = activeSession();
  if (!session || state.sheetBusy) return;
  const automation = els.automationSelect.value;
  const objective = els.objectiveInput.value.trim();
  state.sheetBusy = true;
  setSheetMessage('Applying automation…');
  renderSessionSheet();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/automation`, {
      method: 'POST',
      body: JSON.stringify({ automation, objective })
    });
    state.controls = result.controls || state.controls;
    setSheetMessage(automation === 'off' ? 'Automation is off.' : `${reasoningLabel(automation)} automation enabled.`, 'good');
    showToast(automation === 'off' ? 'Automation turned off' : `${reasoningLabel(automation)} automation enabled`, 'good');
  } catch (error) {
    setSheetMessage(`Could not update automation: ${error.message}`, 'bad');
  } finally {
    state.sheetBusy = false;
    renderSessionSheet();
    renderContextStatus();
    void refreshActivity();
  }
}

async function compactCurrentSession(cancel = false) {
  const session = activeSession();
  if (!session || state.sheetBusy) return;
  state.sheetBusy = true;
  setSheetMessage(cancel ? 'Cancelling compaction…' : 'Starting compaction…');
  if (state.contextSheetOpen) setContextSheetMessage(cancel ? 'Cancelling compaction…' : 'Starting compaction…');
  renderSessionSheet();
  renderContextSheet();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/compact`, { method: cancel ? 'DELETE' : 'POST' });
    state.controls = result.controls || state.controls;
    setSheetMessage(cancel ? 'Compaction cancellation requested.' : 'Compaction started in Chat On Steroids.', 'good');
    if (state.contextSheetOpen) setContextSheetMessage(cancel ? 'Compaction cancellation requested.' : 'Compaction started in Chat On Steroids.', 'good');
    showToast(cancel ? 'Compaction cancellation requested' : 'Compaction started', 'good');
  } catch (error) {
    setSheetMessage(`Compaction action failed: ${error.message}`, 'bad');
    if (state.contextSheetOpen) setContextSheetMessage(`Compaction action failed: ${error.message}`, 'bad');
  } finally {
    state.sheetBusy = false;
    renderSessionSheet();
    renderContextStatus();
    renderContextSheet();
  }
}

async function cancelQueueItem(inputId, inputState = 'queued') {
  const session = activeSession();
  if (!session || !inputId || state.sheetBusy) return;
  const uncertainDelivery = inputState === 'browser';
  state.sheetBusy = true;
  setSheetMessage(uncertainDelivery ? 'Requesting cancellation…' : 'Cancelling queued message…');
  renderSessionSheet();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.id)}/queue/${encodeURIComponent(inputId)}`, { method: 'DELETE' });
    if (result?.ok !== true) throw new Error('Chat On Steroids did not confirm cancellation.');
    if (uncertainDelivery) {
      setSheetMessage('Cancellation requested. Browser delivery may already have started.');
      showToast('Cancellation requested; delivery may already have started');
    } else {
      setSheetMessage('Queued message cancelled.', 'good');
      showToast('Queued message cancelled', 'good');
    }
    const queue = await api(`/api/sessions/${encodeURIComponent(session.id)}/queue`);
    state.queue = Array.isArray(queue.queue) ? queue.queue : [];
  } catch (error) {
    setSheetMessage(`Could not cancel that message: ${error.message}`, 'bad');
  } finally {
    state.sheetBusy = false;
    renderSessionSheet();
  }
}

function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function escapedAt(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function strongClose(text, start, marker) {
  const char = marker[0];
  let singleOpen = false;
  for (let index = start + 2; index < text.length - 1; index += 1) {
    if (text[index] !== char || escapedAt(text, index)) continue;
    if (singleOpen && text.slice(index, index + 3) === char.repeat(3)) return index + 1;
    if (!singleOpen && text.slice(index, index + 2) === marker) return index;
    if (text[index + 1] !== char) singleOpen = !singleOpen;
  }
  return -1;
}

function italicClose(text, start, char) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] !== char || escapedAt(text, index)) continue;
    if (text[index + 1] === char) {
      const nestedClose = strongClose(text, index, char.repeat(2));
      if (nestedClose >= 0) {
        index = nestedClose + 1;
        continue;
      }
    }
    return index;
  }
  return -1;
}

function inlineCandidate(text) {
  const escapable = /[\\`*{}\[\]()#+\-.!_>~|]/;
  for (let index = 0; index < text.length; index += 1) {
    const rest = text.slice(index);
    if (text[index] === '\\' && escapable.test(text[index + 1] || '')) {
      return { type: 'escape', index, length: 2, content: text[index + 1] };
    }
    if (text[index] === '`' && !escapedAt(text, index)) {
      const close = text.indexOf('`', index + 1);
      if (close > index + 1 && !text.slice(index + 1, close).includes('\n')) {
        return { type: 'code', index, length: close - index + 1, content: text.slice(index + 1, close) };
      }
    }
    if (rest.startsWith('![')) {
      const match = /^!\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);
      if (match) return { type: 'image', index, length: match[0].length, content: match[1], extra: match[2], raw: match[0] };
    }
    if (text[index] === '[') {
      const match = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (match) return { type: 'link', index, length: match[0].length, content: match[1], extra: match[2], raw: match[0] };
    }
    if (text[index] === '<') {
      const match = /^<(https?:\/\/[^>\s]+)>/i.exec(rest);
      if (match) return { type: 'link', index, length: match[0].length, content: match[1], extra: match[1], raw: match[0] };
    }
    if (rest.startsWith('~~') && !escapedAt(text, index)) {
      const close = text.indexOf('~~', index + 2);
      if (close > index + 2) return { type: 'strike', index, length: close - index + 2, content: text.slice(index + 2, close) };
    }
    if ((rest.startsWith('**') || rest.startsWith('__')) && !escapedAt(text, index)) {
      const marker = rest.slice(0, 2);
      if (marker === '__' && index > 0 && /[\p{L}\p{N}]/u.test(text[index - 1]) && /[\p{L}\p{N}]/u.test(text[index + 2] || '')) continue;
      const close = strongClose(text, index, marker);
      if (close > index + 2) return { type: 'bold', index, length: close - index + 2, content: text.slice(index + 2, close) };
    }
    if ((text[index] === '*' || text[index] === '_') && !escapedAt(text, index)) {
      if (text[index] === '_' && (text[index - 1] === '_' || text[index + 1] === '_')) continue;
      if (text[index] === '_' && index > 0 && /[\p{L}\p{N}]/u.test(text[index - 1]) && /[\p{L}\p{N}]/u.test(text[index + 1] || '')) continue;
      const close = italicClose(text, index, text[index]);
      if (close > index + 1) return { type: 'italic', index, length: close - index + 1, content: text.slice(index + 1, close) };
    }
  }
  return null;
}

function appendInline(parent, raw, depth = 0) {
  const text = String(raw ?? '');
  if (!text || depth > 8) {
    if (text) parent.append(document.createTextNode(text));
    return;
  }
  let remaining = text;
  while (remaining) {
    const candidate = inlineCandidate(remaining);
    if (!candidate) {
      parent.append(document.createTextNode(remaining));
      return;
    }
    if (candidate.index > 0) parent.append(document.createTextNode(remaining.slice(0, candidate.index)));
    const { content, extra } = candidate;
    if (candidate.type === 'code') {
      const code = document.createElement('code');
      code.className = 'md-inline-code';
      code.textContent = content;
      parent.append(code);
    } else if (candidate.type === 'escape') {
      parent.append(document.createTextNode(content));
    } else if (candidate.type === 'image') {
      const href = safeHttpUrl(extra);
      if (!href) {
        parent.append(document.createTextNode(candidate.raw));
      } else {
        const image = document.createElement('img');
        image.className = 'md-image';
        image.src = href;
        image.alt = content || 'Image';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => {
          const fallback = document.createElement('a');
          fallback.className = 'md-link md-image-fallback';
          fallback.href = href;
          fallback.target = '_blank';
          fallback.rel = 'noopener noreferrer';
          fallback.textContent = content ? `Image: ${content}` : 'Open image';
          image.replaceWith(fallback);
        }, { once: true });
        parent.append(image);
      }
    } else if (candidate.type === 'link') {
      const href = safeHttpUrl(extra);
      if (!href) {
        parent.append(document.createTextNode(candidate.raw));
      } else {
        const link = document.createElement('a');
        link.className = 'md-link';
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        appendInline(link, content, depth + 1);
        parent.append(link);
      }
    } else {
      const emphasis = document.createElement(candidate.type === 'bold' ? 'strong' : candidate.type === 'strike' ? 'del' : 'em');
      appendInline(emphasis, content, depth + 1);
      parent.append(emphasis);
    }
    remaining = remaining.slice(candidate.index + candidate.length);
  }
}

function appendLines(parent, lines) {
  lines.forEach((line, index) => {
    if (index > 0) parent.append(document.createElement('br'));
    appendInline(parent, line);
  });
}

function createCodeBlock(language, codeText) {
  const block = document.createElement('section');
  block.className = 'md-code-block';
  const header = document.createElement('div');
  header.className = 'md-code-header';
  const label = document.createElement('span');
  label.textContent = language || 'Code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'md-copy-button';
  copy.textContent = 'Copy';
  copy.setAttribute('aria-label', `Copy ${language || 'code'} block`);
  copy.addEventListener('click', async () => {
    try {
      await copyText(codeText);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    } catch {
      copy.textContent = 'Copy failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    }
  });
  header.append(label, copy);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = codeText;
  pre.append(code);
  block.append(header, pre);
  return block;
}

function horizontalRule(line) {
  return /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/.test(line);
}

function tableCells(line) {
  let value = String(line ?? '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      cell += char === '|' ? '|' : `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += char;
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}

function tableAlignments(line) {
  const cells = tableCells(line);
  if (!cells.length || cells.some((cell) => !/^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))) return null;
  return cells.map((cell) => {
    const clean = cell.replace(/\s+/g, '');
    if (clean.startsWith(':') && clean.endsWith(':')) return 'center';
    if (clean.endsWith(':')) return 'right';
    return 'left';
  });
}

function appendTaskOrInline(item, raw) {
  const task = /^\[( |x|X)\]\s+(.+)$/.exec(raw);
  if (!task) {
    appendInline(item, raw);
    return;
  }
  item.classList.add('md-task-item');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = task[1].toLowerCase() === 'x';
  checkbox.disabled = true;
  checkbox.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  appendInline(label, task[2]);
  item.append(checkbox, label);
}

function appendListBlock(container, lines, start) {
  const matchLine = (line) => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
  const first = matchLine(lines[start]);
  if (!first) return start;
  const listType = (marker) => /^\d/.test(marker) ? 'ol' : 'ul';
  const root = document.createElement(listType(first[2]));
  const stack = [{ indent: first[1].replace(/\t/g, '    ').length, list: root, type: root.tagName.toLowerCase(), lastItem: null }];
  let index = start;
  while (index < lines.length) {
    const match = matchLine(lines[index]);
    if (!match) break;
    const indent = match[1].replace(/\t/g, '    ').length;
    const type = listType(match[2]);
    while (stack.length > 1 && indent < stack.at(-1).indent) stack.pop();
    let level = stack.at(-1);
    if (indent > level.indent && level.lastItem) {
      const nested = document.createElement(type);
      level.lastItem.append(nested);
      level = { indent, list: nested, type, lastItem: null };
      stack.push(level);
    } else if (indent === level.indent && type !== level.type) {
      break;
    }
    const item = document.createElement('li');
    appendTaskOrInline(item, match[3]);
    level.list.append(item);
    level.lastItem = item;
    index += 1;
  }
  container.append(root);
  return index;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A browser may expose Clipboard API but deny it in a PWA/tab context. Continue
      // to the selection-based path instead of turning a copy tap into a dead action.
    }
  }
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.readOnly = true;
  fallback.tabIndex = -1;
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  fallback.style.pointerEvents = 'none';
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand?.('copy');
  fallback.remove();
  if (!copied) throw new Error('Clipboard unavailable');
}

function createMessageActions(message) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'message-action';
  copy.title = 'Copy message';
  copy.setAttribute('aria-label', `Copy ${message.role === 'user' ? 'your' : 'ChatGPT'} message`);
  copy.append(createUiIcon('copy'));
  copy.addEventListener('click', async () => {
    try {
      const latest = state.messages.find((row) => row.id === message.id) || message;
      await copyText(latest.text || '');
      copy.classList.add('copied');
      copy.title = 'Copied';
      copy.replaceChildren(createUiIcon('check'));
      showToast('Message copied', 'good');
      setTimeout(() => {
        copy.classList.remove('copied');
        copy.title = 'Copy message';
        copy.replaceChildren(createUiIcon('copy'));
      }, 1500);
    } catch {
      showToast('Could not copy this message', 'bad');
    }
  });
  actions.append(copy);
  return actions;
}

function blockStart(line) {
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^(\s*)(?:[-+*]|\d+[.)])\s+/.test(line)
    || horizontalRule(line);
}

function renderMarkdownInto(container, rawText) {
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '');
  container.replaceChildren();
  container.classList.add('markdown-body');
  try {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (line.trim() === '') {
        index += 1;
        continue;
      }

      const fence = /^\s*```([^`]*)$/.exec(line);
      if (fence) {
        const close = lines.findIndex((candidate, offset) => offset > index && /^\s*```\s*$/.test(candidate));
        if (close > index) {
          const language = fence[1].trim().slice(0, 40);
          container.append(createCodeBlock(language, lines.slice(index + 1, close).join('\n')));
          index = close + 1;
          continue;
        }
      }

      const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        const element = document.createElement(`h${heading[1].length}`);
        appendInline(element, heading[2]);
        container.append(element);
        index += 1;
        continue;
      }

      if (horizontalRule(line)) {
        container.append(document.createElement('hr'));
        index += 1;
        continue;
      }

      if (index + 1 < lines.length && line.includes('|')) {
        const alignments = tableAlignments(lines[index + 1]);
        const headers = tableCells(line);
        if (alignments && headers.length === alignments.length) {
          const wrap = document.createElement('div');
          wrap.className = 'md-table-wrap';
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');
          headers.forEach((value, cellIndex) => {
            const cell = document.createElement('th');
            cell.style.textAlign = alignments[cellIndex];
            appendInline(cell, value);
            headerRow.append(cell);
          });
          thead.append(headerRow);
          table.append(thead);
          index += 2;
          const tbody = document.createElement('tbody');
          while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
            const values = tableCells(lines[index]);
            if (values.length !== headers.length) break;
            const row = document.createElement('tr');
            values.forEach((value, cellIndex) => {
              const cell = document.createElement('td');
              cell.style.textAlign = alignments[cellIndex];
              appendInline(cell, value);
              row.append(cell);
            });
            tbody.append(row);
            index += 1;
          }
          if (tbody.childNodes.length) table.append(tbody);
          wrap.append(table);
          container.append(wrap);
          continue;
        }
      }

      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }
        const quote = document.createElement('blockquote');
        appendLines(quote, quoteLines);
        container.append(quote);
        continue;
      }

      if (/^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/.test(line)) {
        index = appendListBlock(container, lines, index);
        continue;
      }

      const paragraphLines = [];
      while (index < lines.length && lines[index].trim() !== '' && !blockStart(lines[index])) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      if (!paragraphLines.length) {
        paragraphLines.push(line);
        index += 1;
      }
      const paragraph = document.createElement('p');
      appendLines(paragraph, paragraphLines);
      container.append(paragraph);
    }
    if (!container.childNodes.length && text) container.textContent = text;
  } catch {
    container.replaceChildren();
    container.textContent = text;
  }
}

function messageAnchor(message) {
  return `message-${message.role}-${String(message.seq).replace(/[^0-9a-z_-]/gi, '-')}`;
}

function transcriptNearBottom(threshold = 32) {
  return nearBottomMetrics(els.transcript, threshold);
}

function captureTranscriptAnchor() {
  const viewportTop = els.transcript.getBoundingClientRect().top;
  for (const node of els.transcript.children) {
    const key = node.dataset?.timelineKey;
    if (!key) continue;
    const rect = node.getBoundingClientRect();
    if (rect.bottom > viewportTop + 1) return { key, offset: rect.top - viewportTop };
  }
  return null;
}

function restoreTranscriptAnchor(anchor, { settle = true, epoch = state.scroll.epoch } = {}) {
  if (!anchor) return;
  const apply = () => {
    if (epoch !== state.scroll.epoch) return;
    if (state.scroll.followLatest) return;
    let node = [...els.transcript.children].find((candidate) => candidate.dataset?.timelineKey === anchor.key);
    if (!node && anchor.key?.startsWith('message:')) {
      const messageId = anchor.key.slice('message:'.length);
      const nested = [...els.transcript.querySelectorAll('[data-message-id]')].find((candidate) => candidate.dataset.messageId === messageId);
      const run = nested?.closest?.('.run-details-group');
      if (run) run._setOpen?.(true);
      node = nested || null;
    }
    if (!node) return;
    const viewportTop = els.transcript.getBoundingClientRect().top;
    const nextOffset = node.getBoundingClientRect().top - viewportTop;
    const delta = nextOffset - anchor.offset;
    if (Math.abs(delta) < 0.5) return;
    state.scroll.programmaticUntil = performance.now() + 100;
    els.transcript.scrollTop += delta;
  };
  apply();
  if (settle) requestAnimationFrame(apply);
}

function rememberSessionScroll() {
  const session = activeSession();
  if (!session || state.draft) return;
  state.scrollMemory.set(session.id, {
    top: Math.max(0, els.transcript.scrollTop),
    followLatest: state.scroll.followLatest
  });
}

function restoreSessionScroll(sessionId) {
  const saved = state.scrollMemory.get(sessionId);
  if (!saved) return false;
  if (saved.followLatest) {
    scrollToLatest({ behavior: 'auto' });
    return true;
  }
  state.scroll.followLatest = false;
  state.scroll.atBottom = false;
  requestAnimationFrame(() => {
    els.transcript.scrollTop = Math.min(saved.top, Math.max(0, els.transcript.scrollHeight - els.transcript.clientHeight));
    state.scroll.atBottom = transcriptNearBottom(32);
    if (state.scroll.atBottom) {
      state.scroll.followLatest = true;
      state.scroll.anchor = null;
    } else {
      state.scroll.anchor = captureTranscriptAnchor();
    }
    renderJumpLatest();
  });
  return true;
}

function scrollToLatest({ behavior = 'smooth' } = {}) {
  const epoch = ++state.scroll.epoch;
  state.scroll.atBottom = true;
  state.scroll.followLatest = true;
  state.scroll.anchor = null;
  state.scroll.unread = 0;
  state.scroll.programmaticUntil = performance.now() + (behavior === 'smooth' ? 900 : 120);
  renderJumpLatest();
  if (epoch === state.scroll.epoch) els.transcript.scrollTo({ top: els.transcript.scrollHeight, behavior });
}

function renderJumpLatest() {
  const show = Boolean(activeSession() && state.messages.length && !state.scroll.atBottom);
  els.jumpLatestButton.classList.toggle('hidden', !show);
  els.jumpLatestLabel.textContent = state.scroll.unread > 1 ? `${state.scroll.unread} new` : state.scroll.unread === 1 ? 'New response' : 'Latest';
  els.jumpLatestButton.setAttribute('aria-label', state.scroll.unread
    ? `Jump to latest, ${state.scroll.unread} new ${state.scroll.unread === 1 ? 'update' : 'updates'}`
    : 'Jump to latest message');
}

function handleTranscriptScroll() {
  if (state.scroll.raf) {
    if (!state.scroll.userIntent) return;
    cancelAnimationFrame(state.scroll.raf);
    state.scroll.raf = 0;
  }
  state.scroll.raf = requestAnimationFrame(() => {
    state.scroll.raf = 0;
    const atBottom = transcriptNearBottom(32);
    state.scroll.atBottom = atBottom;
    if (atBottom) {
      state.scroll.followLatest = true;
      state.scroll.anchor = null;
      state.scroll.userIntent = false;
      state.scroll.unread = 0;
    } else if (state.scroll.userIntent || performance.now() > (state.scroll.programmaticUntil || 0)) {
      state.scroll.followLatest = false;
      state.scroll.anchor = captureTranscriptAnchor();
      state.scroll.userIntent = false;
    }
    renderJumpLatest();
    syncActivePromptFromScroll();
  });
}

function markTranscriptUserScrollIntent() {
  state.scroll.epoch += 1;
  state.scroll.userIntent = true;
  state.scroll.programmaticUntil = 0;
  if (state.scroll.raf) {
    cancelAnimationFrame(state.scroll.raf);
    state.scroll.raf = 0;
  }
  if (state.scroll.followLatest && !transcriptNearBottom(32)) state.scroll.followLatest = false;
}

function toolIconName(category) {
  return ({ web: 'globe', file: 'file', terminal: 'terminal', image: 'image', calendar: 'calendar', agent: 'spark', plan: 'list' })[category] || 'spark';
}

function toolGroupLabel(tools) {
  const categories = new Set(tools.map((tool) => tool.category));
  if (categories.size === 1 && categories.has('web')) return 'Research activity';
  if (categories.size === 1 && categories.has('file')) return 'File activity';
  if (categories.size === 1 && categories.has('terminal')) return 'Code & command activity';
  if (categories.size === 1 && categories.has('agent')) return 'Agent activity';
  return 'Tool activity';
}

function formatActivityClock(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  try { return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(value)); } catch { return ''; }
}

function formatActivityElapsed(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function closeVisualViewer() {
  const viewer = state.visualViewer;
  if (!viewer) return;
  document.removeEventListener('keydown', viewer.onKeyDown);
  viewer.node.remove();
  state.visualViewer = null;
}

function clearVisualObjectUrls() {
  closeVisualViewer();
  state.visualObserver?.disconnect?.();
  state.visualObserver = null;
  for (const url of state.visualObjectUrls.values()) URL.revokeObjectURL(url);
  state.visualObjectUrls.clear();
}

function observeVisualResult(card, visual, sessionId) {
  if (state.screen.open || !card || !visual || !sessionId) return;
  if (!('IntersectionObserver' in window)) return;
  if (!state.visualObserver) {
    state.visualObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        state.visualObserver?.unobserve(entry.target);
        const pending = entry.target?._visualPending;
        if (pending) void loadVisualResult(entry.target, pending.visual, pending.sessionId);
      }
    }, { root: els.transcript, rootMargin: '500px 0px', threshold: 0.01 });
  }
  card._visualPending = { visual, sessionId };
  state.visualObserver.observe(card);
}

function pruneVisualObjectUrls(items) {
  const sessionId = activeSession()?.id || '';
  const keepVisuals = state.screen.open
    ? (state.activity?.visuals || []).map((visual) => ({ kind: 'visual', visual }))
    : items;
  const keep = new Set(keepVisuals
    .filter((item) => item.kind === 'visual')
    .map((item) => `${sessionId}:${item.visual.id}`));
  for (const [key, url] of state.visualObjectUrls) {
    if (keep.has(key)) continue;
    URL.revokeObjectURL(url);
    state.visualObjectUrls.delete(key);
  }
}

function openVisualViewer(url) {
  if (state.screen.open || !url) return;
  closeVisualViewer();
  const overlay = document.createElement('div');
  overlay.className = 'visual-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Visual proof');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'visual-viewer-close';
  close.setAttribute('aria-label', 'Close visual');
  close.append(createUiIcon('close'));
  const image = document.createElement('img');
  image.src = url;
  image.alt = 'Visual proof';
  image.decoding = 'async';
  const dismiss = () => closeVisualViewer();
  const onKeyDown = (event) => {
    if (event.key === 'Escape') dismiss();
  };
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dismiss();
  });
  overlay.append(close, image);
  document.body.append(overlay);
  document.addEventListener('keydown', onKeyDown);
  state.visualViewer = { node: overlay, onKeyDown };
  close.focus({ preventScroll: true });
}

async function loadVisualResult(card, visual, sessionId) {
  if (state.screen.open || !card?.isConnected || !visual?.id || !sessionId) return null;
  const key = `${sessionId}:${visual.id}`;
  const image = card.querySelector('.visual-result-image');
  const placeholder = card.querySelector('.visual-result-placeholder');
  const status = card.querySelector('.visual-result-status');
  const preview = card.querySelector('.visual-result-preview');
  if (!image || !placeholder || !status || !preview) return null;
  const cached = state.visualObjectUrls.get(key);
  if (cached) {
    image.src = cached;
    image.hidden = false;
    placeholder.hidden = true;
    status.textContent = 'Ready';
    preview.dataset.state = 'ready';
    return cached;
  }
  if (preview.dataset.state === 'loading') return null;
  preview.dataset.state = 'loading';
  status.textContent = 'Loading';
  placeholder.hidden = false;
  placeholder.textContent = 'Visual ready · tap to load';
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/visuals/${encodeURIComponent(visual.id)}`, {
      cache: 'no-store',
      headers: authHeaders()
    });
    if (response.status === 401) {
      state.token = '';
      localStorage.removeItem('opendraw.deviceToken');
      showPairing();
    }
    if (!response.ok) throw new Error(`visual_${response.status}`);
    const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw new Error('visual_type');
    const blob = await response.blob();
    if (!blob.size || blob.size > 16 * 1024 * 1024) throw new Error('visual_size');
    if (state.screen.open || activeSession()?.id !== sessionId || !card.isConnected) return null;
    const url = URL.createObjectURL(blob);
    state.visualObjectUrls.set(key, url);
    image.src = url;
    image.hidden = false;
    placeholder.hidden = true;
    status.textContent = 'Ready';
    preview.dataset.state = 'ready';
    return url;
  } catch {
    if (state.screen.open || activeSession()?.id !== sessionId || !card.isConnected) return null;
    image.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = 'Visual unavailable · tap to retry';
    status.textContent = 'Unavailable';
    preview.dataset.state = 'error';
    return null;
  }
}

function createVisualResultNode(item) {
  const visual = item.visual;
  const sessionId = activeSession()?.id || '';
  const card = document.createElement('section');
  card.className = 'visual-result';
  card.dataset.timelineKey = item.key;
  card.dataset.visualSignature = `${visual.id}:${visual.status || ''}:${visual.bytes ?? ''}`;

  const header = document.createElement('div');
  header.className = 'visual-result-header';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = visual.label || 'Visual proof';
  const meta = document.createElement('small');
  const clock = formatActivityClock(Number(visual.time) || 0);
  meta.textContent = ['Image result', clock].filter(Boolean).join(' · ');
  copy.append(title, meta);
  const status = document.createElement('span');
  status.className = 'visual-result-status';
  status.textContent = 'Ready';
  header.append(copy, status);

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'visual-result-preview';
  preview.dataset.state = 'idle';
  preview.setAttribute('aria-label', 'Open visual proof');
  const image = document.createElement('img');
  image.className = 'visual-result-image';
  image.alt = 'Visual proof';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.hidden = true;
  const placeholder = document.createElement('span');
  placeholder.className = 'visual-result-placeholder';
  placeholder.textContent = 'Visual ready · tap to load';
  preview.append(image, placeholder);
  preview.addEventListener('click', async () => {
    const key = `${sessionId}:${visual.id}`;
    let url = state.visualObjectUrls.get(key);
    if (url && preview.dataset.state === 'ready') openVisualViewer(url);
    else {
      url = await loadVisualResult(card, visual, sessionId);
      if (url) openVisualViewer(url);
    }
  });
  image.addEventListener('error', () => {
    const key = `${sessionId}:${visual.id}`;
    const url = state.visualObjectUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    state.visualObjectUrls.delete(key);
    image.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = 'Visual unavailable · tap to retry';
    status.textContent = 'Unavailable';
    preview.dataset.state = 'error';
  });
  card.append(header, preview);
  observeVisualResult(card, visual, sessionId);
  return card;
}

function createToolGroupNode(item) {
  const group = document.createElement('section');
  group.className = `tool-activity-group${item.running ? ' running' : ''}`;
  group.dataset.timelineKey = item.key;
  group.dataset.toolSignature = `${item.running ? 'running|' : ''}${item.tools.map((tool) => `${tool.seq}:${tool.status}:${tool.durationMs ?? ''}`).join('|')}`;
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'tool-group-toggle';
  summary.setAttribute('aria-expanded', 'false');
  const icon = document.createElement('span');
  icon.className = 'tool-group-icon';
  icon.append(createUiIcon(item.tools.some((tool) => tool.status === 'failed') ? 'spark' : toolIconName(item.tools[0]?.category)));
  const copy = document.createElement('span');
  copy.className = 'tool-group-copy';
  const title = document.createElement('strong');
  title.textContent = toolGroupLabel(item.tools);
  const meta = document.createElement('small');
  const failed = item.tools.filter((tool) => tool.status === 'failed').length;
  const times = item.tools.map((tool) => Number(tool.time) || 0).filter(Boolean);
  const clock = times.length ? formatActivityClock(Math.max(...times)) : '';
  const elapsed = times.length > 1 ? formatActivityElapsed(Math.min(...times), Math.max(...times)) : '';
  meta.textContent = `${item.tools.length} ${item.tools.length === 1 ? 'action' : 'actions'}${item.running ? ' · working…' : failed ? ` · ${failed} failed` : ' · completed'}${elapsed ? ` · ${elapsed}` : ''}${clock ? ` · ${clock}` : ''}`;
  copy.append(title, meta);
  const chevron = document.createElement('span');
  chevron.className = 'tool-group-chevron';
  chevron.append(createUiIcon('down'));
  summary.append(icon, copy, chevron);
  const list = document.createElement('div');
  list.className = 'tool-activity-list hidden';
  const setOpen = (open) => {
    group.classList.toggle('open', open);
    list.classList.toggle('hidden', !open);
    summary.setAttribute('aria-expanded', String(open));
  };
  bindDragSafeActivation(summary, () => setOpen(!group.classList.contains('open')));
  for (const tool of item.tools) {
    const row = document.createElement('div');
    row.className = `tool-activity-row ${tool.status === 'failed' ? 'failed' : 'completed'}`;
    const rowIcon = document.createElement('span');
    rowIcon.className = 'tool-activity-icon';
    rowIcon.append(createUiIcon(toolIconName(tool.category)));
    const rowCopy = document.createElement('div');
    const rowTitle = document.createElement('strong');
    rowTitle.textContent = tool.title || 'Tool activity';
    const rowMeta = document.createElement('small');
    const duration = Number.isFinite(tool.durationMs) ? ` · ${tool.durationMs >= 1000 ? `${(tool.durationMs / 1000).toFixed(1)}s` : `${tool.durationMs}ms`}` : '';
    rowMeta.textContent = `${tool.status === 'failed' ? 'Failed' : 'Completed'}${duration}`;
    rowCopy.append(rowTitle, rowMeta);
    const status = document.createElement('span');
    status.className = 'tool-activity-status';
    status.append(createUiIcon(tool.status === 'failed' ? 'spark' : 'check'));
    row.append(rowIcon, rowCopy, status);
    list.append(row);
  }
  group.append(summary, list);
  group._setOpen = setOpen;
  setOpen(Boolean(item.running || item.active));
  return group;
}

let aiLoadingTicker = 0;

function formatAiLoadingElapsed(startedAt, now = Date.now()) {
  const start = Number(startedAt);
  const elapsed = Number.isFinite(start) && start > 0 ? Math.max(0, now - start) : 0;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`;
  const minutes = Math.floor(elapsed / 60_000);
  return `${minutes}m ${((elapsed % 60_000) / 1000).toFixed(1)}s`;
}

function updateAiLoadingElapsed() {
  const timers = [...document.querySelectorAll('.ai-loading-elapsed[data-started-at]')];
  if (!timers.length) {
    if (aiLoadingTicker) window.clearInterval(aiLoadingTicker);
    aiLoadingTicker = 0;
    return;
  }
  const now = Date.now();
  for (const timer of timers) timer.textContent = formatAiLoadingElapsed(Number(timer.dataset.startedAt), now);
}

function ensureAiLoadingTicker() {
  requestAnimationFrame(updateAiLoadingElapsed);
  if (!aiLoadingTicker) aiLoadingTicker = window.setInterval(updateAiLoadingElapsed, 100);
}

function createAiLoadingState(item) {
  const status = document.createElement('section');
  status.className = 'ai-loading-state running open';
  status.dataset.timelineKey = item.key;
  status.dataset.runSignature = item.signature;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-label', 'ChatGPT is working');

  const grid = document.createElement('span');
  grid.className = 'ai-loading-grid';
  grid.setAttribute('aria-hidden', 'true');
  const delays = [90, 0, 90, 180, 90, 180, 270, 180, 270];
  for (const delay of delays) {
    const cell = document.createElement('span');
    cell.className = 'ai-loading-cell';
    cell.style.setProperty('--pixel-delay', `${delay}ms`);
    grid.append(cell);
  }

  const label = document.createElement('span');
  label.className = 'ai-loading-label';
  label.textContent = 'Working';
  const elapsed = document.createElement('span');
  elapsed.className = 'ai-loading-elapsed';
  elapsed.dataset.startedAt = String(item.startedAt || Date.now());
  elapsed.textContent = formatAiLoadingElapsed(Number(elapsed.dataset.startedAt));
  status.append(grid, label, elapsed);
  ensureAiLoadingTicker();
  return status;
}

function createCompletedRunNode(item) {
  if (item.active && !item.rows.length) return createAiLoadingState(item);

  const group = document.createElement('section');
  group.className = `run-details-group${item.active ? ' running' : ''}`;
  group.dataset.timelineKey = item.key;
  group.dataset.runSignature = item.signature;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'run-details-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const icon = document.createElement('span');
  icon.className = 'run-details-icon';
  icon.append(createUiIcon('spark'));
  const copy = document.createElement('span');
  copy.className = 'run-details-copy';
  const title = document.createElement('strong');
  title.textContent = 'Thinking';
  if (!item.active) title.textContent = item.elapsed ? `Thought for ${item.elapsed}` : 'Thought';
  const meta = document.createElement('small');
  const toolCount = item.rows.filter((row) => row.kind === 'tool').length;
  const updateCount = item.rows.filter((row) => row.kind === 'message').length;
  const counts = [
    toolCount ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : '',
    updateCount ? `${updateCount} ${updateCount === 1 ? 'update' : 'updates'}` : ''
  ].filter(Boolean).join(' · ');
  meta.textContent = `${item.active ? 'Working' : 'Completed'}${counts ? ` · ${counts}` : ''}${item.clock ? ` · ${item.clock}` : ''}`;
  copy.append(title, meta);
  const chevron = document.createElement('span');
  chevron.className = 'run-details-chevron';
  chevron.append(createUiIcon('down'));
  toggle.append(icon, copy, chevron);

  const body = document.createElement('div');
  body.className = 'run-details-body';
  const bodyClip = document.createElement('div');
  bodyClip.className = 'run-details-clip';
  const trace = document.createElement('div');
  trace.className = 'run-details-trace';
  bodyClip.append(trace);
  body.append(bodyClip);
  let bodyMaterialized = false;
  const materializeBody = () => {
    if (bodyMaterialized) return;
    bodyMaterialized = true;
    for (const row of item.rows) {
      if (row.kind === 'tool') {
        const tool = row.tool;
        const element = document.createElement('div');
        element.className = `run-detail-tool ${tool.status === 'failed' ? 'failed' : 'completed'}`;
        const rowIcon = document.createElement('span');
        rowIcon.className = 'run-detail-icon';
        rowIcon.append(createUiIcon(toolIconName(tool.category)));
        const rowCopy = document.createElement('div');
        const rowTitle = document.createElement('strong');
        rowTitle.textContent = tool.title || 'Tool activity';
        const rowMeta = document.createElement('small');
        rowMeta.className = 'run-tool-chip';
        const duration = Number.isFinite(tool.durationMs)
          ? (tool.durationMs >= 1000 ? `${(tool.durationMs / 1000).toFixed(1)}s` : `${tool.durationMs}ms`)
          : '';
        const clock = formatActivityClock(Number(tool.time) || 0);
        rowMeta.textContent = [tool.status === 'failed' ? 'Failed' : 'Completed', duration].filter(Boolean).join(' · ');
        if (clock) rowMeta.setAttribute('title', clock);
        rowCopy.append(rowTitle, rowMeta);
        element.append(rowIcon, rowCopy);
        trace.append(element);
        continue;
      }

      const message = row.message;
      const update = document.createElement('article');
      update.id = messageAnchor(message);
      update.dataset.messageId = message.id;
      update.className = 'run-detail-message';
      const heading = document.createElement('div');
      heading.className = 'run-detail-message-heading';
      heading.textContent = ['Thinking / progress', formatActivityClock(Number(message.time) || 0)].filter(Boolean).join(' · ');
      const content = document.createElement('div');
      content.className = 'run-detail-message-content';
      renderMarkdownInto(content, message.text);
      update.append(heading, content);
      trace.append(update);
    }
  };
  const setOpen = (open) => {
    if (open) materializeBody();
    group.classList.toggle('open', open);
    body.setAttribute('aria-hidden', String(!open));
    toggle.setAttribute('aria-expanded', String(open));
    state.workOpen.set(item.key, open);
  };
  bindDragSafeActivation(toggle, () => setOpen(!group.classList.contains('open')));

  group.append(toggle, body);
  group._setOpen = setOpen;
  // Active work opens by default. Completed historical work opens only when the
  // user explicitly left it open; do not reset that preference on an unrelated
  // signature refresh. The active -> terminal replacement below is the one place
  // that deliberately forces a collapse.
  setOpen(state.workOpen.has(item.key) ? state.workOpen.get(item.key) : item.active);
  return group;
}

function reducedMotionPreferred() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function countRevealWords(chunks, start = 0) {
  let count = 0;
  for (let index = start; index < chunks.length; index += 1) {
    if (/\S/.test(chunks[index])) count += 1;
  }
  return count;
}

function cancelWordReveal(messageId) {
  if (!messageId) return;
  state.wordReveal.delete(messageId);
  if (!state.wordReveal.size && state.wordRevealRaf) {
    cancelAnimationFrame(state.wordRevealRaf);
    state.wordRevealRaf = 0;
    state.wordRevealLastAt = 0;
  }
}

function renderStreamingTextInto(bubble, text) {
  if (!bubble) return;
  const value = String(text ?? '');
  const split = Math.max(0, value.length - 7);
  const nodes = [];
  if (split > 0) nodes.push(document.createTextNode(value.slice(0, split)));
  if (split < value.length) {
    const tail = document.createElement('span');
    tail.className = 'stream-tail';
    tail.textContent = value.slice(split);
    nodes.push(tail);
  }
  const caret = document.createElement('span');
  caret.className = 'stream-caret is-streaming';
  caret.setAttribute('aria-hidden', 'true');
  nodes.push(caret);
  bubble.replaceChildren(...nodes);
  bubble.dataset.renderedText = value;
}

function syncRevealEntry(entry) {
  if (!entry?.bubble || !entry?.article) return;
  entry.shown = entry.target;
  entry.bubble.dataset.renderedText = entry.target;
  entry.article.removeAttribute('aria-busy');
  if (entry.final) {
    entry.article.className = 'message assistant';
    renderMarkdownBuffered(entry.bubble, entry.target);
  } else {
    entry.article.className = 'message assistant streaming';
    entry.bubble.classList.remove('markdown-body');
    renderStreamingTextInto(entry.bubble, entry.target);
  }
}

function flushWordReveals() {
  if (state.wordRevealRaf) cancelAnimationFrame(state.wordRevealRaf);
  state.wordRevealRaf = 0;
  state.wordRevealLastAt = 0;
  for (const entry of state.wordReveal.values()) syncRevealEntry(entry);
  state.wordReveal.clear();
  if (state.scroll.followLatest && els.transcript?.isConnected) {
    state.scroll.programmaticUntil = performance.now() + 120;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
}

function completeRevealEntry(entry) {
  syncRevealEntry(entry);
  state.wordReveal.delete(entry.id);
}

function scheduleWordRevealFrame() {
  if (state.wordRevealRaf || !state.wordReveal.size) return;
  state.wordRevealRaf = requestAnimationFrame(runWordRevealFrame);
}

function runWordRevealFrame(timestamp) {
  state.wordRevealRaf = 0;
  if (!state.wordReveal.size) {
    state.wordRevealLastAt = 0;
    return;
  }
  if (document.hidden || reducedMotionPreferred()) {
    flushWordReveals();
    return;
  }

  const elapsed = state.wordRevealLastAt
    ? Math.min(80, Math.max(0, timestamp - state.wordRevealLastAt))
    : 16.7;
  state.wordRevealLastAt = timestamp;
  let changed = false;

  for (const entry of [...state.wordReveal.values()]) {
    if (!entry.bubble?.isConnected || !entry.article?.isConnected) {
      state.wordReveal.delete(entry.id);
      continue;
    }
    if (entry.index >= entry.chunks.length) {
      completeRevealEntry(entry);
      changed = true;
      continue;
    }

    const wordsRemaining = Math.max(1, entry.remainingWords);
    const wordsPerSecond = streamWordsPerSecond(wordsRemaining, entry.final);
    entry.credit += elapsed * wordsPerSecond / 1000;
    let budget = Math.floor(entry.credit);
    if (budget < 1) continue;
    // Small per-frame batches avoid a large durable revision visually landing as
    // an entire sentence/paragraph at once on high-refresh-rate phones.
    budget = Math.min(3, budget);
    entry.credit -= budget;

    let addition = '';
    let wordsUsed = 0;
    while (entry.index < entry.chunks.length && wordsUsed < budget) {
      const chunk = entry.chunks[entry.index++];
      addition += chunk;
      if (/\S/.test(chunk)) wordsUsed += 1;
    }
    if (!addition && entry.index < entry.chunks.length) continue;
    entry.remainingWords = Math.max(0, entry.remainingWords - wordsUsed);
    entry.shown += addition;
    renderStreamingTextInto(entry.bubble, entry.shown);
    changed = true;

    if (entry.index >= entry.chunks.length && entry.shown === entry.target) {
      completeRevealEntry(entry);
    }
  }

  if (changed && state.scroll.followLatest) {
    state.scroll.programmaticUntil = performance.now() + 90;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  if (state.wordReveal.size) scheduleWordRevealFrame();
  else state.wordRevealLastAt = 0;
}

function queueAssistantReveal(article, bubble, message) {
  const id = message.id;
  const target = String(message.text || '');
  const existing = state.wordReveal.get(id);
  const shown = existing?.shown ?? bubble.dataset.renderedText ?? bubble.textContent ?? '';

  if (reducedMotionPreferred() || !target.startsWith(shown)) {
    cancelWordReveal(id);
    bubble.dataset.renderedText = target;
    article.removeAttribute('aria-busy');
    if (message.final) {
      article.className = 'message assistant';
      renderMarkdownBuffered(bubble, target);
    } else {
      article.className = 'message assistant streaming';
      bubble.classList.remove('markdown-body');
      renderStreamingTextInto(bubble, target);
    }
    return;
  }

  if (target === shown) {
    if (existing) {
      existing.target = target;
      existing.final = message.final === true;
      existing.article = article;
      existing.bubble = bubble;
      if (existing.index >= existing.chunks.length) completeRevealEntry(existing);
    } else if (message.final) {
      article.className = 'message assistant';
      article.removeAttribute('aria-busy');
      renderMarkdownBuffered(bubble, target);
    }
    return;
  }

  let entry = existing;
  if (!entry || entry.bubble !== bubble) {
    cancelWordReveal(id);
    entry = {
      id,
      article,
      bubble,
      target: shown,
      shown,
      chunks: [],
      index: 0,
      remainingWords: 0,
      credit: 0,
      final: false
    };
    state.wordReveal.set(id, entry);
  }

  if (target.startsWith(entry.target)) {
    const appended = streamWordChunks(target.slice(entry.target.length));
    entry.chunks.push(...appended);
    entry.remainingWords += countRevealWords(appended);
  } else {
    entry.chunks = streamWordChunks(target.slice(entry.shown.length));
    entry.index = 0;
    entry.remainingWords = countRevealWords(entry.chunks);
    entry.credit = 0;
  }
  entry.target = target;
  entry.final = message.final === true;
  entry.article = article;
  entry.bubble = bubble;
  article.className = `message assistant ${entry.final ? 'revealing' : 'streaming'}`;
  article.setAttribute('aria-busy', 'true');
  bubble.classList.remove('markdown-body');
  scheduleWordRevealFrame();
}

function createMessageNode(message, { animateStreaming = false } = {}) {
  const article = document.createElement('article');
  article.dataset.timelineKey = `message:${message.id}`;
  article.dataset.messageId = message.id;
  const footer = document.createElement('div');
  footer.className = 'message-footer';
  const meta = document.createElement('div');
  meta.className = 'meta';
  footer.append(meta, createMessageActions(message));
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  article.append(bubble, footer);
  updateMessageNode(article, message, { animateStreaming });
  return article;
}

function updateMessageNode(article, message, { animateStreaming = false } = {}) {
  article.id = messageAnchor(message);
  article.dataset.seq = String(message.seq);
  article.className = `message ${message.role}${message.final ? '' : ' streaming'}`;
  const meta = article.querySelector('.meta');
  if (meta) meta.textContent = message.role === 'user' ? 'You' : 'ChatGPT';
  const bubble = article.querySelector('.bubble');
  if (!bubble) return;
  const signature = `${message.final ? 'f' : 's'}:${message.text}`;
  if (bubble.dataset.messageSignature === signature) return;
  bubble.dataset.messageSignature = signature;
  if (message.role === 'assistant' && (animateStreaming || state.wordReveal.has(message.id))) {
    queueAssistantReveal(article, bubble, message);
  } else if (message.role === 'assistant' && !message.final) {
    bubble.classList.remove('markdown-body');
    renderStreamingTextInto(bubble, message.text);
  } else {
    cancelWordReveal(message.id);
    bubble.dataset.renderedText = String(message.text || '');
    renderMarkdownBuffered(bubble, message.text);
  }
}

function buildTimelineItems() {
  const result = [];
  const session = activeSession();
  const activeResponseKey = session?.activity?.activeResponseKey || null;
  const responseByKey = new Map((state.activity?.responses || []).map((response) => [response.responseKey, response]));
  const { bundles, leadingMessages } = groupPromptTimeline({
    messages: state.messages,
    tools: state.activity?.tools || [],
    visuals: state.activity?.visuals || [],
    responses: state.activity?.responses || [],
    activeResponseKey,
    activityState: session?.activity?.state || 'idle'
  });
  for (const message of leadingMessages) result.push({ kind: 'message', key: `message:${message.id}`, message });

  for (const bundle of bundles) {
    result.push({ kind: 'message', key: `message:${bundle.prompt.id}`, message: bundle.prompt });
    if (bundle.workRows.length || bundle.active) {
      const times = bundle.workRows.map((entry) => Number(entry.kind === 'tool' ? entry.tool.time : entry.message.time) || 0).filter(Boolean);
      const responseRows = [...bundle.responseKeys].map((key) => responseByKey.get(key)).filter(Boolean);
      const lifecycleStarts = responseRows.map((response) => Number(response.startedAt) || 0).filter(Boolean);
      const lifecycleEnds = responseRows.map((response) => Number(response.endedAt) || 0).filter(Boolean);
      const start = lifecycleStarts.length
        ? Math.min(...lifecycleStarts)
        : times.length ? Math.min(...times) : Number(bundle.prompt?.time) || 0;
      const end = !bundle.active && lifecycleEnds.length
        ? Math.max(...lifecycleEnds)
        : times.length ? Math.max(...times) : 0;
      const key = `run:prompt:${bundle.prompt.id}`;
      result.push({
        kind: 'run',
        key,
        active: bundle.active,
        rows: bundle.workRows,
        signature: `${bundle.active ? 'active' : 'done'}|${[...bundle.responseKeys].sort().join(',')}|${bundle.workRows.map((entry) => `${entry.kind}:${entry.seq}:${entry.kind === 'tool' ? `${entry.tool.status}:${entry.tool.responseKey || ''}` : `${entry.message.state || 'streaming'}:${entry.message.responseKey || ''}`}`).join('|')}`,
        startedAt: start,
        elapsed: formatActivityElapsed(start, end),
        clock: formatActivityClock(end)
      });
    }
    if (!state.screen.open) {
      for (const visual of bundle.visuals) result.push({ kind: 'visual', key: `visual:${visual.id}`, visual });
    }
    for (const message of bundle.finals) result.push({ kind: 'message', key: `message:${message.id}`, message });
  }
  return result;
}

function userPromptMessages() {
  return state.messages.filter((message) => message.role === 'user');
}

function renderPromptSectionBar() {
  if (!els.promptSectionBar) return;
  const prompts = activeSession() && !state.draft ? userPromptMessages() : [];
  if (!prompts.length) {
    els.promptSectionBar.classList.add('hidden');
    els.promptSectionBar.removeAttribute('data-message-id');
    return;
  }

  let index = prompts.findIndex((message) => message.id === state.scroll.activePromptId);
  if (index < 0) index = 0;
  const prompt = prompts[index];
  state.scroll.activePromptId = prompt.id;
  const preview = promptPreview(prompt.text, isMobileLayout() ? 72 : 110) || 'Prompt';
  els.promptSectionBar.classList.remove('hidden');
  els.promptSectionBar.dataset.messageId = prompt.id;
  els.promptSectionIndex.textContent = String(index + 1);
  els.promptSectionTotal.textContent = String(prompts.length);
  els.promptSectionText.textContent = preview;
  els.promptSectionProgress.style.width = `${((index + 1) / prompts.length) * 100}%`;
  els.promptSectionBar.setAttribute('aria-label', `Prompt ${index + 1} of ${prompts.length}: ${preview}. Jump to prompt.`);
  els.promptNavigatorButton.title = `Current prompt: ${preview}`;
  els.promptNavigatorButton.setAttribute('aria-label', `Conversation outline. Current prompt: ${preview}`);
}

function syncActivePromptFromScroll({ force = false } = {}) {
  const prompts = userPromptMessages();
  if (!activeSession() || state.draft || !prompts.length || els.transcript.classList.contains('hidden')) {
    if (state.scroll.activePromptId !== null) state.scroll.activePromptId = null;
    renderPromptSectionBar();
    return;
  }
  const nodes = [...els.transcript.querySelectorAll('.message.user[data-message-id]')];
  if (!nodes.length) {
    renderPromptSectionBar();
    return;
  }

  const transcriptRect = els.transcript.getBoundingClientRect();
  const marker = transcriptRect.top + Math.min(96, Math.max(42, els.transcript.clientHeight * 0.16));
  let chosen = nodes[0];
  for (const node of nodes) {
    if (node.getBoundingClientRect().top <= marker) chosen = node;
    else break;
  }
  const nextId = chosen?.dataset.messageId || prompts[0].id;
  if (!force && nextId === state.scroll.activePromptId) return;
  state.scroll.activePromptId = nextId;
  renderPromptSectionBar();
  if (state.conversationPanel.open && state.conversationPanel.mode === 'prompts') renderConversationPanel();
}

function observeUserPrompts() {
  state.promptObserver?.disconnect();
  state.promptObserver = null;
  if (!('IntersectionObserver' in window) || !activeSession()) {
    renderPromptSectionBar();
    return;
  }
  state.promptObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) syncActivePromptFromScroll();
  }, { root: els.transcript, rootMargin: '-8% 0px -70% 0px', threshold: [0, 0.01, 0.5] });
  for (const node of els.transcript.querySelectorAll('.message.user')) state.promptObserver.observe(node);
  requestAnimationFrame(() => syncActivePromptFromScroll({ force: true }));
}

function renderTranscript({ preserveScroll = false, animateStreaming = false, animateMessageIds = null } = {}) {
  const followLatest = !preserveScroll || state.scroll.followLatest;
  const anchor = preserveScroll && !followLatest ? (state.scroll.anchor || captureTranscriptAnchor()) : null;
  const previousMessageIds = new Set([...els.transcript.querySelectorAll('[data-message-id]')].map((node) => node.dataset.messageId));
  const priorTargetById = new Map([...els.transcript.querySelectorAll('.message[data-message-id]')].map((node) => [
    node.dataset.messageId,
    node.querySelector('.bubble')?.dataset.messageSignature || ''
  ]));
  const hasSession = Boolean(activeSession());
  const draft = state.draft;
  if (draft) {
    els.emptyTitle.textContent = draft.submitted ? 'Creating your new chat…' : 'Start a new conversation.';
    els.emptyDescription.textContent = draft.submitted
      ? 'Your first message was accepted. OpenDraw will switch to the exact new COS session as soon as it appears.'
      : `This draft will be created in ${projectNameFromKey(draft.projectId || UNGROUPED_PROJECT)} when you send the first message.`;
  } else {
    els.emptyTitle.textContent = 'Pick up the conversation anywhere.';
    els.emptyDescription.textContent = 'Your phone mirrors Chat On Steroids’ durable conversation history, model, provider and live session state through your private Tailscale connection.';
  }
  els.emptyState.classList.toggle('hidden', hasSession && state.messages.length > 0);
  els.transcript.classList.toggle('hidden', !hasSession || state.messages.length === 0);
  if (!hasSession || !state.messages.length) {
    flushWordReveals();
    els.transcript.replaceChildren();
    state.scroll.atBottom = true;
    state.scroll.followLatest = true;
    state.scroll.unread = 0;
    renderJumpLatest();
    observeUserPrompts();
    return;
  }

  const existing = new Map([...els.transcript.children].map((node) => [node.dataset.timelineKey, node]).filter(([key]) => key));
  const desired = buildTimelineItems();
  pruneVisualObjectUrls(desired);
  let cursor = els.transcript.firstChild;
  for (const item of desired) {
    const animateMessage = item.kind === 'message'
      && (animateMessageIds instanceof Set ? animateMessageIds.has(item.message.id) : animateStreaming);
    let node = existing.get(item.key);
    if (!node) {
      if (item.kind === 'message') node = createMessageNode(item.message, { animateStreaming: animateMessage });
      else if (item.kind === 'tools') node = createToolGroupNode(item);
      else if (item.kind === 'visual') node = createVisualResultNode(item);
      else node = createCompletedRunNode(item);
    }
    else if (item.kind === 'message') updateMessageNode(node, item.message, { animateStreaming: animateMessage });
    else if (item.kind === 'tools') {
      const signature = `${item.running ? 'running|' : ''}${item.tools.map((tool) => `${tool.seq}:${tool.status}:${tool.durationMs ?? ''}`).join('|')}`;
      if (node.dataset.toolSignature !== signature) {
        const open = node.classList.contains('open');
        const wasRunning = node.classList.contains('running');
        const replacement = createToolGroupNode(item);
        const wasCursor = node === cursor;
        replacement._setOpen?.(wasRunning && !item.running ? false : open);
        node.replaceWith(replacement);
        if (wasCursor) cursor = replacement;
        node = replacement;
      }
    } else if (item.kind === 'visual') {
      const signature = `${item.visual.id}:${item.visual.status || ''}:${item.visual.bytes ?? ''}`;
      if (node.dataset.visualSignature !== signature) {
        const replacement = createVisualResultNode(item);
        const wasCursor = node === cursor;
        node.replaceWith(replacement);
        if (wasCursor) cursor = replacement;
        node = replacement;
      }
    } else if (node.dataset.runSignature !== item.signature) {
      const open = node.classList.contains('open');
      const wasRunning = node.classList.contains('running');
      const replacement = createCompletedRunNode(item);
      const wasCursor = node === cursor;
      const nextOpen = wasRunning && !item.active
        ? false
        : (state.workOpen.has(item.key) ? state.workOpen.get(item.key) : open);
      replacement._setOpen?.(nextOpen);
      node.replaceWith(replacement);
      if (wasCursor) cursor = replacement;
      node = replacement;
    }
    if (node !== cursor) els.transcript.insertBefore(node, cursor);
    cursor = node.nextSibling;
    existing.delete(item.key);
  }
  for (const node of existing.values()) node.remove();
  for (const [messageId, entry] of state.wordReveal) {
    if (!entry.bubble?.isConnected || !entry.article?.isConnected) cancelWordReveal(messageId);
  }

  const newMessages = state.messages.filter((message) => !previousMessageIds.has(message.id)).length;
  const streamedUpdate = state.messages.some((message) => previousMessageIds.has(message.id)
    && priorTargetById.get(message.id) !== `${message.final ? 'f' : 's'}:${message.text}`);
  if (preserveScroll && !followLatest && (newMessages || streamedUpdate)) {
    state.scroll.unread += newMessages;
    if (!newMessages && streamedUpdate) state.scroll.unread = Math.max(1, state.scroll.unread);
  }
  if (!followLatest) restoreTranscriptAnchor(anchor, { epoch: state.scroll.epoch });
  if (!followLatest && anchor) state.scroll.anchor = anchor;
  state.scroll.atBottom = followLatest ? true : transcriptNearBottom(32);
  renderJumpLatest();
  observeUserPrompts();
  if (state.conversationPanel.open) renderConversationPanel();
  if (followLatest) {
    const epoch = state.scroll.epoch;
    requestAnimationFrame(() => {
      if (epoch !== state.scroll.epoch || !state.scroll.followLatest) return;
    state.scroll.programmaticUntil = performance.now() + 140;
    els.transcript.scrollTop = els.transcript.scrollHeight;
    });
  }
}

function formatTokenCount(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  return Intl.NumberFormat([], { notation: value >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function compactionBusy() {
  const job = state.controls?.job;
  return Boolean(job && (job.busy || !['done', 'failed', 'cancelled'].includes(job.stage)));
}

function compactionStageLabel(stage) {
  return ({
    'handoff-pending': 'Preparing handoff',
    preparing: 'Preparing handoff',
    'waiting-for-browser': 'Waiting for continuation',
    opening: 'Opening continued chat',
    done: 'Compaction complete',
    failed: 'Compaction interrupted',
    cancelled: 'Compaction cancelled'
  })[stage] || (stage ? 'Compacting context' : 'Compacting context');
}

function currentContextSnapshot() {
  const session = activeSession();
  if (!session) return null;
  const settings = state.cosInfo?.settings;
  const contextTokens = session.usage?.contextTokens ?? 0;
  const pressure = contextPressure(
    contextTokens,
    settings?.sessions?.limitTokens,
    settings?.sessions?.advisoryTokens,
    settings?.compaction?.autoTokens
  );
  const job = state.controls?.job;
  const busy = compactionBusy();
  const failed = job?.stage === 'failed';
  const meter = pressure.percent ?? (pressure.auto ? Math.min(100, (pressure.context / pressure.auto) * 100) : 0);
  return {
    session,
    settings,
    pressure,
    job,
    busy,
    failed,
    percent: Math.max(0, Math.min(100, Number.isFinite(meter) ? meter : 0))
  };
}

function renderContextStatus() {
  const snapshot = currentContextSnapshot();
  if (!snapshot) {
    els.contextStatus.classList.add('hidden');
    return;
  }
  const { settings, pressure, job, busy, failed, percent } = snapshot;
  const contextTokens = pressure.context;
  const shouldShow = contextTokens > 0 || busy || failed || Boolean(settings?.sessions?.limitTokens);
  els.contextStatus.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;

  const level = busy ? 'busy' : failed ? 'danger' : pressure.level;
  els.contextStatus.className = `context-status ${level}`;
  els.contextStatusTitle.textContent = busy ? 'Compacting context' : failed ? 'Context compaction interrupted' : 'Context window';
  els.contextStatusValue.textContent = busy ? '•••' : pressure.limit ? `${Math.round(percent)}%` : 'CTX';
  let detail = '';
  if (busy) {
    detail = `${compactionStageLabel(job?.stage)}${job?.automatic ? ' · automatic' : ''}`;
  } else if (failed) {
    detail = 'Open chat controls to retry when you are ready.';
  } else if (settings?.compaction?.auto && pressure.auto) {
    if (pressure.context >= pressure.auto) detail = 'Automatic compaction threshold reached.';
    else detail = `Auto compact at ${formatTokenCount(pressure.auto)} tokens`;
  } else if (pressure.advisory && pressure.context >= pressure.advisory) {
    detail = 'Context is getting full. Compact when convenient.';
  } else if (pressure.limit && pressure.percent >= 80) {
    detail = 'Context is getting close to its limit.';
  } else {
    detail = 'Current attached conversation context';
  }
  els.contextStatusDetail.textContent = detail;
  els.contextStatusButton.style.setProperty('--context-fill', `${percent}%`);
  els.contextMeterFill.style.height = `${percent}%`;
  els.contextStatusButton.setAttribute('aria-label', busy
    ? `${compactionStageLabel(job?.stage)}. Open context details.`
    : `Context window ${pressure.limit ? `${Math.round(percent)} percent full` : `${formatTokenCount(pressure.context)} tokens`}. Open details.`);
  if (state.contextSheetOpen) renderContextSheet();
}

function setContextSheetMessage(text, kind = '') {
  if (!els.contextSheetMessage) return;
  els.contextSheetMessage.textContent = text || '';
  els.contextSheetMessage.className = `sheet-message${kind ? ` ${kind}` : ''}`;
}

function renderContextSheet() {
  if (!els.contextSheetBackdrop) return;
  const snapshot = currentContextSnapshot();
  if (!state.contextSheetOpen || !snapshot) {
    els.contextSheetBackdrop.classList.add('hidden');
    return;
  }
  els.contextSheetBackdrop.classList.remove('hidden');
  const { settings, pressure, job, busy, failed, percent } = snapshot;
  const level = busy ? 'busy' : failed ? 'danger' : pressure.level;
  els.contextSheet.className = `context-sheet ${level}`;
  els.contextSheetGauge.className = `context-sheet-gauge ${level}`;
  els.contextSheetGauge.style.setProperty('--context-fill', `${percent}%`);
  els.contextSheetFill.style.height = `${percent}%`;
  els.contextSheetPercent.textContent = `${Math.round(percent)}%`;
  els.contextCurrentValue.textContent = pressure.limit
    ? `${formatTokenCount(pressure.context)} / ${formatTokenCount(pressure.limit)} tokens`
    : `${formatTokenCount(pressure.context)} tokens`;
  els.contextLimitValue.textContent = pressure.limit ? `${formatTokenCount(pressure.limit)} tokens` : 'Not reported';
  els.contextAdvisoryValue.textContent = pressure.advisory ? `${formatTokenCount(pressure.advisory)} tokens` : 'Not reported';
  els.contextAutoValue.textContent = pressure.auto ? `${formatTokenCount(pressure.auto)} tokens` : settings?.compaction?.auto ? 'Enabled' : 'Off';
  els.contextModeValue.textContent = settings?.compaction?.auto ? 'Automatic + manual' : 'Manual';
  els.contextStageValue.textContent = busy
    ? `${compactionStageLabel(job?.stage)}${job?.automatic ? ' · automatic' : ' · manual'}`
    : failed ? 'Last compaction was interrupted' : job?.stage === 'done' ? 'Compaction complete' : 'Ready';
  els.contextCompactButton.classList.toggle('hidden', busy);
  els.contextCancelCompactButton.classList.toggle('hidden', !busy);
  els.contextCompactButton.disabled = state.contextSheetBusy || state.sheetBusy || !state.controls || state.controls?.blocked || busy;
  els.contextCancelCompactButton.disabled = state.contextSheetBusy || state.sheetBusy || !busy;
}

async function loadContextControls({ quiet = false } = {}) {
  const session = activeSession();
  if (!session || state.contextSheetBusy) return;
  state.contextSheetBusy = true;
  if (!quiet) setContextSheetMessage('Loading current context state…');
  renderContextSheet();
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/controls`);
    if (activeSession()?.id !== session.id) return;
    state.controls = data.controls || null;
    if (!quiet) setContextSheetMessage('');
  } catch (error) {
    if (!quiet) setContextSheetMessage(`Context controls are temporarily unavailable: ${error.message}`, 'bad');
  } finally {
    state.contextSheetBusy = false;
    renderContextStatus();
    renderContextSheet();
  }
}

function openContextSheet() {
  if (!activeSession()) return;
  releaseTextFocus();
  closeSidebar();
  closeSessionSheet();
  closeConversationPanel();
  closeModelPicker();
  state.contextSheetOpen = true;
  els.contextSheet?._resetDismissGesture?.();
  setContextSheetMessage('');
  renderContextSheet();
  void loadContextControls();
}

function closeContextSheet() {
  releaseTextFocus(els.contextSheet);
  els.contextSheet?._resetDismissGesture?.();
  state.contextSheetOpen = false;
  els.contextSheetBackdrop?.classList.add('hidden');
}

function agentStatusLabel(status) {
  return ({
    working: 'Working',
    sleeping: 'Sleeping',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Cancelled',
    idle: 'Waiting'
  })[status] || 'Waiting';
}

function renderAgentBar() {
  if (!els.agentBar) return;
  const agents = Array.isArray(state.activity?.agents) ? state.activity.agents : [];
  const session = activeSession();
  if (!session || !agents.length) {
    els.agentBar.classList.add('hidden');
    els.agentBar.classList.remove('has-working');
    els.agentBar.open = false;
    els.agentList.replaceChildren();
    return;
  }

  const wasOpen = els.agentBar.open;
  const working = agents.filter((agent) => agent.status === 'working').length;
  const done = agents.filter((agent) => agent.status === 'done').length;
  const sleeping = agents.filter((agent) => agent.status === 'sleeping').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const waiting = agents.filter((agent) => agent.status === 'idle').length;
  const summary = [];
  if (working) summary.push(`${working} working`);
  if (sleeping) summary.push(`${sleeping} sleeping`);
  if (waiting) summary.push(`${waiting} waiting`);
  if (done) summary.push(`${done} done`);
  if (failed) summary.push(`${failed} failed`);
  els.agentSummary.textContent = summary.join(' · ') || `${agents.length} subagents`;
  els.agentCount.textContent = String(agents.length);
  els.agentBar.classList.remove('hidden');
  els.agentBar.classList.toggle('has-working', working > 0);
  els.agentList.replaceChildren();

  for (const agent of agents) {
    const row = document.createElement('div');
    row.className = `agent-row ${agent.status || 'idle'}`;
    const dot = document.createElement('span');
    dot.className = 'agent-state-dot';
    dot.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'agent-row-copy';
    const name = document.createElement('strong');
    name.textContent = agent.label || agent.id || 'subagent';
    const meta = document.createElement('small');
    if (agent.status === 'working' && agent.startedAt) meta.textContent = `Started ${sessionTime(agent.startedAt)}`;
    else if (agent.status === 'sleeping') meta.textContent = `${agent.revivable ? 'Reusable' : 'Sleeping'}${agent.finishedAt ? ` · ${sessionTime(agent.finishedAt)}` : ''}`;
    else if (agent.finishedAt) meta.textContent = `Finished ${sessionTime(agent.finishedAt)}`;
    else if (agent.updatedAt) meta.textContent = `Updated ${sessionTime(agent.updatedAt)}`;
    else meta.textContent = 'Linked to this chat';
    copy.append(name, meta);
    const status = document.createElement('span');
    status.className = 'agent-row-state';
    status.textContent = agentStatusLabel(agent.status);
    row.append(dot, copy, status);
    els.agentList.append(row);
  }

  els.agentBar.open = wasOpen;
}

function renderTaskBar() {
  const steps = Array.isArray(state.activity?.plan?.steps) ? state.activity.plan.steps : [];
  const session = activeSession();
  if (!session || !steps.length) {
    if (!state.taskSignature && els.taskBar.classList.contains('hidden')) return;
    state.taskSignature = '';
    els.taskBar.classList.add('hidden');
    els.taskBar.open = false;
    els.taskSteps.replaceChildren();
    return;
  }
  const signature = `${session.id}|${state.activity?.plan?.updatedAt || 0}|${steps.map((step) => `${step.status}:${step.step}`).join('|')}`;
  if (signature === state.taskSignature && !els.taskBar.classList.contains('hidden')) return;
  state.taskSignature = signature;
  const wasOpen = els.taskBar.open;
  els.taskBar.classList.remove('hidden');
  const completed = steps.filter((step) => ['completed', 'skipped'].includes(step.status)).length;
  const current = steps.find((step) => step.status === 'in_progress')
    || steps.find((step) => step.status === 'pending')
    || steps.at(-1);
  els.taskSummary.textContent = current?.status === 'completed' && completed === steps.length
    ? 'Task complete'
    : current?.step || 'Current task';
  els.taskProgress.textContent = `${completed} / ${steps.length}`;
  els.taskSteps.replaceChildren();
  for (const step of steps) {
    const row = document.createElement('div');
    row.className = `task-step ${step.status}`;
    const icon = document.createElement('span');
    icon.className = 'task-step-icon';
    if (step.status === 'completed') icon.append(createUiIcon('check'));
    else if (step.status === 'failed') icon.textContent = '×';
    else if (step.status === 'in_progress') icon.textContent = '•';
    else if (step.status === 'skipped') icon.textContent = '–';
    else icon.textContent = '○';
    const text = document.createElement('span');
    text.textContent = step.step;
    row.append(icon, text);
    els.taskSteps.append(row);
  }
  els.taskBar.open = wasOpen;
}

function clearConversationHighlights() {
  for (const node of els.transcript.querySelectorAll('.search-match, .search-current')) {
    node.classList.remove('search-match', 'search-current');
  }
}

function scrollToMessage(messageId, { closePanel = false, updateHash = true, highlight = true, closeMobilePanel = true } = {}) {
  const message = state.messages.find((row) => row.id === messageId);
  if (!message) return;
  const node = document.getElementById(messageAnchor(message));
  if (!node) return;
  node.closest('.run-details-group')?._setOpen?.(true);
  if (highlight) {
    clearConversationHighlights();
    node.classList.add('search-current');
  }
  state.scroll.atBottom = false;
  state.scroll.followLatest = false;
  const transcriptRect = els.transcript.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  state.scroll.anchor = { key: node.dataset.timelineKey || `message:${message.id}`, offset: nodeRect.top - transcriptRect.top };
  renderJumpLatest();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const maxScrollTop = Math.max(0, els.transcript.scrollHeight - els.transcript.clientHeight);
  const targetScrollTop = Math.max(0, Math.min(maxScrollTop, els.transcript.scrollTop + nodeRect.top - transcriptRect.top - 10));
  // Never use Element.scrollIntoView here. On mobile it may scroll the visual viewport
  // or outer ancestors and physically lift the fixed bottom composer. Only the
  // transcript owns prompt navigation scrolling.
  if (typeof els.transcript.scrollTo === 'function') {
    els.transcript.scrollTo({ top: targetScrollTop, behavior: reducedMotion ? 'auto' : 'smooth' });
  } else {
    els.transcript.scrollTop = targetScrollTop;
  }
  if (updateHash) history.replaceState(null, '', `#${encodeURIComponent(node.id)}`);
  if (closePanel || (closeMobilePanel && isMobileLayout())) closeConversationPanel();
}

function conversationPromptRows() {
  const query = state.conversationPanel.mode === 'prompts' ? state.conversationPanel.query.trim().toLowerCase() : '';
  return state.messages.filter((message) => message.role === 'user' && (!query || message.text.toLowerCase().includes(query)));
}

function conversationSearchRows() {
  const query = state.conversationPanel.query.trim().toLowerCase();
  if (!query) return [];
  return state.messages.filter((message) => message.text.toLowerCase().includes(query));
}

function renderConversationPanel() {
  if (!state.conversationPanel.open) {
    els.conversationPanelBackdrop.classList.add('hidden');
    return;
  }
  els.conversationPanelBackdrop.classList.remove('hidden');
  const searchMode = state.conversationPanel.mode === 'search';
  els.conversationPanelTitle.textContent = searchMode ? 'Search' : 'Prompt navigator';
  els.promptPanelTab.classList.toggle('active', !searchMode);
  els.searchPanelTab.classList.toggle('active', searchMode);
  els.promptPanelTab.setAttribute('aria-selected', String(!searchMode));
  els.searchPanelTab.setAttribute('aria-selected', String(searchMode));
  els.conversationPanelInput.placeholder = searchMode ? 'Search messages' : 'Filter prompts';
  if (els.conversationPanelInput.value !== state.conversationPanel.query) els.conversationPanelInput.value = state.conversationPanel.query;
  els.conversationSearchControls.classList.toggle('hidden', !searchMode);
  els.conversationPanelList.replaceChildren();
  clearConversationHighlights();

  if (searchMode) {
    const rows = conversationSearchRows();
    state.conversationPanel.results = rows.map((message) => message.id);
    if (state.conversationPanel.index >= rows.length) state.conversationPanel.index = Math.max(0, rows.length - 1);
    const query = state.conversationPanel.query.trim();
    els.conversationSearchSummary.textContent = query
      ? `${rows.length} ${rows.length === 1 ? 'result' : 'results'} for “${promptPreview(query, 32)}”`
      : 'Type to search messages';
    els.conversationSearchPrev.disabled = rows.length === 0;
    els.conversationSearchNext.disabled = rows.length === 0;
    rows.forEach((message, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `conversation-result${index === state.conversationPanel.index ? ' active' : ''}`;
      const role = document.createElement('small');
      role.textContent = message.role === 'user' ? 'You' : 'ChatGPT';
      const text = document.createElement('strong');
      text.textContent = promptPreview(message.text, 100);
      button.append(role, text);
      button.addEventListener('click', () => {
        state.conversationPanel.index = index;
        scrollToMessage(message.id, { closePanel: false });
        renderConversationPanel();
      });
      els.conversationPanelList.append(button);
      document.getElementById(messageAnchor(message))?.classList.add('search-match');
    });
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'conversation-panel-empty';
      empty.textContent = query ? 'No messages found.' : 'Start typing to search this conversation.';
      els.conversationPanelList.append(empty);
    }
    return;
  }

  const prompts = conversationPromptRows();
  state.conversationPanel.results = prompts.map((message) => message.id);
  prompts.forEach((message, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `prompt-result${message.id === state.scroll.activePromptId ? ' active' : ''}`;
    const number = document.createElement('span');
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('div');
    const text = document.createElement('strong');
    text.textContent = promptPreview(message.text, 92);
    const time = document.createElement('small');
    time.textContent = sessionTime(message.time);
    copy.append(text, time);
    button.append(number, copy);
    button.addEventListener('click', () => scrollToMessage(message.id, { closePanel: true }));
    els.conversationPanelList.append(button);
  });
  if (!prompts.length) {
    const empty = document.createElement('div');
    empty.className = 'conversation-panel-empty';
    empty.textContent = state.conversationPanel.query ? 'No prompts match this filter.' : 'No user prompts in this conversation yet.';
    els.conversationPanelList.append(empty);
  }
}

function setConversationPanelMode(mode) {
  releaseTextFocus(els.conversationPanel);
  state.conversationPanel.mode = mode === 'search' ? 'search' : 'prompts';
  state.conversationPanel.query = '';
  state.conversationPanel.results = [];
  state.conversationPanel.index = 0;
  renderConversationPanel();
  if (state.conversationPanel.mode === 'search') focusTextControl(els.conversationPanelInput);
}

function openConversationPanel(mode = 'prompts') {
  if (!activeSession()) return;
  releaseTextFocus();
  closeSidebar();
  closeSessionSheet();
  closeModelPicker();
  closeContextSheet();
  state.conversationPanel.open = true;
  els.conversationPanel?._resetDismissGesture?.();
  state.conversationPanel.mode = mode === 'search' ? 'search' : 'prompts';
  state.conversationPanel.query = '';
  state.conversationPanel.index = 0;
  renderConversationPanel();
  if (state.conversationPanel.mode === 'search') focusTextControl(els.conversationPanelInput);
}

function closeConversationPanel() {
  releaseTextFocus(els.conversationPanel);
  els.conversationPanel?._resetDismissGesture?.();
  state.conversationPanel.open = false;
  state.conversationPanel.query = '';
  state.conversationPanel.results = [];
  els.conversationPanelInput.value = '';
  els.conversationPanelBackdrop.classList.add('hidden');
  clearConversationHighlights();
  requestAnimationFrame(syncVisualViewport);
}

function jumpConversationSearch(direction) {
  const rows = state.conversationPanel.results;
  if (!rows.length) return;
  state.conversationPanel.index = (state.conversationPanel.index + direction + rows.length) % rows.length;
  scrollToMessage(rows[state.conversationPanel.index], { closePanel: false });
  renderConversationPanel();
}

function jumpPrompt(direction) {
  const prompts = state.messages.filter((message) => message.role === 'user');
  if (!prompts.length) return;
  let index = prompts.findIndex((message) => message.id === state.scroll.activePromptId);
  if (index < 0) index = direction > 0 ? -1 : prompts.length;
  index = Math.max(0, Math.min(prompts.length - 1, index + direction));
  scrollToMessage(prompts[index].id, { closePanel: false });
}

async function refreshStatus({ force = false } = {}) {
  if (!force && state.statusRefreshedAt && Date.now() - state.statusRefreshedAt < 5_000) return;
  const data = await api('/api/status');
  if (state.bootId && data.bootId !== state.bootId) state.messages = [];
  state.bootId = data.bootId;
  state.status = data;
  state.statusRefreshedAt = Date.now();
  reconcilePendingSendReceipts(data?.cos?.live?.inputs);
  resolvePendingNewChat(data?.cos?.live?.inputs);
  renderStatusSummary();
  renderHeader();
}

async function refreshModels({ force = false } = {}) {
  if (!force && state.modelsRefreshedAt && Date.now() - state.modelsRefreshedAt < 15_000) return;
  try {
    const data = await api('/api/models');
    const normalized = normalizeModelCatalog(data);
    state.modelCatalog = normalized.models;
    state.modelCatalogState = normalized.state;
    state.modelCatalogSource = normalized.source;
    state.modelsRefreshedAt = Date.now();
    rebuildModelControls();
  } catch (error) {
    if (error.status === 401) throw error;
  }
}

async function refreshCosInfo({ force = false } = {}) {
  if (!force && state.cosInfoRefreshedAt && Date.now() - state.cosInfoRefreshedAt < 5_000) return;
  const suffix = state.activeId ? `?sessionId=${encodeURIComponent(state.activeId)}` : '';
  try {
    state.cosInfo = await api(`/api/cos-info${suffix}`);
    state.cosInfoRefreshedAt = Date.now();
    reconcilePendingSendReceipts(state.cosInfo?.outbox);
    resolvePendingNewChat(state.cosInfo?.outbox);
    renderProjectNav();
    renderSessions();
    renderMobileToolbar();
    renderCosInfo();
    renderContextStatus();
  } catch (error) {
    if (error.status === 401) throw error;
    state.cosInfo = null;
    state.cosInfoRefreshedAt = Date.now();
    renderProjectNav();
    renderSessions();
    renderMobileToolbar();
    renderCosInfo();
    renderContextStatus();
  }
}

async function refreshSessions() {
  const data = await api('/api/sessions');
  if (state.bootId && data.bootId !== state.bootId) state.messages = [];
  state.bootId = data.bootId;
  state.sessions = data.sessions;
  finalizePendingNewChat();
  if (!state.draft && (!state.activeId || !state.sessions.some((session) => session.id === state.activeId))) {
    state.activeId = data.currentSessionId || state.sessions[0]?.id || '';
    if (state.activeId) localStorage.setItem('opendraw.activeSession', state.activeId);
  }
  renderProjectNav();
  renderSessions();
  rebuildModelControls();
  renderHeader();
  renderCosInfo();
  renderContextStatus();
}

function updateSessionFromMessageSnapshot(session) {
  if (!session?.id) return;
  const index = state.sessions.findIndex((row) => row.id === session.id);
  if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...session };
  else if (session.id === state.activeId) state.sessions = [session, ...state.sessions];
}

function mergeMessageUpdates(rows) {
  if (!Array.isArray(rows) || !rows.length) return { changed: false, structural: false, changedIds: [] };
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  let changed = false;
  let structural = false;
  const changedIds = [];
  for (const row of rows) {
    if (!row?.id) continue;
    const held = byId.get(row.id);
    if (held && Number(row.seq) < Number(held.seq)) continue;
    if (!held || row.seq !== held.seq || row.order !== held.order || row.responseKey !== held.responseKey || row.text !== held.text || row.final !== held.final || row.state !== held.state) {
      if (!held || row.seq !== held.seq || row.order !== held.order || row.responseKey !== held.responseKey || row.final !== held.final || row.role !== held.role) structural = true;
      byId.set(row.id, row);
      changed = true;
      changedIds.push(row.id);
    }
  }
  if (!changed) return { changed: false, structural: false, changedIds: [] };
  state.messages = [...byId.values()].sort((a, b) => messageOrder(a) - messageOrder(b) || messageChronology(a) - messageChronology(b) || a.seq - b.seq || a.id.localeCompare(b.id));
  return { changed: true, structural, changedIds };
}

function messageOrder(message) {
  const order = Number(message?.order);
  if (Number.isFinite(order) && order > 0) return order;
  return Number(message?.seq) || 0;
}

async function refreshMessages({ force = false, preserveScroll = true, animateChanges = true, deferRender = false } = {}) {
  if (state.draft || !state.activeId) {
    stopMessageStream();
    state.messages = [];
    state.messageSignature = '';
    if (!deferRender) renderTranscript();
    return { changed: true, animateMessageIds: new Set() };
  }
  if (state.messageRefreshInFlight && !force) return { changed: false, animateMessageIds: new Set() };
  const refreshGeneration = ++state.messageRefreshGeneration;
  state.messageRefreshInFlight = true;
  const requestedSessionId = state.activeId;
  const priorMessages = new Map(state.messages.map((message) => [message.id, message]));
  const priorMaxChronology = state.messages.reduce((max, message) => Math.max(max, messageChronology(message)), 0);
  const hadMessages = state.messages.length > 0;
  try {
  const data = await api(`/api/sessions/${encodeURIComponent(state.activeId)}/messages`);
  if (refreshGeneration !== state.messageRefreshGeneration) return;
  if (state.activeId !== requestedSessionId || state.draft) return;
  const bootChanged = Boolean(state.bootId && data.bootId !== state.bootId);
  if (bootChanged) state.messages = [];
  state.bootId = data.bootId;
  updateSessionFromMessageSnapshot(data.session);
  state.lastFullMessageRefresh = Date.now();
  const signature = messageSignature(data.messages);
  if (!force && signature === state.messageSignature) return { changed: false, animateMessageIds: new Set() };
  const animateMessageIds = new Set();
  if (animateChanges && hadMessages && !bootChanged) {
    for (const message of data.messages) {
      if (message?.role !== 'assistant') continue;
      const prior = priorMessages.get(message.id);
      const changed = !prior
        || prior.seq !== message.seq
        || prior.order !== message.order
        || prior.text !== message.text
        || prior.final !== message.final
        || prior.state !== message.state;
      if (!changed) continue;
      // Only progressive/current assistant work is animated on a full snapshot.
      // Historical finalized messages stay instant when opening or switching chats.
      if ((!prior && messageChronology(message) >= priorMaxChronology) || (prior && !prior.final)) {
        animateMessageIds.add(message.id);
      }
    }
  }
  state.messages = data.messages;
  state.messageSignature = signature;
  if (!deferRender) {
    renderTranscript({ preserveScroll, animateMessageIds });
    renderHeader();
  }
  return { changed: true, animateMessageIds };
  } finally {
    if (refreshGeneration === state.messageRefreshGeneration) state.messageRefreshInFlight = false;
  }
}

async function refreshActivity({ durableOnly = false, render = true, forceFull = false } = {}) {
  const session = activeSession();
  if (!session) {
    state.activityRequestId += 1;
    clearVisualObjectUrls();
    state.activity = { plan: null, tools: [], visuals: [], responses: [], agents: [] };
    state.activityFor = '';
    state.activitySignature = '';
    state.activityRevision = null;
    state.activityTimelineSignature = '';
    state.lastLiveActivityRefresh = 0;
    state.controls = null;
    if (render) {
      renderAgentBar();
      renderTaskBar();
      renderContextStatus();
    }
    return { changed: true, timelineChanged: true };
  }
  const requestedSessionId = session.id;
  const requestId = ++state.activityRequestId;
  const previousStage = state.controls?.job?.stage || null;
  try {
    const existingTools = state.activityFor === requestedSessionId && Array.isArray(state.activity?.tools) ? state.activity.tools : [];
    const existingVisuals = state.activityFor === requestedSessionId && Array.isArray(state.activity?.visuals) ? state.activity.visuals : [];
    const afterSeq = forceFull ? 0 : existingTools.reduce((max, tool) => Math.max(max, Number(tool.seq) || 0), 0);
    const params = new URLSearchParams();
    if (afterSeq > 0) params.set('afterSeq', String(afterSeq));
    if (!forceFull && state.activityFor === requestedSessionId && Number.isFinite(state.activityRevision)) {
      params.set('revision', String(state.activityRevision));
    }
    if (durableOnly) params.set('durableOnly', '1');
    const suffix = params.size ? `?${params.toString()}` : '';
    const data = await api(`/api/sessions/${encodeURIComponent(requestedSessionId)}/activity${suffix}`);
    if (requestId !== state.activityRequestId || activeSession()?.id !== requestedSessionId) return;
    const incoming = Array.isArray(data.tools) ? data.tools : [];
    let tools = incoming;
    if (afterSeq > 0 && existingTools.length && data.resync !== true) {
      const bySeq = new Map(existingTools.map((tool) => [tool.seq, tool]));
      for (const tool of incoming) if (tool?.seq) bySeq.set(tool.seq, tool);
      tools = [...bySeq.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
    }
    const incomingVisuals = Array.isArray(data.visuals) ? data.visuals : [];
    let visuals = incomingVisuals;
    if (afterSeq > 0 && existingVisuals.length && data.resync !== true) {
      const byId = new Map(existingVisuals.map((visual) => [visual.id, visual]));
      for (const visual of incomingVisuals) if (visual?.id) byId.set(visual.id, visual);
      visuals = [...byId.values()].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || String(a.id || '').localeCompare(String(b.id || '')));
    }
    const keepPriorPlan = !data.plan && state.activityFor === requestedSessionId && activeSession()?.activity?.state === 'active';
    const responses = Array.isArray(data.responses) ? data.responses : (state.activityFor === requestedSessionId ? state.activity?.responses || [] : []);
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const nextActivity = { plan: data.plan || (keepPriorPlan ? state.activity?.plan || null : null), tools, visuals, responses, agents };
    const lastTool = tools.at(-1);
    const liveSession = activeSession();
    const agentSignature = agents.map((agent) => `${agent.id}:${agent.label || ''}:${agent.status}:${agent.startedAt || 0}:${agent.finishedAt || agent.updatedAt || 0}:${agent.revivable ? 1 : 0}`).join('|');
    const visualSignature = visuals.map((visual) => `${visual.id}:${visual.responseKey || ''}:${visual.status || ''}:${visual.bytes ?? ''}`).join('|');
    const responseSignature = responses.map((response) => `${response.responseKey}:${response.startedSeq || 0}:${response.endedSeq || 0}:${response.outcome || ''}`).join('|');
    const toolOwnershipSignature = tools.map((tool) => `${tool.seq}:${tool.responseKey || ''}:${tool.status || ''}:${tool.durationMs ?? ''}`).join('|');
    const nextTimelineSignature = `${requestedSessionId}|${liveSession?.activity?.state || ''}:${liveSession?.activity?.lastTurnEndAt || 0}|${tools.length}:${toolOwnershipSignature}|responses:${responseSignature}|visuals:${visualSignature}`;
    const nextSignature = `${requestedSessionId}|${liveSession?.activity?.state || ''}:${liveSession?.activity?.lastTurnEndAt || 0}|${nextActivity.plan?.updatedAt || 0}|${nextActivity.plan?.steps?.map((step) => `${step.status}:${step.step}`).join('|') || ''}|${tools.length}:${lastTool?.seq || 0}:${lastTool?.status || ''}:${toolOwnershipSignature}|responses:${responseSignature}|visuals:${visualSignature}|agents:${agentSignature}`;
    const activityChanged = nextSignature !== state.activitySignature;
    const timelineChanged = nextTimelineSignature !== state.activityTimelineSignature;
    state.activity = nextActivity;
    state.activityFor = requestedSessionId;
    if (Number.isFinite(data.revision)) state.activityRevision = data.revision;
    if (!durableOnly) state.lastLiveActivityRefresh = Date.now();
    if (data.controlsAvailable) state.controls = data.controls || null;
    if (render) {
      if (activityChanged) {
        renderAgentBar();
        renderTaskBar();
      }
      renderContextStatus();
      if (timelineChanged) renderTranscript({ preserveScroll: true });
    }
    state.activitySignature = nextSignature;
    state.activityTimelineSignature = nextTimelineSignature;
    const nextStage = state.controls?.job?.stage || null;
    if (previousStage && previousStage !== nextStage && ['done', 'failed', 'cancelled', null].includes(nextStage)) {
      void refreshMessages({ force: true, preserveScroll: true });
    }
    return { changed: activityChanged, timelineChanged };
  } catch (error) {
    if (error.status === 401) throw error;
    if (requestId !== state.activityRequestId || activeSession()?.id !== requestedSessionId) return;
    if (state.activityFor !== requestedSessionId) {
      clearVisualObjectUrls();
      state.activity = { plan: null, tools: [], visuals: [], responses: [], agents: [] };
      state.activityFor = requestedSessionId;
      state.activitySignature = '';
      state.activityRevision = null;
      state.activityTimelineSignature = '';
      if (render) {
        renderAgentBar();
        renderTaskBar();
      }
    }
    if (render) renderContextStatus();
    return { changed: false, timelineChanged: false };
  }
}

function messageCursor() {
  return state.messages.reduce((max, message) => Math.max(max, Number(message.seq) || 0), 0);
}

function stopMessageStream() {
  state.messagePollAbort?.abort();
  state.messagePollAbort = null;
}

function startMessageStream() {
  stopMessageStream();
  const session = activeSession();
  const backgroundWatch = document.hidden && completionNotificationWatchEnabled();
  if (!state.token || !session || (document.hidden && !backgroundWatch)) return;
  const sessionId = session.id;
  const controller = new AbortController();
  state.messagePollAbort = controller;
  void (async () => {
    while (!controller.signal.aborted && state.token && activeSession()?.id === sessionId && (!document.hidden || completionNotificationWatchEnabled())) {
      try {
        if (!state.messages.length) {
          await refreshMessages({ force: true, preserveScroll: false });
          if (!state.messages.length) {
            await new Promise((resolve) => setTimeout(resolve, 700));
            continue;
          }
        }
        if (!document.hidden && Date.now() - state.lastFullMessageRefresh > 15_000) {
          await refreshMessages({ force: true, preserveScroll: true });
        }
        const cursor = messageCursor();
        const priorTurnId = activeSession()?.activity?.activeTurnId || null;
        const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages?afterSeq=${cursor}&waitMs=18000`, {
          signal: controller.signal
        });
        if (controller.signal.aborted || activeSession()?.id !== sessionId) break;
        if (state.bootId && data.bootId !== state.bootId) {
          state.messages = [];
          state.messageSignature = '';
          state.bootId = data.bootId;
          await refreshMessages({ force: true, preserveScroll: true });
          continue;
        }
        state.bootId = data.bootId;
        updateSessionFromMessageSnapshot(data.session);
        const merged = mergeMessageUpdates(data.messages);
        if (merged.changed) {
          state.messageSignature = messageSignature(state.messages);
          const finalAssistant = [...(data.messages || [])].reverse().find((message) => message?.role === 'assistant' && message.final === true);
          const turnFinished = Boolean(priorTurnId && !activeSession()?.activity?.activeTurnId);
          if (finalAssistant && (turnFinished || merged.changedIds.includes(finalAssistant.id))) {
            void notifyAnswerReady(sessionId, finalAssistant);
          }
          if (document.hidden) continue;
          const changedMessage = merged.changedIds.length === 1
            ? state.messages.find((message) => message.id === merged.changedIds[0])
            : null;
          const latestMessage = state.messages.at(-1);
          const liveNode = changedMessage
            ? [...els.transcript.children].find((node) => node.dataset?.messageId === changedMessage.id && node.classList.contains('message'))
            : null;
          const fastStreamingUpdate = !merged.structural
            && changedMessage?.role === 'assistant'
            && changedMessage.id === latestMessage?.id
            && liveNode;
          if (fastStreamingUpdate) {
            updateMessageNode(liveNode, changedMessage, { animateStreaming: true });
            if (!state.scroll.followLatest) {
              state.scroll.unread = Math.max(1, state.scroll.unread);
              renderJumpLatest();
            } else if (!state.wordReveal.has(changedMessage.id)) {
              requestAnimationFrame(() => {
                if (!state.scroll.followLatest) return;
                state.scroll.programmaticUntil = performance.now() + 90;
                els.transcript.scrollTop = els.transcript.scrollHeight;
              });
            }
          } else {
            renderTranscript({ preserveScroll: true, animateMessageIds: new Set(merged.changedIds) });
          }
          renderHeader();
          setConnection('online', 'Connected');
        }
        // An already-running pre-v14 server does not understand waitMs and returns an
        // immediate ordinary snapshot. Back off instead of hot-looping until the user
        // restarts OpenDraw and the long-poll route becomes available.
        if (data.waited !== true && (!Array.isArray(data.messages) || data.messages.length === 0)) {
          await new Promise((resolve) => setTimeout(resolve, 900));
        }
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') break;
        if (error.status === 401) break;
        setConnection('offline', 'Offline');
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
  })();
}

async function refresh({ forceMessages = false, animateMessages = true, waitForBackground = false } = {}) {
  if (!state.token) return;
  try {
    // Sessions are cheap durable metadata and establish the active target. Live COS
    // model/status calls stay secondary so a slow renderer can never hold the chat UI.
    const background = Promise.allSettled([
      refreshStatus({ force: forceMessages }),
      refreshModels({ force: forceMessages })
    ]);
    await refreshSessions();
    const shouldFullMessages = !document.hidden && (forceMessages || !state.messages.length || Date.now() - state.lastFullMessageRefresh > 15_000);
    const coldTranscript = Boolean(activeSession() && !state.draft && (!state.messages.length || state.activityFor !== state.activeId));
    if (coldTranscript) {
      // Fetch the two durable transcript halves together and commit them in one JS
      // turn. This prevents the visible messages-first/tools-later hydration cascade.
      const [messageResult] = await Promise.all([
        refreshMessages({ force: true, preserveScroll: true, animateChanges: false, deferRender: true }),
        refreshActivity({ durableOnly: true, render: false, forceFull: true })
      ]);
      renderTranscript({ preserveScroll: true, animateMessageIds: messageResult?.animateMessageIds || new Set() });
      renderHeader();
      renderAgentBar();
      renderTaskBar();
      renderContextStatus();
    } else {
      await Promise.all([
        shouldFullMessages ? refreshMessages({ force: forceMessages, preserveScroll: true, animateChanges: animateMessages }) : Promise.resolve(),
        refreshActivity({ durableOnly: true })
      ]);
    }

    const liveActivityDue = !document.hidden && Date.now() - state.lastLiveActivityRefresh > (activeSession()?.activity?.state === 'active' ? 8_000 : 15_000);
    const secondary = Promise.allSettled([
      refreshCosInfo({ force: forceMessages }),
      liveActivityDue ? refreshActivity() : Promise.resolve()
    ]);
    if (waitForBackground) await Promise.all([background, secondary]);
    else {
      void secondary;
      void background.then(() => {
      if (!state.token) return;
      renderHeader();
      renderStatusSummary();
      });
    }
    setConnection('online', 'Connected');
  } catch (error) {
    if (error.status !== 401) setConnection('offline', 'Offline');
  } finally {
    renderHeader();
    renderAgentBar();
    renderTaskBar();
    renderContextStatus();
  }
}

function scheduleRefresh(delay = 4_000) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    await refresh();
    const nextDelay = document.hidden
      ? 30_000
      : compactionBusy()
        ? 1_500
        : activeSession()?.activity?.state === 'active' ? 4_000 : 8_000;
    scheduleRefresh(nextDelay);
  }, delay);
}

async function selectSession(id) {
  if (id === state.activeId) {
    closeSidebar();
    return;
  }
  rememberSessionScroll();
  saveComposerDraft();
  flushWordReveals();
  stopVoiceRecognition();
  stopMessageStream();
  closeSessionSheet();
  closeConversationPanel();
  state.draft = null;
  state.activeId = id;
  state.controls = null;
  state.queue = [];
  clearVisualObjectUrls();
  state.activity = { plan: null, tools: [], visuals: [], responses: [], agents: [] };
  state.activityFor = '';
  state.activitySignature = '';
  state.activityRevision = null;
  state.activityTimelineSignature = '';
  state.lastLiveActivityRefresh = 0;
  state.messageSignature = '';
  state.lastFullMessageRefresh = 0;
  state.scroll = { atBottom: true, followLatest: true, unread: 0, activePromptId: null, raf: 0, programmaticUntil: 0, anchor: null, userIntent: false, epoch: 0 };
  if (!state.sendInFlight && !state.connectionRetryBusy) {
    clearTimeout(state.sendUiTimer);
    state.sendUiTimer = null;
    state.sendUiState = 'idle';
  }
  setSendStatus('');
  localStorage.setItem('opendraw.activeSession', id);
  state.messages = [];
  renderProjectNav();
  renderSessions();
  rebuildModelControls();
  restoreComposerDraft({ key: `session:${id}` });
  renderHeader();
  renderCosInfo();
  renderTranscript();
  closeSidebar();
  try {
    const [messageResult] = await Promise.all([
      refreshMessages({ force: true, preserveScroll: false, animateChanges: false, deferRender: true }),
      refreshActivity({ durableOnly: true, render: false, forceFull: true })
    ]);
    renderTranscript({ preserveScroll: false, animateMessageIds: messageResult?.animateMessageIds || new Set() });
    renderHeader();
    renderAgentBar();
    renderTaskBar();
    renderContextStatus();
    restoreSessionScroll(id);
    startMessageStream();
    void Promise.allSettled([
      refreshModels({ force: true }),
      refreshCosInfo(),
      refreshActivity()
    ]);
  } catch { /* next poll will recover */ }
}

function setSendStatus(text, kind = '') {
  els.sendStatus.textContent = text;
  els.sendStatus.className = `send-status${kind ? ` ${kind}` : ''}`;
}

function showToast(text, kind = '') {
  if (!els.toast || !text) return;
  clearTimeout(state.toastTimer);
  els.toast.textContent = text;
  els.toast.className = `toast${kind ? ` ${kind}` : ''}`;
  state.toastTimer = setTimeout(() => {
    els.toast.className = 'toast hidden';
  }, 3200);
}

function setSheetMessage(text, kind = '') {
  if (!els.sheetMessage) return;
  els.sheetMessage.textContent = text || '';
  els.sheetMessage.className = `sheet-message${kind ? ` ${kind}` : ''}`;
}

function voiceErrorMessage(code) {
  return {
    'not-allowed': 'Microphone permission was denied. Allow microphone access in browser settings and retry.',
    'service-not-allowed': 'Voice recognition permission was denied by this browser.',
    'audio-capture': 'No working microphone was found for voice dictation.',
    'no-speech': 'No speech was heard. Tap the microphone and try again.',
    network: 'Voice recognition could not reach its speech service.',
    'language-not-supported': 'This browser does not support voice recognition for your current language.'
  }[code] || 'Voice dictation stopped because speech recognition failed.';
}

function voiceIsActive() {
  const voice = state.voice;
  return voice.starting || voice.listening || voice.stopping;
}

function renderVoiceState() {
  if (!els.voiceButton || !els.voiceStatus) return;
  const voice = state.voice;
  const hasTarget = Boolean(activeSession() || (state.draft && !state.draft.submitted));
  const active = voiceIsActive();
  els.voiceButton.disabled = !voice.supported || !hasTarget || voice.starting || voice.stopping;
  els.voiceButton.classList.toggle('listening', active);
  els.voiceButton.setAttribute('aria-pressed', active ? 'true' : 'false');
  els.voiceButton.setAttribute('aria-label', voice.listening ? 'Stop voice dictation' : 'Start voice dictation');
  els.voiceButton.title = voice.listening ? 'Stop voice dictation' : voice.starting ? 'Starting voice dictation' : voice.stopping ? 'Stopping voice dictation' : 'Voice dictation';
  els.voiceStatus.className = `voice-status${voice.status === 'error' ? ' bad' : active ? ' listening' : ''}`;
  if (!voice.supported) {
    els.voiceStatus.textContent = 'Voice dictation is unavailable in this browser.';
  } else if (voice.status === 'error') {
    els.voiceStatus.textContent = voice.error;
  } else if (voice.starting) {
    els.voiceStatus.textContent = 'Starting microphone…';
  } else if (voice.stopping) {
    els.voiceStatus.textContent = 'Finishing dictation…';
  } else if (voice.listening) {
    els.voiceStatus.textContent = 'Listening… tap the microphone to stop.';
  } else {
    els.voiceStatus.textContent = '';
  }
}

function initVoiceRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (typeof Recognition !== 'function') {
    state.voice.supported = false;
    renderVoiceState();
    return;
  }
  let recognition;
  try {
    recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || document.documentElement.lang || 'en-US';
  } catch {
    state.voice.supported = false;
    renderVoiceState();
    return;
  }
  state.voice.supported = true;
  state.voice.recognition = recognition;

  recognition.addEventListener('start', () => {
    const voice = state.voice;
    voice.starting = false;
    voice.listening = true;
    if (!voice.acceptResults) {
      voice.stopping = true;
      voice.status = 'stopping';
      try { recognition.abort(); } catch { /* recognition is already ending */ }
    } else {
      voice.stopping = false;
      voice.status = 'listening';
      voice.error = '';
    }
    renderVoiceState();
    renderHeader();
  });
  recognition.addEventListener('result', (event) => {
    const voice = state.voice;
    if (!voice.acceptResults) return;
    voice.parts = updateSpeechParts(voice.parts, event.results, event.resultIndex);
    const speech = speechPartsText(voice.parts);
    voice.finalText = speech.finalText;
    voice.error = '';
    if (!voice.stopping) voice.status = 'listening';
    const maxLength = Number(els.messageInput.maxLength) > 0 ? Number(els.messageInput.maxLength) : 16_000;
    els.messageInput.value = combineBaseAndSpeech(voice.baseText, speech.spokenText).slice(0, maxLength);
    scheduleComposerDraftSave();
    resizeComposer();
  });
  recognition.addEventListener('error', (event) => {
    const voice = state.voice;
    const quietlyAborted = event.error === 'aborted' && (voice.stopping || !voice.acceptResults);
    voice.starting = false;
    voice.listening = false;
    voice.stopping = false;
    voice.acceptResults = false;
    voice.parts = [];
    voice.finalText = '';
    voice.baseText = '';
    voice.status = quietlyAborted ? 'idle' : 'error';
    voice.error = quietlyAborted ? '' : voiceErrorMessage(event.error);
    renderVoiceState();
    renderHeader();
  });
  recognition.addEventListener('nomatch', () => {
    state.voice.status = 'error';
    state.voice.error = 'Speech was detected, but no words could be recognized. Try again a little closer to the microphone.';
    renderVoiceState();
  });
  recognition.addEventListener('end', () => {
    const voice = state.voice;
    voice.starting = false;
    voice.listening = false;
    voice.stopping = false;
    voice.acceptResults = false;
    voice.baseText = '';
    voice.parts = [];
    voice.finalText = '';
    if (voice.status !== 'error') voice.status = 'idle';
    renderVoiceState();
    renderHeader();
  });
  renderVoiceState();
}

function toggleVoiceRecognition() {
  const voice = state.voice;
  if (!voice.supported || !voice.recognition || !(activeSession() || (state.draft && !state.draft.submitted))) {
    renderVoiceState();
    return;
  }
  if (voice.listening) {
    voice.stopping = true;
    voice.status = 'stopping';
    try { voice.recognition.stop(); } catch {
      voice.listening = false;
      voice.stopping = false;
      voice.acceptResults = false;
      voice.baseText = '';
      voice.parts = [];
      voice.finalText = '';
      voice.status = 'idle';
    }
    renderVoiceState();
    renderHeader();
    return;
  }
  if (voice.starting || voice.stopping) return;
  voice.baseText = els.messageInput.value;
  voice.parts = [];
  voice.finalText = '';
  voice.acceptResults = true;
  voice.starting = true;
  voice.status = 'starting';
  voice.error = '';
  renderVoiceState();
  renderHeader();
  try {
    voice.recognition.start();
  } catch (error) {
    voice.starting = false;
    voice.acceptResults = false;
    voice.baseText = '';
    voice.status = 'error';
    voice.error = error?.name === 'InvalidStateError'
      ? 'Voice dictation is already starting. Try the microphone again in a moment.'
      : 'Voice dictation could not start in this browser.';
    renderVoiceState();
    renderHeader();
  }
}

function stopVoiceRecognition() {
  const voice = state.voice;
  if (!voice.recognition || !voiceIsActive()) return;
  voice.acceptResults = false;
  voice.stopping = true;
  voice.status = 'stopping';
  voice.baseText = '';
  voice.parts = [];
  voice.finalText = '';
  try {
    if (typeof voice.recognition.abort === 'function') voice.recognition.abort();
    else voice.recognition.stop();
  } catch {
    voice.starting = false;
    voice.listening = false;
    voice.stopping = false;
    voice.status = 'idle';
  }
  renderVoiceState();
}

function draftFingerprint(draft, text, model, reasoningEffort, screen = false) {
  return JSON.stringify({
    projectId: draft.projectId || null,
    text,
    model: model || null,
    reasoningEffort: reasoningEffort || null,
    screen: screen === true
  });
}

async function sendNewChat(text) {
  const draft = state.draft;
  if (!draft || draft.submitted || state.sendInFlight) return;
  const targetKey = draft.storageKey || newChatDraftBaseKey(draft.projectId);
  if (!state.status?.cos?.live?.send?.available) {
    return retryCosConnection();
  }
  if (!text.trim()) return;
  if (state.pendingNewChat && state.pendingNewChat.id !== draft.pendingId) {
    const message = 'Another new chat is still being created. You can keep browsing, but wait for it to finish before sending a second new chat.';
    setSendStatus(message, 'bad');
    showToast(message, 'bad');
    return;
  }
  const model = els.modelSelect.value || draft.model || null;
  const reasoningEffort = els.reasoningSelect.value || null;
  const pendingAttempt = pendingDraftAttempt(draft.pendingId, draft.pendingFingerprint, {
    projectId: draft.projectId || null,
    text,
    model,
    reasoningEffort
  });
  const screen = pendingAttempt ? pendingAttempt.screen : state.screen.open;
  const fingerprint = draftFingerprint(draft, text, model, reasoningEffort, screen);
  if (!pendingAttempt) {
    draft.pendingId = crypto.randomUUID();
  }
  draft.pendingFingerprint = fingerprint;
  const id = draft.pendingId;
  draft.firstText = text;
  state.pendingNewChat = {
    id,
    draftKey: targetKey,
    fingerprint,
    firstText: text,
    projectId: draft.projectId || null,
    model,
    reasoningEffort,
    screen,
    resolvedSessionId: null
  };
  state.sendInFlight = true;
  state.sendUiState = 'creating';
  updateComposerSendState();
  setSendStatus('Creating new Chat On Steroids chat…');
  try {
    const data = await api('/api/chats', {
      method: 'POST',
      body: JSON.stringify({
        id,
        text,
        projectId: draft.projectId || null,
        model,
        reasoningEffort,
        screen
      })
    });
    draft.submitted = true;
    draft.model = model;
    draft.reasoningEffort = reasoningEffort;
    const settled = settleSentComposerTarget(targetKey, text);
    const status = data.result?.status;
    const successCopy = status === 'sent' ? 'First message sent · creating chat…' : 'First message accepted · creating chat…';
    if (settled.sameTarget) {
      setSendStatus(successCopy, 'good');
      if (settled.hasRemainingText) {
        clearTimeout(state.sendUiTimer);
        state.sendUiTimer = null;
        state.sendUiState = 'idle';
      } else {
        setTransientSendButtonState('sent', 1400);
      }
    } else {
      clearTimeout(state.sendUiTimer);
      state.sendUiTimer = null;
      state.sendUiState = 'idle';
      setSendStatus('');
      showToast(successCopy.replace('…', ' in the background.'), 'good');
    }
    rebuildModelControls({ preferSession: true });
    renderHeader();
    renderTranscript();
    await Promise.all([refreshStatus(), refreshSessions(), refreshCosInfo()]);
  } catch (error) {
    draft.submitted = false;
    const sendUnavailable = error.status === 503 && error.data?.error === 'send_unavailable';
    if (sendUnavailable && state.status?.cos?.live?.send) state.status.cos.live.send.available = false;
    if (error.status && error.status !== 503 && error.status !== 401) {
      if (state.pendingNewChat?.id === id) state.pendingNewChat = null;
      draft.pendingId = null;
      draft.pendingFingerprint = null;
    }
    const errorCopy = error.status === 503 && error.data?.error === 'screen_unavailable'
      ? `Could not attach the current screen: ${error.message}`
      : error.status === 503
      ? 'New chat is not confirmed yet. Retry will reuse the same safe message ID.'
      : `Could not create chat: ${error.message}`;
    if (composerDraftTargetKey() === targetKey) {
      setSendStatus(errorCopy, 'bad');
      state.sendUiState = 'error';
    } else {
      clearTimeout(state.sendUiTimer);
      state.sendUiTimer = null;
      state.sendUiState = 'idle';
      setSendStatus('');
      showToast(`Previous new-chat send: ${errorCopy}`, 'bad');
    }
    rebuildModelControls({ preferSession: true });
    renderHeader();
  } finally {
    state.sendInFlight = false;
    updateComposerSendState();
  }
}

function renderMarkdownBuffered(container, rawText) {
  const staging = document.createElement('div');
  renderMarkdownInto(staging, rawText);
  container.replaceChildren(...staging.childNodes);
  container.classList.add('markdown-body');
}

async function stopActiveTurn() {
  const session = activeSession();
  const expectedTurnId = session?.activity?.activeTurnId;
  if (!session || !expectedTurnId || state.stoppingTurn) return;
  state.stoppingTurn = true;
  renderHeader();
  setSendStatus('Stopping active turn…');
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ expectedTurnId })
    });
    setSendStatus('Stop requested', 'good');
    await refresh();
    setTimeout(() => setSendStatus(''), 1800);
  } catch (error) {
    if (error.status === 409) {
      setSendStatus('That turn already changed. Refreshing…', 'bad');
      await refresh().catch(() => undefined);
    } else {
      setSendStatus(`Could not stop turn: ${error.message}`, 'bad');
    }
  } finally {
    state.stoppingTurn = false;
    renderHeader();
  }
}

function primaryComposerAction() {
  const session = activeSession();
  const hasText = Boolean(els.messageInput.value.trim());
  if (!state.draft && session?.activity?.activeTurnId && !hasText) {
    void stopActiveTurn();
    return;
  }
  void sendMessage();
}

async function sendMessage() {
  const text = els.messageInput.value;
  if (voiceIsActive()) return;
  if (state.draft) return sendNewChat(text);
  const session = activeSession();
  if (!session || state.sendInFlight) return;
  const targetKey = `session:${session.id}`;
  if (!state.status?.cos?.live?.send?.available) {
    return retryCosConnection();
  }
  if (!text.trim()) return;
  const model = els.modelSelect.value || session.selectedModel?.model || null;
  const reasoningEffort = els.reasoningSelect.value || null;
  const mode = 'auto';
  const pendingAttempt = pendingMessageAttempt(readPendingSends(session.id), {
    sessionId: session.id,
    conversationId: session.conversationId,
    text,
    model,
    reasoningEffort,
    mode
  });
  const screen = pendingAttempt ? pendingAttempt.screen : state.screen.open;
  const fingerprint = outboundFingerprint(session, text, model, reasoningEffort, mode, screen);
  const id = pendingAttempt?.id || messageIdForAttempt(session, fingerprint);
  state.sendInFlight = true;
  state.sendUiState = 'sending';
  updateComposerSendState();
  setSendStatus(screen ? 'Sending with the current screen…' : 'Sending to Chat On Steroids…');
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ id, conversationId: session.conversationId, text, model, reasoningEffort, mode, screen })
    });
    if (sendReceiptTerminal(data.result)) clearPendingSend(session.id, id);
    const settled = settleSentComposerTarget(targetKey, text);
    const status = data.result?.status;
    const successCopy = status === 'sent' ? 'Sent' : status === 'queued' ? 'Queued in Chat On Steroids' : 'Accepted by Chat On Steroids';
    if (settled.sameTarget) {
      setSendStatus(successCopy, 'good');
      if (settled.hasRemainingText) {
        clearTimeout(state.sendUiTimer);
        state.sendUiTimer = null;
        state.sendUiState = 'idle';
      } else {
        setTransientSendButtonState('sent', 1400);
      }
    } else {
      clearTimeout(state.sendUiTimer);
      state.sendUiTimer = null;
      state.sendUiState = 'idle';
      setSendStatus('');
      showToast(`${successCopy} in ${session.title || 'the previous chat'}.`, 'good');
    }
    void refreshCosInfo();
    setTimeout(() => setSendStatus(''), 2400);
  } catch (error) {
    const sendUnavailable = error.status === 503 && error.data?.error === 'send_unavailable';
    if (sendUnavailable && state.status?.cos?.live?.send) state.status.cos.live.send.available = false;
    if (error.status && error.status !== 503 && error.status !== 401) clearPendingSend(session.id, id);
    const errorCopy = error.status === 503 && error.data?.error === 'screen_unavailable'
      ? `Could not attach the current screen: ${error.message}`
      : error.status === 503
      ? 'Send is not confirmed yet. Retry will reuse the same safe message ID.'
      : `Could not send: ${error.message}`;
    if (composerDraftTargetKey() === targetKey) {
      setSendStatus(errorCopy, 'bad');
      state.sendUiState = 'error';
    } else {
      clearTimeout(state.sendUiTimer);
      state.sendUiTimer = null;
      state.sendUiState = 'idle';
      setSendStatus('');
      showToast(`Previous chat send: ${errorCopy}`, 'bad');
    }
  } finally {
    state.sendInFlight = false;
    renderHeader();
  }
}

function resizeComposer() {
  const viewportHeight = window.visualViewport?.scale === 1
    ? window.visualViewport.height
    : window.innerHeight;
  const maxHeight = Math.max(86, Math.min(150, Math.round((viewportHeight || 600) * 0.28)));
  const minHeight = Math.max(32, Number.parseFloat(getComputedStyle(els.messageInput).minHeight) || 32);
  // Chrome's intrinsic `height:auto` textarea is taller than a single line on mobile,
  // even with rows=1. Measure from the compact floor instead so the prompt bar stays
  // one row until actual text wrapping/newlines require more room.
  els.messageInput.style.height = `${minHeight}px`;
  const contentHeight = els.messageInput.value ? els.messageInput.scrollHeight : minHeight;
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, contentHeight));
  els.messageInput.style.height = `${nextHeight}px`;
  els.messageInput.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  updateComposerSendState();
  syncComposerHeight();
}

function syncComposerHeight() {
  if (!els.composerShell) return;
  const height = Math.max(0, Math.ceil(els.composerShell.getBoundingClientRect().height));
  if (height === state.composerHeight) return;
  const follow = state.scroll.followLatest;
  state.composerHeight = height;
  document.documentElement.style.setProperty('--composer-height', `${height}px`);
  if (follow) {
    const epoch = state.scroll.epoch;
    requestAnimationFrame(() => {
      if (epoch !== state.scroll.epoch || !state.scroll.followLatest) return;
      state.scroll.programmaticUntil = performance.now() + 140;
      els.transcript.scrollTop = els.transcript.scrollHeight;
    });
  } else if (state.scroll.anchor) {
    const epoch = state.scroll.epoch;
    const anchor = state.scroll.anchor;
    requestAnimationFrame(() => restoreTranscriptAnchor(anchor, { settle: false, epoch }));
  }
}

function syncVisualViewport() {
  if (state.viewportRaf) return;
  state.viewportRaf = requestAnimationFrame(() => {
    state.viewportRaf = 0;
    const viewport = window.visualViewport;
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight || 0;
    const visualHeight = viewport && viewport.scale === 1 && Number.isFinite(viewport.height) ? viewport.height : layoutHeight;
    const visualBottom = viewport && viewport.scale === 1 && Number.isFinite(viewport.height)
      ? viewport.height + (Number.isFinite(viewport.offsetTop) ? viewport.offsetTop : 0)
      : layoutHeight;
    const focused = document.activeElement;
    const composerFocused = focused === els.messageInput;
    const editableFocused = composerFocused || focused?.matches?.('input, textarea, [contenteditable="true"]');
    if (!state.viewportBaseline || (!editableFocused && visualHeight > 0) || visualHeight > state.viewportBaseline) {
      state.viewportBaseline = visualHeight;
    }
    if (state.screen.open) syncScreenViewportGeometry();
    const keyboardOpen = Boolean(composerFocused && viewport && viewport.scale === 1 && (
      layoutHeight - visualBottom > 80
      || state.viewportBaseline - visualHeight > 80
    ));
    document.documentElement.classList.toggle('keyboard-open', keyboardOpen);
    // Search/filter keyboards belong to their overlay. Do not resize the hidden
    // chat footer behind them; only the actual message textarea owns composer geometry.
    if (!editableFocused || composerFocused) {
      resizeComposer();
      syncComposerHeight();
    }
  });
}

function trapFocus(event, container) {
  if (event.key !== 'Tab' || !container || container.classList.contains('hidden')) return false;
  const focusable = [...container.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return false;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

function showPairing() {
  els.pairing.classList.remove('hidden');
  setConnection('pending', 'Pair device');
}

function hidePairing() {
  els.pairing.classList.add('hidden');
}

async function pair(event) {
  event.preventDefault();
  els.pairError.textContent = '';
  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingSecret: els.pairingSecret.value.trim(), deviceName: els.deviceName.value.trim() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.token) throw new Error(data.error === 'invalid_pairing_secret' ? 'That pairing secret is not valid.' : data.error || 'Pairing failed.');
    state.token = data.token;
    localStorage.setItem('opendraw.deviceToken', data.token);
    els.pairingSecret.value = '';
    hidePairing();
    await refresh({ forceMessages: true, waitForBackground: true });
    void refreshPushStatus();
    void refreshScreenStatus();
    startMessageStream();
    scheduleRefresh();
  } catch (error) {
    els.pairError.textContent = error.message;
  }
}

function openSidebar() {
  releaseTextFocus();
  closeSessionSheet();
  closeConversationPanel();
  closeModelPicker();
  closeContextSheet();
  els.sidebar?._resetDismissGesture?.();
  els.sidebar.classList.add('open');
  els.scrim.classList.remove('hidden');
  document.documentElement.classList.add('sidebar-open');
  els.composerShell?.setAttribute('aria-hidden', 'true');
}

function closeSidebar() {
  releaseTextFocus(els.sidebar);
  els.sidebar?._resetDismissGesture?.();
  els.sidebar.classList.remove('open');
  els.scrim.classList.add('hidden');
  document.documentElement.classList.remove('sidebar-open');
  els.composerShell?.removeAttribute('aria-hidden');
}

installDismissGesture({
  surface: els.sidebar,
  backdrop: els.scrim,
  axis: 'x',
  close: closeSidebar,
  startSelector: null
});
installDismissGesture({ surface: els.sessionSheet, backdrop: els.sessionSheetBackdrop, axis: 'y', close: closeSessionSheet });
installDismissGesture({ surface: els.modelPickerSheet, backdrop: els.modelPickerBackdrop, axis: 'y', close: closeModelPicker });
installDismissGesture({ surface: els.contextSheet, backdrop: els.contextSheetBackdrop, axis: 'y', close: closeContextSheet });
installDismissGesture({ surface: els.conversationPanel, backdrop: els.conversationPanelBackdrop, axis: 'y', close: closeConversationPanel });
bindDragSafeActivation(els.scrim, closeSidebar);

bindDragSafeActivation(els.promptSectionBar, () => {
  const messageId = els.promptSectionBar?.dataset.messageId || state.scroll.activePromptId;
  if (messageId) scrollToMessage(messageId, { closePanel: false, updateHash: false, highlight: false, closeMobilePanel: false });
});

els.pairForm.addEventListener('submit', pair);
els.screenModeButton.addEventListener('click', toggleScreenMode);
els.screenCloseButton.addEventListener('click', closeScreenMode);
els.screenFullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen?.();
    else await els.screenViewport.requestFullscreen?.();
  } catch {
    showToast('Fullscreen is not available in this browser.', 'bad');
  }
});
els.composer.addEventListener('submit', (event) => { event.preventDefault(); primaryComposerAction(); });
els.messageInput.addEventListener('input', () => {
  if (['sent', 'error'].includes(state.sendUiState)) state.sendUiState = 'idle';
  scheduleComposerDraftSave();
  resizeComposer();
  updateComposerNote();
});
els.messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    primaryComposerAction();
  }
});
els.sessionSearch.addEventListener('input', renderSessions);
els.transcript.addEventListener('pointerdown', markTranscriptUserScrollIntent, { passive: true });
els.transcript.addEventListener('touchstart', markTranscriptUserScrollIntent, { passive: true });
els.transcript.addEventListener('wheel', markTranscriptUserScrollIntent, { passive: true });
els.transcript.addEventListener('scroll', handleTranscriptScroll, { passive: true });
els.jumpLatestButton.addEventListener('click', () => scrollToLatest());
{
  const agentSummary = els.agentBar?.querySelector('summary');
  bindDragSafeActivation(agentSummary, (event) => {
    event.preventDefault();
    const nextOpen = !els.agentBar.open;
    els.agentBar.open = nextOpen;
    if (nextOpen) els.taskBar.open = false;
  });
}
{
  const taskSummary = els.taskBar.querySelector('summary');
  bindDragSafeActivation(taskSummary, (event) => {
    event.preventDefault();
    const nextOpen = !els.taskBar.open;
    els.taskBar.open = nextOpen;
    if (nextOpen && els.agentBar) els.agentBar.open = false;
  });
}
els.voiceButton.addEventListener('click', toggleVoiceRecognition);
els.modelPickerButton.addEventListener('click', openModelPicker);
els.closeModelPicker.addEventListener('click', closeModelPicker);
els.modelPickerBackdrop.addEventListener('click', (event) => {
  if (event.target === els.modelPickerBackdrop) closeModelPicker();
});
els.modelSearchInput.addEventListener('input', renderModelPicker);
els.modelSelect.addEventListener('change', () => {
  const session = activeSession();
  if (session) localStorage.setItem(selectionKey('model', session.id), els.modelSelect.value);
  if (state.draft) state.draft.model = els.modelSelect.value || null;
  rebuildReasoningSelect({ preferSession: false });
  updateComposerSummary();
  saveComposerDraft();
});
els.reasoningSelect.addEventListener('change', () => {
  const session = activeSession();
  if (session) localStorage.setItem(selectionKey('reasoning', session.id), els.reasoningSelect.value);
  if (state.draft) state.draft.reasoningEffort = els.reasoningSelect.value || null;
  updateComposerSummary();
  saveComposerDraft();
});
$('newChatButton').addEventListener('click', () => beginNewChat());
$('openSessions').addEventListener('click', () => {
  setProjectFilter('all');
  openSidebar();
});
$('closeSessions').addEventListener('click', closeSidebar);
els.moreButton.addEventListener('click', openSessionSheet);
els.promptNavigatorButton.addEventListener('click', () => openConversationPanel('prompts'));
els.conversationSearchButton.addEventListener('click', () => openConversationPanel('search'));
els.contextStatusButton.addEventListener('click', openContextSheet);
els.closeContextSheet.addEventListener('click', closeContextSheet);
els.contextSheetBackdrop.addEventListener('click', (event) => {
  if (event.target === els.contextSheetBackdrop) closeContextSheet();
});
els.contextCompactButton.addEventListener('click', () => { void compactCurrentSession(false); });
els.contextCancelCompactButton.addEventListener('click', () => { void compactCurrentSession(true); });
els.mobileProjectButton.addEventListener('click', () => {
  const session = activeSession();
  const key = state.draft ? (state.draft.projectId || UNGROUPED_PROJECT) : session ? sessionProjectKey(session) : 'all';
  setProjectFilter(key);
  openSidebar();
});
els.mobileNewChatButton.addEventListener('click', () => beginNewChat());
els.closeSessionSheet.addEventListener('click', closeSessionSheet);
els.sessionSheetBackdrop.addEventListener('click', (event) => {
  if (event.target === els.sessionSheetBackdrop) closeSessionSheet();
});
els.sheetSearchButton.addEventListener('click', () => {
  closeSessionSheet();
  openConversationPanel('search');
});
els.notificationButton?.addEventListener('click', () => { void toggleCompletionNotifications(); });
els.closeConversationPanel.addEventListener('click', closeConversationPanel);
els.conversationPanelBackdrop.addEventListener('click', (event) => {
  if (event.target === els.conversationPanelBackdrop) closeConversationPanel();
});
els.promptPanelTab.addEventListener('click', () => setConversationPanelMode('prompts'));
els.searchPanelTab.addEventListener('click', () => setConversationPanelMode('search'));
els.conversationPanelInput.addEventListener('input', () => {
  state.conversationPanel.query = els.conversationPanelInput.value;
  state.conversationPanel.index = 0;
  renderConversationPanel();
});
els.conversationSearchPrev.addEventListener('click', () => jumpConversationSearch(-1));
els.conversationSearchNext.addEventListener('click', () => jumpConversationSearch(1));
els.refreshButton.addEventListener('click', async () => {
  if (state.sheetBusy) return;
  setSheetMessage('Refreshing…');
  try {
    await refresh({ forceMessages: true });
    await loadSessionSheet({ quiet: true });
    setSheetMessage('Up to date.', 'good');
    showToast('OpenDraw refreshed', 'good');
  } catch (error) {
    setSheetMessage(`Refresh failed: ${error.message}`, 'bad');
  }
});
els.saveAutomationButton.addEventListener('click', () => { void saveAutomation(); });
els.compactButton.addEventListener('click', () => { void compactCurrentSession(false); });
els.cancelCompactButton.addEventListener('click', () => { void compactCurrentSession(true); });
document.addEventListener('keydown', (event) => {
  if (state.modelPickerOpen && trapFocus(event, els.modelPickerSheet)) return;
  if (state.contextSheetOpen && trapFocus(event, els.contextSheet)) return;
  if (state.conversationPanel.open && trapFocus(event, els.conversationPanel)) return;
  if (state.sheetOpen && trapFocus(event, els.sessionSheet)) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openConversationPanel('search');
    return;
  }
  if (modifier && event.key === 'ArrowUp') {
    event.preventDefault();
    jumpPrompt(-1);
    return;
  }
  if (modifier && event.key === 'ArrowDown') {
    event.preventDefault();
    jumpPrompt(1);
    return;
  }
  if (event.key !== 'Escape') return;
  if (state.modelPickerOpen) closeModelPicker();
  else if (state.contextSheetOpen) closeContextSheet();
  else if (state.conversationPanel.open) closeConversationPanel();
  else if (state.sheetOpen) closeSessionSheet();
  else closeSidebar();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    flushWordReveals();
    stopVoiceRecognition();
    if (state.screen.open) stopScreenStream({ keepOpen: true });
    if (completionNotificationWatchEnabled()) startMessageStream();
    else stopMessageStream();
  } else {
    // Background tabs intentionally snap to the newest durable state when they
    // return; do not replay a long missed backlog as a fake typing animation.
    void refresh({ forceMessages: true, animateMessages: false }).finally(() => startMessageStream());
    if (state.screen.open) startScreenStream();
  }
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  els.installButton.classList.remove('hidden');
});
els.installButton.addEventListener('click', async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice.catch(() => null);
  state.installPrompt = null;
  els.installButton.classList.add('hidden');
});
if ($('unpairButton')) $('unpairButton').addEventListener('click', async () => {
  stopVoiceRecognition();
  stopMessageStream();
  stopScreenStream({ keepOpen: false });
  try { await api('/api/me', { method: 'DELETE' }); } catch { /* clear this browser even if the server is offline */ }
  state.token = '';
  localStorage.removeItem('opendraw.deviceToken');
  showPairing();
  closeSidebar();
});

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let upgradeReloaded = false;
  if (hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (upgradeReloaded) return;
      upgradeReloaded = true;
      window.location.reload();
    });
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => undefined);
  });
}

initVoiceRecognition();

if ('ResizeObserver' in window && els.composerShell) {
  const composerObserver = new ResizeObserver(() => syncComposerHeight());
  composerObserver.observe(els.composerShell);
}
window.visualViewport?.addEventListener('resize', syncVisualViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', syncVisualViewport, { passive: true });
window.addEventListener('orientationchange', () => {
  state.viewportBaseline = 0;
  syncVisualViewport();
}, { passive: true });
window.addEventListener('resize', syncVisualViewport, { passive: true });
window.addEventListener('pagehide', () => {
  saveComposerDraft();
  stopScreenStream({ keepOpen: true });
}, { capture: true });
syncVisualViewport();

if (!state.token) {
  showPairing();
} else {
  setConnection('pending', 'Connecting');
  await refresh({ forceMessages: true });
  void refreshPushStatus();
  void refreshScreenStatus();
  let restoredTarget = null;
  try { restoredTarget = localStorage.getItem(COMPOSER_TARGET_KEY); } catch { restoredTarget = null; }
  const restoredDraft = restoredTarget?.startsWith('new:') ? savedComposerDraft(restoredTarget) : null;
  if (restoredDraft?.text) {
    const projectKey = restoredDraft.projectId || restoredTarget.slice(4).split(':')[0] || UNGROUPED_PROJECT;
    const usable = projectKey === UNGROUPED_PROJECT || Boolean(projectTargetId(projectKey));
    if (usable) beginNewChat(projectKey, { storageKey: restoredTarget });
    else restoreComposerDraft();
  } else {
    restoreComposerDraft();
  }
  renderHeader();
  renderScreenMode();
  startMessageStream();
  scheduleRefresh();
}

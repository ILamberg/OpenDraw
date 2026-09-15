export function messageSignature(messages) {
  return (messages || []).map((message) => {
    const text = String(message?.text ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${message?.id ?? ''}:${message?.seq ?? 0}:${message?.order ?? message?.seq ?? 0}:${message?.responseKey ?? ''}:${message?.final === true ? 1 : 0}:${message?.state ?? ''}:${text.length}:${(hash >>> 0).toString(36)}`;
  }).join('|');
}

export function promptPreview(text, max = 90) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function nearBottomMetrics({ scrollHeight = 0, scrollTop = 0, clientHeight = 0 }, threshold = 120) {
  return Math.max(0, scrollHeight - scrollTop - clientHeight) <= Math.max(0, threshold);
}

export function messageChronology(message) {
  const time = Number(message?.time);
  if (Number.isFinite(time) && time > 0) return time;
  const order = Number(message?.order);
  if (Number.isFinite(order) && order > 0) return order;
  return Number(message?.seq) || 0;
}

function causalMessageOrder(message) {
  const order = Number(message?.order);
  if (Number.isFinite(order) && order > 0) return order;
  return Number(message?.seq) || 0;
}

export function groupPromptTimeline({
  messages = [],
  tools = [],
  visuals = [],
  responses = [],
  activeResponseKey = null,
  activityState = 'idle'
} = {}) {
  const orderedMessages = [...messages].sort((a, b) => (
    causalMessageOrder(a) - causalMessageOrder(b)
    || messageChronology(a) - messageChronology(b)
    || (Number(a?.seq) || 0) - (Number(b?.seq) || 0)
    || String(a?.id || '').localeCompare(String(b?.id || ''))
  ));
  const orderedTools = [...tools].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  const orderedVisuals = [...visuals].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  const lifecycleByKey = new Map(responses
    .filter((row) => row?.responseKey)
    .map((row) => [row.responseKey, row]));
  const completedLifecycle = [...lifecycleByKey.values()].filter((row) => (
    Number(row?.startedSeq) > 0
    && Number(row?.endedSeq) >= Number(row?.startedSeq)
  ));
  const lifecycleForLegacySeq = (seq) => {
    const value = Number(seq) || 0;
    if (!value) return null;
    const containing = completedLifecycle.filter((row) => (
      value >= Number(row.startedSeq)
      && value <= Number(row.endedSeq)
    ));
    return containing.length === 1 ? containing[0] : null;
  };
  const responseGroups = new Map();
  const ensureResponse = (responseKey) => {
    if (!responseKey) return null;
    let group = responseGroups.get(responseKey);
    if (!group) {
      group = { responseKey, messages: [], tools: [], visuals: [], lifecycle: lifecycleByKey.get(responseKey) || null };
      responseGroups.set(responseKey, group);
    }
    return group;
  };

  for (const response of lifecycleByKey.values()) ensureResponse(response.responseKey);
  const claimedLegacyMessages = new Set();
  for (const message of orderedMessages) {
    if (message?.role !== 'assistant') continue;
    if (message.responseKey) {
      ensureResponse(message.responseKey)?.messages.push(message);
      continue;
    }
    const lifecycle = lifecycleForLegacySeq(causalMessageOrder(message));
    if (!lifecycle) continue;
    ensureResponse(lifecycle.responseKey)?.messages.push(message);
    claimedLegacyMessages.add(message);
  }
  for (const tool of orderedTools) if (tool?.responseKey) ensureResponse(tool.responseKey)?.tools.push(tool);
  for (const visual of orderedVisuals) if (visual?.responseKey) ensureResponse(visual.responseKey)?.visuals.push(visual);
  if (activeResponseKey && lifecycleByKey.has(activeResponseKey)) ensureResponse(activeResponseKey);

  const prompts = orderedMessages.filter((message) => message?.role === 'user');
  const bundles = prompts.map((prompt) => ({
    prompt,
    responseKeys: new Set(),
    workRows: [],
    visuals: [],
    finals: [],
    active: false
  }));
  const bundleByPromptId = new Map(bundles.map((bundle) => [bundle.prompt.id, bundle]));
  const promptForCausalSeq = (seq) => {
    const value = Number(seq) || 0;
    let chosen = null;
    for (const prompt of prompts) {
      if (causalMessageOrder(prompt) <= value) chosen = prompt;
      else break;
    }
    return chosen;
  };
  const responseStartSeq = (group) => {
    const lifecycleStart = Number(group?.lifecycle?.startedSeq) || 0;
    if (lifecycleStart) return lifecycleStart;
    const candidates = [
      ...group.messages.map((message) => causalMessageOrder(message)),
      ...group.tools.map((tool) => Number(tool?.seq) || 0),
      ...group.visuals.map((visual) => Number(visual?.seq) || 0)
    ].filter((value) => value > 0);
    return candidates.length ? Math.min(...candidates) : 0;
  };
  const responseTerminalSeq = (group) => {
    const candidates = [
      ...group.messages
        .filter((message) => message?.final === true)
        .map((message) => causalMessageOrder(message)),
      Number(group?.lifecycle?.endedSeq) || 0
    ].filter((value) => value > 0);
    return candidates.length ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
  };
  const lifecycleCanYieldAnswer = (lifecycle) => {
    if (!(Number(lifecycle?.endedSeq) > 0)) return false;
    const outcome = String(lifecycle?.outcome ?? '').trim().toLowerCase();
    return !/(?:fail|error|cancel|abort|reject)/.test(outcome);
  };
  const effectiveFinalMessages = (group) => {
    const explicit = group.messages.filter((message) => message?.final === true);
    if (explicit.length || !lifecycleCanYieldAnswer(group?.lifecycle)) return explicit;

    const endedSeq = Number(group.lifecycle.endedSeq) || 0;
    const terminalMessage = [...group.messages]
      .filter((message) => {
        const order = causalMessageOrder(message);
        return !message?.final
          && order > 0
          && order < endedSeq
          && String(message?.text ?? '').trim();
      })
      .sort((a, b) => causalMessageOrder(a) - causalMessageOrder(b) || (Number(a?.seq) || 0) - (Number(b?.seq) || 0))
      .at(-1);
    return terminalMessage ? [{ ...terminalMessage, final: true, state: 'final' }] : [];
  };
  const terminalByResponseKey = new Map();
  for (const group of responseGroups.values()) {
    terminalByResponseKey.set(group.responseKey, responseTerminalSeq(group));
  }

  for (const group of responseGroups.values()) {
    const anchorPrompt = promptForCausalSeq(responseStartSeq(group));
    if (!anchorPrompt) continue;
    const bundle = bundleByPromptId.get(anchorPrompt.id);
    if (!bundle) continue;
    const terminalSeq = terminalByResponseKey.get(group.responseKey) ?? Number.POSITIVE_INFINITY;
    const finals = effectiveFinalMessages(group);
    const finalIds = new Set(finals.map((message) => message?.id).filter(Boolean));
    bundle.responseKeys.add(group.responseKey);
    bundle.workRows.push(
      ...group.messages
        .filter((message) => !message.final && !finalIds.has(message?.id) && causalMessageOrder(message) < terminalSeq)
        .map((message) => ({ kind: 'message', seq: Number(message.seq) || 0, message })),
      ...group.tools
        .filter((tool) => (Number(tool?.seq) || 0) < terminalSeq)
        .map((tool) => ({ kind: 'tool', seq: Number(tool.seq) || 0, tool }))
    );
    bundle.visuals.push(...group.visuals);
    bundle.finals.push(...finals);
    if (group.responseKey === activeResponseKey && activityState === 'active') bundle.active = true;
  }

  const lifecycle = completedLifecycle;
  const bundleForLegacySeq = (seq, { beforeTerminal = true } = {}) => {
    const value = Number(seq) || 0;
    const containing = lifecycle.filter((row) => value >= Number(row.startedSeq) && value <= Number(row.endedSeq));
    if (containing.length !== 1) return null;
    const terminalSeq = terminalByResponseKey.get(containing[0].responseKey) ?? Number.POSITIVE_INFINITY;
    if (beforeTerminal && value >= terminalSeq) return null;
    const group = responseGroups.get(containing[0].responseKey);
    const anchor = group ? promptForCausalSeq(responseStartSeq(group)) : null;
    return anchor ? bundleByPromptId.get(anchor.id) || null : null;
  };
  for (const tool of orderedTools.filter((row) => !row?.responseKey)) {
    bundleForLegacySeq(tool.seq)?.workRows.push({ kind: 'tool', seq: Number(tool.seq) || 0, tool });
  }
  for (const visual of orderedVisuals.filter((row) => !row?.responseKey)) {
    bundleForLegacySeq(visual.seq, { beforeTerminal: false })?.visuals.push(visual);
  }

  const leadingMessages = [];
  for (const message of orderedMessages.filter((row) => row?.role === 'assistant' && !row.responseKey && !claimedLegacyMessages.has(row))) {
    const prompt = promptForCausalSeq(causalMessageOrder(message));
    const bundle = prompt ? bundleByPromptId.get(prompt.id) : null;
    if (!bundle) {
      if (message.final) leadingMessages.push(message);
      continue;
    }
    if (message.final) bundle.finals.push(message);
    else bundle.workRows.push({ kind: 'message', seq: Number(message.seq) || 0, message });
  }

  for (const bundle of bundles) {
    const keylessFinalBoundary = bundle.finals
      .filter((message) => !message?.responseKey)
      .map((message) => causalMessageOrder(message))
      .filter((value) => value > 0)
      .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY;
    bundle.workRows = bundle.workRows.filter((row) => {
      const responseKey = row.kind === 'tool' ? row.tool?.responseKey : row.message?.responseKey;
      if (responseKey) return true;
      const order = row.kind === 'tool' ? (Number(row.tool?.seq) || 0) : causalMessageOrder(row.message);
      return order < keylessFinalBoundary;
    });
    bundle.workRows.sort((a, b) => a.seq - b.seq || (a.kind === 'tool' ? -1 : 1));
    bundle.visuals.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
    bundle.finals.sort((a, b) => causalMessageOrder(a) - causalMessageOrder(b) || (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  }
  return { bundles, leadingMessages };
}

export function sendReceiptTerminal(receipt) {
  if (Number.isFinite(receipt?.deliveredAt) && receipt.deliveredAt > 0) return true;
  const state = String(receipt?.state ?? receipt?.status ?? '').trim().toLowerCase();
  return ['sent', 'delivered', 'completed', 'done', 'failed', 'cancelled', 'canceled', 'rejected'].includes(state);
}

function parsePendingFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) return null;
  try {
    const parsed = JSON.parse(fingerprint);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

function screenFlagFromFingerprint(parsed) {
  if (typeof parsed?.screen === 'boolean') return parsed.screen;
  return parsed?.source === 'screen';
}

export function pendingMessageAttempt(rows, expected = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const ordered = [...rows].sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
  for (const row of ordered) {
    const parsed = parsePendingFingerprint(row?.fingerprint);
    if (!parsed) continue;
    if (parsed.sessionId !== expected.sessionId || parsed.conversationId !== expected.conversationId) continue;
    if (parsed.text !== expected.text) continue;
    if (!sameNullable(parsed.model, expected.model) || !sameNullable(parsed.reasoningEffort, expected.reasoningEffort)) continue;
    if ((parsed.mode || 'auto') !== (expected.mode || 'auto')) continue;
    return { id: row.id, fingerprint: row.fingerprint, screen: screenFlagFromFingerprint(parsed) };
  }
  return null;
}

export function pendingDraftAttempt(pendingId, pendingFingerprint, expected = {}) {
  if (typeof pendingId !== 'string' || !pendingId || typeof pendingFingerprint !== 'string') return null;
  const parsed = parsePendingFingerprint(pendingFingerprint);
  if (!parsed) return null;
  if (!sameNullable(parsed.projectId, expected.projectId)) return null;
  if (parsed.text !== expected.text) return null;
  if (!sameNullable(parsed.model, expected.model) || !sameNullable(parsed.reasoningEffort, expected.reasoningEffort)) return null;
  return { id: pendingId, fingerprint: pendingFingerprint, screen: screenFlagFromFingerprint(parsed) };
}

export function contextPressure(contextTokens, limitTokens, advisoryTokens, autoTokens) {
  const context = Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0;
  const limit = Number.isFinite(limitTokens) && limitTokens > 0 ? limitTokens : null;
  const advisory = Number.isFinite(advisoryTokens) && advisoryTokens > 0 ? advisoryTokens : null;
  const auto = Number.isFinite(autoTokens) && autoTokens > 0 ? autoTokens : null;
  const percent = limit ? Math.min(100, Math.max(0, (context / limit) * 100)) : null;
  const threshold = auto ?? advisory ?? limit;
  const thresholdPercent = threshold ? (context / threshold) * 100 : null;
  let level = 'normal';
  if ((limit && context >= limit) || (percent !== null && percent >= 95)) level = 'danger';
  else if ((threshold && context >= threshold) || (percent !== null && percent >= 80)) level = 'warn';
  return { context, limit, advisory, auto, percent, thresholdPercent, level };
}

export function streamWordChunks(text) {
  const value = String(text ?? '');
  if (!value) return [];
  return value.match(/\S+\s*|\s+/g) || [value];
}

export function streamWordsPerSecond(remainingWords, final = false) {
  const remaining = Math.max(0, Number(remainingWords) || 0);
  if (!remaining) return 0;
  // Keep nearby words individually perceptible, then accelerate only when a durable
  // revision arrives with a large backlog. This is presentation of text COS has
  // already persisted, not synthetic token generation.
  const comfortableRate = final ? 34 : 27;
  const maxSeconds = final ? 2.4 : 2.0;
  const targetSeconds = Math.min(maxSeconds, Math.max(final ? 0.5 : 0.65, remaining / comfortableRate));
  return Math.min(final ? 78 : 66, Math.max(final ? 30 : 23, remaining / targetSeconds));
}

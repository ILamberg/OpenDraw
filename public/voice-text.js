export function normalizeSpeechText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function speechTokenKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^[.,!?;:'"()[\]{}<>،؛؟]+|[.,!?;:'"()[\]{}<>،؛؟]+$/g, '');
}

function collapseAnchoredFinalReplay(value, anchors) {
  const text = normalizeSpeechText(value);
  if (!text) return text;
  const tokens = text.split(' ').filter(Boolean);
  const keys = tokens.map(speechTokenKey);

  for (const rawAnchor of anchors || []) {
    const anchor = normalizeSpeechText(rawAnchor);
    if (!anchor) continue;
    const anchorTokens = anchor.split(' ').filter(Boolean);
    const anchorKeys = anchorTokens.map(speechTokenKey);
    const size = anchorKeys.length;
    // A one-word repeat may be deliberate ("very very"). Only collapse a
    // recognizer replay when a meaningful prior phrase anchors both copies.
    if (size < 2 || keys.length < size * 2 || anchorKeys.some((key) => !key)) continue;

    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (keys[index] !== anchorKeys[index] || keys[index + size] !== anchorKeys[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    return [...tokens.slice(0, size), ...tokens.slice(size * 2)].join(' ');
  }
  return text;
}

function tokenOverlap(left, right) {
  const leftTokens = normalizeSpeechText(left).split(' ').filter(Boolean).map(speechTokenKey);
  const rightTokens = normalizeSpeechText(right).split(' ').filter(Boolean).map(speechTokenKey);
  const max = Math.min(64, leftTokens.length, rightTokens.length);
  for (let size = max; size >= 2; size -= 1) {
    const leftTail = leftTokens.slice(-size).join(' ');
    const rightHead = rightTokens.slice(0, size).join(' ');
    if (leftTail === rightHead) return size;
  }
  return 0;
}

export function mergeSpeechSegments(values) {
  let merged = '';
  for (const raw of values || []) {
    const text = normalizeSpeechText(raw);
    if (!text) continue;
    if (!merged) {
      merged = text;
      continue;
    }

    const previousLower = merged.toLocaleLowerCase();
    const textLower = text.toLocaleLowerCase();
    if (previousLower === textLower || previousLower.endsWith(` ${textLower}`)) continue;
    if (textLower.startsWith(`${previousLower} `)) {
      merged = text;
      continue;
    }

    const overlap = tokenOverlap(merged, text);
    if (overlap >= 2) {
      const tail = text.split(/\s+/).slice(overlap).join(' ');
      if (tail) merged = `${merged} ${tail}`;
      continue;
    }
    merged = `${merged} ${text}`;
  }
  return merged;
}

export function speechPartsText(parts) {
  const finalSegments = [];
  const interimSegments = [];
  for (const part of parts || []) {
    const text = normalizeSpeechText(part?.text);
    if (!text) continue;
    (part?.final ? finalSegments : interimSegments).push(text);
  }
  const finalText = mergeSpeechSegments(finalSegments);
  const interimText = mergeSpeechSegments(interimSegments);
  return {
    finalText,
    interimText,
    spokenText: mergeSpeechSegments([...finalSegments, ...interimSegments])
  };
}

export function updateSpeechParts(parts, results, resultIndex = 0) {
  const length = Number.isInteger(results?.length) && results.length >= 0 ? results.length : 0;
  const previous = Array.isArray(parts) ? parts : [];
  const previousSpoken = speechPartsText(previous).spokenText;
  const next = previous.slice(0, length);
  const requestedStart = Number.isInteger(resultIndex) && resultIndex >= 0 ? resultIndex : 0;
  let start = Math.min(requestedStart, next.length, length);
  for (let index = 0; index < start; index += 1) {
    if (!next[index]) {
      start = index;
      break;
    }
  }
  for (let index = start; index < length; index += 1) {
    const result = results[index];
    const final = Boolean(result?.isFinal);
    const rawText = result?.[0]?.transcript || '';
    next[index] = {
      text: final
        ? collapseAnchoredFinalReplay(rawText, [previous[index]?.text, previousSpoken])
        : rawText,
      final
    };
  }
  return next;
}

export function combineBaseAndSpeech(base, spoken) {
  const cleanBase = String(base ?? '');
  const cleanSpeech = normalizeSpeechText(spoken);
  if (!cleanSpeech) return cleanBase;
  if (!cleanBase) return cleanSpeech;
  const baseNormalized = normalizeSpeechText(cleanBase);
  if (baseNormalized.toLocaleLowerCase() === cleanSpeech.toLocaleLowerCase()) return cleanBase;

  // Some mobile recognizers replay the tail already present in the composer
  // after a stop/restart. Remove only a meaningful 2+ token boundary overlap;
  // do not collapse a single repeated word that may be intentional speech.
  const overlap = tokenOverlap(baseNormalized, cleanSpeech);
  const remainder = overlap
    ? cleanSpeech.split(/\s+/).slice(overlap).join(' ')
    : cleanSpeech;
  if (!remainder) return cleanBase;
  return `${cleanBase}${/\s$/.test(cleanBase) ? '' : ' '}${remainder}`;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { combineBaseAndSpeech, mergeSpeechSegments, speechPartsText, updateSpeechParts } from '../public/voice-text.js';

function recognitionResult(text, final = false) {
  return { 0: { transcript: text }, isFinal: final };
}

test('speech segment merge removes exact and expanding mobile recognition duplicates', () => {
  assert.equal(mergeSpeechSegments(['hello', 'hello']), 'hello');
  assert.equal(mergeSpeechSegments(['hello', 'hello world']), 'hello world');
  assert.equal(mergeSpeechSegments(['hello world', 'world again']), 'hello world world again');
  assert.equal(mergeSpeechSegments(['hello there friend', 'there friend again']), 'hello there friend again');
});

test('speech segment merge removes cumulative replay across several earlier result slots', () => {
  assert.equal(
    mergeSpeechSegments(['open draw', 'is working now', 'open draw is working now perfectly']),
    'open draw is working now perfectly'
  );
  assert.equal(
    mergeSpeechSegments(['please fix', 'voice dictation', 'please fix voice dictation without duplicates']),
    'please fix voice dictation without duplicates'
  );
});

test('speech parts keep final and interim recognition text without double-appending', () => {
  assert.deepEqual(speechPartsText([
    { text: 'OpenDraw is', final: true },
    { text: 'OpenDraw is working', final: false }
  ]), {
    finalText: 'OpenDraw is',
    interimText: 'OpenDraw is working',
    spokenText: 'OpenDraw is working'
  });
});

test('speech parts de-duplicate an interim cumulative replay of multiple final slots', () => {
  assert.deepEqual(speechPartsText([
    { text: 'make the voice', final: true },
    { text: 'more reliable', final: true },
    { text: 'make the voice more reliable and faster', final: false }
  ]), {
    finalText: 'make the voice more reliable',
    interimText: 'make the voice more reliable and faster',
    spokenText: 'make the voice more reliable and faster'
  });
});

test('dictation appends to pre-existing composer text exactly once', () => {
  assert.equal(combineBaseAndSpeech('Existing draft', 'voice words'), 'Existing draft voice words');
  assert.equal(combineBaseAndSpeech('Existing draft ', 'voice words'), 'Existing draft voice words');
  assert.equal(combineBaseAndSpeech('', 'voice words'), 'voice words');
  assert.equal(combineBaseAndSpeech('Existing draft voice words', 'voice words continue here'), 'Existing draft voice words continue here');
  assert.equal(combineBaseAndSpeech('Existing draft Voice Words,', 'voice words continue here'), 'Existing draft Voice Words, continue here');
  assert.equal(combineBaseAndSpeech('very', 'very good'), 'very very good');
});

test('speech result updates replace interim text by result index instead of appending it again', () => {
  let parts = updateSpeechParts([], [recognitionResult('hello', false)], 0);
  assert.equal(speechPartsText(parts).spokenText, 'hello');

  parts = updateSpeechParts(parts, [
    recognitionResult('hello', true),
    recognitionResult('world', false)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'hello world');

  parts = updateSpeechParts(parts, [
    recognitionResult('hello', true),
    recognitionResult('world', true)
  ], 1);
  assert.deepEqual(parts, [
    { text: 'hello', final: true },
    { text: 'world', final: true }
  ]);
  assert.equal(speechPartsText(parts).spokenText, 'hello world');
});

test('speech result updates drop stale result slots when the browser shortens its result list', () => {
  const parts = updateSpeechParts([
    { text: 'keep', final: true },
    { text: 'stale interim', final: false }
  ], [recognitionResult('keep', true)], 0);
  assert.deepEqual(parts, [{ text: 'keep', final: true }]);
});

test('android finalization collapses a same-slot whole-sentence replay', () => {
  let parts = updateSpeechParts([], [recognitionResult('this is my sentence', false)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('this is my sentence this is my sentence', true)
  ], 0);
  assert.deepEqual(parts, [{ text: 'this is my sentence', final: true }]);
  assert.equal(speechPartsText(parts).spokenText, 'this is my sentence');

  parts = updateSpeechParts([], [recognitionResult('this is my sentence', false)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('this is my sentence this is my sentence with new words', true)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'this is my sentence with new words');
});

test('android finalization also handles a prior hypothesis incorrectly marked final', () => {
  let parts = updateSpeechParts([], [recognitionResult('please send this message', true)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('please send this message please send this message', true)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'please send this message');
});

test('android finalization collapses a replay moved into a new result slot', () => {
  let parts = updateSpeechParts([], [recognitionResult('open draw works now', true)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('open draw works now', true),
    recognitionResult('open draw works now open draw works now', true)
  ], 1);
  assert.equal(speechPartsText(parts).spokenText, 'open draw works now');
});

test('android final replay matching ignores punctuation and capitalization', () => {
  let parts = updateSpeechParts([], [recognitionResult('Fix this please', false)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('Fix this please. fix this please.', true)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'Fix this please.');
});

test('final replay guard preserves normal cumulative expansion and intentional repetition', () => {
  let parts = updateSpeechParts([], [recognitionResult('this is my sentence', false)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('this is my sentence plus new words', true)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'this is my sentence plus new words');

  parts = updateSpeechParts([], [recognitionResult('very', false)], 0);
  parts = updateSpeechParts(parts, [recognitionResult('very very', true)], 0);
  assert.equal(speechPartsText(parts).spokenText, 'very very');

  parts = updateSpeechParts([], [recognitionResult('go now go now', false)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('go now go now go now go now', true)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'go now go now');

  parts = updateSpeechParts([], [recognitionResult('please fix this', false)], 0);
  parts = updateSpeechParts(parts, [
    recognitionResult('please fix this because please fix this', true)
  ], 0);
  assert.equal(speechPartsText(parts).spokenText, 'please fix this because please fix this');
});

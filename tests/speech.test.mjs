import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMonoWav, AUDIO_SAMPLE_RATE, MAX_RECORDING_SECONDS, MAX_WAV_BYTES } from '../src/audio/wav.mjs';
import { SPEECH_PRESETS, validateSpeechConnection, validateWavAudio, transcribeAudio } from '../src/audio/transcription.mjs';

const KEY = 'speech-test-key-only';
const config = (provider = 'whispercpp', extra = {}) => ({ enabled: true, provider, ...extra });
const recording = () => encodeMonoWav(Float32Array.from({ length: AUDIO_SAMPLE_RATE }, (_, index) => Math.sin(index / 12) * 0.2));
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);
function server(reply = () => json({ text: 'Hello from the microphone.' })) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.method, 'POST');
    assert.equal('Content-Type' in init.headers, false, 'FormData must supply its own boundary');
    return await reply({ url, init });
  } };
}

test('WAV encoder emits mono PCM16 with exact format, bounds and clamped samples', () => {
  const bytes = encodeMonoWav(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint16(20, true), 1); assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2); assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 14);
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => view.getInt16(44 + index * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  assert.equal(encodeMonoWav(new Float32Array(AUDIO_SAMPLE_RATE * MAX_RECORDING_SECONDS)).length, MAX_WAV_BYTES);
});

test('WAV encoder rejects empty, oversized, nonfinite and unresampled audio', () => {
  for (const value of [[], new Float32Array(), new Float32Array([NaN]), new Float32Array([Infinity]), new Float32Array(AUDIO_SAMPLE_RATE * 61)]) {
    assert.throws(() => encodeMonoWav(value));
  }
  assert.throws(() => encodeMonoWav(new Float32Array([0]), 48000));
});

test('WAV validation checks complete declared size/format and owns the returned bytes', () => {
  const original = recording();
  const expected = original.slice();
  const isolated = validateWavAudio(original);
  original.fill(0);
  assert.deepEqual(isolated, expected);
  assert.deepEqual(validateWavAudio(expected.buffer), expected);
  const padded = new Uint8Array(expected.length + 10); padded.set(expected, 5);
  assert.deepEqual(validateWavAudio(padded.subarray(5, 5 + expected.length)), expected);
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const malformed = expected.slice(); malformed[offset] ^= 1;
    assert.throws(() => validateWavAudio(malformed), { code: 'INVALID_AUDIO' });
  }
  for (const value of [null, 'audio', { data: [...expected] }, new Uint8Array(44), new Uint8Array(MAX_WAV_BYTES + 2), expected.subarray(0, expected.length - 1)]) {
    assert.throws(() => validateWavAudio(value), { code: 'INVALID_AUDIO' });
  }
});

test('speech configuration whitelists public fields and supplies documented defaults', () => {
  assert.deepEqual(SPEECH_PRESETS.map(preset => preset.id), ['whispercpp', 'openai', 'compatible']);
  assert(SPEECH_PRESETS.every(Object.isFrozen));
  const clean = validateSpeechConnection(config('openai', { apiKey: KEY, injected: 'value', language: 'EN' }));
  assert.equal(clean.model, 'gpt-transcribe');
  assert.equal(clean.language, 'en');
  assert.equal(clean.baseUrl, 'https://api.openai.com/v1');
  assert.equal('apiKey' in clean, false); assert.equal('injected' in clean, false);
  assert.equal(validateSpeechConnection(config('whispercpp', { baseUrl: 'http://localhost:8080/inference/', language: 'auto' })).baseUrl, 'http://localhost:8080');
  assert.equal(validateSpeechConnection(config('whispercpp', { language: 'auto' })).language, '');
  assert.throws(() => validateSpeechConnection(config('unknown')), { code: 'INVALID_PROVIDER' });
  assert.throws(() => validateSpeechConnection(config('whispercpp', { language: 'English' })), { code: 'INVALID_LANGUAGE' });
});

test('speech endpoints refuse credentials, remote HTTP, hidden redirects and ambiguous paths', () => {
  for (const baseUrl of ['http://example.com/v1', 'http://192.168.1.2:8000/v1', 'https://user:secret@example.com/v1', 'https://@example.com', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'https://example.com/a b', 'https://example.com\\evil', 'file:///tmp/speech']) {
    assert.throws(() => validateSpeechConnection(config('compatible', { baseUrl })));
  }
  for (const baseUrl of ['https://other-computer.example', 'http://localhost:8080/proxy', 'https://localhost.example.com']) {
    assert.throws(() => validateSpeechConnection(config('whispercpp', { baseUrl })));
  }
});

test('local-only microphone mode accepts loopback Whisper.cpp and blocks cloud/custom before fetch', async () => {
  for (const baseUrl of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080', 'http://127.4.3.2:8080']) {
    assert.equal(validateSpeechConnection(config('whispercpp', { baseUrl }), { localOnly: true }).provider, 'whispercpp');
  }
  const target = server();
  for (const connection of [config('openai'), config('compatible', { baseUrl: 'http://localhost:8000/v1', model: 'local-model' }), config('whispercpp', { baseUrl: 'https://localhost.example.com' })]) {
    await rejectsCode(transcribeAudio(connection, { audio: recording(), apiKey: KEY, localOnly: true, ...target }), 'LOCAL_ONLY');
  }
  assert.equal(target.calls.length, 0);
});

test('disabled speech, missing models/keys, malformed audio and aborted operations never upload', async () => {
  const target = server();
  const options = { audio: recording(), ...target };
  await rejectsCode(transcribeAudio(config('whispercpp', { enabled: false }), options), 'DISABLED');
  await rejectsCode(transcribeAudio(config('openai', { model: '' }), { ...options, apiKey: KEY }), 'MISSING_MODEL');
  await rejectsCode(transcribeAudio(config('openai'), options), 'MISSING_KEY');
  await rejectsCode(transcribeAudio(config('openai'), { ...options, apiKey: 'bad\r\nkey' }), 'INVALID_KEY');
  await rejectsCode(transcribeAudio(config(), { ...options, audio: new Uint8Array([1, 2]) }), 'INVALID_AUDIO');
  const controller = new AbortController(); controller.abort();
  await rejectsCode(transcribeAudio(config(), { ...options, signal: controller.signal }), 'ABORTED');
  assert.equal(target.calls.length, 0);
});

test('Whisper.cpp receives a WAV and returns only editable text without model or chat payloads', async () => {
  const audio = recording();
  const snapshot = audio.slice();
  const target = server(async ({ url, init }) => {
    assert.equal(url, 'http://127.0.0.1:8080/inference');
    assert.deepEqual([...init.body.keys()], ['file', 'response_format', 'language']);
    assert.equal(init.body.get('response_format'), 'json');
    assert.equal(init.body.get('language'), 'auto');
    assert.equal(init.headers.Authorization, undefined);
    const file = init.body.get('file');
    assert.equal(file.name, 'microphone.wav'); assert.equal(file.type, 'audio/wav');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), snapshot);
    return json({ text: '  A draft to review.\n', segments: [{ ignored: true }] });
  });
  assert.equal(await transcribeAudio(config(), { audio, localOnly: true, ...target }), 'A draft to review.');
  assert.equal(target.calls.length, 1);
  assert.deepEqual(audio, snapshot, 'Caller audio is not changed or retained');
});

test('OpenAI current transcription uses multipart audio, exact model and plural language hint', async () => {
  const target = server(({ url, init }) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(init.body.get('model'), 'gpt-transcribe');
    assert.equal(init.body.get('languages[]'), 'en');
    assert.equal(init.body.has('language'), false);
    return json({ text: 'Speech draft', languages: [{ code: 'en' }] });
  });
  assert.equal(await transcribeAudio(config('openai', { language: 'en' }), { audio: recording(), apiKey: KEY, ...target }), 'Speech draft');
});

test('compatible transcription preserves chosen model/auth and uses singular language', async () => {
  const model = 'my-exact-speech-model';
  const target = server(({ url, init }) => {
    assert.equal(url, 'https://speech.example/v1/audio/transcriptions');
    assert.equal(init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(init.body.get('model'), model); assert.equal(init.body.get('language'), 'fr');
    assert.equal(init.body.has('languages[]'), false);
    return json({ text: 'Bonjour.' });
  });
  assert.equal(await transcribeAudio(config('compatible', { baseUrl: 'https://speech.example/v1/', model, language: 'fr' }), { audio: recording(), apiKey: KEY, ...target }), 'Bonjour.');
});

test('redirects, server responses and network errors never expose audio or credentials', async () => {
  for (const [status, code] of [[302, 'REDIRECT_BLOCKED'], [401, 'AUTHENTICATION'], [403, 'AUTHENTICATION'], [404, 'NOT_FOUND'], [429, 'RATE_LIMIT'], [500, 'SPEECH_HTTP']]) {
    const target = server(() => json({ error: KEY + ' PRIVATE AUDIO' }, status));
    await assert.rejects(transcribeAudio(config('openai'), { audio: recording(), apiKey: KEY, ...target }), error => {
      assert.equal(error.code, code); assert(!String(error).includes(KEY)); assert(!String(error).includes('PRIVATE AUDIO')); assert.equal(error.cause, undefined); return true;
    });
    assert.equal(target.calls.length, 1, 'No retry or fallback destination');
  }
  await rejectsCode(transcribeAudio(config(), { audio: recording(), fetchImpl: async () => ({ ok: true, status: 200, redirected: true }) }), 'REDIRECT_BLOCKED');
  await assert.rejects(transcribeAudio(config(), { audio: recording(), fetchImpl: async () => { throw new Error(KEY + ' PRIVATE AUDIO'); } }), error => {
    assert.equal(error.code, 'CONNECTION_FAILED'); assert(!String(error).includes(KEY)); assert.equal(error.cause, undefined); return true;
  });
});

test('transcription rejects silent, malformed, oversized and untrusted response content', async () => {
  for (const [payload, code] of [[{ text: ' \n ' }, 'NO_SPEECH'], [{ error: KEY }, 'INVALID_RESPONSE'], [{ text: KEY.repeat(1000) }, 'INVALID_RESPONSE'], [{ text: 'bad\u0000text' }, 'INVALID_RESPONSE'], [[], 'INVALID_RESPONSE']]) {
    await rejectsCode(transcribeAudio(config(), { audio: recording(), ...server(() => json(payload)) }), code);
  }
  for (const response of [new Response('not JSON ' + KEY), json({ text: 'ok' }, 200, { 'content-length': String(1024 * 1024) }), new Response('x'.repeat(129 * 1024))]) {
    await rejectsCode(transcribeAudio(config(), { audio: recording(), ...server(() => response) }), 'INVALID_RESPONSE');
  }
});

test('cancellation aborts in-flight transcription and discards a late response', async () => {
  const controller = new AbortController();
  const target = server(({ init }) => {
    controller.abort();
    assert.equal(init.signal.aborted, true);
    return json({ text: 'Must be discarded' });
  });
  await rejectsCode(transcribeAudio(config(), { audio: recording(), signal: controller.signal, ...target }), 'ABORTED');
  assert.equal(target.calls.length, 1);
});

test('transcription timeout cancels the request with a redacted actionable error', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await rejectsCode(transcribeAudio(config(), { audio: recording(), timeoutMs: 20, fetchImpl: async (_url, { signal }) => {
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true }));
    } }), 'TIMEOUT');
  } finally { clearTimeout(keepAlive); }
});

import { AUDIO_SAMPLE_RATE, MAX_WAV_BYTES } from './wav.mjs';

export const SPEECH_PRESETS = Object.freeze([
  { id: 'whispercpp', label: 'Whisper.cpp · local', kind: 'local', baseUrl: 'http://127.0.0.1:8080', model: '', keyRequired: false },
  { id: 'openai', label: 'OpenAI transcription', kind: 'hosted', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe', keyRequired: true },
  { id: 'compatible', label: 'Custom · OpenAI-compatible transcription', kind: 'custom', baseUrl: '', model: '', keyRequired: false },
].map(Object.freeze));

const PRESETS = new Map(SPEECH_PRESETS.map(preset => [preset.id, preset]));
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 8000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class SpeechError extends Error {
  constructor(code, message) { super(message); this.name = 'SpeechError'; this.code = code; }
}
function fail(code, message) { throw new SpeechError(code, message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit || CONTROL_CHARACTERS.test(value)) {
    fail('INVALID_CONFIGURATION', 'A speech setting contains invalid text.');
  }
  return value.trim();
}
function loopback(url) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
}
function checkAbort(signal) {
  if (signal?.aborted) fail('ABORTED', 'Microphone transcription cancelled.');
}

/** Public settings only. Keys are separately bound and protected by the main process. */
export function validateSpeechConnection(connection, { localOnly = false } = {}) {
  if (!object(connection) || !PRESETS.has(connection.provider)) fail('INVALID_PROVIDER', 'Choose a supported speech service.');
  const preset = PRESETS.get(connection.provider);
  const raw = text(connection.baseUrl || preset.baseUrl, 2048);
  if (!raw || /\s/.test(raw) || /[?#\\]/.test(raw) || /\/\/[^/]*@/.test(raw)) {
    fail('INVALID_ENDPOINT', 'Use a speech server URL without credentials, a query, or a fragment.');
  }
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_ENDPOINT', 'Enter a valid speech server URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail('INVALID_ENDPOINT', 'Use HTTPS, or HTTP for a speech server on this computer.');
  }
  if (localOnly && (preset.id !== 'whispercpp' || !loopback(url))) {
    fail('LOCAL_ONLY', 'Keep AI on this computer requires Whisper.cpp on a loopback address for microphone input.');
  }
  if (url.protocol === 'http:' && !loopback(url)) fail('INSECURE_ENDPOINT', 'HTTP speech servers must be on this computer.');
  if (preset.id === 'whispercpp') {
    if (!loopback(url)) fail('INVALID_ENDPOINT', 'The Whisper.cpp local service must run on this computer.');
    if (!['/', '/inference', '/inference/'].includes(url.pathname)) {
      fail('INVALID_ENDPOINT', 'Use the local Whisper.cpp server root or its /inference endpoint.');
    }
    url.pathname = '/';
  }
  const language = text(connection.language ?? '', 10).toLowerCase();
  if (language && language !== 'auto' && !/^[a-z]{2}$/.test(language)) {
    fail('INVALID_LANGUAGE', 'Use a two-letter language code, such as en, or leave it blank for detection.');
  }
  return {
    enabled: connection.enabled === true,
    provider: preset.id,
    baseUrl: url.href.replace(/\/+$/, ''),
    model: text(connection.model ?? preset.model, 512),
    language: language === 'auto' ? '' : language,
  };
}

/** Accept only the bounded PCM format emitted by the microphone encoder. */
export function validateWavAudio(audio) {
  let bytes;
  if (audio instanceof Uint8Array) bytes = audio;
  else if (audio instanceof ArrayBuffer) bytes = new Uint8Array(audio);
  else fail('INVALID_AUDIO', 'The microphone did not provide a WAV recording.');
  if (bytes.length <= 44 || bytes.length > MAX_WAV_BYTES || (bytes.length - 44) % 2 !== 0) {
    fail('INVALID_AUDIO', 'Record a nonempty clip of no more than 60 seconds.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const label = (offset, expected) => [...expected].every((letter, index) => bytes[offset + index] === letter.charCodeAt(0));
  if (!label(0, 'RIFF') || !label(8, 'WAVE') || !label(12, 'fmt ') || !label(36, 'data') ||
      view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== AUDIO_SAMPLE_RATE || view.getUint32(28, true) !== AUDIO_SAMPLE_RATE * 2 ||
      view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== bytes.length - 44) {
    fail('INVALID_AUDIO', 'Use the app microphone to create 16 kHz mono PCM WAV audio.');
  }
  // Own the bytes before an asynchronous request; callers cannot alter the validated recording.
  return new Uint8Array(bytes);
}

async function readJson(response, signal) {
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'The speech service returned too much data.');
  let body;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        checkAbort(signal);
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          fail('INVALID_RESPONSE', 'The speech service returned too much data.');
        }
        chunks.push(decoder.decode(part.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      body = chunks.join('');
    } finally { reader.releaseLock(); }
  } else {
    body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'The speech service returned too much data.');
  }
  checkAbort(signal);
  let data;
  try { data = JSON.parse(body); } catch { fail('INVALID_RESPONSE', 'The speech service returned unreadable data.'); }
  if (!object(data) || typeof data.text !== 'string' || data.text.length > MAX_TRANSCRIPT_CHARACTERS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.text)) {
    fail('INVALID_RESPONSE', 'The speech service returned an invalid transcript.');
  }
  const transcript = data.text.trim();
  if (!transcript) fail('NO_SPEECH', 'No speech was recognized. Try a clearer or longer recording.');
  return transcript;
}

/** One explicit recording in, editable text out. No file storage, history, fallback, or chat submission. */
export async function transcribeAudio(connection, {
  audio, apiKey = '', signal, localOnly = false, fetchImpl = fetch, timeoutMs = 180000,
} = {}) {
  checkAbort(signal);
  const config = validateSpeechConnection(connection, { localOnly });
  if (!config.enabled) fail('DISABLED', 'Enable microphone input in Settings first.');
  if (config.provider !== 'whispercpp' && !config.model) fail('MISSING_MODEL', 'Enter the transcription model used by your speech service.');
  if (typeof apiKey !== 'string' || apiKey.length > 8192 || CONTROL_CHARACTERS.test(apiKey)) {
    fail('INVALID_KEY', 'The speech API key contains invalid characters.');
  }
  const key = apiKey.trim();
  if (PRESETS.get(config.provider).keyRequired && !key) fail('MISSING_KEY', 'Add an API key for the selected speech service.');
  const bytes = validateWavAudio(audio);
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'microphone.wav');
  form.set('response_format', 'json');
  if (config.provider !== 'whispercpp') form.set('model', config.model);
  if (config.language) {
    const currentOpenAI = config.provider === 'openai' && /^gpt-transcribe(?:-|$)/.test(config.model);
    form.set(currentOpenAI ? 'languages[]' : 'language', config.language);
  } else if (config.provider === 'whispercpp') form.set('language', 'auto');
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const suffix = config.provider === 'whispercpp' ? '/inference' : '/audio/transcriptions';
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 180000) : 180000;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
  timeout.unref?.();
  try {
    checkAbort(signal);
    const response = await fetchImpl(config.baseUrl + suffix, {
      method: 'POST', headers, body: form, signal: controller.signal, redirect: 'error', cache: 'no-store',
    });
    checkAbort(signal);
    if (response.redirected || response.status >= 300 && response.status < 400) {
      fail('REDIRECT_BLOCKED', 'The speech service redirected the request. Check its configured address.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) fail('AUTHENTICATION', 'The speech service rejected its API key or access.');
      if (response.status === 404) fail('NOT_FOUND', 'The transcription endpoint or model was not found. Check the speech settings.');
      if (response.status === 429) fail('RATE_LIMIT', 'The speech service reached its rate or usage limit.');
      fail('SPEECH_HTTP', 'The speech service could not transcribe this clip (HTTP ' + Number(response.status) + ').');
    }
    const transcript = await readJson(response, controller.signal);
    checkAbort(signal);
    return transcript;
  } catch (error) {
    if (signal?.aborted) fail('ABORTED', 'Microphone transcription cancelled.');
    if (timedOut) fail('TIMEOUT', 'The speech service took longer than three minutes. Try a shorter clip or a smaller local model.');
    if (error instanceof SpeechError) throw error;
    // Provider/network errors may contain credentials or audio. Do not retain their body or cause.
    fail('CONNECTION_FAILED', 'Could not reach the speech service. Start your local speech server or check its address.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    bytes.fill(0);
  }
}

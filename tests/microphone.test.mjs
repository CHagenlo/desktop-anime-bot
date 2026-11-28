import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpeechController, allowsMicrophone, speechIdentity } from '../src/audio/controller.mjs';
import { encodeMonoWav, AUDIO_SAMPLE_RATE } from '../src/audio/wav.mjs';
import { MicrophoneRecorder } from '../renderer/microphone.mjs';
import { CompanionApplication } from '../src/core/application.mjs';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';
import { SettingsStore, SecretStore } from '../src/core/storage.mjs';
import * as providers from '../src/providers/index.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const audio = () => encodeMonoWav(new Float32Array(AUDIO_SAMPLE_RATE).fill(0.1));
const turn = () => new Promise(resolve => setImmediate(resolve));
const cloudSpeech = extra => ({ enabled: true, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe', language: '', ...extra });

async function controllerFixture(t, { transcribe, recordingTimeoutMs } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'microphone-policy-'));
  const settings = new SettingsStore(directory);
  // Test codec only; Windows protection itself is covered by the credential codec tests.
  const secrets = new SecretStore(directory, {
    async encrypt(value) { return Buffer.from(value).reverse(); },
    async decrypt(value) { return Buffer.from(value).reverse().toString(); },
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.speech.enabled = true;
  config.connections = [{ id: 'chat-a', provider: 'ollama', name: 'Local chat', baseUrl: 'http://127.0.0.1:11434', model: 'local-model' }];
  config.activeConnectionId = 'chat-a';
  await settings.save(config);
  const service = new CompanionApplication({ settings, secrets, native: { cancelPending() {} }, providers, platform: 'win32' });
  await service.initialize();
  await service.savePreferences({ privacy: { paused: false } });
  const events = [], requests = [];
  const speech = new SpeechController({ service, recordingTimeoutMs, emit: event => events.push(event),
    transcribe: async (connection, options) => {
      requests.push({ connection: structuredClone(connection), audio: options.audio.slice(), apiKey: options.apiKey, signal: options.signal });
      return transcribe ? await transcribe(connection, options) : 'Editable microphone draft.';
    } });
  t.after(async () => { speech.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { speech, service, secrets, settings, events, requests };
}

test('microphone permissions grant audio only to the recording settings main frame', () => {
  const trusted = { permission: 'media', senderId: 12, expectedId: 12, frameUrl: 'file:///app/renderer/settings.html',
    expectedUrl: 'file:///app/renderer/settings.html', isMainFrame: true, recording: true };
  assert.equal(allowsMicrophone({ ...trusted, mediaTypes: ['audio'] }), true);
  assert.equal(allowsMicrophone({ ...trusted, check: true, mediaType: 'audio' }), true);
  for (const change of [
    { permission: 'display-capture' }, { permission: 'notifications' }, { senderId: 99 }, { expectedId: null },
    { frameUrl: 'https://untrusted.example' }, { frameUrl: trusted.frameUrl + '#other' }, { isMainFrame: false },
    { isMainFrame: undefined }, { recording: false },
  ]) {
    assert.equal(allowsMicrophone({ ...trusted, mediaTypes: ['audio'], ...change }), false);
    assert.equal(allowsMicrophone({ ...trusted, check: true, mediaType: 'audio', ...change }), false);
  }
  for (const mediaTypes of [undefined, [], ['video'], ['audio', 'video'], ['audio', 'audio'], 'audio']) {
    assert.equal(allowsMicrophone({ ...trusted, mediaTypes }), false);
  }
  for (const mediaType of [undefined, '', 'video', 'unknown']) assert.equal(allowsMicrophone({ ...trusted, check: true, mediaType }), false);
});

test('controller blocks recording while paused, disabled, saving, busy or missing required speech credentials', async t => {
  const { service, speech, events } = await controllerFixture(t);
  service.config.privacy.paused = true;
  assert.throws(() => speech.begin(12), /resume/i);
  service.config.privacy.paused = false; service.config.speech.enabled = false;
  assert.throws(() => speech.begin(12), /enable microphone/i);
  service.config.speech.enabled = true; service.mutationsPending = 1;
  assert.throws(() => speech.begin(12), /being saved/i);
  service.mutationsPending = 0; service.busy = true;
  assert.throws(() => speech.begin(12), /current reply/i);
  service.busy = false; service.config.speech = cloudSpeech();
  assert.throws(() => speech.begin(12), /api key/i);
  service.config.speech.model = '';
  assert.throws(() => speech.begin(12), /transcription model/i);
  service.config.speech = cloudSpeech(); service.config.privacy.localOnly = true;
  assert.throws(() => speech.begin(12), /this computer/i);
  assert.equal(speech.current, null);
  assert.equal(events.some(event => event.type === 'microphone' && event.active), false);
});

test('recording ownership and tokens prevent foreign, stale, replayed and duplicate submissions', async t => {
  const entered = deferred(), released = deferred();
  const { speech, requests } = await controllerFixture(t, { transcribe: async () => { entered.resolve(); return await released.promise; } });
  const old = speech.begin(12), current = speech.begin(12);
  assert.notEqual(old.token, current.token);
  assert.equal(speech.canRecord(12), true); assert.equal(speech.canRecord(99), false);
  speech.cancel('Stale cancellation', old.token);
  assert.equal(speech.canRecord(12), true);
  await assert.rejects(speech.submit({ token: old.token, audio: audio() }, 12), /new microphone/i);
  await assert.rejects(speech.submit({ token: current.token, audio: audio() }, 99), /new microphone/i);
  await assert.rejects(speech.submit({ token: current.token, audio: new Uint8Array([1]) }, 12), { code: 'INVALID_AUDIO' });
  assert.equal(requests.length, 0);
  const pending = speech.submit({ token: current.token, audio: audio() }, 12);
  await entered.promise;
  assert.equal(speech.canRecord(12), false, 'No new device grants during transcription');
  await assert.rejects(speech.submit({ token: current.token, audio: audio() }, 12), /new microphone/i);
  released.resolve('One draft.');
  assert.deepEqual(await pending, { text: 'One draft.' });
  assert.equal(speech.current, null); assert.equal(requests.length, 1);
  await assert.rejects(speech.submit({ token: current.token, audio: audio() }, 12), /new microphone/i);
});

test('cancel during speech key unlock prevents every audio upload', async t => {
  const entered = deferred(), released = deferred();
  const { speech, secrets, requests, events } = await controllerFixture(t);
  secrets.get = async () => { entered.resolve(); return await released.promise; };
  const grant = speech.begin(12);
  const pending = speech.submit({ token: grant.token, audio: audio() }, 12);
  const rejected = assert.rejects(pending, /cancelled/i);
  await entered.promise;
  speech.cancel('Paused by user.'); released.resolve('unlocked-secret');
  await rejected;
  assert.equal(requests.length, 0); assert.equal(speech.canRecord(12), false);
  assert(events.some(event => event.type === 'microphone-cancelled' && event.token === grant.token));
});

test('settings/profile changes invalidate pending recording and late unlock without event ordering assumptions', async t => {
  const mutations = [
    config => { config.privacy.paused = true; },
    config => { config.privacy.localOnly = true; },
    config => { config.speech.enabled = false; },
    config => { config.speech.baseUrl = 'http://127.0.0.1:8081'; },
    config => { config.activeConnectionId = 'different-profile'; },
    config => { config.connections[0].model = 'different-model'; },
    config => { config.connections[0].baseUrl = 'http://127.0.0.1:11435'; },
  ];
  for (const mutate of mutations) {
    const entered = deferred(), released = deferred();
    const { speech, secrets, service, requests } = await controllerFixture(t);
    secrets.get = async () => { entered.resolve(); return await released.promise; };
    const grant = speech.begin(12);
    const pending = speech.submit({ token: grant.token, audio: audio() }, 12);
    const rejected = assert.rejects(pending, /cancelled/i);
    await entered.promise; mutate(service.config);
    assert.equal(speech.canRecord(12), false);
    released.resolve('private-key'); await rejected;
    assert.equal(requests.length, 0); assert.equal(speech.current, null);
  }
});

test('cancelling an in-flight transcript aborts its signal and discards a late successful reply', async t => {
  const entered = deferred(), released = deferred();
  const { speech, requests, service, settings } = await controllerFixture(t, { transcribe: async () => { entered.resolve(); return await released.promise; } });
  const grant = speech.begin(12);
  const pending = speech.submit({ token: grant.token, audio: audio() }, 12);
  const rejected = assert.rejects(pending, /cancelled/i);
  await entered.promise;
  speech.cancel(); assert.equal(requests[0].signal.aborted, true);
  released.resolve('A transcript that must not be used.'); await rejected;
  assert.equal(service.histories.size, 0);
  assert(!(await fs.readFile(settings.file, 'utf8')).includes('transcript that must'));
});

test('speech keys are separate from chat keys and bound to the selected speech endpoint', async t => {
  const { speech, secrets, service, requests, settings } = await controllerFixture(t);
  const chat = { id: 'microphone-transcription', provider: 'openai', baseUrl: 'https://api.openai.com/v1', workspaceId: '' };
  await secrets.put(chat, 'chat-key-must-not-be-reused');
  service.config.speech = cloudSpeech();
  assert.throws(() => speech.begin(12), /api key/i);
  await speech.save({ ...cloudSpeech(), apiKey: 'separate-speech-key', removeKey: false });
  assert.equal(secrets.has(speechIdentity(service.config.speech)), true);
  assert.equal(secrets.has(chat), false);
  const decorated = speech.decorate(service.getState());
  assert.equal(decorated.config.speech.hasKey, true);
  assert(!JSON.stringify(decorated).includes('separate-speech-key'));
  const grant = speech.begin(12);
  assert.deepEqual(await speech.submit({ token: grant.token, audio: audio() }, 12), { text: 'Editable microphone draft.' });
  assert.equal(requests[0].apiKey, 'separate-speech-key');
  assert(!(await fs.readFile(settings.file, 'utf8')).includes('separate-speech-key'));
  const old = structuredClone(service.config.speech);
  await assert.rejects(speech.save({ ...old, baseUrl: 'https://another.example/v1' }), /new key|removal/i);
  assert.deepEqual(service.config.speech, old);
  await speech.save({ ...old, baseUrl: 'https://another.example/v1', removeKey: true });
  assert.equal(secrets.has(speechIdentity(service.config.speech)), false);
  assert.throws(() => speech.begin(12), /api key/i);
});

test('recording watchdog expires grants and broadcasts cancellation', async t => {
  const { speech, events } = await controllerFixture(t, { recordingTimeoutMs: 10 });
  const grant = speech.begin(12);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(speech.canRecord(12), false); assert.equal(speech.current, null);
  assert(events.some(event => event.type === 'microphone-cancelled' && event.token === grant.token));
});

function browserFixture(t, { getUserMedia, decodeAudioData, transcribeAudio, beginMicrophone, recorderStartError } = {}) {
  const originals = new Map(['navigator', 'MediaRecorder', 'AudioContext'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = { begin: 0, cancel: [], uploads: [], gum: [], contexts: [], errors: [], states: [], drafts: [] };
  const transcript = deferred(), failed = deferred();
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const recorders = [];
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(input, options) { this.input = input; this.options = options; this.state = 'inactive'; recorders.push(this); }
    start() { if (recorderStartError) throw recorderStartError; this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['recorded-audio']) }); this.onstop?.(); });
    }
  }
  class Context {
    constructor(options) { this.options = options; this.closed = 0; calls.contexts.push(this); }
    async decodeAudioData(bytes) {
      if (decodeAudioData) return await decodeAudioData(bytes);
      return { length: 1600, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(1600).fill(0.2) };
    }
    async close() { this.closed += 1; }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async options => {
    calls.gum.push(options); return getUserMedia ? await getUserMedia(options) : stream;
  } } } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  const api = {
    async beginMicrophone() { calls.begin += 1; return beginMicrophone ? await beginMicrophone() : { token: 'grant-' + calls.begin, maxSeconds: 60 }; },
    async cancelMicrophone(request) { calls.cancel.push(request); },
    async transcribeAudio(request) { calls.uploads.push({ token: request.token, audio: request.audio.slice() }); return transcribeAudio ? await transcribeAudio(request) : { text: 'Editable draft.' }; },
  };
  const recorder = new MicrophoneRecorder({ api,
    onState: state => calls.states.push(state),
    onTranscript: text => { calls.drafts.push(text); transcript.resolve(text); },
    onError: error => { calls.errors.push(error); failed.resolve(error); },
  });
  t.after(async () => {
    await recorder.cancel();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  return { recorder, calls, api, tracks, stream, recorders, transcript, failed };
}

test('renderer requires the main-process grant before opening an audio-only microphone', async t => {
  const { recorder, calls } = browserFixture(t, { beginMicrophone: async () => { throw new Error('Resume the companion.'); } });
  await recorder.start();
  assert.equal(calls.begin, 1); assert.equal(calls.gum.length, 0); assert.equal(calls.uploads.length, 0);
  assert.equal(recorder.active, false); assert.match(calls.errors[0].message, /resume/i);
});

test('renderer stops every track before decoding, releases its audio context and returns only an editable draft', async t => {
  const { recorder, calls, tracks, transcript, recorders } = browserFixture(t);
  await recorder.start();
  assert.equal(recorder.phase, 'recording'); assert.equal(calls.uploads.length, 0);
  assert.equal(calls.gum[0].video, false); assert.equal(calls.gum[0].audio.channelCount, 1);
  await recorder.start(); assert.equal(calls.begin, 1, 'A second start does not create another device session');
  recorder.stop();
  assert.equal(tracks[0].stopped, 1); assert.equal(recorders[0].state, 'inactive');
  assert.equal(await transcript.promise, 'Editable draft.'); await turn();
  assert.equal(calls.uploads.length, 1); assert.equal(calls.uploads[0].token, 'grant-1');
  assert.equal(new DataView(calls.uploads[0].audio.buffer).getUint32(24, true), 16000);
  assert.equal(calls.contexts[0].closed, 1); assert.equal(recorder.active, false);
  assert.equal(recorder.chunks.length, 0); assert.equal(recorder.stream, null); assert.equal(recorder.token, null);
});

test('cancelling capture immediately releases tracks and prevents late recorder events from uploading', async t => {
  const { recorder, tracks, calls, recorders } = browserFixture(t);
  await recorder.start();
  const oldData = recorders[0].ondataavailable, oldStop = recorders[0].onstop;
  await recorder.cancel();
  assert.equal(tracks[0].stopped, 1);
  oldData({ data: new Blob(['late audio']) }); oldStop(); await turn();
  assert.deepEqual(calls.cancel, [{ token: 'grant-1' }]);
  assert.equal(calls.uploads.length, 0); assert.equal(calls.drafts.length, 0);
  assert.equal(recorder.chunks.length, 0); assert.equal(recorder.active, false);
});

test('a late getUserMedia result after cancellation is stopped without recording or uploading', async t => {
  const pending = deferred();
  const { recorder, calls, stream, tracks, recorders } = browserFixture(t, { getUserMedia: () => pending.promise });
  const start = recorder.start(); await turn();
  assert.equal(recorder.phase, 'requesting'); assert.equal(calls.gum.length, 1);
  await recorder.cancel(); pending.resolve(stream); await start;
  assert.equal(tracks[0].stopped, 1); assert.equal(recorders.length, 0);
  assert.equal(calls.uploads.length, 0); assert.equal(recorder.active, false);
});

test('a late main-process grant after cancellation is revoked before any device request', async t => {
  const pending = deferred();
  const { recorder, calls } = browserFixture(t, { beginMicrophone: () => pending.promise });
  const start = recorder.start(); await turn();
  await recorder.cancel(); pending.resolve({ token: 'late-grant', maxSeconds: 60 }); await start;
  assert.equal(calls.gum.length, 0); assert.equal(calls.uploads.length, 0);
  assert.deepEqual(calls.cancel, [{ token: 'late-grant' }]);
});

test('cancellation during decoding closes the context and discards the recording before IPC', async t => {
  const entered = deferred(), pending = deferred();
  const { recorder, calls } = browserFixture(t, { decodeAudioData: () => { entered.resolve(); return pending.promise; } });
  await recorder.start(); recorder.stop(); await entered.promise;
  await recorder.cancel();
  pending.resolve({ length: 1600, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(1600) });
  await turn();
  assert.equal(calls.contexts[0].closed, 1); assert.equal(calls.uploads.length, 0); assert.equal(calls.drafts.length, 0);
});

test('a main-process cancellation ignores old tokens and discards an in-flight transcript for the current token', async t => {
  const entered = deferred(), pending = deferred();
  const { recorder, calls, tracks } = browserFixture(t, { transcribeAudio: () => { entered.resolve(); return pending.promise; } });
  await recorder.start();
  recorder.handleEvent({ type: 'microphone-cancelled', token: 'stale-token' });
  assert.equal(recorder.phase, 'recording'); assert.equal(tracks[0].stopped, 0);
  recorder.stop(); await entered.promise;
  recorder.handleEvent({ type: 'microphone-cancelled', token: 'grant-1' });
  pending.resolve({ text: 'Stale draft must not appear.' }); await turn();
  assert.equal(calls.drafts.length, 0); assert.equal(calls.cancel.length, 0, 'No echo cancellation IPC for a main-process event');
  assert.equal(recorder.active, false);
});

test('recorder startup failure releases an already opened microphone and its grant', async t => {
  const { recorder, tracks, calls } = browserFixture(t, { recorderStartError: new Error('Recorder could not start.') });
  await recorder.start();
  assert.equal(tracks[0].stopped, 1); assert.equal(calls.cancel.length, 1);
  assert.equal(calls.uploads.length, 0); assert.equal(recorder.active, false); assert.equal(calls.errors.length, 1);
});

test('recording overflow releases the device and never forwards the accumulated bytes', async t => {
  const { recorder, recorders, calls, tracks } = browserFixture(t);
  await recorder.start();
  recorders[0].ondataavailable({ data: new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]) });
  await turn();
  assert.equal(tracks[0].stopped, 1); assert.equal(calls.cancel.length, 1);
  assert.equal(calls.uploads.length, 0); assert.equal(recorder.chunks.length, 0); assert.equal(recorder.active, false);
  assert.match(calls.errors[0].message, /size limit/i);
});

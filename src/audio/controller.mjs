import { randomUUID } from 'node:crypto';
import { secretBinding } from '../core/storage.mjs';
import { SPEECH_PRESETS, validateSpeechConnection, transcribeAudio, validateWavAudio } from './transcription.mjs';

export function speechIdentity(config) {
  return { id: 'microphone-transcription', provider: 'speech:' + config.provider, baseUrl: config.baseUrl, workspaceId: '' };
}

/** Microphone grants are short lived, audio only, and limited to the settings main frame. */
export function allowsMicrophone({ permission, senderId, expectedId, frameUrl, expectedUrl, isMainFrame,
  mediaTypes, mediaType, recording = false, check = false }) {
  if (permission !== 'media' || !recording || !expectedId || senderId !== expectedId ||
      frameUrl !== expectedUrl || isMainFrame !== true) return false;
  return check ? mediaType === 'audio'
    : Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio';
}

export class SpeechController {
  constructor({ service, emit = () => {}, transcribe = transcribeAudio, recordingTimeoutMs = 75000 }) {
    Object.assign(this, { service, emit, transcribe, recordingTimeoutMs });
    this.current = null;
  }
  decorate(state) {
    const config = state.config.speech;
    return { ...state, speechProviders: SPEECH_PRESETS,
      config: { ...state.config, speech: { ...config, hasKey: this.service.secrets.has(speechIdentity(config)) } } };
  }
  stamp() {
    const { speech, privacy, activeConnectionId, connections } = this.service.config;
    const chat = connections.find(item => item.id === activeConnectionId);
    return JSON.stringify([speech, privacy.localOnly, privacy.paused, activeConnectionId,
      chat && [chat.provider, chat.baseUrl, chat.model, chat.workspaceId]]);
  }
  cancel(reason = 'Recording cancelled.', token) {
    const current = this.current;
    if (!current || (token && token !== current.token)) return;
    this.current = null;
    clearTimeout(current.timer);
    current.controller.abort();
    this.emit({ type: 'microphone-cancelled', token: current.token, reason });
    this.emit({ type: 'microphone', active: false });
  }
  checkState() {
    if (this.current && this.current.stamp !== this.stamp()) this.cancel('Recording cancelled because settings changed.');
  }
  assertCurrent(current) {
    if (!current || this.current !== current || current.controller.signal.aborted || current.stamp !== this.stamp()) {
      if (this.current === current) this.cancel();
      throw new Error('Microphone transcription cancelled.');
    }
  }
  async save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter the microphone settings.');
    this.cancel('Recording cancelled because microphone settings changed.');
    const config = validateSpeechConnection(input);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (config.enabled && config.provider !== 'whispercpp' && !config.model) throw new Error('Choose a speech transcription model before enabling the microphone.');
    return this.service.serial(async () => {
      const old = speechIdentity(this.service.config.speech);
      const next = speechIdentity(config);
      const changed = secretBinding(old) !== secretBinding(next);
      if (changed && this.service.secrets.has(old) && !apiKey && input.removeKey !== true) {
        throw new Error('Changing the speech provider or endpoint requires a new key or removal of the saved key.');
      }
      if (apiKey) await this.service.secrets.put(next, apiKey);
      else if (input.removeKey === true || changed) await this.service.secrets.remove(next.id);
      this.service.config.speech = config;
      await this.service.settings.save(this.service.config);
      return this.service.publish();
    });
  }
  begin(ownerId) {
    this.service.assertReady();
    if (this.service.config.privacy.paused) throw new Error('Resume the companion before using the microphone.');
    if (this.service.busy) throw new Error('Wait for the current reply before recording.');
    const config = validateSpeechConnection(this.service.config.speech, { localOnly: this.service.config.privacy.localOnly });
    if (!config.enabled) throw new Error('Enable microphone input in Voice & memory first.');
    if (config.provider !== 'whispercpp' && !config.model) throw new Error('Choose a speech transcription model first.');
    if (SPEECH_PRESETS.find(item => item.id === config.provider)?.keyRequired && !this.service.secrets.has(speechIdentity(config))) {
      throw new Error('Add the speech service API key in Voice & memory first.');
    }
    this.cancel();
    const current = { token: randomUUID(), ownerId, stamp: this.stamp(), config,
      controller: new AbortController(), phase: 'recording', timer: null };
    this.current = current;
    current.timer = setTimeout(() => this.cancel('The microphone session expired.', current.token), this.recordingTimeoutMs);
    current.timer.unref?.();
    this.emit({ type: 'microphone', active: true });
    return { token: current.token, maxSeconds: 60 };
  }
  canRecord(ownerId) {
    const current = this.current;
    return !!current && current.ownerId === ownerId && current.phase === 'recording' &&
      !current.controller.signal.aborted && current.stamp === this.stamp();
  }
  async submit({ token, audio } = {}, ownerId) {
    const current = this.current;
    if (!current || token !== current.token || ownerId !== current.ownerId || current.phase !== 'recording') {
      throw new Error('Start a new microphone recording before transcribing.');
    }
    this.assertCurrent(current);
    const bytes = validateWavAudio(audio);
    current.phase = 'transcribing';
    clearTimeout(current.timer);
    current.timer = setTimeout(() => this.cancel('The speech service took too long to respond.', current.token), 190000);
    current.timer.unref?.();
    this.emit({ type: 'microphone', active: false });
    try {
      const apiKey = await this.service.secrets.get(speechIdentity(current.config));
      this.assertCurrent(current);
      const text = await this.transcribe(current.config, { audio: bytes, apiKey,
        signal: current.controller.signal, localOnly: this.service.config.privacy.localOnly });
      this.assertCurrent(current);
      return { text };
    } finally {
      bytes.fill(0);
      clearTimeout(current.timer);
      if (this.current === current) this.current = null;
    }
  }
  dispose() { this.cancel(); }
}

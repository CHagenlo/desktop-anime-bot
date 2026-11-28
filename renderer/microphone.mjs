import { AUDIO_SAMPLE_RATE, MAX_RECORDING_SECONDS, encodeMonoWav } from '../src/audio/wav.mjs';

const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

function microphoneError(error) {
  if (error?.name === 'NotAllowedError') return new Error('Microphone access was denied. Enable microphone input here and allow desktop apps to use your microphone in Windows privacy settings.');
  if (error?.name === 'NotFoundError') return new Error('No microphone was found. Connect one or choose a default input in Windows sound settings.');
  if (error?.name === 'NotReadableError') return new Error('The microphone could not be opened. Check whether another app or Windows is blocking it.');
  return error instanceof Error ? error : new Error('The microphone could not complete this recording.');
}

/** Captures only an explicit recording; transcripts always return to an editable draft. */
export class MicrophoneRecorder {
  constructor({ api, onState = () => {}, onTranscript = () => {}, onError = () => {} }) {
    Object.assign(this, { api, onState, onTranscript, onError });
    this.phase = 'idle'; this.epoch = 0; this.token = null; this.stream = null;
    this.recorder = null; this.chunks = []; this.bytes = 0; this.timer = null; this.limit = null;
  }
  get active() { return this.phase !== 'idle'; }
  state(phase, text = '') {
    this.phase = phase;
    this.onState({ phase, text, seconds: this.started ? Math.floor((performance.now() - this.started) / 1000) : 0 });
  }
  async start() {
    if (this.active) return;
    const epoch = ++this.epoch;
    this.started = 0;
    this.state('requesting', 'Opening your microphone…');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function') throw new Error('Microphone recording is unavailable in this application runtime.');
      const grant = await this.api.beginMicrophone();
      if (epoch !== this.epoch) { await this.api.cancelMicrophone({ token: grant.token }); return; }
      this.token = grant.token;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch !== this.epoch) { stopTracks(stream); return; }
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This app runtime does not support microphone audio recording.');
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
      this.recorder = recorder; this.chunks = []; this.bytes = 0;
      recorder.ondataavailable = event => {
        if (epoch !== this.epoch || !event.data.size) return;
        this.bytes += event.data.size;
        if (this.bytes > MAX_COMPRESSED_BYTES) {
          void this.cancel(); this.onError(new Error('The recording exceeded the audio size limit. Try a shorter clip.')); return;
        }
        this.chunks.push(event.data);
      };
      recorder.onerror = () => { if (epoch === this.epoch) { void this.cancel(); this.onError(new Error('Microphone recording failed. Try another recording.')); } };
      recorder.onstop = () => { if (epoch === this.epoch) void this.finish(epoch, mimeType); };
      for (const track of stream.getAudioTracks()) track.onended = () => {
        if (epoch === this.epoch && this.phase === 'recording') this.stop();
      };
      recorder.start(500);
      this.started = performance.now();
      this.state('recording', 'Listening. Stop when you are ready to transcribe.');
      this.timer = setInterval(() => this.state('recording', 'Listening. Stop when you are ready to transcribe.'), 500);
      this.limit = setTimeout(() => this.stop(), MAX_RECORDING_SECONDS * 1000);
    } catch (error) {
      if (epoch !== this.epoch) return;
      await this.cancel(); this.onError(microphoneError(error));
    }
  }
  stop() {
    if (this.phase !== 'recording') return;
    clearInterval(this.timer); clearTimeout(this.limit);
    this.state('transcribing', 'Turning your recording into text…');
    if (this.recorder?.state !== 'inactive') this.recorder.stop();
    stopTracks(this.stream); this.stream = null;
  }
  async finish(epoch, mimeType) {
    let context, samples, wav;
    const token = this.token;
    try {
      stopTracks(this.stream); this.stream = null;
      const chunks = this.chunks; this.chunks = []; this.bytes = 0;
      if (!chunks.length) throw new Error('No microphone audio was recorded. Try a slightly longer recording.');
      context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
      const decoded = await context.decodeAudioData(await new Blob(chunks, { type: mimeType }).arrayBuffer());
      if (epoch !== this.epoch) return;
      const length = Math.min(decoded.length, AUDIO_SAMPLE_RATE * MAX_RECORDING_SECONDS);
      if (!length || decoded.sampleRate !== AUDIO_SAMPLE_RATE) throw new Error('The microphone recording could not be converted for speech recognition.');
      samples = new Float32Array(length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const input = decoded.getChannelData(channel);
        for (let i = 0; i < length; i += 1) samples[i] += input[i] / decoded.numberOfChannels;
      }
      wav = encodeMonoWav(samples);
      await context.close(); context = null;
      if (epoch !== this.epoch) return;
      const result = await this.api.transcribeAudio({ token, audio: wav });
      if (epoch !== this.epoch) return;
      this.token = null;
      this.state('idle', 'Transcript added to your draft. Review it, then send when ready.');
      this.onTranscript(result.text);
    } catch (error) {
      if (epoch === this.epoch) { await this.cancel(); this.onError(microphoneError(error)); }
    } finally {
      samples?.fill(0); wav?.fill(0);
      await context?.close().catch(() => {});
      if (epoch === this.epoch) { this.recorder = null; this.chunks = []; this.bytes = 0; }
    }
  }
  async cancel({ notifyMain = true } = {}) {
    ++this.epoch;
    const token = this.token; this.token = null;
    clearInterval(this.timer); clearTimeout(this.limit);
    if (this.recorder) {
      this.recorder.onstop = null; this.recorder.ondataavailable = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    }
    stopTracks(this.stream); this.stream = null; this.recorder = null;
    this.chunks = []; this.bytes = 0; this.started = 0;
    this.state('idle');
    if (notifyMain && token) await this.api.cancelMicrophone({ token }).catch(() => {});
  }
  handleEvent(event) {
    if (event.type === 'microphone-cancelled' && event.token === this.token) void this.cancel({ notifyMain: false });
  }
}

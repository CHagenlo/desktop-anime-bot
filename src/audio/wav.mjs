// Browser-safe PCM encoder shared by microphone capture and protocol tests.
export const AUDIO_SAMPLE_RATE = 16000;
export const MAX_RECORDING_SECONDS = 60;
export const MAX_WAV_BYTES = 44 + AUDIO_SAMPLE_RATE * MAX_RECORDING_SECONDS * 2;

/** Encode already-resampled mono audio; no filesystem or microphone access. */
export function encodeMonoWav(samples, sampleRate = AUDIO_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > AUDIO_SAMPLE_RATE * MAX_RECORDING_SECONDS) {
    throw new Error('Record between a moment and 60 seconds of audio.');
  }
  if (sampleRate !== AUDIO_SAMPLE_RATE) throw new Error('Microphone audio must be resampled to 16 kHz.');
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const label = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
  };
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE');
  label(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) throw new Error('The microphone returned invalid audio samples.');
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

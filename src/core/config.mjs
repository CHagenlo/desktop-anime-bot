import path from 'node:path';
import { validateSpeechConnection } from '../audio/transcription.mjs';

export const CAPABILITIES = ['reactToWindows', 'seeWindowContents', 'manageWindows'];
export const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  activeConnectionId: '',
  connections: [],
  memory: { enabled: true },
  speech: { enabled: false, provider: 'whispercpp', baseUrl: 'http://127.0.0.1:8080', model: '', language: '' },
  privacy: { localOnly: false, reactToWindows: true, seeWindowContents: false,
    manageWindows: false, paused: false, mode: 'custom', rules: [] },
  character: { name: 'Companion', personality: 'You are a warm, curious, gently playful desktop companion. Be concise. Be honest about what you can see and do.',
    playfulness: 'balanced', speechEnabled: false, modelName: '' },
  playProfile: { reactToWindows: true, seeWindowContents: false, manageWindows: false }
});

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function text(value, maximum = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum);
}
export function modelIdentifier(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Enter a model identifier of at most 512 characters.');
  return value.trim();
}
export function executableKey(value) {
  const cleaned = text(value, 2048).replaceAll('/', '\\');
  if (!path.win32.isAbsolute(cleaned) || cleaned.startsWith('\\\\')) throw new Error('Select a local executable from the window list.');
  return path.win32.normalize(cleaned).toLowerCase();
}

export function sanitizeRule(input) {
  if (!plain(input)) throw new Error('Invalid app rule.');
  return { exePath: executableKey(input.exePath), label: text(input.label, 120) || path.win32.basename(input.exePath),
    protected: input.protected === true, layout: input.layout === true,
    vision: input.vision === true, manage: input.manage === true };
}

export function sanitizeConfig(input = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  if (!plain(input)) return config;
  const privacy = plain(input.privacy) ? input.privacy : {};
  if (plain(input.memory) && typeof input.memory.enabled === 'boolean') config.memory.enabled = input.memory.enabled;
  const speech = plain(input.speech) ? input.speech : {};
  if (['whispercpp', 'openai', 'compatible'].includes(speech.provider)) {
    try { config.speech = validateSpeechConnection(speech); }
    catch { /* Invalid saved speech settings never enable recording or an altered destination. */ }
  }
  for (const key of ['localOnly', 'paused', ...CAPABILITIES]) {
    if (typeof privacy[key] === 'boolean') config.privacy[key] = privacy[key];
  }
  if (['work', 'play', 'custom'].includes(privacy.mode)) config.privacy.mode = privacy.mode;
  if (Array.isArray(privacy.rules)) {
    const byPath = new Map();
    for (const candidate of privacy.rules.slice(0, 300)) {
      try { const rule = sanitizeRule(candidate); byPath.set(rule.exePath, rule); } catch { /* A malformed rule grants no access. */ }
    }
    config.privacy.rules = [...byPath.values()];
  }
  if (plain(input.playProfile)) for (const key of CAPABILITIES) {
    if (typeof input.playProfile[key] === 'boolean') config.playProfile[key] = input.playProfile[key];
  }
  const character = plain(input.character) ? input.character : {};
  config.character.name = text(character.name, 60) || config.character.name;
  config.character.personality = text(character.personality, 6000) || config.character.personality;
  if (['quiet', 'balanced', 'playful'].includes(character.playfulness)) config.character.playfulness = character.playfulness;
  config.character.speechEnabled = character.speechEnabled === true;
  config.character.modelName = text(character.modelName, 160);
  if (Array.isArray(input.connections)) {
    const ids = new Set();
    for (const c of input.connections.slice(0, 40)) {
      if (!plain(c) || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id || '') || ids.has(c.id)) continue;
      ids.add(c.id);
      try {
        config.connections.push({ id: c.id, name: text(c.name, 80) || text(c.provider, 40), provider: text(c.provider, 40),
          baseUrl: text(c.baseUrl, 2048), model: modelIdentifier(c.model), supportsVision: c.supportsVision === true,
          workspaceId: text(c.workspaceId, 200), anthropicVersion: text(c.anthropicVersion, 20) });
      } catch { /* Invalid model identifiers never become truncated destinations. */ }
    }
  }
  if (config.connections.some(c => c.id === input.activeConnectionId)) config.activeConnectionId = input.activeConnectionId;
  if (config.privacy.mode === 'work') {
    for (const key of CAPABILITIES) config.privacy[key] = false;
    config.character.playfulness = 'quiet';
  }
  return config;
}

export function applyPreferences(current, patch) {
  if (!plain(patch)) throw new Error('Invalid settings update.');
  const next = sanitizeConfig(current);
  if (plain(patch.memory) && Object.hasOwn(patch.memory, 'enabled')) {
    if (typeof patch.memory.enabled !== 'boolean') throw new Error('The memory switch must be true or false.');
    next.memory.enabled = patch.memory.enabled;
  }
  const p = plain(patch.privacy) ? patch.privacy : {};
  for (const key of ['localOnly', 'paused', ...CAPABILITIES]) {
    if (Object.hasOwn(p, key) && typeof p[key] !== 'boolean') throw new Error('Settings switches must be true or false.');
  }
  if (p.mode === 'work') {
    if (next.privacy.mode !== 'work') for (const key of CAPABILITIES) next.playProfile[key] = next.privacy[key];
    for (const key of CAPABILITIES) next.privacy[key] = false;
    next.privacy.mode = 'work';
    next.character.playfulness = 'quiet';
  } else if (p.mode === 'play') {
    for (const key of CAPABILITIES) next.privacy[key] = next.playProfile[key];
    next.privacy.mode = 'play';
    next.character.playfulness = 'playful';
  } else {
    let changed = false;
    for (const key of CAPABILITIES) if (Object.hasOwn(p, key)) { next.privacy[key] = p[key]; changed = true; }
    if (changed || p.mode === 'custom') {
      next.privacy.mode = 'custom';
      for (const key of CAPABILITIES) next.playProfile[key] = next.privacy[key];
    }
  }
  for (const key of ['localOnly', 'paused']) if (Object.hasOwn(p, key)) next.privacy[key] = p[key];
  const c = plain(patch.character) ? patch.character : {};
  if (Object.hasOwn(c, 'name')) next.character.name = text(c.name, 60) || 'Companion';
  if (Object.hasOwn(c, 'personality')) next.character.personality = text(c.personality, 6000) || DEFAULT_CONFIG.character.personality;
  if (Object.hasOwn(c, 'playfulness')) {
    if (!['quiet', 'balanced', 'playful'].includes(c.playfulness)) throw new Error('Unknown playfulness level.');
    next.character.playfulness = c.playfulness;
    if (next.privacy.mode === 'work' && c.playfulness !== 'quiet') next.privacy.mode = 'custom';
  }
  if (Object.hasOwn(c, 'speechEnabled')) {
    if (typeof c.speechEnabled !== 'boolean') throw new Error('Speech setting must be true or false.');
    next.character.speechEnabled = c.speechEnabled;
  }
  return next;
}

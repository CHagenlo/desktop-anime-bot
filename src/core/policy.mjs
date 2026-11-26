import { executableKey } from './config.mjs';

const FLAGS = { layout: 'reactToWindows', vision: 'seeWindowContents', manage: 'manageWindows' };
export function assertWindowPermission(config, target, capability) {
  if (!Object.hasOwn(FLAGS, capability)) throw new Error('Unknown desktop capability.');
  if (config.privacy.paused) throw new Error('Desktop activity is paused.');
  if (!config.privacy[FLAGS[capability]]) throw new Error('Enable the corresponding desktop capability first.');
  if (!target || !target.handle || !target.pid || !target.exePath) throw new Error('Select a window first.');
  const key = executableKey(target.exePath);
  const rule = config.privacy.rules.find(rule => rule.exePath === key);
  if (!rule || rule.protected || rule[capability] !== true) throw new Error('This app is excluded or has not been allowed for that capability.');
  if (capability === 'vision' && target.minimized) throw new Error('Restore the selected window before viewing it.');
}

export function sameWindow(expected, actual, { includeTitle = true } = {}) {
  if (!expected || !actual) return false;
  try {
    return expected.handle === actual.handle && expected.pid === actual.pid &&
      executableKey(expected.exePath) === executableKey(actual.exePath) &&
      (!includeTitle || expected.title === actual.title);
  } catch { return false; }
}

export class PermissionGate {
  #revision = 0;
  #operations = new Set();
  revoke() {
    this.#revision += 1;
    for (const controller of this.#operations) controller.abort();
    this.#operations.clear();
  }
  lease() {
    const revision = this.#revision;
    const controller = new AbortController();
    this.#operations.add(controller);
    return {
      signal: controller.signal,
      assertActive: () => {
        if (revision !== this.#revision || controller.signal.aborted) throw new Error('Operation cancelled because settings or the selected target changed.');
      },
      release: () => this.#operations.delete(controller)
    };
  }
}

export function sanitizeAction(input) {
  if (!input || typeof input !== 'object') throw new Error('Select a window action.');
  if (input.type === 'move') {
    const dx = Number(input.dx), dy = Number(input.dy);
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) > 1000 || Math.abs(dy) > 1000) throw new Error('Window movement must be an integer between -1000 and 1000 pixels.');
    return { type: 'move', dx, dy };
  }
  if (input.type === 'resize') {
    const width = Number(input.width), height = Number(input.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 120 || width > 7680 || height > 4320) throw new Error('Choose a supported window size.');
    return { type: 'resize', width, height };
  }
  if (['minimize', 'restore'].includes(input.type)) return { type: input.type };
  throw new Error('That action is not available. This prototype cannot close windows, type into apps, or run commands.');
}

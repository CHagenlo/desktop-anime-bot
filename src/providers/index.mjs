/** Provider adapters. Credentials and images must remain in the native process. */
export const PROVIDER_PRESETS = Object.freeze([
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', kind: 'hosted', keyRequired: true },
  { id: 'anthropic', label: 'Anthropic · Claude', baseUrl: 'https://api.anthropic.com', kind: 'hosted', keyRequired: true },
  { id: 'gemini', label: 'Google · Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', kind: 'hosted', keyRequired: true },
  { id: 'xai', label: 'xAI · Grok', baseUrl: 'https://api.x.ai/v1', kind: 'hosted', keyRequired: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', kind: 'hosted', keyRequired: true },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', kind: 'hosted', keyRequired: true },
  { id: 'ollama', label: 'Ollama · local', baseUrl: 'http://localhost:11434', kind: 'local', keyRequired: false },
  { id: 'lmstudio', label: 'LM Studio · local', baseUrl: 'http://localhost:1234/v1', kind: 'local', keyRequired: false },
  { id: 'compatible', label: 'Custom · OpenAI compatible', baseUrl: '', kind: 'custom', keyRequired: false },
].map(Object.freeze));

const PRESETS = new Map(PROVIDER_PRESETS.map(p => [p.id, p]));
const DEFAULT_ANTHROPIC_VERSION = '2026-10-21';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 16 * 1024 * 1024;
const MODEL_LOAD_TIMEOUT_MS = 5 * 60 * 1000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

function fail(code, message) { throw new ProviderError(code, message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isLoopback(url) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
}
function plainString(value, limit, code = 'INVALID_CONFIGURATION') {
  if (typeof value !== 'string' || value.length > limit || CONTROL_CHARACTERS.test(value)) {
    fail(code, 'A configuration field contains invalid text.');
  }
  return value.trim();
}
function checkAbort(signal) {
  if (signal?.aborted) fail('ABORTED', 'Request cancelled.');
}

// These load endpoints report completion, not a fractional percentage. Keep the
// public progress contract nullable; never infer a percentage from elapsed time.
function reportProgress(options, phase, text) {
  if (options.signal?.aborted || typeof options.onProgress !== 'function') return;
  try {
    const pending = options.onProgress({ phase, text, progress: null });
    // A status display must not turn a successful inference into a failed one.
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* Progress is advisory; cancellation is checked before each request. */ }
}

/** Validate a public configuration; never carry unrecognized fields or secrets through. */
export function validateConnection(connection, { localOnly = false } = {}) {
  if (!isObject(connection) || !PRESETS.has(connection.provider)) {
    fail('INVALID_PROVIDER', 'Choose a supported AI provider.');
  }
  const preset = PRESETS.get(connection.provider);
  const raw = plainString(connection.baseUrl || preset.baseUrl, 2048);
  if (!raw || /\s/.test(raw) || /[?#\\]/.test(raw) || /\/\/[^/]*@/.test(raw)) {
    fail('INVALID_ENDPOINT', 'Use a server URL without credentials, a query, or a fragment.');
  }
  let url;
  try { url = new URL(raw); } catch { fail('INVALID_ENDPOINT', 'Enter a valid AI server URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    fail('INVALID_ENDPOINT', 'Use an HTTPS server URL, or HTTP on this computer only.');
  }
  if (url.protocol === 'http:' && !isLoopback(url)) {
    fail('INSECURE_ENDPOINT', 'HTTP is allowed only for a loopback server on this computer.');
  }
  if (localOnly && (preset.kind !== 'local' || !isLoopback(url))) {
    fail('LOCAL_ONLY', 'Local-only mode requires Ollama or LM Studio on a loopback address.');
  }
  // Native local protocols have known roots. Avoid accidentally treating a proxy
  // path as one of the recognized local runtimes.
  if (preset.kind === 'local') {
    if (!['', '/', '/v1', '/v1/'].includes(url.pathname)) {
      fail('INVALID_ENDPOINT', 'Use the local server root, or its /v1 endpoint.');
    }
    url.pathname = preset.id === 'lmstudio' ? '/v1' : '/';
  }
  const workspaceId = plainString(connection.workspaceId ?? '', 200);
  if (workspaceId && !/^[A-Za-z0-9_.:-]+$/.test(workspaceId)) {
    fail('INVALID_CONFIGURATION', 'The workspace identifier contains invalid characters.');
  }
  const version = plainString(connection.anthropicVersion || DEFAULT_ANTHROPIC_VERSION, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
    fail('INVALID_CONFIGURATION', 'Use an API version in YYYY-MM-DD format.');
  }
  return {
    id: plainString(connection.id ?? '', 200),
    name: plainString(connection.name || preset.label, 200),
    provider: preset.id,
    baseUrl: url.href.replace(/\/+$/, ''),
    model: plainString(connection.model ?? '', 512),
    supportsVision: connection.supportsVision === true,
    workspaceId,
    anthropicVersion: version,
  };
}

function endpoint(connection, path, query) {
  const url = new URL(connection.baseUrl + '/' + path);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
  }
  return url.href;
}
function lmStudioRoot(connection) { return { ...connection, baseUrl: connection.baseUrl.replace(/\/v1$/, '') }; }

function requestHeaders(connection, apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length > 8192 || CONTROL_CHARACTERS.test(apiKey)) {
    fail('INVALID_KEY', 'The API key contains invalid characters.');
  }
  const key = apiKey.trim();
  if (PRESETS.get(connection.provider).keyRequired && !key) {
    fail('MISSING_KEY', 'Add an API key for this connection.');
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (key) {
    if (connection.provider === 'gemini') headers['x-goog-api-key'] = key;
    else headers.Authorization = 'Bearer ' + key;
  }
  if (connection.provider === 'anthropic') {
    headers['anthropic-version'] = connection.anthropicVersion;
    if (connection.workspaceId) headers['anthropic-workspace-id'] = connection.workspaceId;
  }
  return headers;
}

/** Fetch with a bounded response and a redacted error boundary. Never follow redirects. */
async function requestJson(connection, path, options, { method = 'GET', body, query, timeoutMs = 30000 } = {}) {
  checkAbort(options.signal);
  const headers = requestHeaders(connection, options.apiKey ?? '');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timeout.unref?.();
  try {
    checkAbort(options.signal);
    const response = await options.fetchImpl(endpoint(connection, path, query), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });
    checkAbort(options.signal);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      fail('REDIRECT_BLOCKED', 'The AI server redirected the request. Check the configured endpoint.');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) fail('AUTHENTICATION', 'The provider rejected this connection’s credentials or access.');
      if (response.status === 429) fail('RATE_LIMIT', 'The provider’s rate or usage limit was reached.');
      if (response.status === 404) fail('NOT_FOUND', 'The provider endpoint or selected model was not found.');
      fail('PROVIDER_HTTP', 'The provider could not complete the request (HTTP ' + Number(response.status) + ').');
    }
    const length = Number(response.headers?.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'The provider response was too large.');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      const chunks = [];
      try {
        while (true) {
          checkAbort(options.signal);
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => {});
            fail('INVALID_RESPONSE', 'The provider response was too large.');
          }
          chunks.push(decoder.decode(part.value, { stream: true }));
        }
        chunks.push(decoder.decode());
        text = chunks.join('');
      } finally { reader.releaseLock(); }
    } else {
      text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'The provider response was too large.');
    }
    checkAbort(options.signal);
    let data;
    try { data = JSON.parse(text); } catch { fail('INVALID_RESPONSE', 'The provider returned an unreadable response.'); }
    if (!isObject(data)) fail('INVALID_RESPONSE', 'The provider returned an unexpected response format.');
    return data;
  } catch (error) {
    if (options.signal?.aborted) fail('ABORTED', 'Request cancelled.');
    if (timedOut) fail('TIMEOUT', 'The AI server took too long to respond.');
    if (error instanceof ProviderError) throw error;
    // Network errors, body errors, and provider-generated messages can contain
    // credentials or screenshots. Deliberately retain no original error/cause.
    fail('CONNECTION_FAILED', 'Could not reach the configured AI server. Check its address and availability.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

function modelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !CONTROL_CHARACTERS.test(value) ? value : null;
}
function displayName(value, id) { return typeof value === 'string' && value.length ? value.slice(0, 256) : id; }
function uniqueModels(models) { return [...new Map(models.map(model => [model.id, model])).values()]; }
function requireArray(data, property) {
  if (!Array.isArray(data[property])) fail('INVALID_RESPONSE', 'The provider did not return a model list.');
  return data[property];
}
function remoteMetadata(item) {
  return isObject(item) && Boolean(item.remote_model || item.remote_host || item.remote === true || item.is_remote === true);
}
function ollamaRemote(tag, info) {
  return remoteMetadata(tag) || remoteMetadata(info) || remoteMetadata(info?.model_info) || /:cloud$/i.test(tag?.model || tag?.name || '');
}
function ollamaLocalProof(tag, info) {
  return !ollamaRemote(tag, info) && typeof tag.digest === 'string' && tag.digest.length > 0 &&
    Number.isFinite(tag.size) && tag.size > 0 && isObject(info?.model_info) &&
    Array.isArray(info.capabilities) && info.capabilities.includes('completion');
}
function ollamaVision(info) {
  return Array.isArray(info?.capabilities) ? info.capabilities.includes('vision') : null;
}
async function ollamaTags(connection, options) {
  const data = await requestJson(connection, 'api/tags', options);
  return requireArray(data, 'models').filter(isObject);
}
async function ollamaShow(connection, id, options) {
  return requestJson(connection, 'api/show', options, { method: 'POST', body: { model: id } });
}
async function selectedOllama(connection, options) {
  const tags = await ollamaTags(connection, options);
  // Ollama resolves an untagged model name to :latest. Preserve that documented
  // shorthand without accepting a different explicit tag or an arbitrary alias.
  const basename = connection.model.slice(connection.model.lastIndexOf('/') + 1);
  const canonical = basename && !basename.includes(':') ? connection.model + ':latest' : connection.model;
  const tag = tags.find(item => item.model === connection.model || item.name === connection.model) ||
    tags.find(item => item.model === canonical || item.name === canonical);
  if (!tag) fail('MODEL_NOT_INSTALLED', 'The selected model was not found in Ollama’s installed model list.');
  if (options.localOnly && ollamaRemote(tag)) fail('REMOTE_MODEL', 'Local-only mode blocks cloud-backed Ollama models.');
  const model = modelId(tag.model) || modelId(tag.name);
  if (!model) fail('INVALID_RESPONSE', 'Ollama returned an unreadable installed model identifier.');
  const info = await ollamaShow(connection, model, options);
  if (options.localOnly && !ollamaLocalProof(tag, info)) {
    fail('LOCAL_MODEL_UNVERIFIED', 'Ollama could not verify that the selected model is installed locally.');
  }
  return { tag, info, model };
}

async function loadLocalModel(connection, path, options, body) {
  try {
    return await requestJson(connection, path, options, {
      method: 'POST', body, timeoutMs: MODEL_LOAD_TIMEOUT_MS,
    });
  } catch (error) {
    if (error.code === 'TIMEOUT') {
      fail('MODEL_LOAD_TIMEOUT', 'The local model did not finish loading within five minutes. Try loading it in your local AI app before retrying.');
    }
    throw error;
  }
}

async function prepareOllamaModel(connection, selected, options) {
  // Explicitly selected cloud-backed or unverified entries retain the existing
  // chat route outside local-only mode; never send them a local warm-up request.
  if (!ollamaLocalProof(selected.tag, selected.info)) return false;
  const data = await requestJson(connection, 'api/ps', options);
  const running = requireArray(data, 'models').some(item => isObject(item) && !ollamaRemote(item) &&
    (item.model === selected.model || item.name === selected.model || item.model === connection.model ||
      item.name === connection.model || item.digest === selected.tag.digest) &&
    (!item.digest || item.digest === selected.tag.digest));
  if (running) return true;
  reportProgress(options, 'loading', 'Loading the Ollama model into memory…');
  // An empty prompt loads an installed model without generating a dummy answer.
  // Omit options/keep_alive so the server's context and retention settings stay in control.
  // https://docs.ollama.com/faq#how-can-i-preload-a-model-into-ollama-to-get-faster-response-times
  const loaded = await loadLocalModel(connection, 'api/generate', options, {
    model: selected.model, prompt: '', stream: false,
  });
  if (loaded.done !== true || (loaded.done_reason !== undefined && loaded.done_reason !== 'load') ||
      typeof loaded.response !== 'string' || loaded.response !== '' ||
      (loaded.model !== connection.model && loaded.model !== selected.tag.model && loaded.model !== selected.tag.name)) {
    fail('INVALID_RESPONSE', 'Ollama did not confirm that the selected model finished loading.');
  }
  return true;
}

async function lmStudioModels(connection, options) {
  const data = await requestJson(lmStudioRoot(connection), 'api/v1/models', options);
  return requireArray(data, 'models').filter(item => isObject(item) && item.type === 'llm' && modelId(item.key));
}
function lmStudioLocalProof(item) {
  return !remoteMetadata(item) && item.type === 'llm' &&
    ((Number.isFinite(item.size_bytes) && item.size_bytes > 0) ||
      (Array.isArray(item.loaded_instances) && item.loaded_instances.some(instance => isObject(instance) && modelId(instance.id))));
}

async function prepareLmStudioModel(connection, selected, options) {
  if (!lmStudioLocalProof(selected)) return { model: connection.model, ready: false };
  if (!Array.isArray(selected.loaded_instances)) {
    fail('INVALID_RESPONSE', 'LM Studio did not report whether the selected model is loaded.');
  }
  const instances = selected.loaded_instances.filter(instance => isObject(instance) && modelId(instance.id));
  const running = instances.find(instance => instance.id === connection.model) || instances[0];
  // Use the existing instance itself, preserving its selected context/GPU/load configuration.
  if (running) return { model: running.id, ready: true };
  if (selected.loaded_instances.length) {
    fail('INVALID_RESPONSE', 'LM Studio returned an unreadable loaded model instance.');
  }
  reportProgress(options, 'loading', 'Loading the LM Studio model into memory…');
  // The native /chat endpoint has loading percentages but cannot accept assistant
  // history. Its dedicated load endpoint lets us preserve stateless, role-based
  // chat and local history without sending conversation text in a warm-up request.
  // https://lmstudio.ai/docs/developer/rest/load
  const loaded = await loadLocalModel(lmStudioRoot(connection), 'api/v1/models/load', options, {
    model: selected.key,
  });
  if (loaded.type !== 'llm' || loaded.status !== 'loaded' || !modelId(loaded.instance_id)) {
    fail('INVALID_RESPONSE', 'LM Studio did not confirm that the selected model finished loading.');
  }
  return { model: loaded.instance_id, ready: true };
}

export async function listModels(connection, { apiKey = '', signal, localOnly = false, fetchImpl = fetch } = {}) {
  const c = validateConnection(connection, { localOnly });
  const options = { apiKey, signal, localOnly, fetchImpl };
  checkAbort(signal);
  if (c.provider === 'ollama') {
    const tags = await ollamaTags(c, options);
    const result = [];
    // Sequential local lookups keep startup bounded and avoid loading work onto
    // every installed model concurrently. /show reads metadata, not inference.
    for (const tag of tags) {
      checkAbort(signal);
      const id = modelId(tag.model) || modelId(tag.name);
      if (!id || (localOnly && ollamaRemote(tag))) continue;
      let info;
      try { info = await ollamaShow(c, id, options); }
      catch (error) {
        if (error.code === 'ABORTED') throw error;
        // Unknown capabilities remain unknown; local-only discovery omits any
        // model whose local evidence could not be established.
        if (localOnly) continue;
      }
      if (localOnly && !ollamaLocalProof(tag, info)) continue;
      result.push({ id, name: displayName(tag.name, id), supportsVision: ollamaVision(info), remote: ollamaRemote(tag, info) });
    }
    return uniqueModels(result);
  }
  if (c.provider === 'lmstudio') {
    const models = await lmStudioModels(c, options);
    return uniqueModels(models.filter(item => !localOnly || lmStudioLocalProof(item)).map(item => ({
      id: item.key,
      name: displayName(item.display_name, item.key),
      supportsVision: typeof item.capabilities?.vision === 'boolean' ? item.capabilities.vision : null,
      remote: remoteMetadata(item),
    })));
  }
  if (c.provider === 'gemini') {
    const result = [];
    let next;
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const data = await requestJson(c, 'models', options, { query: { pageSize: '100', pageToken: next } });
      for (const item of requireArray(data, 'models')) {
        const id = modelId(item?.name);
        if (!id || (Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes('generateContent'))) continue;
        result.push({ id, name: displayName(item.displayName, id), supportsVision: null, remote: true });
      }
      if (!data.nextPageToken) return uniqueModels(result);
      next = plainString(data.nextPageToken, 4096, 'INVALID_RESPONSE');
      if (seen.has(next)) fail('INVALID_RESPONSE', 'The provider returned a repeated model-list page.');
      seen.add(next);
    }
    fail('INVALID_RESPONSE', 'The provider returned too many model-list pages.');
  }
  if (c.provider === 'anthropic') {
    const result = [];
    let query = { limit: '100' };
    const seen = new Set();
    for (let page = 0; page < 20; page++) {
      const data = await requestJson(c, 'v1/models', options, { query });
      for (const item of requireArray(data, 'data')) {
        const id = modelId(item?.id);
        if (!id) continue;
        const support = item.capabilities?.vision?.supported ?? item.capabilities?.image_input?.supported;
        result.push({ id, name: displayName(item.display_name, id), supportsVision: typeof support === 'boolean' ? support : null, remote: true });
      }
      const cursor = data.next_page || (data.has_more ? data.last_id : null);
      if (!cursor) return uniqueModels(result);
      const next = plainString(cursor, 4096, 'INVALID_RESPONSE');
      if (seen.has(next)) fail('INVALID_RESPONSE', 'The provider returned a repeated model-list page.');
      seen.add(next);
      query = data.next_page ? { limit: '100', page: next } : { limit: '100', after_id: next };
    }
    fail('INVALID_RESPONSE', 'The provider returned too many model-list pages.');
  }
  const data = await requestJson(c, 'models', options);
  return uniqueModels(requireArray(data, 'data').flatMap(item => {
    const id = modelId(item?.id);
    if (!id) return [];
    const modalities = item.input_modalities;
    const support = typeof item.capabilities?.vision === 'boolean' ? item.capabilities.vision :
      Array.isArray(modalities) ? modalities.includes('image') : null;
    return [{ id, name: displayName(item.name || item.display_name, id), supportsVision: support, remote: true }];
  }));
}

function prepareConversation(messages, system, image, connection) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200 ||
      !messages.some(message => message?.role === 'user')) {
    fail('INVALID_MESSAGES', 'A conversation needs at least one user message.');
  }
  const clean = messages.map(message => {
    if (!isObject(message) || !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || message.content.length > 1000000) {
      fail('INVALID_MESSAGES', 'The conversation contains an unsupported message.');
    }
    return { role: message.role, content: message.content };
  });
  if (typeof system !== 'string' || system.length > 100000) fail('INVALID_MESSAGES', 'The character instructions are too large.');
  if (image !== null && image !== undefined) {
    if (connection.supportsVision !== true) fail('VISION_DISABLED', 'Enable image support only for a model that supports it.');
    if (!isObject(image) || image.mimeType !== 'image/png' || typeof image.base64 !== 'string' ||
        image.base64.length === 0 || image.base64.length > MAX_IMAGE_BASE64 || image.base64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
      fail('INVALID_IMAGE', 'The selected window image is invalid or too large.');
    }
  }
  return { messages: clean, system, image: image ?? null, latestUser: clean.findLastIndex(message => message.role === 'user') };
}
function compatibleMessages(conversation) {
  const messages = conversation.messages.map((message, index) => {
    if (conversation.image && index === conversation.latestUser) {
      return { role: message.role, content: [
        { type: 'text', text: message.content },
        { type: 'image_url', image_url: { url: 'data:' + conversation.image.mimeType + ';base64,' + conversation.image.base64 } },
      ] };
    }
    return { ...message };
  });
  return conversation.system ? [{ role: 'system', content: conversation.system }, ...messages] : messages;
}
function textBlocks(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : '';
}

export async function generateReply(connection, {
  apiKey = '', messages, system = '', image = null, signal, localOnly = false, fetchImpl = fetch, onDelta, onProgress,
} = {}) {
  const c = validateConnection(connection, { localOnly });
  checkAbort(signal);
  if (!c.model) fail('MISSING_MODEL', 'Select or enter a model for this connection.');
  const conversation = prepareConversation(messages, system, image, c);
  const options = { apiKey, signal, localOnly, fetchImpl, onProgress };
  let result;
  let text = '';
  if (c.provider === 'ollama') {
    reportProgress(options, 'checking', 'Checking the selected Ollama model…');
    const selected = await selectedOllama(c, options);
    if (conversation.image && ollamaVision(selected.info) !== true) fail('VISION_UNSUPPORTED', 'Ollama did not confirm image support for this model.');
    const ready = await prepareOllamaModel(c, selected, options);
    reportProgress(options, 'generating', ready ? 'Ollama model ready. Generating a reply…' : 'Ollama is preparing a reply…');
    const nativeMessages = conversation.messages.map((message, index) => ({ ...message,
      ...(conversation.image && index === conversation.latestUser ? { images: [conversation.image.base64] } : {}),
    }));
    if (system) nativeMessages.unshift({ role: 'system', content: system });
    result = await requestJson(c, 'api/chat', options, {
      method: 'POST', timeoutMs: 180000, body: { model: selected.model, messages: nativeMessages, stream: false },
    });
    text = typeof result.message?.content === 'string' ? result.message.content : '';
  } else if (c.provider === 'openai') {
    const input = conversation.messages.map((message, index) => ({ role: message.role, content:
      conversation.image && index === conversation.latestUser ? [
        { type: 'input_text', text: message.content },
        { type: 'input_image', image_url: 'data:' + conversation.image.mimeType + ';base64,' + conversation.image.base64 },
      ] : message.content,
    }));
    result = await requestJson(c, 'responses', options, { method: 'POST', timeoutMs: 180000,
      body: { model: c.model, input, ...(system ? { instructions: system } : {}), store: false, stream: false },
    });
    text = typeof result.output_text === 'string' ? result.output_text :
      (Array.isArray(result.output) ? result.output.flatMap(item => item?.type === 'message' && Array.isArray(item.content) ? item.content : [])
        .filter(block => block?.type === 'output_text' && typeof block.text === 'string').map(block => block.text).join('') : '');
  } else if (c.provider === 'anthropic') {
    const content = conversation.messages.map((message, index) => ({ role: message.role, content:
      conversation.image && index === conversation.latestUser ? [
        { type: 'image', source: { type: 'base64', media_type: conversation.image.mimeType, data: conversation.image.base64 } },
        { type: 'text', text: message.content },
      ] : message.content,
    }));
    result = await requestJson(c, 'v1/messages', options, { method: 'POST', timeoutMs: 180000,
      body: { model: c.model, messages: content, ...(system ? { system } : {}), max_tokens: 2048, stream: false },
    });
    text = textBlocks(result.content);
  } else if (c.provider === 'gemini') {
    const contents = conversation.messages.map((message, index) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [
      { text: message.content },
      ...(conversation.image && index === conversation.latestUser ? [{ inlineData: { mimeType: conversation.image.mimeType, data: conversation.image.base64 } }] : []),
    ] }));
    const id = c.model.startsWith('models/') ? c.model.slice(7) : c.model;
    result = await requestJson(c, 'models/' + encodeURIComponent(id) + ':generateContent', options, { method: 'POST', timeoutMs: 180000,
      body: { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) },
    });
    const parts = result.candidates?.[0]?.content?.parts;
    text = Array.isArray(parts) ? parts.filter(part => part?.thought !== true && typeof part?.text === 'string').map(part => part.text).join('') : '';
  } else {
    let inferenceModel = c.model;
    if (c.provider === 'lmstudio') {
      reportProgress(options, 'checking', 'Checking the selected LM Studio model…');
      const models = await lmStudioModels(c, options);
      const selected = models.find(model => model.key === c.model || (Array.isArray(model.loaded_instances) &&
        model.loaded_instances.some(instance => isObject(instance) && instance.id === c.model)));
      if (!selected) fail('MODEL_NOT_INSTALLED', 'The selected model was not found in LM Studio’s model list.');
      if (localOnly && !lmStudioLocalProof(selected)) fail('LOCAL_MODEL_UNVERIFIED', 'LM Studio could not verify that the selected model is installed locally.');
      if (conversation.image && selected.capabilities?.vision !== true) fail('VISION_UNSUPPORTED', 'LM Studio did not confirm image support for this model.');
      const prepared = await prepareLmStudioModel(c, selected, options);
      inferenceModel = prepared.model;
      reportProgress(options, 'generating', prepared.ready ? 'LM Studio model ready. Generating a reply…' : 'LM Studio is preparing a reply…');
    }
    result = await requestJson(c, 'chat/completions', options, { method: 'POST', timeoutMs: 180000,
      body: { model: inferenceModel, messages: compatibleMessages(conversation), stream: false },
    });
    text = textBlocks(result.choices?.[0]?.message?.content);
  }
  checkAbort(signal);
  if (!text.trim()) fail('EMPTY_REPLY', 'The model returned no text reply. Check the model’s capabilities and request limits.');
  if (typeof onDelta === 'function') onDelta(text);
  return text;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS, validateConnection, listModels, generateReply } from '../src/providers/index.mjs';

const KEY = 'key-for-tests-only';
const IMAGE = { mimeType: 'image/png', base64: 'iVBORw0KGgo=' };
const USER = [{ role: 'user', content: 'Hello.' }];
const config = (provider, more = {}) => ({ provider, model: 'chosen-exact-id', ...more });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function scripted(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: new URL(url), init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    assert.equal(init.redirect, 'error', 'Credentials must never follow redirects');
    assert.equal(init.cache, 'no-store');
    const step = steps[calls.length - 1];
    assert.notEqual(step, undefined, 'Unexpected network request');
    return typeof step === 'function' ? step(call) : json(step);
  };
  return { calls, fetchImpl };
}
function rejectsCode(promise, code) {
  return assert.rejects(promise, error => error.code === code);
}
const localTag = (extra = {}) => ({ name: 'local-model:exact', model: 'local-model:exact', digest: 'local-digest', size: 1024, ...extra });
const localInfo = (extra = {}) => ({ model_info: { architecture: 'local' }, capabilities: ['completion', 'vision'], ...extra });
const lmModel = (extra = {}) => ({ type: 'llm', key: 'publisher/model-exact', display_name: 'Local model', size_bytes: 1024, loaded_instances: [], capabilities: { vision: true }, ...extra });

test('presets cover all contracted providers and never contain model defaults', () => {
  assert.deepEqual(PROVIDER_PRESETS.map(p => p.id), ['openai', 'anthropic', 'gemini', 'xai', 'deepseek', 'mistral', 'ollama', 'lmstudio', 'compatible']);
  for (const preset of PROVIDER_PRESETS) {
    assert.equal('model' in preset, false);
    assert(Object.isFrozen(preset));
  }
});

test('normalization whitelists public fields and canonicalizes local roots', () => {
  const normal = validateConnection(config('openai', { apiKey: KEY, injected: true, baseUrl: 'https://api.openai.com/v1/' }));
  assert.equal(normal.baseUrl, 'https://api.openai.com/v1');
  assert.equal('apiKey' in normal, false);
  assert.equal('injected' in normal, false);
  assert.equal(validateConnection(config('ollama', { baseUrl: 'http://127.0.0.1:11434/v1' })).baseUrl, 'http://127.0.0.1:11434');
  assert.equal(validateConnection(config('lmstudio', { baseUrl: 'http://[::1]:1234' })).baseUrl, 'http://[::1]:1234/v1');
});

test('endpoint validation rejects credential-bearing, ambiguous, and remote HTTP URLs', () => {
  for (const baseUrl of ['http://example.com/v1', 'http://192.168.1.2:1234/v1', 'ftp://localhost', 'https://user:secret@example.com/v1', 'https://@example.com', 'https://api.example/v1?key=secret', 'https://api.example/v1?', 'https://api.example/v1#fragment', 'https://api.example/v1#', 'https://api.example/has space', 'https://api.example\\evil']) {
    assert.throws(() => validateConnection(config('compatible', { baseUrl })), error => error.name === 'ProviderError');
  }
  assert.throws(() => validateConnection(config('ollama', { baseUrl: 'http://localhost:11434/proxy' })), { code: 'INVALID_ENDPOINT' });
  assert.throws(() => validateConnection(config('unknown')), { code: 'INVALID_PROVIDER' });
});

test('local-only accepts recognized loopback runtimes and rejects hostname tricks/custom proxies', () => {
  for (const baseUrl of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://127.10.20.30:11434', 'http://[::1]:11434']) {
    assert.equal(validateConnection(config('ollama', { baseUrl }), { localOnly: true }).provider, 'ollama');
  }
  for (const connection of [config('openai'), config('compatible', { baseUrl: 'http://localhost:1234/v1' }), config('ollama', { baseUrl: 'https://localhost.example.com' }), config('lmstudio', { baseUrl: 'https://other-computer.example/v1' })]) {
    assert.throws(() => validateConnection(connection, { localOnly: true }), { code: 'LOCAL_ONLY' });
  }
});

test('missing key/model and disabled images fail before any fetch', async () => {
  const server = scripted();
  await rejectsCode(listModels(config('openai'), server), 'MISSING_KEY');
  await rejectsCode(generateReply(config('openai', { model: '' }), { ...server, apiKey: KEY, messages: USER }), 'MISSING_MODEL');
  await rejectsCode(generateReply(config('openai'), { ...server, apiKey: KEY, messages: USER, image: IMAGE }), 'VISION_DISABLED');
  await rejectsCode(generateReply(config('ollama'), { ...server, messages: USER, image: IMAGE }), 'VISION_DISABLED');
  assert.equal(server.calls.length, 0);
});

test('OpenAI Responses sends stateless requests and attaches images only to the latest user message', async () => {
  const original = [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Yes.' }, { role: 'user', content: 'Describe this.' }];
  const server = scripted(call => {
    assert.equal(call.url.href, 'https://api.openai.com/v1/responses');
    assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(call.body.store, false);
    assert.equal(call.body.stream, false);
    assert.equal(call.body.instructions, 'Stay concise.');
    assert.equal(call.body.model, 'chosen-exact-id');
    assert.equal(call.body.input[0].content, 'Earlier.');
    assert.equal(call.body.input[2].content[1].type, 'input_image');
    assert.equal(call.body.input[2].content[1].image_url, 'data:image/png;base64,' + IMAGE.base64);
    return json({ output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'A window.' }] }] });
  });
  const deltas = [];
  const progress = [];
  const reply = await generateReply(config('openai', { supportsVision: true }), { ...server, apiKey: KEY, messages: original, system: 'Stay concise.', image: IMAGE, onDelta: value => deltas.push(value), onProgress: value => progress.push(value) });
  assert.equal(reply, 'A window.');
  assert.deepEqual(deltas, ['A window.']);
  assert.deepEqual(progress, [], 'Hosted adapters keep their existing request path');
  assert.equal(original[2].content, 'Describe this.');
});

test('Claude uses native headers, system instructions, image blocks, and text-only output extraction', async () => {
  const server = scripted(call => {
    assert.equal(call.url.pathname, '/v1/messages');
    assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(call.init.headers['anthropic-version'], '2026-10-21');
    assert.equal(call.init.headers['anthropic-workspace-id'], 'wrkspc_test');
    assert.equal(call.body.system, 'Be warm.');
    assert.equal(call.body.max_tokens, 2048);
    assert.equal(call.body.messages[0].content[0].source.data, IMAGE.base64);
    assert.equal(call.body.messages[0].content[0].source.media_type, 'image/png');
    assert.equal('store' in call.body, false);
    return json({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Hello.' }] });
  });
  assert.equal(await generateReply(config('anthropic', { supportsVision: true, workspaceId: 'wrkspc_test' }), { ...server, apiKey: KEY, messages: USER, system: 'Be warm.', image: IMAGE }), 'Hello.');
});

test('Gemini uses the still-supported native stateless format and preserves discovered resource IDs', async () => {
  const server = scripted(call => {
    assert.equal(call.url.href, 'https://generativelanguage.googleapis.com/v1beta/models/discovered-id:generateContent');
    assert.equal(call.init.headers['x-goog-api-key'], KEY);
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.body.contents[1].role, 'model');
    assert.deepEqual(call.body.systemInstruction, { parts: [{ text: 'Character rules.' }] });
    assert.equal(call.body.contents[2].parts[1].inlineData.data, IMAGE.base64);
    assert.equal('store' in call.body, false);
    return json({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'Visible answer.' }] } }] });
  });
  assert.equal(await generateReply(config('gemini', { model: 'models/discovered-id', supportsVision: true }), { ...server, apiKey: KEY, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Now look' }], system: 'Character rules.', image: IMAGE }), 'Visible answer.');
});

for (const [provider, expectedUrl] of [
  ['xai', 'https://api.x.ai/v1/chat/completions'],
  ['deepseek', 'https://api.deepseek.com/chat/completions'],
  ['mistral', 'https://api.mistral.ai/v1/chat/completions'],
  ['compatible', 'https://custom.example/gateway/v1/chat/completions'],
]) {
  test(provider + ' uses the compatible protocol without cross-provider fallback', async () => {
    const server = scripted(call => {
      assert.equal(call.url.href, expectedUrl);
      assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
      assert.equal(call.body.messages[0].role, 'system');
      assert.equal(call.body.messages[1].content[1].type, 'image_url');
      assert.equal(call.body.stream, false);
      return json({ choices: [{ message: { content: [{ type: 'text', text: 'Compatible reply.' }] } }] });
    });
    const connection = config(provider, { supportsVision: true, ...(provider === 'compatible' ? { baseUrl: 'https://custom.example/gateway/v1' } : {}) });
    assert.equal(await generateReply(connection, { ...server, apiKey: KEY, messages: USER, system: 'Rules.', image: IMAGE }), 'Compatible reply.');
    assert.equal(server.calls.length, 1);
  });
}

test('hosted model discovery preserves actual IDs and does not infer vision from a name', async () => {
  const server = scripted({ data: [
    { id: 'some-vision-sounding-id', owned_by: 'provider' },
    { id: 'documented-image-id', input_modalities: ['text', 'image'], name: 'Image model' },
    { id: 'documented-text-id', capabilities: { vision: false } },
  ] });
  assert.deepEqual(await listModels(config('deepseek'), { ...server, apiKey: KEY }), [
    { id: 'some-vision-sounding-id', name: 'some-vision-sounding-id', supportsVision: null, remote: true },
    { id: 'documented-image-id', name: 'Image model', supportsVision: true, remote: true },
    { id: 'documented-text-id', name: 'documented-text-id', supportsVision: false, remote: true },
  ]);
  assert.equal(server.calls[0].url.pathname, '/models');
});

test('Claude discovery handles current pagination and capability metadata', async () => {
  const server = scripted(
    { data: [{ id: 'first', display_name: 'First', capabilities: { vision: { supported: true } } }], next_page: 'next cursor' },
    call => {
      assert.equal(call.url.searchParams.get('page'), 'next cursor');
      return json({ data: [{ id: 'second' }], next_page: null });
    },
  );
  const models = await listModels(config('anthropic'), { ...server, apiKey: KEY });
  assert.deepEqual(models.map(x => x.id), ['first', 'second']);
  assert.equal(models[0].supportsVision, true);
  assert.equal(models[1].supportsVision, null);
});

test('Gemini discovery paginates and excludes non-generation models', async () => {
  const server = scripted(
    { models: [{ name: 'models/chat-one', displayName: 'Chat', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page two' },
    call => {
      assert.equal(call.url.searchParams.get('pageToken'), 'page two');
      return json({ models: [{ name: 'models/chat-two', supportedGenerationMethods: ['generateContent'] }] });
    },
  );
  assert.deepEqual((await listModels(config('gemini'), { ...server, apiKey: KEY })).map(x => x.id), ['models/chat-one', 'models/chat-two']);
});

test('Ollama local-only discovery omits cloud and unverified entries', async () => {
  const server = scripted(
    { models: [localTag(), localTag({ model: 'remote:cloud', name: 'remote:cloud', remote_host: 'https://cloud.example' }), localTag({ model: 'unverified', name: 'unverified', size: 0 })] },
    localInfo(),
    localInfo(),
  );
  assert.deepEqual(await listModels(config('ollama'), { ...server, localOnly: true }), [{ id: 'local-model:exact', name: 'local-model:exact', supportsVision: true, remote: false }]);
  assert.equal(server.calls.length, 3);
  assert(server.calls.every(call => call.url.hostname === 'localhost'));
});

test('Ollama native chat verifies local metadata before sending a conversation or image', async () => {
  const server = scripted(
    { models: [localTag()] },
    call => { assert.equal(call.url.pathname, '/api/show'); assert.deepEqual(call.body, { model: 'local-model:exact' }); return json(localInfo()); },
    { models: [localTag()] },
    call => {
      assert.equal(call.url.pathname, '/api/chat');
      assert.equal(call.body.model, 'local-model:exact');
      assert.equal(call.body.stream, false);
      assert.equal(call.body.messages[0].role, 'system');
      assert.deepEqual(call.body.messages[1].images, [IMAGE.base64]);
      assert.equal(call.init.headers.Authorization, undefined);
      return json({ message: { role: 'assistant', content: 'Local reply.', thinking: 'hidden' } });
    },
  );
  assert.equal(await generateReply(config('ollama', { model: 'local-model:exact', supportsVision: true }), { ...server, messages: USER, system: 'Rules.', image: IMAGE, localOnly: true }), 'Local reply.');
  assert.deepEqual(USER, [{ role: 'user', content: 'Hello.' }]);
});

for (const [label, tag, info, code] of [
  ['cloud tag', localTag({ remote_model: 'remote-model' }), localInfo(), 'REMOTE_MODEL'],
  ['cloud tag suffix', localTag({ model: 'remote:cloud', name: 'local-model:exact' }), localInfo(), 'REMOTE_MODEL'],
  ['cloud show metadata', localTag(), localInfo({ remote_host: 'https://remote.example' }), 'LOCAL_MODEL_UNVERIFIED'],
  ['missing digest', localTag({ digest: '' }), localInfo(), 'LOCAL_MODEL_UNVERIFIED'],
  ['missing weights', localTag({ size: 0 }), localInfo(), 'LOCAL_MODEL_UNVERIFIED'],
  ['missing show capabilities', localTag(), { model_info: {} }, 'LOCAL_MODEL_UNVERIFIED'],
  ['missing show model info', localTag(), { capabilities: ['completion'] }, 'LOCAL_MODEL_UNVERIFIED'],
]) {
  test('local-only Ollama rejects ' + label + ' before inference', async () => {
    const server = scripted({ models: [tag] }, info);
    await rejectsCode(generateReply(config('ollama', { model: 'local-model:exact' }), { ...server, messages: USER, localOnly: true }), code);
    assert(server.calls.every(call => !['/api/chat', '/api/generate'].includes(call.url.pathname)));
  });
}

test('local-only Ollama fails closed when discovery is unavailable or model does not exactly match', async () => {
  const unavailable = scripted(() => json({ error: KEY }, 503));
  await rejectsCode(generateReply(config('ollama', { model: 'local-model:exact' }), { ...unavailable, messages: USER, localOnly: true }), 'PROVIDER_HTTP');
  assert.equal(unavailable.calls.length, 1);
  const mismatch = scripted({ models: [localTag()] });
  await rejectsCode(generateReply(config('ollama', { model: 'local-model' }), { ...mismatch, messages: USER, localOnly: true }), 'MODEL_NOT_INSTALLED');
  assert.equal(mismatch.calls.length, 1);
});

test('Ollama verifies vision capability even if the user checked image support', async () => {
  const server = scripted({ models: [localTag()] }, localInfo({ capabilities: ['completion'] }));
  await rejectsCode(generateReply(config('ollama', { model: 'local-model:exact', supportsVision: true }), { ...server, messages: USER, image: IMAGE }), 'VISION_UNSUPPORTED');
  assert.equal(server.calls.length, 2);
});

test('LM Studio richer discovery preserves model keys and filters embeddings', async () => {
  const server = scripted(call => {
    assert.equal(call.url.href, 'http://localhost:1234/api/v1/models');
    assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
    return json({ models: [lmModel(), { type: 'embedding', key: 'embedding-model' }] });
  });
  assert.deepEqual(await listModels(config('lmstudio'), { ...server, apiKey: KEY, localOnly: true }), [{ id: 'publisher/model-exact', name: 'Local model', supportsVision: true, remote: false }]);
});

test('LM Studio local-only image chat checks selected local model then uses compatible format', async () => {
  const server = scripted({ models: [lmModel({ loaded_instances: [{ id: 'publisher/model-exact' }] })] }, call => {
    assert.equal(call.url.href, 'http://localhost:1234/v1/chat/completions');
    assert.equal(call.body.model, 'publisher/model-exact');
    assert.equal(call.body.messages[0].content[1].image_url.url, 'data:image/png;base64,' + IMAGE.base64);
    return json({ choices: [{ message: { content: 'Local vision.' } }] });
  });
  assert.equal(await generateReply(config('lmstudio', { model: 'publisher/model-exact', supportsVision: true }), { ...server, messages: USER, image: IMAGE, localOnly: true }), 'Local vision.');
});

test('cold Ollama requests load without prompts or setting overrides before generating the reply', async () => {
  const progress = [];
  const connection = config('ollama', { model: 'local-model:exact', supportsVision: true });
  const original = structuredClone(connection);
  const server = scripted(
    { models: [localTag()] }, localInfo(),
    call => { assert.equal(call.url.pathname, '/api/ps'); return json({ models: [] }); },
    call => {
      assert.equal(call.url.pathname, '/api/generate');
      assert.deepEqual(call.body, { model: 'local-model:exact', prompt: '', stream: false });
      assert.equal(progress.at(-1).phase, 'loading');
      return json({ model: 'local-model:exact', response: '', done: true, done_reason: 'load' });
    },
    call => {
      assert.equal(call.url.pathname, '/api/chat');
      assert.equal(progress.at(-1).phase, 'generating');
      assert.equal(call.body.messages[0].content, 'Rules.');
      assert.deepEqual(call.body.messages[1].images, [IMAGE.base64]);
      return json({ message: { content: 'Ready.' } });
    },
  );
  assert.equal(await generateReply(connection, { ...server, messages: USER, system: 'Rules.', image: IMAGE,
    localOnly: true, onProgress: value => progress.push(value) }), 'Ready.');
  assert.deepEqual(progress.map(value => value.phase), ['checking', 'loading', 'generating']);
  assert(progress.every(value => value.progress === null && typeof value.text === 'string' && value.text.length > 0));
  assert.deepEqual(connection, original);
});

test('Ollama checks server residency each time, skips warm-up while loaded, and reloads after eviction', async () => {
  const progress = [];
  const server = scripted(
    { models: [localTag()] }, localInfo(), { models: [localTag()] }, { message: { content: 'Warm.' } },
    { models: [localTag()] }, localInfo(), { models: [localTag()] }, { message: { content: 'Still warm.' } },
    { models: [localTag()] }, localInfo(), { models: [] },
    { model: 'local-model:exact', response: '', done: true }, { message: { content: 'Loaded again.' } },
  );
  for (const expected of ['Warm.', 'Still warm.', 'Loaded again.']) {
    assert.equal(await generateReply(config('ollama', { model: 'local-model:exact' }), {
      ...server, messages: USER, localOnly: true, onProgress: value => progress.push(value),
    }), expected);
  }
  assert.equal(server.calls.filter(call => call.url.pathname === '/api/generate').length, 1);
  assert.equal(progress.filter(value => value.phase === 'loading').length, 1);
  assert(server.calls.every(call => !call.url.pathname.includes('pull')));
});

test('a running Ollama entry with a stale digest is not treated as the selected loaded model', async () => {
  const server = scripted(
    { models: [localTag()] }, localInfo(), { models: [localTag({ digest: 'older-weights' })] },
    { model: 'local-model:exact', response: '', done: true }, { message: { content: 'Current weights.' } },
  );
  assert.equal(await generateReply(config('ollama', { model: 'local-model:exact' }), { ...server, messages: USER, localOnly: true }), 'Current weights.');
  assert.equal(server.calls[3].url.pathname, '/api/generate');
});

test('Ollama preserves untagged :latest profiles while checking and using the installed canonical model', async () => {
  for (const localOnly of [false, true]) {
    const connection = config('ollama', { model: 'llama3' });
    const tag = localTag({ name: 'llama3:latest', model: 'llama3:latest' });
    const server = scripted({ models: [tag] }, call => {
      assert.equal(call.url.pathname, '/api/show');
      assert.deepEqual(call.body, { model: 'llama3:latest' });
      return json(localInfo());
    }, { models: [] }, call => {
      assert.equal(call.url.pathname, '/api/generate');
      assert.equal(call.body.model, 'llama3:latest');
      return json({ model: 'llama3:latest', response: '', done: true });
    }, call => {
      assert.equal(call.url.pathname, '/api/chat');
      assert.equal(call.body.model, 'llama3:latest');
      return json({ message: { content: 'The selected latest model.' } });
    });
    assert.equal(await generateReply(connection, { ...server, messages: USER, localOnly }), 'The selected latest model.');
    assert.equal(connection.model, 'llama3', 'A request must not rewrite the saved profile');
  }
  const server = scripted({ models: [localTag({ name: 'llama3:latest', model: 'llama3:latest' })] });
  await rejectsCode(generateReply(config('ollama', { model: 'llama3:other' }), { ...server, messages: USER }), 'MODEL_NOT_INSTALLED');
  assert.equal(server.calls.length, 1);
});

test('explicit cloud-backed Ollama selection never receives a local warm-up request', async () => {
  const progress = [];
  const server = scripted(
    { models: [localTag({ remote_model: 'selected-cloud-model', remote_host: 'https://cloud.example' })] },
    localInfo(), { message: { content: 'Explicit remote reply.' } },
  );
  assert.equal(await generateReply(config('ollama', { model: 'local-model:exact' }), {
    ...server, messages: USER, onProgress: value => progress.push(value),
  }), 'Explicit remote reply.');
  assert.deepEqual(server.calls.map(call => call.url.pathname), ['/api/tags', '/api/show', '/api/chat']);
  assert.deepEqual(progress.map(value => value.phase), ['checking', 'generating']);
});

test('LM Studio cold load preserves chat history and targets the returned instance without changing settings', async () => {
  const progress = [];
  const connection = config('lmstudio', { model: 'publisher/model-exact', supportsVision: true });
  const original = structuredClone(connection);
  const history = [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'I remember.' }, { role: 'user', content: 'Look now.' }];
  const server = scripted({ models: [lmModel()] }, call => {
    assert.equal(call.url.href, 'http://localhost:1234/api/v1/models/load');
    assert.deepEqual(call.body, { model: 'publisher/model-exact' });
    assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(progress.at(-1).phase, 'loading');
    return json({ type: 'llm', instance_id: 'chosen-instance', status: 'loaded', load_time_seconds: 3.2 });
  }, call => {
    assert.equal(call.url.href, 'http://localhost:1234/v1/chat/completions');
    assert.equal(call.body.model, 'chosen-instance');
    assert.equal(call.body.stream, false);
    assert.deepEqual(call.body.messages.slice(0, 3), [{ role: 'system', content: 'Rules.' }, ...history.slice(0, 2)]);
    assert.equal(call.body.messages[3].content[1].image_url.url, 'data:image/png;base64,' + IMAGE.base64);
    assert.equal(progress.at(-1).phase, 'generating');
    return json({ choices: [{ message: { content: 'Your remembered conversation.' } }] });
  });
  assert.equal(await generateReply(connection, { ...server, apiKey: KEY, messages: history, system: 'Rules.', image: IMAGE,
    localOnly: true, onProgress: value => progress.push(value) }), 'Your remembered conversation.');
  assert.deepEqual(progress.map(value => value.phase), ['checking', 'loading', 'generating']);
  assert(progress.every(value => value.progress === null));
  assert.deepEqual(connection, original);
  assert.deepEqual(history[2], { role: 'user', content: 'Look now.' });
  assert(server.calls.every(call => !call.url.pathname.includes('download')));
});

test('LM Studio reuses the existing configured instance instead of reloading it', async () => {
  const model = lmModel({ loaded_instances: [{ id: 'my-large-context-instance', config: { context_length: 16384, flash_attention: true } }] });
  const progress = [];
  const reply = call => {
    assert.equal(call.url.pathname, '/v1/chat/completions');
    assert.equal(call.body.model, 'my-large-context-instance');
    assert.deepEqual(Object.keys(call.body).sort(), ['messages', 'model', 'stream']);
    return json({ choices: [{ message: { content: 'Warm model.' } }] });
  };
  const server = scripted({ models: [model] }, reply, { models: [model] }, reply);
  for (let turn = 0; turn < 2; turn++) {
    assert.equal(await generateReply(config('lmstudio', { model: 'publisher/model-exact' }), {
      ...server, messages: USER, localOnly: true, onProgress: value => progress.push(value),
    }), 'Warm model.');
  }
  assert.deepEqual(progress.map(value => value.phase), ['checking', 'generating', 'checking', 'generating']);
  assert.equal(server.calls.filter(call => call.url.pathname.endsWith('/load')).length, 0);
});

test('LM Studio accepts a manually selected loaded-instance ID and preserves that exact instance', async () => {
  for (const localOnly of [false, true]) {
    const model = lmModel({ loaded_instances: [
      { id: 'another-instance', config: { context_length: 4096 } },
      { id: 'my-manual-instance', config: { context_length: 16384 } },
    ] });
    const server = scripted({ models: [model] }, call => {
      assert.equal(call.url.pathname, '/v1/chat/completions');
      assert.equal(call.body.model, 'my-manual-instance');
      assert.deepEqual(Object.keys(call.body).sort(), ['messages', 'model', 'stream']);
      return json({ choices: [{ message: { content: 'The requested instance.' } }] });
    });
    const connection = config('lmstudio', { model: 'my-manual-instance' });
    assert.equal(await generateReply(connection, { ...server, messages: USER, localOnly }), 'The requested instance.');
    assert.equal(connection.model, 'my-manual-instance');
    assert.equal(server.calls.length, 2, 'An already loaded instance must not be loaded again');
  }
});

test('malformed local load confirmations fail before any conversation is dispatched', async () => {
  for (const loaded of [{ done: false }, { model: 'local-model:exact', response: '', done: true, done_reason: 'unload' },
    { model: 'different-model', response: '', done: true }, { model: 'local-model:exact', response: KEY, done: true }]) {
    const server = scripted({ models: [localTag()] }, localInfo(), { models: [] }, loaded);
    await rejectsCode(generateReply(config('ollama', { model: 'local-model:exact' }), { ...server, messages: USER, localOnly: true }), 'INVALID_RESPONSE');
    assert.equal(server.calls.length, 4);
  }
  for (const loaded of [{ status: 'loading', type: 'llm', instance_id: 'instance' },
    { status: 'loaded', type: 'embedding', instance_id: 'instance' }, { status: 'loaded', type: 'llm', instance_id: '' }]) {
    const server = scripted({ models: [lmModel()] }, loaded);
    await rejectsCode(generateReply(config('lmstudio', { model: 'publisher/model-exact' }), { ...server, messages: USER, localOnly: true }), 'INVALID_RESPONSE');
    assert.equal(server.calls.length, 2);
  }
});

for (const provider of ['ollama', 'lmstudio']) {
  test(provider + ' cancellation during a cold load prevents generation and further progress', async () => {
    const controller = new AbortController();
    const progress = [];
    const pendingLoad = call => new Promise((_resolve, reject) => {
      call.init.signal.addEventListener('abort', () => reject(new Error(KEY + IMAGE.base64)), { once: true });
      controller.abort();
    });
    const server = provider === 'ollama'
      ? scripted({ models: [localTag()] }, localInfo(), { models: [] }, pendingLoad)
      : scripted({ models: [lmModel()] }, pendingLoad);
    const model = provider === 'ollama' ? 'local-model:exact' : 'publisher/model-exact';
    await rejectsCode(generateReply(config(provider, { model }), { ...server, messages: USER, localOnly: true,
      signal: controller.signal, onProgress: value => progress.push(value) }), 'ABORTED');
    assert.deepEqual(progress.map(value => value.phase), ['checking', 'loading']);
    assert.equal(server.calls.length, provider === 'ollama' ? 4 : 2);
  });

  test(provider + ' cold-load timeout is bounded, redacted, and never dispatches chat', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const progress = [];
    const pendingLoad = call => new Promise((_resolve, reject) => {
      call.init.signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true });
      t.mock.timers.tick(5 * 60 * 1000);
    });
    const server = provider === 'ollama'
      ? scripted({ models: [localTag()] }, localInfo(), { models: [] }, pendingLoad)
      : scripted({ models: [lmModel()] }, pendingLoad);
    const model = provider === 'ollama' ? 'local-model:exact' : 'publisher/model-exact';
    await assert.rejects(generateReply(config(provider, { model }), { ...server, messages: USER, localOnly: true,
      onProgress: value => progress.push(value) }), error => error.code === 'MODEL_LOAD_TIMEOUT' && !String(error).includes(KEY));
    assert.deepEqual(progress.map(value => value.phase), ['checking', 'loading']);
    assert.equal(server.calls.length, provider === 'ollama' ? 4 : 2);
  });
}

test('a failed loading-status callback cannot fail inference or turn into a provider error', async () => {
  const server = scripted({ models: [localTag()] }, localInfo(), { models: [localTag()] }, { message: { content: 'Still works.' } });
  assert.equal(await generateReply(config('ollama', { model: 'local-model:exact' }), {
    ...server, messages: USER, localOnly: true, onProgress() { throw new Error('Display unavailable'); },
  }), 'Still works.');
});

test('cancellation from a loading callback prevents even the warm-up request', async () => {
  const controller = new AbortController();
  const server = scripted({ models: [localTag()] }, localInfo(), { models: [] });
  await rejectsCode(generateReply(config('ollama', { model: 'local-model:exact' }), {
    ...server, messages: USER, signal: controller.signal, localOnly: true,
    onProgress(value) { if (value.phase === 'loading') controller.abort(); },
  }), 'ABORTED');
  assert.equal(server.calls.length, 3);
});

test('LM Studio local-only cannot use unknown, remote, or unverified model entries', async () => {
  for (const models of [[], [lmModel({ remote: true })], [lmModel({ size_bytes: 0 })]]) {
    const server = scripted({ models });
    await assert.rejects(generateReply(config('lmstudio', { model: 'publisher/model-exact' }), { ...server, messages: USER, localOnly: true }), error => ['MODEL_NOT_INSTALLED', 'LOCAL_MODEL_UNVERIFIED'].includes(error.code));
    assert.equal(server.calls.length, 1);
  }
});

test('LM Studio vision and model-discovery failures never fall back to another endpoint', async () => {
  const textOnly = scripted({ models: [lmModel({ capabilities: { vision: false } })] });
  await rejectsCode(generateReply(config('lmstudio', { model: 'publisher/model-exact', supportsVision: true }), { ...textOnly, messages: USER, image: IMAGE }), 'VISION_UNSUPPORTED');
  const oldServer = scripted(() => json({ error: 'unsupported' }, 404));
  await rejectsCode(listModels(config('lmstudio'), oldServer), 'NOT_FOUND');
  assert.equal(oldServer.calls.length, 1);
});

test('provider error bodies and network errors never expose keys or screenshots', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    const server = scripted(() => json({ error: { message: KEY + IMAGE.base64 } }, status));
    await assert.rejects(generateReply(config('openai'), { ...server, apiKey: KEY, messages: USER }), error => {
      assert(!String(error).includes(KEY));
      assert(!String(error).includes(IMAGE.base64));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(server.calls.length, 1);
  }
  const network = scripted(() => { throw new Error(KEY + IMAGE.base64); });
  await assert.rejects(generateReply(config('openai'), { ...network, apiKey: KEY, messages: USER }), error => error.code === 'CONNECTION_FAILED' && !String(error).includes(KEY));
});

test('redirect responses and followed redirects are refused', async () => {
  const redirect = scripted(() => new Response('secret provider body', { status: 302, headers: { location: 'https://other.example' } }));
  await rejectsCode(listModels(config('openai'), { ...redirect, apiKey: KEY }), 'REDIRECT_BLOCKED');
  const followed = scripted(() => ({ redirected: true, status: 200, ok: true }));
  await rejectsCode(listModels(config('openai'), { ...followed, apiKey: KEY }), 'REDIRECT_BLOCKED');
});

test('malformed response bodies remain redacted', async () => {
  const server = scripted(() => new Response('<html>' + KEY + IMAGE.base64 + '</html>', { status: 200 }));
  await assert.rejects(listModels(config('openai'), { ...server, apiKey: KEY }), error => error.code === 'INVALID_RESPONSE' && !String(error).includes(KEY));
});

test('abort is checked before requests and during a pending request', async () => {
  const already = new AbortController(); already.abort(KEY);
  const none = scripted();
  await rejectsCode(generateReply(config('ollama'), { ...none, signal: already.signal, messages: USER }), 'ABORTED');
  assert.equal(none.calls.length, 0);
  const controller = new AbortController();
  const server = scripted(call => new Promise((resolve, reject) => {
    call.init.signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true });
    controller.abort(KEY);
  }));
  await rejectsCode(generateReply(config('openai'), { ...server, signal: controller.signal, apiKey: KEY, messages: USER }), 'ABORTED');
});

test('invalid roles/images are rejected before network access and tool-only output is not executed', async () => {
  const server = scripted();
  await rejectsCode(generateReply(config('openai'), { ...server, apiKey: KEY, messages: [{ role: 'tool', content: 'execute' }] }), 'INVALID_MESSAGES');
  for (const image of [{ mimeType: 'image/jpeg', base64: IMAGE.base64 }, { mimeType: 'image/png', base64: 'invalid%%' }]) {
    await rejectsCode(generateReply(config('openai', { supportsVision: true }), { ...server, apiKey: KEY, messages: USER, image }), 'INVALID_IMAGE');
  }
  assert.equal(server.calls.length, 0);
  const tool = scripted({ output: [{ type: 'function_call', name: 'run_shell', arguments: '{}' }] });
  await rejectsCode(generateReply(config('openai'), { ...tool, apiKey: KEY, messages: USER }), 'EMPTY_REPLY');
  assert.equal(tool.calls.length, 1);
});

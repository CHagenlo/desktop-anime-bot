const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

// Windows packaging checks use synthetic audio and loopback protocol fixtures.
// They never contact a real AI service or open a person's microphone.
async function verifyFeatures({ app, settingsWindow, service, credentialCodec, poll, directory }) {
  const [{ validateWavAudio }, { ConversationStore }, { CompanionApplication }, storage, providers] = await Promise.all([
    import('./audio/transcription.mjs'), import('./core/memory.mjs'), import('./core/application.mjs'),
    import('./core/storage.mjs'), import('./providers/index.mjs')
  ]);
  let releaseLoad;
  const loadGate = new Promise(resolve => { releaseLoad = resolve; });
  let chatRequests = 0, audioRequests = 0, audioBytes = 0, modelLoaded = false;
  const model = 'packaging-test-model';
  const reply = 'This is a Windows feature check reply.';
  const transcript = 'Microphone check: this is an editable draft.';
  const server = http.createServer(async (request, response) => {
    const send = (data, status = 200) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    };
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 3 * 1024 * 1024) throw new Error(); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      if (request.url === '/api/tags') send({ models: [{ name: model, model, digest: 'packaging-fixture', size: 1024 }] });
      else if (request.url === '/api/show') send({ model_info: { architecture: 'fixture' }, capabilities: ['completion'] });
      else if (request.url === '/api/ps') send({ models: modelLoaded ? [{ name: model, model, digest: 'packaging-fixture' }] : [] });
      else if (request.url === '/api/generate') {
        await loadGate; modelLoaded = true; send({ model, done: true, done_reason: 'load', response: '' });
      } else if (request.url === '/api/chat') {
        const parsed = JSON.parse(body.toString());
        if (parsed.model !== model || !Array.isArray(parsed.messages)) throw new Error();
        chatRequests += 1; send({ done: true, message: { role: 'assistant', content: reply } });
      } else if (request.url === '/inference') {
        const offset = body.indexOf(Buffer.from('RIFF'));
        if (offset < 0 || offset + 8 > body.length) throw new Error();
        const end = offset + body.readUInt32LE(offset + 4) + 8;
        const audio = validateWavAudio(body.subarray(offset, end));
        audioBytes = audio.length; audioRequests += 1; audio.fill(0);
        send({ text: transcript });
      } else send({ error: 'Unknown fixture route' }, 404);
    } catch { send({ error: 'Invalid fixture request' }, 400); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const evaluate = expression => settingsWindow.webContents.executeJavaScript(expression);
  const paint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const screenshot = async name => {
    await paint();
    await fs.writeFile(path.join(directory, name + '.png'), (await settingsWindow.webContents.capturePage()).toPNG());
  };
  const checkComposer = () => poll(settingsWindow, `(() => ({ controls: ['chat-input', 'microphone-toggle', 'send-message'].map(id => {
    const element = document.getElementById(id), box = element.getBoundingClientRect();
    return { id, visible: element.checkVisibility() && box.width > 0 && box.height > 0 &&
      box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
      top: box.top, bottom: box.bottom, viewportHeight: innerHeight };
  }) }))()`, value => value.controls.every(control => control.visible));
  const reloadCore = async () => {
    const profile = app.getPath('userData');
    const restored = new CompanionApplication({ settings: new storage.SettingsStore(profile),
      secrets: new storage.SecretStore(profile, credentialCodec), memory: new ConversationStore(profile, credentialCodec),
      native: { cancelPending() {}, dispose() {} }, providers, platform: process.platform });
    await restored.initialize();
    return restored;
  };
  try {
    const initial = await evaluate('window.companion.getState()');
    if (!initial.config.memory.enabled || initial.config.speech.enabled || !initial.status.memoryAvailable || initial.speechProviders?.length !== 3) {
      throw new Error('Voice or protected-memory defaults did not initialize.');
    }
    await checkComposer();
    const denied = await evaluate(`(async () => {
      try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(track => track.stop()); return false; }
      catch (error) { return error.name === 'NotAllowedError'; }
    })()`);
    if (!denied) throw new Error('The microphone was not denied before an explicit recording grant.');

    await evaluate(`window.companion.saveConnection(${JSON.stringify({ name: 'Packaging feature check', provider: 'ollama', baseUrl, model })})`);
    await evaluate('window.companion.savePreferences({privacy:{paused:false,localOnly:true}})');
    await evaluate(`document.getElementById('chat-input').value='Check persistent Windows conversation memory.';
      document.getElementById('chat-form').requestSubmit();`);
    await poll(settingsWindow, `(() => ({ visible: !document.getElementById('model-activity').hidden,
      phase: document.getElementById('model-activity').dataset.phase,
      indeterminate: !document.getElementById('model-activity-progress').hasAttribute('value') }))()`,
    value => value.visible && value.phase === 'loading' && value.indeterminate);
    await checkComposer();
    await screenshot('loading');
    releaseLoad();
    await poll(settingsWindow, `(() => ({ reply: document.getElementById('chat-messages').textContent.includes(${JSON.stringify(reply)}),
      idle: document.getElementById('model-activity').hidden, ready: !document.getElementById('send-message').disabled }))()`,
    value => value.reply && value.idle && value.ready);
    const raw = await fs.readFile(path.join(app.getPath('userData'), 'conversations.enc.json'), 'utf8');
    if (raw.includes(reply) || !JSON.parse(raw).encrypted) throw new Error('The saved conversation was not encrypted.');
    const restored = await reloadCore();
    const remembered = restored.getState(); restored.dispose();
    if (remembered.messages.length !== 2 || remembered.messages[1].content !== reply || !remembered.config.privacy.paused) {
      throw new Error('A fresh application core did not recover the saved conversation and paused state.');
    }
    await evaluate(`document.getElementById('clear-chat').click()`);
    await poll(settingsWindow, `window.companion.getState()`, value => value.messages?.length === 0);
    const cleared = await reloadCore();
    if (cleared.getState().messages.length) throw new Error('Clear chat did not erase saved memory.');
    cleared.dispose();

    await evaluate(`window.companion.saveSpeech(${JSON.stringify({ enabled: true, provider: 'whispercpp', baseUrl, model: '', language: '' })})`);
    await evaluate(`(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await original(...args); window.__smokeTracks = stream.getTracks(); return stream;
      };
      document.getElementById('chat-input').value = '';
      document.getElementById('microphone-toggle').click();
    })()`);
    await poll(settingsWindow, `({ phase: document.getElementById('microphone-toggle').dataset.phase })`, value => value.phase === 'recording');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await checkComposer();
    await screenshot('recording');
    await evaluate(`document.getElementById('microphone-toggle').click()`);
    await poll(settingsWindow, `({ phase: document.getElementById('microphone-toggle').dataset.phase,
      draft: document.getElementById('chat-input').value,
      tracksEnded: window.__smokeTracks?.every(track => track.readyState === 'ended'),
      error: document.getElementById('app-status').dataset.tone === 'error' ? document.getElementById('app-status').textContent : '' })`,
    value => value.phase === 'idle' && value.draft === transcript && value.tracksEnded);
    if (chatRequests !== 1 || audioRequests !== 1 || audioBytes < 1000 || service.getState().messages.length) {
      throw new Error('The microphone did not produce one WAV transcription into an unsent draft.');
    }
    await checkComposer();
    await evaluate(`document.querySelector('[data-tab="voice"]').click()`);
    await poll(settingsWindow, `({ visible: !document.getElementById('panel-voice').hidden,
      selected: document.querySelector('[data-tab="voice"]').getAttribute('aria-current') })`, value => value.visible && value.selected === 'page');
    await screenshot('voice');
    return { encryptedMemoryRoundTrip: true, clearChatErasesSavedMemory: true, localModelLoadingIndicator: true,
      microphoneDeniedWithoutGrant: true, microphoneSyntheticCapture: true, microphoneTracksReleased: true,
      transcriptionWavTransport: true, transcriptIsUnsentDraft: true, chatControlsVisible: true, voiceSettingsVisible: true,
      speechAndModelResponses: 'loopback fixtures; live models and physical microphone not tested' };
  } finally {
    releaseLoad();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { verifyFeatures };

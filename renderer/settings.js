import { MicrophoneRecorder } from './microphone.mjs';

(() => {
  const api = window.companion;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let editingId = '';
  let windows = [];
  let chatMessages = [];
  let chatBusy = false;
  let chatEpoch = 0;
  let pendingMessage = null;
  let pendingBody = null;
  let characterDirty = false;
  let discoveryEpoch = 0;
  let visionBusy = false;
  let actionBusy = false;
  let activeTab = 'chat';
  let speechDirty = false;
  let speechBusy = false;
  let memoryBusy = false;
  let microphone = null;
  let microphoneState = { phase: 'idle', seconds: 0, text: '' };
  let modelActivity = null;
  let modelActivityStarted = 0;
  let modelActivityTimer = null;
  const pageCopy = {
    chat: ["Let's talk.", 'Your character, your choice of AI, your desktop.'],
    connections: ['Choose her mind.', 'Use your own API keys or a model running on your computer.'],
    voice: ['A voice. A little memory.', 'Choose where audio goes and what your companion remembers.'],
    privacy: ['Your desktop. Your rules.', 'Three abilities, independent switches, and clear boundaries.'],
    character: ['Meet your companion.', 'Give her a look, a name, and a way of being.']
  };

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function errorText(error) {
    return String(error && error.message ? error.message : error || 'Something went wrong.')
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 1400);
  }

  function notify(text, tone = 'info') {
    $('app-status').textContent = text;
    $('app-status').dataset.tone = tone;
    $('app-status').hidden = !text;
  }

  async function run(button, operation) {
    if (button) button.disabled = true;
    try { return await operation(); }
    catch (error) { notify(errorText(error), 'error'); return null; }
    finally {
      if (button) button.disabled = false;
      if (state) updateAvailability();
    }
  }

  function switchTab(tab) {
    if (!pageCopy[tab]) return;
    activeTab = tab;
    document.querySelectorAll('.tab-panel').forEach((panel) => { panel.hidden = panel.id !== 'panel-' + tab; });
    document.querySelectorAll('[data-tab]').forEach((button) => {
      const selected = button.dataset.tab === tab;
      button.classList.toggle('active', selected);
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    $('page-title').textContent = pageCopy[tab][0];
    $('page-subtitle').textContent = pageCopy[tab][1];
    $('microphone-open-chat').hidden = tab === 'chat';
    document.querySelector('.main').scrollTop = 0;
  }

  function currentConnection() {
    return state && state.config.connections.find((connection) => connection.id === state.config.activeConnectionId);
  }

  function providerFor(id) {
    return state && state.providers.find((provider) => provider.id === id);
  }

  function isLoopback(baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname;
      return ['localhost', '[::1]', '::1'].includes(hostname) || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(hostname);
    }
    catch { return false; }
  }

  function blockedByLocalMode(connection) {
    return Boolean(connection && state.config.privacy.localOnly && (providerFor(connection.provider)?.kind !== 'local' || !isLoopback(connection.baseUrl)));
  }

  function speechProviderFor(id) {
    return state?.speechProviders?.find(provider => provider.id === id);
  }

  function microphoneActive() { return microphoneState.phase !== 'idle'; }

  function speechBlockedByLocalMode(speech) {
    return Boolean(state?.config.privacy.localOnly && (speech.provider !== 'whispercpp' || !isLoopback(speech.baseUrl)));
  }

  function microphoneBlockReason() {
    const speech = state?.config.speech;
    if (!speech) return 'Loading microphone settings…';
    if (!speech.enabled) return 'Microphone input is off. Enable it in Voice & memory.';
    if (state.config.privacy.paused) return 'The companion is paused. Resume to record.';
    if (speechBlockedByLocalMode(speech)) return 'Local-only mode permits a whisper.cpp server on this computer.';
    if (!speech.baseUrl) return 'Save a transcription endpoint in Voice & memory.';
    if (speechProviderFor(speech.provider)?.keyRequired && !speech.hasKey) return 'Add a transcription API key in Voice & memory.';
    if (speech.provider !== 'whispercpp' && !speech.model) return 'Choose a transcription model in Voice & memory.';
    if (speechBusy) return 'Wait for voice settings to finish saving.';
    if (chatBusy || visionBusy || modelActivity) return 'Wait for the AI reply, or stop it before recording.';
    return '';
  }

  function duration(seconds) {
    const elapsed = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
  }

  function renderMicrophone(next = microphoneState) {
    microphoneState = next;
    const active = microphoneActive();
    const phase = next.phase;
    $('microphone-toggle').dataset.phase = phase;
    $('microphone-toggle').textContent = ({ idle: 'Record message', requesting: 'Opening microphone…', recording: 'Stop & transcribe', transcribing: 'Transcribing…' })[phase] || 'Record message';
    $('microphone-toggle').setAttribute('aria-pressed', String(phase === 'recording'));
    $('microphone-session').hidden = !active;
    $('microphone-session').dataset.phase = phase;
    $('microphone-status').textContent = next.text || (phase === 'idle' ? 'Microphone idle' : 'Microphone active');
    $('microphone-timer').textContent = duration(next.seconds);
    $('microphone-timer').hidden = phase === 'requesting';
    $('microphone-cancel').textContent = phase === 'transcribing' ? 'Cancel' : 'Discard';
    $('microphone-open-chat').hidden = activeTab === 'chat';
    if (state) updateAvailability();
  }

  function appendTranscript(transcript) {
    const text = typeof transcript === 'string' ? transcript.trim() : String(transcript?.text || '').trim();
    if (!text) { notify('No speech was recognized. Try another recording.'); return; }
    const input = $('chat-input');
    const separator = input.value && !/\s$/.test(input.value) ? '\n' : '';
    const combined = input.value + separator + text;
    const limit = input.maxLength > 0 ? input.maxLength : 12000;
    input.value = combined.slice(0, limit);
    switchTab('chat');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    notify(combined.length > limit
      ? 'Transcript added to the draft. Extra text was omitted because the message reached its 12,000-character limit.'
      : 'Transcript added to your draft. Review it, edit it, then press Send when ready.', combined.length > limit ? 'info' : 'success');
    // Setting the editable draft never submits the form or invokes sendMessage.
  }

  function updateActivityElapsed() {
    $('model-activity-elapsed').textContent = duration((Date.now() - modelActivityStarted) / 1000) + ' elapsed';
  }

  function clearModelActivity() {
    modelActivity = null;
    clearInterval(modelActivityTimer); modelActivityTimer = null;
    $('model-activity').hidden = true;
    $('model-activity').dataset.phase = 'idle';
    $('model-activity-progress').removeAttribute('value');
    $('model-activity-percent').hidden = true;
  }

  function showModelActivity(event) {
    if (event.active !== true) {
      if (!event.requestId || !modelActivity?.requestId || event.requestId === modelActivity.requestId) clearModelActivity();
      if (state) updateAvailability();
      return;
    }
    if (!modelActivity || (event.requestId && event.requestId !== modelActivity.requestId)) {
      modelActivityStarted = Date.now();
      clearInterval(modelActivityTimer);
      modelActivityTimer = setInterval(updateActivityElapsed, 1000);
    }
    const phase = ['checking', 'loading', 'generating'].includes(event.phase) ? event.phase : 'generating';
    modelActivity = { requestId: event.requestId, phase };
    $('model-activity').hidden = false;
    $('model-activity').dataset.phase = phase;
    $('model-activity-label').textContent = ({ checking: 'Checking model', loading: 'Loading model', generating: 'Generating a reply' })[phase];
    $('model-activity-text').textContent = typeof event.text === 'string' ? event.text.slice(0, 480) : 'Waiting for the selected AI connection…';
    const progress = event.progress;
    const determinate = typeof progress === 'number' && Number.isFinite(progress) && progress >= 0 && progress <= 1;
    if (determinate) $('model-activity-progress').value = progress;
    else $('model-activity-progress').removeAttribute('value');
    $('model-activity-percent').hidden = !determinate;
    $('model-activity-percent').textContent = determinate ? Math.round(progress * 100) + '%' : '';
    updateActivityElapsed();
    if (state) updateAvailability();
  }

  function updateSpeechHints() {
    const speech = state?.config.speech || {};
    const provider = speechProviderFor($('speech-provider').value);
    const changed = speech.provider !== $('speech-provider').value ||
      String(speech.baseUrl || '').replace(/\/+$/, '') !== $('speech-url').value.trim().replace(/\/+$/, '');
    const savedKey = speech.hasKey && !changed;
    $('speech-key-state').textContent = savedKey ? 'Key saved' : '';
    $('speech-key').placeholder = savedKey ? 'Leave blank to keep the saved key' : provider?.keyRequired ? 'Enter a transcription API key' : 'If your transcription server requires one';
    $('speech-key-hint').textContent = changed ? 'The provider or endpoint changed. Enter a new key or remove the saved transcription key; it will not be reused.' : 'The transcription key is protected on this PC and stored separately from your chat key.';
    $('speech-remove-key-row').hidden = !speech.hasKey;
    const local = $('speech-provider').value === 'whispercpp';
    $('speech-model').required = !local;
    $('speech-model').placeholder = local ? 'Uses the model loaded in your server' : 'Transcription model ID';
    $('speech-model-hint').textContent = local ? 'Start whisper.cpp with a speech model loaded before recording. This field can stay blank.' : 'Use a model supported by this transcription endpoint.';
    $('speech-endpoint-hint').textContent = local ? 'Use the root URL of your running whisper.cpp server.' : 'Your recorded audio will be sent to this transcription service.';
    $('speech-privacy-note').textContent = state?.config.privacy.localOnly && (!local || !isLoopback($('speech-url').value.trim()))
      ? 'Local-only mode blocks this audio destination. Choose whisper.cpp on this computer or change local-only mode before recording.'
      : speechDirty ? 'Save these changes to use this destination. The saved audio destination above is used until then.'
        : 'Recording starts only when you press Record in Chat. Transcripts remain editable until you choose Send.';
  }

  function renderSpeechSettings(reset = false) {
    const speech = state.config.speech || {};
    if (!$('speech-provider').options.length) {
      for (const provider of state.speechProviders || []) {
        const option = make('option', '', provider.label);
        option.value = provider.id;
        $('speech-provider').append(option);
      }
    }
    if (!speechDirty || reset) {
      $('speech-provider').value = speech.provider || 'whispercpp';
      $('speech-url').value = speech.baseUrl || speechProviderFor(speech.provider)?.baseUrl || '';
      $('speech-model').value = speech.model || '';
      $('speech-language').value = speech.language || '';
      $('speech-key').value = '';
      $('speech-remove-key').checked = false;
      speechDirty = false;
    }
    $('speech-enabled').checked = speech.enabled === true;
    $('speech-state').textContent = speech.enabled ? speechBlockedByLocalMode(speech) ? 'BLOCKED BY LOCAL MODE' : 'ENABLED' : 'OFF';
    const provider = speechProviderFor(speech.provider);
    const label = provider?.label || 'Transcription server';
    $('speech-destination').textContent = label + (speech.model ? ' · ' + speech.model : '');
    $('speech-destination-url').textContent = speech.baseUrl || 'Save an audio endpoint first.';
    $('microphone-destination').textContent = (speech.enabled ? 'Audio → ' : 'Microphone off · ') + label + (speech.baseUrl ? ' · ' + speech.baseUrl : '');
    updateSpeechHints();
  }

  function renderMemorySettings() {
    const enabled = state.config.memory?.enabled !== false;
    const available = state.status.memoryAvailable === true;
    $('memory-enabled').checked = enabled;
    $('memory-status').textContent = state.status.memoryMessage || (enabled ? 'Checking protected conversation storage…' : 'Saved conversation memory is off.');
    $('memory-status').dataset.tone = enabled && !available ? 'error' : 'info';
    $('chat-memory-hint').textContent = enabled && available ? 'This profile’s chat is saved on this PC until you clear it.' : 'Saved memory is off or unavailable. Chats stay in this session.';
  }

  function savedSpeechPayload(enabled = state.config.speech.enabled) {
    const speech = state.config.speech;
    return { enabled, provider: speech.provider, baseUrl: speech.baseUrl, model: speech.model || '', language: speech.language || '', apiKey: '', removeKey: false };
  }

  function selectedRule() {
    const target = state && state.selectedWindow;
    if (!target) return null;
    return state.config.privacy.rules.find((rule) => rule.exePath.toLowerCase() === target.exePath.toLowerCase()) || null;
  }

  function permissionReason(capability) {
    if (!state) return 'Starting…';
    if (state.config.privacy.paused) return 'Everything is paused. Resume when you are ready.';
    if (!state.status.nativeAvailable) return state.status.nativeMessage || 'Desktop controls are unavailable on this system.';
    if (!state.selectedWindow) return 'Select a window first.';
    const rule = selectedRule();
    if (rule && rule.protected) return 'This app is protected. It cannot be viewed or controlled.';
    if (!rule) return 'Add an access rule for the selected app first.';
    if (capability === 'vision') {
      if (!state.config.privacy.seeWindowContents) return 'Turn on “See window contents” to enable this request.';
      if (!rule.vision) return 'Allow Contents for this app in its access rule.';
      const connection = currentConnection();
      if (!connection) return 'Select an AI connection first.';
      if (blockedByLocalMode(connection)) return 'Local-only mode requires Ollama or LM Studio on this computer.';
      if (!connection.supportsVision) return 'Choose a profile configured for a model that accepts images.';
    } else {
      if (!state.config.privacy.manageWindows) return 'Turn on “Manage windows” to enable these buttons.';
      if (!rule.manage) return 'Allow Actions for this app in its access rule.';
    }
    return '';
  }

  function updateAvailability() {
    if (!state) return;
    const connection = currentConnection();
    const localBlocked = blockedByLocalMode(connection);
    $('send-message').disabled = chatBusy || visionBusy || Boolean(modelActivity) || microphoneActive() || !connection || !connection.model || state.config.privacy.paused || localBlocked;
    $('cancel-reply').hidden = !chatBusy;
    $('chat-input').disabled = chatBusy;
    $('clear-chat').disabled = chatBusy;
    $('refresh-windows').disabled = state.platform !== 'win32';
    $('select-window').disabled = !state.status.nativeAvailable || !$('window-list').value;
    $('add-window-rule').disabled = !state.selectedWindow;
    $('discover-models').disabled = !editingId;
    $('vision-permission').textContent = permissionReason('vision') || 'Ready. This sends one screenshot to the destination below.';
    $('describe-window').disabled = visionBusy || chatBusy || Boolean(permissionReason('vision'));
    $('action-permission').textContent = permissionReason('manage') || 'Ready. These controls act only on the selected window.';
    document.querySelectorAll('#window-action-controls button, #window-action-controls input').forEach((control) => {
      control.disabled = actionBusy || Boolean(permissionReason('manage'));
    });
    if (localBlocked) $('chat-send-note').textContent = 'Local-only mode blocks this endpoint. Select a local profile.';
    else if (state.config.privacy.paused) $('chat-send-note').textContent = 'Paused. Resume to send a message.';
    else if (connection && !connection.model) $('chat-send-note').textContent = 'Choose and save a model in AI connections first.';
    else if (microphoneActive()) $('chat-send-note').textContent = 'Finish or discard the recording before sending.';
    else $('chat-send-note').textContent = 'Text goes only to your selected connection.';
    const micReason = microphoneBlockReason();
    $('microphone-toggle').disabled = !microphone || (microphoneState.phase !== 'recording' && (microphoneActive() || Boolean(micReason)));
    $('microphone-hint').textContent = microphoneState.phase === 'recording' ? 'Stop to transcribe, or Discard to keep the audio unsent.'
      : microphoneState.phase === 'transcribing' ? 'Your transcript will be added to this draft. It will not be sent to the chat AI.'
        : microphoneState.phase === 'requesting' ? 'Waiting for microphone access…'
          : micReason || 'Stop to transcribe, then review the editable draft before sending.';
    $('speech-enabled').disabled = speechBusy || (!state.config.speech?.enabled && speechBlockedByLocalMode(state.config.speech || {}));
    document.querySelectorAll('#speech-form input, #speech-form select, #speech-form button').forEach(control => { control.disabled = speechBusy; });
    $('memory-enabled').disabled = memoryBusy;
    $('clear-all-memory').disabled = memoryBusy;
  }

  function applyState(next, options = {}) {
    if (!next || !next.config) return;
    const initial = !state;
    const previous = state;
    const previousConnection = previous?.config.connections.find((item) => item.id === previous.config.activeConnectionId);
    const nextConnection = next.config.connections.find((item) => item.id === next.config.activeConnectionId);
    const connectionIdentity = (connection) => connection && [connection.id, connection.provider, connection.baseUrl, connection.model, connection.workspaceId];
    const providerChanged = previous && JSON.stringify(connectionIdentity(previousConnection)) !== JSON.stringify(connectionIdentity(nextConnection));
    const privacyChanged = previous && JSON.stringify(previous.config.privacy) !== JSON.stringify(next.config.privacy);
    const targetChanged = previous && previous.selectedWindow?.handle !== next.selectedWindow?.handle;
    const speechChanged = previous && JSON.stringify(previous.config.speech) !== JSON.stringify(next.config.speech);
    const memoryChanged = previous && previous.config.memory?.enabled !== next.config.memory?.enabled;
    state = next;
    if (initial) {
      state.providers.forEach((provider) => {
        const option = make('option', '', provider.label);
        option.value = provider.id;
        $('connection-provider').append(option);
      });
    }
    if (initial || providerChanged || memoryChanged || options.replaceChat) {
      chatEpoch += 1;
      chatBusy = false;
      pendingMessage = null;
      pendingBody = null;
      chatMessages = Array.isArray(next.messages) ? next.messages.map((message) => ({role: message.role, content: message.content || message.text || ''})) : [];
      renderChat();
    }
    if (providerChanged || privacyChanged || targetChanged) {
      $('vision-result').textContent = '';
      $('vision-result').hidden = true;
    }
    if (providerChanged || privacyChanged || targetChanged || memoryChanged || options.replaceChat) clearModelActivity();
    if ((providerChanged || privacyChanged || speechChanged) && microphone?.active) void microphone.cancel();
    const privacy = state.config.privacy;
    const character = state.config.character;
    const connection = currentConnection();
    $('sidebar-name').textContent = character.name || 'Companion';
    $('sidebar-mode').textContent = privacy.paused ? 'All activity paused' : privacy.mode === 'work' ? 'Work mode · a little quiet' : privacy.mode === 'play' ? 'Play mode · your rules apply' : 'Custom boundaries';
    $('pause-all').textContent = privacy.paused ? 'Resume companion' : 'Pause everything';
    $('local-summary').textContent = privacy.localOnly ? 'Local AI only' : 'Your selected AI';
    $('local-dot').classList.toggle('inactive', !connection);
    $('local-only').checked = privacy.localOnly;
    $('react-to-windows').checked = privacy.reactToWindows;
    $('see-window-contents').checked = privacy.seeWindowContents;
    $('manage-windows').checked = privacy.manageWindows;
    $('work-mode').classList.toggle('active', privacy.mode === 'work');
    $('play-mode').classList.toggle('active', privacy.mode === 'play');
    $('custom-mode').classList.toggle('active', !['work', 'play'].includes(privacy.mode));
    $('work-mode').setAttribute('aria-pressed', String(privacy.mode === 'work'));
    $('play-mode').setAttribute('aria-pressed', String(privacy.mode === 'play'));
    $('chat-profile').textContent = connection ? connection.name : 'No AI selected';
    $('chat-model').textContent = connection ? connection.model || 'Choose a model' : 'Add a connection to begin';
    $('native-status').textContent = state.status.nativeMessage || (state.status.nativeAvailable ? 'Windows integration is available. Access rules still apply to every operation.' : 'Desktop integration is unavailable.');
    $('vision-destination').textContent = connection ? connection.name + ' · ' + connection.model : 'No AI connection selected';
    $('vision-endpoint').textContent = connection ? connection.baseUrl : 'Select a profile with image support.';
    if (!characterDirty || options.resetCharacter) {
      $('character-name').value = character.name || 'Companion';
      $('character-personality').value = character.personality || '';
      $('character-playfulness').value = character.playfulness || 'balanced';
      $('character-speech').checked = character.speechEnabled;
      characterDirty = false;
    }
    $('avatar-badge').textContent = character.modelName ? 'YOUR VRM AVATAR' : 'PROTOTYPE AVATAR';
    $('avatar-name').textContent = character.modelName ? character.modelName.replace(/ · [a-f0-9]{8}$/, '') : 'Your character starts here.';
    $('avatar-description').textContent = character.modelName ? 'Your imported model is used on the desktop. The pose and expression quality depend on its rig.' : 'A simple procedural 3D stand-in is included. Import your own VRM to give your companion a look.';
    renderSpeechSettings(options.resetSpeech === true);
    renderMemorySettings();
    renderConnections();
    renderRules();
    renderSelectedWindow();
    if (initial) editConnection(connection || null);
    if (Object.hasOwn(state.status, 'replyProgress')) {
      if (state.status.replyProgress?.active) showModelActivity(state.status.replyProgress);
      else clearModelActivity();
    }
    updateAvailability();
  }

  function renderConnections() {
    const list = $('connection-list');
    list.replaceChildren();
    if (!state.config.connections.length) {
      list.append(make('p', 'empty-copy', 'No profiles yet. Add your first connection.'));
      return;
    }
    state.config.connections.forEach((connection) => {
      const card = make('div', 'connection-card');
      card.classList.toggle('active', connection.id === state.config.activeConnectionId);
      card.classList.toggle('editing', connection.id === editingId);
      card.append(make('strong', '', connection.name));
      card.append(make('span', '', (providerFor(connection.provider)?.label || connection.provider) + ' · ' + (connection.model || 'No model')));
      const actions = make('div', 'connection-card-actions');
      if (connection.id === state.config.activeConnectionId) actions.append(make('span', 'tag', 'SELECTED'));
      else {
        const select = make('button', 'text-button', 'Use profile');
        select.type = 'button';
        select.addEventListener('click', () => run(select, async () => {
          applyState(await api.selectConnection(connection.id));
          notify('Selected ' + connection.name + '. Its conversation is ready.', 'success');
        }));
        actions.append(select);
      }
      const edit = make('button', 'text-button', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', () => editConnection(connection));
      actions.append(edit);
      card.append(actions);
      list.append(card);
    });
  }

  function editConnection(connection) {
    editingId = connection?.id || '';
    discoveryEpoch += 1;
    $('connection-form').reset();
    $('connection-editor-title').textContent = connection ? 'Edit connection' : 'Add a connection';
    $('connection-name').value = connection?.name || '';
    $('connection-provider').value = connection?.provider || state.providers[0]?.id || '';
    $('connection-url').value = connection?.baseUrl || providerFor($('connection-provider').value)?.baseUrl || '';
    $('connection-model').value = connection?.model || '';
    $('connection-vision').checked = Boolean(connection?.supportsVision);
    $('connection-workspace').value = connection?.workspaceId || '';
    $('connection-version').value = connection?.anthropicVersion || '';
    $('connection-key').value = '';
    $('remove-key').checked = false;
    $('remove-key-row').hidden = !connection?.hasKey;
    $('delete-connection').hidden = !connection;
    $('model-options').replaceChildren();
    $('model-discovery-status').textContent = connection ? 'Discover this saved profile’s models, or enter a model ID manually.' : 'You can save without a model, discover available models, then choose one.';
    updateConnectionHints();
    renderConnections();
    updateAvailability();
  }

  function updateConnectionHints() {
    const original = state.config.connections.find((connection) => connection.id === editingId);
    const provider = providerFor($('connection-provider').value);
    const changed = original && (original.provider !== $('connection-provider').value || original.baseUrl.replace(/\/+$/, '') !== $('connection-url').value.trim().replace(/\/+$/, '') || (original.workspaceId || '') !== $('connection-workspace').value.trim());
    $('connection-kind').textContent = provider?.kind === 'local' ? 'LOCAL ENDPOINT' : provider?.kind === 'custom' ? 'CUSTOM ENDPOINT' : 'HOSTED SERVICE';
    $('key-state').textContent = original?.hasKey && !changed ? 'Key saved' : '';
    $('connection-key').placeholder = original?.hasKey && !changed ? 'Leave blank to keep the saved key' : 'Enter a key if this endpoint requires one';
    $('key-hint').textContent = changed ? 'The provider, endpoint, or workspace changed. Enter a new key; the previous key will not be reused.' : 'Your key is cleared from this field after saving and is never displayed again.';
    $('endpoint-hint').textContent = provider?.kind === 'local' ? 'Start your local model server before sending a message.' : 'Messages and permitted screenshots go to this exact endpoint.';
  }

  function renderChat() {
    const list = $('chat-messages');
    list.replaceChildren();
    $('chat-empty').hidden = chatMessages.length > 0;
    chatMessages.forEach((message) => {
      const row = make('article', 'message ' + (message.role === 'user' ? 'user' : 'assistant'));
      row.classList.toggle('pending', Boolean(message.pending));
      row.classList.toggle('error', Boolean(message.error));
      row.append(make('div', 'message-avatar', message.role === 'user' ? 'YOU' : '✦'));
      const content = make('div', 'message-content');
      content.append(make('div', 'message-header', message.role === 'user' ? 'You' : state?.config.character.name || 'Companion'));
      const body = make('div', 'message-body', message.content || '');
      content.append(body);
      row.append(content);
      list.append(row);
      if (message === pendingMessage) pendingBody = body;
    });
    list.scrollTop = list.scrollHeight;
  }

  async function sendChat(event) {
    event.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text || chatBusy || $('send-message').disabled) return;
    const epoch = chatEpoch;
    chatMessages.push({role: 'user', content: text});
    pendingMessage = {role: 'assistant', content: '', pending: true};
    chatMessages.push(pendingMessage);
    const responseMessage = pendingMessage;
    $('chat-input').value = '';
    chatBusy = true;
    notify('');
    renderChat();
    updateAvailability();
    try {
      const result = await api.sendMessage({text});
      if (epoch !== chatEpoch) return;
      responseMessage.content = result.text;
      responseMessage.pending = false;
    } catch (error) {
      if (epoch !== chatEpoch) return;
      responseMessage.content = errorText(error);
      responseMessage.error = true;
      responseMessage.pending = false;
    } finally {
      if (epoch === chatEpoch) {
        chatBusy = false;
        clearModelActivity();
        pendingMessage = null;
        pendingBody = null;
        renderChat();
        updateAvailability();
        $('chat-input').focus();
      }
    }
  }

  function renderSelectedWindow() {
    const container = $('selected-window-details');
    container.replaceChildren();
    const target = state.selectedWindow;
    if (!target) { container.append(make('strong', '', 'No window selected')); return; }
    container.append(make('strong', '', target.title || '(Untitled window)'));
    container.append(make('span', '', target.processName + ' · ' + target.bounds.width + ' × ' + target.bounds.height + (target.minimized ? ' · Minimized' : '')));
    container.append(make('code', '', target.exePath));
    if (document.activeElement !== $('window-width')) $('window-width').value = target.bounds.width;
    if (document.activeElement !== $('window-height')) $('window-height').value = target.bounds.height;
  }

  function renderRules() {
    const tbody = $('app-rules');
    tbody.replaceChildren();
    $('rules-empty').hidden = state.config.privacy.rules.length > 0;
    state.config.privacy.rules.forEach((rule) => {
      const row = make('tr', rule.protected ? 'protected' : '');
      const name = make('td');
      name.append(make('strong', '', rule.label));
      name.append(make('small', '', rule.exePath));
      row.append(name);
      ['protected', 'layout', 'vision', 'manage'].forEach((key) => {
        const cell = make('td');
        const checkbox = make('input');
        checkbox.type = 'checkbox';
        checkbox.checked = Boolean(rule[key]);
        checkbox.disabled = rule.protected && key !== 'protected';
        checkbox.setAttribute('aria-label', rule.label + ': ' + ({protected: 'Protected', layout: 'Layout access', vision: 'Contents access', manage: 'Window actions'}[key]));
        checkbox.addEventListener('change', () => run(checkbox, async () => {
          const updated = {...rule, [key]: checkbox.checked};
          if (updated.protected) Object.assign(updated, {layout: false, vision: false, manage: false});
          try {
            applyState(await api.saveRule(updated));
            notify('Updated access for ' + rule.label + '.', 'success');
          } finally { renderRules(); }
        }));
        cell.append(checkbox);
        row.append(cell);
      });
      tbody.append(row);
    });
  }

  async function refreshWindows() {
    notify('Looking for open windows…');
    windows = await api.listWindows();
    applyState(await api.getState());
    const select = $('window-list');
    select.replaceChildren();
    const empty = make('option', '', windows.length ? 'Choose a window…' : 'No eligible windows found');
    empty.value = '';
    select.append(empty);
    windows.forEach((target) => {
      const option = make('option', '', target.processName + ' — ' + (target.title || '(Untitled window)'));
      option.value = target.handle;
      select.append(option);
    });
    if (windows.some((target) => target.handle === state.selectedWindow?.handle)) select.value = state.selectedWindow.handle;
    notify(windows.length ? windows.length + ' open windows listed. Choose one to continue.' : 'No eligible windows are currently available.');
    updateAvailability();
  }

  async function actOnWindow(action, button) {
    if (permissionReason('manage') || actionBusy) return;
    actionBusy = true;
    updateAvailability();
    try {
      applyState(await api.windowAction(action));
      notify(action.type === 'undo' ? 'The last window action was undone.' : 'Window action completed.', 'success');
    } catch (error) { notify(errorText(error), 'error'); }
    finally { actionBusy = false; updateAvailability(); }
  }

  function bindEvents() {
    document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => switchTab(button.dataset.go)));
    document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { $('chat-input').value = button.dataset.prompt; $('chat-input').focus(); }));
    $('chat-form').addEventListener('submit', sendChat);
    $('chat-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
    });
    $('cancel-reply').addEventListener('click', () => run($('cancel-reply'), () => api.cancelReply()));
    $('model-activity-stop').addEventListener('click', () => run($('model-activity-stop'), async () => {
      await api.cancelReply();
      clearModelActivity();
    }));
    $('microphone-toggle').addEventListener('click', () => {
      if (!microphone || $('microphone-toggle').disabled) return;
      if (microphone.phase === 'recording') microphone.stop();
      else if (!microphone.active && !microphoneBlockReason()) { notify(''); void microphone.start(); }
    });
    $('microphone-cancel').addEventListener('click', () => run($('microphone-cancel'), async () => {
      const wasTranscribing = microphone?.phase === 'transcribing';
      await microphone?.cancel();
      notify(wasTranscribing ? 'Transcription cancelled. Nothing was added to the draft.' : 'Recording discarded. No audio was sent for transcription.');
    }));
    $('clear-chat').addEventListener('click', () => run($('clear-chat'), async () => { applyState(await api.clearChat(), {replaceChat: true}); notify('Conversation cleared.', 'success'); }));
    $('pause-all').addEventListener('click', () => run($('pause-all'), async () => {
      const next = state.config.privacy.paused ? await api.savePreferences({privacy: {paused: false}}) : await api.pauseAll();
      applyState(next);
      notify(state.config.privacy.paused ? 'All activity is paused.' : 'Companion resumed. Your app permissions still apply.', 'success');
    }));
    $('toggle-overlay').addEventListener('click', () => run($('toggle-overlay'), () => api.toggleOverlay()));
    $('preview-avatar').addEventListener('click', () => run($('preview-avatar'), () => api.toggleOverlay()));
    $('quit-app').addEventListener('click', () => api.quit().catch((error) => notify(errorText(error), 'error')));

    $('speech-form').addEventListener('input', () => { speechDirty = true; updateSpeechHints(); });
    $('speech-form').addEventListener('change', () => { speechDirty = true; updateSpeechHints(); });
    $('speech-provider').addEventListener('change', () => {
      const provider = speechProviderFor($('speech-provider').value);
      $('speech-url').value = provider?.baseUrl || '';
      $('speech-model').value = provider?.model || '';
      $('speech-key').value = '';
      $('speech-remove-key').checked = false;
      speechDirty = true;
      updateSpeechHints();
    });
    $('speech-key').addEventListener('input', () => { if ($('speech-key').value) $('speech-remove-key').checked = false; });
    $('speech-remove-key').addEventListener('change', () => { if ($('speech-remove-key').checked) $('speech-key').value = ''; });
    $('speech-enabled').addEventListener('change', () => run($('speech-enabled'), async () => {
      const enabled = $('speech-enabled').checked;
      speechBusy = true;
      updateAvailability();
      try {
        await microphone?.cancel();
        applyState(await api.saveSpeech(savedSpeechPayload(enabled)));
        notify(enabled ? 'Microphone input is enabled. Press Record in Chat when you are ready.' : 'Microphone input is off.', 'success');
      } finally {
        speechBusy = false;
        $('speech-enabled').checked = state.config.speech?.enabled === true;
        updateAvailability();
      }
    }));
    $('speech-form').addEventListener('submit', event => {
      event.preventDefault();
      if (speechBusy) return;
      run($('save-speech'), async () => {
        const payload = {
          enabled: state.config.speech?.enabled === true, provider: $('speech-provider').value,
          baseUrl: $('speech-url').value.trim(), model: $('speech-model').value.trim(),
          language: $('speech-language').value.trim(), apiKey: $('speech-key').value,
          removeKey: $('speech-remove-key').checked,
        };
        speechBusy = true;
        updateAvailability();
        try {
          await microphone?.cancel();
          applyState(await api.saveSpeech(payload), { resetSpeech: true });
          notify(state.config.speech?.enabled ? 'Voice settings saved. Review the audio destination before recording.' : 'Voice settings saved. Enable microphone input when you want to record.', 'success');
        } finally {
          $('speech-key').value = ''; payload.apiKey = '';
          speechBusy = false; updateAvailability();
        }
      });
    });
    $('memory-enabled').addEventListener('change', () => run($('memory-enabled'), async () => {
      const enabled = $('memory-enabled').checked;
      const prompt = enabled
        ? 'Enable saved conversation memory? Current session conversations will be cleared so saved memory starts fresh.'
        : 'Turn off conversation memory? This erases saved and current conversations for every AI profile.';
      if (!window.confirm(prompt)) { $('memory-enabled').checked = state.config.memory?.enabled !== false; return; }
      memoryBusy = true; updateAvailability();
      try {
        applyState(await api.savePreferences({ memory: { enabled } }), { replaceChat: true });
        notify(enabled ? 'Conversation memory enabled. New conversations will be saved on this PC.' : 'Conversation memory disabled. Saved and current chats were cleared.', 'success');
      } finally {
        memoryBusy = false;
        $('memory-enabled').checked = state.config.memory?.enabled !== false;
        updateAvailability();
      }
    }));
    $('clear-all-memory').addEventListener('click', () => run($('clear-all-memory'), async () => {
      if (!window.confirm('Clear every AI profile’s saved and current conversation? This cannot be undone.')) return;
      memoryBusy = true; updateAvailability();
      try {
        applyState(await api.clearAllMemory(), { replaceChat: true });
        notify('All saved and current conversations were cleared.', 'success');
      } finally { memoryBusy = false; updateAvailability(); }
    }));

    [['local-only', 'localOnly'], ['react-to-windows', 'reactToWindows'], ['see-window-contents', 'seeWindowContents'], ['manage-windows', 'manageWindows']].forEach(([id, key]) => {
      $(id).addEventListener('change', () => run($(id), async () => {
        const privacy = {[key]: $(id).checked};
        if (key !== 'localOnly') privacy.mode = 'custom';
        try { applyState(await api.savePreferences({privacy})); notify('Preferences saved.', 'success'); }
        finally { $(id).checked = Boolean(state.config.privacy[key]); }
      }));
    });
    [['work-mode', 'work'], ['play-mode', 'play']].forEach(([id, mode]) => $(id).addEventListener('click', () => run($(id), async () => {
      applyState(await api.savePreferences({privacy: {mode}}));
      notify(mode === 'work' ? 'Work mode is on. The three desktop abilities are off.' : 'Play mode is on. Your saved choices and protected app rules apply.', 'success');
    })));

    $('new-connection').addEventListener('click', () => { editConnection(null); $('connection-name').focus(); });
    $('connection-provider').addEventListener('change', () => {
      discoveryEpoch += 1;
      $('connection-url').value = providerFor($('connection-provider').value)?.baseUrl || '';
      $('connection-key').value = '';
      $('connection-model').value = '';
      $('connection-vision').checked = false;
      $('connection-workspace').value = '';
      $('connection-version').value = '';
      $('model-options').replaceChildren();
      $('model-discovery-status').textContent = 'Save this provider and endpoint before discovering models.';
      updateConnectionHints();
    });
    $('connection-url').addEventListener('input', updateConnectionHints);
    $('connection-workspace').addEventListener('input', updateConnectionHints);
    $('connection-key').addEventListener('input', () => { if ($('connection-key').value) $('remove-key').checked = false; });
    $('remove-key').addEventListener('change', () => { if ($('remove-key').checked) $('connection-key').value = ''; });
    $('connection-form').addEventListener('submit', (event) => {
      event.preventDefault();
      run($('save-connection'), async () => {
        const payload = {
          name: $('connection-name').value.trim(), provider: $('connection-provider').value,
          baseUrl: $('connection-url').value.trim(), model: $('connection-model').value.trim(),
          supportsVision: $('connection-vision').checked, workspaceId: $('connection-workspace').value.trim(),
          anthropicVersion: $('connection-version').value.trim(), apiKey: $('connection-key').value,
          removeKey: $('remove-key').checked
        };
        if (editingId) payload.id = editingId;
        try {
          const next = await api.saveConnection(payload);
          applyState(next, {replaceChat: true});
          editConnection(currentConnection());
          notify(currentConnection()?.model ? 'Profile saved and selected. Send a message to use the chosen model.' : 'Profile saved. Discover models or enter a model ID, then save again.', 'success');
        } finally { $('connection-key').value = ''; payload.apiKey = ''; }
      });
    });
    $('delete-connection').addEventListener('click', () => run($('delete-connection'), async () => {
      const connection = state.config.connections.find((item) => item.id === editingId);
      if (!connection || !window.confirm('Remove “' + connection.name + '” and its saved key?')) return;
      applyState(await api.removeConnection(connection.id));
      editConnection(currentConnection() || null);
      notify('Profile removed.', 'success');
    }));
    $('discover-models').addEventListener('click', () => run($('discover-models'), async () => {
      const connection = state.config.connections.find((item) => item.id === editingId);
      if (!connection) throw new Error('Save this profile before discovering models.');
      if (connection.provider !== $('connection-provider').value || connection.baseUrl.replace(/\/+$/, '') !== $('connection-url').value.trim().replace(/\/+$/, '') || (connection.workspaceId || '') !== $('connection-workspace').value.trim() || (connection.anthropicVersion || '') !== $('connection-version').value.trim() || $('connection-key').value || $('remove-key').checked) throw new Error('Save your connection changes before discovering models.');
      const epoch = ++discoveryEpoch;
      $('model-discovery-status').textContent = 'Requesting the model list from ' + connection.name + '…';
      try {
        const models = await api.listModels(connection.id);
        if (epoch !== discoveryEpoch) return;
        $('model-options').replaceChildren();
        models.forEach((model) => { const option = make('option'); option.value = model.id; option.label = (model.name || model.id) + (model.remote ? ' · remote model' : ''); $('model-options').append(option); });
        $('model-discovery-status').textContent = models.length ? models.length + ' models returned. Select or enter a model ID, then save. Chat and image support are not verified by this list.' : 'The endpoint returned no models. Enter a model ID manually if it supports one.';
        notify('Model discovery finished. No chat request was made.', 'success');
      } catch (error) { if (epoch === discoveryEpoch) $('model-discovery-status').textContent = 'Discovery failed. You can still enter a model ID manually.'; throw error; }
    }));

    $('refresh-windows').addEventListener('click', () => run($('refresh-windows'), refreshWindows));
    $('window-list').addEventListener('change', updateAvailability);
    $('select-window').addEventListener('click', () => run($('select-window'), async () => {
      if (!$('window-list').value) return;
      applyState(await api.selectWindow($('window-list').value));
      notify('Window selected. Nothing has been captured or sent.', 'success');
    }));
    $('add-window-rule').addEventListener('click', () => run($('add-window-rule'), async () => {
      if (!state.selectedWindow) return;
      if (selectedRule()) { notify('This app already has a rule. Use its switches below.'); return; }
      const target = state.selectedWindow;
      applyState(await api.saveRule({exePath: target.exePath, label: target.processName, protected: false, layout: false, vision: false, manage: false}));
      notify('App added with access off. Choose its permissions below.', 'success');
    }));
    $('describe-window').addEventListener('click', async () => {
      if (permissionReason('vision') || visionBusy) return;
      const requestFingerprint = JSON.stringify([state.selectedWindow?.handle, state.config.activeConnectionId, state.config.privacy]);
      visionBusy = true;
      $('vision-result').hidden = false;
      $('vision-result').textContent = 'Requesting a description…';
      updateAvailability();
      try {
        const result = await api.describeWindow({question: $('window-question').value.trim() || 'Describe what is shown in this window.'});
        if (requestFingerprint !== JSON.stringify([state.selectedWindow?.handle, state.config.activeConnectionId, state.config.privacy])) return;
        $('vision-result').textContent = result.text;
      } catch (error) {
        $('vision-result').textContent = '';
        $('vision-result').hidden = true;
        notify(errorText(error), 'error');
      } finally { visionBusy = false; clearModelActivity(); updateAvailability(); }
    });
    document.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => {
      const [dx, dy] = button.dataset.move.split(',').map(Number);
      actOnWindow({type: 'move', dx, dy}, button);
    }));
    $('resize-window').addEventListener('click', () => {
      if (!$('window-width').reportValidity() || !$('window-height').reportValidity()) return;
      actOnWindow({type: 'resize', width: Number($('window-width').value), height: Number($('window-height').value)}, $('resize-window'));
    });
    [['minimize-window', 'minimize'], ['restore-window', 'restore'], ['undo-window', 'undo']].forEach(([id, type]) => $(id).addEventListener('click', () => actOnWindow({type}, $(id))));

    $('character-form').addEventListener('input', () => { characterDirty = true; });
    $('character-form').addEventListener('change', () => { characterDirty = true; });
    $('character-form').addEventListener('submit', (event) => {
      event.preventDefault();
      run(event.submitter, async () => {
        const character = {name: $('character-name').value.trim(), personality: $('character-personality').value.trim(), playfulness: $('character-playfulness').value, speechEnabled: $('character-speech').checked};
        applyState(await api.savePreferences({character}), {resetCharacter: true});
        notify('Character preferences saved.', 'success');
      });
    });
    $('import-avatar').addEventListener('click', () => run($('import-avatar'), async () => {
      const result = await api.importAvatar();
      if (!result) return;
      applyState(await api.getState());
      notify('Imported ' + result.name.replace(/ · [a-f0-9]{8}$/, '') + '. The desktop character will load it now.', 'success');
    }));
  }

  function onEvent(event) {
    microphone?.handleEvent(event);
    if (event.type === 'state') applyState(event.state);
    else if (event.type === 'reply-progress') showModelActivity(event);
    else if (event.type === 'chat-delta' && pendingMessage && pendingBody) {
      pendingMessage.content += event.text;
      pendingBody.textContent = pendingMessage.content;
      $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    } else if (event.type === 'chat-reply' && pendingMessage && pendingBody) {
      pendingMessage.content = event.text;
      pendingBody.textContent = event.text;
    } else if (event.type === 'status' && event.text) notify(event.text);
  }

  async function start() {
    if (!api) {
      notify('This interface must be opened by the desktop app. Run the Electron project to use its secure connection and desktop features.', 'error');
      document.querySelectorAll('button,input,textarea,select').forEach((control) => { control.disabled = true; });
      return;
    }
    microphone = new MicrophoneRecorder({
      api, onState: renderMicrophone, onTranscript: appendTranscript,
      onError: error => notify(errorText(error), 'error'),
    });
    renderMicrophone();
    bindEvents();
    api.onEvent(onEvent);
    document.addEventListener('visibilitychange', () => { if (document.hidden && microphone.active) void microphone.cancel(); });
    window.addEventListener('beforeunload', () => { clearInterval(modelActivityTimer); void microphone.cancel(); });
    try { applyState(await api.getState()); }
    catch (error) { notify('Could not load settings. ' + errorText(error), 'error'); }
  }

  start();
})();

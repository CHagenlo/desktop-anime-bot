'use strict';

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
  const pageCopy = {
    chat: ["Let's talk.", 'Your character, your choice of AI, your desktop.'],
    connections: ['Choose her mind.', 'Use your own API keys or a model running on your computer.'],
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
    document.querySelector('.main').scrollTop = 0;
  }

  function currentConnection() {
    return state && state.config.connections.find((connection) => connection.id === state.config.activeConnectionId);
  }

  function providerFor(id) {
    return state && state.providers.find((provider) => provider.id === id);
  }

  function isLoopback(baseUrl) {
    try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(baseUrl).hostname); }
    catch { return false; }
  }

  function blockedByLocalMode(connection) {
    return Boolean(connection && state.config.privacy.localOnly && (providerFor(connection.provider)?.kind !== 'local' || !isLoopback(connection.baseUrl)));
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
    $('send-message').disabled = chatBusy || visionBusy || !connection || !connection.model || state.config.privacy.paused || localBlocked;
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
    else $('chat-send-note').textContent = 'Text goes only to your selected connection.';
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
    state = next;
    if (initial) {
      state.providers.forEach((provider) => {
        const option = make('option', '', provider.label);
        option.value = provider.id;
        $('connection-provider').append(option);
      });
    }
    if (initial || providerChanged || options.replaceChat) {
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
    renderConnections();
    renderRules();
    renderSelectedWindow();
    if (initial) editConnection(connection || null);
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
    $('clear-chat').addEventListener('click', () => run($('clear-chat'), async () => { applyState(await api.clearChat(), {replaceChat: true}); notify('Conversation cleared.', 'success'); }));
    $('pause-all').addEventListener('click', () => run($('pause-all'), async () => {
      const next = state.config.privacy.paused ? await api.savePreferences({privacy: {paused: false}}) : await api.pauseAll();
      applyState(next);
      notify(state.config.privacy.paused ? 'All activity is paused.' : 'Companion resumed. Your app permissions still apply.', 'success');
    }));
    $('toggle-overlay').addEventListener('click', () => run($('toggle-overlay'), () => api.toggleOverlay()));
    $('preview-avatar').addEventListener('click', () => run($('preview-avatar'), () => api.toggleOverlay()));
    $('quit-app').addEventListener('click', () => api.quit().catch((error) => notify(errorText(error), 'error')));

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
      } finally { visionBusy = false; updateAvailability(); }
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
    if (event.type === 'state') applyState(event.state);
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
    bindEvents();
    api.onEvent(onEvent);
    try { applyState(await api.getState()); }
    catch (error) { notify('Could not load settings. ' + errorText(error), 'error'); }
  }

  start();
})();

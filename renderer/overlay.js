const api = window.companion;
const $ = (id) => document.getElementById(id);
let THREE, GLTFLoader, VRMLoaderPlugin, VRMUtils;
let state = null;
let scene, camera, renderer, raycaster, pointer;
let rig = null;
let vrm = null;
let modelName;
let avatarEpoch = 0;
let currentPose = 'idle';
let perchTarget = 0;
let perch = 0;
let look = {x: 0, y: 0};
let targetLook = {x: 0, y: 0};
let elapsed = 0;
let lastFrame = 0;
let patUntil = 0;
let speakingUntil = 0;
let localSpeechActive = false;
let interactive = null;
let pointerDown = null;
let dragging = false;
let hoveredHit = null;
let localVoices = [];
let captionTimer;
let currentUtterance = null;
const boneBases = new Map();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function errorText(error) {
  return String(error?.message || error || 'Something went wrong.').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').slice(0, 600);
}

function bubble(text, detail = '', timeout = 12000) {
  clearTimeout(captionTimer);
  $('speech-text').textContent = String(text).slice(0, 1400);
  $('speech-detail').textContent = detail;
  $('speech-bubble').hidden = false;
  if (timeout) captionTimer = setTimeout(() => { $('speech-bubble').hidden = true; }, timeout);
}

function setInteractive(value) {
  if (interactive === value || !api) return;
  interactive = value;
  Promise.resolve(api.setOverlayInteractive(value)).catch(() => {});
}

function stopSpeech() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  currentUtterance = null;
  localSpeechActive = false;
  speakingUntil = 0;
}

function speak(text) {
  if (!state?.config.character.speechEnabled || state.config.privacy.paused || !('speechSynthesis' in window)) return;
  localVoices = window.speechSynthesis.getVoices().filter((voice) => voice.localService);
  if (!localVoices.length) {
    $('speech-detail').textContent = 'No local system voice is available. Showing captions.';
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = localVoices.find((item) => item.lang.toLowerCase().startsWith(navigator.language.toLowerCase().split('-')[0])) || localVoices[0];
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 1;
  utterance.pitch = 1.04;
  utterance.onstart = () => { if (currentUtterance === utterance) localSpeechActive = true; };
  utterance.onend = () => { if (currentUtterance === utterance) { localSpeechActive = false; speakingUntil = 0; currentUtterance = null; } };
  utterance.onerror = () => {
    if (currentUtterance !== utterance) return;
    localSpeechActive = false;
    currentUtterance = null;
    $('speech-detail').textContent = 'The local system voice could not speak. Showing captions.';
  };
  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

function updateLabels() {
  if (!state) return;
  const paused = state.config.privacy.paused;
  $('companion-name').textContent = state.config.character.name || 'Companion';
  $('pause-companion').textContent = paused ? '▶' : 'Ⅱ';
  $('pause-companion').title = paused ? 'Resume companion' : 'Pause everything';
  $('pause-companion').setAttribute('aria-label', paused ? 'Resume companion' : 'Pause everything');
  $('state-dot').classList.toggle('paused', paused);
  $('state-dot').classList.toggle('thinking', !paused && currentPose === 'thinking');
  $('pose-label').textContent = paused ? 'Paused' : currentPose === 'thinking' ? 'Thinking' : dragging ? 'Moving' : perchTarget ? 'Perched' : 'Here with you';
}

function applyState(next) {
  if (!next?.config) return;
  const previous = state;
  state = next;
  const permissionsChanged = previous && JSON.stringify(previous.config.privacy) !== JSON.stringify(next.config.privacy);
  const providerChanged = previous && previous.config.activeConnectionId !== next.config.activeConnectionId;
  if (next.config.privacy.paused || permissionsChanged || providerChanged || !next.config.character.speechEnabled) stopSpeech();
  if (next.config.privacy.paused || providerChanged || permissionsChanged) {
    $('speech-bubble').hidden = true;
    clearTimeout(captionTimer);
  }
  if (next.config.privacy.paused && pointerDown) {
    Promise.resolve(api.dragOverlay({phase: 'end', screenX: pointerDown.x, screenY: pointerDown.y})).catch(() => {});
    if ($('avatar-canvas').hasPointerCapture(pointerDown.id)) $('avatar-canvas').releasePointerCapture(pointerDown.id);
    pointerDown = null;
    dragging = false;
    document.body.classList.remove('dragging');
  }
  if (next.config.privacy.paused || !next.config.privacy.reactToWindows) perchTarget = 0;
  updateLabels();
  if (scene && modelName !== next.config.character.modelName) loadAvatar(next.config.character.modelName);
}

function disposeObject(object) {
  if (!object) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  object.traverse((child) => {
    if (child.geometry) geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : child.material ? [child.material] : []) {
      materials.add(material);
      Object.values(material).forEach((value) => { if (value?.isTexture) textures.add(value); });
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

function clearAvatar() {
  if (rig) { scene.remove(rig.root); disposeObject(rig.root); }
  rig = null;
  vrm = null;
  boneBases.clear();
}

function mesh(geometry, material, parent, position = [0, 0, 0]) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(...position);
  parent.add(object);
  return object;
}

function createPlaceholder() {
  clearAvatar();
  const root = new THREE.Group();
  scene.add(root);
  const skin = new THREE.MeshToonMaterial({color: 0xf2d9cf});
  const hair = new THREE.MeshToonMaterial({color: 0xb6a5da});
  const hairDark = new THREE.MeshToonMaterial({color: 0x8575b4});
  const mint = new THREE.MeshToonMaterial({color: 0x9ed7c1});
  const dark = new THREE.MeshToonMaterial({color: 0x293345});
  const eyeWhite = new THREE.MeshBasicMaterial({color: 0xf9fbff});
  const iris = new THREE.MeshBasicMaterial({color: 0x586d9b});
  const pupilMaterial = new THREE.MeshBasicMaterial({color: 0x202d46});
  const cheek = new THREE.MeshBasicMaterial({color: 0xe7a2b0, transparent: true, opacity: .48});
  mesh(new THREE.CylinderGeometry(.18, .23, .46, 20), mint, root, [0, 1.00, 0]);
  mesh(new THREE.CylinderGeometry(.20, .32, .32, 24), dark, root, [0, .71, 0]);
  mesh(new THREE.CylinderGeometry(.205, .205, .055, 20), hairDark, root, [0, .85, 0]);
  mesh(new THREE.SphereGeometry(.038, 10, 10), hair, root, [0, 1.14, .18]);
  const head = new THREE.Group();
  head.position.set(0, 1.47, 0);
  head.userData.part = 'head';
  root.add(head);
  const back = mesh(new THREE.SphereGeometry(.30, 28, 20), hairDark, head, [0, .06, -.035]);
  back.scale.set(1.03, 1.08, .94);
  const face = mesh(new THREE.SphereGeometry(.255, 28, 20), skin, head, [0, 0, .06]);
  face.scale.set(.95, 1.05, .91);
  const crown = mesh(new THREE.SphereGeometry(.292, 28, 20, 0, Math.PI * 2, 0, Math.PI * .57), hair, head, [0, .045, -.005]);
  crown.rotation.x = -.09;
  for (let index = -2; index <= 2; index += 1) {
    const bang = mesh(new THREE.CapsuleGeometry(.055, .17, 4, 10), hair, head, [index * .082, .15 - Math.abs(index) * .008, .228 - Math.abs(index) * .008]);
    bang.rotation.z = index * -.09 + .12;
    bang.rotation.x = -.12;
    bang.scale.z = .45;
  }
  for (const side of [-1, 1]) {
    const sideHair = mesh(new THREE.CapsuleGeometry(.075, .22, 4, 10), hair, head, [side * .25, -.035, .015]);
    sideHair.rotation.z = side * .14;
  }
  const eyes = [];
  const pupils = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(side * .098, -.006, .274);
    head.add(eye);
    const white = mesh(new THREE.SphereGeometry(.047, 14, 12), eyeWhite, eye);
    white.scale.set(.8, 1.1, .16);
    const colored = mesh(new THREE.SphereGeometry(.032, 12, 12), iris, eye, [0, -.002, .011]);
    colored.scale.set(.82, 1.12, .18);
    const pupil = mesh(new THREE.SphereGeometry(.018, 10, 10), pupilMaterial, eye, [0, -.001, .016]);
    pupil.scale.set(.72, 1.2, .18);
    const glint = mesh(new THREE.SphereGeometry(.009, 8, 8), eyeWhite, pupil, [-.008, .011, .012]);
    glint.scale.z = .4;
    const blush = mesh(new THREE.SphereGeometry(.04, 12, 10), cheek, head, [side * .15, -.077, .244]);
    blush.scale.set(1.15, .38, .12);
    eyes.push(eye);
    pupils.push(pupil);
  }
  const mouth = mesh(new THREE.SphereGeometry(.026, 12, 10), new THREE.MeshBasicMaterial({color: 0x9b6574}), head, [0, -.108, .263]);
  mouth.scale.set(.9, .20, .12);
  const armGroups = [];
  const legGroups = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * .21, 1.17, 0);
    root.add(arm);
    mesh(new THREE.CapsuleGeometry(.062, .23, 5, 12), mint, arm, [0, -.15, 0]);
    mesh(new THREE.CapsuleGeometry(.044, .17, 5, 12), skin, arm, [0, -.37, .005]);
    mesh(new THREE.SphereGeometry(.055, 12, 12), skin, arm, [0, -.49, .008]);
    armGroups.push(arm);
    const upper = new THREE.Group();
    upper.position.set(side * .12, .63, 0);
    root.add(upper);
    mesh(new THREE.CapsuleGeometry(.068, .23, 5, 12), dark, upper, [0, -.15, 0]);
    const lower = new THREE.Group();
    lower.position.set(0, -.30, 0);
    upper.add(lower);
    mesh(new THREE.CapsuleGeometry(.056, .20, 5, 12), dark, lower, [0, -.13, 0]);
    const foot = mesh(new THREE.SphereGeometry(.075, 14, 10), hairDark, lower, [0, -.265, .045]);
    foot.scale.set(1, .65, 1.5);
    legGroups.push({upper, lower});
  }
  rig = {root, head, mouth, eyes, pupils, armGroups, legGroups, placeholder: true};
  $('avatar-type').textContent = 'Prototype avatar · import a VRM';
  $('overlay-error').hidden = true;
}

function assertSelfContained(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('The avatar must be a binary, self-contained VRM file.');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength + 20 > bytes.byteLength) throw new Error('The model has an invalid GLB header.');
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim());
  const resources = [...(gltf.buffers || []), ...(gltf.images || [])];
  if (resources.some((resource) => typeof resource.uri === 'string' && !resource.uri.startsWith('data:'))) throw new Error('The avatar references external assets. Please use a self-contained VRM.');
}

async function loadAvatar(requestedName) {
  const epoch = ++avatarEpoch;
  modelName = requestedName || '';
  if (!modelName) { createPlaceholder(); return; }
  $('avatar-type').textContent = 'Loading your avatar…';
  try {
    const data = await api.getAvatar();
    if (epoch !== avatarEpoch) return;
    if (!data) { createPlaceholder(); return; }
    const bytes = new Uint8Array(data.bytes);
    assertSelfContained(bytes);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (/^(blob:|data:)/i.test(url)) return url;
      throw new Error('External avatar resources are blocked.');
    });
    const loader = new GLTFLoader(manager);
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await new Promise((resolve, reject) => loader.parse(bytes.buffer, '', resolve, reject));
    if (epoch !== avatarEpoch) { disposeObject(gltf.scene); return; }
    const imported = gltf.userData.vrm;
    if (!imported?.humanoid) { disposeObject(gltf.scene); throw new Error('The file does not contain a supported VRM humanoid.'); }
    clearAvatar();
    vrm = imported;
    if (VRMUtils.rotateVRM0) VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((object) => { object.frustumCulled = false; });
    const root = new THREE.Group();
    root.add(vrm.scene);
    scene.add(root);
    rig = {root, placeholder: false};
    poseVrm(0, 0, false, false);
    vrm.update(0);
    const bounds = new THREE.Box3().setFromObject(vrm.scene);
    const height = bounds.max.y - bounds.min.y;
    if (!Number.isFinite(height) || height < .01 || height > 10000) throw new Error('The model has invalid dimensions.');
    const scale = 1.85 / height;
    vrm.scene.scale.multiplyScalar(scale);
    vrm.scene.position.x -= (bounds.min.x + bounds.max.x) * .5 * scale;
    vrm.scene.position.y -= bounds.min.y * scale;
    vrm.scene.position.z -= (bounds.min.z + bounds.max.z) * .5 * scale;
    $('avatar-type').textContent = 'Your VRM avatar';
    $('overlay-error').hidden = true;
  } catch (error) {
    if (epoch !== avatarEpoch) return;
    createPlaceholder();
    bubble('I could not load that avatar. The prototype character is still available.', errorText(error), 20000);
  }
}

function bone(name) {
  const node = vrm?.humanoid.getNormalizedBoneNode(name);
  if (node && !boneBases.has(name)) boneBases.set(name, node.rotation.clone());
  return node;
}

function rotateBone(name, x, y, z) {
  const node = bone(name);
  if (!node) return;
  const base = boneBases.get(name);
  node.rotation.set(base.x + x, base.y + y, base.z + z, base.order);
}

function setExpression(name, amount) {
  if (!vrm?.expressionManager?.getExpression(name)) return;
  vrm.expressionManager.setValue(name, amount);
}

function poseVrm(time, intensity, isSpeaking, isPat) {
  if (!vrm) return;
  const sway = Math.sin(time * 1.2) * .02 * intensity;
  const thinking = currentPose === 'thinking';
  rotateBone('spine', 0, sway * .5, sway);
  rotateBone('chest', Math.sin(time * 1.6) * .012 * intensity, 0, 0);
  rotateBone('neck', -look.y * .07, look.x * .08, isPat ? .08 : 0);
  rotateBone('head', -look.y * .12 + (isPat ? .11 : 0), look.x * .22, thinking ? .11 : sway * .5);
  rotateBone('leftUpperArm', -.04 - perch * .28, 0, 1.18 + sway * 2);
  rotateBone('rightUpperArm', thinking ? -.55 : -.04 - perch * .28, 0, thinking ? -.85 : -1.18 + sway * 2);
  rotateBone('leftLowerArm', -.12 - perch * .3, 0, 0);
  rotateBone('rightLowerArm', thinking ? -1.25 : -.12 - perch * .3, 0, 0);
  rotateBone('leftUpperLeg', -perch * 1.33, 0, .025);
  rotateBone('rightUpperLeg', -perch * 1.33, 0, -.025);
  rotateBone('leftLowerLeg', perch * 1.44, 0, 0);
  rotateBone('rightLowerLeg', perch * 1.44, 0, 0);
  const blinkCycle = time % 4.7;
  const blink = blinkCycle > 4.48 ? Math.sin((blinkCycle - 4.48) / .22 * Math.PI) : 0;
  setExpression('blink', isPat ? .85 : Math.max(0, blink));
  setExpression('happy', isPat ? .65 : .06);
  setExpression('aa', isSpeaking ? .17 + Math.abs(Math.sin(time * 14)) * .38 : 0);
  setExpression('ih', isSpeaking ? Math.abs(Math.cos(time * 9)) * .12 : 0);
}

function posePlaceholder(time, intensity, isSpeaking, isPat) {
  const sway = Math.sin(time * 1.35) * .026 * intensity;
  rig.head.rotation.set(-look.y * .15 + (isPat ? .12 : 0), look.x * .30, currentPose === 'thinking' ? .12 : sway);
  const blinkPhase = time % 4.7;
  const blink = blinkPhase > 4.48 ? Math.sin((blinkPhase - 4.48) / .22 * Math.PI) : 0;
  rig.eyes.forEach((eye) => { eye.scale.y = isPat ? .12 : Math.max(.08, 1 - blink); });
  rig.pupils.forEach((pupil) => { pupil.position.x = look.x * .008; pupil.position.y = -.001 + look.y * .005; });
  rig.mouth.scale.y = isSpeaking ? .40 + Math.abs(Math.sin(time * 15)) * .7 : isPat ? .45 : .20;
  rig.armGroups[0].rotation.set(-perch * .35, 0, -.11 + sway);
  rig.armGroups[1].rotation.set(currentPose === 'thinking' ? -1.2 : -perch * .35, 0, .11 + sway);
  rig.legGroups.forEach(({upper, lower}, index) => {
    upper.rotation.x = -perch * 1.38;
    lower.rotation.x = perch * 1.46 + (perch ? Math.sin(time * 2 + index) * .06 * intensity : 0);
  });
}

function animationFrame(now) {
  requestAnimationFrame(animationFrame);
  if (!renderer || !rig || now - lastFrame < 30) return;
  const delta = Math.min(.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const paused = state?.config.privacy.paused;
  const playfulness = state?.config.character.playfulness || 'balanced';
  const intensity = paused || reducedMotion ? 0 : playfulness === 'quiet' ? .35 : playfulness === 'playful' ? 1.4 : .8;
  if (!paused) elapsed += delta;
  look.x += ((paused ? 0 : targetLook.x) - look.x) * .11;
  look.y += ((paused ? 0 : targetLook.y) - look.y) * .11;
  perch += ((paused ? 0 : perchTarget) - perch) * .12;
  const isSpeaking = !paused && (localSpeechActive || now < speakingUntil);
  const isPat = !paused && now < patUntil;
  rig.root.position.y = Math.sin(elapsed * 1.6) * .007 * intensity + (dragging ? .04 : 0);
  rig.root.rotation.z = dragging ? Math.sin(elapsed * 6) * .04 : Math.sin(elapsed * .8) * .009 * intensity;
  if (rig.placeholder) posePlaceholder(elapsed, intensity, isSpeaking, isPat);
  else { poseVrm(elapsed, intensity, isSpeaking, isPat); vrm.update(paused ? 0 : delta); }
  renderer.render(scene, camera);
}

function inRect(x, y, element) {
  if (element.hidden) return false;
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function cursorAt(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  targetLook.x = THREE ? THREE.MathUtils.clamp((x - innerWidth / 2) / Math.max(100, innerWidth / 2), -1, 1) : 0;
  targetLook.y = THREE ? THREE.MathUtils.clamp((innerHeight * .35 - y) / Math.max(100, innerHeight * .45), -1, 1) : 0;
  const overControls = inRect(x, y, $('overlay-controls')) || inRect(x, y, $('speech-bubble')) || inRect(x, y, $('overlay-error'));
  hoveredHit = null;
  if (rig && raycaster && x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight) {
    pointer.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    hoveredHit = raycaster.intersectObject(rig.root, true)[0] || null;
  }
  const hot = overControls || Boolean(hoveredHit) || Boolean(pointerDown);
  document.body.classList.toggle('hovered', hot);
  setInteractive(hot);
}

function pat(hit) {
  if (state?.config.privacy.paused) return;
  let object = hit?.object;
  let isHead = hit?.point?.y > 1.27;
  while (object && object !== rig?.root) { if (object.userData.part === 'head') isHead = true; object = object.parent; }
  if (!isHead) return;
  patUntil = performance.now() + 1700;
  $('pat-heart').classList.remove('active');
  void $('pat-heart').offsetWidth;
  $('pat-heart').classList.add('active');
  setTimeout(() => $('pat-heart').classList.remove('active'), 1400);
}

async function bridgeAction(button, action) {
  button.disabled = true;
  try {
    const next = await action();
    if (next?.config) applyState(next);
  } catch (error) { bubble(errorText(error), 'Action unavailable', 10000); }
  finally { button.disabled = false; }
}

function bindInput() {
  document.addEventListener('pointermove', (event) => {
    cursorAt(event.clientX, event.clientY);
    if (!pointerDown || event.pointerId !== pointerDown.id) return;
    const distance = Math.hypot(event.screenX - pointerDown.x, event.screenY - pointerDown.y);
    if (!dragging && distance > 7) {
      dragging = true;
      document.body.classList.add('dragging');
      Promise.resolve(api.dragOverlay({phase: 'start', screenX: pointerDown.x, screenY: pointerDown.y})).catch((error) => bubble(errorText(error)));
    }
    if (dragging) Promise.resolve(api.dragOverlay({phase: 'move', screenX: event.screenX, screenY: event.screenY})).catch(() => {});
    updateLabels();
  });
  $('avatar-canvas').addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state?.config.privacy.paused) return;
    cursorAt(event.clientX, event.clientY);
    if (!hoveredHit) return;
    pointerDown = {id: event.pointerId, x: event.screenX, y: event.screenY, hit: hoveredHit};
    $('avatar-canvas').setPointerCapture(event.pointerId);
    setInteractive(true);
  });
  function finishDrag(event, cancelled = false) {
    if (!pointerDown) return;
    if (dragging) Promise.resolve(api.dragOverlay({phase: 'end', screenX: event.screenX, screenY: event.screenY})).catch(() => {});
    else if (!cancelled) pat(pointerDown.hit);
    if ($('avatar-canvas').hasPointerCapture(pointerDown.id)) $('avatar-canvas').releasePointerCapture(pointerDown.id);
    pointerDown = null;
    dragging = false;
    document.body.classList.remove('dragging');
    cursorAt(event.clientX, event.clientY);
    updateLabels();
  }
  document.addEventListener('pointerup', (event) => finishDrag(event));
  document.addEventListener('pointercancel', (event) => finishDrag(event, true));
  document.addEventListener('pointerleave', () => { if (!pointerDown) { document.body.classList.remove('hovered'); setInteractive(false); } });
  document.addEventListener('contextmenu', (event) => { event.preventDefault(); api.openSettings().catch((error) => bubble(errorText(error))); });
  $('avatar-canvas').addEventListener('dblclick', () => api.openSettings().catch((error) => bubble(errorText(error))));
  $('open-settings').addEventListener('click', () => bridgeAction($('open-settings'), () => api.openSettings()));
  $('pause-companion').addEventListener('click', () => bridgeAction($('pause-companion'), () => api.pauseAll()));
  $('hide-companion').addEventListener('click', () => bridgeAction($('hide-companion'), () => api.toggleOverlay()));
  $('quit-companion').addEventListener('click', () => bridgeAction($('quit-companion'), () => api.quit()));
  $('dismiss-bubble').addEventListener('click', () => { $('speech-bubble').hidden = true; clearTimeout(captionTimer); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !state?.config.privacy.paused) api.pauseAll().then(applyState).catch((error) => bubble(errorText(error))); });
  window.addEventListener('blur', () => { if (!pointerDown) setInteractive(false); });
}

function handleEvent(event) {
  if (event.type === 'state') applyState(event.state);
  else if (event.type === 'cursor') cursorAt(event.x, event.y);
  else if (event.type === 'pose') {
    currentPose = event.pose;
    if (event.pose === 'perched') perchTarget = state?.config.privacy.reactToWindows && !state.config.privacy.paused ? 1 : 0;
    if (event.pose === 'idle' || event.pose === 'paused') perchTarget = 0;
    updateLabels();
  } else if (event.type === 'dragging') {
    dragging = event.active;
    document.body.classList.toggle('dragging', dragging);
    updateLabels();
  } else if (event.type === 'chat-reply' && !state?.config.privacy.paused) {
    bubble(event.text, state?.config.character.speechEnabled ? '' : 'Captioned reply', Math.min(60000, Math.max(10000, event.text.length * 65)));
    speakingUntil = performance.now() + Math.min(12000, Math.max(1500, event.text.length * 35));
    speak(event.text);
  } else if (event.type === 'status' && event.text) bubble(event.text, '', 9000);
}

async function start() {
  if (!api) {
    $('overlay-error').textContent = 'Open this character through the Electron desktop app.';
    $('overlay-error').hidden = false;
    return;
  }
  bindInput();
  api.onEvent(handleEvent);
  if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', () => { localVoices = window.speechSynthesis.getVoices().filter((voice) => voice.localService); });
  }
  try {
    applyState(await api.getState());
    THREE = await import('three');
    ({GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js'));
    ({VRMLoaderPlugin, VRMUtils} = await import('@pixiv/three-vrm'));
    renderer = new THREE.WebGLRenderer({canvas: $('avatar-canvas'), antialias: true, alpha: true, powerPreference: 'low-power'});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, .05, 30);
    camera.position.set(0, 1.02, 4.65);
    camera.lookAt(0, 1.02, 0);
    scene.add(new THREE.HemisphereLight(0xf0eaff, 0x71879c, 2.1));
    const light = new THREE.DirectionalLight(0xfff4ed, 2.4);
    light.position.set(-1.3, 2.7, 3);
    scene.add(light);
    const rim = new THREE.DirectionalLight(0xb4e8dc, 1.2);
    rim.position.set(1.5, 1, -1.5);
    scene.add(rim);
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    const resize = () => { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
    window.addEventListener('resize', resize);
    resize();
    await loadAvatar(state.config.character.modelName);
    requestAnimationFrame(animationFrame);
    setInteractive(false);
  } catch (error) {
    $('overlay-error').textContent = 'The 3D character could not start. Open settings to keep using chat.\n\n' + errorText(error);
    $('overlay-error').hidden = false;
    setInteractive(true);
  }
  updateLabels();
}

window.addEventListener('beforeunload', () => { stopSpeech(); clearTimeout(captionTimer); renderer?.dispose(); });
start();

'use strict';
// Remote Play viewer: receives the PC's screen over WebRTC and sends keyboard
// and mouse input back over data channels.

const $ = (id) => document.getElementById(id);
const els = {
  login: $('login'), form: $('login-form'), key: $('key'), remember: $('remember'),
  loginBtn: $('login-btn'), loginError: $('login-error'),
  stage: $('stage'), bar: $('bar'), video: $('video'),
  overlay: $('overlay'), overlayText: $('overlay-text'), overlayBtn: $('overlay-btn'),
  statusDot: $('status-dot'), statusText: $('status-text'), stats: $('stats'),
  screen: $('screen-select'), quality: $('quality-select'), mouseMode: $('mouse-mode'),
  sens: $('sens'), sensValue: $('sens-value'),
  fullscreen: $('fullscreen-btn'), signOut: $('disconnect-btn'),
};

// ---------------------------------------------------------------------------
// Storage (wrapped: private windows can throw)

const KEY_STORE = 'remoteplay.key';
const PREFS_STORE = 'remoteplay.prefs';

function storageGet(store, k) { try { return store.getItem(k); } catch { return null; } }
function storageSet(store, k, v) { try { store.setItem(k, v); } catch { /* ignore */ } }
function storageDel(store, k) { try { store.removeItem(k); } catch { /* ignore */ } }

function loadSavedKey() {
  return storageGet(sessionStorage, KEY_STORE) || storageGet(localStorage, KEY_STORE);
}
function saveKey(key, remember) {
  storageSet(sessionStorage, KEY_STORE, key);
  if (remember) storageSet(localStorage, KEY_STORE, key);
}
function forgetKey() {
  storageDel(sessionStorage, KEY_STORE);
  storageDel(localStorage, KEY_STORE);
}

const prefs = Object.assign({ quality: '720:6', mouseMode: 'game', sensitivity: 1 },
  (() => { try { return JSON.parse(storageGet(localStorage, PREFS_STORE)) || {}; } catch { return {}; } })());
function savePrefs() { storageSet(localStorage, PREFS_STORE, JSON.stringify(prefs)); }

// ---------------------------------------------------------------------------
// State

const state = {
  key: null,
  remember: false,
  ws: null,
  authed: false,
  retry: 0,
  retryTimer: null,
  iceServers: [],
  hostOnline: false,
  phase: 'connecting', // connecting | offline | starting | live | failed | replaced
  failures: 0,
  session: null, // { sid, pc, input, mouse, ready, pending }
  signalQueue: Promise.resolve(),
  pressedKeys: new Set(),
  pressedButtons: new Set(),
  lastEscAt: 0,
  expectUnlock: false,
  wheel: { x: 0, y: 0, at: 0 },
  moveRemainder: { x: 0, y: 0 }, // sub-pixel movement left over after scaling
  prevStats: null,
};

const mode = () => els.mouseMode.value;
const isLocked = () => document.pointerLockElement === els.stage;
const isLive = () => state.session?.pc.connectionState === 'connected';

// ---------------------------------------------------------------------------
// UI

function showLogin(error = '', clearKey = false) {
  if (clearKey) forgetKey();
  closeSocket();
  closeSession();
  els.stage.hidden = true;
  els.login.hidden = false;
  els.loginBtn.disabled = false;
  els.loginBtn.textContent = 'Connect';
  els.loginError.textContent = error;
  els.key.focus();
}

function showStage() {
  els.login.hidden = true;
  els.stage.hidden = false;
}

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind}`;
  els.statusText.textContent = text;
}

function setPhase(phase) {
  state.phase = phase;
  const labels = {
    connecting: ['warn', 'Connecting…'],
    offline: ['bad', 'PC offline'],
    starting: ['warn', 'Starting stream…'],
    live: ['ok', 'Live'],
    failed: ['bad', 'No connection'],
    replaced: ['bad', 'Opened elsewhere'],
  };
  setStatus(...labels[phase]);
  updateUi();
}

function setOverlay(text, buttonLabel = null, onClick = null, hint = false) {
  els.overlayText.textContent = text;
  els.overlay.classList.toggle('hint', hint);
  els.overlayBtn.hidden = !buttonLabel;
  if (buttonLabel) {
    els.overlayBtn.textContent = buttonLabel;
    els.overlayBtn.onclick = onClick;
  }
}

function updateUi() {
  const locked = isLocked();
  els.stage.classList.toggle('locked', locked);
  els.fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';

  switch (state.phase) {
    case 'connecting': return setOverlay('Connecting to server…');
    case 'offline': return setOverlay('Your PC is offline. Start the host app on it.');
    case 'starting': return setOverlay('Starting stream…');
    case 'failed':
      return setOverlay(state.failures >= 2
        ? 'Can\'t reach your PC from this network. If you\'re on library or school wifi, set up a TURN relay (see README).'
        : 'Connection lost. Retrying…');
    case 'replaced':
      return setOverlay('This stream was opened in another tab or device.', 'Reconnect', () => {
        state.retry = 0;
        connect();
      });
    case 'live':
      if (mode() === 'game' && !locked) {
        return setOverlay('Click to play. Press Ctrl + Alt to get your mouse back.', null, null, true);
      }
      return setOverlay('');
  }
}

// ---------------------------------------------------------------------------
// Signaling

function closeSocket() {
  clearTimeout(state.retryTimer);
  const ws = state.ws;
  state.ws = null;
  if (ws) ws.close();
}

// The server address comes from config.js; empty means "the site serving this page".
function signalingUrl() {
  const base = String(window.REMOTE_PLAY_SERVER || '').trim();
  if (!base) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const url = new URL(base, location.href);
  url.protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws:' : 'wss:';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  return url.toString();
}

function connect() {
  closeSocket();
  if (state.authed) setPhase('connecting');
  const ws = new WebSocket(signalingUrl());
  state.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role: 'viewer', key: state.key }));

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'auth-ok') {
      state.authed = true;
      state.retry = 0;
      state.iceServers = msg.iceServers || [];
      saveKey(state.key, state.remember);
      showStage();
      onHostStatus(msg.hostOnline);
    } else if (msg.type === 'host-status') {
      onHostStatus(msg.online);
    } else if (msg.type === 'signal') {
      enqueue(() => onSignal(msg.data));
    }
  };

  ws.onclose = (ev) => {
    if (state.ws !== ws) return; // we closed it on purpose
    state.ws = null;
    closeSession();
    if (ev.code === 4003) return showLogin('Wrong access key.', true);
    if (ev.code === 4029) return showLogin('Too many wrong keys. Try again in 15 minutes.');
    if (ev.code === 4010) return setPhase('replaced');
    if (!state.authed) {
      return showLogin('Couldn\'t reach the server. If it was asleep it may need a minute to wake up, so try again.');
    }
    const delay = Math.min(15000, 1000 * 2 ** state.retry++);
    setPhase('connecting');
    setStatus('warn', `Reconnecting in ${Math.round(delay / 1000)}s…`);
    state.retryTimer = setTimeout(connect, delay);
  };
}

function signal(data) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'signal', data }));
}

// Process signaling messages one at a time so ICE candidates never race the offer.
function enqueue(fn) {
  state.signalQueue = state.signalQueue.then(fn).catch((err) => console.error(err));
}

function onHostStatus(online) {
  state.hostOnline = !!online;
  if (!online) {
    closeSession();
    setPhase('offline');
  } else if (!state.session) {
    setPhase('starting');
  }
}

async function onSignal(d) {
  if (!d || typeof d !== 'object') return;
  if (d.kind === 'offer') return acceptOffer(d);
  const s = state.session;
  if (!s || d.sid !== s.sid) return;
  if (d.kind === 'candidate') {
    try { await s.pc.addIceCandidate(d.candidate); } catch (err) { console.warn('bad candidate', err); }
  }
}

async function acceptOffer(d) {
  closeSession();
  setPhase('starting');
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const s = { sid: d.sid, pc, input: null, mouse: null, ready: false, pending: [] };
  state.session = s;

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const msg = { kind: 'candidate', sid: s.sid, candidate: e.candidate.toJSON() };
    if (s.ready) signal(msg); else s.pending.push(msg);
  };
  pc.ontrack = (e) => {
    // Ask for the smallest possible playout buffer: we want latency, not smoothness.
    try { e.receiver.jitterBufferTarget = 0; } catch { /* unsupported */ }
    try { e.receiver.playoutDelayHint = 0; } catch { /* unsupported */ }
    els.video.srcObject = e.streams[0] || new MediaStream([e.track]);
    els.video.play().catch(() => {});
  };
  pc.ondatachannel = (e) => setupChannel(s, e.channel);
  pc.onconnectionstatechange = () => onConnectionState(s);

  await pc.setRemoteDescription(d.sdp);
  if (state.session !== s) return;
  await pc.setLocalDescription();
  if (state.session !== s) return;
  signal({ kind: 'answer', sid: s.sid, sdp: pc.localDescription });
  s.ready = true;
  s.pending.splice(0).forEach(signal);
}

function onConnectionState(s) {
  if (state.session !== s) return;
  const st = s.pc.connectionState;
  if (st === 'connected') {
    state.failures = 0;
    setPhase('live');
  } else if (st === 'disconnected') {
    setStatus('warn', 'Connection unstable…');
  } else if (st === 'failed') {
    state.failures += 1;
    releaseLocalInput();
    setPhase('failed');
    // Ask the host for a fresh offer after a short pause.
    setTimeout(() => { if (state.session === s) signal({ kind: 'restart' }); }, 1500);
  }
}

function closeSession() {
  const s = state.session;
  state.session = null;
  state.pressedKeys.clear();
  state.pressedButtons.clear();
  state.prevStats = null;
  els.stats.textContent = '';
  if (s) {
    try { s.pc.close(); } catch { /* ignore */ }
  }
  els.video.srcObject = null;
  els.screen.disabled = true;
}

// ---------------------------------------------------------------------------
// Data channels

function setupChannel(s, ch) {
  if (ch.label === 'input') {
    s.input = ch;
    ch.onopen = () => sendQuality();
    ch.onmessage = (e) => onHostMessage(e.data);
  } else if (ch.label === 'mouse') {
    s.mouse = ch;
  }
}

function sendInput(msg) {
  const ch = state.session?.input;
  if (ch?.readyState === 'open') ch.send(JSON.stringify(msg));
}

function sendMouse(msg) {
  const ch = state.session?.mouse;
  // Mouse moves are disposable: skip them rather than queue behind a congested link.
  if (ch?.readyState === 'open' && ch.bufferedAmount < 16384) ch.send(JSON.stringify(msg));
}

function onHostMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.t === 'screens' && Array.isArray(msg.list)) {
    els.screen.replaceChildren(...msg.list.map((sc) => {
      const opt = document.createElement('option');
      opt.value = sc.id;
      opt.textContent = sc.name;
      return opt;
    }));
    els.screen.value = msg.current;
    els.screen.disabled = msg.list.length < 2;
  }
}

function sendQuality() {
  const [height, mbps] = els.quality.value.split(':').map(Number);
  sendInput({ t: 'quality', height, mbps });
}

// ---------------------------------------------------------------------------
// Fullscreen, pointer lock, keyboard lock

async function lockPointer() {
  try {
    // unadjustedMovement = raw mouse deltas without OS acceleration (Chrome/Edge).
    await els.stage.requestPointerLock({ unadjustedMovement: true });
  } catch {
    try { await els.stage.requestPointerLock(); } catch { /* user can click again */ }
  }
}

async function enterFullscreen() {
  if (document.fullscreenElement) return;
  try {
    await els.stage.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    return;
  }
  // Keyboard Lock (Chrome/Edge, fullscreen only) lets Esc, Ctrl+W, Alt+Tab-ish keys
  // reach the game instead of the browser. Holding Esc still exits fullscreen.
  try { await navigator.keyboard?.lock?.(); } catch { /* unsupported */ }
}

function startGame() {
  els.video.focus();
  const lock = lockPointer(); // must start synchronously inside the click
  enterFullscreen();
  return lock;
}

function releaseMouse() {
  if (isLocked()) {
    state.expectUnlock = true;
    document.exitPointerLock();
  }
}

document.addEventListener('pointerlockchange', () => {
  if (!isLocked()) {
    releaseLocalInput();
    const unexpected = !state.expectUnlock && document.hasFocus() && !document.hidden;
    state.expectUnlock = false;
    // Without Keyboard Lock the browser swallows Esc to release the mouse.
    // Forward it anyway so the game still opens its pause menu.
    if (unexpected && isLive() && mode() === 'game' && performance.now() - state.lastEscAt > 500) {
      tapKey('Escape');
    }
  }
  updateUi();
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
    releaseMouse();
    releaseLocalInput();
    els.stage.classList.remove('show-bar');
  }
  updateUi();
});

els.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else enterFullscreen();
});

// ---------------------------------------------------------------------------
// Keyboard

function capturingKeys() {
  return isLive() && (isLocked() || document.activeElement === els.video);
}

function tapKey(code) {
  sendInput({ t: 'kd', c: code });
  sendInput({ t: 'ku', c: code });
}

window.addEventListener('keydown', (e) => {
  if (!capturingKeys() || !e.code) return;
  e.preventDefault();
  e.stopPropagation();
  // Ctrl+Alt gives the mouse back to this computer (like a virtual machine).
  if (isLocked() && e.ctrlKey && e.altKey && /^(Control|Alt)/.test(e.code)) {
    releaseMouse();
    return;
  }
  if (e.code === 'Escape') state.lastEscAt = performance.now();
  state.pressedKeys.add(e.code);
  sendInput({ t: 'kd', c: e.code });
}, true);

window.addEventListener('keyup', (e) => {
  // Always release keys we pressed, even if focus moved in the meantime.
  if (!state.pressedKeys.delete(e.code)) return;
  e.preventDefault();
  sendInput({ t: 'ku', c: e.code });
}, true);

// Let go of everything on the PC so nothing gets stuck held down.
function releaseLocalInput() {
  for (const c of state.pressedKeys) sendInput({ t: 'ku', c });
  for (const b of state.pressedButtons) sendInput({ t: 'mu', b });
  state.pressedKeys.clear();
  state.pressedButtons.clear();
  sendInput({ t: 'ra' });
}

window.addEventListener('blur', () => {
  state.expectUnlock = true;
  releaseLocalInput();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseLocalInput();
});

// ---------------------------------------------------------------------------
// Mouse

// Position inside the actual picture (the video is letterboxed), 0..1 on each axis.
function videoPoint(e) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return null;
  const r = els.video.getBoundingClientRect();
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = (e.clientX - (r.left + (r.width - w) / 2)) / w;
  const y = (e.clientY - (r.top + (r.height - h) / 2)) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

const inToolbar = (e) => !isLocked() && e.target instanceof Element && !!e.target.closest('#bar');

els.stage.addEventListener('mousedown', (e) => {
  if (inToolbar(e) || !isLive()) return;
  e.preventDefault();
  if (mode() === 'game') {
    if (!isLocked()) { startGame(); return; } // this click only captures the mouse
  } else {
    els.video.focus();
    const p = videoPoint(e);
    if (!p) return;
    sendInput({ t: 'ma', x: p.x, y: p.y }); // same channel as the click, so it lands first
  }
  state.pressedButtons.add(e.button);
  sendInput({ t: 'md', b: e.button });
});

window.addEventListener('mouseup', (e) => {
  if (state.pressedButtons.delete(e.button)) sendInput({ t: 'mu', b: e.button });
});

document.addEventListener('mousemove', (e) => {
  if (document.fullscreenElement && !isLocked()) {
    // Reveal the toolbar when the mouse touches the top edge.
    const near = e.clientY <= 4 || (els.stage.classList.contains('show-bar') && e.clientY < els.bar.offsetHeight + 12);
    els.stage.classList.toggle('show-bar', near);
  }
  if (!isLive()) return;
  if (isLocked()) {
    // Scale by the sensitivity slider. Keep the fractions so slow, low-sensitivity
    // movements still add up instead of rounding away to nothing.
    const k = Number(els.sens.value) || 1;
    const r = state.moveRemainder;
    r.x += e.movementX * k;
    r.y += e.movementY * k;
    const dx = Math.trunc(r.x);
    const dy = Math.trunc(r.y);
    r.x -= dx;
    r.y -= dy;
    if (dx || dy) sendMouse({ t: 'mm', x: dx, y: dy });
  } else if (mode() === 'desktop' && !inToolbar(e)) {
    const p = videoPoint(e);
    if (p) sendMouse({ t: 'ma', x: p.x, y: p.y });
  }
});

els.stage.addEventListener('contextmenu', (e) => {
  if (!inToolbar(e)) e.preventDefault();
});

els.stage.addEventListener('wheel', (e) => {
  if (inToolbar(e) || !isLive()) return;
  if (!isLocked() && !(mode() === 'desktop' && videoPoint(e))) return;
  e.preventDefault();
  // Convert to wheel "notches". Mice give ~100px per notch, trackpads give
  // small deltas that we add up until they reach a whole notch.
  const perNotch = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100;
  const w = state.wheel;
  if (performance.now() - w.at > 250) { w.x = 0; w.y = 0; }
  w.at = performance.now();
  w.x += e.deltaX / perNotch;
  w.y += e.deltaY / perNotch;
  const nx = Math.trunc(w.x);
  const ny = Math.trunc(w.y);
  if (nx || ny) {
    w.x -= nx;
    w.y -= ny;
    sendInput({ t: 'wh', x: nx, y: ny });
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// Toolbar

els.screen.addEventListener('change', () => {
  sendInput({ t: 'screen', id: els.screen.value });
  els.video.focus();
});

els.quality.value = prefs.quality;
if (!els.quality.value) els.quality.value = '720:6';
els.quality.addEventListener('change', () => {
  prefs.quality = els.quality.value;
  savePrefs();
  sendQuality();
  els.video.focus();
});

els.mouseMode.value = prefs.mouseMode === 'desktop' ? 'desktop' : 'game';
els.mouseMode.addEventListener('change', () => {
  prefs.mouseMode = els.mouseMode.value;
  savePrefs();
  if (mode() === 'desktop') releaseMouse();
  els.video.focus();
  updateUi();
});

function showSensitivity() {
  els.sensValue.textContent = `${Number(els.sens.value).toFixed(2)}×`;
}
els.sens.value = String(Math.min(3, Math.max(0.25, Number(prefs.sensitivity) || 1)));
showSensitivity();
els.sens.addEventListener('input', () => {
  showSensitivity();
  prefs.sensitivity = Number(els.sens.value);
  savePrefs();
});
els.sens.addEventListener('change', () => els.video.focus());

els.signOut.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  state.authed = false;
  showLogin('', true);
});

// ---------------------------------------------------------------------------
// Stats

setInterval(async () => {
  const s = state.session;
  if (!s || !isLive()) return;
  const report = await s.pc.getStats();
  let inbound = null;
  let pairId = null;
  let fallbackPair = null;
  report.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
    if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') fallbackPair = r;
  });
  const pair = (pairId && report.get(pairId)) || fallbackPair;
  if (!inbound) return;

  const parts = [];
  if (inbound.frameWidth) parts.push(`${inbound.frameWidth}×${inbound.frameHeight}`);
  if (inbound.framesPerSecond != null) parts.push(`${Math.round(inbound.framesPerSecond)} fps`);
  const prev = state.prevStats;
  if (prev && inbound.timestamp > prev.timestamp) {
    const mbps = ((inbound.bytesReceived - prev.bytes) * 8) / ((inbound.timestamp - prev.timestamp) * 1000);
    parts.push(`${mbps.toFixed(1)} Mbps`);
  }
  state.prevStats = { timestamp: inbound.timestamp, bytes: inbound.bytesReceived };
  if (pair?.currentRoundTripTime != null) parts.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms`);
  const local = pair && report.get(pair.localCandidateId);
  if (local) {
    parts.push(local.candidateType === 'relay'
      ? `relay/${local.relayProtocol || local.protocol}`
      : `direct/${local.protocol}`);
  }
  els.stats.textContent = parts.join(' · ');
}, 1000);

// ---------------------------------------------------------------------------
// Start

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const key = els.key.value.trim();
  if (!key) return;
  state.key = key;
  state.remember = els.remember.checked;
  state.authed = false;
  els.key.value = '';
  els.loginError.textContent = '';
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'Connecting…';
  connect();
});

const saved = loadSavedKey();
if (saved) {
  state.key = saved;
  state.remember = !!storageGet(localStorage, KEY_STORE);
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'Connecting…';
  connect();
} else {
  showLogin();
}

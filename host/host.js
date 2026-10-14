'use strict';
// Host window: captures the screen, streams it over WebRTC, and forwards the
// viewer's input to the main process for injection.

const $ = (id) => document.getElementById(id);

const QUALITY_HEIGHTS = [360, 540, 720, 1080, 1440];

const state = {
  cfg: null,
  ws: null,
  retry: 0,
  iceServers: [],
  screens: [],
  screenId: null,
  quality: { height: 720, mbps: 6 },
  session: null, // { sid, pc, sender, stream, input, mouse, ready, pending }
  queue: Promise.resolve(),
};

// ---------------------------------------------------------------------------
// UI

function log(text) {
  const el = $('log');
  const time = new Date().toLocaleTimeString();
  el.textContent = `[${time}] ${text}\n${el.textContent}`.slice(0, 20000);
}

function setRow(id, kind, text) {
  $(`${id}-dot`).className = `dot ${kind}`;
  $(id).textContent = text;
  host.setStatus(`${$('server').textContent} · ${$('viewer').textContent}`);
}

// ---------------------------------------------------------------------------
// Signaling

function connect() {
  setRow('server', 'warn', 'Connecting…');
  const ws = new WebSocket(state.cfg.serverUrl);
  state.ws = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', role: 'host', key: state.cfg.accessKey }));

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'auth-ok':
        state.retry = 0;
        state.iceServers = msg.iceServers || [];
        setRow('server', 'ok', `Online · ${new URL(state.cfg.serverUrl).host}`);
        log(`Connected to server (${state.iceServers.some((s) => [].concat(s.urls).some((u) => u.startsWith('turn'))) ? 'TURN relay available' : 'no TURN relay configured'})`);
        break;
      case 'viewer-joined':
        log('Viewer joined');
        enqueue(startSession);
        break;
      case 'viewer-left':
        log('Viewer left');
        enqueue(() => stopSession());
        break;
      case 'signal':
        enqueue(() => onSignal(msg.data));
        break;
      default:
        break;
    }
  };

  ws.onclose = (ev) => {
    if (state.ws !== ws) return;
    state.ws = null;
    enqueue(() => stopSession());
    if (ev.code === 4003) {
      setRow('server', 'bad', 'Wrong access key: fix config.json and restart');
      log('Server rejected the access key.');
      return;
    }
    if (ev.code === 4010) {
      setRow('server', 'bad', 'Another host app took over');
      log('Another host connected with the same key; this one stopped.');
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** state.retry++);
    setRow('server', 'warn', `Offline · retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
  };
}

// Keep free hosting from idling the connection.
setInterval(() => {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'ping' }));
}, 30000);

function signal(data) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'signal', data }));
}

// Run session changes and signaling one at a time, in order.
function enqueue(fn) {
  state.queue = state.queue.then(fn).catch((err) => log(`Error: ${err.message || err}`));
}

async function onSignal(d) {
  if (!d || typeof d !== 'object') return;
  if (d.kind === 'restart') {
    log('Viewer asked to reconnect');
    return startSession();
  }
  const s = state.session;
  if (!s || d.sid !== s.sid) return;
  if (d.kind === 'answer') {
    await s.pc.setRemoteDescription(d.sdp);
  } else if (d.kind === 'candidate') {
    try { await s.pc.addIceCandidate(d.candidate); } catch (err) { log(`Bad ICE candidate: ${err.message}`); }
  }
}

// ---------------------------------------------------------------------------
// Capture

function currentScreen() {
  return state.screens.find((sc) => sc.id === state.screenId) || state.screens[0];
}

async function capture() {
  const sc = currentScreen();
  if (!sc) throw new Error('No screens found to capture');
  state.screenId = sc.id;
  // Scale to the chosen height, keeping the screen's shape; never upscale.
  const height = Math.min(state.quality.height, sc.height);
  const width = Math.round((sc.width * height) / sc.height);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sc.id,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: 60,
      },
    },
  });
  const track = stream.getVideoTracks()[0];
  // 'motion' tells the encoder to keep the frame rate up and drop detail instead.
  track.contentHint = 'motion';
  host.setActiveScreen(sc.id);
  return stream;
}

async function applyEncoding(sender) {
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  const enc = params.encodings[0];
  enc.maxBitrate = state.quality.mbps * 1_000_000;
  enc.maxFramerate = 60;
  enc.priority = 'high';
  enc.networkPriority = 'high';
  params.degradationPreference = 'maintain-framerate';
  try {
    await sender.setParameters(params);
  } catch (err) {
    log(`Couldn't set encoder options: ${err.message}`);
  }
}

// H.264 first: it is the codec most likely to use the GPU encoder.
function preferCodecs(transceiver) {
  if (!transceiver.setCodecPreferences) return;
  const caps = RTCRtpSender.getCapabilities?.('video') || RTCRtpReceiver.getCapabilities('video');
  const rank = (c) => {
    const m = c.mimeType.toLowerCase();
    if (m === 'video/h264') return /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1;
    if (m === 'video/vp8') return 2;
    if (m === 'video/vp9') return 3;
    return 4;
  };
  const codecs = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (err) {
    log(`Using default codec order (${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Sessions (one per viewer connection)

async function startSession() {
  stopSession();
  const s = { sid: crypto.randomUUID(), pc: null, sender: null, stream: null, input: null, mouse: null, ready: false, pending: [] };
  state.session = s;

  state.screens = await host.getScreens();
  s.stream = await capture();

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  s.pc = pc;
  const transceiver = pc.addTransceiver(s.stream.getVideoTracks()[0], { direction: 'sendonly', streams: [s.stream] });
  s.sender = transceiver.sender;
  preferCodecs(transceiver);

  // Keys and clicks must arrive, in order. Mouse movement is disposable.
  s.input = pc.createDataChannel('input', { ordered: true });
  s.mouse = pc.createDataChannel('mouse', { ordered: false, maxRetransmits: 0 });
  s.input.onopen = () => sendScreens(s);
  s.input.onmessage = (e) => onViewerMessage(e.data);
  s.mouse.onmessage = (e) => onViewerMessage(e.data);
  s.input.onclose = () => host.releaseAll();

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const msg = { kind: 'candidate', sid: s.sid, candidate: e.candidate.toJSON() };
    if (s.ready) signal(msg); else s.pending.push(msg);
  };
  pc.onconnectionstatechange = () => {
    if (state.session !== s) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      setRow('viewer', 'ok', 'Watching');
      host.setStreaming(true);
      logRoute(s);
    } else if (st === 'disconnected') {
      setRow('viewer', 'warn', 'Connection unstable');
    } else if (st === 'failed') {
      setRow('viewer', 'bad', 'Connection failed');
      host.releaseAll();
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  await applyEncoding(s.sender);
  if (state.session !== s) return;
  signal({ kind: 'offer', sid: s.sid, sdp: pc.localDescription });
  s.ready = true;
  s.pending.splice(0).forEach(signal);
  setRow('viewer', 'warn', 'Connecting…');
}

function stopSession() {
  const s = state.session;
  state.session = null;
  host.releaseAll();
  host.setStreaming(false);
  if (!s) return;
  try { s.pc?.close(); } catch { /* ignore */ }
  s.stream?.getTracks().forEach((t) => t.stop());
  setRow('viewer', '', 'Nobody connected');
  $('sending').textContent = '–';
  $('encoder').textContent = '–';
}

function sendScreens(s) {
  if (s.input?.readyState !== 'open') return;
  s.input.send(JSON.stringify({
    t: 'screens',
    list: state.screens.map(({ id, name }) => ({ id, name })),
    current: state.screenId,
  }));
}

// Swap the captured screen or resolution without renegotiating the call.
async function recapture() {
  const s = state.session;
  if (!s?.sender) return;
  const stream = await capture();
  if (state.session !== s) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  await s.sender.replaceTrack(stream.getVideoTracks()[0]);
  s.stream.getTracks().forEach((t) => t.stop());
  s.stream = stream;
  await applyEncoding(s.sender);
}

function onViewerMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.t === 'screen') {
    if (msg.id === state.screenId || !state.screens.some((sc) => sc.id === msg.id)) return;
    enqueue(async () => {
      host.releaseAll();
      state.screenId = msg.id;
      await recapture();
      log(`Switched to ${currentScreen().name}`);
      if (state.session) sendScreens(state.session);
    });
  } else if (msg.t === 'quality') {
    const height = QUALITY_HEIGHTS.includes(msg.height) ? msg.height : 720;
    const mbps = Math.min(50, Math.max(1, Number(msg.mbps) || 6));
    if (height === state.quality.height && mbps === state.quality.mbps) return;
    enqueue(async () => {
      const resChanged = height !== state.quality.height;
      state.quality = { height, mbps };
      if (resChanged) await recapture();
      else if (state.session?.sender) await applyEncoding(state.session.sender);
      log(`Quality set to ${height}p at ${mbps} Mbps`);
    });
  } else {
    host.input(msg);
  }
}

// ---------------------------------------------------------------------------
// Stats

async function logRoute(s) {
  const report = await s.pc.getStats();
  report.forEach((r) => {
    if (r.type !== 'transport' || !r.selectedCandidatePairId) return;
    const pair = report.get(r.selectedCandidatePairId);
    const local = pair && report.get(pair.localCandidateId);
    const remote = pair && report.get(pair.remoteCandidateId);
    if (local && remote) {
      const relayed = local.candidateType === 'relay' || remote.candidateType === 'relay';
      log(`Viewer connected ${relayed ? 'through the TURN relay' : 'directly'} (${remote.protocol})`);
    }
  });
}

let prevOut = null;
setInterval(async () => {
  const s = state.session;
  if (!s?.pc || s.pc.connectionState !== 'connected') { prevOut = null; return; }
  const report = await s.pc.getStats();
  let out = null;
  report.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
  if (!out) return;
  const parts = [];
  if (out.frameWidth) parts.push(`${out.frameWidth}×${out.frameHeight}`);
  if (out.framesPerSecond != null) parts.push(`${Math.round(out.framesPerSecond)} fps`);
  if (prevOut && out.timestamp > prevOut.timestamp) {
    parts.push(`${(((out.bytesSent - prevOut.bytes) * 8) / ((out.timestamp - prevOut.timestamp) * 1000)).toFixed(1)} Mbps`);
  }
  prevOut = { timestamp: out.timestamp, bytes: out.bytesSent };
  if (out.qualityLimitationReason && out.qualityLimitationReason !== 'none') {
    parts.push(`limited by ${out.qualityLimitationReason}`);
  }
  $('sending').textContent = parts.join(' · ') || '–';
  const codec = out.codecId && report.get(out.codecId);
  $('encoder').textContent = [codec?.mimeType?.replace('video/', ''), out.encoderImplementation].filter(Boolean).join(' · ') || '–';
}, 1000);

// ---------------------------------------------------------------------------

(async () => {
  state.cfg = await host.getConfig();
  connect();
})();

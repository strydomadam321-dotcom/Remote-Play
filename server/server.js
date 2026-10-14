'use strict';
// Remote Play signaling server.
// Serves the browser viewer and relays WebRTC setup messages between the host
// app on your PC and the viewer. Video and input never pass through here: they
// go peer-to-peer (or through a TURN relay when the network blocks that).

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || '';

if (ACCESS_KEY.length < 16) {
  console.error('Set the ACCESS_KEY environment variable to a random string of at least 16 characters.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------------------------------------------------------------------------
// Auth

function keyMatches(given) {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ACCESS_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket.remoteAddress;
}

// Slow down key guessing: 10 wrong keys from one IP locks it out for 15 minutes.
const failures = new Map(); // ip -> { count, until }
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function isBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.until && Date.now() > f.until) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function noteFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  f.until = Date.now() + LOCKOUT_MS;
  failures.set(ip, f);
}

// ---------------------------------------------------------------------------
// ICE servers (STUN + optional TURN)
//
// Library / school wifi often blocks direct peer-to-peer UDP. A TURN relay that
// listens on TCP/TLS port 443 gets through almost anything, so configure one:
//   Cloudflare TURN:  CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   Any other TURN:   TURN_URLS (comma separated) + TURN_USERNAME + TURN_CREDENTIAL

let iceCache = { servers: null, expires: 0 };

async function getIceServers() {
  if (iceCache.servers && Date.now() < iceCache.expires) return iceCache.servers;

  const servers = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  const env = process.env;

  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const list = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
      for (const s of list) {
        if (!s || !s.urls) continue;
        // Browsers time out on port 53, so drop those URLs.
        const urls = [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u));
        if (urls.length) servers.push({ ...s, urls });
      }
    } catch (err) {
      console.warn('Cloudflare TURN credential request failed:', err.message);
    }
  }

  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    servers.push({
      urls: env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
      username: env.TURN_USERNAME,
      credential: env.TURN_CREDENTIAL,
    });
  }

  iceCache = { servers, expires: Date.now() + 6 * 60 * 60 * 1000 };
  return servers;
}

// ---------------------------------------------------------------------------
// Signaling: one host (your PC) and one viewer at a time.
// A newer connection of the same role replaces the older one, so reconnecting
// from flaky wifi never gets stuck behind a half-dead socket.

let host = null;
let viewer = null;

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.close(4000, 'bad message'); }
    if (!msg || typeof msg !== 'object') return;

    if (!ws.role) {
      if (msg.type !== 'auth' || ws.authPending) return;
      ws.authPending = true;
      if (isBlocked(ip)) return ws.close(4029, 'too many attempts');
      if (!keyMatches(msg.key) || (msg.role !== 'host' && msg.role !== 'viewer')) {
        noteFailure(ip);
        console.log(`[auth] rejected ${msg.role} from ${ip}`);
        return setTimeout(() => ws.close(4003, 'wrong key'), 1000);
      }
      failures.delete(ip);
      clearTimeout(authTimer);

      const iceServers = await getIceServers();
      if (ws.readyState !== ws.OPEN) return;
      ws.role = msg.role;

      if (ws.role === 'host') {
        if (host) host.close(4010, 'replaced by a newer host');
        host = ws;
        send(ws, { type: 'auth-ok', iceServers });
        send(viewer, { type: 'host-status', online: true });
        if (viewer) send(host, { type: 'viewer-joined' });
      } else {
        if (viewer) viewer.close(4010, 'replaced by a newer viewer');
        viewer = ws;
        send(ws, { type: 'auth-ok', iceServers, hostOnline: !!host });
        if (host) send(host, { type: 'viewer-joined' });
      }
      console.log(`[auth] ${ws.role} connected from ${ip}`);
      return;
    }

    if (msg.type === 'signal') {
      send(ws.role === 'host' ? viewer : host, { type: 'signal', data: msg.data });
    }
    // Anything else (e.g. app-level keepalive pings) is ignored.
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws === host) {
      host = null;
      send(viewer, { type: 'host-status', online: false });
      console.log('[ws] host disconnected');
    }
    if (ws === viewer) {
      viewer = null;
      send(host, { type: 'viewer-left' });
      console.log('[ws] viewer disconnected');
    }
  });
});

// Drop sockets that stopped answering pings, and keep proxies from idling them out.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`Remote Play server on http://localhost:${PORT}`));

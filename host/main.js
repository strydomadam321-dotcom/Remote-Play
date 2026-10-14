'use strict';
// Remote Play host: runs on the PC you want to control.
// The window (host.html) handles screen capture and WebRTC; this process
// injects the keyboard/mouse input it receives.

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'win32') {
  console.error('The Remote Play host only supports Windows.');
  process.exit(1);
}

// Keep capturing and encoding at full speed while the window is minimized.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) process.exit(0);

const input = require('./input');

let win = null;
let config = null;
let displaySleepBlocker = null;
let screenSources = new Map(); // source id -> physical rect

function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) {
    throw new Error('config.json is missing. Copy config.example.json to config.json and fill it in.');
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^wss?:\/\//.test(cfg.serverUrl || '')) throw new Error('config.json: serverUrl must start with wss:// (or ws:// for local testing).');
  if (typeof cfg.accessKey !== 'string' || cfg.accessKey.length < 16) throw new Error('config.json: accessKey must be the ACCESS_KEY from your server.');
  return cfg;
}

async function listScreens() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  screenSources = new Map();
  return sources.map((src, i) => {
    const d = displays.find((dd) => String(dd.id) === String(src.display_id)) || (sources.length === 1 ? displays[0] : null);
    const rect = d ? screen.dipToScreenRect(null, d.bounds) : null;
    screenSources.set(src.id, rect);
    const size = rect ? ` · ${rect.width}×${rect.height}` : '';
    const main = d && d.id === primaryId ? ' (main)' : '';
    return { id: src.id, name: `Screen ${i + 1}${size}${main}`, width: rect?.width || 1920, height: rect?.height || 1080 };
  });
}

app.whenReady().then(() => {
  try {
    config = loadConfig();
  } catch (err) {
    dialog.showErrorBox('Remote Play host', err.message);
    app.quit();
    return;
  }

  // Don't let the PC go to sleep while the host is running, or it drops offline.
  powerSaveBlocker.start('prevent-app-suspension');

  win = new BrowserWindow({
    width: 560,
    height: 460,
    title: 'Remote Play host',
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile('host.html');
  // Never navigate the window anywhere else.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {
  input.releaseAll();
  app.quit();
});

// Only trust messages from our own window.
const fromWin = (e) => win && e.sender === win.webContents;

ipcMain.handle('config', (e) => (fromWin(e) ? { serverUrl: config.serverUrl, accessKey: config.accessKey } : null));
ipcMain.handle('screens', (e) => (fromWin(e) ? listScreens() : []));

ipcMain.on('active-screen', (e, sourceId) => {
  if (fromWin(e)) input.setDisplayRect(screenSources.get(sourceId) || null);
});

ipcMain.on('input', (e, msg) => {
  if (fromWin(e)) input.handle(msg);
});

ipcMain.on('release-all', (e) => {
  if (fromWin(e)) input.releaseAll();
});

ipcMain.on('streaming', (e, on) => {
  if (!fromWin(e)) return;
  // Keep the monitor awake while someone is watching so the capture doesn't go black.
  if (on && displaySleepBlocker === null) {
    displaySleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!on && displaySleepBlocker !== null) {
    powerSaveBlocker.stop(displaySleepBlocker);
    displaySleepBlocker = null;
  }
});

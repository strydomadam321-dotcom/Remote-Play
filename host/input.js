'use strict';
// Injects keyboard and mouse input on Windows with SendInput (through the koffi FFI).
// Keys are sent as hardware scan codes, which games like Minecraft read reliably.

const koffi = require('koffi');

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const WHEEL_DELTA = 120;

// Browser MouseEvent.button -> [down flag, up flag, mouseData]
const BUTTONS = {
  0: [0x0002, 0x0004, 0], // left
  1: [0x0020, 0x0040, 0], // middle
  2: [0x0008, 0x0010, 0], // right
  3: [0x0080, 0x0100, 1], // back (XBUTTON1)
  4: [0x0080, 0x0100, 2], // forward (XBUTTON2)
};

// Browser KeyboardEvent.code -> [scan code (set 1), extended]
const SCANCODES = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06],
  Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b], Minus: [0x0c],
  Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f],
  KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16],
  KeyI: [0x17], KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c],
  ControlLeft: [0x1d], KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22],
  KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28],
  Backquote: [0x29], ShiftLeft: [0x2a], Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e],
  KeyV: [0x2f], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35],
  ShiftRight: [0x36], NumpadMultiply: [0x37], AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42],
  F9: [0x43], F10: [0x44], NumLock: [0x45], ScrollLock: [0x46],
  Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49], NumpadSubtract: [0x4a], Numpad4: [0x4b],
  Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e], Numpad1: [0x4f], Numpad2: [0x50],
  Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53], IntlBackslash: [0x56], F11: [0x57], F12: [0x58],
  NumpadEnter: [0x1c, true], ControlRight: [0x1d, true], NumpadDivide: [0x35, true], AltRight: [0x38, true],
  Home: [0x47, true], ArrowUp: [0x48, true], PageUp: [0x49, true], ArrowLeft: [0x4b, true],
  ArrowRight: [0x4d, true], End: [0x4f, true], ArrowDown: [0x50, true], PageDown: [0x51, true],
  Insert: [0x52, true], Delete: [0x53, true], MetaLeft: [0x5b, true], MetaRight: [0x5c, true],
  ContextMenu: [0x5d, true],
};

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'int32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
});
const INPUT_SIZE = koffi.sizeof(INPUT);

const user32 = koffi.load('user32.dll');
const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32']);
const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int32', ['int32']);
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const pressedKeys = new Set();
const pressedButtons = new Set();
let displayRect = null; // physical-pixel bounds of the screen being streamed

function mouse(dx, dy, flags, data = 0) {
  SendInput(1, { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
}

function key(code, down) {
  const k = SCANCODES[code];
  if (!k) return;
  if (down) pressedKeys.add(code);
  else if (!pressedKeys.delete(code)) return;
  const flags = KEYEVENTF_SCANCODE | (k[1] ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
  SendInput(1, { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: k[0], dwFlags: flags, time: 0, dwExtraInfo: 0 } } }, INPUT_SIZE);
}

function button(b, down) {
  const spec = BUTTONS[b];
  if (!spec) return;
  if (down) pressedButtons.add(b);
  else if (!pressedButtons.delete(b)) return;
  mouse(0, 0, down ? spec[0] : spec[1], spec[2]);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => (Number.isFinite(v) ? v : 0);

function moveRelative(x, y) {
  const dx = Math.round(clamp(num(x), -4000, 4000));
  const dy = Math.round(clamp(num(y), -4000, 4000));
  if (dx || dy) mouse(dx, dy, MOUSEEVENTF_MOVE);
}

// x, y are 0..1 across the streamed screen.
function moveAbsolute(x, y) {
  if (!displayRect) return;
  const px = displayRect.x + clamp(num(x), 0, 1) * (displayRect.width - 1);
  const py = displayRect.y + clamp(num(y), 0, 1) * (displayRect.height - 1);
  const vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const vw = Math.max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
  const vh = Math.max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
  const ax = Math.round(((px - vx) * 65535) / (vw - 1));
  const ay = Math.round(((py - vy) * 65535) / (vh - 1));
  mouse(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
}

// x, y are wheel notches in browser direction (positive y = scroll down).
function wheel(x, y) {
  const ny = Math.round(clamp(num(y), -20, 20));
  const nx = Math.round(clamp(num(x), -20, 20));
  if (ny) mouse(0, 0, MOUSEEVENTF_WHEEL, -ny * WHEEL_DELTA);
  if (nx) mouse(0, 0, MOUSEEVENTF_HWHEEL, nx * WHEEL_DELTA);
}

function releaseAll() {
  for (const code of [...pressedKeys]) key(code, false);
  for (const b of [...pressedButtons]) button(b, false);
}

// Messages come from the viewer; anything unexpected is ignored.
function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'kd': return key(msg.c, true);
    case 'ku': return key(msg.c, false);
    case 'md': return button(msg.b, true);
    case 'mu': return button(msg.b, false);
    case 'mm': return moveRelative(msg.x, msg.y);
    case 'ma': return moveAbsolute(msg.x, msg.y);
    case 'wh': return wheel(msg.x, msg.y);
    case 'ra': return releaseAll();
    default: return undefined;
  }
}

function setDisplayRect(rect) {
  displayRect = rect;
}

module.exports = { handle, releaseAll, setDisplayRect };

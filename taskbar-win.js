// Windows-only: embed a small Electron window into the system taskbar by
// reparenting it into the "Shell_TrayWnd" window via Win32 SetParent — the
// same technique apps like TrafficMonitor use. All native calls go through
// koffi (FFI), so this module must only be require()'d on Windows.
//
// Everything is wrapped in try/catch; embed() returns false on any failure so
// the caller can fall back to the floating-panel display mode.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

// ---- Win32 type / function bindings ----
// Handles (HWND) are passed around as pointer-sized unsigned integers. On the
// x64 ABI a returned pointer and a uintptr_t share the same register, so this
// is safe and lets us avoid juggling opaque pointer objects.
const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long',
});

const FindWindowW = user32.func('FindWindowW', 'uintptr_t', ['str16', 'str16']);
const SetParent = user32.func('SetParent', 'uintptr_t', ['uintptr_t', 'uintptr_t']);
const GetWindowLongW = user32.func('GetWindowLongW', 'long', ['uintptr_t', 'int']);
const SetWindowLongW = user32.func('SetWindowLongW', 'long', ['uintptr_t', 'int', 'long']);
const SetWindowPos = user32.func('SetWindowPos', 'bool', [
  'uintptr_t', 'uintptr_t', 'int', 'int', 'int', 'int', 'uint',
]);
const GetWindowRect = user32.func('GetWindowRect', 'bool', [
  'uintptr_t', koffi.out(koffi.pointer(RECT)),
]);
const IsWindow = user32.func('IsWindow', 'bool', ['uintptr_t']);

// ---- Win32 constants ----
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_FLAGS = SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW;

// Widget footprint inside the taskbar. Height is overridden at runtime to match
// the actual taskbar height; width is fixed.
const WIDGET_WIDTH = 210;
const LEFT_MARGIN = 6;

let childHwnd = 0n;          // our Electron window
let taskbarHwnd = 0n;       // Shell_TrayWnd
let originalStyle = null;   // to restore on release
let timer = null;
let taskbarRect = null;     // last known taskbar rect in screen coords

function toHandle(v) {
  // Normalize koffi's number|bigint handle returns to BigInt for comparisons.
  return typeof v === 'bigint' ? v : BigInt(v);
}

function nativeHandle(win) {
  const buf = win.getNativeWindowHandle();
  // x64 / arm64 builds: 8-byte handle. (We only ship 64-bit Windows builds.)
  return buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function findTaskbar() {
  return toHandle(FindWindowW('Shell_TrayWnd', null));
}

// Position the widget at the far-left of the taskbar, full taskbar height.
function applyBounds() {
  const rect = {};
  if (!GetWindowRect(taskbarHwnd, rect)) return false;
  taskbarRect = rect;
  const height = rect.bottom - rect.top;
  // Coordinates are relative to the taskbar's client area now that we're a
  // child of it, so x=LEFT_MARGIN sits at the leftmost edge.
  SetWindowPos(childHwnd, 0n, LEFT_MARGIN, 0, WIDGET_WIDTH, height, SWP_FLAGS);
  return true;
}

function reparent() {
  taskbarHwnd = findTaskbar();
  if (!taskbarHwnd) throw new Error('Shell_TrayWnd not found');

  const style = GetWindowLongW(childHwnd, GWL_STYLE);
  if (originalStyle === null) originalStyle = style;
  // Turn the popup into a child window so it lives inside the taskbar.
  const childStyle = ((style | WS_CHILD) & ~WS_POPUP) >>> 0;
  SetWindowLongW(childHwnd, GWL_STYLE, childStyle | 0);

  SetParent(childHwnd, taskbarHwnd);
  applyBounds();
}

// Re-assert placement once per second: re-embed if explorer restarted (the
// taskbar HWND changes) or our window got detached; otherwise just reposition
// to follow DPI / resolution / taskbar size changes.
function tick() {
  try {
    const current = findTaskbar();
    if (!current) return;
    if (current !== taskbarHwnd || !IsWindow(childHwnd)) {
      reparent();
      return;
    }
    applyBounds();
  } catch {
    // Swallow transient failures; next tick retries.
  }
}

function embed(win) {
  try {
    childHwnd = nativeHandle(win);
    reparent();
    timer = setInterval(tick, 1000);
    return true;
  } catch (e) {
    console.error('[taskbar-win] embed failed:', e);
    return false;
  }
}

function release() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  try {
    if (childHwnd) {
      SetParent(childHwnd, 0n);
      if (originalStyle !== null) {
        SetWindowLongW(childHwnd, GWL_STYLE, originalStyle | 0);
      }
    }
  } catch (e) {
    console.error('[taskbar-win] release failed:', e);
  }
}

// Absolute screen rect of the embedded widget — used to position the hover
// popover just above it.
function getWidgetScreenRect() {
  if (!taskbarRect) return null;
  const height = taskbarRect.bottom - taskbarRect.top;
  return {
    x: taskbarRect.left + LEFT_MARGIN,
    y: taskbarRect.top,
    width: WIDGET_WIDTH,
    height,
  };
}

module.exports = {
  embed,
  release,
  getWidgetScreenRect,
  WIDGET_WIDTH,
};

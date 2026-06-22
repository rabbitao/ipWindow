// Windows-only: embed a small Electron window into the system taskbar by
// reparenting it into the "Shell_TrayWnd" window via Win32 SetParent — the
// same technique apps like TrafficMonitor use. All native calls go through
// koffi (FFI), so this module must only be require()'d on Windows.
//
// Everything is wrapped in try/catch; embed() returns false on any failure so
// the caller can fall back to the floating-panel display mode.

const koffi = require('koffi');
const { execFile } = require('child_process');

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
// Gap to leave between the weather/Widgets button and our widget.
const WIDGETS_GAP = 8;

let childHwnd = 0n;          // our Electron window
let taskbarHwnd = 0n;       // Shell_TrayWnd
let originalStyle = null;   // to restore on release
let timer = null;
let tickCount = 0;
let taskbarRect = null;     // last known taskbar rect in screen coords
let widgetX = LEFT_MARGIN;  // current x of our widget, relative to the taskbar
// Right edge (screen px) of the native weather/Widgets button, or null when it
// isn't present. We sit just to its right so we don't cover it.
let widgetsButtonRight = null;

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

// The native weather/Widgets button isn't a real HWND — it lives inside the
// taskbar's XAML/composition surface — so we locate it through UI Automation
// (by its stable AutomationId "WidgetsButton") and read its bounding rect.
// Run out-of-process via PowerShell; the lookup is ~250ms so we poll it
// occasionally rather than every tick. Output: "x,y,w,h" (screen px) or empty.
const UIA_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  'Add-Type -AssemblyName UIAutomationClient',
  'Add-Type -AssemblyName UIAutomationTypes',
  '$ae=[System.Windows.Automation.AutomationElement]',
  '$root=$ae::RootElement',
  "$tc=New-Object System.Windows.Automation.PropertyCondition($ae::ClassNameProperty,'Shell_TrayWnd')",
  '$tray=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$tc)',
  'if($tray){',
  "  $ic=New-Object System.Windows.Automation.PropertyCondition($ae::AutomationIdProperty,'WidgetsButton')",
  '  $b=$tray.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$ic)',
  "  if($b){$r=$b.Current.BoundingRectangle; Write-Output ('{0},{1},{2},{3}' -f [int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height)}",
  '}',
].join('\n');

function queryWidgetsButton() {
  // PowerShell -EncodedCommand takes base64 of a UTF-16LE string; this sidesteps
  // all shell quoting and works the same whether or not we're inside an asar.
  const encoded = Buffer.from(UIA_PROBE, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err) return; // keep the last known value on failure
      const m = String(stdout).trim().match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
      const next = m ? parseInt(m[1], 10) + parseInt(m[3], 10) : null;
      if (next !== widgetsButtonRight) {
        widgetsButtonRight = next;
        applyBounds(); // reposition right away when the weather button moves/appears
      }
    }
  );
}

// Place the widget at full taskbar height, just to the right of the weather/
// Widgets button when it's present, otherwise at the far-left.
function applyBounds() {
  const rect = {};
  if (!GetWindowRect(taskbarHwnd, rect)) return false;
  taskbarRect = rect;
  const height = rect.bottom - rect.top;
  // Coordinates are relative to the taskbar's client area now that we're a
  // child of it. widgetsButtonRight is a screen-x, so subtract the taskbar's
  // left edge to convert it.
  widgetX =
    widgetsButtonRight != null
      ? widgetsButtonRight - rect.left + WIDGETS_GAP
      : LEFT_MARGIN;
  SetWindowPos(childHwnd, 0n, widgetX, 0, WIDGET_WIDTH, height, SWP_FLAGS);
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
  queryWidgetsButton(); // refresh the weather-button anchor after (re)embedding
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
    // Re-check the weather button every ~10s: it appears/disappears or changes
    // width when the user toggles Widgets or the forecast text changes.
    if (++tickCount % 10 === 0) queryWidgetsButton();
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
    x: taskbarRect.left + widgetX,
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

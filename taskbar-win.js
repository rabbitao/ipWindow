// Windows-only helpers for the taskbar overlay widget.
//
// We render the widget as a normal top-level, always-on-top, non-activating,
// layered window positioned *over* the taskbar (rather than reparenting it into
// "Shell_TrayWnd"). So this module's job is just to report taskbar geometry —
// the taskbar rect, the system-tray rect (the right anchor) and the weather /
// Widgets button's right edge (the left anchor) — plus two small helpers used
// while dragging: keep our window's z-order above the (topmost) taskbar, and
// read the physical mouse-button state.
//
// All native calls go through koffi (FFI) and are wrapped so failures degrade
// gracefully. Only require() this module on Windows.

const koffi = require('koffi');
const { execFile } = require('child_process');

const user32 = koffi.load('user32.dll');

// ---- Win32 type / function bindings ----
// HWNDs are passed as pointer-sized unsigned integers (uintptr_t); on x64 a
// returned pointer and a uintptr_t share the same register, so this is safe.
const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long',
});

const FindWindowW = user32.func('FindWindowW', 'uintptr_t', ['str16', 'str16']);
const FindWindowExW = user32.func('FindWindowExW', 'uintptr_t', [
  'uintptr_t', 'uintptr_t', 'str16', 'str16',
]);
const GetWindowRect = user32.func('GetWindowRect', 'bool', [
  'uintptr_t', koffi.out(koffi.pointer(RECT)),
]);
const SetWindowPos = user32.func('SetWindowPos', 'bool', [
  'uintptr_t', 'uintptr_t', 'int', 'int', 'int', 'int', 'uint',
]);
const GetAsyncKeyState = user32.func('GetAsyncKeyState', 'short', ['int']);

// WinEvent hook: fires whenever the system foreground window changes. We use it
// to re-assert our overlay's z-order the instant another app is activated,
// instead of waiting for the slow (1s) reposition tick.
const WinEventProc = koffi.proto(
  'void __stdcall WinEventProc(void* hook, uint32 event, uintptr_t hwnd, ' +
    'int32 idObject, int32 idChild, uint32 idEventThread, uint32 dwmsEventTime)'
);
const SetWinEventHook = user32.func('SetWinEventHook', 'void*', [
  'uint32', 'uint32', 'uintptr_t', koffi.pointer(WinEventProc), 'uint32', 'uint32', 'uint32',
]);
const UnhookWinEvent = user32.func('UnhookWinEvent', 'bool', ['void*']);

// ---- Win32 constants ----
const HWND_TOPMOST = 0xffffffffffffffffn; // (HWND)-1
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const VK_LBUTTON = 0x01;
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;

function toHandle(v) {
  return typeof v === 'bigint' ? v : BigInt(v);
}

function rectOf(h) {
  const r = {};
  if (!GetWindowRect(h, r)) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function findTaskbar() {
  return toHandle(FindWindowW('Shell_TrayWnd', null));
}

// ---- Weather / Widgets button (left anchor) ----
// The native weather/Widgets button isn't a real HWND — it lives inside the
// taskbar's XAML/composition surface — so we locate it through UI Automation
// (by its stable AutomationId "WidgetsButton") and read its bounding rect.
// Run out-of-process via PowerShell; the lookup is ~250ms so callers poll it
// occasionally. Output: "x,y,w,h" (screen px) or empty.
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

let widgetsButtonRight = null; // screen-x of the weather button's right edge, or null

function refreshWidgetsButton() {
  const encoded = Buffer.from(UIA_PROBE, 'utf16le').toString('base64');
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err) return; // keep the last known value on failure
      const m = String(stdout).trim().match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
      widgetsButtonRight = m ? parseInt(m[1], 10) + parseInt(m[3], 10) : null;
    }
  );
}

// Current taskbar geometry in physical (screen) pixels, or null if the taskbar
// can't be found. trayRect is the system-tray/clock region (right anchor);
// widgetsRight is the weather button's right edge (left anchor) or null.
function getLayout() {
  const tray = findTaskbar();
  if (!tray) return null;
  const taskbarRect = rectOf(tray);
  if (!taskbarRect) return null;
  const trayNotify = toHandle(FindWindowExW(tray, 0n, 'TrayNotifyWnd', null));
  const trayRect = trayNotify ? rectOf(trayNotify) : null;
  return { taskbarRect, trayRect, widgetsRight: widgetsButtonRight };
}

// Re-assert our window's z-order above the (topmost) taskbar without moving,
// resizing, or activating it.
function assertTopmost(hwnd) {
  try {
    SetWindowPos(toHandle(hwnd), HWND_TOPMOST, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  } catch {}
}

// Physical left-mouse-button state — lets the drag loop detect release even
// when the cursor has left our (non-activating) window.
function isLeftMouseDown() {
  try {
    return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
  } catch {
    return false;
  }
}

// ---- Foreground-change watch ----
// Keep references alive so the registered callback isn't garbage-collected while
// the OS still holds the hook.
let foregroundHook = null; // HWINEVENTHOOK pointer
let foregroundCb = null; // koffi-registered callback pointer

// Start watching for foreground-window changes. `onForeground` is invoked (with
// no arguments) on the main thread each time another app is activated, so the
// caller can immediately re-assert the overlay's z-order. Events from our own
// process are skipped. Returns true if the hook was installed. Calling again
// replaces any existing hook.
function startForegroundWatch(onForeground) {
  stopForegroundWatch();
  try {
    foregroundCb = koffi.register(() => {
      try {
        onForeground();
      } catch {}
    }, koffi.pointer(WinEventProc));
    foregroundHook = SetWinEventHook(
      EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
      0n, foregroundCb, 0, 0,
      WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
    );
    if (!foregroundHook) {
      stopForegroundWatch();
      return false;
    }
    return true;
  } catch {
    stopForegroundWatch();
    return false;
  }
}

function stopForegroundWatch() {
  try {
    if (foregroundHook) UnhookWinEvent(foregroundHook);
  } catch {}
  try {
    if (foregroundCb) koffi.unregister(foregroundCb);
  } catch {}
  foregroundHook = null;
  foregroundCb = null;
}

module.exports = {
  getLayout,
  refreshWidgetsButton,
  assertTopmost,
  isLeftMouseDown,
  startForegroundWatch,
  stopForegroundWatch,
};

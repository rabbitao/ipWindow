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

// ---- Win32 constants ----
const HWND_TOPMOST = 0xffffffffffffffffn; // (HWND)-1
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const VK_LBUTTON = 0x01;

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

module.exports = {
  getLayout,
  refreshWidgetsButton,
  assertTopmost,
  isLeftMouseDown,
};

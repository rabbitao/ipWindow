const $ = (id) => document.getElementById(id);

// Localized strings (subset of what the floating panel uses).
let T = {
  ipLoading: '…',
  unknownLoc: '',
  queryFailed: '',
  networkError: '',
};

window.ipApi.onI18n((strings) => {
  T = strings;
  $('ip').textContent = T.ipLoading;
  scheduleWidth();
});

function setDot(state) {
  $('status-dot').className = 'dot' + (state ? ' ' + state : '');
}

// Ask the main process to size the window to the actual text, so the refresh
// button sits right after the IP/location instead of being pushed to the far
// right by a fixed-width window. We measure each text span's scrollWidth (the
// full, untruncated text width even when the span is visually ellipsized) and
// add the fixed chrome around it (dot, gaps, refresh button, paddings/margins).
const DOT_W = 6; // .dot width
const ROW_GAP = 5; // gap inside #row-ip between the dot and the IP
const CHROME = 52; // widget margins + paddings + gap + 24px refresh button + safety
function reportWidth() {
  const ipNeed = DOT_W + ROW_GAP + $('ip').scrollWidth;
  const locNeed = $('loc').scrollWidth;
  const content = Math.max(ipNeed, locNeed);
  window.ipApi.taskbarResize(Math.ceil(content) + CHROME);
}

// Text layout settles after the current frame, so measure on the next one.
function scheduleWidth() {
  requestAnimationFrame(reportWidth);
}

window.ipApi.onLoading(() => {
  setDot('loading');
});

window.ipApi.onUpdate((data) => {
  setDot('ok');
  $('ip').textContent = data.ip || '—';
  $('loc').textContent = data.location || T.unknownLoc;
  scheduleWidth();
});

window.ipApi.onError((data) => {
  setDot('err');
  $('ip').textContent = T.queryFailed;
  $('loc').textContent = data.message || T.networkError;
  scheduleWidth();
});

// Follow the OS light/dark theme so text stays legible on the taskbar.
window.ipApi.onTheme((theme) => {
  document.body.className = theme === 'light' ? 'light' : 'dark';
});

// Refresh button on the right.
$('refresh').addEventListener('click', () => {
  const btn = $('refresh');
  btn.classList.add('spin');
  setTimeout(() => btn.classList.remove('spin'), 700);
  window.ipApi.refresh();
});

// Hover anywhere on the widget shows the detail popover (incl. ISP).
const widget = $('widget');
widget.addEventListener('mouseenter', () => window.ipApi.popoverEnter());
widget.addEventListener('mouseleave', () => window.ipApi.popoverLeave());

// Press-and-drag the widget to move it along the taskbar; the main process
// takes over (polling the cursor) and snaps to the nearer side on release.
// The refresh button keeps its own click.
widget.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('#refresh')) return;
  e.preventDefault();
  window.ipApi.dragStart();
});

// The window follows the cursor during a drag, so the pointer stays over the
// widget and this mouseup fires reliably — a prompt end signal that backs up the
// main process's physical-button polling.
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) window.ipApi.dragEnd();
});

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
});

function setDot(state) {
  $('status-dot').className = 'dot' + (state ? ' ' + state : '');
}

window.ipApi.onLoading(() => {
  setDot('loading');
});

window.ipApi.onUpdate((data) => {
  setDot('ok');
  $('ip').textContent = data.ip || '—';
  $('loc').textContent = data.location || T.unknownLoc;
});

window.ipApi.onError((data) => {
  setDot('err');
  $('ip').textContent = T.queryFailed;
  $('loc').textContent = data.message || T.networkError;
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

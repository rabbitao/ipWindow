const $ = (id) => document.getElementById(id);

// Localized strings, populated by the main process via the i18n channel.
// Defaults keep the UI sensible if the message hasn't arrived yet.
let T = {
  ipLoading: '…',
  labelLoc: '',
  closeTitle: '',
  unknownLoc: '',
  updatePrefix: '',
  queryFailed: '',
  networkError: '',
};

window.ipApi.onI18n((strings) => {
  T = strings;
  $('ip').textContent = T.ipLoading;
  $('label-loc').textContent = T.labelLoc;
  $('close').title = T.closeTitle;
});

function setDot(state) {
  const dot = $('status-dot');
  dot.className = 'dot' + (state ? ' ' + state : '');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

window.ipApi.onLoading(() => {
  setDot('loading');
});

window.ipApi.onUpdate((data) => {
  setDot('ok');
  $('ip').textContent = data.ip || '—';
  $('loc').textContent = data.location || T.unknownLoc;
  $('isp').textContent = data.isp || '';
  $('time').textContent = T.updatePrefix + fmtTime(data.time);
});

window.ipApi.onError((data) => {
  setDot('err');
  $('ip').textContent = T.queryFailed;
  $('loc').textContent = data.message || T.networkError;
  $('time').textContent = fmtTime(data.time);
});

// Double-click the card to refresh immediately.
$('card').addEventListener('dblclick', () => window.ipApi.refresh());

// Close button quits the app.
$('close').addEventListener('click', (e) => {
  e.stopPropagation();
  window.ipApi.quit();
});

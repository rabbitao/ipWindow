const $ = (id) => document.getElementById(id);

let T = {
  ipLoading: '…',
  labelLoc: '',
  unknownLoc: '',
  updatePrefix: '',
  queryFailed: '',
  networkError: '',
};

window.ipApi.onI18n((strings) => {
  T = strings;
  $('ip').textContent = T.ipLoading;
  $('label-loc').textContent = T.labelLoc;
});

function setDot(state) {
  $('status-dot').className = 'dot' + (state ? ' ' + state : '');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

window.ipApi.onLoading(() => setDot('loading'));

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

// Keep the popover open while the cursor is over it (it sits just above the
// taskbar widget, so moving onto it would otherwise trigger the widget's
// mouse-leave and hide it).
document.addEventListener('mouseenter', () => window.ipApi.popoverEnter());
document.addEventListener('mouseleave', () => window.ipApi.popoverLeave());

// Settings page: switch push notifications on or off for this device.
(function () {
  var box = document.getElementById('push-box');
  if (!box) return;
  var statusEl = document.getElementById('push-status'), on = document.getElementById('push-on'), off = document.getElementById('push-off'), test = document.getElementById('push-test');

  function say(text) { statusEl.textContent = text; }
  function show(subscribed) { on.style.display = subscribed ? 'none' : ''; off.style.display = subscribed ? '' : 'none'; test.style.display = subscribed ? '' : 'none'; }
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ h: csrf_token }, body)) })
      .then(function (r) { return r.json(); });
  }
  function keyBytes(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4), raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, function (c) { return c.charCodeAt(0); });
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    say('Dieser Browser kann keine Push-Nachrichten. Auf dem iPhone: Spiel zum Home-Bildschirm hinzufügen und von dort öffnen.');
    return;
  }
  if (!window.isSecureContext) { say('Push funktioniert nur über HTTPS.'); return; }

  var registration;
  function refresh() {
    return navigator.serviceWorker.register('/sw.js').then(function (reg) { registration = reg; return navigator.serviceWorker.ready; })
      .then(function (reg) { registration = reg; return reg.pushManager.getSubscription(); })
      .then(function (sub) {
        show(!!sub);
        say(sub ? 'Push ist auf diesem Gerät aktiv.' : (Notification.permission === 'denied' ? 'Der Browser blockiert Meldungen für diese Seite – in den Browser-Einstellungen erlauben.' : 'Push ist auf diesem Gerät aus.'));
      });
  }

  on.addEventListener('click', function () {
    Notification.requestPermission().then(function (p) {
      if (p !== 'granted') { say('Ohne Erlaubnis geht es nicht.'); return null; }
      return fetch('/api/push/key', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (k) {
        return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(k.key) });
      }).then(function (sub) { return post('/api/push/subscribe', sub.toJSON()); }).then(refresh);
    }).catch(function (e) { say('Das hat nicht geklappt: ' + (e && e.message ? e.message : e)); });
  });
  off.addEventListener('click', function () {
    registration.pushManager.getSubscription().then(function (sub) {
      if (!sub) return null;
      return post('/api/push/unsubscribe', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
    }).then(refresh);
  });
  test.addEventListener('click', function () {
    post('/api/push/test', {}).then(function (r) { say(r && r.sent ? 'Testnachricht gesendet.' : 'Es konnte nichts gesendet werden – schalte Push aus und wieder ein.'); });
  });
  refresh().catch(function (e) { say('Push-Setup fehlgeschlagen: ' + (e && e.message ? e.message : e)); });
})();

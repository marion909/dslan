// Polls /api/pulse and tells the player when something new happens (browser notification and/or beep).
(function () {
  var last = null, wanted = null;
  function beep() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination); osc.frequency.value = 660; gain.gain.value = 0.08;
      osc.start(); osc.stop(ctx.currentTime + 0.25);
    } catch (e) { /* no audio */ }
  }
  function tell(text) {
    if (wanted.sound) beep();
    if (wanted.browser && window.Notification && Notification.permission === 'granted') new Notification('TWLan', { body: text });
  }
  function poll() {
    fetch('/api/pulse', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      wanted = d.prefs;
      if (last && (wanted.browser || wanted.sound)) {
        if (wanted.attack && d.attacks > last.attacks) tell('Ein Angriff ist auf dem Weg zu dir!');
        if (wanted.message && d.messages > last.messages) tell('Du hast eine neue Nachricht.');
        if (wanted.report && d.reports > last.reports) tell('Du hast einen neuen Bericht.');
      }
      last = d;
    }).catch(function () { /* offline: try again later */ });
  }
  poll();
  setInterval(poll, 15000);
})();

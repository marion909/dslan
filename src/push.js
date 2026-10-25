'use strict';
const webpush = require('web-push');
const cfg = require('./config');

// Web push: the phone shows a notification even when the game is closed. Needs HTTPS (or localhost).
// The keys identify this server to the push services; they are created once and kept in the database.
let transport = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
const setTransport = (fn) => { transport = fn; };

function keys(db) {
  const get = (k) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) || {}).value;
  let publicKey = process.env.VAPID_PUBLIC || get('vapid_public');
  let privateKey = process.env.VAPID_PRIVATE || get('vapid_private');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    db.prepare("INSERT INTO meta (key, value) VALUES ('vapid_public', ?), ('vapid_private', ?)").run(publicKey, privateKey);
  }
  return { publicKey, privateKey };
}

const options = (db, urgency) => {
  const { publicKey, privateKey } = keys(db);
  return { TTL: 3600, urgency, vapidDetails: { subject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost', publicKey, privateKey } };
};

function subscribe(db, userId, { endpoint, keys: k }) {
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 600) return { ok: false, error: 'badEndpoint' };
  if (!k || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return { ok: false, error: 'badKeys' };
  if (db.prepare('SELECT COUNT(*) AS n FROM push_sub WHERE user_id = ?').get(userId).n >= 10) {
    db.prepare('DELETE FROM push_sub WHERE id = (SELECT MIN(id) FROM push_sub WHERE user_id = ?)').run(userId);
  }
  db.prepare('INSERT INTO push_sub (user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
    .run(userId, endpoint, k.p256dh, k.auth, Math.floor(Date.now() / 1000));
  return { ok: true };
}

const unsubscribe = (db, userId, endpoint) => db.prepare('DELETE FROM push_sub WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint));

// kind: attack | message | report (the player's own notification choices); `force` skips choices and activity (test button).
// Players who are looking at the game right now get nothing: their open page already tells them.
async function notify(db, userId, { kind, title, body, url, force = false }) {
  if (cfg.PAUSED && !force) return 0;
  const user = db.prepare('SELECT notify, last_seen FROM user WHERE id = ?').get(userId);
  if (!user) return 0;
  if (!force) {
    let prefs = {}; try { prefs = JSON.parse(user.notify || '{}'); } catch { /* defaults */ }
    if (prefs[kind] === 0 || prefs[kind] === false) return 0;
    if (user.last_seen > Date.now() / 1000 - 30) return 0;
  }
  const subs = db.prepare('SELECT * FROM push_sub WHERE user_id = ?').all(userId);
  if (!subs.length) return 0;
  const payload = JSON.stringify({ title, body, url: url || '/page/play', tag: kind || 'twlan' });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await transport({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options(db, kind === 'attack' ? 'high' : 'normal'));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) db.prepare('DELETE FROM push_sub WHERE id = ?').run(s.id);
      else console.error('push failed:', e && (e.statusCode || e.message));
    }
  }));
  return sent;
}

// Fire and forget for the game code: a push problem must never break an attack or a message.
const tell = (db, userId, message) => { if (userId) notify(db, userId, message).catch((e) => console.error('push failed:', e && e.message)); };

function install(app, db, { csrfOk }) {
  const auth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not logged in.' }));
  const guard = (req, res, next) => (csrfOk(req) ? next() : res.status(403).json({ error: 'Invalid token.' }));
  app.get('/api/push/key', auth, (req, res) => res.set('Cache-Control', 'no-store').json({ key: keys(db).publicKey, devices: db.prepare('SELECT COUNT(*) AS n FROM push_sub WHERE user_id = ?').get(req.user.id).n }));
  app.post('/api/push/subscribe', auth, guard, (req, res) => res.json(subscribe(db, req.user.id, req.body || {})));
  app.post('/api/push/unsubscribe', auth, guard, (req, res) => { unsubscribe(db, req.user.id, (req.body || {}).endpoint); res.json({ ok: true }); });
  app.post('/api/push/test', auth, guard, async (req, res) => {
    const sent = await notify(db, req.user.id, { kind: 'test', force: true, title: 'TWLan', body: 'Push funktioniert – du wirst bei Angriffen benachrichtigt.', url: '/page/play' });
    res.json({ ok: true, sent });
  });
}

module.exports = { install, notify, tell, subscribe, unsubscribe, keys, setTransport };

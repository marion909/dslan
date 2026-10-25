'use strict';
const path = require('node:path');
const express = require('express');
const push = require('./push');
const cfg = require('./config');
const auth = require('./auth');
const village = require('./game/village');
const f = require('./game/formulas');
const pages = require('./pages');
const admin = require('./admin');
const settings = require('./settings');
const view = require('./view');

const COOKIE = 'twsid';
const NAME_RE = /^[A-Za-z0-9_\- ]{3,24}$/;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
}

function createApp(db, opts = {}) {
  const app = express();
  // Behind nginx/aaPanel the real client IP and scheme come from X-Forwarded-*.
  app.set('trust proxy', opts.trustProxy ?? 1);
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use((req, res, next) => {
    req.sid = parseCookies(req.headers.cookie)[COOKIE];
    req.user = auth.userForSession(db, req.sid);
    const owner = req.user && auth.sittingFor(db, req.sid, req.user.id);
    if (owner) { req.sitter = req.user; req.user = owner; }
    const cookieLang = parseCookies(req.headers.cookie).twlang;
    const pick = (l) => (l && cfg.languageCodes.includes(l) ? l : undefined);
    const lang = pick(req.user && req.user.lang) || pick(cookieLang);
    view.langStore.run({ lang }, next);
  });

  const setCookie = (res, req, s) => res.cookie(COOKIE, s.sid, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: s.maxAge, path: '/',
  });

  // Counters the page polls to raise browser notifications.
  app.get('/api/pulse', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    const n = (sql) => db.prepare(sql).get(req.user.id).n;
    let prefs = {}; try { prefs = JSON.parse(req.user.notify || '{}'); } catch { /* defaults */ }
    res.set('Cache-Control', 'no-store').json({
      prefs: { browser: !!prefs.browser, sound: !!prefs.sound, attack: prefs.attack !== 0, message: prefs.message !== 0, report: prefs.report !== 0 },
      attacks: n("SELECT COUNT(*) AS n FROM command c JOIN village t ON t.id = c.to_village WHERE c.type = 'attack' AND t.user_id = ?"),
      messages: n('SELECT COUNT(*) AS n FROM message WHERE to_id = ? AND is_read = 0 AND deleted_in = 0'),
      reports: n('SELECT COUNT(*) AS n FROM report WHERE user_id = ? AND is_read = 0'),
    });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const limiter = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: opts.authAttempts ?? 30 });

  app.post(['/api/register', '/page/register'], limiter, (req, res) => {
    if ((opts.registrationOpen === false || !settings.registrationOpen(db)) && db.prepare('SELECT COUNT(*) AS n FROM user').get().n > 0) return res.json({ error: 'Die Registrierung ist geschlossen.' });
    const username = req.body.username ?? req.body.register_username;
    const password = req.body.password ?? req.body.register_password;
    if (!NAME_RE.test(username || '')) return res.json({ error: 'Name: 3-24 letters, digits, space, - or _.' });
    if (!password || password.length < 6 || password.length > 100) return res.json({ error: 'Password must be 6-100 characters.' });
    if (db.prepare('SELECT 1 FROM user WHERE name = ?').get(username)) return res.json({ error: 'Name already taken.' });
    const isAdmin = db.prepare('SELECT COUNT(*) AS n FROM user').get().n === 0 ? 1 : 0; // first account administers
    const info = db.prepare('INSERT INTO user (name, password_hash, is_admin, created_at) VALUES (?,?,?,?)')
      .run(username, auth.hashPassword(password), isAdmin, Math.floor(Date.now() / 1000));
    setCookie(res, req, auth.createSession(db, Number(info.lastInsertRowid)));
    res.json({ ok: true, redirect: '/page/play' });
  });

  app.post(['/api/login', '/page/auth'], limiter, (req, res) => {
    const user = db.prepare('SELECT * FROM user WHERE name = ?').get(req.body.username || '');
    if (user && (user.banned || user.is_bot)) return res.json({ error: user.is_bot ? 'Dieser Account ist ein Bot.' : 'Dieser Account ist gesperrt.' });
    if (!user || !auth.verifyPassword(req.body.password || '', user.password_hash)) {
      return res.json({ error: 'Wrong user name or password.' });
    }
    db.prepare('INSERT INTO login_log (user_id, time, ip) VALUES (?,?,?)').run(user.id, Math.floor(Date.now() / 1000), String(req.ip));
    db.prepare('UPDATE user SET last_seen = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), user.id);
    setCookie(res, req, auth.createSession(db, user.id));
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sid) db.prepare('DELETE FROM session WHERE sid = ?').run(req.sid);
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Not logged in.' }));

  function ownVillage(req, res, next) {
    if (cfg.PAUSED) return res.status(503).json({ error: 'The world is paused.' });
    const v = db.prepare('SELECT * FROM village WHERE id = ? AND user_id = ?').get(Number(req.query.village || req.body.village), req.user.id);
    if (!v) return res.status(404).json({ error: 'No such village.' });
    req.village = v;
    next();
  }

  function villageState(id) {
    const v = village.processQueue(db, id);
    const levels = village.getBuildings(db, id);
    const queue = village.getQueue(db, id);
    return {
      id, name: v.name, x: v.x, y: v.y,
      res: { wood: Math.floor(v.wood), stone: Math.floor(v.stone), iron: Math.floor(v.iron) },
      storageMax: village.storageMax(levels),
      pop: village.popUsed(levels, [], village.unitPop(db, id)), popMax: village.popMax(levels),
      production: Object.fromEntries(village.RES.map((r) => [r, village.rate(db, id, levels, r)])),
      levels,
      queue: queue.map((q) => ({ id: q.id, building: q.building, level: q.level, finishAt: q.finish_at })),
      buildings: f.BUILDING_IDS.map((id2) => {
        const next = village.queuedLevels(db, id)[id2] + 1;
        return {
          id: id2, nextLevel: next, maxLevel: cfg.buildings[id2].maxLevel,
          costs: Object.fromEntries([...village.RES, 'population'].map((r) => [r, r === 'population' ? f.buildPopulation(id2, next) : f.buildCost(id2, r, next)])),
          time: f.buildTime(id2, next, levels.main),
          state: next > cfg.buildings[id2].maxLevel ? 'maxLevel' : village.canBuild(db, v, id2),
        };
      }),
    };
  }

  app.get('/api/me', requireUser, (req, res) => {
    const villages = db.prepare('SELECT id, name, x, y FROM village WHERE user_id = ?').all(req.user.id);
    res.json({ id: req.user.id, name: req.user.name, isAdmin: !!req.user.is_admin, villages });
  });

  // Gives a new player their first village on a free spot near the middle of the map.
  app.post('/api/village/create', requireUser, (req, res) => {
    if (db.prepare('SELECT 1 FROM village WHERE user_id = ?').get(req.user.id)) return res.json({ error: 'You already have a village.' });
    const spot = require('./game/world').pickSpot(db);
    const id = village.createVillage(db, { userId: req.user.id, name: `${req.user.name}s village`, ...spot });
    res.json({ ok: true, id });
  });

  app.get('/api/village', requireUser, ownVillage, (req, res) => res.json(villageState(req.village.id)));

  app.post('/api/village/build', requireUser, ownVillage, (req, res) => {
    const result = village.enqueueBuild(db, req.village.id, String(req.body.building));
    res.json({ ...result, village: villageState(req.village.id) });
  });

  app.post('/api/village/cancel', requireUser, ownVillage, (req, res) => {
    const result = village.cancelBuild(db, req.village.id, Number(req.body.queue));
    res.json({ ...result, village: villageState(req.village.id) });
  });

  settings.apply(db);
  push.install(app, db, { csrfOk: (req) => auth.checkCsrf(db, req.sid, req.query.h || (req.body && req.body.h)) });
  admin.install(app, db);
  pages.install(app, db);
  app.use(express.static(path.join(cfg.ROOT, 'public')));

  // Never show stack traces to players; the details go to the server log.
  app.use((err, req, res, _next) => {
    console.error(`${req.method} ${req.originalUrl}:`, err);
    if (res.headersSent) return;
    res.status(500).type('text/plain').send('Es ist ein Fehler aufgetreten. Bitte versuche es noch einmal.');
  });
  return app;
}

module.exports = { createApp };

'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const cfg = require('./config');
const auth = require('./auth');
const settings = require('./settings');
const village = require('./game/village');
const ranking = require('./game/ranking');
const premium = require('./game/premium');
const relics = require('./game/relics');
const bots = require('./game/bots');
const backup = require('./backup');
const world = require('./game/world');
const view = require('./view');

const PAGES = [['', 'Übersicht'], ['players', 'Spieler'], ['bots', 'Bots'], ['villages', 'Dörfer'], ['settings', 'Einstellungen'], ['world', 'Welt']];

function install(app, db) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!req.user) return res.redirect('/');
    if (!req.user.is_admin) return res.status(403).send('Kein Zugriff.');
    res.locals.csrf = auth.csrfToken(db, req.sid);
    res.locals.pages = PAGES;
    res.locals.number = view.number;
    res.locals.dateText = view.dateText;
    res.locals.flash = req.query.msg || '';
    next();
  });
  router.use((req, res, next) => {
    if (req.method === 'POST' && !auth.checkCsrf(db, req.sid, req.body.h)) return res.status(403).send('Ungültiges Token.');
    next();
  });

  const back = (res, path, msg) => res.redirect(`/admin/${path}${msg ? `?msg=${encodeURIComponent(msg)}` : ''}`);
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  // EJS has no layouts: render the page body first, then wrap it.
  const render = (res, page, locals) => {
    const all = { ...res.locals, page, ...locals };
    res.app.render(`admin/${page}`, all, (err, body) => {
      if (err) throw err;
      res.render('admin/layout', { ...all, body });
    });
  };

  router.get('/', (req, res) => {
    render(res, 'index', {
      stats: {
        users: count('SELECT COUNT(*) AS n FROM user'), banned: count('SELECT COUNT(*) AS n FROM user WHERE banned = 1'),
        villages: count('SELECT COUNT(*) AS n FROM village WHERE user_id IS NOT NULL'), barbarians: count('SELECT COUNT(*) AS n FROM village WHERE user_id IS NULL'),
        allies: count('SELECT COUNT(*) AS n FROM ally'), commands: count('SELECT COUNT(*) AS n FROM command'), reports: count('SELECT COUNT(*) AS n FROM report'),
        messages: count('SELECT COUNT(*) AS n FROM message'), sessions: count('SELECT COUNT(*) AS n FROM session WHERE expires_at > ?', Math.floor(Date.now() / 1000)),
      },
      uptime: Math.round(process.uptime()), node: process.version, dbBytes: (() => { try { return require('node:fs').statSync(db.location()).size; } catch { return 0; } })(),
      speed: cfg.SPEED, mult: cfg.SPEED_MULT,
    });
  });

  // ---- players ----
  router.get('/players', (req, res) => {
    const q = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`;
    const pts = new Map(ranking.players(db).map((p) => [p.id, p]));
    const rows = db.prepare('SELECT u.*, a.tag AS tag, (SELECT COUNT(*) FROM village v WHERE v.user_id = u.id) AS villages FROM user u LEFT JOIN ally a ON a.id = u.ally_id WHERE u.name LIKE ? ORDER BY u.id LIMIT 300').all(q)
      .map((u) => ({ ...u, points: (pts.get(u.id) || {}).points || 0 }));
    render(res, 'players', { rows, q: req.query.q || '', temp: req.query.temp || '', who: req.query.who || '' });
  });

  router.post('/players/:id/:action', (req, res) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM user WHERE id = ?').get(id);
    if (!user) return back(res, 'players', 'Spieler nicht gefunden.');
    const selfAction = id === req.user.id;
    switch (req.params.action) {
      case 'ban':
        if (selfAction) return back(res, 'players', 'Du kannst dich nicht selbst sperren.');
        db.prepare('UPDATE user SET banned = 1 WHERE id = ?').run(id);
        db.prepare('DELETE FROM session WHERE user_id = ?').run(id);
        ranking.invalidate();
        return back(res, 'players', `${user.name} gesperrt.`);
      case 'unban': db.prepare('UPDATE user SET banned = 0 WHERE id = ?').run(id); ranking.invalidate(); return back(res, 'players', `${user.name} entsperrt.`);
      case 'admin':
        if (selfAction) return back(res, 'players', 'Du kannst deine eigene Rolle nicht ändern.');
        db.prepare('UPDATE user SET is_admin = ? WHERE id = ?').run(user.is_admin ? 0 : 1, id);
        return back(res, 'players', `${user.name}: Adminrechte ${user.is_admin ? 'entzogen' : 'vergeben'}.`);
      case 'password': {
        const temp = crypto.randomBytes(6).toString('base64url');
        db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(auth.hashPassword(temp), id);
        db.prepare('DELETE FROM session WHERE user_id = ?').run(id);
        return res.redirect(`/admin/players?temp=${encodeURIComponent(temp)}&who=${encodeURIComponent(user.name)}`);
      }
      case 'pp': {
        const amount = Math.trunc(Number(req.body.amount));
        if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000) return back(res, 'players', 'Bitte eine Zahl ungleich 0 angeben.');
        const r = premium.grant(db, id, amount, `Vom Admin (${req.user.name})`);
        return back(res, 'players', r.ok ? `${user.name}: ${amount > 0 ? '+' : ''}${amount} Premium-Punkte.` : 'So viele Punkte hat der Spieler nicht.');
      }
      case 'delete':
        if (selfAction) return back(res, 'players', 'Du kannst dich nicht selbst löschen.');
        db.prepare('DELETE FROM user WHERE id = ?').run(id);
        ranking.invalidate();
        return back(res, 'players', `${user.name} gelöscht (Dörfer werden zu Barbarendörfern).`);
      default: return back(res, 'players');
    }
  });

  // ---- bots ----
  router.get('/bots', (req, res) => render(res, 'bots', { s: settings.load(db), bots: bots.list(db), log: bots.recentLog(db, 80), personas: bots.PERSONAS }));
  router.post('/bots/settings', (req, res) => {
    const b = req.body;
    const num = (v, min, max, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
    settings.set(db, 'botCount', num(b.botCount, 0, 200, 0));
    settings.set(db, 'botActive', b.botActive === '1' ? '1' : '0');
    settings.set(db, 'botInterval', num(b.botInterval, 2, 3600, 30));
    settings.set(db, 'botAggression', num(b.botAggression, 1, 5, 3));
    settings.set(db, 'botAttackPlayers', b.botAttackPlayers === '1' ? '1' : '0');
    settings.set(db, 'botMark', b.botMark === '1' ? '1' : '0');
    const r = bots.sync(db);
    return back(res, 'bots', `Gespeichert: ${r.total} Bots (${r.created} neu, ${r.removed} entfernt).`);
  });
  router.post('/bots/tick', (req, res) => {
    db.prepare('UPDATE bot SET next_at = 0').run();
    return back(res, 'bots', `${bots.tick(db, Date.now() / 1000, Math.random, 200)} Bots haben einen Zug gemacht.`);
  });
  router.post('/bots/:id/remove', (req, res) => {
    bots.remove(db, Number(req.params.id));
    settings.set(db, 'botCount', Math.max(0, Number(settings.load(db).botCount) - 1));
    return back(res, 'bots', 'Bot entfernt.');
  });

  // ---- villages ----
  router.get('/villages', (req, res) => {
    const raw = String(req.query.q || '').trim();
    const coord = /^(\d{1,3})\s*[|:,]\s*(\d{1,3})$/.exec(raw);
    const rows = coord
      ? db.prepare('SELECT v.*, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id WHERE v.x = ? AND v.y = ?').all(Number(coord[1]), Number(coord[2]))
      : db.prepare(`SELECT v.*, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id WHERE ${req.query.barb ? 'v.user_id IS NULL' : 'v.user_id IS NOT NULL'} AND (v.name LIKE ? OR u.name LIKE ?) ORDER BY v.id LIMIT 100`).all(`%${raw}%`, `%${raw}%`);
    render(res, 'villages', { rows: rows.map((r) => ({ ...r, points: village.villagePoints(village.getBuildings(db, r.id)) })), q: raw, barb: !!req.query.barb });
  });

  router.post('/villages/refill', (req, res) => {
    const n = world.seedBarbarians(db, { refill: true });
    world.giveBarbarianTroops(db);
    ranking.invalidate();
    return back(res, 'villages', `${n} Barbarendörfer neu angelegt.`);
  });

  // Barbarian cleanup: a single village (via the table) or everything inside a radius.
  router.post('/villages/clear', (req, res) => {
    const m = /^(\d{1,3})\s*[|:,]\s*(\d{1,3})$/.exec(String(req.body.center || '').trim());
    const radius = Math.min(300, Math.max(0, Number(req.body.radius) || 0));
    if (!m || !radius) return back(res, 'villages', 'Bitte Mitte als x|y und einen Radius angeben.');
    const ids = db.prepare('SELECT id, x, y FROM village WHERE user_id IS NULL').all()
      .filter((r) => Math.hypot(r.x - Number(m[1]), r.y - Number(m[2])) <= radius).map((r) => r.id);
    const r = world.removeBarbarians(db, ids);
    return back(res, 'villages', `${r.removed} Barbarendörfer entfernt${r.skipped ? `, ${r.skipped} übersprungen (Reliquienstandorte)` : ''}.`);
  });

  router.post('/villages/:id/:action', (req, res) => {
    const id = Number(req.params.id);
    const v = db.prepare('SELECT * FROM village WHERE id = ?').get(id);
    if (!v) return back(res, 'villages', 'Dorf nicht gefunden.');
    if (req.params.action === 'remove') {
      if (v.user_id) return back(res, 'villages', 'Dörfer von Spielern werden hier nicht entfernt – setze zuerst den Besitzer auf „leer“ oder lösche den Spieler.');
      const r = world.removeBarbarians(db, [id]);
      return back(res, 'villages', r.removed ? 'Barbarendorf entfernt.' : 'Dieses Dorf ist ein Reliquienstandort und bleibt bestehen.');
    }
    if (req.params.action === 'rename') {
      const name = String(req.body.name || '').trim().slice(0, 32);
      if (name.length >= 3) db.prepare('UPDATE village SET name = ? WHERE id = ?').run(name, id);
    } else if (req.params.action === 'resources') {
      const village0 = village.processQueue(db, id);
      const add = (key) => Math.max(0, Math.floor(Number(req.body[key]) || 0));
      db.prepare('UPDATE village SET wood = ?, stone = ?, iron = ? WHERE id = ?').run(village0.wood + add('wood'), village0.stone + add('stone'), village0.iron + add('iron'), id);
    } else if (req.params.action === 'owner') {
      const owner = db.prepare('SELECT id FROM user WHERE name = ?').get(String(req.body.owner || '').trim());
      const target = req.body.owner === '' ? { id: null } : owner;
      if (!target) return back(res, 'villages', 'Spieler nicht gefunden.');
      db.prepare('UPDATE village SET user_id = ? WHERE id = ?').run(target.id, id);
      db.prepare('DELETE FROM village_group_member WHERE village_id = ?').run(id);
      relics.villageLost(db, id);
      ranking.invalidate();
    }
    return back(res, `villages?q=${encodeURIComponent(`${v.x}|${v.y}`)}`, 'Gespeichert.');
  });

  // ---- settings ----
  router.get('/settings', (req, res) => render(res, 'settings', { s: settings.load(db), world: cfg.world }));
  router.post('/settings', (req, res) => {
    const mult = Number(req.body.speedMultiplier);
    if (mult >= 0.1 && mult <= 1000) settings.set(db, 'speedMultiplier', mult);
    settings.set(db, 'registration', req.body.registration === 'closed' ? 'closed' : 'open');
    return back(res, 'settings', 'Gespeichert.');
  });

  // ---- scheduled backups ----
  router.post('/backup/settings', (req, res) => {
    const hours = Math.min(720, Math.max(1, Math.floor(Number(req.body.hours)) || 24));
    const keep = Math.min(100, Math.max(1, Math.floor(Number(req.body.keep)) || 7));
    settings.set(db, 'backupEnabled', req.body.enabled === '1' ? '1' : '0');
    settings.set(db, 'backupHours', hours); settings.set(db, 'backupKeep', keep);
    return back(res, 'world', 'Backup-Einstellungen gespeichert.');
  });
  router.post('/backup/now', (req, res) => { backup.run(db, { keep: Number(settings.load(db).backupKeep) || 7 }); return back(res, 'world', 'Backup erstellt.'); });
  router.post('/backup/file', (req, res) => {
    const file = backup.resolve(String(req.body.name || ''));
    if (!file || !fs.existsSync(file)) return back(res, 'world', 'Datei nicht gefunden.');
    return res.download(file, path.basename(file));
  });

  // ---- backup: a consistent copy of the whole database, downloaded through the browser ----
  router.post('/backup', (req, res) => {
    const file = path.join(os.tmpdir(), `twlan-backup-${process.pid}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    res.download(file, `twlan-${stamp}.db`, () => fs.rm(file, { force: true }, () => {}));
  });

  // ---- world ----
  router.get('/world', (req, res) => render(res, 'world', { s: settings.load(db), backups: backup.list(), dir: backup.DIR, rules: settings.WORLD_RULES, current: cfg.world, original: settings.ORIGINAL }));
  router.post('/world/rules', (req, res) => {
    const rejected = settings.setWorldRules(db, req.body);
    return back(res, 'world', rejected.length ? `Gespeichert, aber ungültig und übersprungen: ${rejected.join(', ')}.` : 'Weltregeln gespeichert – sie gelten sofort.');
  });
  router.post('/world/rules/reset', (req, res) => { settings.resetWorldRules(db); return back(res, 'world', 'Weltregeln auf die Werte der Weltdatei zurückgesetzt.'); });
  router.post('/world/reset', (req, res) => {
    if (req.body.confirm !== 'ZURÜCKSETZEN') return back(res, 'world', 'Zur Bestätigung bitte ZURÜCKSETZEN eintippen.');
    // Everything except the admin accounts: villages, tribes, messages, reports, orders.
    for (const table of ['command', 'report', 'message', 'forum_thread', 'ally', 'market_offer', 'stationed', 'village', 'session']) db.exec(`DELETE FROM ${table}`);
    db.exec("DELETE FROM user WHERE is_admin = 0; DELETE FROM meta WHERE key LIKE 'barb%'");
    db.prepare('UPDATE user SET ally_id = NULL, kills_att = 0, kills_def = 0, conquered = 0').run();
    ranking.invalidate();
    world.seedBarbarians(db); world.giveBarbarianTroops(db);
    return res.redirect('/');
  });

  app.use('/admin', router);
}

module.exports = { install };

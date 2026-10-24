'use strict';
const path = require('node:path');
const fs = require('node:fs');
const cfg = require('./config');
const auth = require('./auth');
const view = require('./view');
const village = require('./game/village');
const units = require('./game/units');
const world = require('./game/world');
const minimap = require('./game/minimap');
const commands = require('./game/commands');
const ranking = require('./game/ranking');
const ally = require('./game/ally');
const premium = require('./game/premium');
const menu = require('./menu');
const { processJs } = require('./jstemplate');

const { t, duration, number } = view;
const RES = cfg.physicalRes;

function renderPartial(app, name, locals) {
  return new Promise((resolve, reject) => app.render(name, locals, (e, html) => (e ? reject(e) : resolve(html))));
}

// Shared chrome of every game page: navigation icons, quick links and the buttons next to the resources.
const MENU_ICONS = { overview: 'overview_village', map: 'map', reports: 'new_report', mails: 'new_mail', ally: 'flags', profile: 'knight', premium: 'premium', settings: 'scale' };
const DEFAULT_QUICKBAR = () => [
  ['main', 'main', view.buildingName('main')], ['barracks', 'barracks', 'Rekrutieren'], ['snob', 'snob', view.buildingName('snob')],
  ['smith', 'smith', view.buildingName('smith')], ['place', 'place', view.buildingName('place')], ['market', 'market', view.buildingName('market')],
];
const quickbarFor = (db, user) => {
  const own = db.prepare('SELECT label, target FROM quicklink WHERE user_id = ? ORDER BY pos').all(user.id);
  // [icon (a building id or null), link target, label]
  const icon = (screen) => (fs.existsSync(path.join(cfg.ROOT, 'public/graphic/buildings', `${screen}.png`)) ? screen : null);
  return own.length ? own.map((q) => [icon(q.target.split('&')[0]), q.target, q.label]) : DEFAULT_QUICKBAR();
};
const headerIcons = (vid) => [
  ['knight', `/game.php?village=${vid}&screen=statue`, view.buildingName('statue')],
  ['troops', `/game.php?village=${vid}&screen=place&mode=units`, t('buildingPlace.troopMovements')],
  ['map', `/game.php?village=${vid}&screen=map`, t('game.menu.map')],
  ['new_report', `/game.php?village=${vid}&screen=report`, t('game.report.title')],
  ['premium', `/game.php?village=${vid}&screen=overview&action=set_visual&visual=1`, t('game.overview.graphicalOverview')],
];

// Village switcher in the header: all villages plus the player's groups, keeping the current screen.
function villageMenu(db, user, query) {
  const all = db.prepare('SELECT id, name, x, y FROM village WHERE user_id = ? ORDER BY name LIMIT 200').all(user.id);
  if (all.length < 2) return null;
  const byId = new Map(all.map((v) => [v.id, v]));
  const groups = db.prepare('SELECT id, name FROM village_group WHERE user_id = ? ORDER BY name').all(user.id).map((g) => ({
    name: g.name, villages: db.prepare('SELECT village_id FROM village_group_member WHERE group_id = ?').all(g.id).map((m) => byId.get(m.village_id)).filter(Boolean),
  })).filter((g) => g.villages.length);
  const link = (id) => `/game.php?${new URLSearchParams({ ...query, village: String(id) })}`.replace(/&/g, '&amp;');
  return { all, groups, link };
}

function noticesFor(user, sitter, csrf) {
  const left = user.created_at + cfg.PROTECTION_SECONDS - Date.now() / 1000;
  const notes = left > 0 ? [`Angriffsschutz endet in <span class="timer">${duration(left)}</span>.`] : [];
  if (sitter) notes.unshift(`Du vertrittst <b>${view.esc(user.name)}</b> als Sitter. <a href="/page/sit?end=1&amp;h=${csrf}">Vertretung beenden</a>`);
  return notes;
}

// Screens a sitter must not touch: account, premium and tribe matters stay with the owner.
const SITTER_BLOCKED = new Set(['settings', 'mail', 'premium', 'ally']);

// game_data tells the scripts when the player is a sitter (hides owner-only actions).
function sitterFlag(req, data) {
  if (req.sitter) data.player.sitter = 1;
  return data;
}

// Phones get their own page frame. A cookie (set by the "Mobile/Desktop view" links) beats the guess from the user agent.
function wantsMobile(req) {
  const choice = /(?:^|;\s*)twview=(mobile|desktop)/.exec(req.headers.cookie || '');
  if (choice) return choice[1] === 'mobile';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(req.headers['user-agent'] || '');
}

function install(app, db) {
  app.set('view engine', 'ejs');
  app.set('views', path.join(cfg.ROOT, 'views'));
  Object.assign(app.locals, view.helpers, { world: cfg.world, physicalRes: RES, unitIds: units.UNIT_IDS });

  // The original served css/js from the web root; the scripts embed PHP
  // snippets for translated strings, which are resolved here.
  const jsCache = new Map();
  app.get('/:name.js', (req, res, next) => {
    const file = path.join(cfg.ROOT, 'public', 'js', `${req.params.name}.js`);
    if (!fs.existsSync(file)) return next();
    const key = `${view.currentLang()}:${file}`;
    if (!jsCache.has(key)) jsCache.set(key, processJs(fs.readFileSync(file, 'utf8'), (k, p) => t(k, p)));
    res.type('application/javascript').send(jsCache.get(key));
  });
  app.get('/:name.css', (req, res, next) => {
    const file = path.join(cfg.ROOT, 'public', 'css', `${req.params.name}.css`);
    return fs.existsSync(file) ? res.sendFile(file) : next();
  });

  // ---- start page ----
  app.get('/', (req, res) => res.render('index', { user: req.user, languages: cfg.languageCodes.map((c) => [c, cfg.languageNames[c] || c]), currentLang: view.currentLang() }));
  app.get('/page/view', (req, res) => {
    const mode = req.query.mode === 'mobile' ? 'mobile' : 'desktop';
    res.cookie('twview', mode, { maxAge: 365 * 86400 * 1000, sameSite: 'lax', path: '/' });
    const back = String(req.query.back || '');
    res.redirect(/^\/(?!\/)/.test(back) ? back : '/page/play');
  });

  // Start or end acting as a sitter; the link carries the CSRF token because it is a plain GET.
  app.get('/page/sit', (req, res) => {
    if (!req.user) return res.redirect('/');
    if (!auth.checkCsrf(db, req.sid, req.query.h)) return res.status(403).send('Invalid token');
    const realId = req.sitter ? req.sitter.id : req.user.id;
    if (req.query.end) db.prepare('UPDATE session SET sit_for = NULL WHERE sid = ?').run(req.sid);
    else if (db.prepare('SELECT 1 FROM sitter WHERE owner_id = ? AND sitter_id = ?').get(Number(req.query.id), realId)) db.prepare('UPDATE session SET sit_for = ? WHERE sid = ?').run(Number(req.query.id), req.sid);
    return res.redirect('/page/play');
  });

  // A report its owner chose to share: readable by anyone with the link.
  app.get('/report/:token', (req, res) => {
    const row = /^[a-f0-9]{24}$/.test(req.params.token) && db.prepare('SELECT * FROM report WHERE public_token = ?').get(req.params.token);
    if (!row) return res.status(404).type('text/plain').send('Bericht nicht gefunden.');
    return res.render('public_report', { view: { ...row, data: JSON.parse(row.data) } });
  });

  // Language of the start page (players use the one in their settings).
  app.get('/page/lang', (req, res) => {
    if (cfg.languageCodes.includes(String(req.query.l))) res.cookie('twlang', String(req.query.l), { maxAge: 365 * 24 * 3600 * 1000, path: '/', sameSite: 'lax' });
    res.redirect('/');
  });
  app.get('/page/logout', (req, res) => {
    if (req.sid) db.prepare('DELETE FROM session WHERE sid = ?').run(req.sid);
    res.clearCookie('twsid');
    res.redirect('/');
  });
  app.get('/page/play', (req, res) => {
    if (!req.user) return res.redirect('/');
    const v = db.prepare('SELECT id FROM village WHERE user_id = ? ORDER BY id LIMIT 1').get(req.user.id);
    res.redirect(v ? `/game.php?village=${v.id}&screen=overview` : '/page/start');
  });

  // Forgotten password: name + recovery code + new password.
  const recoverLimit = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  app.get('/page/recover', (req, res) => res.render('recover', { error: '', done: false }));
  app.post('/page/recover', recoverLimit, (req, res) => {
    const user = db.prepare('SELECT * FROM user WHERE name = ?').get(String(req.body.username || '').trim());
    const code = auth.normalizeCode(req.body.code);
    const pw = String(req.body.password || '');
    const fail = (error) => res.render('recover', { error, done: false });
    if (pw.length < 6 || pw.length > 100) return fail('Das neue Passwort muss 6 bis 100 Zeichen lang sein.');
    if (!user || user.is_bot || !user.recovery_hash || !code || !auth.verifyPassword(code, user.recovery_hash)) return fail('Name oder Code stimmen nicht.');
    db.prepare('UPDATE user SET password_hash = ?, recovery_hash = NULL WHERE id = ?').run(auth.hashPassword(pw), user.id);
    db.prepare('DELETE FROM session WHERE user_id = ?').run(user.id);
    return res.render('recover', { error: '', done: true });
  });

  // First login: pick the part of the world the first village is built in.
  app.get('/page/start', (req, res) => {
    if (!req.user) return res.redirect('/');
    if (db.prepare('SELECT 1 FROM village WHERE user_id = ?').get(req.user.id)) return res.redirect('/page/play');
    res.render('start', { user: req.user, error: req.query.error || '', allyId: req.user.ally_id, csrf: auth.csrfToken(db, req.sid) });
  });
  app.post('/page/start', (req, res) => {
    if (!req.user) return res.redirect('/');
    if (!auth.checkCsrf(db, req.sid, req.body.h)) return res.status(403).send('Invalid token');
    if (db.prepare('SELECT 1 FROM village WHERE user_id = ?').get(req.user.id)) return res.redirect('/page/play');
    const direction = world.DIRECTIONS.includes(req.body.direction) ? req.body.direction : 'random';
    try {
      village.createVillage(db, { userId: req.user.id, ...world.pickSpot(db, { direction, allyId: req.user.ally_id }), name: `${req.user.name}s Dorf` });
    } catch (e) {
      return res.redirect(`/page/start?error=${encodeURIComponent(t('createVillage.creationFailed'))}`);
    }
    return res.redirect('/page/play');
  });

  const NAME_RE = /^[A-Za-z0-9_\- ]{3,24}$/;
  app.post('/page/register/validate', (req, res) => {
    const { type, value } = req.body;
    const errors = [];
    if (type === 'name') {
      if (!NAME_RE.test(value || '')) errors.push('3-24 Zeichen: Buchstaben, Ziffern, Leerzeichen, - oder _');
      else if (db.prepare('SELECT 1 FROM user WHERE name = ?').get(value)) errors.push('Dieser Name ist bereits vergeben.');
    } else if (type === 'password') {
      if (!value || value.length < 6) errors.push('Das Passwort muss mindestens 6 Zeichen lang sein.');
    }
    res.json({ type, status: errors.length ? 'ERROR' : 'OK', errors });
  });

  // The `game_data` object the original game.js reads on every page.
  function gameData(user, v, screen, mode) {
    const levels = village.getBuildings(db, v.id);
    const prod = Object.fromEntries(RES.map((r) => [r, village.rate(db, v.id, levels, r) / 3600]));
    const pr = ranking.playerRank(db, user.id);
    const count = (sql) => db.prepare(sql).get(user.id).n;
    return {
      player: {
        id: user.id, name: user.name, ally: user.ally_id || 0, ally_level: user.ally_id ? 1 : -1, sitter: 0, sitter_non_owner: null, quest_progress: 0, pp: 0,
        incomings: count("SELECT COUNT(*) AS n FROM command c JOIN village t ON t.id = c.to_village WHERE c.type = 'attack' AND t.user_id = ?"),
        supports: count("SELECT COUNT(*) AS n FROM command c JOIN village t ON t.id = c.to_village WHERE c.type = 'support' AND t.user_id = ?"),
        pp: premium.balance(db, user.id), rank: pr.rank, rank_formatted: String(pr.rank), points: pr.points, points_formatted: number(pr.points),
        new_report: count('SELECT COUNT(*) AS n FROM report WHERE user_id = ? AND is_read = 0'),
        new_igm: count('SELECT COUNT(*) AS n FROM message WHERE to_id = ? AND is_read = 0 AND deleted_in = 0'),
        new_forum_post: ally.unreadThreads(db, user), new_items: 0, new_buddy_request: 0, new_ally_invite: count('SELECT COUNT(*) AS n FROM ally_invite WHERE user_id = ?'), new_ally_application: ally.openApplications(db, user),
        villages: count('SELECT COUNT(*) AS n FROM village WHERE user_id = ?'),
      },
      village: {
        id: v.id, name: v.name, x: v.x, y: v.y, coord: `${v.x}|${v.y}`,
        wood: Math.floor(v.wood), stone: Math.floor(v.stone), iron: Math.floor(v.iron),
        wood_float: v.wood, stone_float: v.stone, iron_float: v.iron,
        wood_prod: prod.wood, stone_prod: prod.stone, iron_prod: prod.iron,
        storage_max: village.storageMax(levels), pop: village.popUsed(levels, [], village.unitPop(db, v.id)), pop_max: village.popMax(levels),
        res: [Math.floor(v.wood), prod.wood, Math.floor(v.stone), prod.stone, Math.floor(v.iron), prod.iron],
      },
      screen, mode: mode || null, device: 'desktop', market: 'zz', link_base: '/game.php?', link_base_pure: '/game.php?',
    };
  }

  // Sector data for the map script: /map.php?v=2&e=<ts>&<x>_<y>=<flags>
  app.get('/map.php', (req, res) => {
    if (!req.user) return res.status(401).json([]);
    const out = [];
    for (const [key, flags] of Object.entries(req.query)) {
      const m = /^(\d+)_(\d+)$/.exec(key);
      if (!m) continue;
      const sx = Number(m[1]); const sy = Number(m[2]);
      if (sx % 20 || sy % 20 || sx >= cfg.world.mapSize || sy >= cfg.world.mapSize || out.length >= 40) continue;
      out.push(world.sector(db, sx, sy, Number(flags) | 0));
    }
    res.json(out);
  });

  app.get('/page.php', (req, res) => {
    if (req.user && req.query.page === 'worldmap_image') {
      const relations = Object.fromEntries((req.user.ally_id ? db.prepare("SELECT other_id, type FROM ally_contract WHERE ally_id = ? AND type IN ('partner', 'nap', 'enemy')").all(req.user.ally_id) : []).map((r) => [r.other_id, r.type]));
      const q = req.query;
      const show = { barbarian: q.barbarian === 'true', ally: q.ally === 'true', partner: q.partner === 'true', nap: q.nap === 'true', enemy: q.enemy === 'true' };
      return res.type('image/png').set('Cache-Control', 'private, max-age=10').send(minimap.renderWorld(db, { userId: req.user.id, allyId: req.user.ally_id, relations, show }));
    }
    if (!req.user || req.query.page !== 'topo_image') return res.status(404).end();
    const sx = Number(req.query.x); const sy = Number(req.query.y);
    if (!Number.isInteger(sx) || !Number.isInteger(sy) || sx % 50 || sy % 50 || sx < 0 || sy < 0) return res.status(400).end();
    res.type('image/png').set('Cache-Control', 'private, max-age=30').send(minimap.render(db, sx, sy, { userId: req.user.id, villageId: Number(req.query.cur) }));
  });

  const csrfOk = (req) => auth.checkCsrf(db, req.sid, req.query.h || req.body.h);

  // Wraps a screen in the page frame (menu, resources, footer).
  function renderGame(req, res, { screen, mode, title, body, locals, meta, common }) {
    const v = village.processQueue(db, common.vid);
    const mobileView = wantsMobile(req);
    app.render(`screens/${body}`, { ...common, village: v, now: Date.now() / 1000, title, ...locals }, (err, content) => {
      if (err) return req.next(err);
      res.render(mobileView ? 'game_mobile' : 'game', {
        mobileView, ...common, village: v, content, title, meta: meta || {}, menu, quickbar: quickbarFor(db, req.user), menuIcons: MENU_ICONS, headerIcons: headerIcons(common.vid),
        gameData: sitterFlag(req, gameData(req.user, v, screen, mode)), serverNow: Date.now() / 1000, notices: noticesFor(req.user, req.sitter, common.csrf), isAdmin: !!req.user.is_admin,
        villageMenu: villageMenu(db, req.user, req.query),
        switchLink: (dir) => new URLSearchParams({ ...req.query, village: `${dir}${common.vid}` }).toString().replace(/&/g, '&amp;'),
        serverUtcDiff: -new Date().getTimezoneOffset() * 60, clockNow: view.clock(Date.now() / 1000), error: undefined,
      }, (e2, html) => (e2 ? req.next(e2) : res.send(html)));
    });
  }

  // Every game screen is a handler in src/screens; each gets the request context.
  const registry = require('./screens')({
    db, app, renderPartial, gameData, csrfOk,
    render(ctx, body, locals = {}, opts = {}) {
      return renderGame(ctx.req, ctx.res, { screen: ctx.screen, mode: opts.mode || ctx.mode, title: opts.title || ctx.screen, body, locals, meta: opts.meta || {}, common: ctx.common });
    },
  });

  app.all('/game.php', async (req, res, next) => {
    try {
      if (!req.user) return res.redirect('/');

      // village=n123 / p123 jump to the next / previous village of the player
      const hop = /^([np])(\d+)$/.exec(String(req.query.village || ''));
      if (hop) {
        const ids = db.prepare('SELECT id FROM village WHERE user_id = ? ORDER BY id').all(req.user.id).map((r) => r.id);
        const at = ids.indexOf(Number(hop[2]));
        if (at >= 0 && ids.length > 1) {
          const target = ids[(at + (hop[1] === 'n' ? 1 : ids.length - 1)) % ids.length];
          return res.redirect(`/game.php?${new URLSearchParams({ ...req.query, village: String(target) })}`);
        }
      }

      const vid = Number(req.query.village);
      if (!db.prepare('SELECT 1 FROM village WHERE id = ? AND user_id = ?').get(vid, req.user.id)) return res.redirect('/page/play');
      if (req.sitter && SITTER_BLOCKED.has(String(req.query.screen))) return res.redirect(`/game.php?village=${vid}&screen=overview`);
      commands.processDue(db);
      const v = village.processQueue(db, vid);
      units.processTraining(db, vid);
      units.processResearch(db, vid);

      const screen = String(req.query.screen || 'overview');
      const isAjax = req.query.ajaxaction !== undefined;
      const csrf = auth.csrfToken(db, req.sid);
      const now = Date.now() / 1000;
      const common = { vid, village: v, csrf, now };

      if (req.method === 'POST' && !csrfOk(req)) {
        return isAjax ? res.json({ error: t('error.technical') }) : res.status(403).send('Invalid token');
      }

      // "Finish now" links in the queues cost premium points.
      if (req.query.action === 'finish' && req.method === 'GET') {
        if (csrfOk(req)) premium.finishFor(db, req.user.id, vid, screen);
        return res.redirect(`/game.php?${new URLSearchParams({ village: String(vid), screen, ...(req.query.mode ? { mode: String(req.query.mode) } : {}) })}`);
      }

      const handler = registry[screen];
      if (handler) {
        const done = await handler({ req, res, common, vid, v, csrf, screen, mode: req.query.mode, isAjax, now });
        if (done !== false) return undefined;
      }
      return renderGame(req, res, { screen, title: screen, body: 'stub', locals: { title: screen }, meta: {}, common });
    } catch (e) { return next(e); }
  });
}

module.exports = { install };

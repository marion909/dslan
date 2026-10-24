'use strict';
const cfg = require('../config');
const f = require('../game/formulas');
const village = require('../game/village');
const units = require('../game/units');
const view = require('../view');
const { movements } = require('../game/movements');
const relics = require('../game/relics');
const commands = require('../game/commands');

const { t } = view;
const RES = cfg.physicalRes;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...r]) => [k, r.join('=')]));
}

// Everything the graphical village view needs: image layers per building plus a few wandering NPCs.
function overviewVisual(db, v, levels, queued, visual, showLevels) {
  const night = view.isNight();
  const researching = units.getResearchQueue(db, v.id).length > 0;
  const layers = f.BUILDING_IDS.map((id) => ({
    id, level: levels[id], queued: queued[id] - levels[id], shape: cfg.buildings[id].shape,
    layers: view.buildingVisual(id, levels[id], { queued: queued[id] > levels[id], active: id === 'smith' && researching, night }),
  }));
  const npcs = ['juggler', 'guard', 'conversation'].filter(() => Math.random() < 1 / 6);
  return { visual, showLevels, night, layers, npcs };
}

const pad2 = (n) => String(n).padStart(2, '0');

// Beginner protection: window starts at registration; shown as a banner and a widget.
function protectionInfo(user) {
  const end = user.created_at + cfg.PROTECTION_SECONDS;
  const d = new Date(end * 1000);
  return {
    protectionEnd: end,
    protectionDate: `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}. um ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`,
  };
}

// Active relic effects of this village, and whether the player still has a relic to hand out.
function effectsFor(db, vid, userId) {
  const active = db.prepare(`SELECT r.name, r.effect, r.bonus FROM relic r JOIN village s ON s.id = r.site_village JOIN village t ON t.id = r.assigned_village
    WHERE r.assigned_village = ? AND s.user_id IS NOT NULL AND s.user_id = t.user_id`).all(vid).map((r) => ({ ...r, label: relics.EFFECTS[r.effect].label }));
  const spare = relics.mine(db, userId).filter((r) => !r.assigned_village).length;
  return { active, spare };
}

// Units standing in the village (own plus supporters), for the troops widget.
function troopsHere(db, vid) {
  const total = units.getUnits(db, vid);
  for (const g of commands.stationedAt(db, vid)) for (const [u, n] of Object.entries(g.units)) total[u] = (total[u] || 0) + n;
  return Object.entries(total).filter(([, n]) => n > 0);
}

module.exports = ({ db, app, render, renderPartial }) => ({
  async overview(ctx) {
    const { req, res, vid, v, common } = ctx;
    const cookies = parseCookies(req.headers.cookie);
    if (req.query.action === 'set_visual' || req.query.action === 'set_labels') {
      const key = req.query.action === 'set_visual' ? 'tw_visual' : 'tw_labels';
      res.cookie(key, req.query.visual ?? req.query.labels, { maxAge: 365 * 24 * 3600 * 1000, path: '/' });
      return res.redirect(`/game.php?village=${vid}&screen=overview`);
    }
    const levels = village.getBuildings(db, vid);
    const queued = village.queuedLevels(db, vid);
    const queue = village.getQueue(db, vid);
    const buildingRows = f.BUILDING_IDS.filter((id) => levels[id] > 0 || queued[id] > 0).map((id) => ({
      id, level: levels[id], extra: queued[id] > levels[id] ? `<small>+${queued[id] - levels[id]}</small>` : '',
    }));
    return render(ctx, 'overview', {
      buildingRows, queue, production: Object.fromEntries(RES.map((r) => [r, village.rate(db, vid, levels, r)])),
      effects: effectsFor(db, vid, req.user.id), troops: troopsHere(db, vid), note: v.note,
      points: village.villagePoints(levels), loyalty: Math.round(village.loyaltyAt(v)), mv: movements(db, vid), ...protectionInfo(req.user),
      ...overviewVisual(db, v, levels, queued, cookies.tw_visual !== '0', cookies.tw_labels !== '0'),
      queueHtml: await renderPartial(app, 'partials/overview_queue', { ...common, village: v, now: Date.now() / 1000, queue }),
    }, { title: t('game.menu.overview.title'), meta: { css: ['overview.css'], js: ['VillageOverview.js', 'upgrade_building.js'] } });
  },
});

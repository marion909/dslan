'use strict';
const cfg = require('../config');
const village = require('../game/village');
const units = require('../game/units');
const { t } = require('../view');

const ERR = {
  resources: 'zu wenig Rohstoffe', requirements: 'Voraussetzungen fehlen', population: 'Bauernhof zu klein', nothing: 'keine Menge', knightExists: 'nur ein Paladin erlaubt', noCoins: 'keine Goldmünzen',
};

// Recruit in several villages at once: one row per village, one column per unit.
module.exports = ({ db, render, csrfOk }) => ({
  async train(ctx) {
    const { req, res, vid } = ctx;
    const me = req.user;
    const own = db.prepare('SELECT * FROM village WHERE user_id = ? ORDER BY name').all(me.id);
    const results = [];

    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      for (const v of own) {
        const orders = {};
        for (const u of units.UNIT_IDS) {
          const n = Math.floor(Number(req.body[`${u}_${v.id}`]) || 0);
          if (n > 0 && u !== 'snob') orders[u] = n;
        }
        if (!Object.keys(orders).length) continue;
        const r = units.enqueueTraining(db, v.id, orders);
        results.push({ village: v.name, ok: r.ok, text: r.ok ? 'Rekrutierung gestartet' : (ERR[r.error] || t('error.technical')) });
      }
    }

    const rows = own.map((v) => {
      village.processQueue(db, v.id); units.processTraining(db, v.id);
      const levels = village.getBuildings(db, v.id);
      const fresh = db.prepare('SELECT * FROM village WHERE id = ?').get(v.id);
      const cells = {};
      for (const u of units.UNIT_IDS) {
        if (u === 'snob' || !units.isRecruitable(db, v.id, levels, u)) continue;
        cells[u] = { max: units.maxRecruitable(db, fresh, levels, u), home: units.getUnits(db, v.id)[u] };
      }
      return { id: v.id, name: v.name, x: v.x, y: v.y, cells, queued: units.getTrainQueue(db, v.id).reduce((s, q) => s + q.amount, 0) };
    });
    const cols = units.UNIT_IDS.filter((u) => rows.some((r) => r.cells[u]));
    return render(ctx, 'masstrain', { rows, cols, results, vid, world: cfg.world }, { title: t('game.overview.recruit') });
  },
});

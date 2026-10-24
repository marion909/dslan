'use strict';
const view = require('../view');
const { mapColors } = require('./colorgroups');
const reservations = require('../game/reservations');
const relics = require('../game/relics');

const { t } = view;

module.exports = ({ db, render }) => ({
  async map(ctx) {
    const { req, res } = ctx;
    const me = req.user;
    if (req.query.ajax === 'search') {
      const q = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`;
      const rows = req.query.type === 'village'
        ? db.prepare('SELECT name, x, y FROM village WHERE user_id IS NOT NULL AND name LIKE ? LIMIT 10').all(q)
        : db.prepare('SELECT v.name AS village, u.name AS name, v.x, v.y FROM village v JOIN user u ON u.id = v.user_id WHERE u.name LIKE ? LIMIT 10').all(q);
      return res.json(rows);
    }
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const total = count('SELECT COUNT(*) AS n FROM village');
    const barb = count('SELECT COUNT(*) AS n FROM village WHERE user_id IS NULL');
    const own = count('SELECT COUNT(*) AS n FROM village WHERE user_id = ?', me.id);
    const tribe = me.ally_id ? count('SELECT COUNT(*) AS n FROM village v JOIN user u ON u.id = v.user_id WHERE u.ally_id = ?', me.ally_id) : 0;
    const pct = (n) => (total ? `${(100 * n / total).toFixed(2)}%` : '0%');
    return render(ctx, 'map', {
      mapDir: 'map', userId: me.id, night: view.isNight(),
      allyRelations: Object.fromEntries((me.ally_id ? db.prepare("SELECT other_id, type FROM ally_contract WHERE ally_id = ? AND type IN ('partner', 'nap', 'enemy')").all(me.ally_id) : []).map((r) => [r.other_id, r.type])),
      favorites: db.prepare('SELECT village_id FROM favorite WHERE user_id = ?').all(me.id).map((r) => r.village_id),
      friends: Object.fromEntries(db.prepare('SELECT other_id FROM buddy WHERE user_id = ?').all(me.id).map((r) => [r.other_id, true])),
      relicIcons: Object.fromEntries(relics.list(db).map((r) => [r.site_village, [{ img: '/graphic/map/relic.png' }]])),
      colors: mapColors(db, me.id), reservations: reservations.mapMarks(db, me),
      worldinfo: { villages: total, barbarians: barb, barbarians_percentage: pct(barb), tribe_villages: tribe, tribe_percentage: pct(tribe), own_villages: own, own_percentage: pct(own) },
    }, { title: t('game.menu.map'), meta: { css: ['map.css'], js: ['map.js', 'twmap_drag.js'] } });
  },
});

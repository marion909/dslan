'use strict';
const relics = require('../game/relics');
const village = require('../game/village');

const ERR = { notYours: 'Diese Reliquie gehört dir nicht.', noVillage: 'Das Dorf gehört dir nicht.', tooFar: `Das Dorf ist mehr als ${relics.RADIUS} Felder entfernt.` };

module.exports = ({ db, render, csrfOk }) => ({
  async relics(ctx) {
    const { req, res, vid } = ctx;
    const me = req.user;
    let message = ''; let ok = false;
    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      const target = req.body.village === '' ? null : Number(req.body.village);
      const r = relics.assign(db, me.id, Number(req.body.relic), target);
      if (r.ok) { ok = true; message = target === null ? 'Die Reliquie wirkt nicht mehr.' : 'Die Reliquie wurde zugewiesen.'; } else message = ERR[r.error] || 'Das geht nicht.';
    }
    const all = relics.list(db).map((r) => ({ ...r, effectLabel: relics.EFFECTS[r.effect].label, own: r.owner_id === me.id }));
    const own = all.filter((r) => r.own);
    const choices = db.prepare('SELECT id, name, x, y FROM village WHERE user_id = ? ORDER BY name').all(me.id);
    for (const r of own) r.choices = choices.filter((c) => relics.distance({ x: r.site_x, y: r.site_y }, c) <= relics.RADIUS);
    return render(ctx, 'relics', { all, message, ok, radius: relics.RADIUS, village: village.processQueue(db, vid) }, { title: 'Reliquien' });
  },
});

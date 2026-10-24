'use strict';
const cfg = require('../config');
const units = require('../game/units');
const { t, buildingName } = require('../view');

module.exports = ({ db, render }) => ({
  async unit_info(ctx) {
    const { req, res, vid } = ctx;
    const id = String(req.query.id || '');
    const c = cfg.units[id];
    if (!c || !c.recruitBuilding) return res.redirect(`/game.php?village=${vid}&screen=place&mode=units`);
    const levels = require('../game/village').getBuildings(db, vid);
    return render(ctx, 'unit_info', {
      id, c, building: buildingName(c.recruitBuilding), time: units.recruitTime(id, levels[c.recruitBuilding] || 0),
      researched: units.researchLevel(db, vid, id) >= 1, needsResearch: units.needsResearch(id),
      research: units.researchCost(id), requirements: Object.entries(c.requirements || {}),
    }, { title: t(`unit${id[0].toUpperCase()}${id.slice(1)}.name`) });
  },
});

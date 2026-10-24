'use strict';
const cfg = require('../config');

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Faith: troops fight at full strength only in villages that lie inside a church area of their owner.
// The first church covers a fixed radius, ordinary churches grow with their level (estimates, see README).
const NO_FAITH = 0.5;
const FIRST_RADIUS = 6;
const radiusOf = (level) => (level > 0 ? 2 + 2 * level : 0);

function churches(db, userId) {
  return db.prepare(`SELECT v.x, v.y, b.building, b.level FROM village v JOIN village_building b ON b.village_id = v.id
    WHERE v.user_id = ? AND b.building IN ('church', 'church_f') AND b.level > 0`).all(userId);
}

// 1 when the village has faith, the penalty factor otherwise; worlds without churches never penalise.
function faithFactor(db, village) {
  if (!cfg.world.church || !village || !village.user_id) return 1;
  const inside = churches(db, village.user_id).some((c) => distance(c, village) <= (c.building === 'church_f' ? FIRST_RADIUS : radiusOf(c.level)));
  return inside ? 1 : NO_FAITH;
}

module.exports = { radiusOf, faithFactor, FIRST_RADIUS, NO_FAITH };

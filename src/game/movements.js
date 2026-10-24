'use strict';
const commands = require('./commands');

// Marching orders around one village, with the names of the villages at the other end.
function movements(db, vid) {
  const info = (id) => db.prepare('SELECT v.id, v.name, v.x, v.y, v.user_id, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id WHERE v.id = ?').get(id);
  const label = (r) => (r.user_id ? r.name : 'Barbarendorf');

  const out = commands.listCommands(db, "(from_village = ? AND type IN ('attack', 'support')) OR (to_village = ? AND type = 'return')", vid, vid).map((c) => {
    const other = info(c.type === 'return' ? c.from_village : c.to_village);
    return { ...c, label: label(other), x: other.x, y: other.y, owner: other.owner };
  });
  const incoming = commands.listCommands(db, "type IN ('attack', 'support') AND to_village = ?", vid).map((c) => {
    const from = info(c.from_village);
    return { ...c, label: label(from), x: from.x, y: from.y, owner: from.owner };
  });
  const trades = commands.listCommands(db, "type = 'trade' AND (from_village = ? OR to_village = ?)", vid, vid).map((c) => {
    const other = info(c.from_village === vid ? c.to_village : c.from_village);
    return { ...c, label: label(other), x: other.x, y: other.y, outgoing: c.from_village === vid };
  });
  return { out, incoming, trades };
}

module.exports = { movements };

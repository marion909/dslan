'use strict';
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const KINDS = ['player', 'ally', 'village'];

// Colour groups tint players, tribes or single villages on the map.
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// What the map script needs: { playerGroups, allyGroups, villageGroups } as colour triples.
function mapColors(db, userId) {
  const out = { playerGroups: {}, allyGroups: {}, villageGroups: {} };
  const rows = db.prepare('SELECT g.color, m.kind, m.ref_id FROM color_group g JOIN color_group_member m ON m.group_id = g.id WHERE g.user_id = ? ORDER BY g.id').all(userId);
  for (const r of rows) out[`${r.kind}Groups`][r.ref_id] = rgb(r.color);
  return out;
}

module.exports = ({ db, render, csrfOk }) => ({
  async map_groups(ctx) {
    const { req, res, vid } = ctx;
    const me = req.user;
    let message = ''; let ok = false;
    const back = `/game.php?village=${vid}&screen=map_groups`;
    const owns = (id) => db.prepare('SELECT * FROM color_group WHERE id = ? AND user_id = ?').get(id, me.id);

    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      const b = req.body;
      const name = String(b.name || '').trim().slice(0, 30);
      const act = req.query.action;
      if (act === 'create' || act === 'update') {
        if (!name || !COLOR_RE.test(String(b.color || ''))) message = 'Bitte Namen und Farbe angeben.';
        else if (act === 'create') {
          if (db.prepare('SELECT COUNT(*) AS n FROM color_group WHERE user_id = ?').get(me.id).n >= 20) message = 'Maximal 20 Gruppen.';
          else { db.prepare('INSERT INTO color_group (user_id, name, color) VALUES (?,?,?)').run(me.id, name, b.color); return res.redirect(back); }
        } else if (owns(Number(b.group))) { db.prepare('UPDATE color_group SET name = ?, color = ? WHERE id = ?').run(name, b.color, Number(b.group)); return res.redirect(back); }
      } else if (act === 'delete' && owns(Number(b.group))) {
        db.prepare('DELETE FROM color_group WHERE id = ?').run(Number(b.group));
        return res.redirect(back);
      } else if (act === 'remove' && owns(Number(b.group)) && KINDS.includes(b.kind)) {
        db.prepare('DELETE FROM color_group_member WHERE group_id = ? AND kind = ? AND ref_id = ?').run(Number(b.group), b.kind, Number(b.ref));
        return res.redirect(back);
      } else if (act === 'add' && owns(Number(b.group)) && KINDS.includes(b.kind)) {
        const text = String(b.value || '').trim();
        let ref = null;
        if (b.kind === 'player') ref = (db.prepare('SELECT id FROM user WHERE name = ?').get(text) || {}).id;
        else if (b.kind === 'ally') ref = (db.prepare('SELECT id FROM ally WHERE name = ? OR tag = ?').get(text, text) || {}).id;
        else {
          const m = /(\d{1,3})\s*[|:,. ]\s*(\d{1,3})/.exec(text);
          ref = m ? (db.prepare('SELECT id FROM village WHERE x = ? AND y = ?').get(Number(m[1]), Number(m[2])) || {}).id : null;
        }
        if (!ref) message = { player: 'Spieler nicht gefunden.', ally: 'Stamm nicht gefunden.', village: 'Dorf nicht gefunden (Format x|y).' }[b.kind];
        else { db.prepare('INSERT OR IGNORE INTO color_group_member (group_id, kind, ref_id) VALUES (?,?,?)').run(Number(b.group), b.kind, ref); return res.redirect(back); }
      }
    }

    const groups = db.prepare('SELECT * FROM color_group WHERE user_id = ? ORDER BY id').all(me.id).map((g) => ({
      ...g,
      members: db.prepare('SELECT kind, ref_id FROM color_group_member WHERE group_id = ?').all(g.id).map((m) => {
        let label = `#${m.ref_id}`;
        if (m.kind === 'player') label = (db.prepare('SELECT name FROM user WHERE id = ?').get(m.ref_id) || {}).name || label;
        else if (m.kind === 'ally') { const a = db.prepare('SELECT name, tag FROM ally WHERE id = ?').get(m.ref_id); if (a) label = `${a.name} (${a.tag})`; }
        else { const v = db.prepare('SELECT name, x, y FROM village WHERE id = ?').get(m.ref_id); if (v) label = `${v.name} (${v.x}|${v.y})`; }
        return { ...m, label };
      }),
    }));
    return render(ctx, 'map_groups', { groups, message, ok }, { title: 'Farbgruppen' });
  },
});

module.exports.mapColors = mapColors;

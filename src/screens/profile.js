'use strict';
const village = require('../game/village');
const ranking = require('../game/ranking');
const { t, dateText } = require('../view');

module.exports = ({ db, render, csrfOk }) => ({
  async info_player(ctx) {
    const { req, res, vid } = ctx;
    const id = Number(req.query.id) || req.user.id;
    const player = db.prepare('SELECT u.*, a.name AS ally_name, a.tag AS ally_tag FROM user u LEFT JOIN ally a ON a.id = u.ally_id WHERE u.id = ?').get(id);
    if (!player) return res.redirect(`/game.php?village=${vid}&screen=overview`);

    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      if (req.query.action === 'buddy_add' && id !== req.user.id) db.prepare('INSERT OR IGNORE INTO buddy (user_id, other_id, accepted) VALUES (?,?,1)').run(req.user.id, id);
      if (req.query.action === 'buddy_del') db.prepare('DELETE FROM buddy WHERE user_id = ? AND other_id = ?').run(req.user.id, id);
      return res.redirect(`/game.php?village=${vid}&screen=info_player&id=${id}`);
    }

    const rows = db.prepare('SELECT id, name, x, y FROM village WHERE user_id = ? ORDER BY id').all(id)
      .map((r) => ({ ...r, points: village.villagePoints(village.getBuildings(db, r.id)) }));
    const rk = ranking.playerRank(db, id);
    const isBuddy = !!db.prepare('SELECT 1 FROM buddy WHERE user_id = ? AND other_id = ?').get(req.user.id, id);
    return render(ctx, 'info_player', { player, villages: rows, rank: rk.rank, points: rk.points, isBuddy, self: id === req.user.id, joined: dateText(player.created_at) }, { title: player.name });
  },

  async buddies(ctx) {
    return ctx.res.redirect(`/game.php?village=${ctx.vid}&screen=mail&mode=address`);
  },

  // Personal scratch pad, one text per player.
  async notes(ctx) {
    const { req, res, vid } = ctx;
    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      db.prepare('INSERT INTO note (user_id, text) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET text = excluded.text').run(req.user.id, String(req.body.text || '').slice(0, 20000));
      return res.redirect(`/game.php?village=${vid}&screen=notes&saved=1`);
    }
    const row = db.prepare('SELECT text FROM note WHERE user_id = ?').get(req.user.id);
    return render(ctx, 'notes', { text: row ? row.text : '', saved: !!req.query.saved }, { title: 'Notizblock' });
  },

  async help(ctx) {
    return render(ctx, 'help', {}, { title: t('game.menu.help') === 'game.menu.help' ? 'Hilfe' : t('game.menu.help') });
  },
});

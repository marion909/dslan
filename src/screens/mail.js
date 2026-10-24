'use strict';
const { t, dateText } = require('../view');

const MODES = ['in', 'out', 'new', 'mass_out', 'address', 'folder'];

// Splits "a; b, c" into distinct, trimmed names.
const names = (s) => [...new Set(String(s || '').split(/[;,\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 30);

module.exports = ({ db, render, csrfOk }) => {
  function send(fromUser, recipients, subject, body) {
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare('INSERT INTO message (from_id, to_id, subject, body, time) VALUES (?,?,?,?,?)');
    for (const r of recipients) insert.run(fromUser.id, r.id, subject, body, now);
  }

  return {
    async mail(ctx) {
      const { req, res, vid } = ctx;
      const me = req.user;
      const mode = MODES.includes(ctx.mode) ? ctx.mode : 'in';
      let message = ''; let ok = false;
      let form = { to: String(req.query.player ? (db.prepare('SELECT name FROM user WHERE id = ?').get(Number(req.query.player)) || {}).name || '' : ''), subject: '', body: '' };

      if (req.method === 'POST') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        const act = req.query.action;
        if (act === 'send') {
          form = { to: String(req.body.to || ''), subject: String(req.body.subject || '').trim().slice(0, 120), body: String(req.body.body || '').slice(0, 10000) };
          let list = [];
          if (mode === 'mass_out') {
            list = me.ally_id ? db.prepare('SELECT id, name FROM user WHERE ally_id = ? AND id != ?').all(me.ally_id, me.id) : [];
            if (!list.length) message = 'Du hast keine Stammesmitglieder, die eine Nachricht erhalten könnten.';
          } else {
            const wanted = names(form.to);
            const found = wanted.map((n) => db.prepare('SELECT id, name FROM user WHERE name = ?').get(n));
            const missing = wanted.filter((n, i) => !found[i]);
            if (!wanted.length) message = 'Bitte einen Empfänger angeben.';
            else if (missing.length) message = `Spieler nicht gefunden: ${missing.join(', ')}`;
            else if (found.some((r) => db.prepare('SELECT 1 FROM blocked WHERE user_id = ? AND other_id = ?').get(r.id, me.id))) message = 'Mindestens ein Empfänger hat dich blockiert.';
            else list = found;
          }
          if (!message && !form.subject) message = 'Bitte einen Betreff angeben.';
          if (!message && !form.body.trim()) message = 'Die Nachricht ist leer.';
          if (!message) {
            send(me, list, form.subject, form.body);
            return res.redirect(`/game.php?village=${vid}&screen=mail&mode=out`);
          }
        } else if (act === 'delete') {
          const ids = [].concat(req.body.ids || []).map(Number).filter(Number.isInteger);
          for (const id of ids) {
            db.prepare('UPDATE message SET deleted_in = 1 WHERE id = ? AND to_id = ?').run(id, me.id);
            db.prepare('UPDATE message SET deleted_out = 1 WHERE id = ? AND from_id = ?').run(id, me.id);
          }
          return res.redirect(`/game.php?village=${vid}&screen=mail&mode=${mode}`);
        } else if (act === 'folder_add') {
          const name = String(req.body.name || '').trim().slice(0, 30);
          if (name && db.prepare('SELECT COUNT(*) AS n FROM mail_folder WHERE user_id = ?').get(me.id).n < 20) db.prepare('INSERT INTO mail_folder (user_id, name) VALUES (?,?)').run(me.id, name);
          return res.redirect(`/game.php?village=${vid}&screen=mail&mode=in`);
        } else if (act === 'folder_delete') {
          const f = Number(req.query.folder);
          db.prepare('UPDATE message SET folder_id = NULL WHERE folder_id = ? AND to_id = ?').run(f, me.id);
          db.prepare('DELETE FROM mail_folder WHERE id = ? AND user_id = ?').run(f, me.id);
          return res.redirect(`/game.php?village=${vid}&screen=mail&mode=in`);
        } else if (act === 'move') {
          const target = Number(String(req.body.op || '').replace('move_', ''));
          const owned = target === 0 || db.prepare('SELECT 1 FROM mail_folder WHERE id = ? AND user_id = ?').get(target, me.id);
          if (owned) for (const id of [].concat(req.body.ids || []).map(Number).filter(Number.isInteger)) db.prepare('UPDATE message SET folder_id = ? WHERE id = ? AND to_id = ?').run(target || null, id, me.id);
          return res.redirect(`/game.php?village=${vid}&screen=mail&mode=${mode}${req.query.folder ? `&folder=${Number(req.query.folder)}` : ''}`);
        } else if (act === 'buddy_group') {
          db.prepare('UPDATE buddy SET grp = ? WHERE user_id = ? AND other_id = ?').run(String(req.body.grp || '').trim().slice(0, 30), me.id, Number(req.body.other));
          return res.redirect(`/game.php?village=${vid}&screen=mail&mode=address`);
        } else if (act === 'buddy_add') {
          const other = db.prepare('SELECT id FROM user WHERE name = ?').get(String(req.body.name || '').trim());
          if (!other || other.id === me.id) message = 'Spieler nicht gefunden.';
          else { db.prepare('INSERT OR IGNORE INTO buddy (user_id, other_id, accepted) VALUES (?,?,1)').run(me.id, other.id); ok = true; message = 'Eingetragen.'; }
        } else if (act === 'buddy_del') {
          db.prepare('DELETE FROM buddy WHERE user_id = ? AND other_id = ?').run(me.id, Number(req.body.other));
          return res.redirect(`/game.php?village=${vid}&screen=mail&mode=address`);
        }
      }

      let view = null; let list = [];
      if (req.query.view) {
        const row = db.prepare('SELECT m.*, f.name AS from_name, t.name AS to_name FROM message m LEFT JOIN user f ON f.id = m.from_id JOIN user t ON t.id = m.to_id WHERE m.id = ? AND (m.to_id = ? OR m.from_id = ?)').get(Number(req.query.view), me.id, me.id);
        if (row) {
          view = row;
          if (row.to_id === me.id) db.prepare('UPDATE message SET is_read = 1 WHERE id = ?').run(row.id);
          if (req.query.reply) form = { to: row.from_name || '', subject: /^(Re|AW):/i.test(row.subject) ? row.subject : `Re: ${row.subject}`, body: `\n\n> ${row.body.split('\n').join('\n> ')}` };
        }
      }
      const folders = db.prepare('SELECT f.*, (SELECT COUNT(*) FROM message m WHERE m.folder_id = f.id AND m.deleted_in = 0) AS count FROM mail_folder f WHERE f.user_id = ? ORDER BY f.name').all(me.id);
      const folder = mode === 'folder' ? folders.find((f) => f.id === Number(req.query.folder)) || null : null;
      if (mode === 'folder' && folder) list = db.prepare('SELECT m.*, f.name AS from_name FROM message m LEFT JOIN user f ON f.id = m.from_id WHERE m.to_id = ? AND m.folder_id = ? AND m.deleted_in = 0 ORDER BY m.time DESC, m.id DESC LIMIT 200').all(me.id, folder.id);
      if (mode === 'in') list = db.prepare('SELECT m.*, f.name AS from_name FROM message m LEFT JOIN user f ON f.id = m.from_id WHERE m.to_id = ? AND m.deleted_in = 0 AND m.folder_id IS NULL ORDER BY m.time DESC, m.id DESC LIMIT 200').all(me.id);
      if (mode === 'out') list = db.prepare('SELECT m.*, t.name AS to_name FROM message m JOIN user t ON t.id = m.to_id WHERE m.from_id = ? AND m.deleted_out = 0 ORDER BY m.time DESC, m.id DESC LIMIT 200').all(me.id);
      const buddies = mode === 'address' ? db.prepare('SELECT u.id, u.name, b.grp FROM buddy b JOIN user u ON u.id = b.other_id WHERE b.user_id = ? ORDER BY b.grp, u.name').all(me.id) : [];

      return render(ctx, 'mail', {
        mode, modes: MODES.filter((m) => m !== 'folder'), folders, folder, list, view, form, message, ok, buddies, hasAlly: !!me.ally_id, me_id: me.id, replying: !!(view && req.query.reply), dateText,
      }, { title: t('game.menu.mails.title'), mode });
    },
  };
};

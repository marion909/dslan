'use strict';
const crypto = require('node:crypto');
const auth = require('../auth');
const commands = require('../game/commands');
const { t } = require('../view');

const MODES = ['attack', 'defense', 'support', 'trade', 'other', 'forwarded', 'public', 'filter', 'folder'];
const FILTERABLE = ['attack', 'defense', 'support', 'trade', 'other'];

module.exports = ({ db, render, csrfOk }) => ({
  async report(ctx) {
    const { req, res, vid } = ctx;
    const me = req.user;
    const q = req.query;
    let mode = MODES.includes(ctx.mode) ? ctx.mode : 'all';
    const folderRow = mode === 'folder' ? db.prepare('SELECT * FROM report_folder WHERE id = ? AND user_id = ?').get(Number(q.folder), me.id) : null;
    if (mode === 'folder' && !folderRow) mode = 'all';
    const folderQuery = folderRow ? `&folder=${folderRow.id}` : '';
    const base = `/game.php?village=${vid}&screen=report&mode=${mode}${folderQuery}`;
    let message = ''; let ok = false;
    const owns = (id) => db.prepare('SELECT 1 FROM report WHERE id = ? AND user_id = ?').get(id, me.id);

    if (q.action === 'del_one') {
      if (auth.checkCsrf(db, req.sid, q.h)) db.prepare('DELETE FROM report WHERE id = ? AND user_id = ?').run(Number(q.id), me.id);
      return res.redirect(base);
    }
    if (req.method === 'POST') {
      if (!csrfOk(req)) return res.status(403).send('Invalid token');
      const body = req.body;
      switch (q.action) {
        case 'folder_add': {
          const name = String(body.name || '').trim().slice(0, 30);
          if (name && db.prepare('SELECT COUNT(*) AS n FROM report_folder WHERE user_id = ?').get(me.id).n < 20) db.prepare('INSERT INTO report_folder (user_id, name) VALUES (?,?)').run(me.id, name);
          return res.redirect(base);
        }
        case 'folder_delete':
          if (folderRow) {
            db.prepare('UPDATE report SET folder_id = NULL WHERE folder_id = ? AND user_id = ?').run(folderRow.id, me.id);
            db.prepare('DELETE FROM report_folder WHERE id = ?').run(folderRow.id);
          }
          return res.redirect(`/game.php?village=${vid}&screen=report&mode=all`);
        case 'process': {
          const ids = [].concat(body.ids || []).map(Number).filter(Number.isInteger).filter(owns);
          const op = String(body.op || '');
          for (const id of ids) {
            if (op === 'delete') db.prepare('DELETE FROM report WHERE id = ?').run(id);
            else if (op === 'read') db.prepare('UPDATE report SET is_read = 1 WHERE id = ?').run(id);
            else if (/^move_\d+$/.test(op)) {
              const target = Number(op.slice(5));
              if (target === 0) db.prepare('UPDATE report SET folder_id = NULL WHERE id = ?').run(id);
              else if (db.prepare('SELECT 1 FROM report_folder WHERE id = ? AND user_id = ?').get(target, me.id)) db.prepare('UPDATE report SET folder_id = ? WHERE id = ?').run(target, id);
            }
          }
          return res.redirect(base);
        }
        case 'filter_save': {
          const hide = [].concat(body.hide || []).filter((x) => FILTERABLE.includes(x));
          db.prepare('UPDATE user SET report_filter = ? WHERE id = ?').run(JSON.stringify(hide), me.id);
          message = 'Gespeichert.'; ok = true;
          break;
        }
        case 'publish':
          if (owns(Number(q.view))) db.prepare('UPDATE report SET public_token = COALESCE(public_token, ?) WHERE id = ?').run(crypto.randomBytes(12).toString('hex'), Number(q.view));
          break;
        case 'unpublish':
          if (owns(Number(q.view))) db.prepare('UPDATE report SET public_token = NULL WHERE id = ?').run(Number(q.view));
          break;
        case 'forward': {
          const r = commands.forwardReport(db, me.id, Number(q.id), body.to);
          message = r.ok ? 'Der Bericht wurde weitergeleitet.' : (r.error === 'blocked' ? 'Der Spieler hat dich blockiert.' : 'Spieler nicht gefunden.');
          ok = r.ok;
          break;
        }
        default: break;
      }
    }

    let opened = null;
    const viewId = Number(q.view || q.id);
    if (viewId) {
      const row = db.prepare('SELECT * FROM report WHERE id = ? AND user_id = ?').get(viewId, me.id);
      if (row) {
        db.prepare('UPDATE report SET is_read = 1 WHERE id = ?').run(row.id);
        opened = { ...row, data: JSON.parse(row.data) };
      }
    }
    const folders = db.prepare('SELECT f.*, (SELECT COUNT(*) FROM report r WHERE r.folder_id = f.id) AS count FROM report_folder f WHERE f.user_id = ? ORDER BY f.name').all(me.id);
    let filter = []; try { filter = JSON.parse(me.report_filter); } catch { /* none */ }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return render(ctx, 'report', {
      mode, folder: folderRow, folders, filter, message, ok, view: opened, baseUrl,
      reports: mode === 'filter' ? [] : commands.getReports(db, me.id, mode, folderRow ? folderRow.id : null),
    }, { title: t('game.report.title'), mode });
  },
});

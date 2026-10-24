'use strict';
const cfg = require('../config');
const units = require('../game/units');
const village = require('../game/village');
const commands = require('../game/commands');
const combat = require('../game/combat');
const view = require('../view');
const { movements } = require('../game/movements');
const reservations = require('../game/reservations');

const { t } = view;
const COLUMNS = [['spear', 'sword', 'axe', 'archer'], ['spy', 'light', 'marcher', 'heavy'], ['ram', 'catapult'], ['knight', 'snob']]
  .map((col) => col.filter((u) => units.UNIT_IDS.includes(u))).filter((col) => col.length);
const MODES = ['command', 'units', 'sim', 'templates'];

const ERR = {
  noTroops: () => t('buildingPlace.errorNoTroops'), notEnoughTroops: () => t('buildingPlace.errorNotEnoughTroops'),
  invalidTarget: () => t('buildingPlace.errorInvalidTarget'), noTarget: () => t('buildingPlace.errorNoTarget'),
  sameVillage: () => 'Das Ziel ist das eigene Dorf.', protected: () => 'Dieser Spieler steht noch unter Angriffsschutz.',
  tooFar: () => 'Adelsgeschlechter können so weit nicht reisen.', unsupported: () => 'Nicht verfügbar.', noSource: () => t('error.technical'),
  denied: () => 'Dazu fehlt dir die Berechtigung.', noCommand: () => t('error.technical'), tooLate: () => 'Zu spät, die Truppen sind schon angekommen.',
};
const errText = (code) => (ERR[code] || ERR.noSource)();

const label = (r) => (r.user_id ? r.name : 'Barbarendorf');

module.exports = ({ db, render, renderPartial, csrfOk }) => {
  const info = (id) => db.prepare('SELECT v.id, v.name, v.x, v.y, v.user_id, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id WHERE v.id = ?').get(id);
  const armyFrom = (body) => Object.fromEntries(units.UNIT_IDS.map((u) => [u, Math.max(0, Math.floor(Number(body[u]) || 0))]).filter(([, n]) => n > 0));

  function target(body) {
    if (body.target) return db.prepare('SELECT * FROM village WHERE id = ?').get(Number(body.target));
    const m = /(\d{1,3})\s*[|:,. ]\s*(\d{1,3})/.exec(String(body.coord || ''));
    return m ? db.prepare('SELECT * FROM village WHERE x = ? AND y = ?').get(Number(m[1]), Number(m[2])) : null;
  }

  return {
    async place(ctx) {
      const { req, res, vid, common } = ctx;
      const q = req.query;
      const me = req.user;
      const mode = MODES.includes(ctx.mode) ? ctx.mode : 'command';
      const base = `/game.php?village=${vid}&screen=place`;
      let message = '';

      // ----- links that change state (need the token) -----
      if (q.action === 'cancel') {
        if (csrfOk(req)) commands.cancel(db, me.id, Number(q.id));
        return res.redirect(base);
      }
      if (q.action === 'recall' || q.action === 'sendback') {
        if (csrfOk(req)) commands.recall(db, me.id, Number(q.id), null, q.action === 'sendback');
        return res.redirect(`${base}&mode=units`);
      }
      if (req.method === 'POST' && mode === 'templates') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        if (q.action === 'save') {
          const name = String(req.body.name || '').trim().slice(0, 40); const army = armyFrom(req.body);
          if (!name) message = 'Bitte einen Namen angeben.'; else if (!Object.keys(army).length) message = t('buildingPlace.errorNoTroops');
          else if (db.prepare('SELECT COUNT(*) AS n FROM troop_template WHERE user_id = ?').get(me.id).n >= 30) message = 'Maximal 30 Vorlagen.';
          else { db.prepare('INSERT INTO troop_template (user_id, name, units) VALUES (?,?,?)').run(me.id, name, JSON.stringify(army)); return res.redirect(`${base}&mode=templates`); }
        } else if (q.action === 'delete') {
          db.prepare('DELETE FROM troop_template WHERE id = ? AND user_id = ?').run(Number(req.body.id), me.id);
          return res.redirect(`${base}&mode=templates`);
        }
      }

      const home = units.getUnits(db, vid);

      // ----- the map's "send troops" pop-up (answers JSON with ready-made dialog HTML) -----
      if (q.ajax === 'command' || q.ajax === 'confirm' || q.ajaxaction === 'map_command') {
        const tg = target(q.ajax === 'command' ? { target: q.target } : req.body);
        if (!tg) return res.json({ error: errText('noTarget') });
        const dialog = (name, locals2) => renderPartial(ctx.req.app, `partials/${name}`, { ...common, ...locals2, now: Date.now() / 1000 });
        if (q.ajax === 'command') {
          const targetInfo = { id: tg.id, x: tg.x, y: tg.y, name: label(tg), user_id: tg.user_id };
          return res.json({ response: { dialog: await dialog('map_command', { target: targetInfo, columns: COLUMNS, home }) } });
        }
        const sent = armyFrom(req.body);
        const type = req.body.support !== undefined || req.body.type === 'support' ? 'support' : 'attack';
        if (q.ajax === 'confirm') {
          if (!Object.keys(sent).length) return res.json({ error: errText('noTroops') });
          if (Object.entries(sent).some(([u, n]) => home[u] < n)) return res.json({ error: errText('notEnoughTroops') });
          if (tg.id === vid) return res.json({ error: errText('sameVillage') });
          if (type === 'support' && !tg.user_id) return res.json({ error: errText('invalidTarget') });
          const from = db.prepare('SELECT x, y FROM village WHERE id = ?').get(vid);
          const confirm = {
            type, target: { id: tg.id, name: label(tg), x: tg.x, y: tg.y }, units: sent, seconds: commands.travelSeconds(sent, from, tg),
            morale: combat.morale(village.villagePoints(village.getBuildings(db, vid)), village.villagePoints(village.getBuildings(db, tg.id))),
          };
          return res.json({ response: { dialog: await dialog('map_command_confirm', { confirm }) } });
        }
        const r = commands.send(db, { userId: me.id, fromId: vid, toId: tg.id, units: sent, type: req.body.type === 'support' ? 'support' : 'attack' });
        if (!r.ok) return res.json({ error: errText(r.error) });
        const support = req.body.type === 'support';
        return res.json({ response: { message: support ? 'Die Unterstützung wurde losgeschickt.' : 'Die Truppen wurden entsandt.', type: support ? 'support' : 'attack', target_id: tg.id } });
      }

      const locals = { mode, modes: MODES, message, columns: COLUMNS, home, base, errText };

      if (mode === 'command') {
        let confirm = null;
        const isPost = req.method === 'POST';
        const type = req.body && req.body.support !== undefined ? 'support' : 'attack';

        if (isPost && q.action === 'command') {
          if (!csrfOk(req)) return res.status(403).send('Invalid token');
          const tg = target(req.body);
          const kind = req.body.type === 'support' ? 'support' : 'attack';
          const r = tg ? commands.send(db, { userId: me.id, fromId: vid, toId: tg.id, units: armyFrom(req.body), type: kind }) : { ok: false, error: 'invalidTarget' };
          if (r.ok) return res.redirect(base);
          message = errText(r.error);
        } else if (isPost && q.try === 'confirm') {
          if (!csrfOk(req)) return res.status(403).send('Invalid token');
          const tg = target(req.body); const sent = armyFrom(req.body);
          if (!tg) message = errText('noTarget');
          else if (!Object.keys(sent).length) message = errText('noTroops');
          else if (Object.entries(sent).some(([u, n]) => home[u] < n)) message = errText('notEnoughTroops');
          else if (tg.id === vid) message = errText('sameVillage');
          else if (type === 'support' && !tg.user_id) message = errText('invalidTarget');
          else {
            const from = db.prepare('SELECT x, y FROM village WHERE id = ?').get(vid);
            confirm = {
              type, target: { id: tg.id, name: label({ ...tg }), x: tg.x, y: tg.y }, units: sent,
              seconds: commands.travelSeconds(sent, from, tg),
              morale: combat.morale(village.villagePoints(village.getBuildings(db, vid)), village.villagePoints(village.getBuildings(db, tg.id))),
              capacity: Object.entries(sent).reduce((s, [u, n]) => s + n * cfg.units[u].haul.base, 0),
              reserved: (() => { const r = reservations.forVillage(db, tg.id); return r && r.user_id !== me.id ? r.owner : null; })(),
            };
          }
        }
        let prefillTarget = '';
        const tid = Number(q.target);
        if (tid) { const tg = db.prepare('SELECT x, y FROM village WHERE id = ?').get(tid); if (tg) prefillTarget = `${tg.x}|${tg.y}`; }
        const tpl = db.prepare('SELECT id, name, units FROM troop_template WHERE user_id = ? ORDER BY name').all(me.id).map((r2) => ({ ...r2, units: JSON.parse(r2.units) }));
        const favorites = db.prepare('SELECT v.id, v.name, v.x, v.y, v.user_id FROM favorite f JOIN village v ON v.id = f.village_id WHERE f.user_id = ? ORDER BY v.name LIMIT 30').all(me.id)
          .map((r2) => ({ id: r2.id, name: label(r2), x: r2.x, y: r2.y }));
        const seen = new Set(); const recent = [];
        for (const r2 of db.prepare("SELECT data FROM report WHERE user_id = ? AND type = 'attack' ORDER BY time DESC LIMIT 40").all(me.id)) {
          const d = JSON.parse(r2.data).defender;
          if (d && !seen.has(d.villageId) && recent.length < 8) { seen.add(d.villageId); recent.push({ id: d.villageId, name: d.village, x: d.x, y: d.y }); }
        }
        Object.assign(locals, { favorites, recent, confirm, message, prefill: confirm ? confirm.units : (isPost ? armyFrom(req.body) : {}), prefillTarget, templates: tpl });
      }

      if (mode === 'units') {
        const hosted = commands.stationedAt(db, vid).map((g) => ({ ...g, from: info(g.owner_village) }));
        const abroad = db.prepare('SELECT * FROM stationed WHERE owner_village = ?').all(vid).map((g) => ({ ...g, units: JSON.parse(g.units), host: info(g.host_village) }));
        Object.assign(locals, { hosted, abroad });
      }

      if (mode === 'templates') {
        locals.templates = db.prepare('SELECT id, name, units FROM troop_template WHERE user_id = ? ORDER BY name').all(me.id).map((r2) => ({ ...r2, units: JSON.parse(r2.units) }));
      }

      if (mode === 'sim') {
        const body = req.method === 'POST' ? req.body : {};
        const pick = (prefix) => Object.fromEntries(units.UNIT_IDS.map((u) => [u, Math.max(0, Math.floor(Number(body[`${prefix}_${u}`]) || 0))]).filter(([, n]) => n > 0));
        locals.form = {
          attacker: pick('att'), defender: pick('def'), wall: Math.min(20, Math.max(0, Math.floor(Number(body.wall) || 0))),
          luck: Math.min(25, Math.max(-25, Number(body.luck) || 0)), night: body.night === '1',
          attPoints: Math.max(0, Math.floor(Number(body.att_points) || 0)), defPoints: Math.max(0, Math.floor(Number(body.def_points) || 0)),
        };
        locals.result = null;
        if (req.method === 'POST' && Object.keys(locals.form.attacker).length) {
          if (!csrfOk(req)) return res.status(403).send('Invalid token');
          const f = locals.form;
          locals.result = combat.resolve({
            attacker: f.attacker, defender: f.defender, wallLevel: f.wall, luck: f.luck / 100,
            attackerPoints: f.attPoints, defenderPoints: f.defPoints, defenseBonus: f.night ? cfg.world.nightBonus : 1,
          });
        }
        locals.unitIds = units.UNIT_IDS;
      }

      const mv = movements(db, vid);
      locals.movementsHtml = await renderPartial(ctx.req.app, 'partials/place_movements', { ...common, ...mv, vid, base, now: Date.now() / 1000 });
      return render(ctx, 'place', locals, { title: t('buildingPlace.name'), mode });
    },
  };
};

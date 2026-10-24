'use strict';
const cfg = require('../config');
const f = require('../game/formulas');
const village = require('../game/village');
const units = require('../game/units');
const commands = require('../game/commands');
const ranking = require('../game/ranking');
const view = require('../view');
const reservations = require('../game/reservations');

const { t, duration, clock, number, buildingName } = view;
const RES = cfg.physicalRes;
const MODES = ['combined', 'prod', 'units', 'buildings', 'commands', 'incomings', 'tech', 'groups', 'trader'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const RESERVE_ERR = (r) => ({
  noAlly: 'Reservieren kannst du nur als Stammesmitglied.', ownVillage: 'Eigene Dörfer lassen sich nicht reservieren.', reserved: `Das Dorf ist schon von ${r.owner} reserviert.`,
  reservedElsewhere: 'Das Dorf ist von einem anderen Stamm reserviert.', tooMany: 'Du hast schon zu viele Reservierungen.', noVillage: 'Dorf nicht gefunden.',
}[r.error] || 'Fehler.');

module.exports = ({ db, render, csrfOk }) => {
  const link = (vid, screen, extra = '') => `/game.php?village=${vid}&amp;screen=${screen}${extra}`;

  function ownVillages(userId, groupId) {
    if (groupId) {
      return db.prepare('SELECT v.* FROM village v JOIN village_group_member m ON m.village_id = v.id JOIN village_group g ON g.id = m.group_id WHERE g.id = ? AND g.user_id = ? AND v.user_id = ? ORDER BY v.name').all(groupId, userId, userId);
    }
    return db.prepare('SELECT * FROM village WHERE user_id = ? ORDER BY name').all(userId);
  }

  const villageCell = (current, v) => ({ html: `<a href="${link(v.id, 'overview')}">${esc(v.name)}</a> <span class="twl-small">(${v.x}|${v.y})</span>${v.id === current ? ' <b>•</b>' : ''}` });

  function build(mode, ctx, list) {
    const cur = ctx.vid;
    const cols = []; const rows = []; let foot = null;
    const settle = (v) => village.processQueue(db, v.id);

    if (mode === 'combined') {
      cols.push('Dorf', 'Punkte', ...RES.map((r) => t(`game.${r}`)), 'Speicher', 'Händler', 'Bauernhof', 'Bauschleife', 'Rekrutierung', 'Befehle');
      for (const v0 of list) {
        const v = settle(v0); units.processTraining(db, v.id);
        const lv = village.getBuildings(db, v.id);
        const q = village.getQueue(db, v.id)[0];
        const tq = units.getTrainQueue(db, v.id);
        const out = commands.listCommands(db, "from_village = ? AND type IN ('attack','support')", v.id).length;
        const inc = commands.listCommands(db, "to_village = ? AND type = 'attack'", v.id).length;
        rows.push([villageCell(cur, v), village.villagePoints(lv), ...RES.map((r) => Math.floor(v[r])), village.storageMax(lv),
          `${commands.merchantsFree(db, v.id)}/${commands.merchantsAt(lv.market)}`, `${village.unitPop(db, v.id) + village.popUsed(lv, [], 0)}/${village.popMax(lv)}`,
          q ? { html: `${esc(buildingName(q.building))} ${q.kind === 'destroy' ? '↓' : q.level} <span class="timer">${duration(q.finish_at - Date.now() / 1000)}</span>` } : '-',
          tq.length ? tq.map((x) => `${x.amount} ${t(`unit${x.unit[0].toUpperCase()}${x.unit.slice(1)}.${x.amount === 1 ? 'name' : 'plural'}`)}`).join(', ') : '-',
          { html: `${out ? `<img src="/graphic/command/attack.png" alt=""> ${out} ` : ''}${inc ? `<b class="warn">⚔ ${inc}</b>` : ''}` || '-' }]);
      }
    } else if (mode === 'prod') {
      cols.push('Dorf', ...RES.map((r) => `${t(`game.${r}`)} / h`), 'Voll in');
      for (const v0 of list) {
        const v = settle(v0); const lv = village.getBuildings(db, v.id); const max = village.storageMax(lv);
        const secs = Math.max(0, ...RES.map((r) => { const p = village.rate(db, v.id, lv, r) / 3600; return v[r] >= max ? 0 : (max - v[r]) / p; }));
        rows.push([villageCell(cur, v), ...RES.map((r) => number(village.rate(db, v.id, lv, r))), secs > 0 ? duration(secs) : 'voll']);
      }
    } else if (mode === 'units') {
      cols.push('Dorf', ...units.UNIT_IDS.map((x) => ({ html: `<img src="/graphic/unit/unit_${x}.png" title="${esc(t(`unit${x[0].toUpperCase()}${x.slice(1)}.plural`))}" alt="${x}">` })));
      const sum = Object.fromEntries(units.UNIT_IDS.map((x) => [x, 0]));
      for (const v of list) {
        units.processTraining(db, v.id);
        const h = units.getUnits(db, v.id);
        units.UNIT_IDS.forEach((x) => { sum[x] += h[x]; });
        rows.push([villageCell(cur, v), ...units.UNIT_IDS.map((x) => h[x] || '')]);
      }
      foot = ['Insgesamt', ...units.UNIT_IDS.map((x) => sum[x])];
    } else if (mode === 'buildings') {
      cols.push('Dorf', ...f.BUILDING_IDS.map((b) => ({ html: `<img src="/graphic/buildings/${b}.png" title="${esc(buildingName(b))}" alt="${b}">` })));
      for (const v of list) { const lv = village.getBuildings(db, v.id); const q = village.queuedLevels(db, v.id); rows.push([villageCell(cur, v), ...f.BUILDING_IDS.map((b) => (q[b] > lv[b] ? { html: `${lv[b]} <small>+${q[b] - lv[b]}</small>` } : lv[b] || ''))]); }
    } else if (mode === 'commands') {
      cols.push('Befehl', 'Von', 'Ziel', 'Truppen', 'Ankunft');
      const ids = list.map((v) => v.id);
      const all = ids.length ? commands.listCommands(db, `type IN ('attack','support','return') AND (from_village IN (${ids.map(() => '?').join(',')}) OR to_village IN (${ids.map(() => '?').join(',')}))`, ...ids, ...ids) : [];
      const label = (id) => { const r = db.prepare('SELECT name, x, y, user_id FROM village WHERE id = ?').get(id); return { html: `<a href="${link(cur, 'info_village', `&amp;id=${id}`)}">${esc(r.user_id ? r.name : 'Barbarendorf')}</a> <span class="twl-small">(${r.x}|${r.y})</span>` }; };
      for (const c of all) rows.push([{ html: `<img src="/graphic/command/${c.type === 'return' ? 'back' : c.type}.png" alt=""> ${{ attack: 'Angriff', support: 'Unterstützung', return: 'Rückkehr' }[c.type]}` }, label(c.from_village), label(c.to_village),
        Object.entries(c.units).map(([x, n]) => `${n} ${x}`).join(', '), { html: `${clock(c.arrive_at)} <span class="timer twl-small">${duration(c.arrive_at - Date.now() / 1000)}</span>` }]);
    } else if (mode === 'incomings') {
      cols.push('Typ', 'Von', 'Ziel', 'Ankunft');
      const ids = list.map((v) => v.id);
      const all = ids.length ? commands.listCommands(db, `type IN ('attack','support') AND to_village IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
      const label = (id) => { const r = db.prepare('SELECT v.name, v.x, v.y, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id WHERE v.id = ?').get(id); return { html: `${esc(r.name)} <span class="twl-small">(${r.x}|${r.y})</span>${r.owner ? ` – ${esc(r.owner)}` : ''}` }; };
      for (const c of all) rows.push([{ html: `<img src="/graphic/command/${c.type}.png" alt=""> ${c.type === 'attack' ? 'Angriff' : 'Unterstützung'}` }, label(c.from_village), label(c.to_village), { html: `${clock(c.arrive_at)} <span class="timer twl-small">${duration(c.arrive_at - Date.now() / 1000)}</span>` }]);
    } else if (mode === 'tech') {
      const techs = units.UNIT_IDS.filter(units.needsResearch);
      cols.push('Dorf', ...techs.map((x) => ({ html: `<img src="/graphic/unit/unit_${x}.png" title="${esc(x)}" alt="${x}">` })));
      for (const v of list) rows.push([villageCell(cur, v), ...techs.map((x) => (units.researchLevel(db, v.id, x) >= 1 ? '✓' : (units.getResearchQueue(db, v.id).some((q) => q.unit === x) ? '…' : '')))]);
    } else if (mode === 'trader') {
      cols.push('Dorf', 'Händler frei', 'Unterwegs');
      for (const v of list) { const lv = village.getBuildings(db, v.id); rows.push([villageCell(cur, v), `${commands.merchantsFree(db, v.id)}/${commands.merchantsAt(lv.market)}`, commands.merchantsBusy(db, v.id)]); }
    }
    return { cols, rows, foot };
  }

  return {
    async overview_villages(ctx) {
      const { req, res, vid } = ctx;
      const me = req.user;
      const mode = MODES.includes(ctx.mode) ? ctx.mode : 'combined';
      const groups = db.prepare('SELECT * FROM village_group WHERE user_id = ? ORDER BY name').all(me.id);
      const groupId = groups.some((g) => g.id === Number(req.query.group)) ? Number(req.query.group) : 0;
      const base = `/game.php?village=${vid}&screen=overview_villages&mode=${mode}`;

      if (req.method === 'POST') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        const body = req.body;
        if (req.query.action === 'group_add') {
          const name = String(body.name || '').trim().slice(0, 30);
          if (name && groups.length < 30) db.prepare('INSERT INTO village_group (user_id, name) VALUES (?,?)').run(me.id, name);
        } else if (req.query.action === 'group_delete') {
          db.prepare('DELETE FROM village_group WHERE id = ? AND user_id = ?').run(Number(body.group), me.id);
        } else if (req.query.action === 'group_set') {
          const g = groups.find((x) => x.id === Number(body.group));
          if (g) {
            const mine = new Set(db.prepare('SELECT id FROM village WHERE user_id = ?').all(me.id).map((r) => r.id));
            const wanted = new Set([].concat(body.villages || []).map(Number).filter((id) => mine.has(id)));
            db.prepare('DELETE FROM village_group_member WHERE group_id = ?').run(g.id);
            for (const id of wanted) db.prepare('INSERT INTO village_group_member (group_id, village_id) VALUES (?,?)').run(g.id, id);
          }
        }
        return res.redirect(`${base}`);
      }

      if (mode === 'groups') {
        const all = ownVillages(me.id, 0);
        const members = Object.fromEntries(groups.map((g) => [g.id, new Set(db.prepare('SELECT village_id FROM village_group_member WHERE group_id = ?').all(g.id).map((r) => r.village_id))]));
        return render(ctx, 'overview_villages', { mode, modes: MODES, groups, groupId, base, groupsPage: true, all, members, table: null }, { title: t('game.menu.overview.title'), mode });
      }
      const list = ownVillages(me.id, groupId);
      return render(ctx, 'overview_villages', { mode, modes: MODES, groups, groupId, base, groupsPage: false, table: build(mode, ctx, list), all: [], members: {} }, { title: t('game.menu.overview.title'), mode });
    },

    async info_village(ctx) {
      const { req, res, vid } = ctx;
      const id = Number(req.query.id) || vid;
      const row = db.prepare('SELECT v.*, u.name AS owner FROM village v LEFT JOIN user u ON u.id = v.user_id WHERE v.id = ?').get(id);
      if (!row) return res.redirect(`/game.php?village=${vid}&screen=overview`);
      const me = req.user;

      // The map's context menu adds and removes favourites with plain XHR GETs.
      if (req.query.ajaxaction === 'add_target' || req.query.ajaxaction === 'del_target') {
        if (req.get('x-requested-with') !== 'XMLHttpRequest') return res.status(403).json({ error: t('error.technical') });
        if (req.query.ajaxaction === 'add_target') db.prepare('INSERT OR IGNORE INTO favorite (user_id, village_id) VALUES (?,?)').run(me.id, id);
        else db.prepare('DELETE FROM favorite WHERE user_id = ? AND village_id = ?').run(me.id, id);
        return res.json({ response: { code: true, id } });
      }
      if (req.query.ajaxaction === 'toggle_reserve_village') {
        if (req.get('x-requested-with') !== 'XMLHttpRequest') return res.status(403).json({ error: t('error.technical') });
        const r = reservations.toggle(db, me, id);
        if (!r.ok) return res.json({ error: RESERVE_ERR(r) });
        return res.json({ response: { code: true, village: id, type: r.type, notice: r.type === 'add' ? 'Das Dorf wurde für dich reserviert.' : 'Die Reservierung wurde aufgehoben.' } });
      }
      if (req.method === 'POST') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        if (req.query.action === 'reserve') reservations.toggle(db, me, id);
        else if (req.query.action === 'fav_add') db.prepare('INSERT OR IGNORE INTO favorite (user_id, village_id) VALUES (?,?)').run(me.id, id);
        else if (req.query.action === 'fav_del') db.prepare('DELETE FROM favorite WHERE user_id = ? AND village_id = ?').run(me.id, id);
        else if (req.query.action === 'note' && row.user_id === me.id) db.prepare('UPDATE village SET note = ? WHERE id = ?').run(String(req.body.note || '').slice(0, 2000), id);
        return res.redirect(`/game.php?village=${vid}&screen=info_village&id=${id}`);
      }
      const here = db.prepare('SELECT x, y FROM village WHERE id = ?').get(vid);
      const levels = village.getBuildings(db, id);
      const ally = row.user_id ? db.prepare('SELECT a.id, a.name, a.tag FROM user u JOIN ally a ON a.id = u.ally_id WHERE u.id = ?').get(row.user_id) : null;
      const target = {
        ...row, name: row.user_id ? row.name : 'Barbarendorf', continent: ranking.continentOf(row.x, row.y), points: village.villagePoints(levels),
        distance: commands.distance(here, row), seconds: commands.travelSeconds({ spear: 1 }, here, row),
        loyalty: Math.round(village.loyaltyAt(row)), own: row.user_id === me.id, ally,
        reservation: reservations.forVillage(db, id),
      };
      return render(ctx, 'info_village', {
        me, target, isFav: !!db.prepare('SELECT 1 FROM favorite WHERE user_id = ? AND village_id = ?').get(me.id, id),
      }, { title: target.name });
    }
  };
};

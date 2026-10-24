'use strict';
const cfg = require('../config');
const village = require('../game/village');
const units = require('../game/units');
const noble = require('../game/noble');
const knight = require('../game/knight');
const church = require('../game/church');
const market = require('../game/market');
const commands = require('../game/commands');
const view = require('../view');

const { t } = view;
const RES = cfg.physicalRes;
const f = require('../game/formulas');
const camel = (id) => id.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');

const ERR = {
  resources: 'Nicht genug Rohstoffe.', requirements: 'Die Voraussetzungen sind nicht erfüllt.', population: 'Der Bauernhof ist zu klein.',
  limit: 'Das Adelsgeschlecht-Limit ist erreicht.', noCoins: 'Dafür fehlen Goldmünzen.', knightExists: 'Jeder Spieler darf nur einen Paladin haben.',
  nothing: 'Bitte eine Menge angeben.', merchants: 'Nicht genug Händler.', invalidTarget: 'Ziel nicht vorhanden.', sameVillage: 'Das Ziel ist das eigene Dorf.',
  badResources: 'Bitte zwei verschiedene Rohstoffe wählen.', badAmount: 'Ungültige Menge.', badRatio: 'Das Verhältnis ist zu unausgeglichen (höchstens 1 : 2,5).',
  noOffer: 'Das Angebot gibt es nicht mehr.', tooFar: 'Das Angebot ist zu weit entfernt.', noSource: t ? 'Fehler.' : '', noItem: 'Gegenstand nicht gefunden.',
  tooMany: 'Zu viele.', unknownUnit: 'Unbekannte Einheit.',
};
const errText = (code) => ERR[code] || t('error.technical');

const BODY = { wood: 'res', stone: 'res', iron: 'res', storage: 'storage', hide: 'hide', farm: 'farm', church: 'church', church_f: 'church' };

// Detail tables shown below the building header; `kind` selects the block in building.ejs.
function buildingModel(db, v, id) {
  const levels = village.getBuildings(db, v.id);
  const level = levels[id];
  const b = cfg.buildings[id];
  const hasNext = level < b.maxLevel;
  const next = { ...levels, [id]: level + 1 };
  const model = {
    b: { id }, level, hasNext, kind: BODY[id] || 'none',
    descKey: `building${id.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('')}.description`,
  };
  if (model.kind === 'res') {
    model.rows = RES.filter((r) => b.res.prod[r]).map((r) => ({
      res: r, local: f.production(id, r, level), nextLocal: f.production(id, r, level + 1),
      total: village.rate(db, v.id, levels, r), nextTotal: village.rate(db, v.id, next, r),
    }));
  } else if (model.kind === 'storage') {
    model.capacity = f.capacity('storage', 'wood', level);
    model.nextCapacity = f.capacity('storage', 'wood', level + 1);
    const max = village.storageMax(levels);
    model.fill = RES.map((r) => {
      const perSec = village.rate(db, v.id, levels, r) / 3600;
      const seconds = v[r] >= max ? 0 : (max - v[r]) / perSec;
      return { res: r, full: v[r] >= max, seconds, at: Date.now() / 1000 + seconds };
    });
  } else if (model.kind === 'hide') {
    model.hide = f.hideCapacity(level);
    model.nextHide = f.hideCapacity(level + 1);
    model.plunder = RES.map((r) => ({ res: r, amount: Math.max(0, Math.round(v[r] - model.hide)) }));
  } else if (model.kind === 'church') {
    model.radius = id === 'church_f' ? church.FIRST_RADIUS : church.radiusOf(level);
    model.nextRadius = id === 'church_f' ? church.FIRST_RADIUS : church.radiusOf(level + 1);
    model.noFaith = Math.round(church.NO_FAITH * 100);
  } else if (model.kind === 'farm') {
    model.pop = village.popUsed(levels, [], village.unitPop(db, v.id));
    model.popMax = village.popMax(levels);
    model.nextPopMax = village.popMax(next);
  }
  return model;
}


module.exports = ({ db, app, render, renderPartial, csrfOk }) => {
  async function head(ctx, id) {
    const level = village.getBuildings(db, ctx.vid)[id];
    return renderPartial(app, 'partials/building_head', { ...view.helpers, id, level, description: t(`building${camel(id)}.description`) });
  }
  const buildingLevel = (vid, id) => village.getBuildings(db, vid)[id];
  const needsBuilding = async (ctx, id) => {
    if (buildingLevel(ctx.vid, id) > 0) return null;
    render(ctx, 'bare', { html: await head(ctx, id) }, { title: view.buildingName(id) });
    return true; // answered: the caller must stop
  };
  const back = (ctx, extra = '') => ctx.res.redirect(`/game.php?village=${ctx.vid}&screen=${ctx.screen}${extra}`);
  const post = (ctx) => { if (ctx.req.method !== 'POST') return false; if (!csrfOk(ctx.req)) { ctx.res.status(403).send('Invalid token'); return null; } return true; };

  const trainingQueue = async (ctx, building) => {
    const events = units.getTrainQueue(db, ctx.vid, building);
    return renderPartial(app, 'partials/train_queue', { ...ctx.common, building, events, now: Date.now() / 1000, vid: ctx.vid });
  };

  // Resource buildings, warehouse, hideout and farm only show their numbers.
  const detail = (id) => async (ctx) => {
    const v = village.processQueue(db, ctx.vid);
    const model = buildingModel(db, v, id);
    return render(ctx, 'building', { ...model, head: await head(ctx, id) }, { title: view.buildingName(id) });
  };

  return {
    wood: detail('wood'), stone: detail('stone'), iron: detail('iron'), storage: detail('storage'), hide: detail('hide'), farm: detail('farm'), church: detail('church'), church_f: detail('church_f'),

    // ---- Adelshof ----
    async snob(ctx) {
      const { req, vid } = ctx;
      const stop = await needsBuilding(ctx, 'snob'); if (stop) return stop;
      const mode = ctx.mode === 'coin' ? 'coin' : 'train';
      let message = ''; let ok = false;
      if (req.query.action === 'cancel') {
        if (csrfOk(req)) units.cancelTraining(db, vid, Number(req.query.id));
        return back(ctx, `&mode=${mode}`);
      }
      const p = post(ctx); if (p === null) return undefined;
      if (p) {
        const n = Math.max(1, Math.floor(Number(req.body.amount) || 1));
        const r = mode === 'coin' ? noble.mint(db, vid, n) : units.enqueueTraining(db, vid, { snob: n });
        if (r.ok) { ok = true; message = mode === 'coin' ? t('buildingSnob.created', { x: `${n} ${t(n === 1 ? 'buildingSnob.coinsSingular' : 'buildingSnob.coinsPlural')}` }) : t('buildingMain.orderSuccess'); } else message = errText(r.error);
      }
      const v = village.processQueue(db, vid); units.processTraining(db, vid);
      const cost = noble.coinCost();
      return render(ctx, 'snob', {
        mode, message, ok, head: await head(ctx, 'snob'), summary: noble.summary(db, req.user.id), coinCost: cost, village: v,
        unit: cfg.units.snob, trainTime: units.recruitTime('snob', buildingLevel(vid, 'snob')), queueHtml: await trainingQueue(ctx, 'snob'),
        unitsHome: units.getUnits(db, vid).snob,
      }, { title: view.buildingName('snob'), mode });
    },

    // ---- Wall ----
    async wall(ctx) {
      const stop = await needsBuilding(ctx, 'wall'); if (stop) return stop;
      const level = buildingLevel(ctx.vid, 'wall');
      const bonus = (lvl) => (Math.pow(1.037, lvl) - 1) * 100;
      return render(ctx, 'wall', {
        head: await head(ctx, 'wall'), level, max: cfg.buildings.wall.maxLevel, bonus: bonus(level), nextBonus: level < cfg.buildings.wall.maxLevel ? bonus(level + 1) : null,
        basic: Math.round(cfg.world.basicDefense * Math.pow(1.037, level)),
      }, { title: view.buildingName('wall') });
    },

    // ---- Statue / Paladin ----
    async statue(ctx) {
      const { req, res, vid } = ctx;
      if (!cfg.world.knightActive) return res.redirect(`/game.php?village=${vid}&screen=overview`);
      const stop = await needsBuilding(ctx, 'statue'); if (stop) return stop;
      const mode = ctx.mode === 'inventory' ? 'inventory' : 'index';
      const me = req.user;
      let message = ''; let ok = false;
      if (req.query.action === 'cancel') {
        if (csrfOk(req)) units.cancelTraining(db, vid, Number(req.query.id));
        return back(ctx);
      }
      if (req.query.action === 'equip') {
        if (csrfOk(req)) knight.equip(db, me.id, String(req.query.item || ''));
        return back(ctx, '&mode=inventory');
      }
      const p = post(ctx); if (p === null) return undefined;
      if (p && req.query.action === 'recruit') {
        const r = units.enqueueTraining(db, vid, { knight: 1 });
        if (r.ok) return back(ctx); message = errText(r.error);
      } else if (p && req.query.action === 'move') {
        const r = commands.moveKnight(db, me.id, vid, Number(req.body.to));
        if (r.ok) return back(ctx);
        message = r.error === 'noStatue' ? 'Im Zieldorf steht keine Statue.' : r.error === 'noTroops' ? 'Der Paladin ist nicht im Dorf.' : 'Ungültiges Zieldorf.';
      } else if (p && req.query.action === 'rename') {
        const name = String(req.body.name || '').trim();
        if (name.length < 3 || name.length > 50) message = t('buildingStatue.palaNameError');
        else { db.prepare('UPDATE user SET knight_name = ? WHERE id = ?').run(name, me.id); ok = true; message = 'Gespeichert.'; }
      }
      units.processTraining(db, vid);
      const fresh = db.prepare('SELECT * FROM user WHERE id = ?').get(me.id);
      const owned = units.knightCount(db, me.id);
      const homeHere = units.getUnits(db, vid).knight || 0;
      const recruit = cfg.units.knight.recruitCosts;
      const targets = homeHere ? db.prepare('SELECT v.id, v.name, v.x, v.y FROM village v JOIN village_building b ON b.village_id = v.id AND b.building = \'statue\' AND b.level >= 1 WHERE v.user_id = ? AND v.id != ? ORDER BY v.name').all(me.id, vid) : [];
      return render(ctx, 'statue', {
        targets, mode, message, ok, head: await head(ctx, 'statue'), name: fresh.knight_name || 'Paladin', owned, homeHere,
        recruit, recruitTime: units.recruitTime('knight', buildingLevel(vid, 'statue')), queueHtml: await trainingQueue(ctx, 'statue'),
        inQueue: units.getTrainQueue(db, vid, 'statue').length > 0,
        items: knight.ITEM_IDS, poly: knight.POLY, foundItems: knight.found(db, me.id), equipped: knight.equipped(db, me.id), progress: knight.progress(db, me.id),
        itemInfo: knight.system, itemName: (i) => t(`knight.${i}`),
      }, { title: view.buildingName('statue'), mode, meta: { css: ['inventory.css'] } });
    },

    // ---- Markt ----
    async market(ctx) {
      const { req, res, vid } = ctx;
      const stop = await needsBuilding(ctx, 'market'); if (stop) return stop;
      const mode = ['send', 'buy', 'own_offer'].includes(ctx.mode) ? ctx.mode : 'send';
      const me = req.user;
      let message = ''; let ok = false;

      // ----- the map's "send resources" pop-up -----
      if (req.query.ajax === 'send' || req.query.ajax === 'confirm' || req.query.ajaxaction === 'map_send') {
        const src = req.query.ajax === 'send' ? req.query : req.body;
        const tg = db.prepare('SELECT * FROM village WHERE id = ? AND user_id IS NOT NULL').get(Number(src.target));
        if (!tg || tg.id === vid) return res.json({ error: errText('invalidTarget') });
        const info = { id: tg.id, x: tg.x, y: tg.y, name: tg.name };
        const v0 = village.processQueue(db, vid);
        const dialog = (name, locals) => renderPartial(app, `partials/${name}`, { ...ctx.common, ...locals });
        if (req.query.ajax === 'send') {
          return res.json({ response: { dialog: await dialog('map_market', { target: info, village: v0, total: commands.merchantsAt(buildingLevel(vid, 'market')), free: commands.merchantsFree(db, vid), capacity: commands.MERCHANT_CAPACITY }) } });
        }
        const amounts = Object.fromEntries(RES.map((r) => [r, Math.max(0, Math.floor(Number(req.body[r]) || 0))]));
        const sum = RES.reduce((acc, r) => acc + amounts[r], 0);
        if (!sum) return res.json({ error: errText('nothing') });
        if (req.query.ajax === 'confirm') {
          if (RES.some((r) => v0[r] < amounts[r])) return res.json({ error: errText('resources') });
          const merchants = Math.ceil(sum / commands.MERCHANT_CAPACITY);
          if (commands.merchantsFree(db, vid) < merchants) return res.json({ error: errText('merchants') });
          return res.json({ response: { dialog: await dialog('map_market_confirm', { target: info, res: amounts, merchants, seconds: commands.merchantSeconds(v0, tg) }) } });
        }
        const r = commands.sendResources(db, { userId: me.id, fromId: vid, toId: tg.id, res: amounts });
        return res.json(r.ok ? { response: { message: `${r.merchants} Händler sind unterwegs.` } } : { error: errText(r.error) });
      }
      if (req.query.action === 'cancel_offer') {
        if (csrfOk(req)) market.cancelOffer(db, me.id, Number(req.query.id));
        return back(ctx, '&mode=own_offer');
      }
      const p = post(ctx); if (p === null) return undefined;
      if (p) {
        const body = req.body;
        if (req.query.action === 'send') {
          const target = body.target ? db.prepare('SELECT id FROM village WHERE id = ?').get(Number(body.target)) : (() => {
            const m = /(\d{1,3})\s*[|:,. ]\s*(\d{1,3})/.exec(String(body.coord || ''));
            return m ? db.prepare('SELECT id FROM village WHERE x = ? AND y = ?').get(Number(m[1]), Number(m[2])) : null;
          })();
          const r = target ? commands.sendResources(db, { userId: me.id, fromId: vid, toId: target.id, res: { wood: body.wood, stone: body.stone, iron: body.iron } }) : { ok: false, error: 'invalidTarget' };
          if (r.ok) { ok = true; message = `${r.merchants} Händler sind unterwegs.`; } else message = errText(r.error);
        } else if (req.query.action === 'offer') {
          const r = market.createOffer(db, { userId: me.id, villageId: vid, sellRes: body.sell_res, sellAmount: Number(body.sell_amount), buyRes: body.buy_res, buyAmount: Number(body.buy_amount), maxDistance: Number(body.max_distance) || 0, multi: Number(body.multi) || 1 });
          if (r.ok) return back(ctx, '&mode=own_offer'); message = errText(r.error);
        } else if (req.query.action === 'accept') {
          const r = market.acceptOffer(db, { userId: me.id, villageId: vid, offerId: Number(body.offer), count: Number(body.count) || 1 });
          if (r.ok) { ok = true; message = 'Angebot angenommen, die Händler sind unterwegs.'; } else message = errText(r.error);
        }
      }
      const v = village.processQueue(db, vid);
      const total = commands.merchantsAt(buildingLevel(vid, 'market'));
      const free = commands.merchantsFree(db, vid);
      let tg = '';
      const tid = Number(req.query.target);
      if (tid) { const r = db.prepare('SELECT x, y FROM village WHERE id = ?').get(tid); if (r) tg = `${r.x}|${r.y}`; }
      const trades = commands.listCommands(db, "type = 'trade' AND (from_village = ? OR to_village = ?)", vid, vid).map((c2) => {
        const other = db.prepare('SELECT name, x, y FROM village WHERE id = ?').get(c2.from_village === vid ? c2.to_village : c2.from_village);
        return { ...c2, other, outgoing: c2.from_village === vid };
      });
      return render(ctx, 'market', {
        mode, message, ok, head: await head(ctx, 'market'), village: v, total, free, capacity: commands.MERCHANT_CAPACITY, target: tg,
        offers: mode === 'buy' ? market.openOffers(db, vid) : [], own: mode === 'own_offer' ? market.ownOffers(db, vid) : [], trades,
      }, { title: view.buildingName('market'), mode });
    },
  };
};

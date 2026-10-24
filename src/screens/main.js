'use strict';
const cfg = require('../config');
const f = require('../game/formulas');
const village = require('../game/village');
const view = require('../view');

const { t } = view;
const RES = cfg.physicalRes;

const ERR = {
  resources: () => t('buildingMain.tooFewRes', { when: '' }), requirements: () => t('buildingMain.requirementsNot'), population: () => t('buildingMain.farmTooSmall'),
  queueFull: () => 'Die Bauschleife ist voll.', noDestroy: () => t('buildingMain.noDestroy'), fullyDestroyed: () => t('buildingMain.fullyDestroyed'),
  maxLevel: () => t('buildingMain.fullyBuilt'), noBuilding: () => t('buildingMain.unknownBuilding'), dependent: () => 'Diese Reihenfolge ist nicht möglich.',
  badOrder: () => t('error.technical'), nothingToSort: () => t('error.technical'),
};
const errText = (code) => (ERR[code] ? ERR[code]() : t('error.technical'));

module.exports = ({ db, app, render, renderPartial, gameData, csrfOk }) => {
  // Human readable reason why a building cannot be queued right now.
  function stateText(v, id, state, queued) {
    if (state === true) return '';
    switch (state) {
      case 'queueFull': return ERR.queueFull();
      case 'requirements': return t('buildingMain.requirementsNot');
      case 'population': return t('buildingMain.farmTooSmall');
      case 'resources': {
        const factor = village.queueFactor(village.getQueue(db, v.id).length);
        const levels = village.getBuildings(db, v.id);
        const secs = Math.max(...RES.map((r) => {
          const missing = village.scaled(f.buildCost(id, r, queued[id] + 1), factor) - v[r];
          const prod = village.rate(db, v.id, levels, r) / 3600;
          return missing > 0 ? (prod > 0 ? missing / prod : Infinity) : 0;
        }));
        return Number.isFinite(secs) ? t('buildingMain.tooFewRes', { when: view.clock(Date.now() / 1000 + secs) }) : t('buildingMain.storageTooSmall');
      }
      default: return t('buildingMain.cannotBuild');
    }
  }

  // Everything the headquarters needs, shared by the page and its AJAX answers.
  function model(v, destroy) {
    const levels = village.getBuildings(db, v.id);
    const queued = village.queuedLevels(db, v.id);
    const queue = village.getQueue(db, v.id);
    const factor = village.queueFactor(queue.length);
    const active = []; const inactive = []; const buildingData = {};
    for (const id of f.BUILDING_IDS) {
      const b = cfg.buildings[id];
      const level = levels[id];
      if (destroy) {
        if (queued[id] <= b.minLevel) continue;
        const time = f.buildTime(id, queued[id], levels.main) / 2;
        active.push({ id, level, nextLevel: queued[id] - 1, costs: {}, time, state: queue.length >= cfg.world.buildqueueStart ? 'queueFull' : true, stateText: queue.length >= cfg.world.buildqueueStart ? ERR.queueFull() : '' });
        buildingData[id] = { id, level: queued[id], wood: 0, stone: 0, iron: 0, pop: 0, can_build: queue.length < cfg.world.buildqueueStart, error: '' };
        continue;
      }
      const missing = village.missingRequirements(queued, id);
      const next = queued[id] + 1;
      const state = next > b.maxLevel ? 'maxLevel' : village.canBuild(db, v, id);
      if (missing.length && level === 0) {
        inactive.push({ id, level, requirements: Object.entries(b.requirements).map(([rb, rl]) => ({ building: rb, level: rl, have: queued[rb], met: queued[rb] >= rl })) });
        continue;
      }
      const costs = Object.fromEntries([...RES, 'population'].map((r) => [r, r === 'population' ? f.buildPopulation(id, next) : village.scaled(f.buildCost(id, r, next), factor)]));
      active.push({ id, level, nextLevel: next, costs, time: f.buildTime(id, next, levels.main), state, stateText: stateText(v, id, state, queued) });
      buildingData[id] = { id, level: queued[id], wood: costs.wood, stone: costs.stone, iron: costs.iron, pop: costs.population, can_build: state === true, error: stateText(v, id, state, queued) };
    }
    return { levels, queue, active, inactive, buildingData, queueFactor: factor, destroy: !!destroy };
  }

  async function partials(common, v, destroy) {
    const m = model(v, destroy);
    const locals = { ...common, village: v, now: Date.now() / 1000, mode: destroy ? 'destroy' : 'build', ...m };
    return { m, locals, queueHtml: await renderPartial(app, 'partials/main_queue', locals), buildingsHtml: await renderPartial(app, 'partials/main_buildings', locals) };
  }

  const resourcesOf = (vid) => { const v = village.processQueue(db, vid); return [Math.floor(v.wood), Math.floor(v.stone), Math.floor(v.iron)]; };

  async function ajax(ctx, destroy) {
    const { req, res, vid, common } = ctx;
    const action = req.query.ajaxaction;
    const id = String(req.body.id || req.query.id || '');
    const legacy = req.query.type === 'vis' || req.query.type === 'class';

    if (action === 'get_possible_building_upgrades') {
      const m = model(village.processQueue(db, vid), false);
      return res.json({ buildings: Object.fromEntries(m.active.filter((b) => b.state === true).map((b) => [b.id, { wood: b.costs.wood, stone: b.costs.stone, iron: b.costs.iron, pop: b.costs.population }])), confirm_queue: village.queueFactor(m.queue.length) > 1 });
    }
    if (action === 'buildorder_reorder') {
      const raw = req.query['buildorder[]'] ?? req.query.buildorder ?? [];
      const order = [].concat(raw).map(Number);
      const r = village.reorderBuild(db, vid, order);
      if (!r.ok) return res.json({ error: errText(r.error) });
    } else if (action === 'upgrade_building' || action === 'downgrade_building') {
      if (legacy && req.get('x-requested-with') !== 'XMLHttpRequest') return res.status(403).json({ error: t('error.technical') });
      const r = action === 'downgrade_building' ? village.enqueueDestroy(db, vid, id) : village.enqueueBuild(db, vid, id);
      if (!r.ok) return res.json({ error: errText(r.error) });
      if (legacy) {
        const v = village.processQueue(db, vid);
        const m = model(v, false);
        const levels = village.getBuildings(db, vid);
        return res.json({
          success: true, confirm_queue: village.queueFactor(m.queue.length) > 1, resources: resourcesOf(vid), population: village.popUsed(levels, [], village.unitPop(db, vid)),
          date_complete_formated: view.clock(r.finishAt), storage_full_time: '',
          building_orders: await renderPartial(app, 'partials/overview_queue', { ...common, village: v, now: Date.now() / 1000, ...m }),
        });
      }
    } else if (action === 'cancel_order') {
      const r = village.cancelBuild(db, vid, Number(req.body.id));
      if (!r.ok) return res.json({ error: errText(r.error) });
    } else if (action !== 'reload') return res.json({ error: t('error.technical') });

    const v = village.processQueue(db, vid);
    const p = await partials(common, v, destroy);
    const levels = village.getBuildings(db, vid);
    return res.json({
      response: {
        building_orders: p.m.queue.length ? p.queueHtml : '', next_buildings: p.buildingsHtml,
        population: village.popUsed(levels, [], village.unitPop(db, vid)), confirm_queue: p.m.queueFactor > 1,
      },
      game_data: gameData(req.user, v, 'main', destroy ? 'destroy' : 'build'),
    });
  }

  return {
    async main(ctx) {
      const { req, res, vid, common, isAjax } = ctx;
      if (req.method === 'POST' && req.query.action === 'change_name') {
        if (!csrfOk(req)) return res.status(403).send('Invalid token');
        const name = String(req.body.name || '').trim();
        if (name.length >= 3 && name.length <= 32) db.prepare('UPDATE village SET name = ? WHERE id = ?').run(name, vid);
        return res.redirect(`/game.php?village=${vid}&screen=main`);
      }
      const destroyAvailable = village.getBuildings(db, vid).main >= 15;
      const destroy = ctx.mode === 'destroy' && destroyAvailable;
      if (isAjax) return ajax(ctx, destroy);
      const v = village.processQueue(db, vid);
      const p = await partials(common, v, destroy);
      return render(ctx, 'main', { ...p.m, queueHtml: p.queueHtml, buildingsHtml: p.buildingsHtml, destroyAvailable, mode: destroy ? 'destroy' : 'build' }, {
        title: t('buildingMain.name'), mode: destroy ? 'destroy' : 'build', meta: { js: ['building_main.js'] },
      });
    },
  };
};

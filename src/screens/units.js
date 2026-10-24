'use strict';
const cfg = require('../config');
const village = require('../game/village');
const units = require('../game/units');
const view = require('../view');

const { t } = view;

const ERR = {
  resources: () => t('buildingMain.tooFewRes', { when: '' }), requirements: () => t('buildingMain.requirementsNot'),
  population: () => t('buildingMain.farmTooSmall'), noCoins: () => 'Dafür fehlen Goldmünzen.', knightExists: () => t('buildingStatue.palaExists'),
};
const errText = (code) => (ERR[code] ? ERR[code]() : t('error.technical'));
const resourcesOf = (db, vid) => { const v = village.processQueue(db, vid); return [Math.floor(v.wood), Math.floor(v.stone), Math.floor(v.iron)]; };

// What the recruitment screen of one building shows: units that can be ordered and those still locked.
function trainModel(db, v, building) {
  const levels = village.getBuildings(db, v.id);
  const counts = units.getUnits(db, v.id);
  const mine = units.UNIT_IDS.filter((u) => cfg.units[u].recruitBuilding === building);
  const available = []; const unavailable = [];
  for (const u of mine) {
    const c = cfg.units[u].recruitCosts;
    if (units.isRecruitable(db, v.id, levels, u)) {
      available.push({
        id: u, cost: c, time: units.recruitTime(u, levels[building]), count: counts[u],
        max: units.maxRecruitable(db, v, levels, u),
      });
    } else {
      unavailable.push({
        id: u, requirements: Object.entries(cfg.units[u].requirements || {}),
        needsResearch: units.needsResearch(u) && units.researchLevel(db, v.id, u) < 1,
      });
    }
  }
  return { available, unavailable, events: units.getTrainQueue(db, v.id, building), building };
}

function smithModel(db, v) {
  const levels = village.getBuildings(db, v.id);
  const techs = units.UNIT_IDS.filter(units.needsResearch).map((u) => {
    const state = units.canResearch(db, v.id, levels, u);
    const message = state === 'requirements' ? Object.entries(cfg.units[u].requirements).map(([b, l]) => `${view.buildingName(b)} (${t('building.level', { x: l })})`).join(', ')
      : state === 'queued' ? t('buildingSmith.eventResearch') : '';
    return { id: u, state, message, cost: units.researchCost(u) };
  });
  return { techs, events: units.getResearchQueue(db, v.id) };
}

module.exports = ({ db, app, render, renderPartial, gameData }) => {
  async function head(ctx, id) {
    const level = village.getBuildings(db, ctx.vid)[id];
    const camel = id[0].toUpperCase() + id.slice(1);
    return { level, html: await renderPartial(app, 'partials/building_head', { id, level, description: t(`building${camel}.description`) }) };
  }

  async function trainAjax(ctx, building) {
    const { req, res, vid, common } = ctx;
    const action = req.query.ajaxaction;
    let msg;
    if (action === 'train') {
      const r = units.enqueueTraining(db, vid, req.body.units || {});
      if (!r.ok) return res.json({ error: errText(r.error) });
      msg = t('buildingMain.orderSuccess');
    } else if (action === 'cancel') {
      const r = units.cancelTraining(db, vid, Number(req.body.id));
      if (!r.ok) return res.json({ error: errText(r.error) });
    } else return res.json({ error: t('error.technical') });
    const v = village.processQueue(db, vid);
    const model = trainModel(db, v, building);
    const levels = village.getBuildings(db, vid);
    return res.json({
      response: {
        success: true, msg,
        current_order: model.events.length ? await renderPartial(app, 'partials/train_queue', { ...common, village: v, now: Date.now() / 1000, ...model }) : '',
        resources: resourcesOf(db, vid), population: village.popUsed(levels, [], village.unitPop(db, vid)),
      },
      game_data: gameData(req.user, v, building, 'train'),
    });
  }

  async function trainScreen(ctx, building) {
    const { vid, v, common } = ctx;
    if (ctx.isAjax) return trainAjax(ctx, building);
    const { level, html } = await head(ctx, building);
    if (level < 1) return render(ctx, 'bare', { html }, { title: view.buildingName(building) });
    const model = trainModel(db, v, building);
    const locals = { ...common, ...model };
    const unitData = Object.fromEntries(model.available.map((u) => [u.id, { wood: u.cost.wood, stone: u.cost.stone, iron: u.cost.iron, pop: u.cost.population, build_time: u.time, requirements_met: true }]));
    const levels = village.getBuildings(db, vid);
    const script = `<script type="text/javascript">
$(document).ready(function () {
  TrainOverview.init(); TrainOverview.initSingleVillageMode();
  TrainOverview.pop_max = ${village.popMax(levels)};
  TrainOverview.train_link = "/game.php?village=${vid}&ajaxaction=train&mode=train&screen=${building}";
  TrainOverview.cancel_link = "/game.php?village=${vid}&ajaxaction=cancel&screen=${building}&mode=train";
});
unit_managers = {};
unit_managers.units = ${JSON.stringify(unitData)};
var unit_build_block = new UnitBuildManager(0, { res: { wood: ${Math.floor(v.wood)}, stone: ${Math.floor(v.stone)}, iron: ${Math.floor(v.iron)}, pop: ${village.popMax(levels) - village.popUsed(levels, [], village.unitPop(db, vid))} } });
setTimeout(function () { unit_build_block._onchange(); }, 1);
</script>`;
    const body = (await renderPartial(app, 'partials/train_queue', locals)) + (await renderPartial(app, 'partials/train_form', locals));
    return render(ctx, 'bare', { html: `${html}<br /><table width="100%"><tr><td>${body}</td></tr></table>${script}` }, {
      title: view.buildingName(building), mode: 'train', meta: { js: ['TrainManager.js', 'trainqueue.js', 'unit_popup.js'] },
    });
  }

  async function smithAjax(ctx) {
    const { req, res, vid, common } = ctx;
    const action = req.query.ajaxaction;
    if (action === 'research') {
      const r = units.enqueueResearch(db, vid, String(req.body.tech_id));
      if (!r.ok) return res.json({ error: errText(r.error) });
    } else if (action === 'cancel') {
      const q = db.prepare('SELECT * FROM research_queue WHERE id = ? AND village_id = ?').get(Number(req.body.order_id), vid);
      if (!q) return res.json({ error: t('error.technical') });
      village.processQueue(db, vid);
      const c = units.researchCost(q.unit);
      db.prepare('DELETE FROM research_queue WHERE id = ?').run(q.id);
      db.prepare('UPDATE village SET wood = wood + ?, stone = stone + ?, iron = iron + ? WHERE id = ?').run(c.wood, c.stone, c.iron, vid);
      // The remaining orders move forward to fill the gap.
      let cursor = Date.now() / 1000;
      for (const o of units.getResearchQueue(db, vid)) {
        const fin = cursor + units.researchCost(o.unit).time;
        db.prepare('UPDATE research_queue SET start_at = ?, finish_at = ? WHERE id = ?').run(cursor, fin, o.id);
        cursor = fin;
      }
    } else return res.json({ error: t('error.technical') });
    const v = village.processQueue(db, vid);
    const model = smithModel(db, v);
    const locals = { ...common, village: v, now: Date.now() / 1000, ...model };
    return res.json({
      response: {
        current_research: model.events.length ? await renderPartial(app, 'partials/smith_queue', locals) : '',
        tech_list: await renderPartial(app, 'partials/smith_list', locals),
      },
      game_data: gameData(req.user, v, 'smith', null),
    });
  }

  async function smithScreen(ctx) {
    const { vid, v, common } = ctx;
    if (ctx.isAjax) return smithAjax(ctx);
    const { level, html } = await head(ctx, 'smith');
    if (level < 1) return render(ctx, 'bare', { html }, { title: view.buildingName('smith') });
    const model = smithModel(db, v);
    const locals = { ...common, ...model };
    const available = Object.fromEntries(model.techs.filter((u) => u.state === true).map((u) => [u.id, { id: u.id, can_research: true, ...u.cost }]));
    const script = `<script type="text/javascript">
BuildingSmith.link_research = "/game.php?village=${vid}&ajaxaction=research&screen=smith";
BuildingSmith.link_cancel = "/game.php?village=${vid}&ajaxaction=cancel&screen=smith";
BuildingSmith.link_remove = "/game.php?village=${vid}&ajaxaction=remove&screen=smith";
BuildingSmith.techs = { available: ${JSON.stringify(available)} };
$(document).ready(function () { BuildingSmith.init(); });
</script>`;
    const body = `${await renderPartial(app, 'partials/smith_queue', locals)}${await renderPartial(app, 'partials/smith_list', locals)}`;
    return render(ctx, 'bare', { html: `${html}<br />${script}${body}` }, { title: view.buildingName('smith'), meta: { js: ['building_smith.js', 'techqueue.js'] } });
  }

  return {
    barracks: (ctx) => trainScreen(ctx, 'barracks'),
    stable: (ctx) => trainScreen(ctx, 'stable'),
    garage: (ctx) => trainScreen(ctx, 'garage'),
    smith: smithScreen,
  };
};

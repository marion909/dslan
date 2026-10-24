'use strict';
const cfg = require('../config');
const v = require('./village');
const c = require('./commands');
const { transaction } = require('../db');

const RES = cfg.physicalRes;
const now = () => Math.floor(Date.now() / 1000);

const marketLevel = (db, villageId) => v.getBuildings(db, villageId).market;

// The seller's goods are held back when the offer is made, so accepting never depends on the seller being online.
function createOffer(db, { userId, villageId, sellRes, sellAmount, buyRes, buyAmount, maxDistance = 0, multi = 1 }) {
  return transaction(db, () => {
    const village = v.processQueue(db, villageId);
    if (!village || village.user_id !== userId) return { ok: false, error: 'noSource' };
    if (marketLevel(db, villageId) < 1) return { ok: false, error: 'requirements' };
    sellAmount = Math.floor(sellAmount); buyAmount = Math.floor(buyAmount); multi = Math.floor(multi); maxDistance = Math.max(0, Math.floor(maxDistance) || 0);
    if (!RES.includes(sellRes) || !RES.includes(buyRes) || sellRes === buyRes) return { ok: false, error: 'badResources' };
    if (!(sellAmount > 0 && buyAmount > 0 && multi >= 1 && multi <= 100)) return { ok: false, error: 'badAmount' };
    if (buyAmount > sellAmount * 2.5 || sellAmount > buyAmount * 2.5) return { ok: false, error: 'badRatio' }; // keeps the exchange rate fair
    const total = sellAmount * multi;
    if (village[sellRes] < total) return { ok: false, error: 'resources' };
    village[sellRes] -= total;
    db.prepare(`UPDATE village SET ${sellRes} = ? WHERE id = ?`).run(village[sellRes], villageId);
    const info = db.prepare('INSERT INTO market_offer (village_id, sell_res, sell_amount, buy_res, buy_amount, max_distance, multi, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(villageId, sellRes, sellAmount, buyRes, buyAmount, maxDistance, multi, now());
    return { ok: true, id: Number(info.lastInsertRowid) };
  });
}

function cancelOffer(db, userId, offerId) {
  return transaction(db, () => {
    const offer = db.prepare('SELECT o.*, vl.user_id FROM market_offer o JOIN village vl ON vl.id = o.village_id WHERE o.id = ?').get(offerId);
    if (!offer || offer.user_id !== userId) return { ok: false, error: 'noOffer' };
    const village = v.processQueue(db, offer.village_id);
    const cap = v.storageMax(v.getBuildings(db, offer.village_id));
    const refund = offer.sell_amount * offer.multi;
    village[offer.sell_res] = Math.min(Math.max(cap, village[offer.sell_res]), village[offer.sell_res] + refund);
    db.prepare(`UPDATE village SET ${offer.sell_res} = ? WHERE id = ?`).run(village[offer.sell_res], offer.village_id);
    db.prepare('DELETE FROM market_offer WHERE id = ?').run(offerId);
    return { ok: true };
  });
}

// Offers of other villages the viewer can still reach.
function openOffers(db, villageId) {
  const me = db.prepare('SELECT x, y FROM village WHERE id = ?').get(villageId);
  return db.prepare('SELECT o.*, vl.name, vl.x, vl.y, vl.user_id, u.name AS owner FROM market_offer o JOIN village vl ON vl.id = o.village_id LEFT JOIN user u ON u.id = vl.user_id WHERE o.village_id != ? ORDER BY o.created_at DESC LIMIT 200').all(villageId)
    .map((o) => ({ ...o, distance: c.distance(me, o) }))
    .filter((o) => !o.max_distance || o.distance <= o.max_distance);
}

function acceptOffer(db, { userId, villageId, offerId, count = 1 }) {
  return transaction(db, () => {
    count = Math.floor(count);
    const buyer = v.processQueue(db, villageId);
    if (!buyer || buyer.user_id !== userId) return { ok: false, error: 'noSource' };
    const offer = db.prepare('SELECT * FROM market_offer WHERE id = ?').get(offerId);
    if (!offer || offer.village_id === villageId) return { ok: false, error: 'noOffer' };
    if (!(count >= 1 && count <= offer.multi)) return { ok: false, error: 'badAmount' };
    const seller = db.prepare('SELECT * FROM village WHERE id = ?').get(offer.village_id);
    if (offer.max_distance && c.distance(buyer, seller) > offer.max_distance) return { ok: false, error: 'tooFar' };
    const pay = offer.buy_amount * count; const get = offer.sell_amount * count;
    if (buyer[offer.buy_res] < pay) return { ok: false, error: 'resources' };
    const needed = Math.ceil(pay / c.MERCHANT_CAPACITY);
    if (c.merchantsFree(db, villageId) < needed) return { ok: false, error: 'merchants' };

    // Payment goes to the seller with the buyer's merchants; the goods follow without tying up seller merchants.
    buyer[offer.buy_res] -= pay;
    db.prepare(`UPDATE village SET ${offer.buy_res} = ? WHERE id = ?`).run(buyer[offer.buy_res], villageId);
    const t = Date.now() / 1000;
    const goodsRes = Object.fromEntries(RES.map((r) => [r, r === offer.sell_res ? get : 0]));
    const payRes = Object.fromEntries(RES.map((r) => [r, r === offer.buy_res ? pay : 0]));
    const insert = db.prepare('INSERT INTO command (type, from_village, to_village, units, loot, depart_at, arrive_at) VALUES (?,?,?,?,?,?,?)');
    insert.run('trade', villageId, seller.id, JSON.stringify({ merchants: needed }), JSON.stringify(payRes), t, t + c.merchantSeconds(buyer, seller));
    insert.run('trade', seller.id, villageId, JSON.stringify({ merchants: 0 }), JSON.stringify(goodsRes), t, t + c.merchantSeconds(buyer, seller));
    if (count === offer.multi) db.prepare('DELETE FROM market_offer WHERE id = ?').run(offerId);
    else db.prepare('UPDATE market_offer SET multi = multi - ? WHERE id = ?').run(count, offerId);
    return { ok: true };
  });
}

const ownOffers = (db, villageId) => db.prepare('SELECT * FROM market_offer WHERE village_id = ? ORDER BY created_at DESC').all(villageId);

module.exports = { createOffer, cancelOffer, openOffers, acceptOffer, ownOffers, marketLevel };

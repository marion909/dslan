'use strict';
const crypto = require('node:crypto');
const cfg = require('../config');
const settings = require('../settings');
const village = require('./village');
const units = require('./units');
const commands = require('./commands');
const combat = require('./combat');
const market = require('./market');
const ally = require('./ally');
const noble = require('./noble');
const knight = require('./knight');
const relics = require('./relics');
const quests = require('./quests');
const reservations = require('./reservations');
const ranking = require('./ranking');
const world = require('./world');
const f = require('./formulas');
const { transaction } = require('../db');

// Bots are ordinary users that are driven by the game's own functions: they obey the same costs,
// queues, protection and travel times as a human, and they cannot log in.
const now = () => Date.now() / 1000;
const RES = cfg.physicalRes;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const chance = (rng, p) => rng() < p;

const FIRST = ['Aldric', 'Bertram', 'Cedric', 'Dietmar', 'Eberhard', 'Falko', 'Gernot', 'Hartmut', 'Ingolf', 'Jorund', 'Konrad', 'Lothar', 'Magnus', 'Norbert', 'Ottokar', 'Parzival', 'Quirin', 'Rüdiger', 'Siegfried', 'Tankred', 'Ulrich', 'Volker', 'Wolfram', 'Xaver', 'Yngvar', 'Zeno', 'Adelheid', 'Brunhild', 'Clara', 'Dorothea', 'Edda', 'Frieda', 'Gisela', 'Hildegard', 'Irmgard', 'Jutta', 'Kunigunde', 'Liesel', 'Mechthild', 'Notburga'];
const LAST = ['Eisenfaust', 'Rabenstein', 'Wolfsburg', 'Löwenherz', 'Steinbrecher', 'Nordwind', 'Falkenauge', 'Bärenklau', 'Schwarzwald', 'Donnerhall', 'Silberbach', 'Feuerbrand', 'Grauwolf', 'Adlerhorst', 'Hammerschlag', 'Nebelmoor', 'Sturmfels', 'Dornwald', 'Kupferkessel', 'Morgenrot'];
const TRIBES = ['Wölfe', 'Raben', 'Löwen', 'Adler', 'Bären', 'Falken', 'Drachen', 'Eber', 'Füchse', 'Hirsche'];
const TRIBE_SUFFIX = ['des Nordens', 'vom Rhein', 'der Eiche', 'des Sturms', 'der Mark', 'am Fluss'];
const PROFILES = ['Ich baue, handle und verteidige mein Dorf.', 'Wer mich angreift, wird es bereuen.', 'Friedlicher Händler sucht Verbündete.', 'Für Ruhm und Beute!', 'Jedes Dorf hat seinen Preis.'];
const REPLIES = ['Danke für deine Nachricht! Ich bin gerade mit dem Ausbau meiner Dörfer beschäftigt, melde mich aber gern später.', 'Hallo! Ich bin offen für Absprachen, schau doch mal in unser Stammesforum.', 'Schön von dir zu hören. Vielleicht kämpfen wir irgendwann Seite an Seite.', 'Nachricht erhalten – ich halte die Augen offen.'];
const THREADS = [['Truppenplanung', 'Wer hat noch Kapazität für Unterstützung? Meldet euch.'], ['Ziele in der Nähe', 'Ich habe ein paar lohnende Barbarendörfer entdeckt. Bitte vorher reservieren.'], ['Ressourcen', 'Falls jemand Holz oder Lehm übrig hat: ich tausche gern auf dem Markt.']];

const PERSONAS = ['builder', 'warrior', 'conqueror'];

// Build order as [building, level] steps; the bot works down the list and builds the first
// step that is allowed. A step it cannot pay for yet is waited for, one that is locked is skipped.
const eco = (l) => [['wood', l], ['stone', l], ['iron', l]];
const LADDER = {
  builder: [['main', 5], ...eco(8), ['farm', 8], ['storage', 8], ['barracks', 3], ['main', 10], ['smith', 3], ['wall', 5], ['market', 4], ...eco(14), ['farm', 14], ['storage', 14],
    ['barracks', 8], ['stable', 3], ['hide', 4], ['main', 15], ['wall', 10], ['market', 10], ['smith', 10], ['statue', 1], ...eco(20), ['farm', 22], ['storage', 20], ['main', 20], ['smith', 20], ['barracks', 15], ['wall', 15], ...eco(26), ['farm', 28]],
  warrior: [['main', 4], ...eco(6), ['farm', 7], ['storage', 6], ['barracks', 5], ['smith', 3], ['main', 8], ['stable', 3], ['wall', 3], ['market', 3], ...eco(11), ['farm', 12], ['storage', 11], ['barracks', 10], ['smith', 8], ['garage', 3],
    ['main', 12], ['stable', 8], ['statue', 1], ...eco(16), ['farm', 18], ['storage', 16], ['barracks', 18], ['smith', 14], ['garage', 8], ['market', 8], ['hide', 5], ['main', 16], ...eco(22), ['farm', 24], ['wall', 8]],
  conqueror: [['main', 5], ...eco(8), ['farm', 8], ['storage', 8], ['barracks', 4], ['main', 10], ['smith', 5], ['market', 5], ['wall', 4], ...eco(13), ['farm', 14], ['storage', 13], ['barracks', 8], ['stable', 4], ['main', 15], ['smith', 12], ['market', 10],
    ...eco(18), ['farm', 20], ['storage', 18], ['main', 20], ['smith', 20], ['snob', 1], ['barracks', 14], ['garage', 5], ['statue', 1], ...eco(24), ['farm', 26], ['wall', 10]],
};

// Share of each recruit order that goes to each unit (spy is handled separately).
const MIX = {
  builder: { spear: 5, sword: 3, archer: 1, spy: 0.6, light: 0.5, ram: 0.2 },
  warrior: { axe: 6, light: 3, spear: 2, ram: 1.2, spy: 0.7, marcher: 1, catapult: 0.3, heavy: 1 },
  conqueror: { axe: 6, light: 3, spear: 2, ram: 1.5, catapult: 1, spy: 0.8, heavy: 1 },
};
const OFFENSE = ['axe', 'light', 'marcher', 'heavy', 'ram', 'catapult'];
const DEFENSE = ['spear', 'sword', 'archer'];

function log(db, userId, text) {
  db.prepare('INSERT INTO bot_log (time, user_id, text) VALUES (?,?,?)').run(Math.floor(now()), userId, text);
  db.prepare('DELETE FROM bot_log WHERE id < (SELECT COALESCE(MAX(id), 0) - 600 FROM bot_log)').run();
}

const stateOf = (row) => { try { return JSON.parse(row.state); } catch { return {}; } };

// ---------------------------------------------------------------- creation / removal
function uniqueName(db, rng, mark) {
  for (let i = 0; i < 200; i++) {
    const name = `${pick(rng, FIRST)} ${pick(rng, LAST)}${mark ? ' [Bot]' : ''}`;
    if (!db.prepare('SELECT 1 FROM user WHERE name = ?').get(name)) return name;
  }
  return `Bot${crypto.randomBytes(3).toString('hex')}${mark ? ' [Bot]' : ''}`;
}

function create(db, rng = Math.random) {
  const s = settings.load(db);
  const persona = pick(rng, ['builder', 'builder', 'warrior', 'warrior', 'conqueror']);
  return transaction(db, () => {
    const name = uniqueName(db, rng, s.botMark === '1');
    const info = db.prepare('INSERT INTO user (name, password_hash, is_admin, created_at, is_bot, profile) VALUES (?,?,0,?,1,?)')
      .run(name, `bot:${crypto.randomBytes(16).toString('hex')}`, Math.floor(now()), pick(rng, PROFILES));
    const userId = Number(info.lastInsertRowid);
    const spot = world.pickSpot(db, { direction: pick(rng, ['random', 'nw', 'no', 'sw', 'so']) });
    village.createVillage(db, { userId, name: `${name.replace(' [Bot]', '')}s Dorf`, ...spot });
    db.prepare('INSERT INTO bot (user_id, persona, next_at, state) VALUES (?,?,?,?)').run(userId, persona, now() + rng() * 20, '{}');
    ranking.invalidate();
    log(db, userId, `${name} ist der Welt beigetreten (${persona}).`);
    return userId;
  });
}

function remove(db, userId) {
  db.prepare('DELETE FROM user WHERE id = ? AND is_bot = 1').run(userId);
  ranking.invalidate();
}

// Makes the number of bots match the setting: new ones join, the weakest ones leave.
function sync(db, count = Number(settings.load(db).botCount), rng = Math.random) {
  count = Math.max(0, Math.min(200, Math.floor(count) || 0));
  const have = db.prepare('SELECT user_id FROM bot').all().map((r) => r.user_id);
  let created = 0; let removed = 0;
  for (let i = have.length; i < count; i++) { create(db, rng); created++; }
  if (have.length > count) {
    const points = new Map(ranking.players(db).map((p) => [p.id, p.points]));
    const weakest = [...have].sort((a, b) => (points.get(a) || 0) - (points.get(b) || 0)).slice(0, have.length - count);
    for (const id of weakest) { remove(db, id); removed++; }
  }
  return { created, removed, total: count };
}

// ---------------------------------------------------------------- economy
// Returns what was built (or null) and the cost of the next step, so recruiting can leave that much alone.
function build(db, v, persona) {
  const fresh = village.processQueue(db, v.id);
  const levels = village.queuedLevels(db, v.id);
  const real = village.getBuildings(db, v.id);
  const queue = village.getQueue(db, v.id);
  const cap = village.storageMax(real);
  const popFree = village.popMax(real) - village.popUsed(real, queue, village.unitPop(db, v.id));
  // Emergencies come first: no room for people, or a full warehouse.
  const urgent = [];
  if (popFree < 40 && levels.farm < cfg.buildings.farm.maxLevel) urgent.push(['farm', levels.farm + 1]);
  if (RES.some((r) => fresh[r] > cap * 0.92) && levels.storage < cfg.buildings.storage.maxLevel) urgent.push(['storage', levels.storage + 1]);
  let text = null; let next = null;
  for (const [b, l] of [...urgent, ...LADDER[persona]]) {
    if (levels[b] >= l || !f.BUILDING_IDS.includes(b)) continue;
    const state = queue.length >= cfg.world.buildqueueStart || (queue.length >= 2 && !text) ? 'queueFull' : village.canBuild(db, fresh, b);
    if (!next && village.missingRequirements(levels, b).length === 0) next = [b, levels[b] + 1];
    if (state === true && !text) {
      const r = village.enqueueBuild(db, v.id, b);
      if (r.ok) { text = `${v.name}: ${b} auf Stufe ${r.level} gebaut`; next = null; queue.push({}); continue; }
    }
    if (state === 'resources' || state === 'queueFull') break; // save up for it
  }
  const reserve = next ? Object.fromEntries(RES.map((r) => [r, village.scaled(f.buildCost(next[0], r, next[1]), village.queueFactor(queue.length))])) : null;
  return { text, reserve };
}

// How full the farm may get with soldiers; the rest stays free for buildings.
const POP_SHARE = { builder: 0.5, warrior: 0.78, conqueror: 0.68 };

function military(db, v, persona, aggression, rng, reserve) {
  const out = [];
  units.processTraining(db, v.id); units.processResearch(db, v.id);
  const levels = village.getBuildings(db, v.id);
  const mix = MIX[persona];
  // Research what the smithy allows and the persona wants.
  if (levels.smith > 0 && units.getResearchQueue(db, v.id).length < 1) {
    for (const u of Object.keys(mix)) {
      if (units.needsResearch(u) && units.canResearch(db, v.id, levels, u) === true && units.enqueueResearch(db, v.id, u).ok) { out.push(`${v.name}: ${u} erforscht`); break; }
    }
  }
  const fresh = db.prepare('SELECT * FROM village WHERE id = ?').get(v.id);
  const popUse = village.popUsed(levels, [], village.unitPop(db, v.id)) / Math.max(1, village.popMax(levels));
  const budget = reserve ? { ...fresh, ...Object.fromEntries(RES.map((r) => [r, Math.max(0, fresh[r] - reserve[r])])) } : fresh;
  if (popUse > (levels.farm >= cfg.buildings.farm.maxLevel ? 0.92 : POP_SHARE[persona])) return out;
  const weights = Object.entries(mix).filter(([u]) => units.UNIT_IDS.includes(u) && units.isRecruitable(db, v.id, levels, u));
  if (!weights.length) return out;
  // One order per building at a time, in proportion to the persona's mix.
  const byBuilding = {};
  for (const [u, w] of weights) (byBuilding[cfg.units[u].recruitBuilding] ||= []).push([u, w]);
  for (const [b, list] of Object.entries(byBuilding)) {
    if (units.getTrainQueue(db, v.id, b).length >= 2) continue;
    const total = list.reduce((s, [, w]) => s + w, 0);
    let roll = rng() * total; let chosen = list[0][0];
    for (const [u, w] of list) { roll -= w; if (roll <= 0) { chosen = u; break; } }
    const max = units.maxRecruitable(db, budget, levels, chosen);
    const amount = Math.min(max, Math.max(1, Math.floor(max * (0.25 + 0.1 * aggression))), 60);
    if (amount >= 1 && units.enqueueTraining(db, v.id, { [chosen]: amount }).ok) out.push(`${v.name}: ${amount} ${chosen} in Auftrag`);
  }
  // Nobles for conquerors: coins first, then the noble itself.
  if (persona === 'conqueror' && levels.snob > 0) {
    const sum = noble.summary(db, v.user_id);
    if (sum.mintable > 0 && noble.mint(db, v.id, 1).ok) out.push(`${v.name}: Goldmünze geprägt`);
    else if ((db.prepare('SELECT coins FROM village WHERE id = ?').get(v.id).coins || 0) > 0 && units.getTrainQueue(db, v.id, 'snob').length === 0 && units.enqueueTraining(db, v.id, { snob: 1 }).ok) out.push(`${v.name}: Adelsgeschlecht in Auftrag`);
  }
  // The paladin, once the statue stands.
  if (levels.statue > 0 && cfg.world.knightActive && units.knightCount(db, v.user_id) === 0 && units.getTrainQueue(db, v.id, 'statue').length === 0 && units.enqueueTraining(db, v.id, { knight: 1 }).ok) out.push(`${v.name}: Paladin in Auftrag`);
  return out;
}

// ---------------------------------------------------------------- war
const offensiveHome = (db, vid, includeNobles) => {
  const home = units.getUnits(db, vid);
  const out = {};
  for (const u of OFFENSE) if (home[u] > 0) out[u] = home[u];
  if (home.knight > 0) out.knight = home.knight;
  if (includeNobles && home.snob > 0) out.snob = Math.min(home.snob, 4);
  return out;
};

function latestIntel(db, userId, targetId, maxAge) {
  for (const r of db.prepare("SELECT time, data FROM report WHERE user_id = ? AND type = 'attack' ORDER BY time DESC, id DESC LIMIT 60").all(userId)) {
    const d = JSON.parse(r.data);
    if (d.defender && d.defender.villageId === targetId && d.intel && now() - r.time <= maxAge) return d.intel;
  }
  return null;
}

function hostile(db, user, target, attackPlayers) {
  if (!target.user_id) return true;
  if (target.user_id === user.id) return false;
  const owner = db.prepare('SELECT * FROM user WHERE id = ?').get(target.user_id);
  if (!owner || owner.banned) return false;
  if (!attackPlayers && !owner.is_bot) return false;
  if (commands.protectedUntil(owner) > now()) return false;
  if (user.ally_id && owner.ally_id) {
    if (user.ally_id === owner.ally_id) return false;
    if (['partner', 'nap'].includes(ally.relation(db, user.ally_id, owner.ally_id))) return false;
  }
  return true;
}

function incomingSoon(db, vid, seconds) {
  return commands.listCommands(db, "type = 'attack' AND to_village = ? AND arrive_at < ?", vid, now() + seconds).length > 0;
}

function warfare(db, user, bot, st, villages, aggression, attackPlayers, rng) {
  const out = [];
  st.cool ||= {};
  const t = now();
  const range = (bot.persona === 'builder' ? 14 : 22) + aggression * 2;
  const maxOut = bot.persona === 'builder' ? 1 : 1 + Math.ceil(aggression / 2);
  for (const v of villages) {
    if (incomingSoon(db, v.id, 90)) continue;
    const busy = commands.listCommands(db, "type IN ('attack') AND from_village = ?", v.id).length;
    if (busy >= maxOut) continue;
    if (bot.persona === 'builder' && !chance(rng, 0.08 * aggression)) continue; // builders rarely fight
    const army = offensiveHome(db, v.id, bot.persona === 'conqueror');
    const strength = Object.values(combat.attackStrength(army)).reduce((a, b) => a + b, 0);
    const spies = units.getUnits(db, v.id).spy || 0;
    if (strength < 400 && !spies) continue;
    const candidates = db.prepare('SELECT v2.* FROM village v2 WHERE v2.id != ? AND v2.x BETWEEN ? AND ? AND v2.y BETWEEN ? AND ?').all(v.id, v.x - range, v.x + range, v.y - range, v.y + range)
      .filter((c) => commands.distance(v, c) <= range && !(st.cool[c.id] > t) && hostile(db, user, c, attackPlayers))
      .sort((a, b) => commands.distance(v, a) - commands.distance(v, b)).slice(0, 10);
    for (const target of candidates) {
      const intel = latestIntel(db, user.id, target.id, 900);
      const dist = commands.distance(v, target);
      if (!intel && spies >= 2 && (!st.spy || !(st.spy[target.id] > t - 300))) {
        const r = commands.send(db, { userId: user.id, fromId: v.id, toId: target.id, units: { spy: Math.min(spies, 3) } });
        if (r.ok) { (st.spy ||= {})[target.id] = t; out.push(`${v.name}: Späher zu ${target.x}|${target.y}`); break; }
        continue;
      }
      if (strength < 400) break;
      let send = { ...army };
      if (intel) {
        const wall = (intel.buildings && intel.buildings.wall) || 0;
        if (!wall) delete send.ram;
        const sim = combat.resolve({ attacker: send, defender: intel.units || {}, wallLevel: wall, luck: -0.2, attackerPoints: 0, defenderPoints: 1000 });
        if (!sim.win || sim.attackerLossRatio > 0.6) { st.cool[target.id] = t + 600; continue; }
      } else if (target.user_id || strength < 500 + 30 * dist) {
        continue; // never blind-attack a player, and do not throw a small army at an unknown barbarian
      }
      if (send.snob && !intel) delete send.snob; // nobles only go where the spies have looked
      const r = commands.send(db, { userId: user.id, fromId: v.id, toId: target.id, units: send, type: 'attack' });
      if (r.ok) {
        st.cool[target.id] = t + 240;
        if (user.ally_id && !target.user_id && !reservations.forVillage(db, target.id)) reservations.toggle(db, user, target.id);
        out.push(`${v.name}: Angriff auf ${target.x}|${target.y}${send.snob ? ' mit Adelsgeschlecht' : ''}`);
        break;
      }
    }
  }
  return out;
}

// Tribe mates under attack get the defenders that can still arrive in time.
function support(db, user, villages) {
  if (!user.ally_id) return [];
  const out = [];
  const threatened = db.prepare("SELECT c.to_village, c.arrive_at, v.x, v.y FROM command c JOIN village v ON v.id = c.to_village JOIN user u ON u.id = v.user_id WHERE c.type = 'attack' AND u.ally_id = ? AND u.id != ? AND c.arrive_at > ?").all(user.ally_id, user.id, now());
  for (const th of threatened) {
    if (stationedAlready(db, th.to_village, villages)) continue;
    for (const v of villages) {
      const home = units.getUnits(db, v.id);
      const army = {};
      for (const u of DEFENSE) if (home[u] > 20) army[u] = Math.floor(home[u] * 0.6);
      if (!Object.keys(army).length) continue;
      if (commands.travelSeconds(army, v, th) + 3 >= th.arrive_at - now()) continue;
      const r = commands.send(db, { userId: user.id, fromId: v.id, toId: th.to_village, units: army, type: 'support' });
      if (r.ok) { out.push(`${v.name}: Unterstützung für ${th.x}|${th.y}`); break; }
    }
  }
  return out;
}

const stationedAlready = (db, hostId, villages) => villages.some((v) => db.prepare('SELECT 1 FROM stationed WHERE owner_village = ? AND host_village = ?').get(v.id, hostId)
  || db.prepare("SELECT 1 FROM command WHERE type = 'support' AND from_village = ? AND to_village = ?").get(v.id, hostId));

// ---------------------------------------------------------------- trade
function trade(db, user, villages, rng) {
  const out = [];
  for (const v of villages) {
    const lv = village.getBuildings(db, v.id);
    if (lv.market < 1) continue;
    const fresh = village.processQueue(db, v.id);
    const cap = village.storageMax(lv);
    const rich = RES.filter((r) => fresh[r] > cap * 0.7);
    const poor = RES.filter((r) => fresh[r] < cap * 0.25);
    if (rich.length && poor.length && market.ownOffers(db, v.id).length < 2 && chance(rng, 0.5)) {
      const give = rich[0]; const want = poor[0]; const amount = Math.floor(cap * 0.15);
      if (market.createOffer(db, { userId: user.id, villageId: v.id, sellRes: give, sellAmount: amount, buyRes: want, buyAmount: Math.floor(amount * 1.1), maxDistance: 40 }).ok) out.push(`${v.name}: Angebot ${amount} ${give} gegen ${want}`);
    }
    // Take an offer that gives what is missing for what is plentiful.
    if (poor.length && rich.length) {
      const offer = market.openOffers(db, v.id).find((o) => poor.includes(o.sell_res) && rich.includes(o.buy_res) && o.buy_amount <= fresh[o.buy_res] * 0.5 && o.user_id !== user.id);
      if (offer && market.acceptOffer(db, { userId: user.id, villageId: v.id, offerId: offer.id, count: 1 }).ok) out.push(`${v.name}: Angebot angenommen`);
    }
    // Between own villages: send the surplus to the village that needs it.
    if (villages.length > 1 && rich.length) {
      const other = villages.filter((o) => o.id !== v.id).map((o) => ({ o, f: village.processQueue(db, o.id), cap: village.storageMax(village.getBuildings(db, o.id)) }))
        .find((x) => RES.some((r) => x.f[r] < x.cap * 0.2));
      if (other) {
        const r = RES.find((rr) => other.f[rr] < other.cap * 0.2 && fresh[rr] > cap * 0.6);
        if (r && commands.sendResources(db, { userId: user.id, fromId: v.id, toId: other.o.id, res: { [r]: Math.floor(cap * 0.2) } }).ok) out.push(`${v.name}: ${r} an ${other.o.name} geschickt`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- society
function tribeName(db, rng) {
  for (let i = 0; i < 50; i++) {
    const name = `${pick(rng, TRIBES)} ${pick(rng, TRIBE_SUFFIX)}`;
    const tag = `${pick(rng, TRIBES).slice(0, 3).toUpperCase()}${Math.floor(rng() * 90 + 10)}`.slice(0, 5);
    if (!db.prepare('SELECT 1 FROM ally WHERE name = ? OR tag = ?').get(name, tag)) return { name, tag };
  }
  return null;
}

function society(db, user, bot, rng, aggression) {
  const out = [];
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(user.id);

  // Every message from a person gets one polite answer.
  const mail = db.prepare('SELECT m.*, f.is_bot AS from_bot FROM message m JOIN user f ON f.id = m.from_id WHERE m.to_id = ? AND m.is_read = 0 AND m.deleted_in = 0 ORDER BY m.time LIMIT 1').get(u.id);
  if (mail) {
    db.prepare('UPDATE message SET is_read = 1 WHERE id = ?').run(mail.id);
    if (!mail.from_bot && !/^Re:/i.test(mail.subject) && mail.subject !== 'Stammeseinladung' && mail.subject !== 'Bewerbung') {
      db.prepare('INSERT INTO message (from_id, to_id, subject, body, time) VALUES (?,?,?,?,?)').run(u.id, mail.from_id, `Re: ${mail.subject}`.slice(0, 120), pick(rng, REPLIES), Math.floor(now()));
      out.push('Nachricht beantwortet');
    }
  }
  // Invitations: accept if not yet in a tribe.
  if (!u.ally_id) {
    const invite = db.prepare('SELECT ally_id FROM ally_invite WHERE user_id = ? LIMIT 1').get(u.id);
    if (invite && ally.accept(db, u, invite.ally_id).ok) { out.push('Einladung angenommen'); return out; }
  }
  // Applications and treaty offers are answered right away; everything else happens now and then.
  if (u.ally_id && ally.can(db, u, 'invite')) {
    for (const a of ally.applicationsOf(db, u.ally_id).slice(0, 2)) if (ally.answerApplication(db, u, a.user_id, true).ok) out.push(`${a.name} aufgenommen`);
  }
  if (u.ally_id && ally.can(db, u, 'diplomacy')) {
    for (const p of ally.incomingProposals(db, u.ally_id)) if (ally.answerProposal(db, u, p.ally_id, true).ok) out.push('Vertrag angenommen');
  }
  if (!chance(rng, 0.25)) return out;
  if (!u.ally_id) {
    const open = db.prepare('SELECT a.id FROM ally a WHERE (SELECT COUNT(*) FROM user m WHERE m.ally_id = a.id) < ?').all(cfg.world.tribeMemberLimit);
    if (open.length && chance(rng, 0.7)) {
      const target = pick(rng, open);
      if (ally.apply(db, u, target.id, 'Ich möchte euch verstärken.').ok) out.push('Bewerbung bei einem Stamm');
    } else if (chance(rng, 0.4)) {
      const names = tribeName(db, rng);
      if (names && ally.found(db, u, names.name, names.tag).ok) out.push(`Stamm ${names.name} gegründet`);
    }
    return out;
  }
  // Tribe life: talk in the forum and keep up diplomacy.
  if (chance(rng, 0.25)) {
    const threads = ally.threads(db, u.ally_id, u.id);
    if (threads.length && chance(rng, 0.6)) { if (ally.reply(db, u, pick(rng, threads).id, pick(rng, ['Bin dabei.', 'Verstanden, ich unterstütze.', 'Gute Idee!', 'Ich halte meine Truppen bereit.'])).ok) out.push('Forum: geantwortet'); }
    else { const [title, body] = pick(rng, THREADS); if (ally.newThread(db, u, title, body).ok) out.push(`Forum: Thema „${title}“`); }
  }
  if (ally.can(db, u, 'diplomacy')) {
    if (chance(rng, 0.05 + 0.02 * aggression)) {
      const others = db.prepare('SELECT id FROM ally WHERE id != ? AND id NOT IN (SELECT other_id FROM ally_contract WHERE ally_id = ?)').all(u.ally_id, u.ally_id);
      if (others.length) {
        const type = bot.persona === 'builder' ? pick(rng, ['nap', 'partner']) : pick(rng, ['nap', 'enemy', 'enemy']);
        if (ally.propose(db, u, pick(rng, others).id, type).ok) out.push(`Diplomatie: ${type}`);
      }
    }
  }
  return out;
}

function perks(db, user, villages) {
  const out = [];
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(user.id);
  const first = villages[0];
  for (const q of quests.QUESTS) if (first && quests.claim(db, u, first.id, q.id).ok) out.push(`Aufgabe „${q.title}“ abgeschlossen`);
  const found = knight.found(db, u.id);
  if (found.length && !knight.equipped(db, u.id)) { knight.equip(db, u.id, found[0]); out.push('Paladin ausgerüstet'); }
  for (const r of relics.mine(db, u.id)) {
    if (r.assigned_village) continue;
    const best = villages.filter((v) => relics.distance({ x: r.site_x, y: r.site_y }, v) <= relics.RADIUS).sort((a, b) => relics.distance({ x: r.site_x, y: r.site_y }, a) - relics.distance({ x: r.site_x, y: r.site_y }, b))[0];
    if (best && relics.assign(db, u.id, r.id, best.id).ok) out.push(`Reliquie „${r.name}“ zugewiesen`);
  }
  return out;
}

// ---------------------------------------------------------------- one turn of one bot
function act(db, bot, rng = Math.random) {
  const user = db.prepare('SELECT * FROM user WHERE id = ?').get(bot.user_id);
  if (!user) return [];
  const s = settings.load(db);
  const aggression = Math.min(5, Math.max(1, Number(s.botAggression) || 3));
  const attackPlayers = s.botAttackPlayers === '1';
  const st = stateOf(bot);
  commands.processDue(db);
  let villages = db.prepare('SELECT * FROM village WHERE user_id = ? ORDER BY id').all(user.id);
  if (!villages.length) { // lost everything: start over like a human who gets a new village
    village.createVillage(db, { userId: user.id, name: `${user.name.replace(' [Bot]', '')}s Dorf`, ...world.pickSpot(db, {}) });
    villages = db.prepare('SELECT * FROM village WHERE user_id = ? ORDER BY id').all(user.id);
  }
  const did = [];
  for (const v of villages) {
    const built = build(db, v, bot.persona); if (built.text) did.push(built.text);
    did.push(...military(db, v, bot.persona, aggression, rng, built.reserve));
  }
  did.push(...warfare(db, user, bot, st, villages, aggression, attackPlayers, rng));
  did.push(...support(db, user, villages));
  did.push(...trade(db, user, villages, rng));
  did.push(...society(db, user, bot, rng, aggression));
  did.push(...perks(db, user, villages));
  db.prepare('UPDATE bot SET state = ? WHERE user_id = ?').run(JSON.stringify(st), user.id);
  return did;
}

// Called from the server's timer: lets the bots that are due take a turn.
function tick(db, t = now(), rng = Math.random, limit = 8) {
  const s = settings.load(db);
  if (s.botActive !== '1') return 0;
  const interval = Math.max(2, Number(s.botInterval) || 30);
  const due = db.prepare('SELECT * FROM bot WHERE next_at <= ? ORDER BY next_at LIMIT ?').all(t, limit);
  for (const bot of due) {
    try {
      const did = act(db, bot, rng);
      for (const line of did) log(db, bot.user_id, line);
    } catch (e) {
      console.error(`bot ${bot.user_id} failed:`, e);
      log(db, bot.user_id, `Fehler: ${e.message}`);
    }
    db.prepare('UPDATE bot SET next_at = ? WHERE user_id = ?').run(t + interval * (0.6 + rng() * 0.8), bot.user_id);
  }
  return due.length;
}

const list = (db) => {
  const points = new Map(ranking.players(db).map((p) => [p.id, p]));
  return db.prepare('SELECT b.user_id, b.persona, u.name, u.ally_id, a.tag, (SELECT COUNT(*) FROM village v WHERE v.user_id = u.id) AS villages FROM bot b JOIN user u ON u.id = b.user_id LEFT JOIN ally a ON a.id = u.ally_id ORDER BY u.name').all()
    .map((b) => ({ ...b, points: (points.get(b.user_id) || {}).points || 0, rank: (points.get(b.user_id) || {}).rank || 0 }));
};

const recentLog = (db, limit = 60) => db.prepare('SELECT l.time, l.text, u.name FROM bot_log l LEFT JOIN user u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?').all(limit);

module.exports = { PERSONAS, create, remove, sync, act, tick, list, recentLog, build, military, warfare, trade, society };

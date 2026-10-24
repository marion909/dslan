'use strict';
const zlib = require('node:zlib');
const world = require('./world');

const SCALE = 5; // pixels per tile, matches FreeMap([5, 5], 50, ...) in the map script
const SECTOR = 50;

const GRASS = [92, 134, 44]; const FOREST = [50, 92, 32]; const LAKE = [52, 100, 170];
const darker = (c) => c.map((n) => Math.round(n * 0.86));
const COLORS = { self: [255, 255, 255], own: [240, 200, 0], other: [130, 60, 10], barbarian: [150, 150, 150] };

function terrainColor(x, y) {
  const idx = world.tileImage(x, y);
  if (idx === 48) return LAKE;
  if (idx >= 32) return FOREST;
  return GRASS;
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Terrain plus one block per village, coloured by who owns it.
function render(db, sx, sy, { userId, villageId }) {
  const size = SECTOR * SCALE;
  const buf = Buffer.alloc(size * size * 3);
  const fill = (px, py, w, h, c) => {
    for (let y = py; y < py + h; y++) for (let x = px; x < px + w; x++) { const o = (y * size + x) * 3; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; }
  };
  // One square per tile with a thin grid; villages are small squares in the middle.
  for (let tx = 0; tx < SECTOR; tx++) {
    for (let ty = 0; ty < SECTOR; ty++) {
      const c = terrainColor(sx + tx, sy + ty);
      fill(tx * SCALE, ty * SCALE, SCALE, SCALE, darker(c));
      fill(tx * SCALE, ty * SCALE, SCALE - 1, SCALE - 1, c);
    }
  }
  const rows = db.prepare('SELECT id, x, y, user_id FROM village WHERE x >= ? AND x < ? AND y >= ? AND y < ?').all(sx, sx + SECTOR, sy, sy + SECTOR);
  for (const r of rows) {
    const c = r.id === villageId ? COLORS.self : !r.user_id ? COLORS.barbarian : r.user_id === userId ? COLORS.own : COLORS.other;
    fill((r.x - sx) * SCALE, (r.y - sy) * SCALE, SCALE - 1, SCALE - 1, c);
  }
  // Continent borders every 100 tiles.
  for (let tx = 0; tx < SECTOR; tx++) if ((sx + tx) % 100 === 0) fill(tx * SCALE, 0, 2, size, [0, 0, 0]);
  for (let ty = 0; ty < SECTOR; ty++) if ((sy + ty) % 100 === 0) fill(0, ty * SCALE, size, 2, [0, 0, 0]);
  return png(size, size, buf);
}

// The whole populated area as one picture, 1 pixel per tile, centred on the middle of the world
// (the world-map dialog maps clicks back with x = px + 500 - width / 2).
function renderWorld(db, { userId, allyId, relations = {}, show = {} }) {
  const centre = world.CENTER;
  const rows = db.prepare('SELECT v.id, v.x, v.y, v.user_id, u.ally_id FROM village v LEFT JOIN user u ON u.id = v.user_id').all();
  let reach = 60;
  for (const r of rows) reach = Math.max(reach, Math.abs(r.x - centre) + 4, Math.abs(r.y - centre) + 4);
  const size = Math.min(2 * centre, 2 * reach);
  const buf = Buffer.alloc(size * size * 3);
  const put = (px, py, c) => { if (px < 0 || py < 0 || px >= size || py >= size) return; const o = (py * size + px) * 3; buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; };
  const ox = centre - size / 2;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) put(px, py, ((px + ox) % 100 === 0 || (py + ox) % 100 === 0) ? [0, 0, 0] : terrainColor(px + ox, py + ox));
  const colour = { barbarian: COLORS.barbarian, own: COLORS.own, other: COLORS.other, ally: [0, 0, 244], partner: [0, 160, 244], nap: [128, 0, 128], enemy: [244, 0, 0] };
  for (const r of rows) {
    let kind;
    if (!r.user_id) kind = 'barbarian';
    else if (r.user_id === userId) kind = 'own';
    else if (allyId && r.ally_id === allyId) kind = 'ally';
    else kind = (r.ally_id && relations[r.ally_id]) || 'other';
    if (kind !== 'own' && kind !== 'other' && show[kind] === false) continue;
    if (kind === 'other' && show.other === false) continue;
    put(r.x - ox, r.y - ox, colour[kind]);
  }
  return png(size, size, buf);
}

module.exports = { render, renderWorld };

'use strict';

// Run with:  node --test
// Exercises packRows, the pure justified-packing step, outside Obsidian.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// main.js does require('obsidian') at load time; the classes it extends are
// all that must exist for the module to evaluate.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') return { Plugin: class {}, PluginSettingTab: class {} };
  return origLoad.call(this, request, ...rest);
};
const { packRows } = require('../main.js');
Module._load = origLoad;

const W = 1000, GAP = 7, H = 220;

/* Width a row would take at its height: items' widths plus gaps. */
const rowWidth = (ars, { start, end, height }) =>
  ars.slice(start, end).reduce((sum, ar) => sum + ar * height, 0) + (end - start - 1) * GAP;

test('empty input gives no rows', () => {
  assert.deepEqual(packRows([], W, GAP, H), []);
});

test('rows cover every item once, in order', () => {
  const ars = [1.5, 0.67, 1.78, 1, 1.33, 0.75, 2.2, 1.5, 1.5, 0.8, 1.2];
  const rows = packRows(ars, W, GAP, H);
  let next = 0;
  for (const r of rows) {
    assert.equal(r.start, next);
    assert.ok(r.end > r.start, 'a row holds at least one item');
    next = r.end;
  }
  assert.equal(next, ars.length);
});

test('full rows fill the width exactly', () => {
  const ars = [1.5, 0.67, 1.78, 1, 1.33, 0.75, 2.2, 1.5, 1.5, 0.8, 1.2];
  const rows = packRows(ars, W, GAP, H);
  const full = rows.filter((r) => r.full);
  assert.ok(full.length >= 2, 'enough items for several full rows');
  for (const r of full) {
    assert.ok(Math.abs(rowWidth(ars, r) - W) < 1e-6, `row ${r.start}-${r.end} fills the width`);
  }
});

test('leftover items form a last row at the target height', () => {
  const ars = [1.5, 1];
  const rows = packRows(ars, W, GAP, H);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { start: 0, end: 2, height: H, full: false });
  assert.ok(rowWidth(ars, rows[0]) < W);
});

test('row heights stay close to the target', () => {
  const ars = Array.from({ length: 40 }, (_, i) => [1.5, 0.67, 1.78, 1][i % 4]);
  for (const r of packRows(ars, W, GAP, H).filter((r) => r.full)) {
    assert.ok(r.height > 0.7 * H && r.height < 1.4 * H, `height ${r.height.toFixed(1)} is near ${H}`);
  }
});

test('an overflowing item is squeezed in when that is closer to the target', () => {
  // 2.4 + 2.4 fits at 200px (960 < 1000); adding 0.3 overflows (1020).
  // With it: 1000/5.1 = 196.1 (0.98×). Without: 1000/4.8 = 208.3 (1.04×).
  // 0.98× is closer, so the third item joins the row.
  const rows = packRows([2.4, 2.4, 0.3], 1000, 0, 200);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].start, rows[0].end], [0, 3]);
  assert.ok(Math.abs(rows[0].height - 1000 / 5.1) < 1e-9);
});

test('an overflowing item starts the next row when that is closer to the target', () => {
  // With 1.5: 1000/6.3 = 158.7 (0.79×). Without: 208.3 (1.04×) wins.
  const rows = packRows([2.4, 2.4, 1.5], 1000, 0, 200);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].start, rows[0].end, rows[0].full], [0, 2, true]);
  assert.ok(Math.abs(rows[0].height - 1000 / 4.8) < 1e-9);
  assert.deepEqual([rows[1].start, rows[1].end, rows[1].full, rows[1].height], [2, 3, false, 200]);
});

test('a panorama that starts a row gets the row to itself, scaled to fit', () => {
  // 1.5 × 3 closes a row at ≈219px (0.996×); the panorama then starts fresh.
  const rows = packRows([1.5, 1.5, 1.5, 10, 1], W, GAP, H);
  const pano = rows.find((r) => r.start === 3);
  assert.deepEqual([pano.end, pano.full], [4, true]);
  assert.ok(Math.abs(pano.height - W / 10) < 1e-9);
});

test('a leading panorama is also its own row', () => {
  const rows = packRows([10, 1], W, GAP, H);
  assert.deepEqual([rows[0].start, rows[0].end, rows[0].full], [0, 1, true]);
  assert.ok(Math.abs(rows[0].height - W / 10) < 1e-9);
});

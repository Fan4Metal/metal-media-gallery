'use strict';

// Run with:  node --test
// Exercises moveEmbed, the source rewrite behind Ctrl+drag reordering.

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
const { moveEmbed } = require('../main.js');
Module._load = origLoad;

const H = '> [!gallery]';

test('one embed per line: the line moves', () => {
  const lines = [H, '> ![[a]]', '> ![[b]]', '> ![[c]]'];
  assert.deepEqual(moveEmbed(lines, 0, 2, true), [H, '> ![[b]]', '> ![[c]]', '> ![[a]]']);
  assert.deepEqual(moveEmbed(lines, 2, 0, false), [H, '> ![[c]]', '> ![[a]]', '> ![[b]]']);
  assert.deepEqual(moveEmbed(lines, 0, 1, true), [H, '> ![[b]]', '> ![[a]]', '> ![[c]]']);
});

test('dropping next to its own position changes nothing', () => {
  const lines = [H, '> ![[a]]', '> ![[b]]', '> ![[c]]'];
  assert.equal(moveEmbed(lines, 1, 1, false), null);
  assert.equal(moveEmbed(lines, 1, 0, true), null);
  assert.equal(moveEmbed(lines, 1, 2, false), null);
  assert.equal(moveEmbed(lines, 1, 1, true), null);
});

test('embeds sharing a line move inline', () => {
  const lines = [H, '> ![[a]] ![[b]] ![[c]]'];
  assert.deepEqual(moveEmbed(lines, 0, 2, true), [H, '> ![[b]] ![[c]] ![[a]]']);
  assert.deepEqual(moveEmbed(lines, 2, 0, false), [H, '> ![[c]] ![[a]] ![[b]]']);
  assert.deepEqual(moveEmbed(lines, 1, 0, false), [H, '> ![[b]] ![[a]] ![[c]]']);
});

test('a lone embed joins a shared line, and its own line goes', () => {
  const lines = [H, '> ![[a]]', '> ![[b]] ![[c]]'];
  assert.deepEqual(moveEmbed(lines, 0, 1, true), [H, '> ![[b]] ![[a]] ![[c]]']);
});

test('an embed leaving a shared line gets a line of its own next to a lone one', () => {
  const lines = [H, '> ![[a]] ![[b]]', '> ![[c]]'];
  assert.deepEqual(moveEmbed(lines, 0, 2, true), [H, '> ![[b]]', '> ![[c]]', '> ![[a]]']);
});

test('moves across a *** separator and keeps it in place', () => {
  const lines = [H, '> ![[a]]', '> ***', '> ![[b]]'];
  assert.deepEqual(moveEmbed(lines, 0, 1, true), [H, '> ***', '> ![[b]]', '> ![[a]]']);
});

test('markdown images and duplicate links are told apart by position', () => {
  const lines = [H, '> ![x](u.png)', '> ![[a]]', '> ![[a]]'];
  assert.deepEqual(moveEmbed(lines, 0, 2, true), [H, '> ![[a]]', '> ![[a]]', '> ![x](u.png)']);
  assert.deepEqual(moveEmbed(lines, 2, 1, false), [H, '> ![x](u.png)', '> ![[a]]', '> ![[a]]']);
});

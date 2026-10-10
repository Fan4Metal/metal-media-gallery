'use strict';

// Run with:  node --test
// Exercises moveEmbed and groupEmbeds, the source rewrites behind Ctrl+drag
// reordering and the "One row" action on a selection.

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
const { moveEmbed, groupEmbeds } = require('../main.js');
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

/* groupEmbeds: the "One row" action on selected images. */

const S = '> ***';
const G = [H, '> ![[a]]', '> ![[b]]', '> ![[c]]', '> ![[d]]'];

test('a run of embeds gets separators around it', () => {
  assert.deepEqual(groupEmbeds(G, [1, 2]), [H, '> ![[a]]', S, '> ![[b]]', '> ![[c]]', S, '> ![[d]]']);
});

test('no separator right under the header', () => {
  assert.deepEqual(groupEmbeds(G, [0, 1]), [H, '> ![[a]]', '> ![[b]]', S, '> ![[c]]', '> ![[d]]']);
});

test('the last embeds are closed too, so they fill the width', () => {
  assert.deepEqual(groupEmbeds(G, [3]), [H, '> ![[a]]', '> ![[b]]', '> ![[c]]', S, '> ![[d]]', S]);
});

test('scattered embeds are gathered where the first one is', () => {
  assert.deepEqual(groupEmbeds(G, [1, 3]), [H, '> ![[a]]', S, '> ![[b]]', '> ![[d]]', S, '> ![[c]]']);
});

test('existing separators are not doubled', () => {
  const lines = [H, '> ![[a]]', S, '> ![[b]]', '> ![[c]]', S, '> ![[d]]'];
  assert.deepEqual(groupEmbeds(lines, [1, 2]), lines);
});

test('embeds sharing a line are split out of it', () => {
  assert.deepEqual(
    groupEmbeds([H, '> ![[a]] ![[b]] ![[c]] ![[d]]'], [1, 3]),
    [H, '> ![[a]]', S, '> ![[b]]', '> ![[d]]', S, '> ![[c]]']
  );
});

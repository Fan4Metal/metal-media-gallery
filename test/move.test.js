'use strict';

// Run with:  node --test
// Exercises moveEmbed, groupEmbeds, ungroupEmbeds and removeEmbeds, the
// source rewrites behind Ctrl+drag reordering and the "One row" / "Ungroup" /
// "Remove" actions on a selection.

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
const { moveEmbed, groupEmbeds, ungroupEmbeds, removeEmbeds } = require('../main.js');
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

/* ungroupEmbeds: the "Ungroup" action on selected images. */

test('ungroup removes the separators around the picked embeds group', () => {
  const lines = [H, '> ![[a]]', S, '> ![[b]]', '> ![[c]]', S, '> ![[d]]'];
  assert.deepEqual(ungroupEmbeds(lines, [1]), [H, '> ![[a]]', '> ![[b]]', '> ![[c]]', '> ![[d]]']);
});

test('ungroup in the first group removes only the separator below it', () => {
  const lines = [H, '> ![[a]]', S, '> ![[b]]', S, '> ![[c]]'];
  assert.deepEqual(ungroupEmbeds(lines, [0]), [H, '> ![[a]]', '> ![[b]]', S, '> ![[c]]']);
});

test('ungroup with no separators changes nothing', () => {
  assert.equal(ungroupEmbeds(G, [1, 2]), null);
});

/* removeEmbeds: the "Remove" action on selected images. */

test('a lone embed takes its line along', () => {
  assert.deepEqual(removeEmbeds(G, [1]), [H, '> ![[a]]', '> ![[c]]', '> ![[d]]']);
  assert.deepEqual(removeEmbeds(G, [0, 3]), [H, '> ![[b]]', '> ![[c]]']);
});

test('an embed sharing a line leaves the rest of it', () => {
  assert.deepEqual(removeEmbeds([H, '> ![[a]] ![[b]] ![[c]]'], [1]), [H, '> ![[a]] ![[c]]']);
  assert.deepEqual(removeEmbeds([H, '> ![[a]] ![[b]] ![[c]]'], [0, 2]), [H, '> ![[b]]']);
  assert.deepEqual(removeEmbeds([H, '> ![[a]] ![[b]] ![[c]]'], [0, 1, 2]), [H]);
});

test('other text on the line stays', () => {
  assert.deepEqual(removeEmbeds([H, '> ![[a]] caption', '> ![[b]]'], [0]), [H, '> caption', '> ![[b]]']);
});

test('separators doubled by the removal, or left under the header, go', () => {
  const lines = [H, '> ![[a]]', S, '> ![[b]]', S, '> ![[c]]'];
  assert.deepEqual(removeEmbeds(lines, [1]), [H, '> ![[a]]', S, '> ![[c]]']);
  assert.deepEqual(removeEmbeds(lines, [0]), [H, '> ![[b]]', S, '> ![[c]]']);
  assert.deepEqual(removeEmbeds(lines, [0, 1]), [H, '> ![[c]]']);
});

test('a group that closed the gallery leaves the one before it closed', () => {
  assert.deepEqual(removeEmbeds([H, '> ![[a]]', S, '> ![[b]]', S], [1]), [H, '> ![[a]]', S]);
});

test('markdown images and empty quote lines already there are kept apart', () => {
  const lines = [H, '>', '> ![a](a.png) ![[b]]', '>'];
  assert.deepEqual(removeEmbeds(lines, [1]), [H, '>', '> ![a](a.png)', '>']);
  assert.deepEqual(removeEmbeds(lines, [0, 1]), [H, '>', '>']);
});

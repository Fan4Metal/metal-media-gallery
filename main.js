'use strict';

/*
 * Metal Media Gallery — Obsidian plugin
 * -------------------------------------------------------------------------
 * Turns callouts into image galleries in reading view:
 *
 *     > [!gallery]           justified rows (proportional widths, no crop)
 *     > [!gallery-masonry]   Pinterest-style columns (pure CSS)
 *
 * The justified layout is computed in JS: each row is scaled so the images'
 * widths — kept proportional to their aspect ratios — fill the row exactly.
 * Nothing is stretched, so nothing is cropped, and rows still line up.
 */

const obsidian = require('obsidian');

/* Per-element state from the last layout: the aspect ratio it assumed and the
   size strings it wrote. Weak so discarded galleries take their entries along. */
const usedAr = new WeakMap();
const written = new WeakMap();

/* Measured aspect ratio (w/h) of an img/video, or 0 while it is still unknown. */
function measureAr(el) {
  const w = el.naturalWidth || el.videoWidth || 0;
  const h = el.naturalHeight || el.videoHeight || 0;
  return h > 0 ? w / h : 0;
}

/* Markdown lines, for the editor commands: any blockquote line, an empty
   one, the first line of a gallery callout, and a *** row separator. */
const QUOTE = /^\s*>/;
const EMPTY_QUOTE = /^\s*>\s*$/;
const GALLERY_HEADER = /^\s*>\s*\[!gallery(-masonry)?\]/i;
const ROW_SEPARATOR = /^\s*>\s*\*\s*\*\s*\*[\s*]*$/;

/* A line moved into a callout; blank lines become a bare ">" so the
   blockquote stays one block. */
function quoteLine(line) {
  return line.trim().length ? '> ' + line : '>';
}

/* Embeds (![[…]] and ![…](…)) in the given lines, in order, as
   { line, start, end, text }. */
function findEmbeds(lines) {
  const embeds = [];
  lines.forEach((text, line) => {
    for (const m of text.matchAll(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g)) {
      embeds.push({ line, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  });
  return embeds;
}

/* Move embed number `from` to just before (or `after`) embed number `to`,
   in the lines of a gallery callout. An embed alone on its line takes the
   line along; next to an embed that shares its line, it goes inline,
   separated by a space. Returns the new lines, or null if the embed is
   already there. */
function moveEmbed(lines, from, to, after) {
  const slot = after ? to + 1 : to; // insertion point in the original order
  if (slot === from || slot === from + 1) return null;

  const out = lines.slice();
  const src = findEmbeds(out)[from];
  const left = cutSpan(out[src.line], src.start, src.end);
  if (EMPTY_QUOTE.test(left)) out.splice(src.line, 1);
  else out[src.line] = left;

  const dst = findEmbeds(out)[to > from ? to - 1 : to];
  const line = out[dst.line];
  if (EMPTY_QUOTE.test(line.slice(0, dst.start) + line.slice(dst.end))) {
    out.splice(after ? dst.line + 1 : dst.line, 0, line.slice(0, dst.start) + src.text);
  } else if (after) {
    out[dst.line] = line.slice(0, dst.end) + ' ' + src.text + line.slice(dst.end);
  } else {
    out[dst.line] = line.slice(0, dst.start) + src.text + ' ' + line.slice(dst.start);
  }
  return out;
}

/* Cut [start, end) out of a gallery line, closing up the space around it. */
function cutSpan(line, start, end) {
  const head = line.slice(0, start);
  const tail = line.slice(end);
  return head.replace(/\s+$/, '') + (tail.trim() ? ' ' + tail.replace(/^\s+/, '') : '');
}

/* Gather the `picked` embeds (indices into findEmbeds(lines), ascending)
   where the first of them is, one per line between *** separators, so they
   form a group of their own: a short one is a single full-width row.
   Embeds left behind keep their order; a separator doubled by the move, or
   right under the header, is dropped. Returns the new lines. */
function groupEmbeds(lines, picked) {
  const embeds = findEmbeds(lines);
  const pick = new Set(picked);
  const first = embeds[picked[0]];
  const group = ['> ***', ...picked.map((i) => '> ' + embeds[i].text), '> ***'];

  const out = [];
  lines.forEach((line, n) => {
    // Picked embeds on this line, right to left so earlier offsets hold.
    const cuts = embeds.filter((e, i) => e.line === n && pick.has(i) && e !== first).reverse();
    if (n !== first.line) {
      if (!cuts.length) return void out.push(line);
      for (const e of cuts) line = cutSpan(line, e.start, e.end);
      if (!EMPTY_QUOTE.test(line)) out.push(line);
      return;
    }
    // The first picked embed's line splits around the group.
    const prefix = (line.match(/^\s*>\s?/) || ['> '])[0];
    let rest = line.slice(first.end);
    for (const e of cuts) rest = cutSpan(rest, e.start - first.end, e.end - first.end);
    const before = line.slice(0, first.start).replace(/\s+$/, '');
    if (!EMPTY_QUOTE.test(before)) out.push(before);
    out.push(...group);
    if (rest.trim()) out.push(prefix + rest.trim());
  });

  return dropExtraSeparators(out);
}

/* Drop a *** separator that follows another one or the header: an empty
   group between them would render as nothing. */
function dropExtraSeparators(lines) {
  return lines.filter((line, n) => !ROW_SEPARATOR.test(line) ||
    !(ROW_SEPARATOR.test(lines[n - 1] || '') || GALLERY_HEADER.test(lines[n - 1] || '')));
}

/* Remove the `picked` embeds (indices into findEmbeds(lines)) from the
   gallery's lines; the files they embed are not touched. A line left with
   nothing but its ">" goes too, and so do the *** separators that end up
   doubled or right under the header. Returns the new lines. */
function removeEmbeds(lines, picked) {
  const embeds = findEmbeds(lines);
  const pick = new Set(picked);
  const out = [];
  lines.forEach((line, n) => {
    // Right to left so earlier offsets hold.
    const cuts = embeds.filter((e, i) => e.line === n && pick.has(i)).reverse();
    for (const e of cuts) line = cutSpan(line, e.start, e.end);
    if (!cuts.length || !EMPTY_QUOTE.test(line)) out.push(line);
  });
  return dropExtraSeparators(out);
}

/* Remove the *** separators that bound the groups the `picked` embeds
   (indices into findEmbeds(lines)) are in — the nearest one above and
   below each — so those images go back to the automatic flow. Returns the
   new lines, or null if there is no such separator. */
function ungroupEmbeds(lines, picked) {
  const embeds = findEmbeds(lines);
  const drop = new Set();
  for (const i of picked) {
    const at = embeds[i].line;
    for (let n = at - 1; n >= 0; n--) {
      if (ROW_SEPARATOR.test(lines[n])) {
        drop.add(n);
        break;
      }
    }
    for (let n = at + 1; n < lines.length; n++) {
      if (ROW_SEPARATOR.test(lines[n])) {
        drop.add(n);
        break;
      }
    }
  }
  return drop.size ? lines.filter((line, n) => !drop.has(n)) : null;
}

/* The nearest ancestor of el that scrolls vertically (the note's view). */
function scrollParent(el) {
  const win = el.ownerDocument.defaultView || window;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = win.getComputedStyle(p).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/* A gallery's rendered embeds, one per ![[…]] / ![…](…) in its source: the
   outermost .internal-embed spans (a missing file, an audio clip or an
   embedded note still has one, with or without media inside), plus media
   not inside one (external images). */
function galleryUnits(content) {
  return Array.from(content.querySelectorAll('.internal-embed, img, video')).filter(
    (el) => !(el.parentElement && el.parentElement.closest('.internal-embed'))
  );
}

/* The rendered embed an image or video belongs to (see galleryUnits). */
function embedUnit(el) {
  return el.closest('.internal-embed') || el;
}

/* Decode a gallery's images off the main thread: a row of camera-sized
   photos scrolling into view otherwise stalls the frame while each one is
   decoded. */
function decodeAsync(content) {
  content.querySelectorAll('img:not([decoding])').forEach((img) => (img.decoding = 'async'));
}

const DEFAULT_SETTINGS = {
  rowHeight: 220,   // [!gallery] target row height (px)
  maxRowHeight: 0,  // [!gallery] height cap for full rows, e.g. a group closed by *** (px; 0 = none)
  columns: 3,       // [!gallery-masonry] column count (maximum)
  columnWidth: 180, // [!gallery-masonry] minimum column width (px); narrow panes drop columns
  gap: 7,           // gap between items (px)
  radius: 6,        // corner radius (px)
  width: 140,       // gallery width relative to text column (%)
  showRibbon: true, // show the wrap button in the left ribbon
  showEditorMenu: true, // show the gallery actions in the editor's right-click menu
};

class MediaGalleryPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Sliders call saveSettings on every tick; write data.json once they settle.
    // The pending flag lets onunload flush a write without Debouncer.run(),
    // which only exists since Obsidian 1.4.4.
    this.settingsDirty = false;
    this.persistSettings = obsidian.debounce(() => this.writeSettings(), 500, true);
    // Aspect ratio by image URL. A note re-rendered or re-opened lays out
    // correctly on the first pass instead of jumping once the images load.
    this.arCache = new Map();
    // Render children of the justified galleries set up so far (see onunload).
    this.galleries = new Set();
    this.sel = null; // the image selection in a gallery (setSelection)

    this.applyCssVars();
    // Popout windows have their own document, so style each as it opens.
    this.registerEvent(
      this.app.workspace.on('window-open', (win, window) => this.applyCssVarsTo(window.document))
    );
    this.addSettingTab(new MediaGallerySettingTab(this.app, this));

    this.addCommand({
      id: 'wrap-in-gallery',
      name: 'Wrap selection in gallery callout',
      editorCallback: (editor) => this.wrapSelection(editor, 'gallery'),
    });
    this.addCommand({
      id: 'wrap-in-gallery-masonry',
      name: 'Wrap selection in masonry gallery callout',
      editorCallback: (editor) => this.wrapSelection(editor, 'gallery-masonry'),
    });
    this.addCommand({
      id: 'unwrap-gallery',
      name: 'Remove gallery callout wrapping',
      editorCallback: (editor) => this.unwrapSelection(editor),
    });
    this.addCommand({
      id: 'insert-row-separator',
      name: 'Insert row separator (***) in gallery',
      editorCallback: (editor) => this.insertSeparator(editor),
    });
    this.addCommand({
      id: 'remove-empty-lines',
      name: 'Remove empty lines in gallery',
      editorCallback: (editor) => this.compactGallery(editor),
    });
    this.addCommand({
      id: 'remove-row-separators',
      name: 'Remove row separators (***) in gallery',
      editorCallback: (editor) => this.removeSeparators(editor),
    });

    this.ribbonEl = null;
    this.applyRibbon();

    // Right-click menu: wrap actions outside a gallery, gallery actions inside.
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        if (!this.settings.showEditorMenu) return;
        const inGallery = this.galleryTop(editor, this.selectedLines(editor).fromLine) >= 0;
        menu.addSeparator();
        if (inGallery) {
          menu.addItem((i) =>
            i.setTitle('Insert row separator (***)').setIcon('minus').onClick(() => this.insertSeparator(editor))
          );
          menu.addItem((i) =>
            i.setTitle('Remove empty lines in gallery').setIcon('eraser').onClick(() => this.compactGallery(editor))
          );
          menu.addItem((i) =>
            i.setTitle('Remove row separators (***)').setIcon('trash-2').onClick(() => this.removeSeparators(editor))
          );
          menu.addItem((i) =>
            i.setTitle('Remove gallery').setIcon('x').onClick(() => this.unwrapSelection(editor))
          );
        } else {
          menu.addItem((i) =>
            i.setTitle('Wrap in gallery').setIcon('layout-grid').onClick(() => this.wrapSelection(editor, 'gallery'))
          );
          menu.addItem((i) =>
            i.setTitle('Wrap in masonry gallery').setIcon('align-start-vertical')
              .onClick(() => this.wrapSelection(editor, 'gallery-masonry'))
          );
        }
      })
    );

    this.registerMarkdownPostProcessor((el, ctx) => {
      const find = (sel) => (el.matches(sel) ? [el] : Array.from(el.querySelectorAll(sel)));
      find('.callout[data-callout="gallery"]').forEach((c) => this.setupJustified(c, ctx, el));
      // Masonry is laid out by CSS; it only shares async decoding and reordering.
      find('.callout[data-callout="gallery-masonry"]').forEach((c) => this.setupMasonry(c, ctx, el));
    });
  }

  /* Every document Obsidian renders into: the main window plus open popouts. */
  documents() {
    const docs = new Set([document]);
    this.app.workspace.iterateAllLeaves((leaf) => {
      const el = leaf.view && leaf.view.containerEl;
      if (el) docs.add(el.ownerDocument);
    });
    return docs;
  }

  /* Push settings to CSS custom properties consumed by styles.css */
  applyCssVars() {
    this.documents().forEach((doc) => this.applyCssVarsTo(doc));
  }

  cssVars() {
    const s = this.settings;
    return {
      '--mg-columns': String(s.columns),
      '--mg-col-width': s.columnWidth + 'px',
      '--mg-gap': s.gap + 'px',
      '--mg-radius': s.radius + 'px',
      '--mg-width': s.width + '%',
    };
  }

  applyCssVarsTo(doc) {
    const vars = this.cssVars();
    for (const name in vars) doc.body.style.setProperty(name, vars[name]);
  }

  removeCssVars() {
    const names = Object.keys(this.cssVars());
    this.documents().forEach((doc) => names.forEach((n) => doc.body.style.removeProperty(n)));
  }

  onunload() {
    if (this.settingsDirty) { // flush a pending write
      this.persistSettings.cancel();
      this.writeSettings();
    }
    this.removeCssVars();

    // Rendered notes outlive the plugin: stop their galleries' observers and
    // timers, and give the media back their natural size.
    this.clearSelection();
    this.galleries.forEach((child) => child.unload());
    this.documents().forEach((doc) => {
      doc.querySelectorAll('.callout-content[data-mg-ready]').forEach((content) => {
        delete content.dataset.mgReady;
        content.querySelectorAll('img, video').forEach((el) => {
          el.style.removeProperty('width');
          el.style.removeProperty('height');
          el.style.removeProperty('margin-right');
          el.classList.remove('mg-broken');
        });
      });
    });
  }

  writeSettings() {
    this.settingsDirty = false;
    return this.saveData(this.settings);
  }

  saveSettings() {
    this.settingsDirty = true;
    this.persistSettings();
    this.applyCssVars();
    // Re-layout every visible justified gallery so changes show immediately.
    this.documents().forEach((doc) => {
      doc
        .querySelectorAll('.callout[data-callout="gallery"] > .callout-content')
        .forEach((content) => this.layout(content));
    });
  }

  /* Add or remove the left-ribbon wrap button to match the setting. */
  applyRibbon() {
    if (this.settings.showRibbon && !this.ribbonEl) {
      this.ribbonEl = this.addRibbonIcon('layout-grid', 'Wrap in gallery', (evt) => {
        const menu = new obsidian.Menu();
        menu.addItem((i) =>
          i.setTitle('Justified gallery').setIcon('layout-grid').onClick(() => this.wrapActive('gallery'))
        );
        menu.addItem((i) =>
          i.setTitle('Masonry gallery').setIcon('align-start-vertical').onClick(() => this.wrapActive('gallery-masonry'))
        );
        menu.addItem((i) =>
          i.setTitle('Row separator (***)').setIcon('minus')
            .onClick(() => this.withActiveEditor((editor) => this.insertSeparator(editor)))
        );
        menu.addItem((i) =>
          i.setTitle('Remove empty lines').setIcon('eraser')
            .onClick(() => this.withActiveEditor((editor) => this.compactGallery(editor)))
        );
        menu.addItem((i) =>
          i.setTitle('Remove row separators').setIcon('trash-2')
            .onClick(() => this.withActiveEditor((editor) => this.removeSeparators(editor)))
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i.setTitle('Remove gallery').setIcon('x').onClick(() => this.unwrapActive())
        );
        menu.showAtMouseEvent(evt);
      });
    } else if (!this.settings.showRibbon && this.ribbonEl) {
      this.ribbonEl.remove();
      this.ribbonEl = null;
    }
  }

  /* Run an editor action against the active markdown view (ribbon button). */
  withActiveEditor(fn) {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (view && view.editor) {
      fn(view.editor);
    } else {
      new obsidian.Notice('Metal Media Gallery: open a note in editing mode first.');
    }
  }

  wrapActive(type) {
    this.withActiveEditor((editor) => this.wrapSelection(editor, type));
  }

  unwrapActive() {
    this.withActiveEditor((editor) => this.unwrapSelection(editor));
  }

  /* Whole lines covered by the selection, or the cursor's line. Commands
     always act on whole lines, even when the selection starts or ends
     mid-line; a selection that ends at the very start of a line (as after
     Shift+Down) doesn't include that line. */
  selectedLines(editor) {
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const toLine = to.line > from.line && to.ch === 0 ? to.line - 1 : to.line;
    return { fromLine: from.line, toLine };
  }

  /* First and last line of the blockquote that contains line n. */
  quoteTop(editor, n) {
    while (n > 0 && QUOTE.test(editor.getLine(n - 1))) n--;
    return n;
  }

  quoteBottom(editor, n) {
    const last = editor.lastLine();
    while (n < last && QUOTE.test(editor.getLine(n + 1))) n++;
    return n;
  }

  /* The gallery callouts that the selection (or the cursor's line) touches,
     as { top, bottom } line ranges, last first, so editing them in order
     keeps the line numbers of the ones still to come valid. With none, a
     notice is shown and the list is empty. */
  touchedGalleries(editor) {
    const { fromLine, toLine } = this.selectedLines(editor);
    const blocks = [];
    for (let n = fromLine; n <= toLine; n++) {
      if (!QUOTE.test(editor.getLine(n))) continue;
      const top = this.quoteTop(editor, n);
      const bottom = this.quoteBottom(editor, n);
      if (GALLERY_HEADER.test(editor.getLine(top))) blocks.push({ top, bottom });
      n = bottom;
    }
    if (!blocks.length) new obsidian.Notice('Metal Media Gallery: no gallery callout at the cursor.');
    return blocks.reverse();
  }

  /* Header line of the gallery callout that contains line n, or -1. */
  galleryTop(editor, n) {
    if (!QUOTE.test(editor.getLine(n))) return -1;
    const top = this.quoteTop(editor, n);
    return GALLERY_HEADER.test(editor.getLine(top)) ? top : -1;
  }

  /* Replace lines a..b with `lines`, adding blank lines where a neighbour
     would otherwise run into the callout: a quote directly above would take
     the header in as plain text, and a non-blank line directly below would
     join the callout as a lazy continuation. `joinsBelow` says the line below
     already belongs to the block, so it must stay attached. */
  replaceLines(editor, a, b, lines, joinsBelow) {
    const out = lines.slice();
    if (a > 0 && QUOTE.test(editor.getLine(a - 1))) out.unshift('');
    if (!joinsBelow && b < editor.lastLine() && editor.getLine(b + 1).trim()) out.push('');
    editor.replaceRange(
      out.join('\n'),
      { line: a, ch: 0 },
      { line: b, ch: editor.getLine(b).length }
    );
  }

  /* Wrap the selected lines (or the current line) in a gallery callout.
     If the selection overlaps or directly borders an existing gallery, the
     lines are merged into it instead of getting a second "> [!gallery]" —
     see extendGallery below. */
  wrapSelection(editor, type) {
    const { fromLine, toLine } = this.selectedLines(editor);
    const last = editor.lastLine();

    for (let n = Math.max(fromLine - 1, 0); n <= Math.min(toLine + 1, last); n++) {
      if (!QUOTE.test(editor.getLine(n))) continue;
      const top = this.quoteTop(editor, n);
      if (GALLERY_HEADER.test(editor.getLine(top))) {
        this.extendGallery(editor, fromLine, toLine, top);
        return;
      }
      n = this.quoteBottom(editor, n); // not a gallery; skip the rest of it
    }

    const lines = [`> [!${type}]`];
    for (let n = fromLine; n <= toLine; n++) lines.push(quoteLine(editor.getLine(n)));
    this.replaceLines(editor, fromLine, toLine, lines, false);
  }

  /* Merge lines fromLine..toLine into the gallery whose header is on line
     `top`. The header must stay the first line of the blockquote, or the
     callout turns into a plain quote, so it moves above any lines selected
     before it; everything else keeps its order. Plain lines get a "> "
     prefix, and the headers of other galleries in the range are dropped, so
     a selection spanning two galleries merges them. The type is kept. */
  extendGallery(editor, fromLine, toLine, top) {
    const a = Math.min(fromLine, top);
    const b = Math.max(toLine, top);
    const lines = [editor.getLine(top)];
    for (let n = a; n <= b; n++) {
      const line = editor.getLine(n);
      if (n === top || GALLERY_HEADER.test(line)) continue;
      lines.push(QUOTE.test(line) ? line : quoteLine(line));
    }
    this.replaceLines(editor, a, b, lines, QUOTE.test(editor.getLine(b)));
  }

  /* Unwrap every gallery callout that the selection (or the cursor's line)
     touches: drop its header and row separators, and strip one level of
     "> " from all its lines. Other quotes and callouts are left alone. */
  unwrapSelection(editor) {
    for (const { top, bottom } of this.touchedGalleries(editor)) {
      const lines = [];
      for (let n = top + 1; n <= bottom; n++) {
        const line = editor.getLine(n);
        if (ROW_SEPARATOR.test(line)) continue; // would become a horizontal rule
        lines.push(line.replace(/^(\s*)>\s?/, '$1'));
      }
      editor.replaceRange(
        lines.join('\n'),
        { line: top, ch: 0 },
        { line: bottom, ch: editor.getLine(bottom).length }
      );
    }
  }

  /* Remove *** row separators: the one on the cursor's line, those among
     the selected lines, or else all of the gallery at the cursor. */
  removeSeparators(editor) {
    const { fromLine, toLine } = this.selectedLines(editor);
    const selected = editor.somethingSelected();
    const onSeparator = !selected && ROW_SEPARATOR.test(editor.getLine(fromLine));
    let removed = 0;
    for (const { top, bottom } of this.touchedGalleries(editor)) {
      const lo = selected || onSeparator ? Math.max(top, fromLine) : top;
      const hi = selected || onSeparator ? Math.min(bottom, toLine) : bottom;
      for (let n = hi; n >= lo; n--) { // bottom-up keeps the lines above in place
        if (!ROW_SEPARATOR.test(editor.getLine(n))) continue;
        // Take the line with its line break (the one before it at the end of the note).
        if (n < editor.lastLine()) editor.replaceRange('', { line: n, ch: 0 }, { line: n + 1, ch: 0 });
        else editor.replaceRange('', { line: n - 1, ch: editor.getLine(n - 1).length }, { line: n, ch: editor.getLine(n).length });
        removed++;
      }
    }
    if (!removed && this.galleryTop(editor, fromLine) >= 0) {
      new obsidian.Notice('Metal Media Gallery: no row separators here.');
    }
  }

  /* Remove the empty ">" lines from every gallery callout that the selection
     (or the cursor's line) touches. */
  compactGallery(editor) {
    for (const { top, bottom } of this.touchedGalleries(editor)) {
      const lines = [];
      for (let n = top; n <= bottom; n++) {
        const line = editor.getLine(n);
        if (!EMPTY_QUOTE.test(line)) lines.push(line);
      }
      if (lines.length === bottom - top + 1) continue; // nothing to remove
      // An empty ">" at the end kept a following paragraph out of the
      // callout; without it, that line would join as a lazy continuation.
      if (EMPTY_QUOTE.test(editor.getLine(bottom)) && bottom < editor.lastLine() &&
          editor.getLine(bottom + 1).trim()) {
        lines.push('');
      }
      editor.replaceRange(
        lines.join('\n'),
        { line: top, ch: 0 },
        { line: bottom, ch: editor.getLine(bottom).length }
      );
    }
  }

  /* Insert a "> ***" row separator in a gallery: on the cursor's line if it
     is an empty ">" line, otherwise on a new line after it. With a selection,
     separators go before and after the selected lines, so they become a
     group of their own (a short one is a single full-width row), again
     taking over an empty ">" line there; none is added where a separator or
     the header already is. */
  insertSeparator(editor) {
    const { fromLine, toLine } = this.selectedLines(editor);
    const top = this.galleryTop(editor, fromLine);
    if (top < 0 || this.quoteBottom(editor, fromLine) < toLine) {
      new obsidian.Notice('Metal Media Gallery: put the cursor or selection inside a gallery callout.');
      return;
    }

    const sep = '> ***';
    const endOf = (n) => ({ line: n, ch: editor.getLine(n).length });
    const isEmpty = (n) => n > top && n <= editor.lastLine() && EMPTY_QUOTE.test(editor.getLine(n));
    const replaceLine = (n) => editor.replaceRange(sep, { line: n, ch: 0 }, endOf(n));

    if (!editor.somethingSelected()) {
      const line = isEmpty(fromLine) ? fromLine : fromLine + 1;
      if (line === fromLine) replaceLine(line);
      else editor.replaceRange('\n' + sep, endOf(fromLine));
      editor.setCursor(endOf(line));
      return;
    }
    // The one after first, so fromLine stays valid for the one before.
    if (isEmpty(toLine + 1)) replaceLine(toLine + 1);
    else if (toLine === editor.lastLine() || !ROW_SEPARATOR.test(editor.getLine(toLine + 1))) {
      editor.replaceRange('\n' + sep, endOf(toLine));
    }
    if (isEmpty(fromLine - 1)) replaceLine(fromLine - 1);
    else if (fromLine > top + 1 && !ROW_SEPARATOR.test(editor.getLine(fromLine - 1))) {
      editor.replaceRange(sep + '\n', { line: fromLine, ch: 0 });
    }
  }

  /* Pointer editing of a gallery in reading view; each change rewrites the
     embeds in the note, and Obsidian then re-renders the gallery.
     - Ctrl/Cmd + drag moves an image (dragItem). `vertical` galleries
       (masonry, whose order runs down the columns) drop above/below an
       image instead of left/right.
     - Alt + drag selects the images a box touches (Shift adds to the
       selection), Alt + click toggles one (selectBox); a toolbar over the
       selection offers "One row", "Ungroup" and "Remove" (editSelection),
       the last also on the Delete / Backspace key.
     - Right-click opens the file menu of an embedded image (fileMenu). */
  setupInteractions(child, content, sectionEl, ctx, vertical) {
    const onDown = (e) => {
      if (e.button !== 0 || !content.closest('.markdown-preview-view')) return;
      if (e.altKey) {
        e.preventDefault(); // no text selection or native image drag
        this.selectBox(e, content, sectionEl, ctx);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const item = e.target.closest && e.target.closest('img, video');
      if (!item || !content.contains(item)) return;
      e.preventDefault();
      this.dragItem(e, item, content, sectionEl, ctx, vertical);
    };
    const onDragStart = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault();
    };
    const onMenu = (e) => {
      const item = e.target.closest && e.target.closest('img, video');
      if (item && content.contains(item) && this.fileMenu(e, item, ctx.sourcePath)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    content.addEventListener('pointerdown', onDown);
    content.addEventListener('dragstart', onDragStart);
    content.addEventListener('contextmenu', onMenu, true); // before handlers on the embed itself
    child.register(() => {
      content.removeEventListener('pointerdown', onDown);
      content.removeEventListener('dragstart', onDragStart);
      content.removeEventListener('contextmenu', onMenu, true);
      // Re-rendered or unloaded: the selected elements are gone.
      if (this.sel && this.sel.content === content) this.clearSelection();
    });
  }

  /* Show the menu Obsidian gives a link in the editor for the file an image
     embeds: open in a new tab / to the right / in a new window, then the
     file-menu items (rename, delete, reveal, copy path, other plugins').
     Returns false, leaving the event alone, for media that aren't a vault
     file (external images). */
  fileMenu(evt, item, sourcePath) {
    const embed = item.closest('.internal-embed');
    const src = embed && embed.getAttribute('src');
    if (!src) return false;
    const link = src.split('|')[0].trim();
    const file = this.app.metadataCache.getFirstLinkpathDest(obsidian.getLinkpath(link), sourcePath);
    if (!(file instanceof obsidian.TFile)) return false;

    const menu = new obsidian.Menu();
    const ws = this.app.workspace;
    // Obsidian's own link menu; it is internal, so check it is there and
    // filled the menu (Menu.items is internal too).
    if (typeof ws.handleLinkContextMenu === 'function') {
      ws.handleLinkContextMenu(menu, link, sourcePath);
      if (!Array.isArray(menu.items) || menu.items.length) {
        menu.showAtMouseEvent(evt);
        return true;
      }
    }
    const open = (title, icon, where) =>
      menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(() => ws.openLinkText(link, sourcePath, where)));
    open('Open in new tab', 'file-plus', 'tab');
    open('Open to the right', 'separator-vertical', 'split');
    open('Open in new window', 'picture-in-picture-2', 'window');
    menu.addSeparator();
    ws.trigger('file-menu', menu, file, 'link-context-menu');
    menu.showAtMouseEvent(evt);
    return true;
  }

  /* Follow one Alt + press: a drag draws a box and selects the images it
     touches (added to the current selection with Shift); a press without
     movement toggles the image under it. Escape restores the selection. */
  selectBox(down, content, sectionEl, ctx) {
    const doc = content.ownerDocument;
    const win = doc.defaultView || window;
    const base = this.sel && this.sel.content === content ? new Set(this.sel.items) : new Set();
    const box = doc.createElement('div');
    box.className = 'mg-marquee';
    let active = false;
    // The box's corner is pinned to the content, so scrolling stretches it.
    const c0 = content.getBoundingClientRect();
    const sx = down.clientX - c0.left;
    const sy = down.clientY - c0.top;
    const pointer = { x: down.clientX, y: down.clientY };

    const update = () => {
      const c = content.getBoundingClientRect();
      const x0 = c.left + sx;
      const y0 = c.top + sy;
      if (!active) {
        if (Math.hypot(pointer.x - x0, pointer.y - y0) < 5) return;
        active = true;
        doc.body.appendChild(box);
        doc.body.classList.add('mg-selecting');
      }
      const l = Math.min(x0, pointer.x);
      const r = Math.max(x0, pointer.x);
      const t = Math.min(y0, pointer.y);
      const b = Math.max(y0, pointer.y);
      Object.assign(box.style, { left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' });
      const picked = new Set(down.shiftKey ? base : []);
      content.querySelectorAll('img, video').forEach((el) => {
        const q = el.getBoundingClientRect();
        if (q.right > l && q.left < r && q.bottom > t && q.top < b) picked.add(el);
      });
      this.setSelection(content, sectionEl, ctx, picked);
    };
    const scroll = this.scrollWhileDragging(content, pointer, update);
    const onMove = (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      update();
      scroll.kick();
    };

    const finish = (cancel) => {
      scroll.stop();
      win.removeEventListener('pointermove', onMove, true);
      win.removeEventListener('pointerup', onUp, true);
      win.removeEventListener('pointercancel', onCancel, true);
      win.removeEventListener('keydown', onKey, true);
      box.remove();
      doc.body.classList.remove('mg-selecting');
      if (cancel) {
        this.setSelection(content, sectionEl, ctx, base);
      } else if (!active) {
        const item = down.target.closest && down.target.closest('img, video');
        if (item && content.contains(item)) {
          const picked = new Set(base);
          if (picked.has(item)) picked.delete(item);
          else picked.add(item);
          this.setSelection(content, sectionEl, ctx, picked);
        }
      }
      // Keep the click that ends the press from opening a lightbox.
      const swallow = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      win.addEventListener('click', swallow, true);
      win.setTimeout(() => win.removeEventListener('click', swallow, true), 0);
    };
    const onUp = () => finish(false);
    const onCancel = () => finish(true);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };

    win.addEventListener('pointermove', onMove, true);
    win.addEventListener('pointerup', onUp, true);
    win.addEventListener('pointercancel', onCancel, true);
    win.addEventListener('keydown', onKey, true);
  }

  /* Show `items` (media of one gallery) as selected, with the toolbar over
     them; an empty set clears the selection. One selection at a time. */
  setSelection(content, sectionEl, ctx, items) {
    if (this.sel && this.sel.content !== content) this.clearSelection();
    if (!items.size) {
      this.clearSelection();
      return;
    }
    if (!this.sel) this.sel = this.openSelection(content, sectionEl, ctx);
    this.sel.items.forEach((el) => {
      if (!items.has(el)) el.classList.remove('mg-selected');
    });
    items.forEach((el) => el.classList.add('mg-selected'));
    this.sel.items = items;
    this.sel.place();
  }

  /* Selection state with its toolbar: a fixed element on <body> kept above
     the selected images. Escape or a press anywhere else clears it. */
  openSelection(content, sectionEl, ctx) {
    const doc = content.ownerDocument;
    const win = doc.defaultView || window;
    const bar = doc.createElement('div');
    bar.className = 'mg-toolbar';
    const button = (label, title, onClick, cta) => {
      const b = doc.createElement('button');
      b.textContent = label;
      b.title = title;
      if (cta) b.classList.add('mod-cta');
      b.addEventListener('click', onClick);
      bar.appendChild(b);
    };
    button('One row', 'Put the selected images in a row of their own (between *** lines)',
      () => this.editSelection(groupEmbeds), true);
    button('Ungroup', 'Remove the *** lines around the groups of the selected images',
      () => this.editSelection(ungroupEmbeds));
    button('Remove', 'Take the selected images out of the gallery (Delete); the files stay in the vault',
      () => this.removeSelection());
    button('✕', 'Clear the selection (Esc)', () => this.clearSelection());
    doc.body.appendChild(bar);

    const sel = { content, sectionEl, ctx, items: new Set() };
    sel.place = () => {
      let top = Infinity;
      let left = Infinity;
      sel.items.forEach((el) => {
        const r = el.getBoundingClientRect();
        top = Math.min(top, r.top);
        left = Math.min(left, r.left);
      });
      const h = bar.offsetHeight;
      const y = Math.min(Math.max(top - h - 6, 4), win.innerHeight - h - 4);
      bar.style.top = y + 'px';
      bar.style.left = Math.max(left, 4) + 'px';
    };
    const onKey = (e) => {
      if (e.key === 'Escape') this.clearSelection();
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      this.removeSelection();
    };
    const onDown = (e) => {
      if (!bar.contains(e.target) && !e.altKey) this.clearSelection();
    };
    win.addEventListener('scroll', sel.place, true);
    win.addEventListener('resize', sel.place);
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('pointerdown', onDown, true);
    sel.close = () => {
      win.removeEventListener('scroll', sel.place, true);
      win.removeEventListener('resize', sel.place);
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('pointerdown', onDown, true);
      sel.items.forEach((el) => el.classList.remove('mg-selected'));
      bar.remove();
    };
    return sel;
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel.close();
    this.sel = null;
  }

  /* Take the selected images out of the gallery: their embeds leave the
     note, the files stay. Says so, since the images just vanish. */
  async removeSelection() {
    const count = this.sel ? this.sel.items.size : 0;
    if (await this.editSelection(removeEmbeds)) {
      new obsidian.Notice('Metal Media Gallery: removed ' + count + (count === 1 ? ' image' : ' images') +
        ' from the gallery; the ' + (count === 1 ? 'file is' : 'files are') + ' still in the vault.');
    }
  }

  /* Apply edit(block, picked) to the gallery of the selection, where picked
     are the selected images' embed indices, ascending; then clear it.
     Resolves to whether the note was rewritten. */
  editSelection(edit) {
    const sel = this.sel;
    if (!sel) return Promise.resolve(false);
    const items = Array.from(sel.items);
    this.clearSelection();
    return this.rewriteGallery(sel.content, sel.sectionEl, sel.ctx, (block, units) => {
      const picked = [...new Set(items.map((el) => units.indexOf(embedUnit(el))))]
        .filter((i) => i >= 0)
        .sort((a, b) => a - b);
      return picked.length ? edit(block, picked) : null;
    });
  }

  /* Follow one drag from its pointerdown: dim the image, show a bar in the
     gap on the side of the image under the pointer where it will land, and
     move on release. Escape cancels. A press without movement stays an
     ordinary click. */
  dragItem(down, item, content, sectionEl, ctx, vertical) {
    const doc = content.ownerDocument;
    const win = doc.defaultView || window;
    let active = false;
    let target = null;
    let after = false;

    // The bar is a fixed element on <body>, placed from the target's
    // on-screen box: drawn inside the gallery, it was clipped by an ancestor
    // at the edges of a row, exactly where a gap lies outside the gallery.
    const bar = doc.createElement('div');
    bar.className = 'mg-drop-bar';
    const placeBar = () => {
      bar.hidden = !target;
      if (!target) return;
      const b = target.getBoundingClientRect();
      const half = this.settings.gap / 2;
      const t = 4; // thickness
      if (vertical) {
        const y = after ? b.bottom + half : b.top - half;
        Object.assign(bar.style, { left: b.left + 'px', width: b.width + 'px', top: y - t / 2 + 'px', height: t + 'px' });
      } else {
        const x = after ? b.right + half : b.left - half;
        Object.assign(bar.style, { left: x - t / 2 + 'px', width: t + 'px', top: b.top + 'px', height: b.height + 'px' });
      }
    };
    const setTarget = (el, isAfter) => {
      target = el;
      after = isAfter;
      placeBar();
    };

    const pointer = { x: down.clientX, y: down.clientY };
    const update = () => {
      if (!active) {
        if (Math.hypot(pointer.x - down.clientX, pointer.y - down.clientY) < 5) return;
        active = true;
        item.classList.add('mg-dragging');
        doc.body.classList.add('mg-reordering');
        doc.body.appendChild(bar);
        win.addEventListener('scroll', placeBar, true); // the target moves under a still pointer
      }
      const r = content.getBoundingClientRect();
      if (pointer.x < r.left || pointer.x > r.right || pointer.y < r.top || pointer.y > r.bottom) {
        setTarget(null);
        return;
      }
      const over = doc.elementFromPoint(pointer.x, pointer.y);
      const el = over && over.closest('img, video');
      if (!el || !content.contains(el)) return; // in a gap: keep the last target
      const b = el.getBoundingClientRect();
      const isAfter = vertical ? pointer.y > b.top + b.height / 2 : pointer.x > b.left + b.width / 2;
      setTarget(el === item ? null : el, isAfter);
    };
    const scroll = this.scrollWhileDragging(content, pointer, update);
    const onMove = (e) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      update();
      scroll.kick();
    };

    const finish = (drop) => {
      scroll.stop();
      win.removeEventListener('pointermove', onMove, true);
      win.removeEventListener('pointerup', onUp, true);
      win.removeEventListener('pointercancel', onCancel, true);
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('scroll', placeBar, true);
      const dropOn = target;
      const dropAfter = after;
      bar.remove();
      item.classList.remove('mg-dragging');
      doc.body.classList.remove('mg-reordering');
      if (!active) return;
      // The release still fires a click; keep it from opening a lightbox or
      // following a link. It is dispatched before any timer runs.
      const swallow = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      win.addEventListener('click', swallow, true);
      win.setTimeout(() => win.removeEventListener('click', swallow, true), 0);
      if (drop && dropOn) this.moveItem(content, sectionEl, ctx, item, dropOn, dropAfter);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };

    win.addEventListener('pointermove', onMove, true);
    win.addEventListener('pointerup', onUp, true);
    win.addEventListener('pointercancel', onCancel, true);
    win.addEventListener('keydown', onKey, true);
  }

  /* Scrolling during a drag or box selection, whose pointerdown suppressed
     the native kind: the wheel scrolls the note (with Ctrl held it would
     zoom instead), and so does holding the pointer near the note's top or
     bottom edge, faster closer to it. update() runs after each scroll step
     so the hit test follows the content. Returns { kick, stop }; call
     kick() after each pointer move. */
  scrollWhileDragging(content, pointer, update) {
    const win = content.ownerDocument.defaultView || window;
    const scroller = scrollParent(content);
    if (!scroller) return { kick() {}, stop() {} };
    const scrollBy = (dy) => {
      const before = scroller.scrollTop;
      scroller.scrollBy({ top: dy, behavior: 'instant' });
      return scroller.scrollTop !== before;
    };

    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? scroller.clientHeight : 1;
      if (scrollBy(e.deltaY * unit)) update();
    };
    win.addEventListener('wheel', onWheel, { capture: true, passive: false });

    let frame = 0;
    const step = () => {
      frame = 0;
      const r = scroller.getBoundingClientRect();
      const edge = Math.min(60, r.height / 4);
      const into = pointer.y < r.top + edge ? pointer.y - (r.top + edge)
        : pointer.y > r.bottom - edge ? pointer.y - (r.bottom - edge)
        : 0;
      if (!into || !scrollBy(Math.max(-25, Math.min(25, into / 3)))) return; // out of the zone, or at the end
      update();
      frame = win.requestAnimationFrame(step); // keep going while the pointer rests there
    };
    return {
      kick: () => {
        if (!frame) frame = win.requestAnimationFrame(step);
      },
      stop: () => {
        win.removeEventListener('wheel', onWheel, { capture: true });
        win.cancelAnimationFrame(frame);
      },
    };
  }

  /* Move `item` before (or after) `target` in the note's source. */
  moveItem(content, sectionEl, ctx, item, target, after) {
    return this.rewriteGallery(content, sectionEl, ctx, (block, units) => {
      const from = units.indexOf(embedUnit(item));
      const to = units.indexOf(embedUnit(target));
      if (from < 0 || to < 0) return null; // e.g. an image inside an embedded note
      return moveEmbed(block, from, to, after);
    });
  }

  /* Rewrite the gallery's lines in the note: edit(block, units) gets the
     gallery's source lines and its rendered embeds (galleryUnits), whose
     indices match findEmbeds(block), and returns new lines or null. The
     section's text must still be what was rendered, and the counts must
     agree; anything that doesn't line up — the note changed meanwhile, the
     gallery is nested, an embed renders as something else — leaves the
     note untouched, with a notice (and the details in the console).
     Resolves to whether the note was rewritten. */
  async rewriteGallery(content, sectionEl, ctx, edit) {
    const units = galleryUnits(content);
    const info = ctx.getSectionInfo(sectionEl);
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!info || !(file instanceof obsidian.TFile)) {
      new obsidian.Notice("Metal Media Gallery: galleries can only be edited in the note's own reading view.");
      return false;
    }

    let error = null;
    let rewrote = false;
    await this.processFile(file, (data) => {
      const eol = data.includes('\r\n') ? '\r\n' : '\n';
      const lines = data.split(/\r?\n/);
      // info.text is in practice the whole note, but is documented as the
      // section's text; accept either.
      const rendered = info.text.split(/\r?\n/);
      const offset = rendered.length === info.lineEnd - info.lineStart + 1 ? info.lineStart : 0;
      for (let n = info.lineStart; n <= info.lineEnd; n++) {
        if (lines[n] !== rendered[n - offset]) {
          error = 'the note has changed, try again.';
          return data;
        }
      }
      let top = info.lineStart;
      while (top <= info.lineEnd && !GALLERY_HEADER.test(lines[top])) top++;
      let end = info.lineEnd;
      while (end > top && !lines[end].trim()) end--;
      // Lines right after the quote that don't start with ">" still belong
      // to the callout (lazy continuation), so their images show in the
      // gallery. Writing them with "> " keeps them there wherever the move
      // or grouping takes them; it doesn't change what is rendered.
      const block = top <= end
        ? lines.slice(top, end + 1).map((l) => (QUOTE.test(l) ? l : quoteLine(l)))
        : [];
      const embeds = findEmbeds(block);
      if (embeds.length !== units.length) {
        error = "couldn't match the images to the note's text (details in the console, Ctrl+Shift+I).";
        console.warn('Metal Media Gallery: found', embeds.length, 'embeds in the text but',
          units.length, 'rendered.', { text: embeds.map((e) => e.text), rendered: units });
        return data;
      }
      const next = edit(block, units);
      if (!next) return data;
      lines.splice(top, block.length, ...next);
      rewrote = true;
      return lines.join(eol);
    });
    if (error) new obsidian.Notice('Metal Media Gallery: ' + error);
    return rewrote && !error;
  }

  /* Rewrite a file through fn. Vault.process (atomic) needs Obsidian 1.1. */
  async processFile(file, fn) {
    const vault = this.app.vault;
    if (vault.process) return vault.process(file, fn);
    const data = await vault.read(file);
    const next = fn(data);
    if (next !== data) await vault.modify(file, next);
  }

  /* The content of a gallery callout not set up yet, now marked as set up,
     or null. */
  claimContent(callout) {
    const content = callout.querySelector(':scope > .callout-content');
    if (!content || content.dataset.mgReady) return null;
    content.dataset.mgReady = '1';
    return content;
  }

  /* A render child for one gallery. Observers and listeners registered on it
     are released when Obsidian discards the rendered section (otherwise every
     re-render would leave them, and the whole old DOM, alive) or when the
     plugin unloads (see onunload). */
  galleryChild(callout, ctx) {
    const child = new obsidian.MarkdownRenderChild(callout);
    this.galleries.add(child);
    child.register(() => this.galleries.delete(child));
    ctx.addChild(child);
    return child;
  }

  /* Call fn whenever nodes are added under content. Obsidian loads ![[embeds]]
     after the post processors have run, so when a gallery is set up its img
     elements usually don't exist yet; they arrive one by one later. */
  watchAdded(child, content, fn) {
    const mo = new MutationObserver(fn);
    mo.observe(content, { childList: true, subtree: true });
    child.register(() => mo.disconnect());
  }

  setupMasonry(callout, ctx, sectionEl) {
    const content = this.claimContent(callout);
    if (!content) return;
    const child = this.galleryChild(callout, ctx);
    this.setupInteractions(child, content, sectionEl, ctx, true);
    this.watchAdded(child, content, () => decodeAsync(content));
    decodeAsync(content);
  }

  /* Wire up one justified gallery: (re)layout as media arrive and load, and
     on resize. */
  setupJustified(callout, ctx, sectionEl) {
    const content = this.claimContent(callout);
    if (!content) return;
    const child = this.galleryChild(callout, ctx);
    this.setupInteractions(child, content, sectionEl, ctx, false);

    // A large gallery fires many load/loadedmetadata events in quick
    // succession, and each full re-layout re-flows the whole gallery, so
    // they are coalesced into one layout per 100 ms window. The initial
    // layout and resize layout stay synchronous so the gallery sizes
    // correctly on first paint even when images come from cache.
    let timer = null;
    const relayoutBatched = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        this.layout(content);
      }, 100);
    };
    child.register(() => clearTimeout(timer));

    // A load whose measured ratio matches what the layout already assumed
    // (from the URL cache) changes nothing, so it doesn't trigger a layout.
    const onMedia = (e) => {
      const el = e.target;
      const ar = measureAr(el);
      if (ar && usedAr.has(el) && Math.abs(ar - usedAr.get(el)) < 1e-3) return;
      relayoutBatched();
    };

    // These events don't bubble, but listening in the capture phase on the
    // content catches them for every item, including ones added later.
    for (const type of ['load', 'error', 'loadedmetadata']) {
      content.addEventListener(type, onMedia, true);
      child.register(() => content.removeEventListener(type, onMedia, true));
    }

    // Newly added items are sized in the next frame, before it is painted,
    // so they never show at their natural size; items arriving within one
    // frame share a layout.
    const win = content.ownerDocument.defaultView || window;
    let frame = 0;
    const relayoutNextFrame = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        this.layout(content);
      });
    };
    child.register(() => win.cancelAnimationFrame(frame));
    this.watchAdded(child, content, () => {
      decodeAsync(content);
      relayoutNextFrame();
    });
    decodeAsync(content);

    // ResizeObserver is already throttled to at most one notification per
    // frame, so layout runs synchronously here without the O(n²) risk. It
    // also fires when layout itself changes the content's height, so skip
    // notifications where the width (the only input) is unchanged.
    let lastWidth = content.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = content.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      this.layout(content);
    });
    ro.observe(content);
    child.register(() => ro.disconnect());

    this.layout(content);
  }

  rememberAr(src, ar) {
    if (this.arCache.size >= 4000 && !this.arCache.has(src)) {
      this.arCache.delete(this.arCache.keys().next().value); // drop the oldest
    }
    this.arCache.set(src, ar);
  }

  /* Size the items of one justified gallery (the packing itself is packRows). */
  layout(content) {
    // Post processors also run on callouts in Live Preview, where styles.css
    // doesn't apply; sizing the images there would only shrink them in place.
    if (!content.closest('.markdown-preview-view')) return;

    // *** separators (<hr>) split the items into groups, each packed on its
    // own; a group that a separator closes ends with a full row.
    const items = [];
    const groups = [];
    let groupStart = 0;
    const closeGroup = (closed) => {
      if (items.length > groupStart) groups.push({ start: groupStart, end: items.length, closed });
      groupStart = items.length;
    };
    content.querySelectorAll('img, video, hr').forEach((el) => {
      if (el.tagName === 'HR') return closeGroup(true);
      // An image that finished loading with no pixels is broken; keep its
      // placeholder icon out of the rows instead of giving it a 3:2 slot.
      const broken = el.tagName === 'IMG' && el.complete && !el.naturalWidth;
      el.classList.toggle('mg-broken', broken);
      if (!broken) items.push(el);
    });
    closeGroup(false);
    if (!items.length) return;

    // Fractional, not clientWidth: that is rounded, and rounding up by half
    // a pixel is enough to wrap the last item of a row.
    const width = content.getBoundingClientRect().width;
    if (!width) return;

    const gap = this.settings.gap;
    const targetH = this.settings.rowHeight;
    const maxH = this.settings.maxRowHeight || Infinity; // 0 = no limit

    // Aspect ratio (w/h) for each item: measured once loaded, remembered by
    // URL for next time, and 3:2 as a placeholder until either is available.
    const ars = items.map((el) => {
      const measured = measureAr(el);
      const src = el.currentSrc || el.src;
      if (measured) {
        if (src) this.rememberAr(src, measured);
        return measured;
      }
      return (src && this.arCache.get(src)) || 3 / 2;
    });

    for (const g of groups) {
      const rows = packRows(ars.slice(g.start, g.end), width, gap, targetH, g.closed);
      for (const row of rows) {
        // A full row taller than the limit is shrunk to it, so it no longer
        // fills the width; the margin after its last item then pads it to
        // the full width, so the next group still starts on a new line.
        const capped = row.full && row.height > maxH;
        const start = g.start + row.start;
        const end = g.start + row.end;
        if (capped) this.sizeRow(items, ars, start, end, maxH, false, true, width, gap);
        else this.sizeRow(items, ars, start, end, row.height, row.full, false, width, gap);
      }
    }
  }

  /* Write the sizes of items start..end-1, one row of `height`. Widths are
     snapped down to the 1/64 px grid Chromium lays out on, so a row's sum
     never exceeds the container and nothing wraps. In a full row the last
     item takes the remainder, so the row ends flush; in a padded row its
     right margin does. */
  sizeRow(items, ars, start, end, height, full, padded, width, gap) {
    let used = 0;
    for (let i = start; i < end; i++) {
      const last = i === end - 1;
      const w = full && last ? width - (end - start - 1) * gap - used : ars[i] * height;
      const snapped = Math.floor(w * 64) / 64;
      used += snapped;
      const margin = padded && last
        ? Math.max(0, Math.floor((width - (end - start - 1) * gap - used) * 64) / 64)
        : 0;
      const el = items[i];
      usedAr.set(el, ars[i]);
      // Only touch elements whose size actually changed, so a late image
      // load doesn't invalidate the style of every row above it.
      const size = height.toFixed(2) + 'px ' + snapped + 'px ' + margin + 'px';
      if (written.get(el) !== size) {
        written.set(el, size);
        el.style.height = height.toFixed(2) + 'px';
        el.style.width = snapped + 'px';
        if (margin) el.style.marginRight = margin + 'px';
        else el.style.removeProperty('margin-right');
      }
    }
  }
}

/* Pure justified packing. Given aspect ratios (w/h), the container width,
   the gap and the target row height, returns rows as { start, end, height,
   full } (end exclusive). A full row's height is chosen so its items' widths
   (ar × height) plus gaps fill the width exactly; the last, incomplete row
   (full: false) keeps the target height. Nothing is stretched, so nothing is
   cropped. A `closed` group (one followed by a *** separator) has no
   incomplete row: see packClosed. */
function packRows(ars, width, gap, targetH, closed = false) {
  if (closed) return packClosed(ars, width, gap, targetH);
  const rows = [];
  let start = 0;   // first item of the row being built
  let arSum = 0;   // sum of its aspect ratios so far

  for (let i = 0; i < ars.length; i++) {
    const n = i - start + 1; // items in the row if i joins it
    const withAr = arSum + ars[i];
    if (withAr * targetH + (n - 1) * gap < width) {
      arSum = withAr; // still fits at the target height
      continue;
    }

    // Item i overflows the target height. Either squeeze it into this row
    // (row gets shorter) or close the row before it (row gets taller): take
    // whichever height is closer to the target, in ratio terms so a 0.8×
    // squeeze and a 1.25× stretch count the same. A row keeps at least one
    // item, so a single panorama simply becomes a short row of its own.
    const hWith = (width - (n - 1) * gap) / withAr;
    const hWithout = n > 1 ? (width - (n - 2) * gap) / arSum : Infinity;
    const closer = (h) => Math.abs(Math.log(h / targetH));
    if (n > 1 && closer(hWithout) < closer(hWith)) {
      rows.push({ start, end: i, height: hWithout, full: true });
      start = i;
      arSum = ars[i];
      if (ars[i] * targetH >= width) { // too wide even on its own
        rows.push({ start, end: i + 1, height: width / ars[i], full: true });
        start = i + 1;
        arSum = 0;
      }
    } else {
      rows.push({ start, end: i + 1, height: hWith, full: true });
      start = i + 1;
      arSum = 0;
    }
  }
  if (start < ars.length) rows.push({ start, end: ars.length, height: targetH, full: false });
  return rows;
}

/* Packing for a group that a *** separator closes: every row is full, the
   last one included, so a short group becomes a single full-width row. Rows
   are chosen over the whole group (minimising the summed squared log ratio
   of each row's height to the target) rather than greedily, which would
   often leave the group's last image alone in a huge full-width row. */
function packClosed(ars, width, gap, targetH) {
  const n = ars.length;
  const cost = [0];  // cost[j]: best cost of packing items 0..j-1
  const from = [0];  // from[j]: where the last row of that packing starts
  for (let j = 1; j <= n; j++) {
    cost[j] = Infinity;
    let arSum = 0;
    for (let i = j - 1; i >= 0; i--) { // row i..j-1; taller rows first
      arSum += ars[i];
      const h = (width - (j - i - 1) * gap) / arSum;
      if (h <= 0) break;
      const c = cost[i] + Math.log(h / targetH) ** 2;
      if (c < cost[j]) {
        cost[j] = c;
        from[j] = i;
      }
      if (h < targetH / 4) break; // longer rows only get shorter
    }
  }
  const rows = [];
  for (let j = n; j > 0; j = from[j]) {
    const i = from[j];
    const height = (width - (j - i - 1) * gap) / ars.slice(i, j).reduce((a, b) => a + b, 0);
    rows.unshift({ start: i, end: j, height, full: true });
  }
  return rows;
}

class MediaGallerySettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const slider = (name, desc, key, min, max, step) => {
      new obsidian.Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addSlider((sl) =>
          sl
            .setLimits(min, max, step)
            .setValue(this.plugin.settings[key])
            .setDynamicTooltip()
            .onChange(async (v) => {
              this.plugin.settings[key] = v;
              await this.plugin.saveSettings();
            })
        );
    };

    new obsidian.Setting(containerEl)
      .setName('Ribbon button')
      .setDesc('Show a wrap-in-gallery button in the left ribbon.')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.showRibbon).onChange(async (v) => {
          this.plugin.settings.showRibbon = v;
          await this.plugin.saveSettings();
          this.plugin.applyRibbon();
        })
      );

    new obsidian.Setting(containerEl)
      .setName('Editor context menu')
      .setDesc('Show the gallery actions in the editor right-click menu.')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.showEditorMenu).onChange(async (v) => {
          this.plugin.settings.showEditorMenu = v;
          await this.plugin.saveSettings();
        })
      );

    slider('Row height (justified)', 'Target row height for [!gallery], in px.', 'rowHeight', 80, 500, 10);
    slider('Max row height (justified)', 'A group of images closed by a *** line ends with a full-width row, which can get very tall. Taller rows are shrunk to this height and no longer fill the width, in px. 0 = no limit.', 'maxRowHeight', 0, 1500, 50);
    slider('Columns (masonry)', 'Maximum number of columns for [!gallery-masonry].', 'columns', 1, 6, 1);
    slider('Min column width (masonry)', 'Narrow panes use fewer columns so each stays at least this wide, in px.', 'columnWidth', 80, 400, 10);
    slider('Gap', 'Gap between items, in px.', 'gap', 0, 60, 1);
    slider('Border radius', 'Corner radius of images and videos, in px.', 'radius', 0, 40, 1);
    slider('Gallery width', 'Width relative to the text column, in % (needs readable line width).', 'width', 100, 200, 5);
  }
}

module.exports = MediaGalleryPlugin;
// Pure helpers, exposed for the tests in test/.
module.exports.packRows = packRows;
module.exports.moveEmbed = moveEmbed;
module.exports.groupEmbeds = groupEmbeds;
module.exports.ungroupEmbeds = ungroupEmbeds;
module.exports.removeEmbeds = removeEmbeds;

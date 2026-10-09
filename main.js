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

const DEFAULT_SETTINGS = {
  rowHeight: 220,   // [!gallery] target row height (px)
  columns: 3,       // [!gallery-masonry] column count (maximum)
  columnWidth: 180, // [!gallery-masonry] minimum column width (px); narrow panes drop columns
  gap: 7,           // gap between items (px)
  radius: 6,        // corner radius (px)
  width: 140,       // gallery width relative to text column (%)
  showRibbon: true, // show the wrap button in the left ribbon
};

class MediaGalleryPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Sliders call saveSettings on every tick; write data.json once they settle.
    this.persistSettings = obsidian.debounce(() => this.saveData(this.settings), 500, true);
    // Aspect ratio by image URL. A note re-rendered or re-opened lays out
    // correctly on the first pass instead of jumping once the images load.
    this.arCache = new Map();

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

    this.ribbonEl = null;
    this.applyRibbon();

    this.registerMarkdownPostProcessor((el, ctx) => {
      const sel = '.callout[data-callout="gallery"]';
      const callouts = el.matches(sel) ? [el] : Array.from(el.querySelectorAll(sel));
      callouts.forEach((c) => this.setupJustified(c, ctx));
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
    this.persistSettings.run(); // flush a pending write
    this.removeCssVars();
  }

  saveSettings() {
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

  /* Wrap the selected lines (or the current line) in a gallery callout.
     If the selection already touches an existing gallery callout, the new
     lines are merged into it (just a "> " prefix) instead of being wrapped in
     a second, nested "> [!gallery]" — see extendGallery below. */
  wrapSelection(editor, type) {
    const isQuote = (n) => /^\s*>/.test(editor.getLine(n));
    const isGalleryHeader = (n) =>
      /^\s*>\s*\[!gallery(-masonry)?\]/i.test(editor.getLine(n));

    const hasSelection = editor.somethingSelected();
    const fromLine = hasSelection ? editor.getCursor('from').line : editor.getCursor().line;
    const toLine = hasSelection ? editor.getCursor('to').line : editor.getCursor().line;

    // Does any selected line already belong to an existing gallery callout?
    // (A quoted line whose contiguous blockquote block starts with a gallery
    // header.) If so, extend that gallery rather than nesting a new one.
    for (let n = fromLine; n <= toLine; n++) {
      if (!isQuote(n)) continue;
      let top = n;
      while (top > 0 && isQuote(top - 1)) top--;
      if (isGalleryHeader(top)) {
        this.extendGallery(editor, fromLine, toLine);
        return;
      }
    }

    // No gallery in range → create a fresh one.
    const raw = hasSelection
      ? editor.getSelection()
      : editor.getLine(editor.getCursor().line);

    const body = raw
      .replace(/\r/g, '')
      .split('\n')
      .map((line) => (line.trim().length ? '> ' + line : '>'))
      .join('\n');
    const out = `> [!${type}]\n${body}\n`;

    if (hasSelection) {
      editor.replaceSelection(out);
    } else {
      const line = editor.getCursor().line;
      editor.setLine(line, out.replace(/\n+$/, ''));
    }
  }

  /* Merge plain lines into an already-existing gallery: add "> " to the lines
     that aren't quoted yet and leave the existing gallery lines untouched.
     The gallery's type is kept as-is (defined by its existing header). */
  extendGallery(editor, fromLine, toLine) {
    const isQuote = (n) => /^\s*>/.test(editor.getLine(n));
    const out = [];
    for (let n = fromLine; n <= toLine; n++) {
      const line = editor.getLine(n);
      out.push(isQuote(n) ? line : line.trim().length ? '> ' + line : '>');
    }
    editor.replaceRange(
      out.join('\n'),
      { line: fromLine, ch: 0 },
      { line: toLine, ch: editor.getLine(toLine).length }
    );
  }

  /* Remove gallery-callout wrapping: drops the [!gallery] header and strips
     one level of "> " from each line. Uses the selection if present,
     otherwise the contiguous blockquote block around the cursor. */
  unwrapSelection(editor) {
    const isQuote = (n) => /^\s*>/.test(editor.getLine(n));
    let fromLine, toLine;

    if (editor.somethingSelected()) {
      fromLine = editor.getCursor('from').line;
      toLine = editor.getCursor('to').line;
    } else {
      const cur = editor.getCursor().line;
      if (!isQuote(cur)) {
        new obsidian.Notice('Metal Media Gallery: cursor is not inside a callout.');
        return;
      }
      const last = editor.lastLine();
      fromLine = cur;
      toLine = cur;
      while (fromLine > 0 && isQuote(fromLine - 1)) fromLine--;
      while (toLine < last && isQuote(toLine + 1)) toLine++;
    }

    const out = [];
    for (let n = fromLine; n <= toLine; n++) {
      const line = editor.getLine(n);
      if (/^\s*>\s*\[!gallery(-masonry)?\]/i.test(line)) continue; // drop header
      out.push(line.replace(/^(\s*)>\s?/, '$1'));                  // strip one "> "
    }

    editor.replaceRange(
      out.join('\n'),
      { line: fromLine, ch: 0 },
      { line: toLine, ch: editor.getLine(toLine).length }
    );
  }

  /* Wire up one justified gallery: mark it, then (re)layout on load & resize.
     The ResizeObserver is tied to a MarkdownRenderChild so Obsidian disconnects
     it when the rendered section is discarded; otherwise every re-render would
     leave an observer (and the whole old DOM it references) alive. */
  setupJustified(callout, ctx) {
    const content = callout.querySelector(':scope > .callout-content');
    if (!content || content.dataset.mgReady) return;
    content.dataset.mgReady = '1';

    const child = new obsidian.MarkdownRenderChild(callout);
    const imgs = Array.from(content.querySelectorAll('img, video'));

    // Batch the flood of per-image load events into one layout per frame.
    // A large gallery fires many load/loadedmetadata events in quick
    // succession, and running the full pack on each is O(n²). The initial
    // layout and resize layout stay synchronous so the gallery sizes
    // correctly on first paint even when images come from cache.
    let scheduled = false;
    const relayoutBatched = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        this.layout(content);
      });
    };

    imgs.forEach((img) => {
      if (img.tagName === 'IMG') {
        if (img.complete && img.naturalWidth) return;
        img.addEventListener('load', relayoutBatched);
        img.addEventListener('error', relayoutBatched);
      } else {
        img.addEventListener('loadedmetadata', relayoutBatched);
      }
    });

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
    ctx.addChild(child);

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

    // An image that finished loading with no pixels is broken; keep its
    // placeholder icon out of the rows instead of giving it a 3:2 slot.
    const items = Array.from(content.querySelectorAll('img, video')).filter((el) => {
      const broken = el.tagName === 'IMG' && el.complete && !el.naturalWidth;
      el.classList.toggle('mg-broken', broken);
      return !broken;
    });
    if (!items.length) return;

    // Fractional, not clientWidth: that is rounded, and rounding up by half
    // a pixel is enough to wrap the last item of a row.
    const width = content.getBoundingClientRect().width;
    if (!width) return;

    const gap = this.settings.gap;
    const targetH = this.settings.rowHeight;

    // Aspect ratio (w/h) for each item: measured once loaded, remembered by
    // URL for next time, and 3:2 as a placeholder until either is available.
    const ars = items.map((el) => {
      const w = el.naturalWidth || el.videoWidth || 0;
      const h = el.naturalHeight || el.videoHeight || 0;
      const src = el.currentSrc || el.src;
      if (h > 0) {
        if (src) this.rememberAr(src, w / h);
        return w / h;
      }
      return (src && this.arCache.get(src)) || 3 / 2;
    });

    for (const { start, end, height, full } of packRows(ars, width, gap, targetH)) {
      // Widths are snapped down to the 1/64 px grid Chromium lays out on, so
      // a row's sum never exceeds the container and nothing wraps. In a full
      // row the last item takes the remainder, so the row ends flush.
      let used = 0;
      for (let i = start; i < end; i++) {
        const w = full && i === end - 1
          ? width - (end - start - 1) * gap - used
          : ars[i] * height;
        const snapped = Math.floor(w * 64) / 64;
        used += snapped;
        items[i].style.height = height.toFixed(2) + 'px';
        items[i].style.width = snapped + 'px';
      }
    }
  }
}

/* Pure justified packing. Given aspect ratios (w/h), the container width,
   the gap and the target row height, returns rows as { start, end, height,
   full } (end exclusive). A full row's height is chosen so its items' widths
   (ar × height) plus gaps fill the width exactly; the last, incomplete row
   (full: false) keeps the target height. Nothing is stretched, so nothing is
   cropped. */
function packRows(ars, width, gap, targetH) {
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

    slider('Row height (justified)', 'Target row height for [!gallery], in px.', 'rowHeight', 80, 500, 10);
    slider('Columns (masonry)', 'Maximum number of columns for [!gallery-masonry].', 'columns', 1, 6, 1);
    slider('Min column width (masonry)', 'Narrow panes use fewer columns so each stays at least this wide, in px.', 'columnWidth', 80, 400, 10);
    slider('Gap', 'Gap between items, in px.', 'gap', 0, 60, 1);
    slider('Border radius', 'Corner radius of images and videos, in px.', 'radius', 0, 40, 1);
    slider('Gallery width', 'Width relative to the text column, in % (needs readable line width).', 'width', 100, 200, 5);
  }
}

module.exports = MediaGalleryPlugin;
module.exports.packRows = packRows; // exposed for test/pack.test.js

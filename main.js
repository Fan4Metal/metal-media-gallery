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

/* Markdown lines, for the editor commands: any blockquote line, the first
   line of a gallery callout, and a *** row separator inside one. */
const QUOTE = /^\s*>/;
const GALLERY_HEADER = /^\s*>\s*\[!gallery(-masonry)?\]/i;
const ROW_SEPARATOR = /^\s*>\s*\*\s*\*\s*\*[\s*]*$/;

/* A line moved into a callout; blank lines become a bare ">" so the
   blockquote stays one block. */
function quoteLine(line) {
  return line.trim().length ? '> ' + line : '>';
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
      find('.callout[data-callout="gallery"]').forEach((c) => this.setupJustified(c, ctx));
      // Masonry is laid out by CSS; it only shares the async decoding.
      find('.callout[data-callout="gallery-masonry"]').forEach((c) => this.setupMasonry(c, ctx));
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
    const { fromLine, toLine } = this.selectedLines(editor);
    const blocks = [];
    for (let n = fromLine; n <= toLine; n++) {
      if (!QUOTE.test(editor.getLine(n))) continue;
      const top = this.quoteTop(editor, n);
      const bottom = this.quoteBottom(editor, n);
      if (GALLERY_HEADER.test(editor.getLine(top))) blocks.push({ top, bottom });
      n = bottom;
    }
    if (!blocks.length) {
      new obsidian.Notice('Metal Media Gallery: no gallery callout at the cursor.');
      return;
    }

    // Bottom-up, so the line numbers of the blocks above stay valid.
    for (const { top, bottom } of blocks.reverse()) {
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

  /* Insert a "> ***" row separator after the cursor's line in a gallery.
     With a selection, separators go before and after the selected lines, so
     they become a group of their own (a short one is a single full-width
     row); none is added where a separator or the header already is. */
  insertSeparator(editor) {
    const { fromLine, toLine } = this.selectedLines(editor);
    const top = this.galleryTop(editor, fromLine);
    if (top < 0 || this.quoteBottom(editor, fromLine) < toLine) {
      new obsidian.Notice('Metal Media Gallery: put the cursor or selection inside a gallery callout.');
      return;
    }

    const sep = '> ***';
    const endOf = (n) => ({ line: n, ch: editor.getLine(n).length });
    if (!editor.somethingSelected()) {
      editor.replaceRange('\n' + sep, endOf(fromLine));
      editor.setCursor(endOf(fromLine + 1));
      return;
    }
    // The one after first, so fromLine stays valid for the one before.
    if (toLine === editor.lastLine() || !ROW_SEPARATOR.test(editor.getLine(toLine + 1))) {
      editor.replaceRange('\n' + sep, endOf(toLine));
    }
    if (fromLine > top + 1 && !ROW_SEPARATOR.test(editor.getLine(fromLine - 1))) {
      editor.replaceRange(sep + '\n', { line: fromLine, ch: 0 });
    }
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

  setupMasonry(callout, ctx) {
    const content = this.claimContent(callout);
    if (!content) return;
    const child = this.galleryChild(callout, ctx);
    this.watchAdded(child, content, () => decodeAsync(content));
    decodeAsync(content);
  }

  /* Wire up one justified gallery: (re)layout as media arrive and load, and
     on resize. */
  setupJustified(callout, ctx) {
    const content = this.claimContent(callout);
    if (!content) return;
    const child = this.galleryChild(callout, ctx);

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
module.exports.packRows = packRows; // exposed for test/pack.test.js

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
  columns: 3,       // [!gallery-masonry] column count
  gap: 7,           // gap between items (px)
  radius: 6,        // corner radius (px)
  width: 140,       // gallery width relative to text column (%)
  showRibbon: true, // show the wrap button in the left ribbon
};

class MediaGalleryPlugin extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.applyCssVars();
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

  /* Push settings to CSS custom properties consumed by styles.css */
  applyCssVars() {
    const s = this.settings;
    const root = document.body;
    root.style.setProperty('--mg-row-height', s.rowHeight + 'px');
    root.style.setProperty('--mg-columns', String(s.columns));
    root.style.setProperty('--mg-gap', s.gap + 'px');
    root.style.setProperty('--mg-radius', s.radius + 'px');
    root.style.setProperty('--mg-width', s.width + '%');
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyCssVars();
    // Re-layout every visible justified gallery so changes show immediately.
    document
      .querySelectorAll('.callout[data-callout="gallery"] > .callout-content')
      .forEach((content) => this.layout(content));
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
    content.classList.add('mg-justified');

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

  /* The justified algorithm: greedy row fill, then scale each row to width. */
  layout(content) {
    const items = Array.from(content.querySelectorAll('img, video'));
    if (!items.length) return;

    const width = content.clientWidth;
    if (!width) return;

    const gap = this.settings.gap;
    const targetH = this.settings.rowHeight;

    // Aspect ratio (w/h) for each item, with sane fallbacks while loading.
    const ars = items.map((el) => {
      const w = el.naturalWidth || el.videoWidth || 0;
      const h = el.naturalHeight || el.videoHeight || 0;
      return h > 0 ? w / h : 3 / 2;
    });

    let row = [];
    let rowArSum = 0;

    const flushRow = (isLast) => {
      if (!row.length) return;
      const gaps = (row.length - 1) * gap;
      // For a full row, scale height so widths fill the container exactly.
      // The last, incomplete row keeps the target height (left aligned).
      const h = isLast ? targetH : (width - gaps) / rowArSum;
      row.forEach(({ el, ar }) => {
        el.style.height = Math.round(h) + 'px';
        el.style.width = Math.floor(ar * h) + 'px';
      });
      row = [];
      rowArSum = 0;
    };

    for (let i = 0; i < items.length; i++) {
      row.push({ el: items[i], ar: ars[i] });
      rowArSum += ars[i];
      const gaps = (row.length - 1) * gap;
      const naturalRowWidth = rowArSum * targetH + gaps;
      if (naturalRowWidth >= width) flushRow(false);
    }
    flushRow(true); // leftover items
  }
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
    slider('Columns (masonry)', 'Number of columns for [!gallery-masonry].', 'columns', 1, 6, 1);
    slider('Gap', 'Gap between items, in px.', 'gap', 0, 60, 1);
    slider('Border radius', 'Corner radius of images and videos, in px.', 'radius', 0, 40, 1);
    slider('Gallery width', 'Width relative to the text column, in % (needs readable line width).', 'width', 100, 200, 5);
  }
}

module.exports = MediaGalleryPlugin;

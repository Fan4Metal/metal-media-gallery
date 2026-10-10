# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commits

In this project, append the `Co-Authored-By: Claude ...` trailer to commit messages
(overrides the global default of omitting it).

## What this is

An Obsidian plugin ("Metal Media Gallery") that renders `> [!gallery]` and `> [!gallery-masonry]`
callouts as image galleries in **reading view**, without cropping. Portrait and landscape
images sit side by side, each shown in full.

## No build step

The plugin ships as hand-written source — there is no bundler, transpiler, `package.json`,
`node_modules`, or linter. The three files in the repo root (`main.js`, `manifest.json`,
`styles.css`) are the deployable artifact as-is — they must stay in the root, because Obsidian
reads `manifest.json` from the repository root to publish and update the plugin. `main.js` is plain CommonJS
(`require('obsidian')` / `module.exports`), not TypeScript or ESM. Edit these files directly.

## Deploy / test loop

Rendering is verified by hand in Obsidian. The pure pieces — the row-packing function
`packRows` and `moveEmbed`, the source rewrite behind drag reordering — have a `node:test` suite (no dependencies; `main.js` is loaded with a stubbed
`obsidian` module):

```powershell
node --test
```

```powershell
./deploy.ps1                          # copy the plugin files into the local dev_vault and enable it
./deploy.ps1 -Watch                   # re-deploy on every file change
./deploy.ps1 -Vault "C:\Path\To\Vault"  # deploy to a different vault
```

`deploy.ps1` copies the three files into `<vault>/.obsidian/plugins/metal-media-gallery/` and adds
`metal-media-gallery` to `community-plugins.json`. After deploying, reload Obsidian
(`Ctrl+P → Reload app without saving`) to pick up changes.

`dev_vault/` is a local test vault and is **not committed** (see `.gitignore`). Its deployed
plugin copy under `.obsidian/plugins/metal-media-gallery/` is git-ignored — the sources of truth live
in the repo root, never edit the deployed copy.

## Architecture (three files, one flow)

The plugin's two gallery modes are handled by completely different mechanisms:

- **`[!gallery-masonry]` is pure CSS** — the CSS `columns` shorthand (min width + max count) in
  `styles.css`. JS only marks its images `decoding="async"`.
- **`[!gallery]` (justified) is computed in JS** — CSS alone can't fill rows edge-to-edge
  without cropping, so `main.js` sizes each image inline.

The justified pipeline (`main.js`):

1. `registerMarkdownPostProcessor` finds `.callout[data-callout="gallery"]` in each rendered
   block and calls `setupJustified`.
2. `setupJustified` marks the callout (`data-mgReady` guards against re-processing), then wires
   a `ResizeObserver` on the content, capture-phase `load` / `error` / `loadedmetadata`
   listeners on the content and a `MutationObserver` for added nodes, so `layout` re-runs on
   pane resize, as media dimensions become known, and as items appear — Obsidian inserts the
   `img` of a `![[embed]]` only after the post processors ran, so a gallery usually starts
   empty. Added items are laid out in the next animation frame (before they are painted).
   Load-driven re-layouts are coalesced into 100 ms windows and skipped when the measured
   ratio matches what the layout already assumed (from the per-URL cache); `layout` itself only
   rewrites the inline size of items whose size changed. Images get `decoding="async"`, and the
   stylesheet gives items `content-visibility: auto` so off-screen rows aren't painted/decoded.
3. `layout` reads each item's aspect ratio and the content's fractional width, calls `packRows`
   and writes inline sizes. `packRows` (pure, exported for the tests) adds items to a row until
   the next one overflows the target height, then either squeezes it in or closes the row before
   it — whichever row height is closer to the target. A full row's height makes widths (each
   `aspectRatio × height`) plus gaps fill the container exactly; the last, incomplete row keeps
   the target height. Widths are snapped down to 1/64 px (Chromium's layout grid) and the last
   item of a full row takes the remainder, so rows end flush and never wrap. Because width
   always equals `ar × height`, nothing is stretched or cropped.
4. A `> ***` line (`<hr>`, hidden by CSS) splits the items into groups that `layout` packs
   separately. A group closed by one has no incomplete row: `packRows(…, closed = true)` hands it
   to `packClosed`, a DP that picks the row breaks minimising Σ log²(height / target) with every
   row full. A full row taller than `maxRowHeight` (0 = no cap) is shrunk to it, and its last
   item's `margin-right` pads it to the width so the next group still starts a new line.
   (`---` can't be the separator: under a paragraph line it makes a setext heading.)

`styles.css` strips the callout chrome, flattens Obsidian's `<p>`/`<div>` wrappers with
`display: contents` (so each `img`/`video` is a direct flex/column child), and breaks the
gallery out wider than the text column via `--mg-width` (requires *Readable line length* on).

### Settings ↔ CSS bridge

Settings live in one `DEFAULT_SETTINGS` object, persisted via `loadData`/`saveData`. Most
settings (gap, radius, columns, column width, width) are pushed to `--mg-*` CSS custom properties on
`document.body` by `applyCssVars`; the CSS reads them with fallbacks. Only `rowHeight`, `maxRowHeight` and `gap`
also feed the JS `layout` directly. `saveSettings` re-applies the vars **and** re-runs `layout`
on every visible justified gallery so changes appear live. When adding a setting, update
`DEFAULT_SETTINGS`, `applyCssVars` (if CSS-driven), the settings tab in
`MediaGallerySettingTab.display`, and `styles.css`'s fallback.

### Editor commands

Five commands plus a ribbon menu wrap/unwrap the selection in a gallery callout
(`wrapSelection` / `unwrapSelection`), insert `> ***` row separators (`insertSeparator`) and
delete empty `>` lines (`compactGallery`). These operate on the **editor** (source mode); the
gallery rendering only happens in reading view. `withActiveEditor` bridges the ribbon button
(which has no editor context) to the active `MarkdownView`. The `editor-menu` handler adds the
same actions to the right-click menu, picked by whether the cursor is inside a gallery
(`galleryTop`).

### Drag reordering (reading view)

`setupReorder` listens for Ctrl/Cmd + pointerdown on a gallery's media; `dragItem` follows the
drag with window-level capture listeners (class `mg-dragging` on the image, body
`mg-reordering`, and an `.mg-drop-bar` — a `position: fixed` element on `<body>` placed from the
target's on-screen box, because anything drawn inside the gallery gets clipped at the row
edges by an ancestor), and the drop calls `moveItem`. That rewrites the note
through `Vault.process` (read/modify fallback before 1.1): it re-reads the section via
`ctx.getSectionInfo(sectionEl)` — so the post processor's `el` is passed down to the setup
functions — checks the file still matches what was rendered, matches DOM items to the gallery
block's embeds by order (and by link for internal embeds), and applies `moveEmbed`. Any
mismatch leaves the file untouched and shows a notice.

## Manifest / release

Bump `version` in `manifest.json` and add the same version to `versions.json` (version →
minimum Obsidian version) for releases, then run `./release.ps1`: it packs
`dist/metal-media-gallery.zip` (one `metal-media-gallery/` folder, `/`-separated entries) and prints the
`gh release create <version> …` command. The tag must equal the version, and the three loose
files go on the release next to the zip — Obsidian's installer downloads them individually.
`dist/` is git-ignored. `minAppVersion` is `1.0.0` and
`isDesktopOnly` is `false` (the plugin uses no desktop-only APIs).

## Docs

`README.md` (English) and `README.ru.md` (Russian) are user-facing and kept in sync — update
both when changing user-visible behavior, settings, or the deploy workflow.

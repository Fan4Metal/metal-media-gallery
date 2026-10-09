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
`node_modules`, tests, or linter. The three files in `plugin/` (`main.js`, `manifest.json`,
`styles.css`) are the deployable artifact as-is. `main.js` is plain CommonJS
(`require('obsidian')` / `module.exports`), not TypeScript or ESM. Edit these files directly.

## Deploy / test loop

There is no automated test suite; you verify by hand in Obsidian.

```powershell
./deploy.ps1                          # copy plugin/* into the local dev_vault and enable it
./deploy.ps1 -Watch                   # re-deploy on every file change
./deploy.ps1 -Vault "C:\Path\To\Vault"  # deploy to a different vault
```

`deploy.ps1` copies the three files into `<vault>/.obsidian/plugins/metal-media-gallery/` and adds
`metal-media-gallery` to `community-plugins.json`. After deploying, reload Obsidian
(`Ctrl+P → Reload app without saving`) to pick up changes.

`dev_vault/` is a local test vault and is **not committed** (see `.gitignore`). Its deployed
plugin copy under `.obsidian/plugins/metal-media-gallery/` is git-ignored — the sources of truth live
in `plugin/`, never edit the deployed copy.

## Architecture (three files, one flow)

The plugin's two gallery modes are handled by completely different mechanisms:

- **`[!gallery-masonry]` is pure CSS** — CSS `column-count` in `styles.css`. No JS involved.
- **`[!gallery]` (justified) is computed in JS** — CSS alone can't fill rows edge-to-edge
  without cropping, so `main.js` sizes each image inline.

The justified pipeline (`main.js`):

1. `registerMarkdownPostProcessor` finds `.callout[data-callout="gallery"]` in each rendered
   block and calls `setupJustified`.
2. `setupJustified` marks the callout (`data-mgReady` guards against re-processing), then wires
   a `ResizeObserver` on the content plus `load` / `loadedmetadata` listeners on each
   `img`/`video`, so `layout` re-runs on pane resize and as media dimensions become known.
3. `layout` is the core algorithm: greedily pack items into a row until their combined width at
   the target height would overflow, then scale that row's height so widths (each
   `aspectRatio × height`) fill the container exactly. The last, incomplete row keeps the target
   height. Because width always equals `ar × height`, nothing is stretched or cropped.

`styles.css` strips the callout chrome, flattens Obsidian's `<p>`/`<div>` wrappers with
`display: contents` (so each `img`/`video` is a direct flex/column child), and breaks the
gallery out wider than the text column via `--mg-width` (requires *Readable line length* on).

### Settings ↔ CSS bridge

Settings live in one `DEFAULT_SETTINGS` object, persisted via `loadData`/`saveData`. Most
settings (gap, radius, columns, width) are pushed to `--mg-*` CSS custom properties on
`document.body` by `applyCssVars`; the CSS reads them with fallbacks. Only `rowHeight` and `gap`
also feed the JS `layout` directly. `saveSettings` re-applies the vars **and** re-runs `layout`
on every visible justified gallery so changes appear live. When adding a setting, update
`DEFAULT_SETTINGS`, `applyCssVars` (if CSS-driven), the settings tab in
`MediaGallerySettingTab.display`, and `styles.css`'s fallback.

### Editor commands

Three commands plus a ribbon menu wrap/unwrap the selection in a gallery callout
(`wrapSelection` / `unwrapSelection`). These operate on the **editor** (source mode); the
gallery rendering only happens in reading view. `withActiveEditor` bridges the ribbon button
(which has no editor context) to the active `MarkdownView`.

## Manifest / release

Bump `version` in `plugin/manifest.json` for releases. `minAppVersion` is `1.0.0` and
`isDesktopOnly` is `false` (the plugin uses no desktop-only APIs).

## Docs

`README.md` (English) and `README.ru.md` (Russian) are user-facing and kept in sync — update
both when changing user-visible behavior, settings, or the deploy workflow.

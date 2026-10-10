# Metal Media Gallery

**English** · [Русский](README.ru.md)

An Obsidian plugin that turns callouts into image galleries in reading view — **without cropping**. Mixed portrait and landscape photos sit side by side, each shown in full.

![gallery](https://img.shields.io/badge/Obsidian-plugin-7c3aed) ![view](https://img.shields.io/badge/mode-reading%20view-blue)

![A justified gallery rendered in Obsidian's reading view](images/screenshot.png)

## Features

- **`[!gallery]` — justified rows.** Widths are computed in JavaScript proportionally to each image's aspect ratio, so every row fills the width edge-to-edge while nothing is stretched or cropped (like Google Photos / Flickr).
- **`[!gallery-masonry]` — masonry columns.** Pinterest-style columns; every image is shown in full at its natural height.
- **No cropping.** Portrait and landscape mix freely.
- **Reflows** on pane resize and as images load.
- **Wider than the text column** — the gallery breaks out beyond the readable line width (configurable).
- **Drag to reorder** — Ctrl/Cmd + drag an image in reading view to move it; the note's text is updated.
- **Select and group** — Alt + drag a box (or Alt + click) to select images, then put them in a row of their own with one click.
- **Lightbox-friendly** — pairs with the [Metal Image Viewer](https://github.com/Fan4Metal/metal-image-viewer) plugin for click-to-zoom.

## Usage

Wrap your embeds in a callout and drop images inside. Blank lines between images don't matter.

```markdown
> [!gallery]
> ![[photo-1.png]]
> ![[photo-2.png]]
> ![[photo-3.png]]
> ![[photo-4.png]]
```

Masonry variant:

```markdown
> [!gallery-masonry]
> ![[photo-1.png]]
> ![[photo-2.png]]
> ![[photo-3.png]]
```

### Keeping images on one row

In `[!gallery]`, a `***` line ends a group of images: the group is packed on its own and ends with a row that fills the full width, and the images after the line start a new row. Put `***` before and after a few images to show them side by side in one row:

```markdown
> [!gallery]
> ![[photo-1.png]]
> ![[photo-2.png]]
> ![[photo-3.png]]
> ***
> ![[portrait-1.png]]
> ![[portrait-2.png]]
> ***
> ![[photo-4.png]]
```

A short group (two to four images) becomes a single row; a longer one is split into several full rows. A full-width row of portraits can get tall — **Max row height** caps it. Use `***`, not `---`: right under an image line, `---` turns that line into a heading. Masonry galleries ignore the separator.

The **Insert row separator** command (also in the ribbon menu) adds `> ***` after the cursor's line (or turns the cursor's empty `>` line into it); with lines selected inside a gallery, it puts a separator before and after them, so the selection becomes a row of its own. **Remove row separators** takes them out again: the one on the cursor's line, those among the selected lines, or else all of the gallery's.

### Reordering images

In reading view, hold **Ctrl** (**Cmd** on macOS) and drag an image to another place in the same gallery — handy for grouping similar shots. A bar shows where it will land: left or right of the image under the pointer (above or below it in a masonry gallery, whose order runs down the columns). On release the embed is moved in the note's text and the gallery redraws; **Esc** cancels the drag. While dragging (or drawing a selection box), the mouse wheel scrolls the note, and so does moving the pointer to its top or bottom edge. An image alone on its line moves with its line; one that shares a line with others moves inline. Without Ctrl, clicks work as usual.

If the gallery can't be matched to the note's text — the note changed in the meantime, or the gallery shows images from an embedded note — nothing is changed and a notice explains why.

Lines placed right after a gallery without a `>` (and without a blank line in between) still belong to it in Markdown, so their images show in the gallery; reordering rewrites them with a `> ` prefix, which changes nothing visible. To keep images outside a gallery, leave a blank line after it.

### Selecting images and putting them in one row

In reading view, hold **Alt** (**Option** on macOS) and drag a box over a gallery: every image it touches is selected (outlined). **Shift + Alt** + drag adds to the selection, and **Alt + click** adds or removes a single image, so scattered images can be picked too. A small toolbar appears above the selection:

- **One row** gathers the selected images where the first of them is, one per line, between `***` separators — they become a group of their own, usually a single full-width row (see [Keeping images on one row](#keeping-images-on-one-row)). Images that were elsewhere move next to the first one.
- **Ungroup** removes the `***` separators around the groups the selected images are in, returning them to the automatic flow.
- **✕** (or **Esc**, or a click anywhere else) clears the selection.

> **Tip:** for a single image, just embed it normally (outside a callout) — galleries are for groups.

### Quick-wrap command

Instead of typing the callout by hand, select the image lines and run a command:

- **Metal Media Gallery: Wrap selection in gallery callout**
- **Metal Media Gallery: Wrap selection in masonry gallery callout**
- **Metal Media Gallery: Remove gallery callout wrapping**
- **Metal Media Gallery: Insert row separator (\*\*\*) in gallery** — see [Keeping images on one row](#keeping-images-on-one-row)
- **Metal Media Gallery: Remove empty lines in gallery** — deletes the empty `>` lines from the gallery at the cursor (or every gallery the selection touches)
- **Metal Media Gallery: Remove row separators (\*\*\*) in gallery**

Open the command palette (`Ctrl/Cmd+P`) and run one, or assign a hotkey in **Settings → Hotkeys**. Each selected line gets a `> ` prefix and a `> [!gallery]` header is added on top. With no selection, it wraps the current line. Commands always act on whole lines, even if the selection starts or ends mid-line.

> **Adding to an existing gallery.** If the selection includes lines that already belong to a gallery, or sits right above or below one, the new lines are merged into it (they just get a `> ` prefix) — no second header is added, so you never get a nested gallery. The header stays on the first line, and the type is taken from it. A selection spanning two galleries merges them into one. A fresh `> [!gallery]` is only created when the selection does *not* touch another gallery.

**Unwrap** removes the `[!gallery]` header and strips one level of `> ` from the whole gallery (row separators are dropped too) — place the cursor anywhere inside it, or select lines to unwrap every gallery they touch. Other callouts and quotes are left alone.

There is also a **ribbon button** (left sidebar, grid icon): select your image lines, click it, and pick *Justified*, *Masonry*, *Row separator*, *Remove empty lines*, *Remove row separators*, or *Remove gallery*. Toggle it off in **Settings → Metal Media Gallery → Ribbon button**.

The same actions are in the editor's **right-click menu**: *Wrap in gallery* / *Wrap in masonry gallery* outside a gallery, *Insert row separator* / *Remove empty lines in gallery* / *Remove row separators* / *Remove gallery* inside one. Toggle them off in **Settings → Metal Media Gallery → Editor context menu**.

## Settings

Open **Settings → Metal Media Gallery**:

| Setting | What it does | Default |
| --- | --- | --- |
| Row height (justified) | Target row height for `[!gallery]` | 220 px |
| Max row height (justified) | Caps full rows, such as a group closed by `***`; a capped row no longer fills the width. 0 = no limit | 0 |
| Columns (masonry) | Maximum column count for `[!gallery-masonry]` | 3 |
| Min column width (masonry) | Narrow panes and phones use fewer columns so each stays at least this wide | 180 px |
| Gap | Space between items | 7 px |
| Border radius | Corner radius of images/videos | 6 px |
| Gallery width | Width relative to the text column (needs *Readable line length* on) | 140% |

## How the justified layout works

Images are grouped into rows: items are added until the next one would overflow the container at the target height. That item is then either squeezed into the row or starts the next one, whichever leaves the row height closer to the target. Each full row is scaled so its widths — each proportional to the image's aspect ratio — fill the row exactly. Because width equals `aspectRatio × height`, every image keeps its true proportions: no cropping. The last, incomplete row keeps the target height and is left-aligned. A `***` line splits the images into groups packed separately; a group it closes has no incomplete row — its rows are chosen together so that all of them, the last included, fill the width with heights as close to the target as possible. Aspect ratios are remembered per image, so a note you return to lays out correctly before its images have reloaded.

## Requirements

- Works in **reading view**.
- **Gallery width > 100%** requires *Settings → Editor → Readable line length* to be enabled.

## Installation

The plugin is not in the community store yet, so install it manually:

1. Download `metal-media-gallery.zip` from the [latest release](https://github.com/Fan4Metal/metal-media-gallery/releases/latest) and unzip it into `<your-vault>/.obsidian/plugins/`. This gives you the folder `<your-vault>/.obsidian/plugins/metal-media-gallery/` with the three plugin files.
   *Alternatively*, create that folder yourself and copy `manifest.json`, `main.js` and `styles.css` into it (from the release or from the root of this repository).
2. In Obsidian, open **Settings → Community plugins**. If *Restricted mode* is on, turn it off.
3. Click **Reload plugins** (or restart Obsidian), then find **Metal Media Gallery** in the list and enable it.
4. *(Recommended)* Enable **Settings → Editor → Readable line length** so galleries can be wider than the text column.

> **Note:** `.obsidian` is a hidden folder. Enable "show hidden files" in your file manager, or open it via **Settings → About → Open vault folder** in Obsidian, then navigate into `.obsidian/plugins`.

## Development

The plugin sources (`manifest.json`, `main.js`, `styles.css`) live in the repository root. A local `dev_vault/` (not committed) is used for testing.

```powershell
# copies the plugin files into dev_vault and enables it
./deploy.ps1

# re-deploy automatically on every change
./deploy.ps1 -Watch

# deploy to another vault
./deploy.ps1 -Vault "C:\Path\To\Vault"
```

After deploying, reload Obsidian (`Ctrl+P → Reload app without saving`) and enable **Metal Media Gallery** under *Settings → Community plugins*.

The row-packing algorithm has a small dependency-free test suite: `node --test`.

### Release

```powershell
# packs dist/metal-media-gallery.zip (a ready-to-unzip plugin folder)
./release.ps1
```

Bump `version` in `manifest.json` and add it to `versions.json` first. The script prints the `gh release create` command; the release tag must equal the version, and the three loose files are attached alongside the zip because Obsidian's installer downloads them individually.

## Project layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | Plugin manifest |
| `versions.json` | Plugin version → minimum Obsidian version |
| `main.js` | Post-processor + justified layout algorithm |
| `styles.css` | Callout chrome, width breakout, masonry |
| `deploy.ps1` | Copies the plugin into a vault; `-Watch` mode |
| `release.ps1` | Packs `dist/metal-media-gallery.zip` for a release |
| `test/pack.test.js` | Tests for the row-packing algorithm (`node --test`) |

## License

[MIT](LICENSE)

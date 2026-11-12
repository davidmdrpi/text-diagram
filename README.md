# text-diagram

Text diagram editor for markdown documents: type [ditaa](https://ditaa.sourceforge.net/)-style
ASCII diagrams and see them rendered live as SVG, entirely in the browser.

## Usage

Open `index.html` in a browser (no build step, no server). Type or paste ASCII in the left pane;
the right pane renders it. Click a box (in the text or the preview) to select it, then:

| Action | Buttons | Keys |
| --- | --- | --- |
| Move box (attached wires stretch) | Shift Box ← ↑ ↓ → | `Alt+Arrows` |
| Resize box | Size Box ±W ±H | `Alt+Shift+Arrows` |
| Toggle shape / color tag | `{s}` `{d}` `cBLU` … | |
| Undo / redo | ↶ ↷ | `Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) |

Stamp buttons chain: `+Box+` → `──>` → `+Box+` places each new box on the arrow tip.

Exports: SVG, 2× PNG, and **Export Strict Backend ditaa**, which rewrites the extended syntax
below into plain ditaa that the Java renderer accepts.

## Syntax

Standard ditaa, plus a few extensions:

- **Boxes**: `+--+` corners, `/--\` and `\--/` rounded corners; `=` or `:` in a wall, or `{*}`, makes it dashed.
- **Shapes**: `{s}` storage, `{d}` document, `{io}` parallelogram, `{mo}` trapezoid, `{o}` pill.
- **Colors**: `cBLU cGRE cYEL cRED cPNK cBLK`, `c#RRGGBB`, ditaa-style `cRGB` (uppercase hex).
- **Wires**: `-` `|` solid, `=` `:` dashed, spaced `= = = >` dashed, `*` junction dot, `< > ^ v` arrowheads.
- **Inline border arrows** (extension): an arrowhead can sit directly on a box wall, e.g. `+---^---+`, saving a row.
- **Nested boxes**: a box containing other boxes is a container; its text and wires render normally.
- **Legend macros** (extension): a small box labelled `[D]` expands to the text defined by a legend line:

  ```
  # [D] = Diagram Engine
  ```

  Other lines starting with `#` are comments and are not drawn.

## Layout

```
index.html         UI shell (Tailwind via CDN)
src/engine.js      parser, SVG renderer, legacy exporter, 2D grid editor (no DOM; runs in Node)
src/app.js         UI controller and preset diagrams
test/              node:test suite for the engine
```

## Development

```bash
npm test
```

Requires Node 18+. No dependencies.

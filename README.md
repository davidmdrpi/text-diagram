# text-diagram

Text diagram editor for markdown documents: type [ditaa](https://ditaa.sourceforge.net/)-style
ASCII diagrams and see them rendered live as SVG, entirely in the browser.

## Quick start

Download **[text-diagram.html](https://github.com/davidmdrpi/text-diagram/raw/main/text-diagram.html)**
and open it in any browser. It is a single self-contained file: no install, no server, no other
files, and it works offline.

## Usage

Type or paste ASCII in the left pane;
the right pane renders it. Click a box (in the text or the preview) to select it, then:

| Action | Buttons | Keys |
| --- | --- | --- |
| Move box (attached wires stretch) | Shift Box ← ↑ ↓ → | `Alt+Arrows` |
| Resize box | Size Box ±W ±H | `Alt+Shift+Arrows` |
| Toggle shape / color tag | `{c}` `{s}` `{d}` `cBLU` … | |
| Undo / redo | ↶ ↷ | `Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) |

Stamp buttons chain: `+Box+` → `──>` → `+Box+` places each new box on the arrow tip.

Exports: SVG, 2× PNG, and **Export Strict Backend ditaa**, which rewrites the extended syntax
below into plain ditaa that the Java renderer accepts.

## Syntax

Standard ditaa, plus a few extensions:

- **Boxes**: `+--+` corners, `/--\` and `\--/` rounded corners; `=` or `:` in a wall, or `{*}`, makes it dashed.
- **Shapes**: `{c}` decision diamond, `{s}` storage, `{d}` document, `{io}` parallelogram, `{mo}` trapezoid, `{o}` pill.
- **Decision diamonds** (`{c}`, as in ditaa 0.9+, PlantUML and Asciidoctor Diagram): draw an ordinary box with
  `{c}` inside. Put `+` ports at the centre of each wall and they become the diamond's four vertices, so
  flowchart branches attach there; a wire hitting the wall anywhere else ends on the slanted edge. Give the
  box an odd width and height so the centres fall on a character (the `<Diamond?>` stamp does this, and
  resizing a diamond grows or shrinks it by 2 to keep it that way):

  ```
         +-------+-------+
         |               |    no
  ------>+  Valid? {c}   +------->
         |               |
         +-------+-------+
                 | yes
                 v
  ```
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
text-diagram.html  single-file build for end users (generated, committed)
index.html         UI shell for development (Tailwind via CDN)
src/engine.js      parser, SVG renderer, legacy exporter, 2D grid editor (no DOM; runs in Node)
src/app.js         UI controller and preset diagrams
build.js           inlines src/ and compiled Tailwind CSS into text-diagram.html
test/              node:test suite
```

## Development

Edit `index.html` and `src/`, open `index.html` to try changes, then rebuild the single file:

```bash
npm install
npm run build
npm test
```

The tests fail if `text-diagram.html` is out of date with the sources, so always rebuild and
commit it with your changes. Requires Node 18+; the only (dev) dependency is Tailwind CSS.

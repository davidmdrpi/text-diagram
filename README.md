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

**Typing inside a box grows it** (the *Auto-fit boxes* checkbox, on by default), the way
inserting text naturally pushes the rest of a line along:

- When text would reach the right wall, the box widens on its own lines only. Arrows and boxes
  beside it move over to make room (a box beside it moves as a whole); lines above and below
  are untouched. A vertical wire hanging off something that moved is re-joined with a small
  jog (`+--+`), which straightens again if the box shrinks back.
- Enter inside a box adds a line to it, pushing the lines below down, like a new line in a text
  editor.
- Diamonds grow around their centre so the wires on their top and bottom points stay attached
  (a lead-in wire on the left gets one character shorter).
- Backspace and Delete edit within the box and join lines; pasted text with line breaks becomes
  multiple lines. An edit that would break another box is refused with a message. Typing
  outside boxes is ordinary text editing, so you can always adjust anything by hand.

The Size Box ±W buttons follow the same rule (only the box's own lines shift).

**Right-click** in the editor for connected shapes:

- On a box's wall (or just outside it): add a **Box**, **Rounded box**, **Diamond `{c}`** or
  **Arrow only** on that side, joined by an arrow from a `+` port in the middle of the wall. On a
  corner you get both sides; inside the box, all four. The new shape's placeholder label is
  selected, so just type its name.
- Right and below draw into empty space; if something is there, room is made the same way typing
  does (things beside move over / the lines below move down), and if an arrow already continues
  that way the new shape is spliced into it.
- Left and above only use empty space (at the top/left edge of the diagram, blank rows/columns are
  added). If something is in the way you'll be told how to make room: press Enter above the box,
  or type spaces before it.
- On empty space: insert a shape right there.
- Cut / Copy / Paste are in the menu too; Shift+right-click opens the browser's own menu.

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

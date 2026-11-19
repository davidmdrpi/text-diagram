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
| Move box | ← ↑ ↓ → | `Alt+Arrows` |
| Resize box | +W −W +H −H | `Alt+Shift+Arrows` |
| Toggle shape / color tag | `{c}` `{s}` `{d}` `cBLU` … | |
| Undo / redo | ↶ ↷ | `Ctrl+Z` / `Ctrl+Y` (`Ctrl+Shift+Z`) |

**Typing inside a box grows it** (the *Fit* checkbox in the toolbar, on by default), the way
inserting text naturally pushes the rest of a line along:

- When text would reach the right wall, the box widens on its own lines only. Arrows and boxes
  beside it move over to make room (a box beside it moves as a whole); lines above and below
  are untouched. Lines above and below are not re-routed: if one no longer meets what moved,
  fix it by hand or redraw it with a connection.
- Enter inside a box (or the +H button) adds a line to that box only: boxes beside it keep
  their size, the space and vertical wires around them stretch, and a horizontal arrow to a
  box beside it stays attached (that box moves down with the arrow if the arrow moves).
  What is below moves down, like a new line in a text editor.
- Diamonds grow around their centre so the wires on their top and bottom points stay attached
  (a lead-in wire on the left gets one character shorter).
- Backspace and Delete edit within the box and join lines; pasted text with line breaks becomes
  multiple lines. Text lives between the walls, and the box keeps one space before its right
  wall; an edit in a wall's own column (typing or Delete right before a wall, Backspace right
  after one) is editing the drawing, so it is plain text editing. Typing is never blocked: if
  a box can't grow safely, the keystroke simply goes in as plain text. Typing outside boxes is
  ordinary text editing, so you can always adjust anything by hand. (Toolbar and right-click
  actions that would break another box are refused with a red message instead.)

The +W / −W buttons follow the same rule (only the box's own lines shift).

**Boxes inside boxes** grow into the empty space inside the box around them (typing, Enter,
+W/+H): the outer box never resizes on its own. If there isn't enough room you're told so;
make the outer box bigger first.

**Insert / overwrite** (the `INS` / `OVR` button at the bottom right, or the Insert key): in
overwrite mode typing replaces the character under the caret (shown as a highlighted cell),
Backspace and Delete blank characters instead of pulling text along, a click puts the caret on
the cell clicked (even past the end of a line), and paste writes over the text at the caret.
Nothing is auto-fitted in overwrite mode, even with *Fit* on: Enter is a plain line break and
typing over a selection is plain replacement.

**Block selection** is on by default (`▭ Block` at the bottom right): a drag selects a
rectangle, not runs of lines. Shift+Arrows grow a rectangle from the caret (Shift+Down from a
caret selects a column), Shift+Home / Shift+End reach the diagram's left and right edges, and
Shift+click extends. Alt+drag selects lines the usual way (with block mode off it's the other
way round). Right-click also offers *Select box*, *Select row* and *Select column*.

A block that spans the diagram's full width is **whole rows**; one that spans its full height
(the legend lines below don't count) is **whole columns**. That makes room while keeping
everything joined up: copy a row that vertical lines run through and paste it, and every one of
them gets a line longer; copy a column that the arrows cross and paste it, and they all stretch.

| | Insert mode | Overwrite mode |
| --- | --- | --- |
| Ctrl+C | copies the block | copies the block |
| Ctrl+X / Delete | removes it: rows are deleted, columns and rectangles pull the text to their right over | blanks it |
| Ctrl+V of copied rows | inserts them above the caret's line | writes them over the lines from the caret's line |
| Ctrl+V of copied columns | inserts them before the caret's column, on every diagram line | writes them over the columns from the caret's column |
| Ctrl+V of a copied rectangle | inserts it as columns at the caret, on consecutive lines | writes it over the text at the caret |
| Ctrl+V with a block selected | replaces the block | replaces the block |

Any other key or a click drops the block selection. Ordinary text from elsewhere pastes as
usual in insert mode.

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

**Connections** (right-click → *Start connection here*, on a box's wall, on a line or in empty space):

1. On a wall a `+` port goes where you clicked; on a line or empty space nothing changes yet.
2. Click (or right-click → *Connect to here*) where it should end: another box's wall (or just
   next to it, or inside the box), a line, or empty space. While a start is pending the
   right-click menu offers only that and *Cancel connection* (Esc also cancels); a click on
   text, or a route that can't be found, cancels it with a message.

Ends on a line join it: continuing from a line's end keeps it straight (so you can mend a gap
in a line, or extend one after deleting what it pointed to), and meeting a line from the side
makes a `+`. An arrowhead goes on the end only when it ends on a wall or in empty space. To
leave a lone connection point on a wall, just type a `+`.

The line is routed with horizontal and vertical segments, leaving and entering the walls at right
angles, around boxes and text. Where it has to cross a container's wall, or another line, the
crossing becomes a `+`. If the exact end cell can't be reached cleanly, the nearest cell on the
same wall that can is used. Two toolbar toggles set the style for every connection: solid `──` or
dashed `┄┄`, and arrowhead `─▸` or plain line.

Every toolbar button explains itself on hover. Stamp buttons chain: `+Box+` → `──>` → `+Box+` places each new box on the arrow tip.

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

`test/ui.test.js` also drives `text-diagram.html` in a headless Chromium (right-click
mapping, inserts, paste) when Playwright is installed, and is skipped otherwise.

The tests fail if `text-diagram.html` is out of date with the sources, so always rebuild and
commit it with your changes. Requires Node 18+; the only (dev) dependency is Tailwind CSS.

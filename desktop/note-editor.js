// The note editor: the phone's NoteMarkupField for a computer. The markers
// stay hidden while writing, the words show bold, italic, headings, bullets,
// checklist boxes and tables as they will on the phone, and the toolbar and
// the table bar do what the phone's do, with the same rules (note-markup.js).
//
// What is stored, the note with its "**" and "- [ ] ", is the truth; the page
// shows layout() of it. Every keystroke is caught before the browser applies
// it, turned into an edit of the stored text at the stored selection, and the
// note drawn again with the caret put back through the layout's maps. That is
// how the phone's text field works too: its selection lives in the stored
// text, so typing at the end of a bold word stays bold.
//
// It is only DOM: the page hands it the note and is told when to save.

import * as markup from "./note-markup.js?v=76";

const ZWSP = "\u200b";
const BOX_LENGTH = 3;

// --- edits of the stored text --------------------------------------------------------
//
// Each takes the stored text and offsets in it and returns an edit,
// { text, selectionStart, selectionEnd }, the way note-markup.js does.

const edit = (text, selectionStart, selectionEnd = selectionStart) => ({ text, selectionStart, selectionEnd });

/**
 * The bold, italic and strike wraps in [source] with where their markers sit,
 * read off the layout so they are exactly the ones the phone draws:
 * [{ open, contentStart, contentEnd, closeEnd, empty }].
 */
export function wrapsOf(source, l = markup.layout(source)) {
  const wraps = [];
  for (const s of l.spans) {
    if (s.heading || !(s.bold || s.italic || s.strike)) continue;
    const length = s.italic ? 1 : 2;
    const first = l.displayToOriginal[s.start];
    // An empty wrap shows a zero-width space where its words would go.
    const empty = s.end - s.start === 1 && l.display[s.start] === ZWSP && source[first] !== ZWSP;
    const contentStart = first;
    const contentEnd = empty ? first : l.displayToOriginal[s.end - 1] + 1;
    wraps.push({ open: contentStart - length, contentStart, contentEnd, closeEnd: contentEnd + length, empty });
  }
  return wraps;
}

/**
 * [source] without [start, end). A wrap that only half falls in the range
 * keeps its markers, so taking the end off a bold word leaves the rest bold
 * rather than a stray "**"; a wrap wholly inside goes with its words.
 */
export function deleteRange(source, start, end) {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(source.length, Math.max(start, end));
  if (lo >= hi) return edit(source, lo);
  const keep = new Set();
  for (const w of wrapsOf(source)) {
    if (w.open >= lo && w.closeEnd <= hi) continue;
    for (let i = w.open; i < w.contentStart; i++) if (i >= lo && i < hi) keep.add(i);
    for (let i = w.contentEnd; i < w.closeEnd; i++) if (i >= lo && i < hi) keep.add(i);
  }
  let kept = "";
  for (let i = lo; i < hi; i++) if (keep.has(i)) kept += source[i];
  return edit(source.slice(0, lo) + kept + source.slice(hi), lo);
}

/** [text] typed over [start, end). */
export function insertText(source, start, end, text) {
  const cleared = start === end ? edit(source, snapCaret(source, start)) : deleteRange(source, start, end);
  const at = cleared.selectionStart;
  const caret = at + text.length;
  return edit(cleared.text.slice(0, at) + text + cleared.text.slice(at), caret);
}

/** Enter: a line break, then the list carried on or ended the phone's way (afterNewline). */
export function insertNewline(source, start, end) {
  const typed = insertText(source, start, end, "\n");
  return markup.afterNewline(typed.text, typed.selectionStart - 1);
}

function stripLinePrefix(source, lineStart, prefix) {
  return edit(source.slice(0, lineStart) + source.slice(lineStart + prefix.markerLength), lineStart);
}

// The caret in an empty wrap ("****" after a Bold with nothing typed): a
// delete either way takes the wrap, there being nothing else in it.
function emptyWrapAround(source, l, p) {
  return wrapsOf(source, l).find((w) => w.empty && p > w.open && p < w.closeEnd) ?? null;
}

function emptyWrapAt(source, l, displayIndex) {
  return wrapsOf(source, l).find((w) => w.empty && l.originalToDisplay[w.contentStart] === displayIndex) ?? null;
}

/**
 * Backspace with the caret at [caret]. At the start of a list item or a
 * heading's words it takes the bullet, number, box or # off, as a list
 * does; otherwise it takes the character shown before the caret.
 */
export function deleteBackward(source, caret) {
  const p = snapCaret(source, caret);
  const lineStart = markup.lineStartOf(source, p);
  const prefix = markup.parsePrefix(source.slice(lineStart, markup.lineEndOf(source, lineStart)));
  const l = markup.layout(source);
  // At the words' start as shown: past a "**" that opens them counts too.
  const wordsStart = lineStart + prefix.markerLength;
  if (prefix.kind !== "none" && p >= wordsStart && l.originalToDisplay[p] === l.originalToDisplay[wordsStart]) {
    return stripLinePrefix(source, lineStart, prefix);
  }
  const inside = emptyWrapAround(source, l, p);
  if (inside) return edit(source.slice(0, inside.open) + source.slice(inside.closeEnd), inside.open);
  let k = l.originalToDisplay[p] - 1;
  // A heading's empty slot is no character to take.
  while (k >= 0 && l.display[k] === ZWSP && !emptyWrapAt(source, l, k)) k--;
  if (k < 0) return edit(source, p);
  const wrap = emptyWrapAt(source, l, k);
  if (wrap) return edit(source.slice(0, wrap.open) + source.slice(wrap.closeEnd), wrap.open);
  if (isLowSurrogate(l.display[k]) && k > 0 && isHighSurrogate(l.display[k - 1])) k--;
  const from = l.displayToOriginal[k];
  return deleteRange(source, from, Math.max(p, from + 1));
}

/** Delete with the caret at [caret]: the character shown after it, or a line's bullet or box whole. */
export function deleteForward(source, caret) {
  const p = snapCaret(source, caret);
  const lineStart = markup.lineStartOf(source, p);
  const prefix = markup.parsePrefix(source.slice(lineStart, markup.lineEndOf(source, lineStart)));
  if ((prefix.kind === "bullet" || prefix.kind === "checklist") && p === lineStart) return stripLinePrefix(source, lineStart, prefix);
  const l = markup.layout(source);
  const inside = emptyWrapAround(source, l, p);
  if (inside) return edit(source.slice(0, inside.open) + source.slice(inside.closeEnd), inside.open);
  let k = l.originalToDisplay[p];
  while (k < l.display.length && l.display[k] === ZWSP && !emptyWrapAt(source, l, k)) k++;
  if (k >= l.display.length) return edit(source, p);
  const wrap = emptyWrapAt(source, l, k);
  if (wrap) return edit(source.slice(0, wrap.open) + source.slice(wrap.closeEnd), wrap.open);
  if (l.display[k] === "\n") {
    // Joining the next line on: its bullet or # would only be characters now.
    const nl = l.displayToOriginal[k];
    const next = markup.parsePrefix(source.slice(nl + 1, markup.lineEndOf(source, nl + 1)));
    return edit(source.slice(0, nl) + source.slice(nl + 1 + next.markerLength), p);
  }
  const step = isHighSurrogate(l.display[k]) && isLowSurrogate(l.display[k + 1]) ? 2 : 1;
  const to = k + step < l.displayToOriginal.length ? l.displayToOriginal[k + step] : source.length;
  const result = deleteRange(source, p, Math.max(to, p + 1));
  return edit(result.text, p);
}

const isHighSurrogate = (ch) => ch != null && ch >= "\ud800" && ch <= "\udbff";
const isLowSurrogate = (ch) => ch != null && ch >= "\udc00" && ch <= "\udfff";

/**
 * [caret] moved out of a line's marker ("- ", "- [ ] ", "# ") to where its
 * words start: typed inside one, a letter would undo the bullet or box. A
 * number is shown as typed, so a caret may sit in it.
 */
export function snapCaret(source, caret) {
  const p = Math.max(0, Math.min(caret, source.length));
  const lineStart = markup.lineStartOf(source, p);
  const prefix = markup.parsePrefix(source.slice(lineStart, markup.lineEndOf(source, lineStart)));
  const marked = prefix.kind === "bullet" || prefix.kind === "checklist" || prefix.kind === "heading";
  return marked && p > lineStart && p < lineStart + prefix.markerLength ? lineStart + prefix.markerLength : p;
}

/**
 * A caret the person put at [caret]: as snapCaret, and one in front of a
 * bullet or box, where nothing can be typed, goes to the item's words.
 */
export function caretAt(source, caret) {
  const p = snapCaret(source, caret);
  const lineStart = markup.lineStartOf(source, p);
  const prefix = markup.parsePrefix(source.slice(lineStart, markup.lineEndOf(source, lineStart)));
  return (prefix.kind === "bullet" || prefix.kind === "checklist") && p === lineStart ? lineStart + prefix.markerLength : p;
}

/** Where the shown text [before] became [after]: { from, to, text }, in [before]'s offsets. */
export function displayChange(before, after) {
  let a = 0;
  while (a < before.length && a < after.length && before[a] === after[a]) a++;
  let b = 0;
  while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++;
  return { from: a, to: before.length - b, text: after.slice(a, after.length - b) };
}

/**
 * Typing is gathered up so undo steps back a burst rather than a letter;
 * anything bigger than one character stands alone. NoteEditHistory on the
 * phone, the same 800 ms and 80 steps.
 */
export class NoteEditHistory {
  static COALESCE_MS = 800;
  static MAX_STEPS = 80;

  constructor() {
    this.undoSteps = [];
    this.redoSteps = [];
    this.lastRecordAt = 0;
  }

  get canUndo() {
    return this.undoSteps.length > 0;
  }

  get canRedo() {
    return this.redoSteps.length > 0;
  }

  /** Notes [previous] as a step back before [next], unless it joins the last one. */
  record(previous, next, now = Date.now()) {
    if (previous.text === next.text) return false;
    const coalesce = this.undoSteps.length > 0 && now - this.lastRecordAt < NoteEditHistory.COALESCE_MS &&
      Math.abs(next.text.length - previous.text.length) <= 1;
    this.lastRecordAt = now;
    this.redoSteps = [];
    if (coalesce) return false;
    this.undoSteps.push(previous);
    while (this.undoSteps.length > NoteEditHistory.MAX_STEPS) this.undoSteps.shift();
    return true;
  }

  undo(current) {
    const previous = this.undoSteps.pop();
    if (!previous) return null;
    this.redoSteps.push(current);
    this.lastRecordAt = 0;
    return previous;
  }

  redo(current) {
    const next = this.redoSteps.pop();
    if (!next) return null;
    this.undoSteps.push(current);
    this.lastRecordAt = 0;
    return next;
  }
}

/** The style pieces of [display]: [{ from, to, classes, box }], a box being a checklist line's. */
export function pieces(l, boxAt = new Set()) {
  const cuts = new Set([0, l.display.length]);
  for (const s of l.spans) cuts.add(s.start).add(s.end);
  for (const at of boxAt) cuts.add(at).add(at + BOX_LENGTH);
  const points = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [from, to] = [points[k], points[k + 1]];
    if (boxAt.has(from)) {
      out.push({ from, to: from + BOX_LENGTH, classes: [], box: true });
      continue;
    }
    const on = l.spans.filter((s) => s.start <= from && to <= s.end);
    const level = on.find((s) => s.heading)?.heading;
    const classes = [
      on.some((s) => s.bold) && "nm-b",
      on.some((s) => s.italic) && "nm-i",
      on.some((s) => s.strike) && "nm-s",
      level && `nm-h${level}`,
    ].filter(Boolean);
    out.push({ from, to, classes, box: false });
  }
  return out;
}

// --- the editor ------------------------------------------------------------------------

const BOX_SVG = {
  true: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="var(--accent-ink, #fff)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  false: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
};

/**
 * An editor for [text]. Options: icon(name, size) for the toolbar's icons,
 * mac for the key names, placeholder, and what to do on onSave (Ctrl or
 * Cmd+Enter), onCancel (Esc) and onLeave (focus gone elsewhere on the page).
 * Returns { element, value(), focus() }.
 */
export function noteEditor(text, { icon, mac = false, placeholder = "", onSave, onCancel, onLeave }) {
  let source = text;
  let sel = { start: source.length, end: source.length };
  const history = new NoteEditHistory();
  // Which box has the caret: "t:<block>", "after" (the line after a closing
  // table) or "c:<table>:<row>:<col>".
  let focusKey = null;
  let surfaces = [];
  let shape = "";
  let rendering = false;
  let composing = null;
  const listening = new AbortController();
  const mod = mac ? "⌘" : "Ctrl";

  const root = document.createElement("div");
  root.className = "note-editor";
  const toolbar = document.createElement("div");
  toolbar.className = "ne-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Formatting");
  const body = document.createElement("div");
  body.className = "ne-body";
  root.append(toolbar, body);

  // --- toolbar ---

  const tools = {};
  const tool = (name, label, iconName, run, key, ariaKey) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ne-tool";
    b.tabIndex = -1;
    b.setAttribute("aria-label", label);
    if (iconName) b.append(icon(iconName, 18));
    else {
      b.textContent = "H";
      b.classList.add("ne-heading");
    }
    if (key) {
      b.dataset.tip = label;
      b.dataset.key = key;
      b.setAttribute("aria-keyshortcuts", ariaKey);
    } else {
      b.title = label;
    }
    b.addEventListener("click", run);
    tools[name] = b;
    return b;
  };
  const gap = () => {
    const s = document.createElement("span");
    s.className = "ne-sep";
    return s;
  };
  const ariaMod = mac ? "Meta" : "Control";
  const toggle = (fn, ...rest) => () => toggleAt(fn, ...rest);
  toolbar.append(
    tool("undo", "Undo", "undo", () => undo(), `${mod}+Z`, `${ariaMod}+Z`),
    tool("redo", "Redo", "redo", () => redo(), mac ? `${mod}+Shift+Z` : `${mod}+Y`, mac ? `${ariaMod}+Shift+Z` : `${ariaMod}+Y`),
    gap(),
    tool("bold", "Bold", "bold", toggle(markup.toggleBold), `${mod}+B`, `${ariaMod}+B`),
    tool("italic", "Italic", "italic", toggle(markup.toggleItalic), `${mod}+I`, `${ariaMod}+I`),
    tool("strike", "Strikethrough", "strike", toggle(markup.toggleStrike), `${mod}+Shift+X`, `${ariaMod}+Shift+X`),
    gap(),
    tool("heading", "Heading", null, toggle(markup.toggleHeading, 1)),
    tool("bullet", "Bulleted list", "bulletList", toggle(markup.toggleBullet), `${mod}+Shift+8`, `${ariaMod}+Shift+8`),
    tool("ordered", "Numbered list", "numberList", toggle(markup.toggleOrdered), `${mod}+Shift+7`, `${ariaMod}+Shift+7`),
    tool("checklist", "Checklist", "checklist", toggle(markup.toggleChecklist), `${mod}+Shift+9`, `${ariaMod}+Shift+9`),
    tool("table", "Table", "table", toggle(markup.toggleTable)),
  );

  function updateToolbar() {
    const [s, e] = [sel.start, sel.end];
    const on = {
      bold: markup.hasBold(source, s, e),
      italic: markup.hasItalic(source, s, e),
      strike: markup.hasStrike(source, s, e),
      heading: markup.hasHeading(source, s, e, 1),
      bullet: markup.hasBullet(source, s, e),
      ordered: markup.hasOrdered(source, s, e),
      checklist: markup.hasChecklist(source, s, e),
      table: markup.hasTable(source, s, e),
    };
    for (const [name, pressed] of Object.entries(on)) tools[name].setAttribute("aria-pressed", String(pressed));
    tools.undo.disabled = !history.canUndo;
    tools.redo.disabled = !history.canRedo;
  }

  // --- changing the note ---

  /** Takes [next] as the note, remembering the step for undo, and draws it. */
  function apply(next, { record = true } = {}) {
    if (record) history.record({ text: source, selectionStart: sel.start, selectionEnd: sel.end }, next);
    source = next.text;
    sel = { start: next.selectionStart, end: next.selectionEnd };
    render(true);
  }

  /**
   * A toolbar or key toggle at the selection. On the empty line after a
   * closing table the line is made first, or the toggle would land in the
   * table's last row.
   */
  function toggleAt(fn, ...rest) {
    syncCaret();
    if (focusKey === "after" && source && !current()?.local) {
      const text = source + "\n";
      apply(fn(text, text.length, text.length, ...rest));
      return;
    }
    apply(fn(source, sel.start, sel.end, ...rest));
  }

  function undo() {
    const back = history.undo({ text: source, selectionStart: sel.start, selectionEnd: sel.end });
    if (back) apply(back, { record: false });
  }

  function redo() {
    const forward = history.redo({ text: source, selectionStart: sel.start, selectionEnd: sel.end });
    if (forward) apply(forward, { record: false });
  }

  // --- the boxes that take typing ---
  //
  // A run of lines is one editable box; each table cell is another, as on
  // the phone. A box edits its own words ("local"), and commit() puts the
  // result back into the note.

  function textSurface(key, block, last, after) {
    const base = after ? source.length : block.start;
    let local = after ? "" : source.slice(block.start, block.end);
    // Lines before a table end in the break the table starts on.
    const trimBreak = !after && !last && local.endsWith("\n");
    if (trimBreak) local = local.slice(0, -1);
    // The line after a closing table starts with the break that ends it.
    const lead = after && source ? "\n" : "";
    return {
      key,
      kind: "text",
      base,
      local,
      contains: (p) => (after ? p === source.length : p >= base && p <= base + local.length),
      toLocal: (p) => p - base,
      commit(next) {
        const stored = after ? (next.text ? lead + next.text : "") : trimBreak && next.text ? next.text + "\n" : next.text;
        const end = after ? source.length : block.end;
        const shift = base + (next.text ? lead.length : 0);
        apply(edit(source.slice(0, base) + stored + source.slice(end), shift + next.selectionStart, shift + next.selectionEnd));
      },
    };
  }

  function cellSurface(key, table, row, col, columns) {
    // A short row has no cell here yet; writing in it makes one.
    const cell = table.rows[row][col] ?? null;
    return {
      key,
      kind: "cell",
      table,
      row,
      col,
      base: cell?.start ?? null,
      local: cell?.text ?? "",
      contains: (p) => cell != null && p >= cell.start && p <= cell.end,
      toLocal: (p) => (cell ? p - cell.start : 0),
      commit(next) {
        const rows = table.rows.map((r, ri) => Array.from({ length: columns }, (_, ci) =>
          (ri === row && ci === col ? next.text : r[ci]?.text ?? "")));
        apply(markup.replaceTable(source, table, rows, row, col,
          Math.min(next.selectionStart, next.text.length), Math.min(next.selectionEnd, next.text.length)));
      },
    };
  }

  function surfaceAt(p) {
    const current = surfaces.find((s) => s.key === focusKey);
    if (current?.contains(p)) return current;
    return surfaces.find((s) => s.kind === "cell" && s.contains(p)) ?? surfaces.find((s) => s.contains(p)) ?? surfaces[0];
  }

  function localSel(s) {
    const len = s.local.length;
    const clamp = (p) => Math.max(0, Math.min(len, s.toLocal(p)));
    return { start: clamp(sel.start), end: clamp(sel.end) };
  }

  // --- drawing ---

  function render(keepFocus) {
    rendering = true;
    try {
      const blocks = markup.parseBlocks(source);
      const next = [];
      blocks.forEach((b, i) => {
        if (b.type === "text") next.push(textSurface(`t:${i}`, b, i === blocks.length - 1, false));
        else {
          const columns = Math.max(1, ...b.rows.map((r) => r.length));
          b.rows.forEach((_, r) => {
            for (let c = 0; c < columns; c++) next.push(cellSurface(`c:${i}:${r}:${c}`, b, r, c, columns));
          });
        }
      });
      // Somewhere to write after a closing table, and in an empty note.
      if (!blocks.length || blocks[blocks.length - 1].type === "table") next.push(textSurface("after", null, true, true));
      const hadFocus = keepFocus || root.contains(document.activeElement);
      const target = surfaceFor(next);
      focusKey = target.key;
      const nextShape = blocks.map((b) => (b.type === "text" ? "t" : `x${b.rows.length}:${Math.max(...b.rows.map((r) => r.length))}`)).join(",") +
        (next[next.length - 1].key === "after" ? "+" : "");
      if (nextShape === shape) {
        // Same boxes: fill them again where they are, so the one being typed in keeps focus.
        next.forEach((s, i) => {
          s.el = surfaces[i].el;
          s.wrap = surfaces[i].wrap;
          fill(s);
        });
        surfaces = next;
      } else {
        surfaces = next;
        shape = nextShape;
        build(blocks);
      }
      drawTableBars();
      if (hadFocus) placeCaret(target);
      updateToolbar();
    } finally {
      rendering = false;
    }
  }

  /** The box the caret belongs in among [list]. */
  function surfaceFor(list) {
    const fits = (s) => s.contains(sel.start);
    return list.find((s) => s.key === focusKey && fits(s)) ?? list.find((s) => s.kind === "cell" && fits(s)) ??
      list.find(fits) ?? list[0];
  }

  function build(blocks) {
    body.replaceChildren();
    let i = 0;
    blocks.forEach((b, bi) => {
      if (b.type === "text") {
        body.append(editable(surfaces[i++]));
        return;
      }
      const columns = Math.max(1, ...b.rows.map((r) => r.length));
      // The table scrolls in its box; its bar sits under it, outside, so its menus are not cut off.
      const block = document.createElement("div");
      block.className = "ne-table";
      block.dataset.table = String(bi);
      const wrap = document.createElement("div");
      wrap.className = "nm-table-wrap";
      const table = document.createElement("table");
      table.className = "nm-table";
      const label = (t) => {
        const th = document.createElement("th");
        th.dataset.label = t;
        return th;
      };
      const head = document.createElement("tr");
      head.append(label(""), ...Array.from({ length: columns }, (_, c) => label(markup.TableMath.columnName(c))));
      const thead = document.createElement("thead");
      thead.append(head);
      const tbody = document.createElement("tbody");
      b.rows.forEach((_, r) => {
        const tr = document.createElement("tr");
        tr.append(label(String(r + 1)));
        for (let c = 0; c < columns; c++) {
          const s = surfaces[i++];
          const td = document.createElement("td");
          s.wrap = td;
          td.append(editable(s));
          tr.append(td);
        }
        tbody.append(tr);
      });
      table.append(thead, tbody);
      const bar = document.createElement("div");
      bar.className = "ne-table-bar";
      bar.hidden = true;
      wrap.append(table);
      block.append(wrap, bar);
      body.append(block);
    });
    while (i < surfaces.length) body.append(editable(surfaces[i++]));
  }

  function editable(s) {
    const div = document.createElement("div");
    div.className = s.kind === "cell" ? "ne-surface nm-cell ne-cell" : "ne-surface ne-text";
    try {
      div.contentEditable = "plaintext-only";
    } catch {
      div.contentEditable = "true";
    }
    if (div.contentEditable !== "plaintext-only") div.contentEditable = "true";
    div.spellcheck = true;
    div.setAttribute("role", "textbox");
    if (s.kind === "cell") div.setAttribute("aria-label", `Cell ${markup.TableMath.columnName(s.col)}${s.row + 1}`);
    else {
      div.setAttribute("aria-multiline", "true");
      div.setAttribute("aria-label", "Note");
    }
    s.el = div;
    fill(s);
    return div;
  }

  /** Draws [s]'s words with their markup, or a sum's result while its cell is not being written in. */
  function fill(s) {
    const el = s.el;
    el.dataset.surface = s.key;
    el.classList.toggle("ne-empty", surfaces.length <= 1 && !s.local);
    if (placeholder) el.dataset.placeholder = placeholder;
    const results = s.kind === "cell" && markup.TableMath.isFormula(s.local) && focusKey !== s.key
      ? markup.TableMath.evaluate(s.table.rows.map((r) => r.map((c) => c.text)))[s.row][s.col]
      : null;
    if (s.wrap) {
      s.wrap.className = results != null ? "num sum"
        : s.local.trim().toLowerCase() === "total" ? "total"
        : markup.TableMath.isNumber(s.local) ? "num" : "";
    }
    if (results != null) {
      // Shown, not written: the cell's words come back when it is clicked.
      s.layout = null;
      s.display = results;
      el.replaceChildren(results);
      return;
    }
    const l = markup.layout(s.local);
    s.layout = l;
    s.display = l.display;
    const boxes = s.kind === "text" ? markup.checklistBoxes(s.local) : [];
    const boxAt = new Map(boxes.map((b) => [b.displayIndex, b]));
    const nodes = [];
    for (const piece of pieces(l, new Set(boxAt.keys()))) {
      const words = l.display.slice(piece.from, piece.to);
      if (piece.box) {
        nodes.push(boxNode(s, boxAt.get(piece.from), words));
      } else if (piece.classes.length) {
        const span = document.createElement("span");
        span.className = piece.classes.join(" ");
        span.textContent = words;
        nodes.push(span);
      } else {
        nodes.push(document.createTextNode(words));
      }
    }
    // A last empty line needs something to stand on.
    nodes.push(document.createElement("br"));
    el.replaceChildren(...nodes);
  }

  function boxNode(s, box, words) {
    const b = document.createElement("span");
    b.className = "ne-box note-tick";
    b.contentEditable = "false";
    b.dataset.len = String(BOX_LENGTH);
    b.dataset.text = words;
    b.setAttribute("role", "checkbox");
    b.setAttribute("aria-checked", String(box.checked));
    b.setAttribute("aria-label", box.checked ? "Untick" : "Tick");
    b.innerHTML = BOX_SVG[box.checked];
    b.addEventListener("mousedown", (event) => event.preventDefault());
    b.addEventListener("click", (event) => {
      event.preventDefault();
      // The box flips; the caret stays where it was, as "- [ ] " and "- [x] " are the same length.
      const flipped = markup.toggleChecked(source, s.base + box.lineStart);
      apply(edit(flipped.text, sel.start, sel.end));
    });
    return b;
  }

  // --- the table bar, under a table while one of its cells has the caret ---

  function drawTableBars() {
    const s = surfaces.find((x) => x.key === focusKey);
    for (const bar of body.querySelectorAll(".ne-table-bar")) {
      const show = s?.kind === "cell" && bar.parentElement.dataset.table === focusKey.split(":")[1];
      bar.hidden = !show;
      if (show && !bar.firstChild) fillTableBar(bar);
    }
  }

  function fillTableBar(bar) {
    const cell = () => surfaces.find((x) => x.key === focusKey && x.kind === "cell");
    const act = (fn) => () => {
      const s = cell();
      if (!s) return;
      apply(fn(source, s));
    };
    const button = (label, iconName, run) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ne-bar-button";
      b.tabIndex = -1;
      b.append(icon(iconName, 16), label);
      b.addEventListener("click", run);
      return b;
    };
    const menu = (label, iconName, items) => {
      const holder = document.createElement("span");
      holder.className = "ne-menu-holder";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ne-tool";
      b.tabIndex = -1;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-haspopup", "menu");
      b.append(icon(iconName, 18));
      const list = document.createElement("div");
      list.className = "ne-menu";
      list.setAttribute("role", "menu");
      list.hidden = true;
      for (const item of items) {
        if (!item) {
          const sep = document.createElement("div");
          sep.className = "menu-sep";
          list.append(sep);
          continue;
        }
        const it = document.createElement("button");
        it.type = "button";
        it.className = "menu-item";
        it.tabIndex = -1;
        it.setAttribute("role", "menuitem");
        const words = document.createElement("span");
        words.textContent = typeof item.label === "function" ? item.label() : item.label;
        it.append(icon(item.icon, 16), words);
        it.addEventListener("click", () => {
          list.hidden = true;
          item.run();
        });
        it.refresh = () => (words.textContent = typeof item.label === "function" ? item.label() : item.label);
        list.append(it);
      }
      b.addEventListener("click", () => {
        const opening = list.hidden;
        closeMenus();
        if (opening) {
          for (const it of list.querySelectorAll(".menu-item")) it.refresh?.();
          list.hidden = false;
        }
      });
      holder.append(b, list);
      return holder;
    };
    const rows = (s) => s.table.rows.length;
    const columns = (s) => Math.max(...s.table.rows.map((r) => r.length));
    const spacer = document.createElement("span");
    spacer.className = "ne-bar-space";
    bar.append(
      button("Row", "plus", act((text, s) => markup.addTableRow(text, s.table, s.row, s.col))),
      button("Column", "plus", act((text, s) => markup.addTableColumn(text, s.table, s.col, s.row))),
      spacer,
      menu("Totals", "sum", [
        { label: "Total this row", icon: "tableRows", run: act((text, s) => markup.totalRow(text, s.table, s.row, s.col)) },
        { label: "Total this column", icon: "tableColumns", run: act((text, s) => markup.totalColumn(text, s.table, s.col, s.row)) },
        null,
        { label: "Total all rows", icon: "tableRows", run: act((text, s) => markup.totalAllRows(text, s.table, s.row, s.col)) },
        { label: "Total all columns", icon: "tableColumns", run: act((text, s) => markup.totalAllColumns(text, s.table, s.row, s.col)) },
      ]),
      menu("More table options", "more", [
        { label: "Row above", icon: "plus", run: act((text, s) => markup.addTableRow(text, s.table, s.row - 1, s.col)) },
        { label: "Column left", icon: "plus", run: act((text, s) => markup.addTableColumn(text, s.table, s.col - 1, s.row)) },
        { label: () => (rows(cell()) > 1 ? "Delete row" : "Delete table"), icon: "trash", run: act((text, s) => markup.deleteTableRow(text, s.table, s.row, s.col)) },
        { label: () => (columns(cell()) > 1 ? "Delete column" : "Delete table"), icon: "trash", run: act((text, s) => markup.deleteTableColumn(text, s.table, s.col, s.row)) },
      ]),
    );
  }

  function closeMenus() {
    let closed = false;
    for (const m of root.querySelectorAll(".ne-menu:not([hidden])")) {
      m.hidden = true;
      closed = true;
    }
    return closed;
  }

  // --- the caret, between the page's selection and the note's ---

  /** Puts the browser's caret where [sel] is, in [s]. */
  function placeCaret(s) {
    const { start, end } = localSel(s);
    const toDisplay = (p) => (s.layout ? s.layout.originalToDisplay[p] : s.display.length);
    const a = domPoint(s.el, toDisplay(start));
    const b = domPoint(s.el, toDisplay(end));
    if (document.activeElement !== s.el) s.el.focus({ preventScroll: false });
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    s.shown = { start: toDisplay(start), end: toDisplay(end) };
  }

  /** The note's selection taken from the browser's, when the person moved it. */
  function readCaret() {
    const selection = getSelection();
    if (!selection.rangeCount) return;
    const s = surfaces.find((x) => x.el.contains(selection.anchorNode));
    if (!s || !s.el.contains(selection.focusNode)) return;
    const a = displayOffset(s.el, selection.anchorNode, selection.anchorOffset);
    const b = displayOffset(s.el, selection.focusNode, selection.focusOffset);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (focusKey !== s.key) {
      const before = focusKey;
      focusKey = s.key;
      if (s.kind === "cell" || before?.startsWith("c:")) refocusCells(before);
    }
    // Where the caret already is, as the page put it: the note's selection
    // stays, so a caret parked after a closed wrap is not pulled back into it.
    if (s.shown && s.shown.start === lo && s.shown.end === hi && s.contains(sel.start)) {
      updateToolbar();
      return;
    }
    if (s.base == null) return;
    const toLocal = (d) => {
      if (!s.layout) return s.local.length;
      const p = s.layout.displayToOriginal[Math.min(d, s.layout.displayToOriginal.length - 1)];
      return snapCaret(s.local, p < 0 ? 0 : p);
    };
    const start = lo === hi ? caretAt(s.local, toLocal(lo)) : toLocal(lo);
    const end = lo === hi ? start : toLocal(hi);
    sel = { start: s.base + start, end: s.base + end };
    s.shown = { start: lo, end: hi };
    drawTableBars();
    updateToolbar();
  }

  // A sum shows its result until its cell is written in, then its formula.
  function refocusCells(before) {
    for (const s of surfaces) {
      if (s.kind !== "cell" || !markup.TableMath.isFormula(s.local)) continue;
      if (s.key !== before && s.key !== focusKey) continue;
      rendering = true;
      try {
        fill(s);
        if (s.key === focusKey) {
          // Clicked on a result: the caret goes after the formula, as on the phone.
          if (s.base != null && !s.contains(sel.start)) sel = { start: s.base + s.local.length, end: s.base + s.local.length };
          placeCaret(s);
        }
      } finally {
        rendering = false;
      }
    }
  }

  // --- typing ---

  const current = () => surfaces.find((s) => s.key === focusKey) ?? null;

  // The page says the caret moved only a moment later (selectionchange is
  // queued), so a key that follows an arrow at once would land where the
  // caret was; every edit reads it first.
  function syncCaret() {
    if (!rendering && !composing && root.contains(document.activeElement)) readCaret();
  }

  /** Runs [fn] on the focused box's words at its selection and puts the result back. */
  function editLocal(fn) {
    syncCaret();
    const s = current();
    if (!s) return;
    const { start, end } = localSel(s);
    const next = fn(s.local, start, end, s);
    if (next) s.commit(next);
  }

  function rangeOfTarget(s, event) {
    const r = event.getTargetRanges?.()[0];
    if (!r || !s.layout) return null;
    const a = displayOffset(s.el, r.startContainer, r.startOffset);
    const b = displayOffset(s.el, r.endContainer, r.endOffset);
    const d2o = s.layout.displayToOriginal;
    return { start: Math.max(0, d2o[Math.min(a, b)]), end: Math.max(0, d2o[Math.max(a, b)]) };
  }

  body.addEventListener("beforeinput", (event) => {
    if (event.isComposing || event.inputType === "insertCompositionText" || event.inputType === "deleteCompositionText") return;
    syncCaret();
    const s = current();
    if (!s) return;
    event.preventDefault();
    closeMenus();
    const type = event.inputType;
    const words = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
    if (type === "insertText" || type === "insertReplacementText" || type === "insertFromYank") {
      const target = type === "insertReplacementText" ? rangeOfTarget(s, event) : null;
      editLocal((local, start, end) => (target
        ? insertText(local, target.start, target.end, words)
        : insertText(local, start, end, words)));
    } else if (type === "insertParagraph" || type === "insertLineBreak") {
      if (s.kind === "cell") nextCell(s, true);
      else editLocal((local, start, end) => insertNewline(local, start, end));
    } else if (type === "insertFromPaste" || type === "insertFromDrop") {
      pasteText(words);
    } else if (type === "deleteContentBackward" || type === "deleteContentForward") {
      editLocal((local, start, end) => (start !== end ? deleteRange(local, start, end)
        : type === "deleteContentBackward" ? deleteBackward(local, start) : deleteForward(local, start)));
    } else if (type.startsWith("delete")) {
      editLocal((local, start, end) => {
        if (start !== end) return deleteRange(local, start, end);
        const target = rangeOfTarget(s, event);
        if (!target) return null;
        return type.includes("Backward") ? deleteRange(local, target.start, start) : deleteRange(local, start, Math.max(start, target.end));
      });
    } else if (type === "historyUndo") {
      undo();
    } else if (type === "historyRedo") {
      redo();
    } else if (type === "formatBold") {
      toggleAt(markup.toggleBold);
    } else if (type === "formatItalic") {
      toggleAt(markup.toggleItalic);
    } else if (type === "formatStrikeThrough") {
      toggleAt(markup.toggleStrike);
    }
  });

  function pasteText(raw) {
    const words = raw.replace(/\r\n?/g, "\n");
    if (!words) return;
    editLocal((local, start, end) => insertText(local, start, end, words));
  }

  // The browser writes a composition (an accent, a CJK word) itself; when it
  // is done, what it wrote is read back and made an edit of the note.
  body.addEventListener("compositionstart", () => {
    syncCaret();
    const s = current();
    composing = s ? { key: s.key, display: s.display, sel: localSel(s) } : null;
  });
  body.addEventListener("compositionend", () => setTimeout(() => {
    const was = composing;
    composing = null;
    if (was) reconcile(was);
  }));
  // Anything else the browser wrote by itself (it should not) is taken in the same way.
  body.addEventListener("input", (event) => {
    if (composing || event.isComposing) return;
    const s = current();
    if (s) reconcile({ key: s.key, display: s.display, sel: localSel(s) });
  });

  function reconcile(was) {
    const s = surfaces.find((x) => x.key === was.key);
    if (!s) return;
    const now = domText(s.el);
    if (now === was.display) return;
    const change = displayChange(was.display, now);
    const words = change.text.replaceAll(ZWSP, "");
    if (!s.layout) {
      s.commit(edit(words, words.length));
      return;
    }
    const d2o = s.layout.displayToOriginal;
    const o2d = s.layout.originalToDisplay;
    // Written where the caret was: kept at the caret's place in the note, so
    // a word composed at the end of a bold one is bold too.
    const atCaret = change.from === change.to && o2d[was.sel.end] === change.from;
    const from = atCaret ? was.sel.end : Math.max(0, d2o[change.from]);
    const to = atCaret ? was.sel.end : Math.max(0, d2o[change.to]);
    s.commit(insertText(s.local, from, to, words));
  }

  body.addEventListener("copy", (event) => copyOut(event, false));
  body.addEventListener("cut", (event) => copyOut(event, true));

  // Copying takes the note's own characters, markers and all, as the phone
  // does, so pasting them back keeps the bold.
  function copyOut(event, cut) {
    syncCaret();
    const s = current();
    if (!s) return;
    const { start, end } = localSel(s);
    if (start === end) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", s.local.slice(start, end));
    if (cut) editLocal((local, a, b) => deleteRange(local, a, b));
  }

  body.addEventListener("paste", (event) => {
    event.preventDefault();
    pasteText(event.clipboardData?.getData("text/plain") ?? "");
  });

  body.addEventListener("dragstart", (event) => event.preventDefault());
  body.addEventListener("dragover", (event) => event.preventDefault());
  body.addEventListener("drop", (event) => {
    event.preventDefault();
    const words = event.dataTransfer?.getData("text/plain") ?? "";
    const point = document.caretPositionFromPoint?.(event.clientX, event.clientY) ??
      (() => {
        const r = document.caretRangeFromPoint?.(event.clientX, event.clientY);
        return r ? { offsetNode: r.startContainer, offset: r.startOffset } : null;
      })();
    const s = point && surfaces.find((x) => x.el.contains(point.offsetNode));
    if (s && s.layout && s.base != null) {
      focusKey = s.key;
      const d = displayOffset(s.el, point.offsetNode, point.offset);
      const p = snapCaret(s.local, Math.max(0, s.layout.displayToOriginal[d]));
      sel = { start: s.base + p, end: s.base + p };
      rendering = true;
      try {
        placeCaret(s);
      } finally {
        rendering = false;
      }
    }
    pasteText(words);
  });

  // --- keys ---

  root.addEventListener("keydown", (event) => {
    const command = mac ? event.metaKey : event.ctrlKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!closeMenus()) onCancel?.();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (command && !event.altKey) {
      const run = {
        b: !event.shiftKey && (() => toggleAt(markup.toggleBold)),
        i: !event.shiftKey && (() => toggleAt(markup.toggleItalic)),
        x: event.shiftKey && (() => toggleAt(markup.toggleStrike)),
        z: () => (event.shiftKey ? redo() : undo()),
        y: !mac && !event.shiftKey && (() => redo()),
      }[key] || {
        Digit8: event.shiftKey && (() => toggleAt(markup.toggleBullet)),
        Digit7: event.shiftKey && (() => toggleAt(markup.toggleOrdered)),
        Digit9: event.shiftKey && (() => toggleAt(markup.toggleChecklist)),
      }[event.code];
      if (run) {
        event.preventDefault();
        run();
      }
      return;
    }
    syncCaret();
    const s = current();
    if (!s || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab" && s.kind === "cell") {
      event.preventDefault();
      if (event.shiftKey) previousCell(s);
      else nextCell(s, false);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || event.shiftKey) return;
    // Arrows at a box's edge go on to the next box: a cell's neighbour, or the lines around a table.
    const { start, end } = localSel(s);
    if (start !== end) return;
    const atStart = start === 0 || (s.layout && s.layout.originalToDisplay[start] === 0);
    const atEnd = start === s.local.length;
    let to = null;
    if (s.kind === "cell") {
      const columns = Math.max(...s.table.rows.map((r) => r.length));
      if (event.key === "ArrowUp") to = cellKey(s, s.row - 1, s.col) ?? neighbour(s, -1);
      if (event.key === "ArrowDown") to = cellKey(s, s.row + 1, s.col) ?? neighbour(s, 1);
      if (event.key === "ArrowLeft" && atStart) to = s.col > 0 ? cellKey(s, s.row, s.col - 1) : cellKey(s, s.row - 1, columns - 1) ?? neighbour(s, -1);
      if (event.key === "ArrowRight" && atEnd) to = s.col < columns - 1 ? cellKey(s, s.row, s.col + 1) : cellKey(s, s.row + 1, 0) ?? neighbour(s, 1);
    } else {
      if ((event.key === "ArrowUp" || event.key === "ArrowLeft") && atStart) to = neighbour(s, -1);
      if ((event.key === "ArrowDown" || event.key === "ArrowRight") && atEnd) to = neighbour(s, 1);
    }
    if (!to) return;
    event.preventDefault();
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    moveTo(to, forward ? "start" : "end");
  });

  function cellKey(s, row, col) {
    const key = `c:${s.key.split(":")[1]}:${row}:${col}`;
    return surfaces.some((x) => x.key === key) ? key : null;
  }

  /** The box before or after [s]'s table or run of lines. */
  function neighbour(s, step) {
    const group = (x) => (x.kind === "cell" ? `table${x.key.split(":")[1]}` : x.key);
    const i = surfaces.indexOf(s);
    for (let j = i + step; j >= 0 && j < surfaces.length; j += step) {
      if (group(surfaces[j]) === group(s)) continue;
      if (surfaces[j].kind === "cell") {
        // Into a table from below lands in its first column of the last row.
        const t = surfaces[j].key.split(":")[1];
        const cells = surfaces.filter((x) => x.kind === "cell" && x.key.split(":")[1] === t);
        return (step < 0 ? cells.filter((x) => x.row === cells[cells.length - 1].row)[0] : cells[0]).key;
      }
      return surfaces[j].key;
    }
    return null;
  }

  function moveTo(key, where) {
    const s = surfaces.find((x) => x.key === key);
    if (!s) return;
    const before = focusKey;
    focusKey = key;
    if (s.base != null) {
      const p = s.base + (where === "start" ? 0 : s.local.length);
      sel = { start: p, end: p };
    }
    refocusCells(before);
    if (!(s.kind === "cell" && markup.TableMath.isFormula(s.local))) {
      rendering = true;
      try {
        placeCaret(s);
      } finally {
        rendering = false;
      }
    }
    drawTableBars();
    updateToolbar();
  }

  function nextCell(s, enter) {
    const columns = Math.max(...s.table.rows.map((r) => r.length));
    const to = s.col < columns - 1 ? cellKey(s, s.row, s.col + 1) : cellKey(s, s.row + 1, 0);
    if (to) {
      moveTo(to, "end");
      return;
    }
    // Past the last cell, a new row to go on in, as the phone's Next does.
    if (enter || !neighbour(s, 1)) apply(markup.addTableRow(source, s.table, s.row, 0));
    else moveTo(neighbour(s, 1), "start");
  }

  function previousCell(s) {
    const columns = Math.max(...s.table.rows.map((r) => r.length));
    const to = s.col > 0 ? cellKey(s, s.row, s.col - 1) : cellKey(s, s.row - 1, columns - 1);
    if (to) moveTo(to, "end");
  }

  // --- focus ---

  // Clicking the toolbar, a table's labels or bar, or the space around the
  // words keeps the caret where it is; only leaving the editor counts as leaving.
  root.addEventListener("mousedown", (event) => {
    if (event.target.closest(".ne-surface") && !event.target.closest(".ne-box")) return;
    event.preventDefault();
    if (!event.target.closest(".ne-menu-holder")) closeMenus();
    // The padding of a cell is the cell.
    const cell = event.target.closest("td")?.querySelector(".ne-surface");
    if (cell) moveTo(cell.dataset.surface, "end");
  });
  body.addEventListener("mousedown", (event) => {
    // A click below the last line goes to the end of the note.
    if (event.target !== body) return;
    const last = surfaces[surfaces.length - 1];
    moveTo(last.key, "end");
  });
  root.addEventListener("focusin", (event) => {
    if (rendering) return;
    const s = surfaces.find((x) => x.el === event.target);
    if (s && s.key !== focusKey) {
      const before = focusKey;
      focusKey = s.key;
      refocusCells(before);
      drawTableBars();
    }
  });
  root.addEventListener("focusout", (event) => {
    if (rendering || root.contains(event.relatedTarget)) return;
    closeMenus();
    onLeave?.();
  });
  document.addEventListener("selectionchange", () => {
    if (!root.isConnected) {
      listening.abort();
      return;
    }
    if (!rendering && !composing && root.contains(document.activeElement)) readCaret();
  }, { signal: listening.signal });

  render(false);
  return {
    element: root,
    value: () => source,
    focus() {
      const s = surfaceFor(surfaces);
      focusKey = s.key;
      rendering = true;
      try {
        if (s.kind === "cell") fill(s);
        placeCaret(s);
      } finally {
        rendering = false;
      }
      drawTableBars();
      updateToolbar();
    },
  };
}

// --- between the page and the shown text ---------------------------------------------

/** The text [el] shows: its words, a box as the characters it stands for, a typed break as "\n". */
function domText(el) {
  let out = "";
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out += c.data;
      else if (c.dataset?.len) out += c.dataset.text ?? "";
      else if (c.nodeName === "BR") out += c === el.lastChild ? "" : "\n";
      else {
        if ((c.nodeName === "DIV" || c.nodeName === "P") && out && !out.endsWith("\n")) out += "\n";
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

function lengthOf(n) {
  if (n.nodeType === Node.TEXT_NODE) return n.data.length;
  if (n.dataset?.len) return Number(n.dataset.len);
  let total = 0;
  for (const c of n.childNodes) total += lengthOf(c);
  return total;
}

/** Where the point ([node], [offset]) is in [root]'s shown text. */
function displayOffset(root, node, offset) {
  let total = 0;
  let found = null;
  const visit = (n) => {
    if (found !== null) return;
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) found = total + offset;
      else if (n.dataset?.len) found = total + (offset > 0 ? Number(n.dataset.len) : 0);
      else {
        for (let i = 0; i < offset && i < n.childNodes.length; i++) total += lengthOf(n.childNodes[i]);
        found = total;
      }
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      total += n.data.length;
      return;
    }
    if (n.dataset?.len) {
      // Inside a box: after it.
      if (n.contains(node)) found = total + Number(n.dataset.len);
      else total += Number(n.dataset.len);
      return;
    }
    for (const c of n.childNodes) visit(c);
  };
  visit(root);
  return found ?? total;
}

/** The DOM point at [d] in [root]'s shown text, on the end of the words before it where there is a choice. */
function domPoint(root, d) {
  let total = 0;
  let found = null;
  const visit = (n) => {
    for (let i = 0; i < n.childNodes.length && !found; i++) {
      const c = n.childNodes[i];
      if (c.nodeType === Node.TEXT_NODE) {
        // The first piece that reaches [d] takes it, so a caret at the end of
        // a bold word sits in the bold, as typing there will be.
        if (d <= total + c.data.length) {
          found = { node: c, offset: d - total };
          return;
        }
        total += c.data.length;
      } else if (c.dataset?.len) {
        const len = Number(c.dataset.len);
        if (d <= total) {
          found = { node: n, offset: i };
          return;
        }
        if (d < total + len) {
          found = { node: n, offset: i + 1 };
          return;
        }
        total += len;
      } else if (c.nodeName !== "BR") {
        visit(c);
      }
    }
  };
  visit(root);
  // Past the words: before the closing <br>.
  return found ?? { node: root, offset: Math.max(0, root.childNodes.length - 1) };
}

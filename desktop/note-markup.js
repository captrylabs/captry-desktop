// A capture note's small markup: bold, italic, strike, bullets, numbered and
// checklist lines, headings and tables, with the sums a table can show. It is
// stored as ordinary characters ("**bold**", "- [ ] milk", "| a | b |") so
// search and export keep seeing a string; the phone hides the markers and
// draws the rest.
//
// NoteMarkup.kt and TableMath.kt are the phone's copies of all of this, and
// the shared vector (note-markup-vector.json, which NoteMarkupVectorTest
// reads too) holds the two to the same results. The names are the phone's,
// so a change on one side is easy to find on the other.
//
// Offsets are UTF-16 code units, as they are in Kotlin, so every position
// means the same character on both sides. An edit comes back as
// { text, selectionStart, selectionEnd }, the text and where the caret goes.

export const BOLD = "**";
export const ITALIC = "_";
export const STRIKE = "~~";
export const BULLET = "- ";
export const CHECKLIST_OPEN = "- [ ] ";
export const CHECKLIST_DONE = "- [x] ";
/** The em space after a checklist box, so a drawn box wider than ☐ does not sit on the words. */
export const CHECKLIST_DISPLAY_GAP = "\u2003";
export const TABLE_COLUMNS = 2;
export const TABLE_ROWS = 2;
const ORDERED = /^(\d+)\. /;
const TABLE_SEPARATOR_CELL = /^:?-{3,}:?$/;
const TOTAL_LABEL = "Total";
const SUM_ABOVE = "=sum";
const SUM_LEFT = "=sum(left)";
const INT_MAX = 2147483647;

// --- Kotlin's idea of a character ---------------------------------------------------
//
// Kotlin's isWhitespace, isDigit and isLetter are Unicode-wide and not quite
// JavaScript's \s, so they are spelled out: a space the two disagreed on would
// put a marker or a cell edge in a different place.

const WHITESPACE = /^[\t\n\u000b\f\r\u001c-\u001f\p{Zs}\u2028\u2029]$/u;
const DIGIT = /^\p{Nd}$/u;
const LETTER = /^\p{L}$/u;

const isWhitespace = (ch) => ch != null && WHITESPACE.test(ch);
const isDigit = (ch) => ch != null && DIGIT.test(ch);
const isLetter = (ch) => ch != null && LETTER.test(ch);
const isLetterOrDigit = (ch) => isLetter(ch) || isDigit(ch);

function trimStart(s) {
  let i = 0;
  while (i < s.length && isWhitespace(s[i])) i++;
  return s.slice(i);
}

function trim(s) {
  let to = s.length;
  while (to > 0 && isWhitespace(s[to - 1])) to--;
  let from = 0;
  while (from < to && isWhitespace(s[from])) from++;
  return s.slice(from, to);
}

const isBlank = (s) => trim(s).length === 0;

function equalsIgnoreCase(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x !== y && x.toUpperCase() !== y.toUpperCase() && x.toLowerCase() !== y.toLowerCase()) return false;
  }
  return true;
}

const coerceIn = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const edit = (text, selectionStart, selectionEnd) => ({ text, selectionStart, selectionEnd });
const removeRange = (s, from, to) => s.slice(0, from) + s.slice(to);

// --- line prefixes -------------------------------------------------------------------

const NONE = Object.freeze({ kind: "none", markerLength: 0 });
const BULLET_PREFIX = Object.freeze({ kind: "bullet", markerLength: 2 });
const ordered = (n) => ({ kind: "ordered", n, markerLength: `${n}. `.length });
const heading = (level) => ({ kind: "heading", level, markerLength: level + 1 });
const checklist = (checked) => ({ kind: "checklist", checked, markerLength: 6 });

/**
 * What a line starts with: { kind: "none" | "bullet" | "ordered" | "heading"
 * | "checklist", n, level, checked, markerLength }.
 */
export function parsePrefix(line) {
  if (line.startsWith("### ")) return heading(3);
  if (line.startsWith("## ")) return heading(2);
  if (line.startsWith("# ")) return heading(1);
  if (line.startsWith(CHECKLIST_OPEN)) return checklist(false);
  if (line.startsWith(CHECKLIST_DONE) || line.startsWith("- [X] ")) return checklist(true);
  if (line.startsWith(BULLET)) return BULLET_PREFIX;
  const m = ORDERED.exec(line);
  // The phone reads the number as an Int and fails on one past 2147483647;
  // here such a line is only words.
  if (m && Number(m[1]) <= INT_MAX) return ordered(Number(m[1]));
  return NONE;
}

/** [line] without its prefix. */
export function stripPrefix(line) {
  return line.substring(parsePrefix(line).markerLength);
}

function applyPrefix(line, prefix) {
  const body = stripPrefix(line);
  switch (prefix.kind) {
    case "bullet": return BULLET + body;
    case "ordered": return `${prefix.n}. ${body}`;
    case "heading": return `${"#".repeat(prefix.level)} ${body}`;
    case "checklist": return (prefix.checked ? CHECKLIST_DONE : CHECKLIST_OPEN) + body;
    default: return body;
  }
}

function sameKind(a, b) {
  if (a.kind !== b.kind || a.kind === "none") return false;
  return a.kind !== "heading" || a.level === b.level;
}

// --- bold, italic, strike ------------------------------------------------------------

export const toggleBold = (text, start, end) => toggleWrap(text, start, end, BOLD);
export const toggleItalic = (text, start, end) => toggleWrap(text, start, end, ITALIC);
export const toggleStrike = (text, start, end) => toggleWrap(text, start, end, STRIKE);
export const hasBold = (text, start, end) => wrapAround(text, start, end, BOLD) != null;
export const hasItalic = (text, start, end) => wrapAround(text, start, end, ITALIC) != null;
export const hasStrike = (text, start, end) => wrapAround(text, start, end, STRIKE) != null;

export function toggleWrap(text, start, end, marker) {
  const from = coerceIn(start, 0, text.length);
  const to = coerceIn(end, 0, text.length);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const wrap = wrapAround(text, lo, hi, marker);
  if (wrap != null) {
    if (lo !== hi) return unwrap(text, wrap, lo, hi);
    if (wrap.contentStart === wrap.contentEnd) return unwrap(text, wrap, lo, hi);
    if (lo <= wrap.contentStart) return unwrap(text, wrap, lo, hi);
    if (lo >= wrap.contentEnd) return edit(text, wrap.closeEnd, wrap.closeEnd);
    return splitEnd(text, wrap, lo, marker);
  }
  if (lo === hi) {
    const inserted = text.substring(0, lo) + marker + marker + text.substring(lo);
    const caret = lo + marker.length;
    return edit(inserted, caret, caret);
  }
  const wrapped = marker + text.substring(lo, hi) + marker;
  return edit(text.substring(0, lo) + wrapped + text.substring(hi), lo, lo + wrapped.length);
}

function wrapAround(text, start, end, marker) {
  const lo = coerceIn(Math.min(start, end), 0, text.length);
  const hi = coerceIn(Math.max(start, end), 0, text.length);
  const lineStart = lineStartOf(text, lo);
  const lineEnd = lineEndOf(text, lo);
  if (hi > lineEnd) return null;
  return findWraps(text, lineStart, lineEnd, marker).find((wrap) =>
    lo === hi ? wrap.open <= lo && lo < wrap.closeEnd : wrap.open <= lo && hi <= wrap.closeEnd) ?? null;
}

function findWraps(text, lineStart, lineEnd, marker) {
  const wraps = [];
  let i = lineStart;
  while (i < lineEnd) {
    if (marker === ITALIC && !canOpenItalic(text, i)) {
      i++;
      continue;
    }
    if (!text.startsWith(marker, i)) {
      i++;
      continue;
    }
    const contentStart = i + marker.length;
    const close = text.indexOf(marker, contentStart);
    if (close === -1 || close > lineEnd) {
      i++;
      continue;
    }
    const closeEnd = close + marker.length;
    if (marker === ITALIC && !canCloseItalic(text, closeEnd)) {
      i++;
      continue;
    }
    wraps.push({ open: i, contentStart, contentEnd: close, closeEnd });
    i = closeEnd;
  }
  return wraps;
}

function unwrap(text, wrap, lo, hi) {
  const inner = text.substring(wrap.contentStart, wrap.contentEnd);
  const next = text.substring(0, wrap.open) + inner + text.substring(wrap.closeEnd);
  return edit(next, remapUnwrapped(lo, wrap), remapUnwrapped(hi, wrap));
}

function remapUnwrapped(pos, wrap) {
  const inner = wrap.contentEnd - wrap.contentStart;
  if (pos <= wrap.open) return pos;
  if (pos <= wrap.contentStart) return wrap.open;
  if (pos <= wrap.contentEnd) return wrap.open + (pos - wrap.contentStart);
  if (pos <= wrap.closeEnd) return wrap.open + inner;
  return pos - (wrap.closeEnd - wrap.open - inner);
}

function splitEnd(text, wrap, pos, marker) {
  const kept = text.substring(wrap.contentStart, pos);
  const rest = text.substring(pos, wrap.contentEnd);
  const next = text.substring(0, wrap.open) + marker + kept + marker + rest + text.substring(wrap.closeEnd);
  const caret = wrap.open + marker.length + kept.length + marker.length;
  return edit(next, caret, caret);
}

function spanAt(source, index, limit) {
  let m = matchPair(source, index, limit, BOLD);
  if (m) return { ...m, bold: true, italic: false, strike: false };
  m = matchPair(source, index, limit, STRIKE);
  if (m) return { ...m, bold: false, italic: false, strike: true };
  if (canOpenItalic(source, index)) {
    m = matchPair(source, index, limit, ITALIC);
    if (m && canCloseItalic(source, m.markerEnd)) return { ...m, bold: false, italic: true, strike: false };
  }
  return null;
}

function matchPair(source, index, limit, marker) {
  if (!source.startsWith(marker, index)) return null;
  const contentStart = index + marker.length;
  const close = source.indexOf(marker, contentStart);
  if (close === -1 || close > limit) return null;
  return { contentStart, contentEnd: close, markerEnd: close + marker.length };
}

// An underscore inside a word (track_saw_kit) is part of the word, not italic.
function canOpenItalic(source, index) {
  if (index >= source.length || source[index] !== "_") return false;
  const prev = index > 0 ? source[index - 1] : null;
  return prev == null || isWhitespace(prev) || "([{'\"".includes(prev);
}

function canCloseItalic(source, markerEnd) {
  const next = markerEnd >= 0 && markerEnd < source.length ? source[markerEnd] : null;
  return next == null || isWhitespace(next) || ".,;:!?)]}'\"".includes(next);
}

// --- lists and headings --------------------------------------------------------------

export const hasBullet = (text, start, end) =>
  cellPrefix(text, start)?.kind === "bullet" || linesHave(text, start, end, (p) => p.kind === "bullet");

export const hasOrdered = (text, start, end) =>
  cellPrefix(text, start)?.kind === "ordered" || linesHave(text, start, end, (p) => p.kind === "ordered");

export const hasChecklist = (text, start, end) =>
  cellPrefix(text, start)?.kind === "checklist" || linesHave(text, start, end, (p) => p.kind === "checklist");

export function hasHeading(text, start, end, level) {
  const cell = cellPrefix(text, start);
  return (cell?.kind === "heading" && cell.level === level) ||
    linesHave(text, start, end, (p) => p.kind === "heading" && p.level === level);
}

export const toggleBullet = (text, start, end) => toggleLinePrefix(text, start, end, BULLET_PREFIX);
export const toggleOrdered = (text, start, end) => toggleLinePrefix(text, start, end, ordered(1));
export const toggleChecklist = (text, start, end) => toggleLinePrefix(text, start, end, checklist(false));

/** A second tap on the heading a line already has ends it: the caret goes after its words. */
export function toggleHeading(text, start, end, level) {
  const from = coerceIn(start, 0, text.length);
  const to = coerceIn(end, 0, text.length);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const lines = linesIntersecting(text, lo, hi);
  if (lines.length === 1) {
    const line = lines[0];
    const prefix = parsePrefix(text.substring(line.start, line.end));
    if (prefix.kind === "heading" && prefix.level === level) {
      return stripPrefix(text.substring(line.start, line.end)).length === 0
        ? toggleLinePrefix(text, lo, hi, heading(level))
        : edit(text, line.end, line.end);
    }
  }
  return toggleLinePrefix(text, start, end, heading(level));
}

/** Flips the checked bit on the checklist line under [offset]; any other line is left alone. */
export function toggleChecked(text, offset) {
  const from = coerceIn(offset, 0, text.length);
  const lineStart = lineStartOf(text, from);
  const lineEnd = lineEndOf(text, lineStart);
  const line = text.substring(lineStart, lineEnd);
  const prefix = parsePrefix(line);
  if (prefix.kind !== "checklist") return edit(text, from, from);
  const next = applyPrefix(line, checklist(!prefix.checked));
  const rewritten = text.substring(0, lineStart) + next + text.substring(lineEnd);
  const caret = coerceIn(from + (next.length - line.length), 0, rewritten.length);
  return edit(rewritten, caret, caret);
}

/** Whether [displayOffset] in layout(source).display is on a checklist box (the box or its space). */
export function isChecklistBoxTap(source, displayOffset) {
  const l = layout(source);
  const original = l.displayToOriginal[coerceIn(displayOffset, 0, l.displayToOriginal.length - 1)];
  if (original == null || original < 0) return false;
  const lineStart = lineStartOf(source, original);
  const prefix = parsePrefix(source.substring(lineStart, lineEndOf(source, lineStart)));
  if (prefix.kind !== "checklist") return false;
  const boxStart = l.originalToDisplay[lineStart];
  return displayOffset >= boxStart && displayOffset < boxStart + 2;
}

/**
 * Every checklist box: [{ lineStart, displayIndex, checked }]. lineStart is the
 * stored offset toggleChecked takes; displayIndex is where the box is in
 * layout(source).display.
 */
export function checklistBoxes(source) {
  if (source.length === 0) return [];
  const l = layout(source);
  const hits = [];
  let lineStart = 0;
  for (;;) {
    const lineEnd = lineEndOf(source, lineStart);
    const prefix = parsePrefix(source.substring(lineStart, lineEnd));
    if (prefix.kind === "checklist") {
      hits.push({ lineStart, displayIndex: l.originalToDisplay[lineStart], checked: prefix.checked });
    }
    if (lineEnd >= source.length) break;
    lineStart = lineEnd + 1;
  }
  return hits;
}

function linesHave(text, start, end, match) {
  const lines = linesIntersecting(text, start, end);
  return lines.length > 0 && lines.every((line) => match(parsePrefix(text.substring(line.start, line.end))));
}

function toggleLinePrefix(text, start, end, target) {
  const from = coerceIn(start, 0, text.length);
  const to = coerceIn(end, 0, text.length);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const table = tableAt(text, lo, hi);
  if (table != null) return togglePrefixInTableCell(text, table, lo, target);
  const lines = linesIntersecting(text, lo, hi);
  if (lines.length === 0) return edit(text, lo, hi);
  const strip = lines.every((line) => sameKind(parsePrefix(text.substring(line.start, line.end)), target));
  const firstNumber = target.kind === "ordered" && !strip ? nextOrderedNumber(text, lines[0].start) : 1;
  const result = rewriteLines(text, lo, hi, lines, (index, line) => {
    if (strip) return applyPrefix(line, NONE);
    return applyPrefix(line, target.kind === "ordered" ? ordered(firstNumber + index) : target);
  });
  if (strip) return result;
  if (result.selectionStart !== result.selectionEnd) return result;
  const lineStart = lineStartOf(result.text, result.selectionStart);
  const lineEnd = lineEndOf(result.text, lineStart);
  const prefix = parsePrefix(result.text.substring(lineStart, lineEnd));
  const caret = Math.max(result.selectionStart, lineStart + prefix.markerLength);
  return edit(result.text, caret, caret);
}

function nextOrderedNumber(text, lineStart) {
  if (lineStart === 0) return 1;
  const prevEnd = lineStart - 1;
  const prev = parsePrefix(text.substring(lineStartOf(text, prevEnd), prevEnd));
  return prev.kind === "ordered" ? prev.n + 1 : 1;
}

function rewriteLines(text, lo, hi, lines, transform) {
  let out = "";
  let cursor = 0;
  let newMin = lo;
  let newMax = hi;
  lines.forEach((line, index) => {
    out += text.substring(cursor, line.start);
    const old = text.substring(line.start, line.end);
    const next = transform(index, old);
    const delta = next.length - old.length;
    if (lo > line.start) newMin += delta;
    if (hi > line.start) newMax += delta;
    out += next;
    cursor = line.end;
  });
  out += text.substring(cursor);
  return edit(out, coerceIn(newMin, 0, out.length), coerceIn(newMax, 0, out.length));
}

// --- Enter ---------------------------------------------------------------------------

/**
 * After a newline is typed at [newlineIndex], continue a list or leave it.
 * An empty item is how a list ends: the prefix goes, rather than stacking
 * blank bullets. A bold, italic or strike open at the break is closed there.
 */
export function afterNewline(text, newlineIndex) {
  const closed = closeWrapsAtNewline(text, newlineIndex);
  const lineStart = lineStartOf(closed.text, closed.selectionStart - 1);
  const newlineAt = closed.selectionStart - 1;
  const line = closed.text.substring(lineStart, newlineAt);
  const prefix = parsePrefix(line);
  const body = line.substring(prefix.markerLength);
  if (prefix.kind === "none" || (prefix.kind === "heading" && body.length > 0)) {
    const caret = newlineAt + 1;
    return edit(closed.text, caret, caret);
  }
  if (body.length === 0) {
    const next = closed.text.substring(0, lineStart) + closed.text.substring(newlineAt + 1);
    return edit(next, lineStart, lineStart);
  }
  const nextPrefix = prefix.kind === "bullet" ? BULLET
    : prefix.kind === "ordered" ? `${prefix.n + 1}. `
    : CHECKLIST_OPEN;
  const at = newlineAt + 1;
  const next = closed.text.substring(0, at) + nextPrefix + closed.text.substring(at);
  const caret = at + nextPrefix.length;
  return edit(next, caret, caret);
}

/** Where [next] is [old] with one newline typed before [newCaret], or null when it is not. */
export function newlineInsertionIndex(old, next, newCaret) {
  if (next.length !== old.length + 1) return null;
  const at = newCaret - 1;
  if (at < 0 || at >= next.length || next[at] !== "\n") return null;
  if (removeRange(next, at, at + 1) !== old) return null;
  return at;
}

// Enter ends a wrap the way a second toolbar tap does: the words before the
// break stay formatted and the new line starts plain.
function closeWrapsAtNewline(text, newlineIndex) {
  let next = text;
  let nl = newlineIndex;
  for (const marker of [BOLD, STRIKE, ITALIC]) {
    const lineStart = lineStartOf(next, nl);
    const open = unclosedWrapOpen(next, lineStart, nl, marker);
    if (open == null) continue;
    const contentEmpty = open + marker.length === nl;
    const afterClose = next.startsWith(marker, nl + 1);
    if (contentEmpty && afterClose) {
      next = removeRange(removeRange(next, nl + 1, nl + 1 + marker.length), open, nl);
      nl = open;
      continue;
    }
    next = next.substring(0, nl) + marker + next.substring(nl);
    nl += marker.length;
    const nextLineEnd = lineEndOf(next, nl + 1);
    const leftoverClose = next.indexOf(marker, nl + 1);
    if (leftoverClose !== -1 && leftoverClose <= nextLineEnd) {
      if (marker !== ITALIC || canCloseItalic(next, leftoverClose + marker.length)) {
        next = removeRange(next, leftoverClose, leftoverClose + marker.length);
      }
    }
  }
  return edit(next, nl + 1, nl + 1);
}

function unclosedWrapOpen(text, lineStart, limit, marker) {
  let i = lineStart;
  let open = null;
  while (i < limit) {
    // An italic opens on a _ that can open one and closes on a _ that can
    // close one, so the _ after "b" in "_b_ **c" closes it.
    if (marker === ITALIC) {
      const usable = open == null ? canOpenItalic(text, i) : text[i] === "_" && canCloseItalic(text, i + 1);
      if (!usable) {
        i++;
        continue;
      }
    }
    if (!text.startsWith(marker, i) || i + marker.length > limit) {
      i++;
      continue;
    }
    open = open == null ? i : null;
    i += marker.length;
  }
  return open;
}

// --- what is shown ------------------------------------------------------------------

/**
 * The visible text and its styles, with maps both ways so a caret on the
 * screen lands on the right stored character.
 *
 * Returns { display, spans, originalToDisplay, displayToOriginal }. display has
 * the markers hidden, "- " drawn as "• ", a checklist marker as "☐ " or "☑ "
 * and an em space, and a zero-width space where an empty wrap or heading
 * keeps a caret slot. spans are [{ start, end, bold, italic, strike, heading }]
 * in display offsets; heading is 0, or 1 to 3. originalToDisplay has one more
 * entry than the source, displayToOriginal one more than the display; a
 * display character with no stored one maps to -1.
 */
export function layout(source) {
  const out = [];
  const spans = [];
  const originalToDisplay = new Array(source.length + 1).fill(0);
  const displayToOriginal = new Array(source.length + 1).fill(-1);
  let d = 0;
  let lastEmittedOrig = 0;

  const emit = (orig, ch) => {
    originalToDisplay[orig] = d;
    displayToOriginal[d] = orig;
    out.push(ch);
    d++;
    lastEmittedOrig = orig + 1;
  };
  const emitZwsp = (orig) => {
    originalToDisplay[orig] = d;
    displayToOriginal[d] = orig;
    out.push("\u200b");
    d++;
    lastEmittedOrig = orig;
  };
  const hide = (from, to) => {
    for (let m = from; m < to; m++) originalToDisplay[m] = d;
  };

  let lineStart = 0;
  for (;;) {
    const lineEnd = lineEndOf(source, lineStart);
    const prefix = parsePrefix(source.substring(lineStart, lineEnd));
    let i = lineStart;
    if (prefix.kind === "bullet") {
      emit(i, "•");
      emit(i + 1, " ");
      i += 2;
    } else if (prefix.kind === "checklist") {
      emit(i, prefix.checked ? "☑" : "☐");
      emit(i + 1, " ");
      emit(i + 2, CHECKLIST_DISPLAY_GAP);
      hide(i + 3, i + prefix.markerLength);
      i += prefix.markerLength;
    } else if (prefix.kind === "heading") {
      hide(i, i + prefix.markerLength);
      i += prefix.markerLength;
    }
    const contentDisplayStart = d;
    if (i === lineEnd && prefix.kind === "heading") emitZwsp(i);
    while (i < lineEnd) {
      const match = spanAt(source, i, lineEnd);
      if (match == null) {
        emit(i, source[i]);
        i++;
        continue;
      }
      const styleStart = d;
      hide(i, match.contentStart);
      if (match.contentStart === match.contentEnd) {
        emitZwsp(match.contentStart);
        hide(match.contentStart + 1, match.markerEnd);
      } else {
        for (let o = match.contentStart; o < match.contentEnd; o++) emit(o, source[o]);
        hide(match.contentEnd, match.markerEnd);
      }
      spans.push({ start: styleStart, end: d, bold: match.bold, italic: match.italic, strike: match.strike, heading: 0 });
      i = match.markerEnd;
    }
    if (prefix.kind === "heading" && d > contentDisplayStart) {
      spans.push({ start: contentDisplayStart, end: d, bold: false, italic: false, strike: false, heading: prefix.level });
    }
    if (lineEnd === source.length) break;
    emit(lineEnd, "\n");
    lineStart = lineEnd + 1;
  }
  originalToDisplay[source.length] = d;
  if (displayToOriginal[d] === -1) displayToOriginal[d] = lastEmittedOrig;
  return { display: out.join(""), spans, originalToDisplay, displayToOriginal: displayToOriginal.slice(0, d + 1) };
}

// --- tables --------------------------------------------------------------------------

/**
 * The note cut into runs of lines and tables: [{ type: "text", start, end }]
 * and [{ type: "table", start, end, rows }], rows being [[{ start, end, text }]]
 * with each cell's stored range. A table's alignment row (| --- |) is not a
 * row of cells. A block's end takes in the newline after it.
 */
export function parseBlocks(source) {
  const result = [];
  let lineStart = 0;
  let textRunStart = null;
  let tableStart = null;
  let tableRows = [];

  const flushText = (until) => {
    if (textRunStart == null) return;
    if (until > textRunStart) result.push({ type: "text", start: textRunStart, end: until });
    textRunStart = null;
  };
  const flushTable = (until) => {
    if (tableStart == null) return;
    if (tableRows.length) result.push({ type: "table", start: tableStart, end: until, rows: tableRows });
    tableStart = null;
    tableRows = [];
  };

  if (source.length === 0) return [];
  for (;;) {
    const lineEnd = lineEndOf(source, lineStart);
    const line = source.substring(lineStart, lineEnd);
    const separator = isSeparatorRow(line);
    if (isTableRow(line) && !separator) {
      if (tableStart == null) {
        flushText(lineStart);
        tableStart = lineStart;
      }
      tableRows.push(parseTableRow(source, lineStart, lineEnd));
    } else if (!(separator && tableStart != null)) {
      if (tableStart != null) flushTable(lineStart);
      if (textRunStart == null) textRunStart = lineStart;
    }
    if (lineEnd === source.length) {
      if (tableStart != null) flushTable(source.length);
      else flushText(source.length);
      break;
    }
    lineStart = lineEnd + 1;
  }
  return result;
}

export const hasTable = (text, start, end) => tableAt(text, start, end) != null;

/** The table block the caret at [start] is in, or null. */
export function tableAt(text, start, end) {
  const lo = coerceIn(Math.min(start, end), 0, text.length);
  return parseBlocks(text).find((b) => b.type === "table" &&
    lo >= b.start && (lo < b.end || (lo === text.length && b.end === text.length))) ?? null;
}

/**
 * Inserts a 2×2 table at the caret, or turns the table the caret is in back
 * into lines. Selected words become the first cell.
 */
export function toggleTable(text, start, end) {
  const from = coerceIn(start, 0, text.length);
  const to = coerceIn(end, 0, text.length);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const existing = tableAt(text, lo, hi);
  return existing != null ? removeTable(text, existing) : insertTable(text, lo, hi);
}

/**
 * [text] with [table] written out again as [rows] (arrays of cell words), the
 * caret at [selectionStart]..[selectionEnd] within the cell at caretRow, caretCol.
 */
export function replaceTable(text, table, rows, caretRow, caretCol, selectionStart, selectionEnd = selectionStart) {
  const normalized = normalizeTable(rows);
  const next = text.substring(0, table.start) + serializeTable(normalized) + text.substring(rowsEnd(text, table));
  const start = coerceIn(table.start + caretInTable(normalized, caretRow, caretCol, selectionStart), 0, next.length);
  const end = coerceIn(table.start + caretInTable(normalized, caretRow, caretCol, selectionEnd), 0, next.length);
  return edit(next, start, end);
}

export function addTableRow(text, table, afterRow, caretCol = 0) {
  const rows = table.rows.map((row) => row.map((cell) => cell.text));
  const cols = Math.max(Math.max(...rows.map((r) => r.length)), TABLE_COLUMNS);
  const at = coerceIn(afterRow + 1, 0, rows.length);
  rows.splice(at, 0, new Array(cols).fill(""));
  const col = coerceIn(caretCol, 0, cols - 1);
  return replaceTable(text, table, rows, at, col, 0);
}

export function addTableColumn(text, table, afterCol, caretRow = 0) {
  const cols = Math.max(Math.max(...table.rows.map((r) => r.length)), 1);
  const at = coerceIn(afterCol + 1, 0, cols);
  const rows = table.rows.map((row) => {
    const cells = Array.from({ length: cols }, (_, i) => row[i]?.text ?? "");
    cells.splice(at, 0, "");
    return cells;
  });
  const row = coerceIn(caretRow, 0, rows.length - 1);
  return replaceTable(text, table, rows, row, at, 0);
}

/** Deleting the last row deletes the table. */
export function deleteTableRow(text, table, row, caretCol = 0) {
  const rows = tableTexts(table);
  if (rows.length <= 1) return dropTable(text, table);
  const at = coerceIn(row, 0, rows.length - 1);
  rows.splice(at, 1);
  const caretRow = Math.min(at, rows.length - 1);
  const col = coerceIn(caretCol, 0, rows[caretRow].length - 1);
  return replaceTable(text, table, rows, caretRow, col, rows[caretRow][col].length);
}

/** Deleting the last column deletes the table. */
export function deleteTableColumn(text, table, col, caretRow = 0) {
  const rows = tableTexts(table);
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols <= 1) return dropTable(text, table);
  const at = coerceIn(col, 0, cols - 1);
  const next = rows.map((row) => row.filter((_, i) => i !== at));
  const caretCol = Math.min(at, cols - 2);
  const r = coerceIn(caretRow, 0, next.length - 1);
  return replaceTable(text, table, next, r, caretCol, next[r][caretCol].length);
}

/** Totals column [col] in a Total row at the bottom, added the first time and reused after. */
export function totalColumn(text, table, col, caretRow = 0) {
  const rows = tableTexts(table);
  const cols = rows[0].length;
  const c = coerceIn(col, 0, cols - 1);
  const total = totalRowToFill(rows, cols);
  total[c] = SUM_ABOVE;
  rows[rows.length - 1] = total;
  return keepCaret(text, table, rows, caretRow, c);
}

/** Totals row [row] in a Total column on the right, added the first time and reused after. */
export function totalRow(text, table, row, caretCol = 0) {
  let rows = tableTexts(table);
  const r = coerceIn(row, 0, rows.length - 1);
  if (!reusesTotalColumn(rows)) rows = rows.map((cells, i) => [...cells, i === 0 ? TOTAL_LABEL : ""]);
  const at = rows[0].length - 1;
  rows = rows.map((cells, i) => (i === r ? cells.map((x, j) => (j === at ? SUM_LEFT : x)) : cells));
  return keepCaret(text, table, rows, r, caretCol);
}

/** totalColumn for every column that holds numbers. */
export function totalAllColumns(text, table, caretRow = 0, caretCol = 0) {
  const rows = tableTexts(table);
  const cols = rows[0].length;
  const reuse = reusesTotalRow(rows);
  const body = reuse ? rows.slice(0, -1) : rows;
  let numeric = [];
  for (let c = 0; c < cols; c++) if (body.some((row) => isNumeric(row[c]))) numeric.push(c);
  if (!numeric.length) numeric = range(cols > 1 ? 1 : 0, cols);
  const total = totalRowToFill(rows, cols);
  for (const c of numeric) total[c] = SUM_ABOVE;
  rows[rows.length - 1] = total;
  return keepCaret(text, table, rows, caretRow, caretCol);
}

/** totalRow for every row that holds numbers. */
export function totalAllRows(text, table, caretRow = 0, caretCol = 0) {
  let rows = tableTexts(table);
  const lastCol = rows[0].length - 1;
  const reuse = reusesTotalColumn(rows);
  const bodyWidth = reuse ? lastCol : lastCol + 1;
  let numeric = [];
  rows.forEach((row, r) => row.slice(0, bodyWidth).some(isNumeric) && numeric.push(r));
  if (!numeric.length) numeric = range(rows.length > 1 ? 1 : 0, rows.length);
  if (!reuse) rows = rows.map((cells, i) => [...cells, i === 0 ? TOTAL_LABEL : ""]);
  const at = rows[0].length - 1;
  rows = rows.map((cells, i) => (numeric.includes(i) ? cells.map((x, j) => (j === at ? SUM_LEFT : x)) : cells));
  return keepCaret(text, table, rows, caretRow, caretCol);
}

const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const isNumeric = (s) => TableMath.isFormula(s) || TableMath.isNumber(s);
const isSum = (s) => {
  const t = trim(s).toLowerCase();
  return t === SUM_ABOVE || t === SUM_LEFT;
};

// The bottom row is already a Total row when it says so or already sums.
function reusesTotalRow(rows) {
  const last = rows[rows.length - 1];
  return rows.length > 1 && (equalsIgnoreCase(last[0], TOTAL_LABEL) || last.some(isSum));
}

function reusesTotalColumn(rows) {
  const lastCol = rows[0].length - 1;
  return lastCol > 0 && (equalsIgnoreCase(rows[0][lastCol], TOTAL_LABEL) || rows.some((row) => isSum(row[lastCol])));
}

/** The Total row to write sums into: a copy of the last row, or a new one put at the bottom. */
function totalRowToFill(rows, cols) {
  if (reusesTotalRow(rows)) return [...rows[rows.length - 1]];
  const total = Array.from({ length: cols }, (_, i) => (i === 0 ? TOTAL_LABEL : ""));
  rows.push(total);
  return total;
}

function keepCaret(text, table, rows, row, col) {
  const r = coerceIn(row, 0, rows.length - 1);
  const c = coerceIn(col, 0, rows[r].length - 1);
  return replaceTable(text, table, rows, r, c, rows[r][c].length);
}

function tableTexts(table) {
  const cols = Math.max(Math.max(...table.rows.map((r) => r.length)), 1);
  return table.rows.map((row) => Array.from({ length: cols }, (_, i) => row[i]?.text ?? ""));
}

function cellPrefix(text, start) {
  const table = tableAt(text, start, start);
  if (table == null) return null;
  for (const row of table.rows) {
    for (const cell of row) if (start >= cell.start && start <= cell.end) return parsePrefix(cell.text);
  }
  return null;
}

function togglePrefixInTableCell(text, table, offset, target) {
  let rowIndex = -1;
  let colIndex = -1;
  let current = "";
  table.rows.forEach((row, r) => row.forEach((cell, c) => {
    if (offset >= cell.start && offset <= cell.end) {
      rowIndex = r;
      colIndex = c;
      current = cell.text;
    }
  }));
  if (rowIndex < 0) return edit(text, offset, offset);
  const nextText = sameKind(parsePrefix(current), target) ? stripPrefix(current) : applyPrefix(current, target);
  const rows = table.rows.map((row, r) => row.map((cell, c) => (r === rowIndex && c === colIndex ? nextText : cell.text)));
  const caret = Math.min(parsePrefix(nextText).markerLength, nextText.length);
  return replaceTable(text, table, rows, rowIndex, colIndex, caret);
}

/** A line that starts with a pipe and has another one after it. */
export function isTableRow(line) {
  return line.startsWith("|") && line.indexOf("|", 1) >= 0;
}

function isSeparatorRow(line) {
  if (!isTableRow(line)) return false;
  const cells = tableRowCells(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(trim(cell)));
}

function tableRowCells(line) {
  let inner = line;
  if (inner.startsWith("|")) inner = inner.substring(1);
  if (inner.endsWith("|")) inner = inner.substring(0, inner.length - 1);
  if (inner.length === 0) return [""];
  return inner.split("|");
}

function parseTableRow(source, lineStart, lineEnd) {
  const line = source.substring(lineStart, lineEnd);
  const cells = [];
  let i = line.startsWith("|") ? 1 : 0;
  while (i < line.length) {
    let nextPipe = line.indexOf("|", i);
    if (nextPipe === -1) nextPipe = line.length;
    const raw = line.substring(i, nextPipe);
    // Writing a table pads each cell with one space either side. Only that
    // padding is taken off, so a space typed between words stays.
    let from = 0;
    let to = raw.length;
    if (raw.startsWith(" ")) from = 1;
    if (to > from && raw[to - 1] === " ") to -= 1;
    cells.push({ start: lineStart + i + from, end: lineStart + i + to, text: raw.substring(from, to) });
    if (nextPipe === line.length) break;
    i = nextPipe + 1;
    if (i >= line.length && line.endsWith("|")) break;
  }
  return cells.length ? cells : [{ start: lineStart, end: lineStart, text: "" }];
}

function insertTable(text, lo, hi) {
  const selected = trim(text.substring(lo, hi).replaceAll("|", " ").replaceAll("\n", " "));
  const rows = Array.from({ length: TABLE_ROWS }, (_, r) =>
    Array.from({ length: TABLE_COLUMNS }, (_, c) => (r === 0 && c === 0 ? selected : "")));
  const table = serializeTable(rows);
  const before = text.substring(0, lo);
  const after = text.substring(hi);
  const prefix = before.length && !before.endsWith("\n") ? "\n" : "";
  const suffix = after.length && !after.startsWith("\n") ? "\n" : "";
  const next = before + prefix + table + suffix + after;
  const caret = before.length + prefix.length + 2 + selected.length;
  return edit(next, caret, caret);
}

function removeTable(text, table) {
  const collapsed = table.rows
    .map((row) => row.map((cell) => cell.text).filter((t) => !isBlank(t)).join(" "))
    .filter((line) => line.length > 0)
    .join("\n");
  if (collapsed.length === 0) return dropTable(text, table);
  const before = text.substring(0, table.start);
  const after = text.substring(rowsEnd(text, table));
  const prefix = before.length && !before.endsWith("\n") ? "\n" : "";
  const suffix = after.length && !after.startsWith("\n") && !collapsed.endsWith("\n") ? "\n" : "";
  const next = before + prefix + collapsed + suffix + after;
  const caret = coerceIn(before.length + prefix.length + collapsed.length, 0, next.length);
  return edit(next, caret, caret);
}

function dropTable(text, table) {
  let from = table.start;
  let to = rowsEnd(text, table);
  if (from > 0 && text[from - 1] === "\n") from--;
  else if (to < text.length && text[to] === "\n") to++;
  return edit(text.substring(0, from) + text.substring(to), from, from);
}

// Where [table]'s last row ends. parseBlocks counts the line break after it
// as the table's; a rewrite keeps that break for the line after.
function rowsEnd(text, table) {
  return table.end > table.start && text[table.end - 1] === "\n" ? table.end - 1 : table.end;
}

function normalizeTable(rows) {
  const cols = rows.length ? Math.max(Math.max(...rows.map((r) => r.length)), 1) : TABLE_COLUMNS;
  const cleaned = rows.map((row) =>
    Array.from({ length: cols }, (_, i) => (i < row.length ? row[i] : "").replaceAll("|", " ").replaceAll("\n", " ")));
  return cleaned.length ? cleaned : [new Array(cols).fill("")];
}

function serializeTable(rows) {
  return rows.map((row) => "| " + row.join(" | ") + " |").join("\n");
}

function caretInTable(rows, row, col, offset) {
  const r = coerceIn(row, 0, rows.length - 1);
  const c = coerceIn(col, 0, rows[r].length - 1);
  let pos = 0;
  for (let i = 0; i < r; i++) pos += serializeTable([rows[i]]).length + 1;
  pos += 2;
  for (let i = 0; i < c; i++) pos += rows[r][i].length + 3;
  return pos + coerceIn(offset, 0, rows[r][c].length);
}

// --- lines ---------------------------------------------------------------------------

function linesIntersecting(text, start, end) {
  const lo = coerceIn(start, 0, text.length);
  const hi = coerceIn(end, 0, text.length);
  const first = lineStartOf(text, lo);
  const lastStart = lineStartOf(text, lo === hi ? hi : Math.max(hi - 1, lo));
  const lines = [];
  let cursor = first;
  for (;;) {
    const lineEnd = lineEndOf(text, cursor);
    lines.push({ start: cursor, end: lineEnd });
    if (cursor >= lastStart || lineEnd === text.length) break;
    cursor = lineEnd + 1;
  }
  return lines;
}

/** Where the line holding [offset] starts. */
export function lineStartOf(text, offset) {
  const i = coerceIn(offset, 0, text.length);
  if (i === 0) return 0;
  const newline = text.lastIndexOf("\n", i - 1);
  return newline === -1 ? 0 : newline + 1;
}

/** Where the line holding [offset] ends: its newline, or the end of [text]. */
export function lineEndOf(text, offset) {
  const newline = text.indexOf("\n", coerceIn(offset, 0, text.length));
  return newline === -1 ? text.length : newline;
}

// --- table sums ----------------------------------------------------------------------
//
// Spreadsheet-style formulas for a table. A cell whose words start with "="
// is a formula: what is stored stays the formula, only what is shown is the
// result. Numbers, + - * / %, parentheses, cell references (A1), ranges
// (A1:B3) and sum avg min max count. A function with no arguments, or with
// above or left, reads the cells above it in its column or to its left in
// its row, so "=sum" under a column totals it.

const ERROR = "#ERR";
const FUNCTIONS = new Set(["SUM", "TOTAL", "AVG", "AVERAGE", "MEAN", "MIN", "MAX", "COUNT"]);
const REF = /^([A-Z]{1,2})(\d{1,4})$/;
const MARKUP = /[*_~]/g;
// Kotlin's \s and \d in a pattern are ASCII-only; JavaScript's \d is too, \s is not.
const NUMBER = /^([-+\u2212]?)[ \t\n\u000b\f\r]?([$€£¥₹]?)[ \t\n\u000b\f\r]?([-+\u2212]?)(\d[\d.,']*|[.,]\d+)[ \t\n\u000b\f\r]?(%|[$€£¥₹]|[A-Za-z]{1,3})?$/;
const MAX_DECIMALS = 6;
const FAR = Number.MAX_SAFE_INTEGER;

class FormulaError extends Error {}

/** A number as a cell has it: its value and how it was written, to write a result the same way. */
function num(value, rest = {}) {
  return { value, decimals: 0, prefix: "", suffix: "", grouped: false, commaDecimal: false, percent: false, ...rest };
}

const hasUnit = (n) => n.prefix.length > 0 || n.suffix.length > 0;

class Sheet {
  constructor(rows) {
    this.rows = rows;
    this.results = new Map();
    this.visiting = new Set();
    // The formula being worked out at the top, left out of its own ranges.
    this.self = [-1, -1];
  }

  display(r, c) {
    this.self = [r, c];
    try {
      return format(this.formula(r, c));
    } catch {
      return ERROR;
    }
  }

  formula(r, c) {
    const key = `${r},${c}`;
    if (this.results.has(key)) {
      const known = this.results.get(key);
      if (known == null) throw new FormulaError();
      return known;
    }
    if (this.visiting.has(key)) throw new FormulaError();
    this.visiting.add(key);
    let result = null;
    try {
      const source = trimStart(this.rows[r][c]);
      result = new Parser(source.startsWith("=") ? source.slice(1) : source, this, r, c).parse();
    } catch {
      result = null;
    }
    this.visiting.delete(key);
    this.results.set(key, result);
    if (result == null) throw new FormulaError();
    return result;
  }

  /** A cell as a number: a formula's result, a number, or null for words. */
  cell(r, c) {
    const row = r >= 0 && r < this.rows.length ? this.rows[r] : null;
    const text = row && c >= 0 && c < row.length ? row[c] : null;
    if (text == null) return null;
    return isFormula(text) ? this.formula(r, c) : parseNumber(text);
  }

  /** One referenced cell. Empty counts as zero, words are an error. */
  ref(r, c) {
    if (r < 0 || r >= this.rows.length || c < 0) throw new FormulaError();
    const text = c < this.rows[r].length ? this.rows[r][c] : null;
    if (text == null) throw new FormulaError();
    if (isBlank(text)) return num(0);
    const n = this.cell(r, c);
    if (n == null) throw new FormulaError();
    return n;
  }

  /** The numbers in a range. Words and empty cells are skipped, as a spreadsheet does. */
  range(r1, c1, r2, c2) {
    const out = [];
    const width = this.rows.length ? Math.max(...this.rows.map((row) => row.length)) : 0;
    const rowFrom = Math.max(Math.min(r1, r2), 0);
    const rowTo = Math.min(Math.max(r1, r2), this.rows.length - 1);
    const colFrom = Math.max(Math.min(c1, c2), 0);
    const colTo = Math.min(Math.max(c1, c2), width - 1);
    for (let r = rowFrom; r <= rowTo; r++) {
      for (let c = colFrom; c <= colTo; c++) {
        if (r === this.self[0] && c === this.self[1]) continue;
        if (c >= this.rows[r].length) continue;
        const n = this.cell(r, c);
        if (n != null) out.push(n);
      }
    }
    return out;
  }
}

class Parser {
  constructor(src, sheet, row, col) {
    this.src = src;
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.i = 0;
  }

  parse() {
    const result = this.expr();
    this.skipSpace();
    if (this.i < this.src.length) throw new FormulaError();
    return result;
  }

  expr() {
    let left = this.term();
    for (;;) {
      this.skipSpace();
      const ch = this.peek();
      if (ch === "+") {
        this.i++;
        left = additive(left, this.term(), (a, b) => a + b);
      } else if (ch === "-" || ch === "\u2212") {
        this.i++;
        left = additive(left, this.term(), (a, b) => a - b);
      } else {
        return left;
      }
    }
  }

  term() {
    let left = this.unary();
    for (;;) {
      this.skipSpace();
      const ch = this.peek();
      if (ch === "*" || ch === "×") {
        this.i++;
        left = multiplicative(left, this.unary(), (a, b) => a * b);
      } else if (ch === "/" || ch === "÷") {
        this.i++;
        const right = this.unary();
        if (right.value === 0) throw new FormulaError();
        left = multiplicative(left, right, (a, b) => a / b);
      } else {
        return left;
      }
    }
  }

  unary() {
    this.skipSpace();
    const ch = this.peek();
    if (ch === "-" || ch === "\u2212") {
      this.i++;
      const inner = this.unary();
      return { ...inner, value: -inner.value };
    }
    if (ch === "+") {
      this.i++;
      return this.unary();
    }
    return this.postfix(this.primary());
  }

  postfix(value) {
    this.skipSpace();
    if (this.peek() === "%") {
      this.i++;
      return { ...value, value: value.value / 100, percent: false };
    }
    return value;
  }

  primary() {
    this.skipSpace();
    const ch = this.peek();
    if (ch == null) throw new FormulaError();
    if (ch === "(") {
      this.i++;
      const inner = this.expr();
      this.expect(")");
      return inner;
    }
    if (isDigit(ch) || ch === ".") return this.number();
    if (isLetter(ch)) {
      const upper = this.word().toUpperCase();
      this.skipSpace();
      if (FUNCTIONS.has(upper)) return this.call(upper);
      const ref = parseRef(upper);
      if (ref == null) throw new FormulaError();
      return this.sheet.ref(ref[0], ref[1]);
    }
    throw new FormulaError();
  }

  call(name) {
    const values = [];
    if (this.peek() === "(") {
      this.i++;
      this.skipSpace();
      if (this.peek() === ")") {
        this.i++;
        values.push(...this.above());
      } else {
        for (;;) {
          values.push(...this.argument());
          this.skipSpace();
          const ch = this.peek();
          if (ch === "," || ch === ";") this.i++;
          else if (ch === ")") {
            this.i++;
            break;
          } else throw new FormulaError();
        }
      }
    } else {
      values.push(...this.above());
    }
    return aggregate(name, values);
  }

  argument() {
    this.skipSpace();
    const mark = this.i;
    if (isLetter(this.peek())) {
      const word = this.word().toUpperCase();
      this.skipSpace();
      switch (word) {
        case "ABOVE":
        case "UP":
          return this.above();
        case "LEFT":
          return this.col === 0 ? [] : this.sheet.range(this.row, 0, this.row, this.col - 1);
        case "BELOW":
        case "DOWN":
          return this.sheet.range(this.row + 1, this.col, FAR, this.col);
        case "RIGHT":
          return this.sheet.range(this.row, this.col + 1, this.row, FAR);
      }
      const from = parseRef(word);
      if (from != null && this.peek() === ":") {
        this.i++;
        this.skipSpace();
        const to = parseRef(this.word().toUpperCase());
        if (to == null) throw new FormulaError();
        return this.sheet.range(from[0], from[1], to[0], to[1]);
      }
      this.i = mark;
    }
    return [this.expr()];
  }

  above() {
    return this.row === 0 ? [] : this.sheet.range(0, this.col, this.row - 1, this.col);
  }

  number() {
    const start = this.i;
    while (this.i < this.src.length && (isDigit(this.src[this.i]) || this.src[this.i] === ".")) this.i++;
    const value = toDoubleOrNull(this.src.substring(start, this.i));
    if (value == null) throw new FormulaError();
    // A typed constant sets no precision; the cells it meets do.
    return num(value);
  }

  word() {
    const start = this.i;
    while (this.i < this.src.length && isLetterOrDigit(this.src[this.i])) this.i++;
    return this.src.substring(start, this.i);
  }

  expect(ch) {
    this.skipSpace();
    if (this.peek() !== ch) throw new FormulaError();
    this.i++;
  }

  peek() {
    return this.i < this.src.length ? this.src[this.i] : null;
  }

  skipSpace() {
    while (this.i < this.src.length && isWhitespace(this.src[this.i])) this.i++;
  }
}

// Kotlin's toDoubleOrNull for a run of digits and dots: ASCII digits only.
function toDoubleOrNull(text) {
  return /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(text) ? Number(text) : null;
}

function aggregate(name, values) {
  if (name === "COUNT") return num(values.length);
  const style = values.reduce((acc, n) => (acc == null ? n : additive(acc, n, (a) => a)), null) ?? num(0);
  const sum = () => values.reduce((acc, n) => acc + n.value, 0);
  switch (name) {
    case "SUM":
    case "TOTAL":
      return { ...style, value: sum() };
    case "AVG":
    case "AVERAGE":
    case "MEAN":
      if (!values.length) throw new FormulaError();
      return { ...style, value: sum() / values.length };
    case "MIN":
      return { ...style, value: values.length ? values.reduce((m, n) => Math.min(m, n.value), Infinity) : 0 };
    case "MAX":
      return { ...style, value: values.length ? values.reduce((m, n) => Math.max(m, n.value), -Infinity) : 0 };
    default:
      throw new FormulaError();
  }
}

/** Adding keeps a shared unit ($ + $ = $) and drops it when they differ. */
function additive(a, b, op) {
  let prefix = "";
  let suffix = "";
  if (!hasUnit(a)) [prefix, suffix] = [b.prefix, b.suffix];
  else if (!hasUnit(b)) [prefix, suffix] = [a.prefix, a.suffix];
  else if (a.prefix === b.prefix && a.suffix === b.suffix) [prefix, suffix] = [a.prefix, a.suffix];
  return num(op(a.value, b.value), {
    decimals: Math.max(a.decimals, b.decimals),
    prefix,
    suffix,
    grouped: a.grouped || b.grouped,
    commaDecimal: a.commaDecimal || b.commaDecimal,
    percent: a.percent && b.percent,
  });
}

/** Multiplying keeps the one unit there is ($4 × 3 = $12, $80 × 15% = $12) and drops two. */
function multiplicative(a, b, op) {
  let prefix = "";
  let suffix = "";
  if (hasUnit(a) && !hasUnit(b)) [prefix, suffix] = [a.prefix, a.suffix];
  else if (hasUnit(b) && !hasUnit(a)) [prefix, suffix] = [b.prefix, b.suffix];
  return num(op(a.value, b.value), {
    decimals: Math.max(a.decimals, b.decimals),
    prefix,
    suffix,
    grouped: a.grouped || b.grouped,
    commaDecimal: a.commaDecimal || b.commaDecimal,
    percent: a.percent !== b.percent && !hasUnit(a) && !hasUnit(b),
  });
}

function isFormula(text) {
  return trimStart(text).startsWith("=");
}

/** "B3" is row 2, column 1: [2, 1]. Null when it is not a cell. */
function parseRef(word) {
  const m = REF.exec(word.toUpperCase());
  if (!m) return null;
  const row = Number(m[2]);
  if (row < 1) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [row - 1, col - 1];
}

/** Column 0 is A, 25 is Z, 26 is AA. */
function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A cell's words as a number, such as 12, $4.50, 1,200 or 15%, or null. */
function parseNumber(raw) {
  const text = trim(raw.replace(MARKUP, "")).replaceAll("\u00a0", " ");
  if (!text) return null;
  const m = NUMBER.exec(text);
  if (!m) return null;
  const [, sign1 = "", prefix = "", sign2 = "", digits, suffix = ""] = m;
  if (sign1 && sign2) return null;
  const sign = sign1 + sign2;
  const negative = sign === "-" || sign === "\u2212";
  let grouped = false;
  let commaDecimal = false;
  const lastDot = digits.lastIndexOf(".");
  const lastComma = digits.lastIndexOf(",");
  const count = (ch) => digits.split(ch).length - 1;
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) decimalAt = Math.max(lastDot, lastComma);
  else if (lastComma >= 0) decimalAt = count(",") === 1 && digits.length - lastComma - 1 !== 3 ? lastComma : -1;
  else if (lastDot >= 0) decimalAt = count(".") === 1 ? lastDot : -1;
  const intPart = decimalAt >= 0 ? digits.substring(0, decimalAt) : digits;
  const fracPart = decimalAt >= 0 ? digits.substring(decimalAt + 1) : "";
  if (/[^0-9]/.test(fracPart)) return null;
  const intDigits = intPart.replace(/[^0-9]/g, "");
  if (intDigits.length !== intPart.length) {
    grouped = true;
    // Separators group threes: 1,200 or 1.200.000, never 12,00,0.
    const groups = intPart.split(/[,.']/);
    if (groups.slice(1).some((g) => g.length !== 3) || groups[0].length < 1 || groups[0].length > 3) return null;
  }
  if (decimalAt >= 0 && digits[decimalAt] === ",") commaDecimal = true;
  const value = Number(`${intDigits || "0"}.${fracPart || "0"}`);
  const percent = suffix === "%";
  const signed = negative ? -value : value;
  return num(percent ? signed / 100 : signed, {
    decimals: Math.min(fracPart.length, MAX_DECIMALS),
    prefix,
    suffix: percent ? "" : suffix,
    grouped,
    commaDecimal,
    percent,
  });
}

// What Java's new BigDecimal(v).setScale(decimals, HALF_UP).abs() writes:
// toFixed rounds the exact binary value with halves away from zero, the same,
// up to 1e21, past which a double is a whole number anyway.
function plainFixed(v, decimals) {
  const a = Math.abs(v);
  if (a < 1e21) return a.toFixed(decimals);
  return BigInt(a).toString() + (decimals > 0 ? "." + "0".repeat(decimals) : "");
}

/** A result written the way its cells were: their decimals, unit, grouping and decimal comma. */
function format(result) {
  const n = result.percent ? { ...result, value: result.value * 100 } : result;
  if (!Number.isFinite(n.value)) throw new FormulaError();
  let decimals = n.decimals;
  const exact = Math.sign(n.value) * Number(plainFixed(n.value, decimals));
  if (Math.abs(exact - n.value) > 1e-9) decimals = Math.max(decimals, 2);
  let text = plainFixed(n.value, decimals);
  if (decimals > n.decimals) {
    text = text.replace(/0+$/, "");
    const dot = text.indexOf(".");
    const keep = dot + 1 + n.decimals;
    if (dot >= 0 && text.length < keep) text = text.padEnd(keep, "0");
    text = text.replace(/\.+$/, "");
  }
  const dot = text.indexOf(".");
  let int = dot >= 0 ? text.substring(0, dot) : text;
  const frac = dot >= 0 ? text.substring(dot + 1) : "";
  const groupSep = n.commaDecimal ? "." : ",";
  const decimalSep = n.commaDecimal ? "," : ".";
  if (n.grouped) {
    const groups = [];
    for (let end = int.length; end > 0; end -= 3) groups.unshift(int.substring(Math.max(0, end - 3), end));
    int = groups.join(groupSep);
  }
  const body = frac ? `${int}${decimalSep}${frac}` : int;
  const negative = n.value < 0 && /[1-9]/.test(body);
  const spacedSuffix = isLetter(n.suffix[0]) ? ` ${n.suffix}` : n.suffix;
  return (negative ? "-" : "") + n.prefix + body + (n.percent ? "%" : spacedSuffix);
}

export const TableMath = Object.freeze({
  ERROR,
  isFormula,
  /** True when [text] reads as a plain number, such as 12, $4.50, 1,200 or 15%. */
  isNumber: (text) => parseNumber(text) != null,
  /** Each formula cell's result, shaped like [rows]; null for a cell that is not a formula. */
  evaluate(rows) {
    const sheet = new Sheet(rows);
    return rows.map((row, r) => row.map((text, c) => (isFormula(text) ? sheet.display(r, c) : null)));
  },
  parseRef,
  columnName,
});

// The lines of a list: an entry kept in a checklist collection as an ongoing
// list (Weekly staples in Shopping) rather than an item to tick off. Its
// lines are the checklist lines of its note, "- [ ] " or "- [x] ", the same
// markup the phone's note editor writes.
//
// ListLines.kt is the phone's copy of all of this, and the shared vector
// (listCases in desktop-inbox-vector.json) holds the two to the same results.
//
// A line is named by where it is among the checklist lines and by its words,
// so an edit still finds it when a line above was added or removed since.

const OPEN = "- [ ] ";
const DONE = "- [x] ";

function parse(line) {
  if (line.startsWith(OPEN)) return { checked: false, text: line.slice(OPEN.length) };
  if (line.startsWith(DONE) || line.startsWith("- [X] ")) return { checked: true, text: line.slice(OPEN.length) };
  return null;
}

/** The checklist lines of [note]: [{ index, text, checked }], index counting only those lines. */
export function listLines(note) {
  const out = [];
  for (const line of (note ?? "").split("\n")) {
    const p = parse(line);
    if (p) out.push({ index: out.length, text: p.text.trim(), checked: p.checked });
  }
  return out;
}

/** Where in note.split("\n") the checklist line meant by [index] and [text] is, or -1. */
function find(lines, index, text) {
  const want = text.trim();
  let n = 0;
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    const p = parse(lines[i]);
    if (!p) continue;
    if (p.text.trim() === want) {
      if (n === index) return i;
      if (first < 0) first = i;
    }
    n++;
  }
  return first;
}

/** [note] with that line ticked or unticked, or null when it is not there. */
export function tickLine(note, index, text, checked) {
  const lines = (note ?? "").split("\n");
  const at = find(lines, index, text);
  if (at < 0) return null;
  lines[at] = (checked ? DONE : OPEN) + parse(lines[at]).text;
  return lines.join("\n");
}

/** [note] with a new open line: at checklist position [index] when given, else after the last one. */
export function addLine(note, text, index = null) {
  const words = text.replace(/\s+/g, " ").trim();
  if (!words) return note ?? "";
  const lines = note ? note.split("\n") : [];
  const at = [];
  lines.forEach((line, i) => parse(line) && at.push(i));
  let insert;
  if (index !== null && index < at.length) insert = at[index];
  else if (at.length) insert = at[at.length - 1] + 1;
  else insert = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  lines.splice(insert, 0, OPEN + words);
  return lines.join("\n");
}

/** [note] without that line, or null when it is not there. */
export function removeLine(note, index, text) {
  const lines = (note ?? "").split("\n");
  const at = find(lines, index, text);
  if (at < 0) return null;
  lines.splice(at, 1);
  return lines.join("\n");
}

/** [note] with that line's words changed, ticked or not as it was, or null when it is not there. */
export function renameLine(note, index, text, to) {
  const words = to.replace(/\s+/g, " ").trim();
  if (!words) return null;
  const lines = (note ?? "").split("\n");
  const at = find(lines, index, text);
  if (at < 0) return null;
  lines[at] = (parse(lines[at]).checked ? DONE : OPEN) + words;
  return lines.join("\n");
}

function marks(lines) {
  const at = [];
  lines.forEach((line, i) => parse(line) && at.push(i));
  return at;
}

/**
 * [note] with that line moved so it is the checklist line at [to], the way a
 * drag reorders a list; null when it is not there or [to] is past the end.
 */
export function moveLine(note, index, text, to) {
  const lines = (note ?? "").split("\n");
  const at = find(lines, index, text);
  const from = marks(lines).indexOf(at);
  if (at < 0 || to < 0 || to >= marks(lines).length) return null;
  if (from === to) return note ?? "";
  const [moving] = lines.splice(at, 1);
  const rest = marks(lines);
  lines.splice(to < rest.length ? rest[to] : rest[rest.length - 1] + 1, 0, moving);
  return lines.join("\n");
}

/** [note] with every line unticked: the list ready to use again. */
export function resetLines(note) {
  return (note ?? "").split("\n").map((line) => (parse(line)?.checked ? OPEN + parse(line).text : line)).join("\n");
}

/**
 * A note made into a list. One that already has checklist lines is kept as it
 * is; otherwise every line with words becomes one, bullets and numbers dropped.
 */
export function linesFromPlain(note) {
  if (!note) return "";
  if (listLines(note).length) return note;
  return note.split("\n").map((line) => {
    const words = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    return words ? OPEN + words : line;
  }).join("\n");
}

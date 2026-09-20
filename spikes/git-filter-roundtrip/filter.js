// Spike only: regex-based Python handling, single-line comments, one-shot filter mode.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MARK = /#~([0-9a-z]{4})?(?: (.*?))?(\r?\n|$)/;

function splitLines(s) {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function autoId(file, text, n) {
  const hex = crypto.createHash("sha1").update(file + "\0" + text + "\0" + n).digest("hex");
  return parseInt(hex.slice(0, 8), 16).toString(36).padStart(4, "0").slice(-4);
}

function sidecarPath(file) {
  return path.join(".agents", "comments", file + ".md");
}

function readSidecar(file) {
  const out = new Map();
  let raw;
  try { raw = fs.readFileSync(sidecarPath(file), "utf8"); } catch { return out; }
  let id = null;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^## ([0-9a-z]{4})$/.exec(line);
    if (h) { id = h[1]; out.set(id, ""); }
    else if (id && line.trim()) out.set(id, line.trim());
  }
  return out;
}

// Yields [line, match, id, text] for each marked line; id is assigned deterministically when absent.
function* marked(file, content) {
  const seen = new Map();
  for (const line of splitLines(content)) {
    const m = MARK.exec(line);
    if (!m || (!m[1] && m[2] === undefined)) { yield [line, null]; continue; }
    let id = m[1];
    if (!id) {
      const n = seen.get(m[2]) || 0;
      seen.set(m[2], n + 1);
      id = autoId(file, m[2], n);
    }
    yield [line, m, id, m[2]];
  }
}

function clean(file, content) {
  let out = "";
  for (const [line, m, id] of marked(file, content)) {
    out += m ? line.slice(0, m.index) + "#~" + id + m[3] : line;
  }
  return out;
}

function smudge(file, content) {
  const bodies = readSidecar(file);
  let out = "", missing = 0;
  for (const [line, m, id, text] of marked(file, content)) {
    if (!m) { out += line; continue; }
    const body = text !== undefined ? text : bodies.get(id);
    if (body === undefined) missing++;
    out += line.slice(0, m.index) + "#~" + id + (body ? " " + body : "") + m[3];
  }
  if (missing) process.stderr.write(`[smudge] ${file}: ${missing} marker(s) had no body yet\n`);
  return out;
}

function sync(file) {
  const content = fs.readFileSync(file, "utf8");
  const bodies = readSidecar(file);
  let out = "";
  for (const [line, m, id, text] of marked(file, content)) {
    if (!m) { out += line; continue; }
    if (text !== undefined) bodies.set(id, text);
    out += line.slice(0, m.index) + "#~" + id + (text ? " " + text : "") + m[3];
  }
  if (out !== content) fs.writeFileSync(file, out);
  const sc = sidecarPath(file);
  fs.mkdirSync(path.dirname(sc), { recursive: true });
  fs.writeFileSync(sc, [...bodies].map(([id, b]) => `## ${id}\n${b}\n`).join("\n"));
}

const [mode, file] = process.argv.slice(2);
if (mode === "sync") {
  sync(file);
} else {
  const input = fs.readFileSync(0, "utf8");
  process.stdout.write(mode === "clean" ? clean(file, input) : smudge(file, input));
}

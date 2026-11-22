// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and changes every file or none. The whole contract is
// SPEC.md; this file implements it. Node 22, standard library alone; run as
// `node main.ts [options] [PATCH]` with the working directory as the root of
// a tree of text files.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// Files: a file is its lines, its line break and whether it ends with one
// (SPEC.md section 3). The break is CRLF when the first line feed follows a
// carriage return, LF otherwise; an empty file has no lines and no break.
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Matching lines at three tiers (SPEC.md section 5): tier 0 every line equal,
// tier 1 every line equal once trailing spaces and tabs are removed, tier 2
// every line equal once leading and trailing spaces and tabs are removed.
function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function matchLine(fileLine: string, oldLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return trimEndWs(fileLine) === trimEndWs(oldLine);
  return trimWs(fileLine) === trimWs(oldLine);
}

function matchAt(lines: string[], old: string[], at: number, tier: number): boolean {
  for (let k = 0; k < old.length; k++) {
    if (!matchLine(lines[at + k]!, old[k]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    if (matchAt(lines, old, i, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which the old lines occur, with every occurrence there. */
function findFirstTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. `noeol` is set when a `\`
 *  line follows it (as in `\ No newline at end of file`). */
interface BodyOp {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noeol: boolean;
}

function oldLinesOf(ops: BodyOp[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

/** Whether a `\` line follows the hunk or chunk's last context or `+` line. */
function lastCtxOrAddNoeol(ops: BodyOp[]): boolean {
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i]!;
    if (o.kind === 'ctx' || o.kind === 'add') return o.noeol;
  }
  return false;
}

function reindent(line: string, f: string, p: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** The lines that replace the matched lines: a context line is written as the
 *  file's own matched line, never the patch's; at tier 2 every other line is
 *  re-indented from the old block's indent to the file's indent. */
function buildReplacement(ops: BodyOp[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadingWs(fileLines[pos] ?? '');
    const firstOld = ops.find((o) => o.kind !== 'add');
    p = firstOld === undefined ? '' : leadingWs(firstOld.text);
  }
  for (const o of ops) {
    if (o.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (o.kind === 'del') {
      oi++;
    } else {
      out.push(tier === 2 ? reindent(o.text, f, p) : o.text);
    }
  }
  return out;
}

/** SEARCH/REPLACE blocks have no context lines, so at tier 2 every new line
 *  is re-indented; at tiers 0 and 1 the new lines are written as they are. */
function buildReplacementSr(oldL: string[], newL: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return [...newL];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldL[0] ?? '');
  return newL.map((l) => reindent(l, f, p));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, renderDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// Unified diffs (SPEC.md section 6).

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

interface UnifiedHunk {
  a: number;
  ops: BodyOp[];
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  gitOld: string | null;
  gitNew: string | null;
  hunks: UnifiedHunk[];
}

/** A `---`/`+++` path: the text after the four characters, up to the first
 *  tab, with surrounding spaces removed and one leading `a/` or `b/` off. */
function unifiedPath(s: string): string {
  const t = s.split('\t')[0]!.trim();
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

/** A hunk's body: the lines after its header that start with ` `, `-`, `+`
 *  or `\`, or are empty. Empty lines at the end of a body are not part of it. */
function parseHunkBody(lines: string[], i: number): { ops: BodyOp[]; next: number } {
  const raw: string[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
      raw.push(line);
      i++;
    } else break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const ops: BodyOp[] = [];
  for (const line of raw) {
    if (line.startsWith('\\')) {
      if (ops.length > 0) ops[ops.length - 1]!.noeol = true;
      continue;
    }
    if (line === '') ops.push({ kind: 'ctx', text: '', noeol: false });
    else if (line[0] === ' ') ops.push({ kind: 'ctx', text: line.slice(1), noeol: false });
    else if (line[0] === '-') ops.push({ kind: 'del', text: line.slice(1), noeol: false });
    else ops.push({ kind: 'add', text: line.slice(1), noeol: false });
  }
  return { ops, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  const fresh = (gitOld: string | null, gitNew: string | null): UnifiedSection => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    gitOld,
    gitNew,
    hunks: [],
  });
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.oldPath = unifiedPath(line.slice(4));
          cur.newPath = unifiedPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = unifiedPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const body = parseHunkBody(lines, i + 1);
        cur.hunks.push({ a: Number(m[1]), ops: body.ops });
        inHeader = false;
        i = body.next;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = fresh(null, null);
      sections.push(cur);
      inHeader = true;
      cur.oldPath = unifiedPath(line.slice(4));
      cur.newPath = unifiedPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (cur !== null && !inHeader && line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), ops: body.ops });
      i = body.next;
      continue;
    }
    if (cur === null && line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) edits.push(unifiedEdit(s, strict));
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** A section's hunks, applied in order to the file's lines. `d` is the sum
 *  over the hunks applied so far of (new length minus old length). */
function applyHunks(text: string, hunks: UnifiedHunk[], strict: boolean, path: string): string {
  const doc = parseDoc(text);
  let d = 0;
  for (const h of hunks) {
    const o = oldLinesOf(h.ops);
    if (o.length === 0) {
      const insertPos = Math.min(Math.max(h.a + d, 0), doc.lines.length);
      const atEnd = insertPos === doc.lines.length;
      const rep = buildReplacement(h.ops, doc.lines, insertPos, 0);
      doc.lines.splice(insertPos, 0, ...rep);
      if (atEnd) doc.final = !lastCtxOrAddNoeol(h.ops);
      d += rep.length;
      continue;
    }
    const found = findFirstTier(doc.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const rep = buildReplacement(h.ops, doc.lines, best, found.tier);
    const atEnd = best + o.length === doc.lines.length;
    doc.lines.splice(best, o.length, ...rep);
    if (atEnd) doc.final = !lastCtxOrAddNoeol(h.ops);
    d += rep.length - o.length;
  }
  return renderDoc(doc);
}

function unifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  const oldRaw = s.oldPath ?? s.renameFrom ?? s.gitOld;
  const newRaw = s.newPath ?? s.renameTo ?? s.gitNew;
  const oldPath = oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === null || newRaw === '/dev/null' ? null : newRaw;
  let kind: 'create' | 'delete' | 'move' | 'change' | 'noop';
  if (oldPath === null && newPath === null) kind = 'noop';
  else if ((s.newFile || oldPath === null) && newPath !== null) kind = 'create';
  else if ((s.deletedFile || newPath === null) && oldPath !== null) kind = 'delete';
  else if (oldPath !== null && newPath !== null && oldPath !== newPath) kind = 'move';
  else if (oldPath !== null) kind = 'change';
  else kind = 'noop';
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (kind === 'noop') return;
    if (kind === 'create') {
      const target = newPath!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      let lastPlus: BodyOp | null = null;
      for (const h of s.hunks) {
        for (const o of h.ops) {
          if (o.kind === 'add') {
            plus.push(o.text);
            lastPlus = o;
          }
        }
      }
      const final = lastPlus === null || !lastPlus.noeol;
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const target = oldPath!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (kind === 'move') {
      const from = oldPath!;
      const to = newPath!;
      const text = tree.get(from);
      if (text === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const out = applyHunks(text, s.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, out);
      tree.moves.push({ old: from, new: to });
      return;
    }
    const target = oldPath!;
    const text = tree.get(target);
    if (text === null) throw new Fail('missing', target);
    tree.now.set(target, applyHunks(text, s.hunks, strict, target));
  };
}

// SEARCH/REPLACE blocks (SPEC.md section 7).

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const found = findFirstTier(doc.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = buildReplacementSr(oldL, newL, doc.lines, pos, found.tier);
    doc.lines.splice(pos, oldL.length, ...rep);
    tree.now.set(path, renderDoc(doc));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (eq < 0 && l.trimEnd() === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && l.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (eq < 0 && l.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// V4A patches (SPEC.md section 8).

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  ops: BodyOp[];
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const doc = parseDoc(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let k = cursor; k < doc.lines.length; k++) {
            if (matchLine(doc.lines[k]!, chunk.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const o = oldLinesOf(chunk.ops);
      if (o.length === 0) {
        const insertPos = chunk.eof ? doc.lines.length : cursor;
        const rep = buildReplacement(chunk.ops, doc.lines, insertPos, 0);
        doc.lines.splice(insertPos, 0, ...rep);
        cursor = insertPos + rep.length;
        continue;
      }
      let foundPos = -1;
      let foundTier = 0;
      for (const t of tiers(strict)) {
        for (let k = cursor; k + o.length <= doc.lines.length; k++) {
          if (chunk.eof && k + o.length !== doc.lines.length) continue;
          if (matchAt(doc.lines, o, k, t)) {
            foundPos = k;
            foundTier = t;
            break;
          }
        }
        if (foundPos >= 0) break;
      }
      if (foundPos < 0) throw new Fail('no-match', path);
      const rep = buildReplacement(chunk.ops, doc.lines, foundPos, foundTier);
      doc.lines.splice(foundPos, o.length, ...rep);
      cursor = foundPos + rep.length;
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const content: number[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push(i);
      i++;
    }
    while (content.length > 0 && blank(lines[content[content.length - 1]!]!)) content.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const j of content) {
        const l = lines[j]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aAddEdit(path, addLines));
    } else if (kind === 'delete') {
      for (const j of content) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let rest = content;
      if (rest.length > 0 && lines[rest[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[rest[0]!]!.slice(13).trim();
        rest = rest.slice(1);
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let closed = false;
      for (const j of rest) {
        const l = lines[j]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
          closed = false;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          }
          closed = true;
          continue;
        }
        if (l.startsWith('***')) throw new Exit2(`error: parse ${j + 1}`);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (closed) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, eof: false, ops: [] };
          }
          if (l === '') cur.ops.push({ kind: 'ctx', text: '', noeol: false });
          else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1), noeol: false });
          else if (l[0] === '-') cur.ops.push({ kind: 'del', text: l.slice(1), noeol: false });
          else cur.ops.push({ kind: 'add', text: l.slice(1), noeol: false });
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const wasNew = tree.original(m.new);
    const nowOld = tree.now.get(m.old);
    const nowNew = tree.now.get(m.new);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      suppressed.add(`D ${m.old}`);
      suppressed.add(`A ${m.new}`);
    }
  }
  const changed: { p: string; now: string | null }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const tag = was === null ? 'A' : now === null ? 'D' : 'M';
    changed.push({ p, now });
    if (suppressed.has(`${tag} ${p}`)) continue;
    rows.push({ key: p, line: `${tag} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) if (c.now === null) rmSync(c.p, { force: true });
    for (const c of changed) {
      if (c.now === null) continue;
      mkdirSync(dirname(c.p), { recursive: true });
      writeFileSync(c.p, c.now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

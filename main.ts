// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded: new path -> old path, for the `R` output line. */
  readonly moves = new Map<string, string>();
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

/** One line of O: a context line (also in N) or an old-only line. */
interface OLine {
  text: string;
  ctx: boolean;
}
/** One line of N: a context line (ctx: its index into O) or an added line (ctx: -1). */
interface NLine {
  text: string;
  ctx: number;
}

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

/** Every 0-based position where O occurs in lines at tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0..2, or only 0 with --strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * The lines N writes when O matched at `at` in fileLines at `tier`: context lines are the file's
 * own matched lines; at tier 2 every other line is re-indented from O's first line to the file's.
 */
function buildNew(n: NLine[], o: OLine[], fileLines: string[], at: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadST(fileLines[at] ?? '');
    p = leadST(o[0]!.text);
  }
  const out: string[] = [];
  for (const item of n) {
    if (item.ctx >= 0) {
      out.push(fileLines[at + item.ctx] ?? '');
    } else {
      let t = item.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** A: the hunk's old start, 1-based. */
  a: number;
  o: OLine[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** Whether a `\` line follows the hunk's last `+` line (null: the hunk has no `+` line). */
  plusNoEol: boolean | null;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  delete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}
function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: OLine[] = [];
  const n: NLine[] = [];
  const kinds: string[] = [];
  for (const b of body) {
    if (b === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: o.length - 1 });
      kinds.push('ctx');
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: '', ctx: o.length - 1 });
      kinds.push('ctx');
    } else if (b[0] === '-') {
      o.push({ text: b.slice(1), ctx: false });
      kinds.push('old');
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: -1 });
      kinds.push('add');
    } else if (b[0] === '\\') {
      kinds.push('bs');
    }
  }
  let noEol = false;
  let plusNoEol: boolean | null = null;
  for (let j = kinds.length - 1; j >= 0; j--) {
    if (kinds[j] === 'ctx' || kinds[j] === 'add') {
      noEol = kinds[j + 1] === 'bs';
      break;
    }
  }
  for (let j = kinds.length - 1; j >= 0; j--) {
    if (kinds[j] === 'add') {
      plusNoEol = kinds[j + 1] === 'bs';
      break;
    }
  }
  return { a, o, n, noEol, plusNoEol };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let plusNew: string | null = null;
  let newFile = false;
  let delFile = false;
  let state: 'outside' | 'header' | 'between' = 'outside';

  const finishSection = (): void => {
    if (cur === null) return;
    // `/dev/null` means no file.
    const noFile = (p: string | null): string | null => (p === '/dev/null' ? null : p);
    const oldPath = noFile(pairOld ?? renOld ?? diffOld);
    const newPath = noFile(pairNew ?? plusNew ?? renNew ?? diffNew);
    cur.oldPath = oldPath;
    cur.newPath = newPath;
    cur.create = oldPath === null || newFile;
    cur.delete = newPath === null || delFile;
    sections.push(cur);
    cur = null;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    finishSection();
    diffOld = oldP;
    diffNew = newP;
    pairOld = null;
    pairNew = null;
    renOld = null;
    renNew = null;
    plusNew = null;
    newFile = false;
    delFile = false;
    cur = { oldPath: null, newPath: null, create: false, delete: false, hunks: [] };
    state = 'header';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(m[1]!, m[2]!);
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
        pairOld = stripPrefix(headerPath(line));
        pairNew = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header') {
        pairOld = stripPrefix(headerPath(line));
        pairNew = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      startSection(null, null);
      pairOld = stripPrefix(headerPath(line));
      pairNew = stripPrefix(headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      state = 'between';
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        plusNew = stripPrefix(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        renOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        delFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishSection();
  return sections;
}

/** Apply a section's hunks, in order, to lines; returns the new lines and final-break flag. */
function applyHunks(lines: string[], finalIn: boolean, hunks: Hunk[], strict: boolean, path: string): { lines: string[]; final: boolean } {
  let cur = [...lines];
  let final = finalIn;
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.o.map((x) => x.text);
    if (oTexts.length === 0) {
      const oldLen = cur.length;
      const pos = Math.min(h.a + d, oldLen);
      const nLines = buildNew(h.n, h.o, cur, pos, 0);
      cur = [...cur.slice(0, pos), ...nLines, ...cur.slice(pos)];
      if (pos === oldLen) final = !h.noEol;
      d += nLines.length;
      continue;
    }
    const found = findTier(cur, oTexts, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const nLines = buildNew(h.n, h.o, cur, best, found.tier);
    const atEnd = best + oTexts.length === cur.length;
    cur = [...cur.slice(0, best), ...nLines, ...cur.slice(best + oTexts.length)];
    if (atEnd) final = !h.noEol;
    d += nLines.length - oTexts.length;
  }
  return { lines: cur, final };
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.create) {
      const p = newP ?? oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const item of h.n) if (item.ctx < 0) plus.push(item.text);
        if (h.plusNoEol !== null) noEol = h.plusNoEol;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.delete) {
      const p = oldP ?? newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = splitFile(text);
      const out = applyHunks(f.lines, f.final, sec.hunks, strict, oldP);
      tree.now.set(newP, joinFile(out.lines, f.br, out.final));
      tree.now.set(oldP, null);
      tree.moves.set(newP, oldP);
      return;
    }
    const p = oldP ?? newP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const f = splitFile(text);
    const out = applyHunks(f.lines, f.final, sec.hunks, strict, p);
    tree.now.set(p, joinFile(out.lines, f.br, out.final));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1; // index of the previous block's `>>>>>>> REPLACE` line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const f = splitFile(cur);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const nItems: NLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
    const oItems: OLine[] = b.oldLines.map((t) => ({ text: t, ctx: false }));
    const nLines = buildNew(nItems, oItems, f.lines, at, found.tier);
    const out = [...f.lines.slice(0, at), ...nLines, ...f.lines.slice(at + b.oldLines.length)];
    tree.now.set(p, joinFile(out, f.br, f.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => srEdit(b, strict));
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  /** The anchor text, or null when the chunk has none. */
  anchor: string | null;
  eof: boolean;
  o: OLine[];
  n: NLine[];
}

interface VRawLine {
  t: string;
  n: number;
}

function buildVChunk(anchor: string | null, eof: boolean, body: string[]): VChunk {
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: o.length - 1 });
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: '', ctx: o.length - 1 });
    } else if (b[0] === '-') {
      o.push({ text: b.slice(1), ctx: false });
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: -1 });
    }
  }
  return { anchor, eof, o, n };
}

/** Parse an Update File section's lines into its Move to and chunks. */
function parseUpdateSection(raw: VRawLine[], hdrLine: number): { moveTo: string | null; chunks: VChunk[] } {
  const lines = [...raw];
  while (lines.length > 0 && blank(lines[lines.length - 1]!.t)) lines.pop();
  let moveTo: string | null = null;
  let idx = 0;
  if (lines.length > 0 && lines[0]!.t.startsWith('*** Move to: ')) {
    moveTo = lines[0]!.t.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const finishChunk = (): void => {
    if (cur !== null) {
      chunks.push(buildVChunk(cur.anchor, cur.eof, cur.body));
      cur = null;
    }
  };
  while (idx < lines.length) {
    const l = lines[idx]!.t;
    const no = lines[idx]!.n;
    if (l.startsWith('@@')) {
      finishChunk();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      idx++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      finishChunk();
      idx++;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(l);
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  finishChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${hdrLine}`);
  return { moveTo, chunks };
}

/** The first line at or after the cursor equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** The first occurrence of O at or after the cursor, at the first tier with one. */
function findChunkOcc(lines: string[], o: string[], cursor: number, eof: boolean, strict: boolean): { at: number; tier: number } | null {
  for (let t = 0; t <= (strict ? 0 : 2); t++) {
    const occ = occurrences(lines, o, t).filter((p) => p >= cursor && (!eof || p + o.length === lines.length));
    if (occ.length > 0) return { at: occ[0]!, tier: t };
  }
  return null;
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, hdrLine: number, raw: VRawLine[], strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { t: l, n: no } of raw) {
      if (l === '') fileLines.push('');
      else if (l[0] === '+') fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const { t: l, n: no } of raw) {
      if (!blank(l)) throw new Exit2(`error: parse ${no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const { moveTo, chunks } = parseUpdateSection(raw, hdrLine);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(cur);
    let lines = [...f.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findAnchor(lines, ch.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const oTexts = ch.o.map((x) => x.text);
      if (oTexts.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const nLines = buildNew(ch.n, ch.o, lines, at, 0);
        lines = [...lines.slice(0, at), ...nLines, ...lines.slice(at)];
        cursor = at + nLines.length;
        continue;
      }
      const occ = findChunkOcc(lines, oTexts, cursor, ch.eof, strict);
      if (occ === null) throw new Fail('no-match', path);
      const nLines = buildNew(ch.n, ch.o, lines, occ.at, occ.tier);
      lines = [...lines.slice(0, occ.at), ...nLines, ...lines.slice(occ.at + oTexts.length)];
      cursor = occ.at + nLines.length;
    }
    const out = joinFile(lines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.set(moveTo, path);
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
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const hdr = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (hdr.startsWith('*** Add File: ')) {
      kind = 'add';
      path = hdr.slice('*** Add File: '.length).trim();
    } else if (hdr.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = hdr.slice('*** Delete File: '.length).trim();
    } else if (hdr.startsWith('*** Update File: ')) {
      kind = 'update';
      path = hdr.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const hdrLine = i + 1;
    i++;
    const raw: VRawLine[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ t: l, n: i + 1 });
      i++;
    }
    edits.push(v4aEdit(kind, path, hdrLine, raw, strict));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

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
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; line: string }[] = [];
  const rNews = new Set<string>();
  const rOlds = new Set<string>();
  for (const [nw, old] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      rNews.add(nw);
      rOlds.add(old);
    }
  }
  for (const p of changed) {
    if (rNews.has(p) || rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
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

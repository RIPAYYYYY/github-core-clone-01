// gitobj.ts: the git object model the forge is built on. Real SHA-1 git objects (commit, tree, blob,
// tag) in one content-addressed store, pkt-line framing, pack write/read (plain objects plus OFS/REF
// delta resolution), history walks (ancestry, merge-base, shallow/deepen selection), a file-level
// three-way merge and a line diff. Node built-ins only; everything is synchronous and in memory, which
// keeps the timed workloads lean.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of a typed payload: sha1 of "<type> <len>\0" + data. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** One content-addressed object store shared by every repository (objects are immutable and keyed by hash). */
export class ObjectStore {
  readonly map = new Map<string, GitObject>();

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.map.has(oid)) this.map.set(oid, { type, data });
    return oid;
  }

  get(oid: string): GitObject | undefined {
    return this.map.get(oid);
  }

  has(oid: string): boolean {
    return this.map.has(oid);
  }

  /** The type of a stored object, or undefined when absent. */
  typeOf(oid: string): ObjType | undefined {
    return this.map.get(oid)?.type;
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000' for files, '40000' for directories
  name: string;
  oid: string;
}

export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Git's tree sort key: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Flatten a tree (recursively) into path -> file entry. Directories themselves are not entries. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const obj = store.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTreeData(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, name: path, oid: entry.oid });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> entry map; returns the root tree oid. */
export function buildTreeFromFiles(store: ObjectStore, files: Map<string, TreeEntry>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1] as string, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTreeData(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string; // "Name <email> ts +0000"
  committerLine: string;
  message: string;
}

export function parseCommitData(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

export function buildCommitData(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorLine}`);
  lines.push(`committer ${info.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Parse a tag object: its target oid and target type. */
export function parseTagData(data: Buffer): { target: string; targetType: string } {
  const text = data.toString('utf8');
  let target = '';
  let targetType = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) target = line.slice(7).trim();
    else if (line.startsWith('type ')) targetType = line.slice(5).trim();
    else if (line === '') break;
  }
  return { target, targetType };
}

/** Follow tag objects until a non-tag object; returns that oid (or the input when not a tag). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTagData(obj.data).target;
  }
  return current;
}

// ---------------------------------------------------------------- history walks

/** All commit ancestors of `tip` (including tip), breadth-first by generation. Map oid -> generation (tip = 0). */
export function ancestorGenerations(store: ObjectStore, tip: string): Map<string, number> {
  const generations = new Map<string, number>();
  if (!store.has(tip)) return generations;
  let frontier: Array<{ oid: string; gen: number }> = [{ oid: tip, gen: 0 }];
  generations.set(tip, 0);
  while (frontier.length > 0) {
    const next: Array<{ oid: string; gen: number }> = [];
    for (const { oid, gen } of frontier) {
      const obj = store.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommitData(obj.data).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, gen + 1);
          next.push({ oid: parent, gen: gen + 1 });
        }
      }
    }
    frontier = next;
  }
  return generations;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorGenerations(store, descendant).has(ancestor);
}

/** A best common ancestor of two commits (the one with the smallest combined generation), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const genA = ancestorGenerations(store, a);
  if (genA.has(b)) return b;
  const genB = ancestorGenerations(store, b);
  if (genB.has(a)) return a;
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, ga] of genA) {
    const gb = genB.get(oid);
    if (gb !== undefined && ga + gb < bestScore) {
      bestScore = ga + gb;
      best = oid;
    }
  }
  return best;
}

/** Every object (commits, trees, blobs, tags) reachable from the given root oids. */
export function objectClosure(store: ObjectStore, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommitData(obj.data);
      stack.push(info.tree);
      for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeData(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTagData(obj.data).target);
    }
  }
  return seen;
}

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: 4 hex digits of total length + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem = { kind: 'data'; data: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/**
 * Read pkt-lines from `buf` starting at `offset`, stopping just after the first flush (or at the end of
 * the buffer). Delim and response-end markers are preserved as items so protocol v2's sections parse
 * exactly. Returns the items and the offset just past the last one consumed.
 */
export function readPktItems(buf: Buffer, offset: number): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const header = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      at += 4;
      break;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buf.length) break;
    items.push({ kind: 'data', data: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { items, next: at };
}

/** Just the data payloads of a pkt item list, as text lines (trailing newlines stripped). */
export function pktTexts(items: PktItem[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') lines.push(item.data.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- packs

/** Write a pack of plain (undeltified) objects: PACK header, varint-typed deflated objects, SHA-1 trailer. */
export function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const first = ((TYPE_CODES[object.type] as number) << 4) | (size & 0x0f);
    const bytes: number[] = [];
    let rest = size >> 4;
    let lead = first;
    if (rest > 0) lead |= 0x80;
    bytes.push(lead);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (`base` -> result) per the delta format: source size, target size, then opcodes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size (the caller knows the base)
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error(`delta produced ${result.length} bytes, expected ${targetSize} (produced ${produced})`);
  return result;
}

/**
 * Read a pack into the store, resolving OFS/REF deltas (bases may sit earlier in the same pack or already
 * in the store). Returns the object ids the pack carried, in pack order. Throws on a malformed pack.
 */
export function readPackInto(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('missing PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const added: string[] = [];
  const local = new Map<number, string>(); // pack offset -> oid, for OFS_DELTA bases
  interface Pending { type: ObjType; data: Buffer }
  const resolve = (type: ObjType, data: Buffer): string => store.put(type, data);
  for (let index = 0; index < count; index += 1) {
    const objectStart = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseType: ObjType | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base object's start in this pack.
      let back = pack[offset] as number;
      offset += 1;
      let relative = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] as number;
        offset += 1;
        relative = ((relative + 1) << 7) | (back & 0x7f);
      }
      baseOid = local.get(objectStart - relative) ?? null;
      if (baseOid === null) throw new Error('OFS_DELTA base not in pack');
      baseType = store.typeOf(baseOid) ?? null;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      baseType = store.typeOf(baseOid) ?? null;
      if (baseType === null) throw new Error('REF_DELTA base not available');
    }
    // The object body is one zlib stream; inflate with { info: true } so the engine reports how many
    // compressed bytes it consumed, which is where the next object starts.
    const { data, consumed } = inflatePrefix(pack.subarray(offset));
    offset += consumed;
    let finalType: ObjType;
    let finalData: Buffer;
    if (baseOid !== null) {
      const base = store.get(baseOid);
      if (base === undefined || baseType === null) throw new Error('delta base missing');
      finalType = baseType;
      finalData = applyDelta(base.data, data);
    } else {
      const plain = CODE_TYPES[typeCode];
      if (plain === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      finalType = plain;
      finalData = data;
      if (finalData.length !== size) throw new Error('inflated size mismatch');
    }
    const pending: Pending = { type: finalType, data: finalData };
    const oid = resolve(pending.type, pending.data);
    local.set(objectStart, oid);
    added.push(oid);
  }
  return added;
}

/**
 * Inflate exactly one zlib stream from the front of `buf`, reporting how many compressed bytes it used.
 * `inflateSync` with `{ info: true }` returns the engine's byte count alongside the data — the same
 * mechanism the suite's own pack reader relies on.
 */
function inflatePrefix(buf: Buffer): { data: Buffer; consumed: number } {
  const result = inflateSync(buf, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine?.bytesWritten;
  if (typeof written !== 'number' || written <= 0) throw new Error('zlib stream in pack consumed no bytes');
  return { data: result.buffer, consumed: written };
}

// ---------------------------------------------------------------- fetch selection

export interface FetchSelection {
  /** Object ids to pack, commits first then the rest. */
  objects: string[];
  /** Commits that become the client's new shallow boundary. */
  shallow: string[];
  /** Client-shallow commits whose parents are now present (no longer shallow). */
  unshallow: string[];
}

/**
 * Choose the objects a fetch sends: the closure of the wants minus the closure of the haves, with the
 * have-walk cut at the client's shallow commits and, when `deepen` is set, the want-walk limited to that
 * many generations. Mirrors the suite client's own accounting.
 */
export function selectFetchObjects(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  deepen: number | null,
): FetchSelection {
  const shallowSet = new Set(clientShallow.filter((oid) => store.typeOf(oid) === 'commit'));
  // Commits the client provably has: ancestors of the haves, not descending past a shallow commit.
  const hadCommits = new Set<string>();
  const hadStack = [...haves];
  while (hadStack.length > 0) {
    const oid = hadStack.pop() as string;
    if (hadCommits.has(oid)) continue;
    if (store.typeOf(oid) !== 'commit') continue;
    hadCommits.add(oid);
    if (shallowSet.has(oid)) continue; // the shallow commit itself is had; its ancestors are not
    for (const parent of parseCommitData(store.get(oid)?.data ?? Buffer.alloc(0)).parents) hadStack.push(parent);
  }
  for (const oid of shallowSet) hadCommits.add(oid);

  // Split the wants: commits are history-walked; a tag want carries the tag object itself and walks
  // from the commit it peels to; a tree/blob want is carried whole.
  const commitWants: string[] = [];
  const extraRoots = new Set<string>();
  for (const want of wants) {
    const type = store.typeOf(want);
    if (type === 'commit') commitWants.push(want);
    else if (type === 'tag') {
      extraRoots.add(want);
      const target = peelToCommit(store, want);
      if (store.typeOf(target) === 'commit') commitWants.push(target);
    } else if (type !== undefined) {
      extraRoots.add(want);
    }
  }

  // Commits to send: ancestors of the commit wants, minus the had ones. The walk expands through a
  // commit when the depth budget allows (deepen counts generations from the want, held or not); an
  // undeepened fetch stops at held commits and at the client's shallow boundary.
  const sendCommits = new Set<string>();
  const depthOf = new Map<string, number>();
  let frontier = [...new Set(commitWants)];
  for (const oid of frontier) depthOf.set(oid, 1);
  let depth = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const had = hadCommits.has(oid);
      if (!had) sendCommits.add(oid);
      const expand = deepen !== null ? depth < deepen : !had && !shallowSet.has(oid);
      if (!expand) continue;
      for (const parent of parseCommitData(store.get(oid)?.data ?? Buffer.alloc(0)).parents) {
        if (!depthOf.has(parent)) {
          depthOf.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    depth += 1;
  }

  // The new shallow boundary: sent commits with a parent that is neither sent nor had.
  const newShallow: string[] = [];
  for (const oid of sendCommits) {
    const parents = parseCommitData(store.get(oid)?.data ?? Buffer.alloc(0)).parents;
    const cut = parents.some((parent) => !sendCommits.has(parent) && !hadCommits.has(parent));
    if (cut && !shallowSet.has(oid)) newShallow.push(oid);
  }
  // Unshallow: client-shallow commits whose parents are all present after this fetch.
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    const parents = parseCommitData(store.get(oid)?.data ?? Buffer.alloc(0)).parents;
    if (parents.length === 0) continue;
    if (parents.every((parent) => sendCommits.has(parent) || hadCommits.has(parent))) unshallow.push(oid);
  }

  // Objects: the sent commits with their tree closures (a commit contributes its tree and blobs, never
  // its parents — history beyond the send set stays behind), plus the extra roots, minus what the
  // client already has. The client's own set is built with the same no-history walk over its held
  // commits: a shallow-held commit's ancestors are NOT part of what it has.
  const walkNoHistory = (into: Set<string>, root: string): void => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (into.has(oid)) continue;
      const obj = store.get(oid);
      if (obj === undefined) continue;
      into.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTreeData(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTagData(obj.data).target);
      } else if (obj.type === 'commit') {
        stack.push(parseCommitData(obj.data).tree);
      }
    }
  };
  const hadObjects = new Set<string>();
  for (const oid of hadCommits) walkNoHistory(hadObjects, oid);
  const sendObjects = new Set<string>();
  for (const oid of sendCommits) walkNoHistory(sendObjects, oid);
  for (const oid of extraRoots) walkNoHistory(sendObjects, oid);
  const rest = [...sendObjects].filter((oid) => !hadObjects.has(oid));
  const commitsFirst = [...sendCommits].filter((oid) => rest.includes(oid));
  const others = rest.filter((oid) => !sendCommits.has(oid));
  return { objects: [...commitsFirst, ...others], shallow: newShallow, unshallow };
}

// ---------------------------------------------------------------- merge and diff

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a diff between two texts via an LCS over lines (bounded for very large inputs). */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > 4000 || b.length > 4000) return { additions: b.length, deletions: a.length };
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? (dp[(i + 1) * (n + 1) + j + 1] as number) + 1 : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

/** The changed files between two trees, with line-diff counts (the pulls/{n}/files surface). */
export function diffTrees(store: ObjectStore, beforeTree: string | null, afterTree: string | null): FileChange[] {
  const before = beforeTree === null ? new Map<string, TreeEntry>() : flattenTree(store, beforeTree);
  const after = afterTree === null ? new Map<string, TreeEntry>() : flattenTree(store, afterTree);
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b !== undefined && a !== undefined && b.oid === a.oid && b.mode === a.mode) continue;
    const beforeText = b === undefined ? '' : (store.get(b.oid)?.data.toString('utf8') ?? '');
    const afterText = a === undefined ? '' : (store.get(a.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(beforeText, afterText);
    let status: FileChange['status'] = 'modified';
    if (b === undefined) status = 'added';
    else if (a === undefined) status = 'deleted';
    let add = additions;
    let del = deletions;
    if (status === 'modified' && add === 0 && del === 0) add = 1; // bytes differ but lines do not (e.g. final newline)
    changes.push({ filename: path, status, additions: add, deletions: del, changes: add + del });
  }
  return changes;
}

export interface MergeOutcome {
  files: Map<string, TreeEntry>;
  conflicts: string[];
}

/**
 * A file-level three-way merge of flattened trees: a path changed on only one side takes that side; a
 * path changed identically on both sides takes it; anything else (both sides changed it differently,
 * or one side deleted what the other changed) conflicts.
 */
export function mergeFileSets(
  base: Map<string, TreeEntry>,
  ours: Map<string, TreeEntry>,
  theirs: Map<string, TreeEntry>,
): MergeOutcome {
  const files = new Map<string, TreeEntry>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x: TreeEntry | undefined, y: TreeEntry | undefined): boolean =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) files.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) files.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) files.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { files, conflicts };
}

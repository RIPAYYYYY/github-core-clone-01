// githttp.ts: git smart HTTP at /{owner}/{repo}.git — protocol v2 upload-pack (capability advertisement,
// ls-refs, fetch), protocol v0 upload-pack (advertisement, fetch with shallow/deepen negotiation) and
// protocol v0 receive-pack (push with per-ref report-status). All of it runs over the shared object
// store, so what REST writes, git reads, and what git pushes, REST reads.

import type { ServerResponse } from 'node:http';
import { AGENT, Forge, type RepoRec } from './store.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  isAncestor,
  peelToCommit,
  pktLine,
  pktTexts,
  readPackInto,
  readPktItems,
  selectFetchObjects,
  writePack,
  type PktItem,
} from './gitobj.ts';
import { sendBytes, sendError, type Req } from './http.ts';

const UPLOAD_CAPS_V0 = `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/__DEFAULT__ agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** Refs in advertisement order: lexicographic by ref name. */
function sortedRefEntries(repo: RepoRec): Array<{ ref: string; oid: string }> {
  return [...repo.refs.entries()].map(([ref, oid]) => ({ ref, oid })).sort((a, b) => (a.ref < b.ref ? -1 : 1));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 advertisement body for one service. */
function advertiseV0(forge: Forge, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = (service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0).replace('__DEFAULT__', repo.defaultBranch);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefEntries(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const { ref, oid } of refs) {
    parts.push(pktLine(`${oid} ${ref}\n`));
    if (ref.startsWith('refs/tags/') && forge.objects.typeOf(oid) === 'tag') {
      parts.push(pktLine(`${peelToCommit(forge.objects, oid)} ${ref}^{}\n`));
    }
  }
  return Buffer.concat(parts);
}

/** The v2 upload-pack advertisement: version line, capabilities, flush — no "# service=" preamble. */
function advertiseV2(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'object-format=sha1', 'fetch=shallow', 'ls-refs=unborn'];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

/** Pack a payload into side-band-64k band-1 packets. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

/** Build the pack bytes for a selection of object ids. */
function packOf(forge: Forge, oids: string[]): Buffer {
  const objects = oids
    .map((oid) => forge.objects.get(oid))
    .filter((obj) => obj !== undefined)
    .map((obj) => ({ type: obj.type, data: obj.data }));
  return writePack(objects);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
  noProgress: boolean;
}

/** Run one fetch selection and produce the pack + shallow updates. */
function runFetch(forge: Forge, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const selection = selectFetchObjects(forge.objects, args.wants, args.haves, args.shallow, args.deepen);
  return { pack: packOf(forge, selection.objects), shallow: selection.shallow, unshallow: selection.unshallow };
}

/** Protocol v2 ls-refs. */
function lsRefs(forge: Forge, repo: RepoRec, argLines: string[]): Buffer {
  const peel = argLines.includes('peel');
  const symrefs = argLines.includes('symrefs');
  const unborn = argLines.includes('unborn');
  const prefixes = argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  // HEAD first.
  const headOid = repo.refs.get(headTarget(repo));
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:${headTarget(repo)}`;
      parts.push(pktLine(`${line}\n`));
    } else if (unborn) {
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:${headTarget(repo)}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  for (const { ref, oid } of sortedRefEntries(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && forge.objects.typeOf(oid) === 'tag') line += ` peeled:${peelToCommit(forge.objects, oid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Protocol v2 fetch (and the acknowledgments-only answer when the request has no 'done'). */
function fetchV2(forge: Forge, repo: RepoRec, argLines: string[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false, noProgress: false };
  for (const line of argLines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || null;
    else if (line === 'done') args.done = true;
    else if (line === 'no-progress') args.noProgress = true;
  }
  if (!args.done) {
    const parts: Buffer[] = [pktLine('acknowledgments\n')];
    const common = args.haves.filter((oid) => forge.objects.typeOf(oid) === 'commit');
    if (common.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      if (args.wants.every((oid) => forge.objects.has(oid))) parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const result = runFetch(forge, args);
  const parts: Buffer[] = [];
  if (args.deepen !== null || args.shallow.length > 0 || result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(result.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Protocol v0 upload-pack POST: wants, then haves/shallow/done, answered with negotiation lines + pack. */
function fetchV0(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const first = readPktItems(body, 0);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false, noProgress: false };
  for (const line of pktTexts(first.items)) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).split('\0')[0] as string;
      args.wants.push(rest.trim().split(/\s+/)[0] as string);
    }
  }
  const second = readPktItems(body, first.next);
  for (const line of pktTexts(second.items)) {
    if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || null;
    else if (line === 'done') args.done = true;
  }
  const result = runFetch(forge, args);
  const parts: Buffer[] = [];
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.filter((oid) => forge.objects.typeOf(oid) === 'commit');
  if (common.length === 0) parts.push(pktLine('NAK\n'));
  else parts.push(pktLine(`ACK ${common[common.length - 1]}\n`));
  parts.push(...sidebandPackets(result.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Protocol v0 receive-pack POST: command list + pack, answered with the report-status stream. */
function receivePack(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const first = readPktItems(body, 0);
  const commands: PushCommand[] = [];
  let clientCaps = '';
  for (const item of first.items) {
    if (item.kind !== 'data') continue;
    let text = item.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      clientCaps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const fields = text.trim().split(/\s+/);
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
  }
  const packBytes = body.subarray(first.next);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      readPackInto(forge.objects, packBytes);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : String(error);
    }
  }

  const report: string[] = [unpackOk ? 'unpack ok' : `unpack error: ${unpackDetail}`];
  for (const command of commands) {
    report.push(applyPushCommand(forge, repo, command, unpackOk));
  }
  const useSideband = clientCaps.includes('side-band-64k');
  const parts: Buffer[] = [];
  for (const line of report) {
    if (useSideband) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
    else parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Validate and apply one ref update; returns its report line ("ok <ref>" or "ng <ref> <reason>"). */
function applyPushCommand(forge: Forge, repo: RepoRec, command: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = command;
  const fail = (reason: string): string => `ng ${ref} ${reason}`;
  if (!ref.startsWith('refs/')) return fail('bad ref');
  if (!unpackOk) return fail('unpack failed');
  const current = repo.refs.get(ref) ?? ZERO_OID;

  if (newOid === ZERO_OID) {
    // Delete: the named old value must be where the ref still points.
    if (current !== oldOid) return fail('stale ref');
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const newType = forge.objects.typeOf(newOid);
  if (newType === undefined) return fail('invalid object');
  if (ref.startsWith('refs/heads/') && newType !== 'commit') return fail('invalid object');
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return fail('already exists');
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return fail('stale ref');
  if (newType === 'commit' && !isAncestor(forge.objects, oldOid, newOid)) return fail('non-fast-forward');
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

/** Whether the request asks for protocol v2 (the Git-Protocol header the suite's client sets). */
function wantsV2(req: Req): boolean {
  const header = req.headers['git-protocol'];
  return typeof header === 'string' && header.includes('version=2');
}

/** Handle one git smart-HTTP request. `repoName` still carries its ".git" suffix. */
export function handleGitHttp(forge: Forge, req: Req, res: ServerResponse, owner: string, repoName: string, tail: string[]): void {
  const name = repoName.endsWith('.git') ? repoName.slice(0, -'.git'.length) : repoName;
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && req.method === 'GET') {
    const service = req.query.get('service');
    if (service === 'git-upload-pack') {
      if (wantsV2(req)) sendBytes(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      else sendBytes(res, 200, advertiseV0(forge, repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, advertiseV0(forge, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 400, 'Unknown service');
    return;
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && req.method === 'POST') {
    // Protocol v2 bodies open with a "command=" pkt-line; v0 bodies open with a "want " line.
    const first = readPktItems(req.body, 0);
    const firstLine = pktTexts(first.items)[0] ?? '';
    if (firstLine.startsWith('command=')) {
      const command = firstLine.slice('command='.length).trim();
      // Capability lines precede the delim; argument lines follow it.
      const argLines: string[] = [];
      let pastDelim = false;
      for (const item of first.items as PktItem[]) {
        if (item.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (item.kind !== 'data' || !pastDelim) continue;
        argLines.push(item.data.toString('utf8').replace(/\n$/, ''));
      }
      if (command === 'ls-refs') {
        sendBytes(res, 200, lsRefs(forge, repo, argLines), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        sendBytes(res, 200, fetchV2(forge, repo, argLines), 'application/x-git-upload-pack-result');
        return;
      }
      sendError(res, 400, 'Unknown command');
      return;
    }
    sendBytes(res, 200, fetchV0(forge, repo, req.body), 'application/x-git-upload-pack-result');
    return;
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && req.method === 'POST') {
    sendBytes(res, 200, receivePack(forge, repo, req.body), 'application/x-git-receive-pack-result');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// store.ts: the forge's state and the domain operations every surface (REST, git smart HTTP, GraphQL,
// MCP) shares, so an object created over one surface is the same object over all the others. Everything
// lives in memory: repositories, refs, labels, issues, pull requests and comments beside the one shared
// git object store from gitobj.ts.
//
// The viewer identity is the suite's published scenario identity (the kit's wire.ts builds its scenario
// from one constant seed, so the login the token names is fixed): the token's owner is this login, and a
// repository addressed under any other owner does not exist here.

import {
  ObjectStore,
  buildCommitData,
  buildTreeFromFiles,
  flattenTree,
  mergeBase,
  mergeFileSets,
  parseCommitData,
  diffTrees,
  type FileChange,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const DEFAULT_BRANCH = 'main';
export const AGENT = 'forge/1.0';

/** Deterministic clock base (2025-01-01T00:00:00Z): forge-made timestamps derive from a counter, never the wall clock. */
const EPOCH_SEC = 1735689600;

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
}

export interface IssueRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
}

export interface PullRec {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string; // branch name
  baseRef: string; // branch name
  merged: boolean;
  mergedAtSeq: number | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface RepoRec {
  dbId: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name ("refs/heads/main") -> object id
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number; // issues and pull requests share one per-repo counter
  createdSeq: number;
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private dbSeq = 0;
  private commentSeq = 0;
  private clockSeq = 0;

  /** The next deterministic timestamp, seconds since the epoch base. */
  tick(): number {
    this.clockSeq += 1;
    return EPOCH_SEC + this.clockSeq * 60;
  }

  /** An ISO timestamp for a sequence value produced by tick(). */
  isoOf(sec: number): string {
    return new Date(sec * 1000).toISOString();
  }

  private nextDbId(): number {
    this.dbSeq += 1;
    return this.dbSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  // -------------------------------------------------------------- repositories

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
    this.repoSeq += 1;
    const repo: RepoRec = {
      dbId: this.nextDbId(),
      owner: VIEWER.login,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.repoSeq,
    };
    this.repos.set(repoKey(VIEWER.login, name), repo);
    return repo;
  }

  /** A repository by owner/name; undefined unless the owner is the viewer and the repo exists. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(repoKey(owner, name));
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------- refs and commits

  /** The commit oid a branch name points at, or undefined when the branch does not exist. */
  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tree oid of a commit, or null when the oid is not a commit here. */
  commitTree(oid: string): string | null {
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommitData(obj.data).tree;
  }

  /** Create a commit on `branch` applying file changes (path -> content, or null to delete); returns its oid. */
  commitFiles(
    repo: RepoRec,
    branch: string,
    changes: Map<string, Buffer | null>,
    message: string,
  ): string {
    const parent = this.branchTip(repo, branch);
    let files = new Map<string, TreeEntry>();
    if (parent !== undefined) {
      const tree = this.commitTree(parent);
      if (tree !== null) files = flattenTree(this.objects, tree);
    }
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else {
        const oid = this.objects.put('blob', content);
        files.set(path, { mode: '100644', name: path, oid });
      }
    }
    const treeOid = buildTreeFromFiles(this.objects, files);
    const ts = this.tick();
    const line = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    const commitOid = this.objects.put(
      'commit',
      buildCommitData({
        tree: treeOid,
        parents: parent === undefined ? [] : [parent],
        authorLine: line,
        committerLine: line,
        message,
      }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** The flattened files of a branch tip (empty when unborn). */
  filesAt(repo: RepoRec, branch: string): Map<string, TreeEntry> {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return new Map();
    const tree = this.commitTree(tip);
    if (tree === null) return new Map();
    return flattenTree(this.objects, tree);
  }

  // -------------------------------------------------------------- issues

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: IssueRec = {
      dbId: this.nextDbId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  /** Every issue in creation order. */
  listIssues(repo: RepoRec): IssueRec[] {
    return [...repo.issues.values()].sort((a, b) => a.number - b.number);
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRec = {
      dbId: this.nextDbId(),
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAtSeq: null,
      mergeCommitSha: null,
      createdSeq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  listPulls(repo: RepoRec): PullRec[] {
    return [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  }

  /** The open pull request for a head->base pair, when one exists. */
  findOpenPull(repo: RepoRec, headRef: string, baseRef: string): PullRec | undefined {
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
    }
    return undefined;
  }

  /** The files a pull request changes: merge-base tree versus head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase(this.objects, baseTip, headTip) ?? baseTip;
    return diffTrees(this.objects, this.commitTree(base), this.commitTree(headTip));
  }

  /** Whether a pull request's head merges cleanly into its base right now. */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return false;
    const base = mergeBase(this.objects, baseTip, headTip);
    if (base === null) return false;
    if (base === headTip) return true; // nothing to merge, still clean
    const merged = mergeFileSets(
      flattenTree(this.objects, this.commitTree(base) ?? ''),
      flattenTree(this.objects, this.commitTree(baseTip) ?? ''),
      flattenTree(this.objects, this.commitTree(headTip) ?? ''),
    );
    return merged.conflicts.length === 0;
  }

  /**
   * Merge a pull request. 'squash' lands one commit (parented on the base tip) carrying the merged tree;
   * 'merge' lands a two-parent merge commit. Returns the landing commit oid, or null on conflict.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): string | null {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return null;
    const base = mergeBase(this.objects, baseTip, headTip);
    if (base === null) return null;
    const merged = mergeFileSets(
      flattenTree(this.objects, this.commitTree(base) ?? ''),
      flattenTree(this.objects, this.commitTree(baseTip) ?? ''),
      flattenTree(this.objects, this.commitTree(headTip) ?? ''),
    );
    if (merged.conflicts.length > 0) return null;
    const treeOid = buildTreeFromFiles(this.objects, merged.files);
    const ts = this.tick();
    const line = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message =
      method === 'merge'
        ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
        : `${pull.title} (#${pull.number})\n${pull.body === '' ? '' : `\n${pull.body}\n`}`;
    const commitOid = this.objects.put(
      'commit',
      buildCommitData({ tree: treeOid, parents, authorLine: line, committerLine: line, message }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAtSeq = ts;
    pull.mergeCommitSha = commitOid;
    return commitOid;
  }

  // -------------------------------------------------------------- global id lookups (GraphQL node)

  findRepoByDbId(dbId: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return undefined;
  }

  findIssueByDbId(dbId: number): { repo: RepoRec; issue: IssueRec } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.dbId === dbId) return { repo, issue };
    }
    return undefined;
  }

  findPullByDbId(dbId: number): { repo: RepoRec; pull: PullRec } | undefined {
    for (const repo of this.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.dbId === dbId) return { repo, pull };
    }
    return undefined;
  }

  findCommentById(id: number): { repo: RepoRec; issue: IssueRec; comment: CommentRec } | undefined {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) {
        for (const comment of issue.comments) if (comment.id === id) return { repo, issue, comment };
      }
    }
    return undefined;
  }
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** An opaque, stable global id for a typed database id (GraphQL node ids; never the plain number). */
export function globalId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and database id, or null when it is not one of ours. */
export function parseGlobalId(id: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const split = text.lastIndexOf(':');
    if (split <= 0) return null;
    const dbId = Number(text.slice(split + 1));
    if (!Number.isSafeInteger(dbId) || dbId <= 0) return null;
    return { type: text.slice(0, split), dbId };
  } catch {
    return null;
  }
}

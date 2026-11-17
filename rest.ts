// rest.ts: the GitHub REST v3 surface under /api/v3 — repositories, branches, refs, commits, contents,
// labels, issues, comments and pull requests, all over the shared Forge store. Replies follow the wire
// contract: JSON always, {message} errors, 201/200/204/404/405/409/422 where the suite expects them,
// Link-header pagination on the list routes.

import type { ServerResponse } from 'node:http';
import { Forge, VIEWER, globalId, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { ancestorGenerations, flattenTree, parseCommitData } from './gitobj.ts';
import { intParam, parseJsonBody, sendEmpty, sendError, sendJson, type Req } from './http.ts';

const EPOCH_SEC = 1735689600;

/** A deterministic ISO timestamp from a global creation sequence (display only). */
function isoOfSeq(seq: number): string {
  return new Date((EPOCH_SEC + seq * 60) * 1000).toISOString();
}

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: isoOfSeq(repo.dbId),
    updated_at: isoOfSeq(repo.dbId),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: globalId('Issue', issue.dbId),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', default: false };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOfSeq(issue.dbId),
    updated_at: isoOfSeq(issue.dbId),
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  return {
    id: pull.dbId,
    node_id: globalId('PullRequest', pull.dbId),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAtSeq === null ? null : forge.isoOf(pull.mergedAtSeq),
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headTip ?? null },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip ?? null },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOfSeq(pull.dbId),
    updated_at: isoOfSeq(pull.dbId),
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: isoOfSeq(comment.id) };
}

/** Slice a list by ?per_page&page and build the Link header (rel="next"/"last") when more pages remain. */
function paginate<T>(req: Req, items: T[]): { page: T[]; headers: Record<string, string> } {
  const perPage = intParam(req, 'per_page', 30, 1, 100);
  const page = intParam(req, 'page', 1, 1, 1_000_000);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const host = req.headers.host ?? 'forge.invalid';
    const base = `http://${host}${req.path}`;
    const next = `${base}?per_page=${perPage}&page=${page + 1}`;
    const last = `${base}?per_page=${perPage}&page=${totalPages}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, headers };
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

/** Handle one /api/v3 request. `seg` is the path segments after the /api/v3 prefix. */
export function handleRest(forge: Forge, req: Req, res: ServerResponse, seg: string[]): void {
  res.setHeader('x-oauth-scopes', 'repo, read:org');
  const method = req.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
      });
      return;
    }
    notFound(res);
    return;
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    else notFound(res);
    return;
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') sendJson(res, 200, userJson());
    else notFound(res);
    return;
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(req, forge.listRepos());
      sendJson(res, 200, page.map(repoJson), headers);
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = typeof body.value.name === 'string' ? body.value.name : '';
      if (name === '' || name.includes('/')) return sendError(res, 422, 'Repository creation failed: a name is required.');
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return sendError(res, 422, `Repository creation failed: the name ${name} already exists on this account.`);
      }
      const repo = forge.createRepo(
        name,
        typeof body.value.description === 'string' ? body.value.description : '',
        body.value.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) return notFound(res);
    handleRepo(forge, req, res, repo, seg.slice(3));
    return;
  }

  notFound(res);
}

function handleRepo(forge: Forge, req: Req, res: ServerResponse, repo: RepoRec, tail: string[]): void {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (typeof body.value.description === 'string') repo.description = body.value.description;
      if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
      if (typeof body.value.default_branch === 'string' && body.value.default_branch !== '') repo.defaultBranch = body.value.default_branch;
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return sendEmpty(res, 204);
    }
    return notFound(res);
  }

  const head = tail[0] as string;

  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { page, headers } = paginate(req, branches);
      return sendJson(res, 200, page, headers);
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === undefined) return notFound(res);
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    }
    return notFound(res);
  }

  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const ref = typeof body.value.ref === 'string' ? body.value.ref : '';
      const sha = typeof body.value.sha === 'string' ? body.value.sha : '';
      if (!ref.startsWith('refs/') || sha === '' || !forge.objects.has(sha)) {
        return sendError(res, 422, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, object: { sha, type: forge.objects.typeOf(sha) ?? 'commit' } });
    }
    if (tail.length >= 3 && method === 'GET') {
      const joined = tail.slice(2).join('/');
      const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound(res);
      return sendJson(res, 200, { ref, object: { sha, type: forge.objects.typeOf(sha) ?? 'commit' } });
    }
    return notFound(res);
  }

  if (head === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const refParam = req.query.get('sha');
      let tip: string | undefined;
      if (refParam !== null && refParam !== '') {
        tip = forge.branchTip(repo, refParam) ?? (forge.objects.typeOf(refParam) === 'commit' ? refParam : undefined);
      } else {
        tip = forge.branchTip(repo, repo.defaultBranch);
      }
      if (tip === undefined) return sendError(res, 409, 'Git Repository is empty');
      const generations = ancestorGenerations(forge.objects, tip);
      const ordered = [...generations.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
      const { page, headers } = paginate(req, ordered);
      return sendJson(res, 200, page.map((oid) => commitJson(forge, oid)), headers);
    }
    if (tail.length === 2 && method === 'GET') {
      const sha = tail[1] as string;
      if (forge.objects.typeOf(sha) !== 'commit') return notFound(res);
      return sendJson(res, 200, commitJson(forge, sha));
    }
    return notFound(res);
  }

  if (head === 'contents') {
    handleContents(forge, req, res, repo, tail.slice(1).join('/'));
    return;
  }

  if (head === 'labels') {
    if (tail.length === 1 && method === 'GET') {
      const labels = [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false }));
      return sendJson(res, 200, labels);
    }
    if (tail.length === 1 && method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const labelName = typeof body.value.name === 'string' ? body.value.name : '';
      if (labelName === '') return sendError(res, 422, 'A label name is required');
      if (repo.labels.has(labelName)) return sendError(res, 422, 'Label already exists');
      const color = typeof body.value.color === 'string' ? body.value.color.replace(/^#/, '') : 'ededed';
      repo.labels.set(labelName, { name: labelName, color });
      return sendJson(res, 201, { name: labelName, color, default: false });
    }
    return notFound(res);
  }

  if (head === 'issues') {
    handleIssues(forge, req, res, repo, tail.slice(1));
    return;
  }

  if (head === 'pulls') {
    handlePulls(forge, req, res, repo, tail.slice(1));
    return;
  }

  notFound(res);
}

function commitJson(forge: Forge, oid: string): Record<string, unknown> {
  const obj = forge.objects.get(oid);
  const info = obj === undefined ? null : parseCommitData(obj.data);
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: '', email: '', date: isoOfSeq(0) };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '' },
      author: person(info?.authorLine ?? ''),
      committer: person(info?.committerLine ?? ''),
    },
    parents: (info?.parents ?? []).map((sha) => ({ sha })),
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
  };
}

/** Resolve a ref parameter (branch name or commit oid) to a commit oid. */
function resolveCommit(forge: Forge, repo: RepoRec, ref: string | null): string | undefined {
  if (ref === null || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  return forge.branchTip(repo, ref) ?? (forge.objects.typeOf(ref) === 'commit' ? ref : undefined);
}

function handleContents(forge: Forge, req: Req, res: ServerResponse, repo: RepoRec, path: string): void {
  const method = req.method;

  if (method === 'GET') {
    const tip = resolveCommit(forge, repo, req.query.get('ref'));
    if (tip === undefined) return notFound(res);
    const tree = forge.commitTree(tip);
    if (tree === null) return notFound(res);
    const files = flattenTree(forge.objects, tree);
    if (path === '') {
      return sendJson(res, 200, dirListing(files, ''));
    }
    const entry = files.get(path);
    if (entry !== undefined) {
      const blob = forge.objects.get(entry.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
    }
    const prefix = `${path}/`;
    const isDir = [...files.keys()].some((key) => key.startsWith(prefix));
    if (isDir) return sendJson(res, 200, dirListing(files, path));
    return notFound(res);
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = parseJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    const branch = typeof body.value.branch === 'string' && body.value.branch !== '' ? body.value.branch : repo.defaultBranch;
    // A contents write naming a branch that does not exist yet creates it from the default branch tip
    // (the fallback branch-creation route the suite's fixtures are allowed to use).
    if (forge.branchTip(repo, branch) === undefined && branch !== repo.defaultBranch) {
      const defaultTip = forge.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
    }
    const files = forge.filesAt(repo, branch);
    const existing = files.get(path);
    const message = typeof body.value.message === 'string' ? body.value.message : `${method === 'PUT' ? 'Update' : 'Delete'} ${path}`;

    if (method === 'DELETE') {
      if (existing === undefined) return notFound(res);
      if (typeof body.value.sha !== 'string' || body.value.sha !== existing.oid) {
        return sendError(res, 409, 'The sha provided does not match the current blob');
      }
      const commit = forge.commitFiles(repo, branch, new Map([[path, null]]), message);
      return sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    }

    // PUT
    const contentB64 = typeof body.value.content === 'string' ? body.value.content : '';
    const data = Buffer.from(contentB64, 'base64');
    if (existing !== undefined) {
      if (typeof body.value.sha !== 'string' || body.value.sha !== existing.oid) {
        return sendError(res, 409, 'The sha provided does not match the current blob');
      }
    } else if (body.value.sha !== undefined) {
      return notFound(res);
    }
    const blobOid = forge.objects.put('blob', data);
    const commit = forge.commitFiles(repo, branch, new Map([[path, data]]), message);
    return sendJson(res, existing !== undefined ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
      commit: { sha: commit, message },
    });
  }

  notFound(res);
}

function dirListing(files: Map<string, { mode: string; name: string; oid: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: entry.oid });
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
}

function handleIssues(forge: Forge, req: Req, res: ServerResponse, repo: RepoRec, tail: string[]): void {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = typeof body.value.title === 'string' ? body.value.title : '';
      if (title === '') return sendError(res, 422, 'An issue title is required');
      const labels = labelNamesOf(body.value.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(res, 422, `Label '${label}' does not exist on this repository`);
      }
      const issue = forge.createIssue(repo, title, typeof body.value.body === 'string' ? body.value.body : '', labels);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let issues = forge.listIssues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const direction = req.query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(req, issues);
      return sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), headers);
    }
    return notFound(res);
  }

  const number = Number(tail[0]);
  const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;

  if (tail.length === 1) {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
      if (typeof body.value.title === 'string') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      if (body.value.labels !== undefined) {
        const labels = labelNamesOf(body.value.labels);
        for (const label of labels) {
          if (!repo.labels.has(label)) return sendError(res, 422, `Label '${label}' does not exist on this repository`);
        }
        issue.labels = labels;
      }
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return notFound(res);
    if (method === 'GET') {
      const { page, headers } = paginate(req, issue.comments);
      return sendJson(res, 200, page.map(commentJson), headers);
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const text = typeof body.value.body === 'string' ? body.value.body : '';
      if (text === '') return sendError(res, 422, 'A comment body is required');
      const comment = { id: forge.nextCommentId(), body: text, authorLogin: VIEWER.login };
      issue.comments.push(comment);
      return sendJson(res, 201, commentJson(comment));
    }
    return notFound(res);
  }

  notFound(res);
}

/** Issue label inputs arrive as strings or as {name} objects; normalize to names. */
function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function handlePulls(forge: Forge, req: Req, res: ServerResponse, repo: RepoRec, tail: string[]): void {
  const method = req.method;

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = typeof body.value.title === 'string' ? body.value.title : '';
      const head = branchNameOf(body.value.head);
      const base = branchNameOf(body.value.base);
      if (title === '' || head === '' || base === '') return sendError(res, 422, 'A title, head and base are required');
      const headTip = forge.branchTip(repo, head);
      const baseTip = forge.branchTip(repo, base);
      if (headTip === undefined || baseTip === undefined) return sendError(res, 422, 'Head or base branch does not exist');
      if (forge.findOpenPull(repo, head, base) !== undefined) {
        return sendError(res, 422, `A pull request already exists for ${head} -> ${base}`);
      }
      if (headTip === baseTip) return sendError(res, 422, 'No commits between base and head');
      const pull = forge.createPull(repo, title, typeof body.value.body === 'string' ? body.value.body : '', head, base);
      return sendJson(res, 201, pullJson(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = forge.listPulls(repo);
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      const { page, headers } = paginate(req, pulls);
      return sendJson(res, 200, page.map((pull) => pullJson(forge, repo, pull)), headers);
    }
    return notFound(res);
  }

  const number = Number(tail[0]);
  const pull = Number.isSafeInteger(number) ? repo.pulls.get(number) : undefined;

  if (tail.length === 1 && method === 'GET') {
    if (pull === undefined) return notFound(res);
    return sendJson(res, 200, pullJson(forge, repo, pull));
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound(res);
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const { page, headers } = paginate(req, files);
    return sendJson(res, 200, page, headers);
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound(res);
    const body = parseJsonBody(req);
    if (!body.ok) return sendError(res, 400, 'Problems parsing JSON');
    if (pull.merged) return sendError(res, 405, 'Pull Request is not mergeable');
    const methodName = typeof body.value.merge_method === 'string' ? body.value.merge_method : 'merge';
    const sha = forge.mergePull(repo, pull, methodName === 'merge' ? 'merge' : 'squash');
    if (sha === null) return sendError(res, 405, 'Pull Request is not mergeable: merge conflict');
    return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }

  notFound(res);
}

/** A head/base input may carry an "owner:" prefix (the fork form); the branch is the part after ':'. */
function branchNameOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

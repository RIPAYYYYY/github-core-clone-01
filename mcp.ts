// mcp.ts: the Model Context Protocol endpoint at /mcp — JSON-RPC 2.0 over streamable HTTP. It speaks
// the modern revision (server/discover answering supportedVersions) and the legacy handshake
// (initialize + notifications/initialized) alike. The tools act on the same Forge store as REST, so an
// object created over MCP is the same object over /api/v3. The tools list is built once, so two
// tools/list answers are byte-identical.

import type { ServerResponse } from 'node:http';
import { Forge, VIEWER } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { sendEmpty, sendJson, type Req } from './http.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };

/** The tools list, built once at module load: tools/list answers are byte-identical by construction. */
const TOOLS: ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository for the authenticated user.',
    { name: STRING, description: STRING, private: BOOLEAN, owner: STRING },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    { owner: STRING, repo: STRING, full_name: STRING },
    ['owner', 'repo'],
  ),
  tool(
    'list_repos',
    'List the repositories owned by the authenticated user.',
    { owner: STRING },
    [],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    { owner: STRING, repo: STRING, full_name: STRING, title: STRING, body: STRING },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository, optionally filtered by state (open, closed or all).',
    { owner: STRING, repo: STRING, full_name: STRING, state: STRING },
    ['owner', 'repo'],
  ),
  tool(
    'get_issue',
    'Get one issue by number from a repository.',
    { owner: STRING, repo: STRING, full_name: STRING, issue_number: { type: 'number' } },
    ['owner', 'repo', 'issue_number'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    { owner: STRING, repo: STRING, full_name: STRING, title: STRING, body: STRING, head: STRING, base: STRING },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request by number (squash).',
    { owner: STRING, repo: STRING, full_name: STRING, pull_number: { type: 'number' } },
    ['owner', 'repo', 'pull_number'],
  ),
];

const TOOLS_BY_NAME = new Map(TOOLS.map((def) => [def.name, def]));

interface RpcOutcome {
  status: number;
  body: Record<string, unknown> | null; // null -> empty reply (notifications)
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, status: number, code: number, message: string): RpcOutcome {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/** A successful tool result: the object as structured content and as a JSON text block. */
function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool-level failure (the tool ran, the operation could not be done). */
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Read a string argument from any of its accepted names. */
function argString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Read a numeric argument from any of its accepted names. */
function argNumber(args: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  }
  return undefined;
}

/** Resolve owner/repo arguments (a full_name of "owner/repo" fills either when missing). */
function repoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = argString(args, 'owner');
  let repo = argString(args, 'repo', 'repository', 'name');
  const fullName = argString(args, 'full_name', 'fullName');
  if ((owner === undefined || repo === undefined) && fullName !== undefined && fullName.includes('/')) {
    const [head, tail] = fullName.split('/', 2);
    if (owner === undefined) owner = head;
    if (repo === undefined) repo = tail;
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcErrorCode: number; message: string } {
  const missing = (what: string): { rpcErrorCode: number; message: string } => ({ rpcErrorCode: -32602, message: `Missing required argument: ${what}` });

  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === undefined) return missing('name');
      if (forge.getRepo(VIEWER.login, repoName) !== undefined) return toolError(`Repository ${repoName} already exists`);
      const repo = forge.createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const target = repoArgs(args);
      if (target === null) return missing('owner/repo');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      return toolOk(repoJson(repo));
    }
    case 'list_repos': {
      return toolOk({ repositories: forge.listRepos().map(repoJson) });
    }
    case 'create_issue': {
      const target = repoArgs(args);
      if (target === null) return missing('owner/repo');
      const title = argString(args, 'title');
      if (title === undefined) return missing('title');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const target = repoArgs(args);
      if (target === null) return missing('owner/repo');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const state = (argString(args, 'state') ?? 'open').toLowerCase();
      let issues = forge.listIssues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return toolOk({ issues: issues.map((issue) => issueJson(repo, issue)) });
    }
    case 'get_issue': {
      const target = repoArgs(args);
      if (target === null) return missing('owner/repo');
      const number = argNumber(args, 'issue_number', 'number');
      if (number === undefined) return missing('issue_number');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolError(`Issue #${number} not found`);
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const target = repoArgs(args);
      if (target === null) return missing('owner/repo');
      const title = argString(args, 'title');
      const head = argString(args, 'head', 'head_branch');
      const base = argString(args, 'base', 'base_branch');
      if (title === undefined) return missing('title');
      if (head === undefined) return missing('head');
      if (base === undefined) return missing('base');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      if (forge.branchTip(repo, head) === undefined || forge.branchTip(repo, base) === undefined) {
        return toolError('Head or base branch not found');
      }
      const existing = forge.findOpenPull(repo, head, base);
      if (existing !== undefined) return toolOk(pullJson(forge, repo, existing));
      const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const target = repoArgs(args);
      if (target === null) return missing('owner/repo');
      const number = argNumber(args, 'pull_number', 'number', 'pr_number');
      if (number === undefined) return missing('pull_number');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`Pull request #${number} not found`);
      if (!pull.merged) {
        const sha = forge.mergePull(repo, pull, 'squash');
        if (sha === null) return toolError(`Pull request #${number} is not mergeable`);
      }
      return toolOk(pullJson(forge, repo, pull));
    }
    default:
      return { rpcErrorCode: -32602, message: `Unknown tool: ${name}` };
  }
}

/** Dispatch one parsed JSON-RPC request object. */
function dispatch(forge: Forge, request: Record<string, unknown>): RpcOutcome {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = id === undefined;
  if (isNotification) return { status: 202, body: null }; // notifications are never answered

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
      // Tool names may carry a server prefix ("github__create_issue"): match the canonical suffix.
      const canonical = TOOLS_BY_NAME.has(name) ? name : (name.split('__').pop() as string);
      if (!TOOLS_BY_NAME.has(canonical)) return rpcError(id, 200, -32602, `Unknown tool: ${name}`);
      const outcome = callTool(forge, canonical, args);
      if ('rpcErrorCode' in outcome) return rpcError(id, 200, outcome.rpcErrorCode, outcome.message);
      return rpcResult(id, outcome);
    }
    default:
      if (isNotification) return { status: 202, body: null };
      return rpcError(id, 200, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp request. Auth is enforced by the caller (app.ts) before this runs. */
export function handleMcp(forge: Forge, req: Req, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const bodies: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const outcome = dispatch(forge, entry as Record<string, unknown>);
      if (outcome.body !== null) bodies.push(outcome.body);
    }
    sendJson(res, 200, bodies);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const outcome = dispatch(forge, parsed as Record<string, unknown>);
  if (outcome.body === null) {
    sendEmpty(res, outcome.status);
    return;
  }
  sendJson(res, outcome.status, outcome.body);
}

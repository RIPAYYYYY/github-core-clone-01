// graphql.ts: the GraphQL v4 surface at /api/graphql. A small hand-rolled parser and executor for the
// documents gh and github-mcp-server send: named operations, variables, aliases, fragments, input
// objects, connections with opaque cursors, the node() global-id lookup, the five mutations the suite
// drives, and __type introspection. Unknown fields answer HTTP 200 with an errors array naming the
// field; unknown repositories answer data.repository = null with no errors.

import type { ServerResponse } from 'node:http';
import { Forge, VIEWER, globalId, parseGlobalId, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { sendError, sendJson, type Req } from './http.ts';

const EPOCH_SEC = 1735689600;

function isoOfSeq(seq: number): string {
  return new Date((EPOCH_SEC + seq * 60) * 1000).toISOString();
}

// ---------------------------------------------------------------- lexer

interface Tok {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function lex(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:@$!=|&'.includes(ch)) {
      toks.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        toks.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let j = i;
      while (j < input.length && /[-+0-9.eE]/.test(input[j] as string)) j += 1;
      toks.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      toks.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> }
  | { kind: 'variable'; name: string };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  directives: Array<{ name: string; args: Record<string, ValueNode> }>;
  selection: FieldNode[] | null;
  fragmentSpread: string | null; // set for ...Name
  inlineType: string | null; // set for ... on Type
}

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefaults: Record<string, ValueNode>;
  selection: FieldNode[];
}

interface FragmentDef {
  typeCondition: string;
  selection: FieldNode[];
}

class Parser {
  private toks: Tok[];
  private at = 0;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok {
    return this.toks[this.at] as Tok;
  }

  private next(): Tok {
    const tok = this.toks[this.at] as Tok;
    this.at += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected '${value}', got '${tok.value}'`);
  }

  private skipPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got '${tok.value}'`);
    return tok.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ opType: 'query', name: null, varDefaults: {}, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefaults: Record<string, ValueNode> = {};
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) varDefaults[varName] = this.parseValue();
            this.parseDirectives();
          }
        }
        this.parseDirectives();
        operations.push({
          opType: keyword === 'mutation' ? 'mutation' : 'query',
          name,
          varDefaults,
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error(`expected 'on' in fragment ${fragName}`);
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition '${keyword}'`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): Array<{ name: string; args: Record<string, ValueNode> }> {
    const directives: Array<{ name: string; args: Record<string, ValueNode> }> = [];
    while (this.skipPunct('@')) {
      const name = this.expectName();
      let args: Record<string, ValueNode> = {};
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArgs();
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'number') return { kind: 'number', value: Number(tok.value) };
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token '${tok.value}'`);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.skipPunct('}')) fields.push(this.parseSelection());
    return fields;
  }

  private parseSelection(): FieldNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { name: '', alias: null, args: {}, directives, selection: this.parseSelectionSet(), fragmentSpread: null, inlineType: typeCondition };
      }
      const spreadName = this.expectName();
      const directives = this.parseDirectives();
      return { name: '', alias: null, args: {}, directives, selection: null, fragmentSpread: spreadName, inlineType: null };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArgs();
    const directives = this.parseDirectives();
    let selection: FieldNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { name, alias, args, directives, selection, fragmentSpread: null, inlineType: null };
  }
}

// ---------------------------------------------------------------- values

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path?: string[] }>;
}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, ctx);
      return out;
    }
    case 'variable':
      return ctx.variables[node.name];
  }
}

function evalArgs(nodes: Record<string, ValueNode>, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(nodes)) out[key] = evalValue(value, ctx);
  return out;
}

/** Whether a field's @skip/@include directives keep it. */
function directivesKeep(node: FieldNode, ctx: ExecCtx): boolean {
  for (const directive of node.directives) {
    if (directive.name === 'skip' && evalValue(directive.args.if as ValueNode, ctx) === true) return false;
    if (directive.name === 'include' && evalValue(directive.args.if as ValueNode, ctx) === false) return false;
  }
  return true;
}

// ---------------------------------------------------------------- object values

type GqlObj = Record<string, unknown> & { __type: string };

function userObj(): GqlObj {
  return { __type: 'User', id: globalId('User', VIEWER.id), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, isViewer: true };
}

function repoObj(repo: RepoRec): GqlObj {
  return { __type: 'Repository', repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): GqlObj {
  return { __type: 'Issue', repo, issue };
}

function pullObj(repo: RepoRec, pull: PullRec): GqlObj {
  return { __type: 'PullRequest', repo, pull };
}

function refObj(repo: RepoRec, branch: string): GqlObj {
  return { __type: 'Ref', repo, branch };
}

function commitObj(oid: string): GqlObj {
  return { __type: 'Commit', oid };
}

function commentObj(repo: RepoRec, issue: IssueRec, comment: { id: number; body: string }): GqlObj {
  return { __type: 'IssueComment', repo, issue, comment };
}

/** An opaque pagination cursor for a numbered item. */
function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  node: GqlObj;
}

/** Slice an ordered connection by first/after, GitHub-style. */
function connection(type: string, edgeType: string, items: ConnectionItem[], args: Record<string, unknown>): GqlObj {
  const afterNumber = numberOfCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const index = items.findIndex((item) => item.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 10;
  const slice = items.slice(start, start + first);
  const edges = slice.map((item) => ({ __type: edgeType, node: item.node, cursor: cursorOf(item.number) }) as GqlObj);
  const pageInfo: GqlObj = {
    __type: 'PageInfo',
    hasNextPage: start + slice.length < items.length,
    hasPreviousPage: start > 0,
    startCursor: edges.length > 0 ? (edges[0] as GqlObj).cursor : null,
    endCursor: edges.length > 0 ? (edges[edges.length - 1] as GqlObj).cursor : null,
  };
  return { __type: type, nodes: slice.map((item) => item.node), edges, pageInfo, totalCount: items.length };
}

// ---------------------------------------------------------------- introspection data

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileStatus: ['ADDED', 'MODIFIED', 'DELETED'],
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID', 'Base64String', 'HTML', 'PreciseDateTime', 'GitTimestamp', 'X509Certificate']);

function typeObj(name: string): GqlObj | null {
  if (ENUM_VALUES[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: (ENUM_VALUES[name] as string[]).map((value) => ({ __type: '__EnumValue', name: value })),
    };
  }
  if (SCALAR_TYPES.has(name)) return { __type: '__Type', name, kind: 'SCALAR', fields: null, enumValues: null };
  const fields = TYPE_FIELDS[name];
  if (fields === undefined) return null;
  return {
    __type: '__Type',
    name,
    kind: name === 'Node' ? 'INTERFACE' : 'OBJECT',
    fields: fields.map((field) => ({ __type: '__Field', name: field })),
    enumValues: null,
  };
}

// ---------------------------------------------------------------- resolvers

type Resolver = (parent: GqlObj | null, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function repoOf(parent: GqlObj): RepoRec {
  return parent.repo as RepoRec;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(),
    repository: (_parent, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_parent, args, ctx) => nodeById(ctx, String(args.id ?? '')),
    __type: (_parent, args) => typeObj(String(args.name ?? '')),
    __schema: () => ({
      __type: '__Schema',
      types: [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES), ...SCALAR_TYPES].map((name) => typeObj(name)),
      queryType: typeObj('Query'),
      mutationType: typeObj('Mutation'),
      directives: [],
    }),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? ctx.forge.findRepoByDbId(parsed.dbId) : undefined;
      if (repo === undefined) throw new Error('createIssue: repository not found');
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
      if (found === undefined) throw new Error('closeIssue: issue not found');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.type === 'Repository' ? ctx.forge.findRepoByDbId(parsed.dbId) : undefined;
      if (repo === undefined) throw new Error('createPullRequest: repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const existing = ctx.forge.findOpenPull(repo, head, base);
      if (existing !== undefined) {
        return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, existing), clientMutationId: input.clientMutationId ?? null };
      }
      if (ctx.forge.branchTip(repo, head) === undefined || ctx.forge.branchTip(repo, base) === undefined) {
        throw new Error('createPullRequest: head or base branch not found');
      }
      const pull = ctx.forge.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === undefined) throw new Error('mergePullRequest: pull request not found');
      if (!found.pull.merged) {
        const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase() === 'MERGE' ? 'merge' : 'squash';
        const sha = ctx.forge.mergePull(found.repo, found.pull, method);
        if (sha === null) throw new Error('mergePullRequest: pull request is not mergeable');
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
      if (found === undefined) throw new Error('addComment: subject not found');
      const comment = { id: ctx.forge.nextCommentId(), body: String(input.body ?? ''), authorLogin: VIEWER.login };
      found.issue.comments.push(comment);
      const edge: GqlObj = { __type: 'IssueCommentEdge', node: commentObj(found.repo, found.issue, comment), cursor: cursorOf(comment.id) };
      return { __type: 'AddCommentPayload', commentEdge: edge, clientMutationId: input.clientMutationId ?? null };
    },
  },
  User: {
    id: () => globalId('User', VIEWER.id),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (parent) => globalId('Repository', repoOf(parent as GqlObj).dbId),
    databaseId: (parent) => repoOf(parent as GqlObj).dbId,
    name: (parent) => repoOf(parent as GqlObj).name,
    nameWithOwner: (parent) => `${repoOf(parent as GqlObj).owner}/${repoOf(parent as GqlObj).name}`,
    owner: () => userObj(),
    description: (parent) => repoOf(parent as GqlObj).description,
    isPrivate: (parent) => repoOf(parent as GqlObj).isPrivate,
    defaultBranchRef: (parent, _args, ctx) => {
      const repo = repoOf(parent as GqlObj);
      return ctx.forge.branchTip(repo, repo.defaultBranch) === undefined ? null : refObj(repo, repo.defaultBranch);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    url: (parent) => `https://forge.invalid/${repoOf(parent as GqlObj).owner}/${repoOf(parent as GqlObj).name}`,
    createdAt: (parent) => isoOfSeq(repoOf(parent as GqlObj).dbId),
    updatedAt: (parent) => isoOfSeq(repoOf(parent as GqlObj).dbId),
    issue: (parent, args, ctx) => {
      const repo = repoOf(parent as GqlObj);
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (parent, args, ctx) => {
      const repo = repoOf(parent as GqlObj);
      let issues = ctx.forge.listIssues(repo);
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return connection('IssueConnection', 'IssueEdge', issues.map((issue) => ({ number: issue.number, node: issueObj(repo, issue) })), args);
    },
    pullRequest: (parent, args) => {
      const repo = repoOf(parent as GqlObj);
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullObj(repo, pull);
    },
    pullRequests: (parent, args, ctx) => {
      const repo = repoOf(parent as GqlObj);
      let pulls = ctx.forge.listPulls(repo);
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
      pulls.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return connection('PullRequestConnection', 'PullRequestEdge', pulls.map((pull) => ({ number: pull.number, node: pullObj(repo, pull) })), args);
    },
  },
  Ref: {
    name: (parent) => (parent as GqlObj).branch as string,
    prefix: () => 'refs/heads/',
    target: (parent, _args, ctx) => {
      const repo = repoOf(parent as GqlObj);
      const tip = ctx.forge.branchTip(repo, (parent as GqlObj).branch as string);
      return tip === undefined ? null : commitObj(tip);
    },
  },
  Commit: {
    oid: (parent) => (parent as GqlObj).oid as string,
    id: (parent) => Buffer.from(`Commit:${(parent as GqlObj).oid as string}`, 'utf8').toString('base64'),
    message: (parent, _args, ctx) => {
      const obj = ctx.forge.objects.get((parent as GqlObj).oid as string);
      if (obj === undefined) return '';
      const split = obj.data.toString('utf8').indexOf('\n\n');
      return split === -1 ? '' : obj.data.toString('utf8').slice(split + 2);
    },
  },
  Issue: {
    id: (parent) => globalId('Issue', ((parent as GqlObj).issue as IssueRec).dbId),
    databaseId: (parent) => ((parent as GqlObj).issue as IssueRec).dbId,
    number: (parent) => ((parent as GqlObj).issue as IssueRec).number,
    title: (parent) => ((parent as GqlObj).issue as IssueRec).title,
    body: (parent) => ((parent as GqlObj).issue as IssueRec).body,
    state: (parent) => ((parent as GqlObj).issue as IssueRec).state.toUpperCase(),
    author: () => userObj(),
    repository: (parent) => repoObj(repoOf(parent as GqlObj)),
    url: (parent) => `https://forge.invalid/${repoOf(parent as GqlObj).owner}/${repoOf(parent as GqlObj).name}/issues/${((parent as GqlObj).issue as IssueRec).number}`,
    createdAt: (parent) => isoOfSeq(((parent as GqlObj).issue as IssueRec).dbId),
    updatedAt: (parent) => isoOfSeq(((parent as GqlObj).issue as IssueRec).dbId),
  },
  PullRequest: {
    id: (parent) => globalId('PullRequest', ((parent as GqlObj).pull as PullRec).dbId),
    databaseId: (parent) => ((parent as GqlObj).pull as PullRec).dbId,
    number: (parent) => ((parent as GqlObj).pull as PullRec).number,
    title: (parent) => ((parent as GqlObj).pull as PullRec).title,
    body: (parent) => ((parent as GqlObj).pull as PullRec).body,
    state: (parent) => {
      const pull = (parent as GqlObj).pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (parent) => ((parent as GqlObj).pull as PullRec).merged,
    mergedAt: (parent, _args, ctx) => {
      const pull = (parent as GqlObj).pull as PullRec;
      return pull.mergedAtSeq === null ? null : ctx.forge.isoOf(pull.mergedAtSeq);
    },
    mergeCommit: (parent) => {
      const pull = (parent as GqlObj).pull as PullRec;
      return pull.mergeCommitSha === null ? null : commitObj(pull.mergeCommitSha);
    },
    headRefName: (parent) => ((parent as GqlObj).pull as PullRec).headRef,
    baseRefName: (parent) => ((parent as GqlObj).pull as PullRec).baseRef,
    headRef: (parent, _args, ctx) => {
      const pull = (parent as GqlObj).pull as PullRec;
      const repo = repoOf(parent as GqlObj);
      return ctx.forge.branchTip(repo, pull.headRef) === undefined ? null : refObj(repo, pull.headRef);
    },
    baseRef: (parent, _args, ctx) => {
      const pull = (parent as GqlObj).pull as PullRec;
      const repo = repoOf(parent as GqlObj);
      return ctx.forge.branchTip(repo, pull.baseRef) === undefined ? null : refObj(repo, pull.baseRef);
    },
    mergeable: (parent, _args, ctx) => {
      const pull = (parent as GqlObj).pull as PullRec;
      if (pull.merged) return 'MERGEABLE';
      return ctx.forge.pullMergeable(repoOf(parent as GqlObj), pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (parent, args, ctx) => {
      const pull = (parent as GqlObj).pull as PullRec;
      const repo = repoOf(parent as GqlObj);
      const files = ctx.forge.pullFiles(repo, pull);
      const items = files.map((file, index) => ({
        number: index + 1,
        node: {
          __type: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        } as GqlObj,
      }));
      return connection('PullRequestFileConnection', 'PullRequestFileEdge', items, args);
    },
    author: () => userObj(),
    repository: (parent) => repoObj(repoOf(parent as GqlObj)),
    url: (parent) => `https://forge.invalid/${repoOf(parent as GqlObj).owner}/${repoOf(parent as GqlObj).name}/pull/${((parent as GqlObj).pull as PullRec).number}`,
    createdAt: (parent) => isoOfSeq(((parent as GqlObj).pull as PullRec).dbId),
    updatedAt: (parent) => isoOfSeq(((parent as GqlObj).pull as PullRec).dbId),
  },
  IssueComment: {
    id: (parent) => globalId('IssueComment', ((parent as GqlObj).comment as { id: number }).id),
    databaseId: (parent) => ((parent as GqlObj).comment as { id: number }).id,
    body: (parent) => ((parent as GqlObj).comment as { body: string }).body,
    author: () => userObj(),
    createdAt: (parent) => isoOfSeq(((parent as GqlObj).comment as { id: number }).id),
  },
  __Type: {
    name: (parent) => (parent as GqlObj).name ?? null,
    kind: (parent) => (parent as GqlObj).kind ?? null,
    description: () => null,
    fields: (parent) => (parent as GqlObj).fields ?? null,
    enumValues: (parent) => (parent as GqlObj).enumValues ?? null,
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (parent) => (parent as GqlObj).name ?? null,
    description: () => null,
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (parent) => (parent as GqlObj).name ?? null,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: (parent) => (parent as GqlObj).types ?? [],
    queryType: (parent) => (parent as GqlObj).queryType ?? null,
    mutationType: (parent) => (parent as GqlObj).mutationType ?? null,
    subscriptionType: () => null,
    directives: () => [],
  },
};

/** The fields introspection reports per type: exactly the resolver surface, plus connection plumbing. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'repository', 'url', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'files', 'author', 'repository',
    'url', 'createdAt', 'updatedAt',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

function findIssueByGlobalId(ctx: ExecCtx, id: string): { repo: RepoRec; issue: IssueRec } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return undefined;
  return ctx.forge.findIssueByDbId(parsed.dbId);
}

function findPullByGlobalId(ctx: ExecCtx, id: string): { repo: RepoRec; pull: PullRec } | undefined {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return undefined;
  return ctx.forge.findPullByDbId(parsed.dbId);
}

function nodeById(ctx: ExecCtx, id: string): GqlObj | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  switch (parsed.type) {
    case 'Repository': {
      const repo = ctx.forge.findRepoByDbId(parsed.dbId);
      return repo === undefined ? null : repoObj(repo);
    }
    case 'Issue': {
      const found = ctx.forge.findIssueByDbId(parsed.dbId);
      return found === undefined ? null : issueObj(found.repo, found.issue);
    }
    case 'PullRequest': {
      const found = ctx.forge.findPullByDbId(parsed.dbId);
      return found === undefined ? null : pullObj(found.repo, found.pull);
    }
    case 'IssueComment': {
      const found = ctx.forge.findCommentById(parsed.dbId);
      return found === undefined ? null : commentObj(found.repo, found.issue, found.comment);
    }
    case 'User':
      return parsed.dbId === VIEWER.id ? userObj() : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- execution

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

/** Collect the fields applying to `typeName` from a selection set, expanding fragments. */
function collectFields(
  ctx: ExecCtx,
  typeName: string,
  selection: FieldNode[],
  out: Map<string, FieldNode[]>,
  visited: Set<string>,
): void {
  for (const node of selection) {
    if (!directivesKeep(node, ctx)) continue;
    if (node.fragmentSpread !== null) {
      if (visited.has(node.fragmentSpread)) continue;
      visited.add(node.fragmentSpread);
      const fragment = ctx.fragments.get(node.fragmentSpread);
      if (fragment === undefined) continue;
      if (fragment.typeCondition === typeName || (fragment.typeCondition === 'Node' && NODE_TYPES.has(typeName))) {
        collectFields(ctx, typeName, fragment.selection, out, visited);
      }
      continue;
    }
    if (node.inlineType !== null) {
      if (node.inlineType === typeName || (node.inlineType === 'Node' && NODE_TYPES.has(typeName))) {
        collectFields(ctx, typeName, node.selection ?? [], out, visited);
      }
      continue;
    }
    const key = node.alias ?? node.name;
    const list = out.get(key);
    if (list === undefined) out.set(key, [node]);
    else list.push(node);
  }
}

function executeSelection(ctx: ExecCtx, typeName: string, parent: GqlObj | null, selection: FieldNode[], path: string[]): Record<string, unknown> {
  const collected = new Map<string, FieldNode[]>();
  collectFields(ctx, typeName, selection, collected, new Set());
  const out: Record<string, unknown> = {};
  for (const [key, nodes] of collected) {
    const node = nodes[0] as FieldNode;
    out[key] = executeField(ctx, typeName, parent, node, nodes, [...path, key]);
  }
  return out;
}

function executeField(
  ctx: ExecCtx,
  typeName: string,
  parent: GqlObj | null,
  node: FieldNode,
  allNodes: FieldNode[],
  path: string[],
): unknown {
  if (node.name === '__typename') return typeName;
  const args = evalArgs(node.args, ctx);
  let value: unknown;
  const resolver = RESOLVERS[typeName]?.[node.name];
  try {
    if (resolver !== undefined) {
      value = resolver(parent, args, ctx);
    } else if (parent !== null && Object.prototype.hasOwnProperty.call(parent, node.name)) {
      value = parent[node.name];
    } else {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'`, path });
      return null;
    }
  } catch (error) {
    ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path });
    return null;
  }
  // Merge the selection sets of every node answering under this response key.
  let selection: FieldNode[] | null = null;
  for (const entry of allNodes) {
    if (entry.selection !== null) selection = [...(selection ?? []), ...entry.selection];
  }
  return completeValue(ctx, value, selection, path);
}

function completeValue(ctx: ExecCtx, value: unknown, selection: FieldNode[] | null, path: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selection, path));
  if (typeof value === 'object') {
    const obj = value as GqlObj;
    if (typeof obj.__type === 'string') {
      if (selection === null) return obj.__type === '__Type' || obj.__type === '__Schema' ? {} : null;
      return executeSelection(ctx, obj.__type, obj, selection, path);
    }
    return value;
  }
  return value;
}

/** Execute one GraphQL request object ({query, variables, operationName}) against the forge. */
export function executeGraphQL(forge: Forge, request: Record<string, unknown>): Record<string, unknown> {
  const query = typeof request.query === 'string' ? request.query : '';
  const variables: Record<string, unknown> = {};
  if (typeof request.variables === 'object' && request.variables !== null) {
    Object.assign(variables, request.variables as Record<string, unknown>);
  }
  let document: { operations: Operation[]; fragments: Map<string, FragmentDef> };
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'No operation found in the document' }] };
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation =
    (operationName !== null ? document.operations.find((op) => op.name === operationName) : undefined) ?? (document.operations[0] as Operation);
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  for (const [name, defaultNode] of Object.entries(operation.varDefaults)) {
    if (ctx.variables[name] === undefined) ctx.variables[name] = evalValue(defaultNode, ctx);
  }
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selection, []);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql request (single document or a batch array, answered in order). */
export function handleGraphQL(forge: Forge, req: Req, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      executeGraphQL(forge, typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}),
    );
    sendJson(res, 200, results);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendError(res, 400, 'Invalid GraphQL request');
    return;
  }
  sendJson(res, 200, executeGraphQL(forge, parsed as Record<string, unknown>));
}

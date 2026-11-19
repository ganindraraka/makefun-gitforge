// The GraphQL v4 surface: a dependency-free parser for the documents gh and github-mcp-server send
// (operations, variables, aliases, inline fragments, enum/list/input-object arguments), a schema
// metadata table for validation and __type introspection, and an executor over the shared forge.

import { Forge, HttpError, globalId, parseGlobalId, repoById, type Repo, type Issue, type Pull, type IssueComment } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Selection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Selection[] | null;
}

interface FragmentNode {
  kind: 'inline' | 'spread';
  typeCondition: string | null;
  name?: string;
  selections: Selection[];
}

type Node = Selection | FragmentNode;

interface Operation {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  private skip(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,﻿]/.test(this.text[this.pos])) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skip();
    return this.text[this.pos] ?? '';
  }

  private take(expected: string): boolean {
    this.skip();
    if (this.text.startsWith(expected, this.pos)) {
      this.pos += expected.length;
      return true;
    }
    return false;
  }

  private expect(expected: string): void {
    if (!this.take(expected)) throw new Error(`Syntax Error: expected ${JSON.stringify(expected)} at ${this.pos}`);
  }

  private name(): string {
    this.skip();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new Error(`Syntax Error: expected a name at ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    for (;;) {
      const next = this.peek();
      if (next === '') break;
      if (next === '{') {
        operations.push({ operation: 'query', name: null, selections: this.selectionSet() });
        continue;
      }
      const word = this.name();
      if (word === 'query' || word === 'mutation') {
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.name();
        if (this.take('(')) {
          // Variable definitions: parsed and skipped; JSON variables arrive coerced already.
          while (!this.take(')')) {
            this.expect('$');
            this.name();
            this.expect(':');
            this.typeRef();
            if (this.take('=')) this.value();
            this.directives();
          }
        }
        this.directives();
        operations.push({ operation: word, name, selections: this.selectionSet() });
        continue;
      }
      if (word === 'fragment') {
        const fragmentName = this.name();
        this.expect('on');
        const typeCondition = this.name();
        this.directives();
        fragments.set(fragmentName, { typeCondition, selections: this.selectionSet() });
        continue;
      }
      throw new Error(`Syntax Error: unexpected ${JSON.stringify(word)}`);
    }
    if (operations.length === 0) throw new Error('Syntax Error: no operation');
    return { operations, fragments };
  }

  private typeRef(): void {
    if (this.take('[')) {
      this.typeRef();
      this.expect(']');
    } else {
      this.name();
    }
    this.take('!');
  }

  private directives(): void {
    while (this.peek() === '@') {
      this.pos += 1;
      this.name();
      if (this.take('(')) this.arguments();
    }
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    for (;;) {
      const next = this.peek();
      if (next === '') throw new Error('Syntax Error: unterminated selection set');
      if (this.take('}')) break;
      if (this.take('...')) {
        this.skip();
        const isInline = /^on\b/.test(this.text.slice(this.pos)) || this.peek() === '@' || this.peek() === '{';
        if (isInline) {
          let typeCondition: string | null = null;
          if (this.take('on')) typeCondition = this.name();
          this.directives();
          const node: FragmentNode = { kind: 'inline', typeCondition, selections: this.selectionSet() };
          selections.push(node as unknown as Selection);
        } else {
          const name = this.name();
          this.directives();
          const node: FragmentNode = { kind: 'spread', typeCondition: null, name, selections: [] };
          selections.push(node as unknown as Selection);
        }
        continue;
      }
      selections.push(this.field());
    }
    return selections;
  }

  private field(): Selection {
    let name = this.name();
    let alias: string | null = null;
    if (this.take(':')) {
      alias = name;
      name = this.name();
    }
    let args: Record<string, Value> = {};
    if (this.take('(')) args = this.arguments();
    this.directives();
    let selections: Selection[] | null = null;
    if (this.peek() === '{') selections = this.selectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private arguments(): Record<string, Value> {
    const args: Record<string, Value> = {};
    for (;;) {
      if (this.take(')')) break;
      const name = this.name();
      this.expect(':');
      args[name] = this.value();
    }
    return args;
  }

  private value(): Value {
    const next = this.peek();
    if (next === '') throw new Error('Syntax Error: expected a value');
    if (this.take('$')) return { kind: 'variable', name: this.name() };
    if (this.take('[')) {
      const values: Value[] = [];
      while (!this.take(']')) values.push(this.value());
      return { kind: 'list', values };
    }
    if (this.take('{')) {
      const fields: Record<string, Value> = {};
      while (!this.take('}')) {
        const name = this.name();
        this.expect(':');
        fields[name] = this.value();
      }
      return { kind: 'object', fields };
    }
    if (next === '"') return { kind: 'string', value: this.string() };
    if (/[-0-9]/.test(next)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos))!;
      this.pos += match[0].length;
      const numeric = Number(match[0]);
      return match[0].includes('.') || match[0].includes('e') || match[0].includes('E')
        ? { kind: 'float', value: numeric }
        : { kind: 'int', value: numeric };
    }
    const word = this.name();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    return { kind: 'enum', value: word };
  }

  private string(): string {
    this.skip();
    if (this.text.startsWith('"""', this.pos)) {
      const end = this.text.indexOf('"""', this.pos + 3);
      if (end < 0) throw new Error('Syntax Error: unterminated block string');
      const value = this.text.slice(this.pos + 3, end);
      this.pos = end + 3;
      return value;
    }
    this.expect('"');
    let out = '';
    for (;;) {
      const char = this.text[this.pos];
      if (char === undefined) throw new Error('Syntax Error: unterminated string');
      this.pos += 1;
      if (char === '"') break;
      if (char === '\\') {
        const escape = this.text[this.pos++];
        if (escape === 'n') out += '\n';
        else if (escape === 't') out += '\t';
        else if (escape === 'r') out += '\r';
        else if (escape === 'b') out += '\b';
        else if (escape === 'f') out += '\f';
        else if (escape === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += escape;
        continue;
      }
      out += char;
    }
    return out;
  }
}

function evalValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': return variables[value.name] ?? null;
    case 'int':
    case 'float': return value.value;
    case 'string': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((entry) => evalValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = evalValue(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema metadata

interface TypeMeta {
  kind: 'OBJECT' | 'INTERFACE' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeMeta> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'user', 'rateLimit', 'search', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'updatePullRequest', 'addComment', 'closePullRequest'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'bio', 'company'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'ref', 'refs', 'labels', 'isEmpty', 'isFork', 'licenseInfo', 'stargazerCount', 'forkCount'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target', 'repository'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'stateReason', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'locked'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'commits', 'additions', 'deletions', 'changedFiles', 'reviewDecision', 'isDraft', 'headRef', 'baseRef', 'locked'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committedDate', 'url'] },
  GitActor: { kind: 'OBJECT', fields: ['name', 'email', 'date', 'user'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  UpdateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  UpdatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  ClosePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'issue', 'subject', 'clientMutationId'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'ofType', 'interfaces'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason', 'args', 'type'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'directives'] },
  __Directive: { kind: 'OBJECT', fields: ['name', 'description', 'locations', 'args'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'ORGANIZATION', 'TEAM'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestReviewDecision: { kind: 'ENUM', enumValues: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] },
};

// ---------------------------------------------------------------- views

type Obj = Record<string, unknown> & { __type: string };

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function gqlUser(): Obj {
  return { __type: 'User', id: globalId('User', VIEWER.id), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email, url: `http://localhost/${VIEWER.login}`, avatarUrl: '', createdAt: '2025-01-01T00:00:00Z', bio: null, company: null };
}

function gqlRepo(repo: Repo): Obj {
  return {
    __type: 'Repository',
    __repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: gqlUser(),
    description: repo.description,
    url: `http://localhost/${repo.fullName}`,
    isPrivate: repo.private,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: iso(repo.createdAt),
    updatedAt: iso(repo.updatedAt),
    isEmpty: repo.refs.size === 0,
    isFork: false,
    licenseInfo: null,
    stargazerCount: 0,
    forkCount: 0,
  };
}

function gqlIssue(repo: Repo, issue: Issue): Obj {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    stateReason: issue.state === 'closed' ? 'COMPLETED' : null,
    url: `http://localhost/${repo.fullName}/issues/${issue.number}`,
    createdAt: iso(issue.createdAt),
    updatedAt: iso(issue.updatedAt),
    closedAt: iso(issue.closedAt),
    author: gqlUser(),
    locked: false,
    repository: gqlRepo(repo),
  };
}

function gqlPull(forge: Forge, repo: Repo, pull: Pull): Obj {
  const mergeable = forge.pullMergeable(repo, pull);
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergeable: mergeable === true ? 'MERGEABLE' : mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    headRefName: pull.head,
    baseRefName: pull.base,
    url: `http://localhost/${repo.fullName}/pull/${pull.number}`,
    createdAt: iso(pull.createdAt),
    updatedAt: iso(pull.updatedAt),
    closedAt: iso(pull.closedAt),
    mergedAt: iso(pull.mergedAt),
    mergeCommit: pull.mergeCommitSha ? { __type: 'Commit', id: globalId('Commit', repo.id, pull.mergeCommitSha), oid: pull.mergeCommitSha, message: pull.title, messageHeadline: pull.title, url: '', committedDate: iso(pull.mergedAt), author: { __type: 'GitActor', name: VIEWER.name, email: VIEWER.email, date: iso(pull.mergedAt), user: gqlUser() } } : null,
    author: gqlUser(),
    reviewDecision: null,
    isDraft: false,
    locked: false,
  };
}

function gqlComment(repo: Repo, issue: Issue, comment: IssueComment): Obj {
  return {
    __type: 'IssueComment',
    id: globalId('IssueComment', comment.id),
    body: comment.body,
    author: gqlUser(),
    createdAt: iso(comment.createdAt),
    updatedAt: iso(comment.updatedAt),
    url: `http://localhost/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue: gqlIssue(repo, issue),
  };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const index = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(index) ? index : -1;
  } catch {
    return -1;
  }
}

function connection(nodeType: string, edgeType: string, items: Obj[], args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' && args.first > 0 ? Math.min(100, Math.trunc(args.first)) : 100;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  return {
    __type: `${nodeType}Connection`,
    nodes: slice,
    edges: slice.map((node, i) => ({ __type: edgeType, node, cursor: cursorOf(start + i) })),
    totalCount: items.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    },
  };
}

// ---------------------------------------------------------------- executor

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

class Executor {
  private forge: Forge;
  private variables: Record<string, unknown>;
  private fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
  errors: GqlError[] = [];

  constructor(forge: Forge, variables: Record<string, unknown>, fragments: Document['fragments']) {
    this.forge = forge;
    this.variables = variables;
    this.fragments = fragments;
  }

  private args(selection: Selection): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args)) out[key] = evalValue(value, this.variables);
    return out;
  }

  private repoFromId(id: unknown): Repo {
    const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
    const repo = parsed && parsed.kind === 'Repository' ? repoById(this.forge, Number(parsed.parts[0])) : undefined;
    if (!repo) throw new HttpError(404, 'Could not resolve to a Repository with the given id.');
    return repo;
  }

  private issueFromId(id: unknown): { repo: Repo; issue: Issue } {
    const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
    if (parsed && parsed.kind === 'Issue') {
      const repo = repoById(this.forge, Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      if (repo && issue) return { repo, issue };
    }
    throw new HttpError(404, 'Could not resolve to an Issue with the given id.');
  }

  private pullFromId(id: unknown): { repo: Repo; pull: Pull } {
    const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
    if (parsed && parsed.kind === 'PullRequest') {
      const repo = repoById(this.forge, Number(parsed.parts[0]));
      const pull = repo?.pulls.get(Number(parsed.parts[1]));
      if (repo && pull) return { repo, pull };
    }
    throw new HttpError(404, 'Could not resolve to a PullRequest with the given id.');
  }

  resolve(typeName: string, obj: Record<string, unknown>, name: string, args: Record<string, unknown>): unknown {
    const forge = this.forge;
    if (typeName === 'Query') {
      switch (name) {
        case 'viewer': return gqlUser();
        case 'user': return gqlUser();
        case 'repository': {
          const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo ? gqlRepo(repo) : null;
        }
        case 'node': return this.node(args.id);
        case '__type': {
          const meta = SCHEMA[String(args.name ?? '')];
          if (!meta) return null;
          return {
            __type: '__Type',
            name: String(args.name),
            kind: meta.kind,
            description: null,
            fields: meta.fields ? meta.fields.map((field) => ({ __type: '__Field', name: field, description: null, isDeprecated: false, deprecationReason: null, args: [], type: null })) : null,
            enumValues: meta.enumValues ? meta.enumValues.map((value) => ({ __type: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })) : null,
            inputFields: null,
            ofType: null,
            interfaces: meta.kind === 'OBJECT' ? [{ __type: '__Type', name: 'Node', kind: 'INTERFACE', fields: null, enumValues: null }] : null,
          };
        }
        case '__schema': {
          return {
            __type: '__Schema',
            types: Object.entries(SCHEMA).map(([name2, meta]) => ({ __type: '__Type', name: name2, kind: meta.kind, description: null, fields: null, enumValues: null })),
            queryType: { __type: '__Type', name: 'Query', kind: 'OBJECT', fields: null, enumValues: null },
            mutationType: { __type: '__Type', name: 'Mutation', kind: 'OBJECT', fields: null, enumValues: null },
            directives: [],
          };
        }
        case 'rateLimit': return { __type: 'RateLimit', limit: 5000, remaining: 4999, resetAt: iso(Date.now() + 3600_000), cost: 1, nodeCount: 0 };
        case 'search': return connection('SearchResultItem', 'SearchResultItemEdge', [], args);
        default: return null;
      }
    }
    if (typeName === 'Mutation') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      try {
        switch (name) {
          case 'createIssue': {
            const repo = this.repoFromId(input.repositoryId);
            const issue = forge.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', Array.isArray(input.labels) ? (input.labels as string[]) : []);
            return { __type: 'CreateIssuePayload', issue: gqlIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
          }
          case 'closeIssue': {
            const { repo, issue } = this.issueFromId(input.issueId);
            issue.state = 'closed';
            issue.closedAt = Date.now();
            issue.updatedAt = Date.now();
            issue.rev += 1;
            return { __type: 'CloseIssuePayload', issue: gqlIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
          }
          case 'updateIssue': {
            const { repo, issue } = this.issueFromId(input.id ?? input.issueId);
            if (typeof input.title === 'string') issue.title = input.title;
            if (typeof input.body === 'string') issue.body = input.body;
            if (input.state === 'OPEN' || input.state === 'CLOSED') {
              issue.state = input.state === 'OPEN' ? 'open' : 'closed';
              issue.closedAt = issue.state === 'closed' ? Date.now() : null;
            }
            issue.updatedAt = Date.now();
            issue.rev += 1;
            return { __type: 'UpdateIssuePayload', issue: gqlIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
          }
          case 'createPullRequest': {
            const repo = this.repoFromId(input.repositoryId);
            const pull = forge.createPull(repo, {
              title: String(input.title ?? ''),
              body: typeof input.body === 'string' ? input.body : '',
              head: String(input.headRefName ?? ''),
              base: String(input.baseRefName ?? ''),
            });
            return { __type: 'CreatePullRequestPayload', pullRequest: gqlPull(forge, repo, pull), clientMutationId: input.clientMutationId ?? null };
          }
          case 'mergePullRequest': {
            const { repo, pull } = this.pullFromId(input.pullRequestId);
            const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
            forge.mergePull(repo, pull, method);
            return { __type: 'MergePullRequestPayload', pullRequest: gqlPull(forge, repo, pull), clientMutationId: input.clientMutationId ?? null };
          }
          case 'closePullRequest': {
            const { repo, pull } = this.pullFromId(input.pullRequestId);
            pull.state = 'closed';
            pull.closedAt = Date.now();
            pull.updatedAt = Date.now();
            return { __type: 'ClosePullRequestPayload', pullRequest: gqlPull(forge, repo, pull), clientMutationId: input.clientMutationId ?? null };
          }
          case 'addComment': {
            const { repo, issue } = this.issueFromId(input.subjectId);
            const comment = forge.addComment(repo, issue, String(input.body ?? ''));
            return {
              __type: 'AddCommentPayload',
              commentEdge: { __type: 'IssueCommentEdge', node: gqlComment(repo, issue, comment), cursor: cursorOf(issue.comments.length - 1) },
              issue: gqlIssue(repo, issue),
              subject: gqlIssue(repo, issue),
              clientMutationId: input.clientMutationId ?? null,
            };
          }
          default: return null;
        }
      } catch (err) {
        if (err instanceof HttpError) throw new Error(err.message);
        throw err;
      }
    }
    if (typeName === 'Repository') {
      const repo = obj.__repo as Repo;
      switch (name) {
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? gqlIssue(repo, issue) : null;
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states && states.length > 0) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const order = (args.orderBy ?? {}) as Record<string, unknown>;
          const field = typeof order.field === 'string' ? order.field : 'CREATED_AT';
          const direction = order.direction === 'ASC' ? 1 : -1;
          const key = (issue: Issue): number => field === 'UPDATED_AT' ? issue.updatedAt : field === 'COMMENTS' ? issue.comments.length : issue.createdAt;
          issues.sort((a, b) => (key(a) - key(b) || a.number - b.number) * direction);
          return connection('Issue', 'IssueEdge', issues.map((issue) => gqlIssue(repo, issue)), args);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? gqlPull(this.forge, repo, pull) : null;
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) && (args.states as string[]).length > 0 ? (args.states as string[]) : ['OPEN'];
          pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          pulls.sort((a, b) => (b.createdAt - a.createdAt) || b.number - a.number);
          return connection('PullRequest', 'PullRequestEdge', pulls.map((pull) => gqlPull(this.forge, repo, pull)), args);
        }
        case 'defaultBranchRef': {
          const tip = this.forge.branchTip(repo, repo.defaultBranch);
          if (tip === undefined) return null;
          return { __type: 'Ref', id: globalId('Ref', repo.id, repo.headRef()), name: repo.defaultBranch, prefix: 'refs/heads/', target: { __type: 'Commit', id: globalId('Commit', repo.id, tip), oid: tip, message: '', messageHeadline: '', url: '', committedDate: iso(repo.updatedAt), author: null }, repository: gqlRepo(repo) };
        }
        case 'ref': {
          const qualified = String(args.qualifiedName ?? '');
          const ref = qualified.startsWith('refs/') ? qualified : `refs/heads/${qualified}`;
          const tip = repo.refs.get(ref);
          if (tip === undefined) return null;
          return { __type: 'Ref', id: globalId('Ref', repo.id, ref), name: ref.replace(/^refs\/heads\//, ''), prefix: ref.slice(0, ref.lastIndexOf('/') + 1), target: { __type: 'Commit', id: globalId('Commit', repo.id, tip), oid: tip, message: '', messageHeadline: '', url: '', committedDate: iso(repo.updatedAt), author: null }, repository: gqlRepo(repo) };
        }
        case 'labels': {
          const labels = [...repo.labels.values()].map((label) => ({ __type: 'Label', id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description }));
          return connection('Label', 'LabelEdge', labels, args);
        }
        case 'owner': return gqlUser();
        default: return obj[name] ?? null;
      }
    }
    if (typeName === 'PullRequest') {
      const repo = obj.__repo as Repo;
      const pull = obj.__pull as Pull;
      switch (name) {
        case 'files': {
          const files = this.forge.pullFiles(repo, pull).map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions }));
          return connection('PullRequestChangedFile', 'PullRequestChangedFileEdge', files, args);
        }
        case 'headRef': return { __type: 'Ref', id: globalId('Ref', repo.id, `refs/heads/${pull.head}`), name: pull.head, prefix: 'refs/heads/', target: null, repository: gqlRepo(repo) };
        case 'baseRef': return { __type: 'Ref', id: globalId('Ref', repo.id, `refs/heads/${pull.base}`), name: pull.base, prefix: 'refs/heads/', target: null, repository: gqlRepo(repo) };
        case 'commits': return connection('PullRequestCommit', 'PullRequestCommitEdge', [], args);
        default: return obj[name] ?? null;
      }
    }
    if (typeName === 'Issue') {
      const repo = obj.__repo as Repo;
      const issue = obj.__issue as Issue;
      switch (name) {
        case 'comments': return connection('IssueComment', 'IssueCommentEdge', issue.comments.map((comment) => gqlComment(repo, issue, comment)), args);
        case 'labels': return connection('Label', 'LabelEdge', issue.labels.map((label) => ({ __type: 'Label', id: globalId('Label', label.id), name: label.name, color: label.color, description: label.description })), args);
        default: return obj[name] ?? null;
      }
    }
    return obj[name] ?? null;
  }

  private node(id: unknown): Obj | null {
    const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
    if (!parsed) return null;
    if (parsed.kind === 'Repository') {
      const repo = repoById(this.forge, Number(parsed.parts[0]));
      return repo ? gqlRepo(repo) : null;
    }
    if (parsed.kind === 'Issue') {
      const repo = repoById(this.forge, Number(parsed.parts[0]));
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      return repo && issue ? gqlIssue(repo, issue) : null;
    }
    if (parsed.kind === 'PullRequest') {
      const repo = repoById(this.forge, Number(parsed.parts[0]));
      const pull = repo?.pulls.get(Number(parsed.parts[1]));
      return repo && pull ? gqlPull(this.forge, repo, pull) : null;
    }
    if (parsed.kind === 'IssueComment') {
      const commentId = Number(parsed.parts[0]);
      for (const repo of this.forge.repoList) {
        for (const issue of repo.issues.values()) {
          const comment = issue.comments.find((entry) => entry.id === commentId);
          if (comment) return gqlComment(repo, issue, comment);
        }
      }
      return null;
    }
    if (parsed.kind === 'User') return gqlUser();
    return null;
  }

  project(typeName: string, obj: Record<string, unknown>, selections: Selection[], path: Array<string | number>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const meta = SCHEMA[typeName];
    for (const selection of selections) {
      const node = selection as unknown as FragmentNode;
      if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === typeName) {
          Object.assign(out, this.project(typeName, obj, node.selections, path));
        }
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = this.fragments.get(node.name!);
        if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
          Object.assign(out, this.project(typeName, obj, fragment.selections, path));
        }
        continue;
      }
      const field = selection;
      const key = field.alias ?? field.name;
      if (!meta || !meta.fields || !meta.fields.includes(field.name)) {
        this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path: [...path, key] });
        continue;
      }
      let value: unknown;
      try {
        value = this.resolve(typeName, obj, field.name, this.args(field));
      } catch (err) {
        this.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = this.projectValue(value, field.selections, [...path, key]);
    }
    return out;
  }

  private projectValue(value: unknown, selections: Selection[] | null, path: Array<string | number>): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((entry, index) => this.projectValue(entry, selections, [...path, index]));
    if (selections && typeof value === 'object') {
      const obj = value as Obj;
      if (typeof obj.__type === 'string') return this.project(obj.__type, obj, selections, path);
      return null;
    }
    return value;
  }
}

export interface GraphQLResult {
  data?: unknown;
  errors?: GqlError[];
}

export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string | null): GraphQLResult {
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operationName
    ? document.operations.find((entry) => entry.name === operationName)
    : document.operations[0];
  if (!operation) return { errors: [{ message: 'Unknown operation named.' }] };
  const executor = new Executor(forge, variables ?? {}, document.fragments);
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executor.project(rootType, {}, operation.selections, []);
  return executor.errors.length > 0 ? { data, errors: executor.errors } : { data };
}

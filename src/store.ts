// The forge's state: one object store shared by every repository, repositories with refs, issues,
// pull requests, labels and comments, and the operations the REST, git, GraphQL and MCP surfaces
// share (contents commits, branch management, three-way merges). Everything is in memory.

import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';
import {
  type GitObject,
  type GitObjectType,
  type TreeEntry,
  ZERO_OID,
  GitError,
  hashObject,
  makeObject,
  parseCommit,
  parseTree,
  buildTree,
  buildCommit,
  collectReachable,
  isAncestor,
  peelToCommit,
  isOid,
} from './git.ts';

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown> | undefined;

  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /** Bumped on every mutation; invalidates the serialized-JSON cache. */
  rev: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string = DEFAULT_BRANCH;
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  nextNumber = 1;
  createdAt: number;
  updatedAt: number;
  refVersion = 0;
  /** Invariant URL prefixes (owner/name never change after creation). */
  readonly apiBase: string;
  readonly htmlBase: string;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.private = isPrivate;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.apiBase = `/api/v3/repos/${owner}/${name}`;
    this.htmlBase = `http://localhost/${owner}/${name}`;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  bumpRefs(): void {
    this.refVersion += 1;
    this.updatedAt = Date.now();
  }
}

export interface FlatEntry {
  mode: string;
  oid: string;
}

export type FlatTree = Map<string, FlatEntry>;

export interface ContentResult {
  commitSha: string;
  blobSha: string | null;
  created: boolean;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  sha: string | null;
}

const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

export class Forge {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  repoList: Repo[] = [];
  nextRepoId = 5000;
  nextIssueId = 100_000;
  nextCommentId = 200_000;
  nextLabelId = 300_000;

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  storeObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, makeObject(type, data));
    return oid;
  }

  // ---------------------------------------------------------------- repositories

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }] });
    }
    const key = `${VIEWER.login.toLowerCase()}/${name.toLowerCase()}`;
    if (this.repos.has(key)) {
      throw new HttpError(422, 'Repository creation failed.', {
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      });
    }
    const repo = new Repo(this.nextRepoId++, VIEWER.login, name, description ?? '', isPrivate === true);
    this.repos.set(key, repo);
    this.repoList.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  requireRepo(owner: string, name: string): Repo {
    const lower = owner.toLowerCase();
    const repo = this.repos.get(`${lower}/${name.toLowerCase()}`);
    if (!repo || repo.owner.toLowerCase() !== lower) throw new HttpError(404, 'Not Found');
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`);
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
  }

  // ---------------------------------------------------------------- refs

  /** Resolve a branch name, tag name, full ref, HEAD or raw oid to a commit oid. */
  resolveCommit(repo: Repo, ref: string | undefined | null): string | null {
    const name = ref === undefined || ref === null || ref === '' ? repo.defaultBranch : ref;
    const candidates = [name, `refs/heads/${name}`, `refs/tags/${name}`];
    if (name === 'HEAD') candidates.unshift(repo.headRef());
    for (const candidate of candidates) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) return peelToCommit(oid, this.lookup);
    }
    if (isOid(name)) return peelToCommit(name, this.lookup);
    return null;
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  createRef(repo: Repo, ref: string, sha: string): void {
    if (typeof ref !== 'string' || !ref.startsWith('refs/')) throw new HttpError(422, 'Validation Failed');
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
    if (!isOid(sha) || !this.objects.has(sha)) throw new HttpError(422, 'Validation Failed: sha must be a valid object');
    repo.refs.set(ref, sha);
    repo.bumpRefs();
  }

  // ---------------------------------------------------------------- trees

  flattenTree(treeOid: string, prefix = '', out: FlatTree = new Map()): FlatTree {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  commitTree(repo: Repo, tip: string | null): FlatTree {
    if (tip === null) return new Map();
    const object = this.objects.get(tip);
    if (!object || object.type !== 'commit') return new Map();
    return this.flattenTree(parseCommit(object.data).tree);
  }

  buildTreeFromFlat(flat: FlatTree): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, FlatTree>();
      for (const [path, entry] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (!sub) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, entry);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.storeObject('tree', buildTree(entries));
    };
    return build('');
  }

  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return this.storeObject('commit', data);
  }

  // ---------------------------------------------------------------- contents

  /** Read a path at a ref: a file's bytes, a directory's entries, or null when absent. */
  readPath(repo: Repo, ref: string | undefined | null, path: string):
    | { kind: 'file'; sha: string; data: Buffer; name: string; path: string }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> }
    | null {
    const tip = this.resolveCommit(repo, ref);
    if (tip === null) return null;
    const commit = parseCommit(this.objects.get(tip)!.data);
    let treeOid = commit.tree;
    const clean = path.replace(/^\/+|\/+$/g, '');
    const segments = clean === '' ? [] : clean.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') return { kind: 'dir', entries: this.dirEntries(entry.oid, clean) };
        const blob = this.objects.get(entry.oid);
        if (!blob) return null;
        return { kind: 'file', sha: entry.oid, data: blob.data, name: entry.name, path: clean };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return { kind: 'dir', entries: this.dirEntries(treeOid, '') };
  }

  private dirEntries(treeOid: string, prefix: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> {
    const tree = this.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => {
      const isDir = entry.mode === '40000';
      const object = this.objects.get(entry.oid);
      return {
        name: entry.name,
        path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        sha: entry.oid,
        type: isDir ? ('dir' as const) : ('file' as const),
        size: isDir ? 0 : (object?.data.length ?? 0),
      };
    });
  }

  /** Create/update/delete one file with a commit; the GitHub contents API semantics. */
  writePath(repo: Repo, options: {
    path: string;
    content: Buffer | null;
    message: string;
    branch?: string;
    sha?: string;
  }): ContentResult {
    const path = options.path.replace(/^\/+|\/+$/g, '');
    if (path === '' || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new HttpError(422, 'Validation Failed: invalid path');
    }
    const branch = options.branch ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let parent = repo.refs.get(refName) ?? null;
    if (parent === null && branch !== repo.defaultBranch) parent = repo.refs.get(repo.headRef()) ?? null;
    const flat = this.commitTree(repo, parent);
    const existing = flat.get(path);
    let created = false;
    let blobSha: string | null = null;
    if (options.content !== null) {
      if (existing) {
        if (options.sha === undefined) throw new HttpError(422, "Validation Failed: 'sha' wasn't supplied");
        if (options.sha.toLowerCase() !== existing.oid) throw new HttpError(409, 'Conflict: the file was changed on the branch');
      } else {
        created = true;
      }
      blobSha = this.storeObject('blob', options.content);
      flat.set(path, { mode: '100644', oid: blobSha });
    } else {
      if (!existing) throw new HttpError(404, 'Not Found');
      if (options.sha !== undefined && options.sha.toLowerCase() !== existing.oid) {
        throw new HttpError(409, 'Conflict: the file was changed on the branch');
      }
      flat.delete(path);
    }
    const treeOid = this.buildTreeFromFlat(flat);
    const commitSha = this.makeCommit(treeOid, parent === null ? [] : [parent], options.message);
    repo.refs.set(refName, commitSha);
    repo.bumpRefs();
    return { commitSha, blobSha, created };
  }

  // ---------------------------------------------------------------- history and merges

  history(tip: string, limit: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  mergeBase(a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const queue = [a];
    while (queue.length) {
      const oid = queue.pop()!;
      if (ancestors.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      ancestors.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const walk = [b];
    const seen = new Set<string>();
    while (walk.length) {
      const oid = walk.shift()!;
      if (ancestors.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) walk.push(parent);
    }
    return null;
  }

  private treeOfCommit(oid: string | null): string | null {
    if (oid === null) return null;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Three-way tree merge; null when any path conflicts. */
  mergeTrees(baseOid: string | null, oursOid: string, theirsOid: string): string | null {
    const base = baseOid === null ? new Map<string, FlatEntry>() : this.flattenTree(baseOid);
    const ours = this.flattenTree(oursOid);
    const theirs = this.flattenTree(theirsOid);
    const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean =>
      a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode;
    const result: FlatTree = new Map();
    const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      let chosen: FlatEntry | undefined;
      if (same(o, t)) chosen = o;
      else if (same(o, b)) chosen = t;
      else if (same(t, b)) chosen = o;
      else return null;
      if (chosen !== undefined) result.set(path, chosen);
    }
    return this.buildTreeFromFlat(result);
  }

  /** The merge plan for a pull request, or null when it conflicts. */
  mergePlan(repo: Repo, pull: Pull): { treeOid: string; baseTip: string; headTip: string } | null {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return null;
    const base = this.mergeBase(baseTip, headTip);
    const baseTree = this.treeOfCommit(base);
    const oursTree = this.treeOfCommit(baseTip);
    const theirsTree = this.treeOfCommit(headTip);
    if (oursTree === null || theirsTree === null) return null;
    const treeOid = this.mergeTrees(baseTree, oursTree, theirsTree);
    if (treeOid === null) return null;
    return { treeOid, baseTip, headTip };
  }

  pullMergeable(repo: Repo, pull: Pull): boolean | null {
    if (pull.merged) return null;
    if (pull.state !== 'open') return null;
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return false;
    if (isAncestor(headTip, baseTip, this.lookup)) return null;
    return this.mergePlan(repo, pull) !== null;
  }

  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = this.mergeBase(baseTip, headTip);
    const oldFlat = this.commitTree(repo, base);
    const newFlat = this.commitTree(repo, headTip);
    const lineCount = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const object = this.objects.get(oid);
      if (!object || object.data.length === 0) return 0;
      const text = object.data.toString('utf8');
      let lines = 0;
      for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lines += 1;
      if (!text.endsWith('\n')) lines += 1;
      return Math.max(1, lines);
    };
    const files: PullFile[] = [];
    const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = oldFlat.get(path);
      const newEntry = newFlat.get(path);
      if (oldEntry && newEntry && oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) continue;
      if (!oldEntry && newEntry) {
        const additions = lineCount(newEntry.oid);
        files.push({ filename: path, status: 'added', additions, deletions: 0, sha: newEntry.oid });
      } else if (oldEntry && !newEntry) {
        const deletions = lineCount(oldEntry.oid);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, sha: oldEntry.oid });
      } else {
        const additions = lineCount(newEntry?.oid);
        const deletions = lineCount(oldEntry?.oid);
        files.push({ filename: path, status: 'modified', additions, deletions, sha: newEntry?.oid ?? null });
      }
    }
    return files;
  }

  mergePull(repo: Repo, pull: Pull, method: string): { sha: string; message: string } {
    if (pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
    const plan = this.mergePlan(repo, pull);
    if (plan === null) throw new HttpError(405, 'Pull Request is not mergeable');
    if (isAncestor(plan.headTip, plan.baseTip, this.lookup)) throw new HttpError(405, 'Pull Request is not mergeable');
    let parents: string[];
    let message: string;
    if (method === 'merge') {
      parents = [plan.baseTip, plan.headTip];
      message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
    } else {
      parents = [plan.baseTip];
      message = `${pull.title} (#${pull.number})`;
    }
    const sha = this.makeCommit(plan.treeOid, parents, message);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    repo.bumpRefs();
    const now = Date.now();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.mergeCommitSha = sha;
    return { sha, message: 'Pull Request successfully merged' };
  }

  // ---------------------------------------------------------------- issues, labels, comments, pulls

  createLabel(repo: Repo, name: string, color: string): Label {
    if (typeof name !== 'string' || name === '') throw new HttpError(422, 'Validation Failed');
    if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
    const label: Label = { id: this.nextLabelId++, name, color: typeof color === 'string' && color !== '' ? color.replace(/^#/, '') : 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    if (typeof title !== 'string' || title === '') throw new HttpError(422, 'Validation Failed: title is required');
    const attached: Label[] = [];
    for (const name of labels) {
      const label = repo.labels.get(name);
      if (!label) {
        throw new HttpError(422, 'Validation Failed', { errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label ${JSON.stringify(name)} does not exist` }] });
      }
      attached.push(label);
    }
    const now = Date.now();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: typeof body === 'string' ? body : '',
      state: 'open',
      labels: attached,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      rev: 0,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  requireIssue(repo: Repo, number: number): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new HttpError(404, 'Not Found');
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    if (typeof body !== 'string' || body === '') throw new HttpError(422, 'Validation Failed: body is required');
    const now = Date.now();
    const comment: IssueComment = { id: this.nextCommentId++, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    issue.updatedAt = now;
    issue.rev += 1;
    return comment;
  }

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull {
    const { title, head, base } = input;
    if (typeof title !== 'string' || title === '' || typeof head !== 'string' || head === '' || typeof base !== 'string' || base === '') {
      throw new HttpError(422, 'Validation Failed');
    }
    if (head === base) throw new HttpError(422, 'Validation Failed: head and base must differ');
    if (!this.branchTip(repo, head)) throw new HttpError(422, 'Validation Failed: head branch does not exist');
    if (!this.branchTip(repo, base)) throw new HttpError(422, 'Validation Failed: base branch does not exist');
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === head && pull.base === base) {
        throw new HttpError(422, 'Validation Failed: a pull request already exists for this head and base');
      }
    }
    const now = Date.now();
    const pull: Pull = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  requirePull(repo: Repo, number: number): Pull {
    const pull = repo.pulls.get(number);
    if (!pull) throw new HttpError(404, 'Not Found');
    return pull;
  }

  /** Objects reachable from roots, as a set (missing objects tolerated). */
  reachable(roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup, true);
  }
}

// ---------------------------------------------------------------- global (Relay) ids

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

export function repoById(forge: Forge, id: number): Repo | undefined {
  return forge.repoList.find((repo) => repo.id === id);
}

export { ZERO_OID, GitError, isAncestor };

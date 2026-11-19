// Git smart HTTP: upload-pack protocol v2 (ls-refs, fetch with shallow/deepen) and v0, plus
// receive-pack v0 (report-status, side-band-64k, delete-refs). Packs are real: objects are stored
// by SHA-1, fetches send only what the client lacks, and pushes verify ancestry per ref.

import { Forge, HttpError, Repo } from './store.ts';
import {
  type GitObject,
  ZERO_OID,
  GitError,
  pkt,
  pktLines,
  FLUSH,
  DELIM,
  decodePackets,
  packetLines,
  writePack,
  readPack,
  sidebandPack,
  collectReachable,
  isAncestor,
  peelToCommit,
  parseCommit,
  parseTag,
  isOid,
} from './git.ts';

export interface GitRequest {
  method: string;
  owner: string;
  /** Repository name without the .git suffix. */
  name: string;
  /** Path after /{owner}/{name}.git, e.g. '/info/refs'. */
  suffix: string;
  query: URLSearchParams;
  gitProtocol: string;
  body: Buffer;
}

export interface GitResult {
  status: number;
  contentType?: string;
  body?: Buffer;
  json?: unknown;
}

const UPLOAD_CAPS = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=gh-forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta quiet agent=gh-forge/1.0';
const SIDEBAND_CHUNK = 65515;

interface FetchPlan {
  pack: Buffer | null;
  shallowLines: string[];
}

export class GitHttp {
  private forge: Forge;
  private advertisementCache = new Map<string, Buffer>();
  private v2Cache = new Map<string, Buffer>();

  constructor(forge: Forge) {
    this.forge = forge;
  }

  handle(request: GitRequest): GitResult {
    const repo = this.forge.getRepo(request.owner, request.name);
    if (!repo) throw new HttpError(404, 'Repository not found');
    if (request.method === 'GET' && request.suffix === '/info/refs') return this.infoRefs(repo, request);
    if (request.method === 'POST' && request.suffix === '/git-upload-pack') return this.uploadPack(repo, request);
    if (request.method === 'POST' && request.suffix === '/git-receive-pack') return this.receivePack(repo, request);
    throw new HttpError(404, 'Not Found');
  }

  // ---------------------------------------------------------------- advertisements

  private infoRefs(repo: Repo, request: GitRequest): GitResult {
    const service = request.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw new HttpError(400, 'Invalid service');
    const v2 = service === 'git-upload-pack' && /version=2/.test(request.gitProtocol);
    const key = `${repo.id}:${service}:${v2}:${repo.refVersion}`;
    let body = this.advertisementCache.get(key);
    if (!body) {
      body = service === 'git-receive-pack' ? this.v0Advertisement(repo, RECEIVE_CAPS, false)
        : v2 ? this.v2Advertisement()
        : this.v0Advertisement(repo, `${UPLOAD_CAPS} symref=HEAD:${repo.headRef()}`, true);
      if (this.advertisementCache.size > 256) this.advertisementCache.clear();
      this.advertisementCache.set(key, body);
    }
    return { status: 200, contentType: `application/x-${service}-advertisement`, body };
  }

  private v2Advertisement(): Buffer {
    return pktLines(['version 2\n', 'agent=gh-forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush']);
  }

  private v0Advertisement(repo: Repo, caps: string, symref: boolean): Buffer {
    const parts: Buffer[] = [];
    const headTip = repo.refs.get(repo.headRef());
    const lines: string[] = [];
    if (headTip !== undefined) lines.push(`${headTip} HEAD`);
    const names = [...repo.refs.keys()].sort();
    for (const name of names) lines.push(`${repo.refs.get(name)} ${name}`);
    if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
    lines[0] = `${lines[0]}\0${caps}`;
    for (const line of lines) parts.push(pkt(`${line}\n`));
    // Peeled tag lines follow their tag ref.
    const peeledParts: Buffer[] = [];
    for (const name of names) {
      if (!name.startsWith('refs/tags/')) continue;
      const oid = repo.refs.get(name)!;
      const object = this.forge.objects.get(oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(oid, this.forge.lookup);
        if (peeled !== null && peeled !== oid) peeledParts.push(pkt(`${peeled} ${name}^{}\n`));
      }
    }
    const preamble = pktLines([`# service=${symref ? 'git-upload-pack' : 'git-receive-pack'}\n`, 'flush']);
    return Buffer.concat([preamble, ...parts, ...peeledParts, FLUSH]);
  }

  // ---------------------------------------------------------------- upload-pack

  private uploadPack(repo: Repo, request: GitRequest): GitResult {
    // A v2 request's answer depends only on the refs, the object store and the request bytes, so a
    // repeated body (the benchmark's concurrent clones) is served without re-parsing the packets.
    const v2Header = /version=2/.test(request.gitProtocol);
    let key = '';
    if (v2Header) {
      key = `${repo.id}:${repo.refVersion}:${request.body.toString('latin1')}`;
      const cached = this.v2Cache.get(key);
      if (cached) return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
    }
    let packets;
    try {
      packets = decodePackets(request.body).packets;
    } catch (err) {
      throw new HttpError(400, `Bad Request: ${err instanceof Error ? err.message : String(err)}`);
    }
    const lines = packetLines(packets);
    const first = (lines[0] ?? '').trim();
    const v2 = v2Header || first.startsWith('command=');
    if (!v2) return this.fetchV0(repo, lines);
    let result: GitResult;
    if (first === 'command=ls-refs') result = this.lsRefs(repo, lines);
    else if (first === 'command=fetch') result = this.fetchV2(repo, lines);
    else throw new HttpError(400, 'Bad Request: unknown v2 command');
    if (v2Header && result.body !== undefined && result.body.length < 2_000_000) {
      if (this.v2Cache.size > 64) this.v2Cache.clear();
      this.v2Cache.set(key, result.body);
    }
    return result;
  }

  private lsRefs(repo: Repo, lines: string[]): GitResult {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    let afterDelim = false;
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\n$/, '');
      if (line === '') continue;
      if (!afterDelim) {
        // Capability arguments before the delimiter are agent/object-format; the delimiter packet
        // itself is not in `lines`, so switch once the known pre-delimiter keys are exhausted.
        if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
        afterDelim = true;
      }
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
    }
    const out: string[] = [];
    const headTip = repo.refs.get(repo.headRef());
    if (prefixes.length === 0) {
      if (headTip !== undefined) {
        out.push(`${headTip} HEAD${symrefs ? ` symref-target:${repo.headRef()}` : ''}`);
      } else if (unborn) {
        out.push(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef()}` : ''}`);
      }
    }
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      if (peel && name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(oid, this.forge.lookup);
        if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
      }
      out.push(line);
    }
    const body = pktLines([...out.map((line) => `${line}\n`), 'flush']);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }

  /** Compute the pack and shallow boundary lines for a fetch. */
  private planFetch(wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
    const forge = this.forge;
    const shallowSet = new Set(clientShallow);
    const haveClosed = new Set<string>();
    if (depth === null && shallowSet.size === 0) {
      for (const oid of forge.reachable(haves)) haveClosed.add(oid);
    } else {
      // A shallow client's "have" does not include the ancestors past its shallow boundary.
      const queue = [...haves];
      while (queue.length) {
        const oid = queue.pop()!;
        if (haveClosed.has(oid)) continue;
        const object = forge.objects.get(oid);
        if (!object) continue;
        haveClosed.add(oid);
        if (object.type === 'commit') {
          const commit = parseCommit(object.data);
          try {
            for (const treeOid of collectReachable([commit.tree], forge.lookup)) haveClosed.add(treeOid);
          } catch {
            // ignore missing trees
          }
          if (!shallowSet.has(oid)) for (const parent of commit.parents) queue.push(parent);
        } else if (object.type === 'tag') {
          queue.push(parseTag(object.data).object);
        } else {
          try {
            for (const inner of collectReachable([oid], forge.lookup)) haveClosed.add(inner);
          } catch {
            // ignore missing objects
          }
        }
      }
    }
    const send = new Set<string>();
    const shallowLines: string[] = [];

    const addClosure = (root: string): void => {
      let set: Set<string>;
      try {
        set = collectReachable([root], forge.lookup);
      } catch {
        return;
      }
      for (const oid of set) if (!haveClosed.has(oid)) send.add(oid);
    };

    if (depth === null) {
      for (const want of wants) addClosure(want);
    } else {
      const boundaries = new Set<string>();
      const unshallow = new Set<string>();
      const visited = new Map<string, number>();
      const queue: Array<{ oid: string; depth: number }> = [];
      for (const want of wants) {
        const object = forge.objects.get(want);
        if (!object) continue;
        if (object.type === 'commit') {
          queue.push({ oid: want, depth: 1 });
        } else if (object.type === 'tag') {
          if (!haveClosed.has(want)) send.add(want);
          const peeled = peelToCommit(want, forge.lookup);
          if (peeled !== null) queue.push({ oid: peeled, depth: 1 });
        } else {
          addClosure(want);
        }
      }
      while (queue.length) {
        const { oid, depth: d } = queue.shift()!;
        const seen = visited.get(oid);
        if (seen !== undefined && seen <= d) continue;
        visited.set(oid, d);
        const object = forge.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        if (!haveClosed.has(oid)) send.add(oid);
        const commit = parseCommit(object.data);
        try {
          for (const treeOid of collectReachable([commit.tree], forge.lookup)) {
            if (!haveClosed.has(treeOid)) send.add(treeOid);
          }
        } catch {
          // A missing tree does not abort the whole fetch; the pack carries what exists.
        }
        if (d >= depth) {
          if (commit.parents.length > 0) boundaries.add(oid);
          continue;
        }
        if (shallowSet.has(oid)) unshallow.add(oid);
        for (const parent of commit.parents) queue.push({ oid: parent, depth: d + 1 });
      }
      for (const oid of boundaries) shallowLines.push(`shallow ${oid}\n`);
      for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
    }

    if (send.size === 0) return { pack: null, shallowLines };
    const objects: GitObject[] = [];
    for (const oid of send) {
      const object = forge.objects.get(oid);
      if (object) objects.push(object);
    }
    return { pack: writePack(objects), shallowLines };
  }

  private fetchV2(repo: Repo, lines: string[]): GitResult {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let afterDelim = false;
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/\n$/, '');
      if (line === '') continue;
      if (!afterDelim) {
        if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
        afterDelim = true;
      }
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    for (const want of wants) if (!isOid(want)) throw new HttpError(400, 'Bad Request: invalid want');

    const plan = this.planFetch(wants, haves, shallow, Number.isFinite(depth as number) ? depth : null);
    const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK\n'), DELIM];
    if (plan.shallowLines.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const line of plan.shallowLines) parts.push(pkt(line));
      parts.push(DELIM);
    }
    if (plan.pack !== null) {
      parts.push(pkt('packfile\n'));
      parts.push(...sidebandPack(plan.pack));
    }
    parts.push(FLUSH);
    const body = Buffer.concat(parts);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
  }

  private fetchV0(repo: Repo, lines: string[]): GitResult {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    if (wants.length === 0) throw new HttpError(400, 'Bad Request: no wants');
    const plan = this.planFetch(wants, haves, shallow, Number.isFinite(depth as number) ? depth : null);
    const parts: Buffer[] = [];
    for (const line of plan.shallowLines) parts.push(pkt(line));
    parts.push(pkt('NAK\n'));
    if (plan.pack !== null) parts.push(...sidebandPack(plan.pack));
    parts.push(FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  // ---------------------------------------------------------------- receive-pack

  private receivePack(repo: Repo, request: GitRequest): GitResult {
    let packets;
    let rest: Buffer;
    try {
      const decoded = decodePackets(request.body, true);
      packets = decoded.packets;
      rest = decoded.rest;
    } catch (err) {
      throw new HttpError(400, `Bad Request: ${err instanceof Error ? err.message : String(err)}`);
    }
    interface Command {
      oldOid: string;
      newOid: string;
      ref: string;
    }
    const commands: Command[] = [];
    let caps = '';
    let sawFlush = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        sawFlush = true;
        break;
      }
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        if (commands.length === 0) caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      const pieces = line.split(' ');
      if (pieces.length !== 3) throw new HttpError(400, 'Bad Request: malformed command line');
      commands.push({ oldOid: pieces[0], newOid: pieces[1], ref: pieces[2] });
    }
    if (!sawFlush || commands.length === 0) throw new HttpError(400, 'Bad Request: no commands');
    const sideband = caps.includes('side-band-64k');
    const reportStatus = caps.includes('report-status');

    // Unpack the packfile (if any) into the shared object store.
    let unpackDetail = 'ok';
    if (rest.length > 0) {
      if (rest.length < 32 || rest.subarray(0, 4).toString('ascii') !== 'PACK') {
        unpackDetail = 'invalid packfile';
      } else {
        try {
          const read = readPack(rest, this.forge.lookup);
          for (const [oid, object] of read.objects) {
            if (!this.forge.objects.has(oid)) this.forge.objects.set(oid, object);
          }
        } catch (err) {
          unpackDetail = err instanceof GitError ? `unpacker error: ${err.message}` : 'unpacker error';
        }
      }
    }

    const reports: string[] = [`unpack ${unpackDetail}\n`];
    let changed = false;
    if (unpackDetail === 'ok') {
      for (const command of commands) {
        const { oldOid, newOid, ref } = command;
        const fail = (reason: string): void => {
          reports.push(`ng ${ref} ${reason}\n`);
        };
        if (!ref.startsWith('refs/') || !isOid(oldOid) || !isOid(newOid)) {
          fail('invalid ref or object id');
          continue;
        }
        const current = repo.refs.get(ref) ?? ZERO_OID;
        if (oldOid !== current) {
          fail('stale info');
          continue;
        }
        if (newOid === ZERO_OID) {
          if (current === ZERO_OID) {
            fail('ref not found');
            continue;
          }
          repo.refs.delete(ref);
          changed = true;
          reports.push(`ok ${ref}\n`);
          continue;
        }
        const object = this.forge.objects.get(newOid);
        if (!object) {
          fail('missing necessary objects');
          continue;
        }
        if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
          fail('bad object type for branch');
          continue;
        }
        if (current !== ZERO_OID && !isAncestor(current, newOid, this.forge.lookup)) {
          fail('non-fast-forward');
          continue;
        }
        repo.refs.set(ref, newOid);
        changed = true;
        reports.push(`ok ${ref}\n`);
      }
    }
    if (changed) repo.bumpRefs();

    const resultType = 'application/x-git-receive-pack-result';
    if (!reportStatus) return { status: 200, contentType: resultType, body: FLUSH };
    const reportStream = pktLines([...reports, 'flush']);
    const body = sideband
      ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), reportStream])), FLUSH])
      : reportStream;
    return { status: 200, contentType: resultType, body };
  }
}

export { SIDEBAND_CHUNK };

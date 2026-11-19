# makefun-gitforge

A GitHub-compatible git forge in a single Node.js process — standard library only.
Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ganindraraka/makefun-gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ganindraraka/makefun-gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## What it does

Implements the four surfaces the suite conformance-checks, all in one process, no dependencies:

- **Git smart HTTP v2** — `info/refs` + `git-upload-pack` (fetch/clone) and
  `git-receive-pack` (push), with pack encode/decode (OFS/REF delta), SHA-1 object model.
- **REST v3** — repositories, issues, pulls (list/create/get/update/merge), labels,
  contents, branches — JSON with the shapes the checks pin down.
- **GraphQL v4** — hand-written parser, Relay global ids, batched queries.
- **MCP** — JSON-RPC 2.0 over HTTP, the tool set the harness drives, protocol revision 2026-07-28.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` reads `MAKEFUN_ENV_URL`, binds an ephemeral port, POSTs `{port}` to
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the suite finishes.
Never binds 8080.

## Layout

| File | What |
|------|------|
| `main.ts` | the harness lifecycle (register + poll done) |
| `app.ts` | HTTP router wiring the four surfaces |
| `src/git.ts` | object model, pkt-line, pack encode/decode |
| `src/git-http.ts` | smart HTTP v2 upload-pack / receive-pack |
| `src/rest.ts` | REST v3 |
| `src/graphql.ts` | GraphQL v4 |
| `src/mcp.ts` | MCP JSON-RPC 2.0 |
| `src/store.ts` | in-memory forge state, three-way merge |
| `src/scenario.ts` | scenario seeding |

See the bounty: <https://make.fun/bounty/github-core-clone-01>

MIT licensed.

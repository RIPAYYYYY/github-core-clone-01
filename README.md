# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/RIPAYYYYY/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/RIPAYYYYY/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only. It serves git smart HTTP (upload-pack protocol v2 with ls-refs and fetch, v0 fetch with shallow/deepen negotiation, receive-pack v0 with report-status), the REST v3 API (repositories, branches, refs, commits, contents, labels, issues, comments, pull requests, merges), the GraphQL v4 API (queries, connections, node lookups, mutations, introspection) and an MCP endpoint (server/discover, initialize, tools/list, tools/call) — all four surfaces over one shared in-memory git object store, so an object created through any surface is the same object through the rest. Real SHA-1 git objects and packs are implemented from scratch: no git binary, no dependencies, no network.

## Run it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, serves until the suite reports done, and exits 0. API and git requests carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s70vnsn3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

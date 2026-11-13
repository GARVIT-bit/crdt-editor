# CRDT Collaborative Editor

A Google Docs-style editor where many people type in the same document at once, keep editing while offline, and always end up with the same text. The CRDT at its core (the data structure that makes every copy converge) is **written from scratch**, not imported from Yjs or Automerge.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6) ![Tests](https://img.shields.io/badge/tests-131%20passing-2ea44f) ![License: MIT](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Real-time collaboration.** Every browser holds a full replica and applies its own keystrokes instantly; edits sync over WebSockets and merge in any order.
- **Offline editing.** Keep typing with no connection. Edits are saved in IndexedDB and synced on reconnect, with nothing lost and nothing doubled.
- **Live cursors.** See where everyone is. Cursors are anchored to characters, so they stay put while others type.
- **Version history.** Automatic and named versions. Restoring one applies the smallest set of edits, so it doesn't clobber people who are typing.
- **Horizontal scale-out.** Any number of Node servers behind Nginx, fanned out through Redis pub/sub, sharing one MongoDB op log. Kill a server mid-session and clients move to another with no lost edits.
- **AI co-editor.** A bot that joins as a normal collaborator and edits the document with Claude. Its edits merge with what people type while it is thinking.
- **Measured, not claimed.** Every performance number below comes from a script in `bench/` you can rerun.

## Architecture

```
 browser (React + CodeMirror 6 + RGA replica + IndexedDB outbox)
    |  WebSocket: hello / ops / acks / presence
    v
 Nginx (load balancer, WebSocket upgrade)
    |                     |
 server1               server2        (Node + Express + ws; one Room per open document)
    |   \_____ Redis _____/           (pub/sub on doc:<id>: fan-out between servers)
    v
 MongoDB replica set                  (op log + snapshots/versions)
```

Servers **never decide edit order**: they validate, store, and relay. Order comes from the CRDT alone, which is why any server can serve any document.

**Tech stack:** TypeScript everywhere (npm workspaces), React 19, CodeMirror 6, Node 24, Express 5, `ws`, MongoDB 8, Redis 7, Nginx, Docker Compose, Vitest + fast-check (property-based tests), Claude API for the bot.

## Quick start

Requirements: Node 22+ (developed on 24) and, for the full stack, Docker.

```bash
npm install                          # at the repo root (npm workspaces)

# terminal 1: server on :3000 (omit MONGO_URL to keep the op log in memory)
MONGO_URL=mongodb://127.0.0.1:27017 npm run dev:server            # bash
$env:MONGO_URL="mongodb://127.0.0.1:27017"; npm run dev:server    # PowerShell

# terminal 2: web app on :5173 (proxies /ws and /api to :3000)
npm run dev:web
```

Open <http://localhost:5173/?doc=resume> in two tabs and type in both. Try **Go offline**, edit in both tabs, then go back online. Use **History** to save and restore versions.

**Full scale-out stack** (2 servers, Nginx, MongoDB replica set, Redis, all in Docker):

```bash
docker compose up -d --build         # http://localhost:8090/?doc=resume
docker compose kill server1          # failover: clients move to server2, nothing is lost
docker compose stop                  # stop everything (data is kept)
```

Nginx listens on host port 8090 by default; set `CRDT_HTTP_PORT` to change it.

**AI co-editor** (needs Claude API credentials: `ANTHROPIC_API_KEY`, or `ant auth login`):

```bash
npm start -w @crdt-editor/bot -- --doc resume --instruction "Fix spelling and grammar"
npm start -w @crdt-editor/bot -- --doc resume --watch     # then type "@ai <instruction>" in the doc
```

Use `--server ws://localhost:8090` to point the bot at the Docker stack.

## Project structure

```
packages/crdt       the RGA CRDT (no dependencies)
packages/protocol   wire protocol + validation, DocClient (sync client shared by browser, tests and bot),
                    local storage interface, Myers character diff
apps/server         Express + ws server: rooms, op log (memory or MongoDB), Redis bus, version history API
apps/web            React + CodeMirror 6 editor: CRDT binding, IndexedDB storage, cursors, history panel
apps/bot            AI co-editor (Claude) as an ordinary CRDT client
bench               benchmarks (this RGA vs Yjs, server latency / fan-out); results in bench/results/
deploy              Nginx config
docs                learning exercises
```

## Tests

```bash
npm test                    # every package
npm run typecheck

# everything, including real MongoDB (replica set), Redis and the Docker failover test:
docker compose up -d --build
MONGO_URL="mongodb://127.0.0.1:27018/?directConnection=true" E2E_URL="http://localhost:8090" npm test

RUNS=10000 npm test -w @crdt-editor/crdt      # more random histories for the property tests
NET_RUNS=400 npm test -w @crdt-editor/server  # more random runs over real sockets / servers
```

Tests that need MongoDB or Redis use throwaway databases and are skipped with a warning if the service isn't running.

| Package | Tests | What they prove |
| --- | --- | --- |
| `packages/crdt` | 14 | the RGA converges for any concurrent history, delivery order and duplication (property test) |
| `packages/protocol` | 34 | hostile messages are rejected; the client recovers from hung or silent connections; the character diff is correct **and minimal** (checked against an exact LCS) |
| `apps/server` | 57 | rooms, relay, reject, snapshots, restart; offline edits, lost acks, reloads, two tabs; presence and history; 2-3 servers on a lossy bus; real Redis; MongoDB replica-set concurrency; **Docker failover**; random histories over **real sockets** converge; the in-memory and MongoDB stores pass the **same contract** |
| `apps/web` | 18 | the CodeMirror binding (emoji, multi-cursor, undo), IndexedDB storage, peer cursors, restore-by-diff |
| `apps/bot` | 8 | AI edits merge with people typing at the same time (fake model, no API calls) |

## Benchmarks

Every number comes from a script in `bench/` (`npm run crdt -w @crdt-editor/bench`, `npm run server -w @crdt-editor/bench`). Raw results with machine details are in `bench/results/`. Measured on an Intel Core i5-1135G7 (8 threads), 8 GB RAM, Windows 11, Node 24.20, with clients and server on the same machine.

**CRDT core, 10,000 characters (median of 5 runs), this RGA vs Yjs 13.6.33:**

| | this RGA | Yjs |
| --- | ---: | ---: |
| typing at the end (ops/sec) | 11,202 | 138,695 |
| typing at random positions (ops/sec) | 15,715 | 126,803 |
| applying remote ops (ops/sec) | 34,672 | 126,160 |
| merge latency per remote op, p50 / p99 (µs) | 91.6 / 340 | 20.5 / 91.8 |
| heap per 10k chars | 1,861 KiB | 391 KiB |
| heap per 10k chars, half deleted | 1,865 KiB | 1,435 KiB |

Yjs is about 12x faster at typing and uses about 5x less memory. It run-length-encodes consecutive characters and avoids the O(n) index scans this RGA does per keystroke (see [Known limits](#known-limits) for the fixes).

**Server:**

| | in-memory op log | MongoDB op log |
| --- | ---: | ---: |
| edit latency writer -> server -> reader, p50 / p99 | 0.2 / 0.94 ms | 5.24 / 11.68 ms |
| ingest into one document (ops/sec, batches of 50) | 3,080 | 1,572 |
| fan-out p99, 100 readers on one doc | 5.7 ms | 18.7 ms |
| fan-out p99, 500 readers | 24.7 ms | 38 ms |
| fan-out p99, 1,000 readers | 36.5 ms | not run |
| fan-out p99, 2,000 readers | 106.5 ms | not run |

Largest reader count tested on one server with 100% delivery and p99 <= 100 ms: **1,000** (in-memory log).

**Failover** (Docker stack, `apps/server/test/e2e.failover.test.ts`): after `docker kill` of one server mid-session, both clients were back online with identical text in **2.6 s** (7.3 s while the rest of the test suite was running), with every character typed during the outage delivered and stored exactly once.

## How it works

### The CRDT (`packages/crdt`)

**The problem.** Alice and Bob both type at position 5 at the same moment. If each sends "insert at index 5", the two documents end up different, because index 5 means something different on each screen after the other's edit lands.

**The fix: give every character a permanent identity.** Instead of "insert at index 5", an edit says "insert X *after character #12@bob*". Character IDs never change, so the instruction means the same thing on every machine.

| File | What it does |
| --- | --- |
| `id.ts` | IDs are `[counter, replicaId]`. The counter is a **Lamport clock**: +1 on each local edit, and jumps to `max(mine, theirs)` on every received edit, so anything typed after seeing a character gets a bigger counter. Ties are broken by replica ID. |
| `rga.ts` | The RGA (Replicated Growable Array): one node per character ever typed, including deleted ones (tombstones). |

**The one rule that makes everyone agree** (`integrateInsert`): to insert X after anchor A, start right after A and *skip every node whose ID is bigger than X's*; insert X before the first smaller one. The final position depends only on IDs, never on arrival order, so all replicas converge.

- **Idempotent:** applying the same op twice is a no-op, so the network can safely resend.
- **Tombstones:** deleting only marks a node; a concurrent insert may still be anchored to it.
- **Out-of-order arrival:** an op whose anchor hasn't arrived yet waits in a pending buffer.
- **Cursors as IDs:** a cursor is "after character X", so it doesn't jump when someone types earlier in the document.

A property test generates thousands of random histories (2-4 users, ops delivered partially, shuffled and duplicated) and checks every replica ends with the same text and internal order. Another test checks that two words typed at the same spot never interleave letter by letter.

### Live sync

```
type "x" -> localInsert -> op --ws--> validate -> causal check -> append to op log
                                      apply to the room's replica -> relay to everyone else
```

- `packages/protocol`: shared message types, strict validation, and `DocClient`, the sync client used by the browser, the tests and the bot.
- `apps/server/src/room.ts`: one `Room` per open document. All work goes through a **per-room queue**, so a joiner's catch-up and the live relays never leave a gap. Order of work: check, **persist**, apply, ack, relay.
- `apps/web/src/binding.ts`: CodeMirror <-> RGA. Converts UTF-16 positions to code points (an emoji is 2 units in CodeMirror, 1 character in the RGA). Remote changes are never re-sent and never undone by your Ctrl+Z.
- The server rejects ops that refer to characters it has never seen; otherwise they would wait in a pending buffer forever.

### Offline editing

**Send until acked, and duplicates are free.** Every local edit goes into an **outbox** (memory + IndexedDB) and stays there until the server acknowledges it. Unacked ops are re-sent on every reconnect; a unique `(docId, opId)` index makes resends no-ops.

```
client -> hello {lastSeq}           "I have every op up to 41"   (null = nothing yet)
server -> catchup {ops 42.., seq}   only what I missed            (or a full snapshot if new / too far behind)
client -> ops [whole outbox]        re-send everything unacked
server -> ack {opIds, seq}          also for duplicates, so the client can forget them
server -> reject {opIds}            ops that can never be accepted: dropped, then a clean resync
```

The outbox is stored **one record per op** so several tabs never overwrite each other. On a full snapshot the client **rebases**: server state + its own unacked ops.

### Presence and version history

- **Cursors** are sent as character IDs, throttled to one message per 100 ms, relayed through the same per-room queue as edits (so a cursor never arrives before its character), and never persisted.
- **Versions:** snapshots are never overwritten. There are automatic ones every 200 ops plus named ones (`POST /api/docs/:id/versions`), listed by `GET /api/docs/:id/versions`.
- **Restore = a diff, applied as normal edits** (Myers' algorithm on code points), so it doesn't rewrite history or fight people who are typing.

### Scale-out

Any server can serve any document: a server stores an op, relays it to its clients, and publishes it on Redis channel `doc:<id>`; other servers relay it to theirs. The hard part is **catch-up across servers**: seq 11 can be committed or relayed before seq 10, and a client that saw 11 and reconnects "from 11" would miss 10 forever. Three pieces fix it:

1. **Gap-free seqs, committed in seq order.** Duplicates are filtered before seqs are reserved, and each append is a MongoDB transaction on the document's counter, so concurrent appends to one document serialize.
2. **Watermark.** Each room tracks the highest seq `W` such that every op <= `W` has been applied. Clients only adopt `W` as their `lastSeq`, never an op's own seq.
3. **Repair.** A gap is refilled from MongoDB after 500 ms; every 5 s each room compares its watermark with the op log (a lost message followed by silence would otherwise go unnoticed); after a Redis reconnect every room resyncs. Remote cursors expire if their server stops announcing them.

Fast failover needs timeouts on both sides: Nginx gives up on a dead server after 2 s (`proxy_connect_timeout`), and the client drops a connection that doesn't sync within 10 s or goes silent (app-level `ping`/`pong`, since browsers can't see WebSocket ping frames).

### AI co-editor

The bot (`apps/bot`) is just another CRDT client. When asked to edit it:

1. **forks** its replica at that moment,
2. asks Claude for the revised text (structured output),
3. diffs the original against the revision **on the fork**, producing ops anchored to the fork's character IDs,
4. applies them to the live replica and sends them.

Because the ops point at characters, not positions, edits people make while the model is thinking survive, even inside the sentence being rewritten. In watch mode it reacts to a line `@ai <instruction>` typed into the document.

## Known limits

**Sync and servers**
- No authentication or authorization yet: anyone who can reach the server can edit any document. No `Origin` check on the WebSocket upgrade.
- Several servers need MongoDB as a replica set (for transactional appends). A standalone MongoDB is only correct with a single server.
- Redis pub/sub is at-most-once. Lost messages are repaired from the op log, so one can delay delivery by up to ~5 s.
- If a server dies without closing its sockets, clients notice within ~35 s (heartbeat). A crashed container is noticed immediately.
- A snapshot is one MongoDB document, capped at 16 MB (very roughly 200k characters of history).
- Each server keeps one replica per open document in memory, and server ingest is bounded by the RGA's O(n) cost per op.
- The bot sends the whole document to the model (limit: 50,000 characters).

**CRDT core**
- Index lookups are O(n) per keystroke; a balanced tree with visible counts per subtree would make them O(log n).
- Tombstones are never compacted. Safe rule: drop them in a snapshot once every client has seen the delete.
- One node per character; Yjs saves a lot of memory by run-length encoding consecutively typed text.
- RGA prevents interleaving for text typed forwards; typing backwards (Home + type) can still interleave. The Fugue algorithm (Weidner and Kleppmann, 2023) fixes that.

## Learn by breaking it

[`docs/exercises.md`](docs/exercises.md) lists small changes to make on purpose, with what the tests should do and why.

## License

[MIT](LICENSE)

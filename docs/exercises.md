# Break it on purpose

Learning exercises: make a small change, predict what happens, run the tests, compare, then undo it.

## CRDT core (`packages/crdt`)

Each of these is caught by the tests.

1. In `rga.ts`, change the skip rule `compareId(...) > 0` to `< 0`. How many tests fail? Look at the fast-check counterexample: it's the smallest history that breaks it. Can you explain it on paper?
2. Remove `this.clock.observe(op.id[0])` from `integrateInsert`. Why does a character typed *after* seeing another one now sometimes land in the wrong place?
3. Remove the duplicate check at the top of `integrateInsert`. What happens when the network resends an op?
4. In `integrateDelete`, really remove the node instead of marking it deleted. Which test breaks, and why do tombstones matter?

## Live sync (Phase 3)

These were verified against the **Phase 3 code**. Later phases moved some of these lines (`room.join` is now `room.hello`, and `append` now drops duplicates before reserving seqs), so a few may no longer fail the same way.

**Server (`apps/server`)**
1. In `app.ts`, replace `room.enqueue(() => room.join(ws))` with `Promise.resolve(room.join(ws))`. Which test fails? (The restart test: the joiner gets a snapshot of a room that hasn't finished loading from the store yet.)
2. In `room.ts`, make the causal check `if (false)`. Why does `pendingCount` end up 1, and why is that a slow memory leak an attacker can trigger?
3. In `room.ts`, remove `client === from ||` so authors get their own ops back. Predict first: do the convergence tests fail? (No: idempotence quietly absorbs the echo. Only a strict message-count test notices. Correctness is free; bandwidth isn't.)

**Binding (`apps/web`)**
1. In `opsFromTransaction`, drop `|| tr.annotation(remote)`. What happens to a remote edit? (It's re-sent as a brand-new local edit: duplicated text.)
2. Replace `cpLength(tr.newDoc.sliceString(0, fromB))` with `fromB`. Type `😀` then `x`. Why is it off by one only after an emoji?
3. Remove `Transaction.addToHistory.of(false)`. Whose text does Ctrl+Z delete now?

**MongoDB (`apps/server/src/mongoStore.ts`)**
1. Remove `unique: true` from the `(docId, opId)` index. What does a network resend do to the log?
2. Change `$gt` to `$gte` in `opsSince`. The document still loads correctly. Why? (Idempotence again.) What does it cost, and which test notices?
3. Change `ordered: false` to `ordered: true`. When can `append` now report something it didn't store?

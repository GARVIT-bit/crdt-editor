import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opsToMatch, type PresenceState } from "@crdt-editor/protocol";
import { startServer, type RunningServer } from "../src/app.js";
import { MemoryStore } from "../src/store.js";
import { connect, ofType, rawSocket, until, type TestClient } from "./helpers.js";

let store: MemoryStore;
let server: RunningServer;
let docN = 0;
const freshDoc = () => `ph${++docN}`;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  store = new MemoryStore();
  server = await startServer({ store, snapshotEvery: 10 });
});
afterAll(async () => {
  await server.close();
});

const presences = (c: TestClient) => ofType(c.messages, "presence");
const lastPresence = (c: TestClient) => presences(c).at(-1);

describe("presence", () => {
  it("relays my cursor (as CRDT ids) to others, and shows newcomers who is already here", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    alice.type(0, "hello");
    const at = alice.client.rga!.cursorAt(3); // after "l"
    const state: PresenceState = { name: "Alice", color: "#e11d48", cursor: { anchor: at, head: at } };
    alice.client.setPresence(state);

    await until(() => lastPresence(bob)?.name === "Alice");
    const seen = lastPresence(bob)!;
    expect(seen).toMatchObject(state);
    // The cursor survives Bob's concurrent typing before it: it's an id, not an index.
    await until(() => bob.text() === "hello");
    bob.type(0, ">> ");
    expect(bob.client.rga!.cursorIndex(seen.cursor!.head)).toBe(6);

    const carol = await connect(server, doc, "carol");
    await until(() => lastPresence(carol)?.name === "Alice");
    expect(lastPresence(carol)!.clientId).toBe(seen.clientId);
    for (const c of [alice, bob, carol]) c.client.close();
  });

  it("says goodbye when someone leaves, and is never written to the store", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    alice.client.setPresence({ name: "Alice", color: "#e11d48", cursor: null });
    await until(() => presences(bob).length === 1);
    alice.client.close();
    await until(() => ofType(bob.messages, "presence-leave").length === 1);
    expect(ofType(bob.messages, "presence-leave")[0]!.clientId).toBe(presences(bob)[0]!.clientId);
    expect(store.opCount(doc)).toBe(0);
    expect(await store.listVersions(doc)).toEqual([]);
    bob.client.close();
  });

  it("throttles to ~100 ms but always delivers the latest state", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    for (let i = 1; i <= 50; i++) alice.client.setPresence({ name: `A${i}`, color: "#000000", cursor: null });
    await until(() => lastPresence(bob)?.name === "A50", 3000, "latest presence");
    expect(presences(bob).length).toBeLessThanOrEqual(2); // first + last, not 50
    alice.client.close();
    bob.client.close();
  });

  it("re-announces itself after a reconnect", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    alice.client.setPresence({ name: "Alice", color: "#e11d48", cursor: null });
    await until(() => presences(bob).length === 1);
    alice.client.setOnline(false);
    await until(() => ofType(bob.messages, "presence-leave").length === 1);
    alice.client.setOnline(true);
    await until(() => presences(bob).length === 2);
    expect(lastPresence(bob)!.name).toBe("Alice");
    alice.client.close();
    bob.client.close();
  });

  it("requires hello first", async () => {
    const { ws, inbox } = await rawSocket(server, freshDoc(), "skip");
    ws.send(JSON.stringify({ type: "presence", name: "x", color: "#000000", cursor: null }));
    await until(() => inbox.length === 1);
    expect(inbox[0]).toMatchObject({ type: "error", message: "send hello first" });
    ws.close();
  });
});

describe("version history", () => {
  const getJson = async (path: string) => {
    const res = await fetch(base() + path);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(base() + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("lists automatic and named versions and returns their text", async () => {
    const doc = freshDoc();
    expect((await getJson(`/api/docs/${doc}/versions`)).body).toEqual({ versions: [] });

    const alice = await connect(server, doc, "alice");
    alice.type(0, "Garvit Mundra"); // 13 ops >= snapshotEvery (10): automatic version at seq 13
    await until(() => alice.client.pendingCount === 0);
    alice.type(13, ", CSE");
    await until(() => alice.client.pendingCount === 0);
    expect(await post(`/api/docs/${doc}/versions`, { label: "  with degree " })).toEqual({
      status: 201,
      body: { seq: 18, label: "with degree" },
    });

    const { body } = await getJson(`/api/docs/${doc}/versions`);
    const versions = body.versions as { seq: number; label: string | null; chars: number }[];
    expect(versions.map((v) => [v.seq, v.label, v.chars])).toEqual([
      [18, "with degree", 18],
      [13, null, 13],
    ]);
    expect((await getJson(`/api/docs/${doc}/versions/13`)).body).toEqual({ seq: 13, text: "Garvit Mundra" });
    alice.client.close();
  });

  it("can save a named version of a document nobody has open", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    alice.type(0, "abc");
    await until(() => alice.client.pendingCount === 0);
    alice.client.close();
    await until(() => !server.rooms.has(doc));
    expect((await post(`/api/docs/${doc}/versions`, { label: "closed" })).body).toEqual({ seq: 3, label: "closed" });
    expect((await getJson(`/api/docs/${doc}/versions/3`)).body.text).toBe("abc");
    await until(() => !server.rooms.has(doc), 3000, "room unloaded again");
  });

  it("validates input", async () => {
    expect((await getJson(`/api/docs/bad%20id/versions`)).status).toBe(400);
    expect((await getJson(`/api/docs/x/versions/abc`)).status).toBe(400);
    expect((await getJson(`/api/docs/x/versions/7`)).status).toBe(404);
    expect((await post(`/api/docs/x/versions`, { label: "" })).status).toBe(400);
    expect((await post(`/api/docs/x/versions`, { label: "y".repeat(81) })).status).toBe(400);
    expect((await post(`/api/docs/x/versions`, {})).status).toBe(400);
  });

  it("restoring = ordinary edits: everyone sees the old text and history keeps growing", async () => {
    const doc = freshDoc();
    const alice = await connect(server, doc, "alice");
    const bob = await connect(server, doc, "bob");
    alice.type(0, "Objective: backend role");
    await until(() => alice.client.pendingCount === 0);
    const { body } = await post(`/api/docs/${doc}/versions`, { label: "v1" });
    alice.del(11, 12);
    alice.type(11, "full-stack internship");
    await until(() => bob.view() === "Objective: full-stack internship");

    // Bob restores v1: fetch its text, diff against his replica, send the ops.
    const old = (await getJson(`/api/docs/${doc}/versions/${body.seq}`)).body.text as string;
    const ops = opsToMatch(bob.client.rga!, old);
    bob.client.send(ops);
    await until(() => alice.view() === "Objective: backend role");
    expect(ops.length).toBeLessThan(40); // a diff, not "delete everything, retype everything"
    // Restoring didn't rewrite history: v1 is still there, and newer versions come after it.
    await until(() => alice.client.pendingCount === 0 && bob.client.pendingCount === 0);
    const after = await store.listVersions(doc);
    const v1 = after.find((v) => v.label === "v1")!;
    expect(v1.seq).toBe(body.seq);
    expect(after[0]!.seq).toBeGreaterThan(v1.seq);
    alice.client.close();
    bob.client.close();
  });
});

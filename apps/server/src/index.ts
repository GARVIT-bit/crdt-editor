/**
 * Entry point. Environment:
 *   PORT            default 3000
 *   MONGO_URL       e.g. mongodb://127.0.0.1:27017  (unset = in-memory, data lost on restart)
 *   MONGO_DB        default crdt_editor
 *   REDIS_URL       e.g. redis://127.0.0.1:6380     (set = scale-out mode: fan out via Redis pub/sub)
 *   SERVER_ID       name shown in /healthz (default: random)
 *   SNAPSHOT_EVERY  ops between snapshots, default 200
 */
import { startServer } from "./app.js";
import type { Bus } from "./bus.js";
import { MemoryStore, type OpStore } from "./store.js";

async function main(): Promise<void> {
  let store: OpStore;
  const mongoUrl = process.env.MONGO_URL;
  if (mongoUrl) {
    const { MongoStore } = await import("./mongoStore.js");
    const dbName = process.env.MONGO_DB ?? "crdt_editor";
    const mongo = await MongoStore.connect(mongoUrl, dbName);
    store = mongo;
    console.log(`op log: MongoDB database "${dbName}" (${mongo.transactional ? "replica set, transactional appends" : "standalone"})`);
  } else {
    store = new MemoryStore();
    console.warn("op log: in-memory, data is lost on restart (set MONGO_URL to persist)");
  }

  let bus: Bus | undefined;
  if (process.env.REDIS_URL) {
    if (!mongoUrl) throw new Error("REDIS_URL (several servers) needs MONGO_URL: servers must share one op log");
    const { RedisBus } = await import("./bus.js");
    bus = await RedisBus.connect(process.env.REDIS_URL);
    console.log("scale-out: Redis pub/sub enabled");
  }

  const server = await startServer({
    store,
    bus,
    serverId: process.env.SERVER_ID,
    port: Number(process.env.PORT ?? 3000),
    snapshotEvery: Number(process.env.SNAPSHOT_EVERY ?? 200),
  });
  console.log(`server ${server.serverId} listening on http://localhost:${server.port}  (ws: /ws?doc=<id>)`);

  const shutdown = async () => {
    console.log("shutting down...");
    await server.close();
    await bus?.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

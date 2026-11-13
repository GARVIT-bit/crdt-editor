/**
 * HTTP + WebSocket server.
 *   GET  /healthz                          liveness check (Docker/Nginx)
 *   GET  /api/docs/:docId/versions         version history (newest first)
 *   GET  /api/docs/:docId/versions/:seq    text of one version
 *   POST /api/docs/:docId/versions         save the current state as a named version {label}
 *   WS   /ws?doc=<id>                      sync + presence for document <id>
 * If apps/web has been built, its files are served too (production mode).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { RGA } from "@crdt-editor/crdt";
import { DOC_ID_PATTERN, parseClientMessage, ProtocolError } from "@crdt-editor/protocol";
import type { Bus } from "./bus.js";
import { Room, send } from "./room.js";
import type { OpStore } from "./store.js";

export interface ServerOptions {
  store: OpStore;
  port?: number;
  snapshotEvery?: number;
  heartbeatMs?: number;
  /** Max bytes per incoming WebSocket message. */
  maxPayload?: number;
  /** A client further behind than this many seqs gets a snapshot instead of a catch-up. */
  catchupLimit?: number;
  /** Server-to-server fan-out (Redis in production). Absent = single server. */
  bus?: Bus;
  /** Unique per process; shows up in /healthz. Default: random. */
  serverId?: string;
  gapFillMs?: number;
  /** Presence heartbeat between servers; remote entries expire after 3x this. Default 10 s. */
  presenceHeartbeatMs?: number;
  /** With a bus: how often each open room compares its watermark with the store. Default 5 s. */
  antiEntropyMs?: number;
}

export interface RunningServer {
  serverId: string;
  port: number;
  http: Server;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

const MAX_LABEL_LENGTH = 80;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const snapshotEvery = opts.snapshotEvery ?? 200;
  const serverId = opts.serverId ?? randomUUID().slice(0, 8);
  const heartbeatPresenceMs = opts.presenceHeartbeatMs ?? 10_000;
  const rooms = new Map<string, Room>();

  function roomFor(docId: string): Room {
    let room = rooms.get(docId);
    if (!room) {
      room = new Room(docId, opts.store, {
        snapshotEvery,
        catchupLimit: opts.catchupLimit,
        bus: opts.bus,
        serverId,
        gapFillMs: opts.gapFillMs,
        presenceTtlMs: heartbeatPresenceMs * 3,
      });
      rooms.set(docId, room);
    }
    return room;
  }

  /** Unload a room once nobody is in it and all its queued work is done. */
  function unloadIfEmpty(docId: string, room: Room): Promise<void> {
    return room.enqueue(async () => {
      if (room.clients.size === 0 && rooms.get(docId) === room) {
        rooms.delete(docId);
        await room.stop();
      }
    });
  }

  // After a bus outage, messages may have been lost: every open room re-reads the store.
  opts.bus?.onReconnect(() => {
    for (const room of rooms.values()) {
      room.enqueue(() => room.syncFromStore()).catch((err) => console.error("resync failed", err));
    }
  });

  // ---------------------------------------------------------------- HTTP

  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, serverId, rooms: rooms.size });
  });

  const validDoc = (req: Request, res: Response): string | null => {
    const docId = String(req.params.docId);
    if (DOC_ID_PATTERN.test(docId)) return docId;
    res.status(400).json({ error: "invalid document id" });
    return null;
  };

  app.get("/api/docs/:docId/versions", async (req, res, next) => {
    try {
      const docId = validDoc(req, res);
      if (docId) res.json({ versions: await opts.store.listVersions(docId) });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/docs/:docId/versions/:seq", async (req, res, next) => {
    try {
      const docId = validDoc(req, res);
      if (!docId) return;
      const seq = Number(req.params.seq);
      if (!Number.isSafeInteger(seq) || seq < 0) return void res.status(400).json({ error: "invalid seq" });
      const snapshot = await opts.store.getVersion(docId, seq);
      if (!snapshot) return void res.status(404).json({ error: "no version at that seq" });
      res.json({ seq, text: RGA.fromSnapshot(snapshot, "history").toString() });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/docs/:docId/versions", async (req, res, next) => {
    try {
      const docId = validDoc(req, res);
      if (!docId) return;
      const label = (req.body as { label?: unknown } | undefined)?.label;
      if (typeof label !== "string" || label.trim().length === 0 || label.length > MAX_LABEL_LENGTH) {
        return void res.status(400).json({ error: `label must be 1..${MAX_LABEL_LENGTH} characters` });
      }
      const room = roomFor(docId);
      const seq = await room.enqueue(async () => {
        await room.snapshotNow(label.trim());
        return room.seq;
      });
      await unloadIfEmpty(docId, room);
      res.status(201).json({ seq, label: label.trim() });
    } catch (err) {
      next(err);
    }
  });

  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (existsSync(webDist)) app.use(express.static(webDist));

  // ---------------------------------------------------------------- WebSocket

  const http = createHttpServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? 4 * 1024 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const docId = url.searchParams.get("doc");
    if (url.pathname !== "/ws" || docId === null || !DOC_ID_PATTERN.test(docId)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, docId));
  });

  function onConnection(ws: WebSocket, docId: string): void {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    /** Identifies this connection's cursor to others. Random, so it's unique across servers. */
    const clientId = randomUUID().slice(0, 8);
    // The room is looked up when hello arrives, not now: an idle socket must
    // not hold on to a room that gets unloaded in the meantime.
    let room: Room | null = null;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return send(ws, { type: "error", message: "binary messages are not supported" });
      let msg;
      try {
        msg = parseClientMessage(data.toString());
      } catch (err) {
        if (err instanceof ProtocolError) return send(ws, { type: "error", message: err.message });
        throw err;
      }

      if (msg.type === "ping") return send(ws, { type: "pong" });

      if (msg.type === "hello") {
        if (room) return send(ws, { type: "error", message: "hello may only be sent once" });
        const r = (room = roomFor(docId));
        const lastSeq = msg.lastSeq;
        r.enqueue(() => r.hello(ws, lastSeq)).catch((err) => {
          console.error(`[${docId}] failed to load document`, err);
          if (rooms.get(docId) === r) rooms.delete(docId); // let the next hello retry
          ws.close(1011, "could not load document");
        });
        return;
      }

      if (!room) return send(ws, { type: "error", message: "send hello first" });
      const r = room;

      if (msg.type === "presence") {
        const { name, color, cursor } = msg;
        r.enqueue(() => r.setPresence(ws, clientId, { name, color, cursor })).catch(() => {});
        return;
      }

      const ops = msg.ops;
      r.enqueue(() => r.receive(ws, ops)).catch((err) => {
        // Not acked, so the client still has these ops in its outbox. Closing
        // makes it reconnect and re-send them once the database is back.
        console.error(`[${docId}] failed to store ops`, err);
        ws.close(1011, "failed to store edits");
      });
    });

    ws.on("close", () => {
      if (!room) return;
      const r = room;
      r.clients.delete(ws); // stop relaying to it right away
      r.enqueue(() => r.leave(ws)).catch(() => {});
      unloadIfEmpty(docId, r).catch(() => {});
    });
  }

  // Heartbeat: drop connections that stopped answering pings (laptop lid closed, Wi-Fi gone).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 30_000);

  // Presence heartbeat between servers (see Room.presenceTick).
  const presenceTimer = opts.bus
    ? setInterval(() => {
        for (const room of rooms.values()) room.enqueue(() => room.presenceTick()).catch(() => {});
      }, heartbeatPresenceMs)
    : null;

  // Anti-entropy: catches bus messages lost with nothing after them (see Room.checkHead).
  const antiEntropyTimer = opts.bus
    ? setInterval(() => {
        for (const room of rooms.values()) {
          room.enqueue(() => room.checkHead()).catch((err) => console.error("anti-entropy failed", err));
        }
      }, opts.antiEntropyMs ?? 5_000)
    : null;

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, resolve));

  return {
    serverId,
    port: (http.address() as AddressInfo).port,
    http,
    rooms,
    async close() {
      clearInterval(heartbeat);
      if (presenceTimer) clearInterval(presenceTimer);
      if (antiEntropyTimer) clearInterval(antiEntropyTimer);
      for (const room of rooms.values()) await room.stop();
      for (const ws of wss.clients) ws.terminate();
      await Promise.all([...rooms.values()].map((r) => r.idle()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

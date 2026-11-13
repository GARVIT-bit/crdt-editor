/**
 * Wire protocol shared by server and browser. One file, so both sides
 * always agree on message shapes.
 *
 * Client -> server
 *   { type: "hello", lastSeq }                    FIRST message: "I have every op up to lastSeq"
 *                                                 (null = I have nothing from the server yet)
 *   { type: "ops", ops: Op[] }                    my local edits, in the order I made them
 *                                                 (may include re-sends of unacked ops)
 *   { type: "presence", name, color, cursor }     where I am (cursor as CRDT ids)
 *   { type: "ping" }                              liveness check; the server answers "pong"
 *                                                 (browsers can't see WebSocket ping frames)
 *
 * Server -> client
 *   { type: "init", snapshot, seq }               full state (new client, or too far behind)
 *   { type: "catchup", ops: SeqOp[], seq }        only the ops after your lastSeq
 *   { type: "ops", ops: SeqOp[], seq }            edits from other people, already stored;
 *                                                 seq = you have now seen everything up to here
 *   { type: "ack", opIds, seq }                   these ops of yours are durable (incl. duplicates);
 *                                                 you have now seen every op up to seq
 *   { type: "reject", opIds, message }            these ops can never be accepted: drop them
 *   { type: "presence", clientId, ... } / { type: "presence-leave", clientId }
 *   { type: "pong" }                              answer to ping
 *   { type: "error", message }                    malformed message
 *
 * `seq` is the position of an op in the server's log for this document. It
 * is NOT used to order text (the RGA does that); it only answers "which ops
 * have you already seen?".
 */
import type { Id, Op, Snapshot } from "@crdt-editor/crdt";

export type SeqOp = { seq: number; op: Op };

/**
 * A cursor/selection stored as CRDT ids ("after character X"), so it stays
 * next to the same text when others edit. null = start of document.
 */
export type CursorIds = { anchor: Id | null; head: Id | null };

/** What a client says about itself (presence is relayed, never persisted). */
export type PresenceState = { name: string; color: string; cursor: CursorIds | null };

export type ClientMessage =
  | { type: "hello"; lastSeq: number | null }
  | { type: "ping" }
  | { type: "ops"; ops: Op[] }
  | ({ type: "presence" } & PresenceState);

export type ServerMessage =
  | { type: "init"; snapshot: Snapshot; seq: number }
  | { type: "catchup"; ops: SeqOp[]; seq: number }
  | { type: "ops"; ops: SeqOp[]; seq: number }
  | { type: "ack"; opIds: string[]; seq: number }
  | { type: "reject"; opIds: string[]; message: string }
  | ({ type: "presence"; clientId: string } & PresenceState)
  | { type: "presence-leave"; clientId: string }
  | { type: "pong" }
  | { type: "error"; message: string };

export const MAX_NAME_LENGTH = 40;
export const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const MAX_OPS_PER_MESSAGE = 10_000;
export const MAX_REPLICA_LENGTH = 64;
export const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Stable unique key per op, used for the (docId, opId) unique index.
 * Two users deleting the same character produce the same opId: that's fine,
 * the second delete would be a no-op anyway.
 */
export function opId(op: Op): string {
  return `${op.type}:${op.id[0]}@${op.id[1]}`;
}

// ------------------------------------------------------------- validation

export class ProtocolError extends Error {}

function isId(x: unknown): x is Id {
  return (
    Array.isArray(x) &&
    x.length === 2 &&
    Number.isSafeInteger(x[0]) &&
    (x[0] as number) > 0 &&
    typeof x[1] === "string" &&
    x[1].length > 0 &&
    x[1].length <= MAX_REPLICA_LENGTH
  );
}

function isOp(x: unknown): x is Op {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.type === "del") return isId(o.id);
  if (o.type === "ins") {
    return (
      isId(o.id) &&
      (o.after === null || isId(o.after)) &&
      typeof o.value === "string" &&
      [...o.value].length === 1
    );
  }
  return false;
}

/** Parse and validate a raw client message. Throws ProtocolError if invalid. */
export function parseClientMessage(raw: string): ClientMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new ProtocolError("invalid JSON");
  }
  if (typeof msg !== "object" || msg === null) throw new ProtocolError("message must be an object");
  const m = msg as Record<string, unknown>;
  if (m.type === "ping") return { type: "ping" };
  if (m.type === "hello") {
    const lastSeq = m.lastSeq;
    if (lastSeq !== null && !(Number.isSafeInteger(lastSeq) && (lastSeq as number) >= 0)) {
      throw new ProtocolError("hello.lastSeq must be null or a non-negative integer");
    }
    return { type: "hello", lastSeq: lastSeq as number | null };
  }
  if (m.type === "presence") {
    const { name, color, cursor } = m;
    if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new ProtocolError(`presence.name must be 1..${MAX_NAME_LENGTH} characters`);
    }
    if (typeof color !== "string" || !COLOR_PATTERN.test(color)) throw new ProtocolError("presence.color must be #rrggbb");
    if (cursor === null) return { type: "presence", name, color, cursor: null };
    const c = cursor as Record<string, unknown> | undefined;
    const okEnd = (x: unknown) => x === null || isId(x);
    if (typeof c !== "object" || c === null || !okEnd(c.anchor) || !okEnd(c.head)) {
      throw new ProtocolError("presence.cursor must be null or {anchor, head} of ids/null");
    }
    const copy = (x: Id | null): Id | null => (x === null ? null : [x[0], x[1]]);
    return { type: "presence", name, color, cursor: { anchor: copy(c.anchor as Id | null), head: copy(c.head as Id | null) } };
  }
  if (m.type !== "ops") throw new ProtocolError(`unknown message type ${JSON.stringify(m.type)}`);
  if (!Array.isArray(m.ops)) throw new ProtocolError("ops must be an array");
  if (m.ops.length === 0 || m.ops.length > MAX_OPS_PER_MESSAGE) {
    throw new ProtocolError(`ops must contain 1..${MAX_OPS_PER_MESSAGE} items`);
  }
  for (const op of m.ops) if (!isOp(op)) throw new ProtocolError(`invalid op ${JSON.stringify(op)}`);
  // Copy only the known fields so extra junk is never stored or relayed.
  const ops = (m.ops as Op[]).map((op): Op =>
    op.type === "ins"
      ? { type: "ins", id: [op.id[0], op.id[1]], after: op.after && [op.after[0], op.after[1]], value: op.value }
      : { type: "del", id: [op.id[0], op.id[1]] },
  );
  return { type: "ops", ops };
}

export { DocClient, type DocClientOptions, type SocketLike, type Status } from "./client.js";
export { MemoryDocStorage, seqRank, type DocStorage, type StoredDoc } from "./storage.js";
export { applyEdits, diffText, opsToMatch, type Edit } from "./diff.js";

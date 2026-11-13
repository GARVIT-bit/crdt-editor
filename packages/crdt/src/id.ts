/**
 * Character IDs and the Lamport clock.
 *
 * Every character ever typed gets an ID that is unique across all users and
 * never changes: [counter, replicaId].
 *  - counter comes from a Lamport clock, so a character typed AFTER seeing
 *    another one always gets a bigger counter (causality is preserved).
 *  - replicaId breaks ties when two users type at the same moment with the
 *    same counter. Every replica compares IDs the same way, so every replica
 *    ends up with the same order.
 */

export type Id = readonly [counter: number, replica: string];

/** Total order on IDs: counter first, then replica ID as a tie-break. */
export function compareId(a: Id, b: Id): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

export function sameId(a: Id | null, b: Id | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

/** Stable string key for maps and sets ("12@alice"). */
export function idKey(id: Id): string {
  return `${id[0]}@${id[1]}`;
}

export class LamportClock {
  private counter = 0;

  /** Local event: advance and return the new counter. */
  tick(): number {
    this.counter += 1;
    return this.counter;
  }

  /** Remote event seen: never fall behind anything we've observed. */
  observe(remote: number): void {
    if (remote > this.counter) this.counter = remote;
  }

  get value(): number {
    return this.counter;
  }
}

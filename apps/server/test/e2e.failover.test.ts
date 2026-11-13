/**
 * End-to-end failover against the real Docker Compose stack:
 *   docker compose up -d --build
 *   $env:E2E_URL="http://localhost:8090"; npx vitest run test/e2e.failover.test.ts   (PowerShell)
 *
 * Two clients connect through Nginx, type, then server1 is killed with
 * `docker kill`. Both keep typing; whoever was on server1 reconnects (Nginx
 * routes it to server2). Pass = both converge, nothing typed is lost, and
 * MongoDB holds exactly one copy of every op.
 */
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DocClient } from "@crdt-editor/protocol";
import { until } from "./helpers.js";

const E2E_URL = process.env.E2E_URL;

function client(doc: string, name: string) {
  const ws = E2E_URL!.replace(/^http/, "ws");
  return new DocClient({ url: `${ws}/ws?doc=${doc}`, retryBaseMs: 100, newReplicaId: () => `${name}-${Date.now()}` });
}

async function servedBy(): Promise<string> {
  const res = await fetch(`${E2E_URL}/healthz`);
  return ((await res.json()) as { serverId: string }).serverId;
}

describe.skipIf(!E2E_URL)("Docker Compose failover (E2E)", () => {
  it("kill a server mid-session: clients reconnect through Nginx with no lost edits", async () => {
    // Nginx round-robins: show that both servers answer.
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(await servedBy());
    expect(seen).toEqual(new Set(["server1", "server2"]));

    const doc = `failover${Date.now()}`;
    const a = client(doc, "a");
    const b = client(doc, "b");
    try {
      await until(() => a.status === "online" && b.status === "online", 10_000);
      const typeAt = (c: DocClient, text: string) => c.send(c.rga!.localInsertText(c.rga!.length, text));

      typeAt(a, "before ");
      await until(() => b.rga!.toString() === "before ", 5000);

      const killedAt = Date.now();
      execSync("docker kill crdt-server1", { stdio: "ignore" });
      for (let i = 0; i < 20; i++) {
        typeAt(i % 2 ? a : b, String(i % 10));
        await new Promise((r) => setTimeout(r, 50));
      }

      await until(
        () => {
          expect(a.status).toBe("online");
          expect(b.status).toBe("online");
          expect(a.pendingCount + b.pendingCount).toBe(0);
          expect(a.rga!.toString()).toBe(b.rga!.toString());
        },
        30_000,
        "convergence after failover",
      );
      const recoveredMs = Date.now() - killedAt;
      console.log(`failover: both clients online and converged ${recoveredMs} ms after docker kill`);
      expect(recoveredMs).toBeLessThan(15_000);

      const text = a.rga!.toString();
      expect(text.startsWith("before ")).toBe(true);
      expect(text.length).toBe(7 + 20); // every character typed during the outage made it

      const count = execSync(
        `docker exec crdt-mongo mongosh --quiet crdt_editor --eval "db.ops.countDocuments({docId: '${doc}'})"`,
      )
        .toString()
        .trim();
      expect(Number(count)).toBe(27); // stored exactly once each
    } finally {
      a.close();
      b.close();
      execSync("docker compose start server1", { stdio: "ignore" });
    }
  }, 120_000);
});

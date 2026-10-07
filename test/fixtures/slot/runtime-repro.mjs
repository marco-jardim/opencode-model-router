// Multi-process repro of QA-1.4-27 on the running runtime (Bun or Node), with the
// production clocks and constants. Not part of the vitest suite (it takes about
// 2 minutes). The children run on the same runtime as this script.
//
//   bun  test/fixtures/slot/runtime-repro.mjs <slot.ts> [b1] [b2] [b3]
//   node test/fixtures/slot/runtime-repro.mjs <slot.ts> [b1] [b2] [b3]    (Node 22.18+: type stripping)
//
// b1: a live holder H; observers O and Y whose processes started 8 s apart (on Bun,
//     their hrtime clocks are 8 s apart) see a +31 s wall step. After one of H's
//     heartbeats, Y looks at +0.2 s and +3.0 s, and O at +4.4 s. Two holders if O
//     gets the slot or H loses it.
// b2: a hung lock (live PID, 60 s old); fresh processes, 3 s apart, each call once
//     with waitMs 0 and exit. Shared observations let one of them reclaim it.
// b3: the same lock; two long-lived processes started 30 s apart each call once
//     with waitMs 0, then only their background watches look. Time to reclaim.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { utimes as fsUtimes } from "node:fs/promises";

const runtime = typeof globalThis.Bun !== "undefined" ? `bun ${globalThis.Bun.version}` : `node ${process.version}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === "child") {
  // Child: one line of JSON config, then commands on stdin ("acquire <json>", "status", "exit").
  const [, , , slotPath, raw] = process.argv;
  const cfg = JSON.parse(raw);
  const { acquireSlot } = await import(pathToFileURL(slotPath).href);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  let lost = false;
  const handles = [];
  const keepAlive = setInterval(() => {}, 1_000); // long-lived until "exit"; the slot's own timers are unref'd
  const deps = { dir: cfg.dir };
  if (cfg.beats) deps.utimes = async (p, t) => {
    await fsUtimes(p, t, t);
    out({ beat: Date.now() });
  };
  out({ ready: Date.now(), hr: Number(process.hrtime.bigint() / 1_000_000n) });
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const [cmd, arg] = [line.split(" ")[0], line.slice(line.indexOf(" ") + 1)];
    if (cmd === "acquire") {
      const o = JSON.parse(arg);
      const d = o.wallStepMs ? { ...deps, now: () => Date.now() + o.wallStepMs } : deps;
      const r = await acquireSlot({ max: 1, waitMs: o.waitMs ?? 0, meta: { cwd: process.cwd(), command: cfg.id }, onLost: () => (lost = true) }, d);
      if (!("busy" in r)) handles.push(r);
      out({ id: cfg.id, result: "busy" in r ? "busy" : "held", at: Date.now() });
    } else if (cmd === "status") {
      out({ id: cfg.id, lost });
    } else if (cmd === "exit") {
      clearInterval(keepAlive);
      rl.close();
      if (cfg.release) for (const h of handles) await h.release();
      process.exit(0);
    }
  }
} else {
  const slotPath = resolve(process.argv[2]);
  const which = process.argv.slice(3);
  const run = (name) => which.length === 0 || which.includes(name);
  const base = mkdtempSync(join(tmpdir(), "omr-repro-"));
  const kids = [];
  const t0 = Date.now();
  const rel = () => `${((Date.now() - t0) / 1_000).toFixed(1)}s`;

  function child(dir, id, extra = {}) {
    const p = spawn(process.execPath, [process.argv[1], "child", slotPath, JSON.stringify({ dir, id, ...extra })], { stdio: ["pipe", "pipe", "inherit"] });
    kids.push(p);
    const lines = [];
    const waiters = [];
    createInterface({ input: p.stdout }).on("line", (l) => {
      const o = JSON.parse(l);
      lines.push(o);
      for (const w of waiters.splice(0)) w();
    });
    const next = (pred) =>
      new Promise((res) => {
        const seen = lines.length;
        const check = () => {
          const hit = lines.slice(seen).find(pred);
          if (hit) res(hit);
          else waiters.push(check);
        };
        check();
      });
    const send = (s) => p.stdin.write(`${s}\n`);
    const exited = new Promise((r) => p.on("exit", r));
    return { p, next, send, lines, exited, ready: next((o) => "ready" in o) };
  }
  function plantHung(dir) {
    const lock = join(dir, "slot-0.lock");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), token: "hung", startedAt: 0, cwd: "", command: "hung" }));
    const t = new Date(Date.now() - 60_000);
    utimesSync(lock, t, t);
    return lock;
  }
  const tokenAt = (lock) => (existsSync(lock) ? JSON.parse(readFileSync(lock, "utf8")).token : null);
  const results = { runtime, slot: slotPath };

  try {
    if (run("b1")) {
      const dir = mkdtempSync(join(base, "b1-"));
      const lock = join(dir, "slot-0.lock");
      const h = child(dir, "H", { beats: true, release: true });
      await h.ready;
      h.send(`acquire ${JSON.stringify({})}`);
      await h.next((o) => o.result);
      const o = child(dir, "O");
      const oReady = await o.ready;
      await sleep(8_000);
      const y = child(dir, "Y");
      const yReady = await y.ready;
      const beat = await h.next((m) => "beat" in m);
      const at = (ms) => sleep(Math.max(0, beat.beat + ms - Date.now()));
      const look = async (c) => {
        c.send(`acquire ${JSON.stringify({ wallStepMs: 31_000 })}`);
        return (await c.next((m) => m.result)).result;
      };
      await at(200);
      const y1 = await look(y);
      await at(3_000);
      const y2 = await look(y);
      await at(4_400);
      const oRes = await look(o);
      const oLookMsAfterBeat = Date.now() - beat.beat;
      await sleep(6_000); // H's next heartbeat tells it whether it lost the slot
      h.send("status");
      const hLost = (await h.next((m) => "lost" in m)).lost;
      results.b1 = {
        hrtimeAtStartMs: { O: oReady.hr, Y: yReady.hr },
        clockOriginDeltaMs: yReady.ready - yReady.hr - (oReady.ready - oReady.hr),
        Y: [y1, y2],
        O: oRes,
        oLookMsAfterBeat,
        hLost,
        lockPresent: tokenAt(lock) !== null,
        twoHolders: oRes === "held" || hLost,
      };
      for (const c of [h, o, y]) c.send("exit");
      await Promise.all([h, o, y].map((c) => c.exited));
      console.log(`[${rel()}] b1 ${JSON.stringify(results.b1)}`);
    }

    if (run("b2")) {
      const dir = mkdtempSync(join(base, "b2-"));
      const lock = plantHung(dir);
      const planted = Date.now();
      const seq = [];
      for (let i = 0; i < 8 && tokenAt(lock) === "hung"; i++) {
        await sleep(Math.max(0, planted + i * 3_000 - Date.now()));
        const c = child(dir, `F${i}`, { release: true });
        await c.ready;
        c.send(`acquire ${JSON.stringify({})}`);
        const r = (await c.next((m) => m.result)).result;
        seq.push(`${((Date.now() - planted) / 1_000).toFixed(1)}s ${r}`);
        c.send("exit");
        await c.exited;
        if (r === "held") break;
      }
      results.b2 = { seq, reclaimed: tokenAt(lock) !== "hung" };
      console.log(`[${rel()}] b2 ${JSON.stringify(results.b2)}`);
    }

    if (run("b3")) {
      const dir = mkdtempSync(join(base, "b3-"));
      const gapMs = Number(process.env.B3_GAP_MS ?? 30_000);
      const p1 = child(dir, "P1");
      const r1 = await p1.ready;
      await sleep(gapMs);
      const p2 = child(dir, "P2");
      const r2 = await p2.ready;
      const lock = plantHung(dir);
      const start = Date.now();
      for (const c of [p1, p2]) c.send(`acquire ${JSON.stringify({})}`);
      const first = await Promise.all([p1, p2].map((c) => c.next((m) => m.result)));
      let reclaimedMs = null;
      while (Date.now() - start < 60_000) {
        if (tokenAt(lock) !== "hung") {
          reclaimedMs = Date.now() - start;
          break;
        }
        await sleep(250);
      }
      results.b3 = {
        clockOriginDeltaMs: r1.ready - r1.hr - (r2.ready - r2.hr),
        calls: first.map((m) => m.result),
        reclaimedAfterMs: reclaimedMs,
      };
      for (const c of [p1, p2]) c.send("exit");
      await Promise.all([p1, p2].map((c) => c.exited));
      console.log(`[${rel()}] b3 ${JSON.stringify(results.b3)}`);
    }
  } finally {
    for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(JSON.stringify(results));
}

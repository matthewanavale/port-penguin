// B7, B10: the yield check and the process counter of the scheduler.
import { describe, expect, it } from "vitest";
import { Sched, SIGNALS, YIELD_MS } from "./sched";

describe("Sched", () => {
  it("starts the process ids above the largest given id", () => {
    const s = new Sched();
    s.startPids(4242);
    expect(s.allocPid()).toBe(4243);
    expect(s.allocPid()).toBe(4244);
    s.startPids(10);
    expect(s.allocPid()).toBe(4245);
  });

  it("is not due at once, and is due after 16 ms of real work", async () => {
    const s = new Sched();
    s.reset();
    let early = false;
    for (let i = 0; i < 64; i++) early = early || s.due();
    expect(early).toBe(false);
    await new Promise((r) => setTimeout(r, YIELD_MS + 5));
    let late = false;
    for (let i = 0; i < 16; i++) late = late || s.due();
    expect(late).toBe(true);
  });

  it("yield() takes one real macrotask and starts a new budget", async () => {
    const s = new Sched();
    let timer = false;
    setTimeout(() => (timer = true), 0);
    await new Promise((r) => setTimeout(r, YIELD_MS + 5));
    await s.yield();
    expect(timer).toBe(true);
    let due = false;
    for (let i = 0; i < 16; i++) due = due || s.due();
    expect(due).toBe(false);
  });

  it("names the signals with their Linux numbers", () => {
    expect(SIGNALS).toMatchObject({ INT: 2, QUIT: 3, TSTP: 20, TERM: 15 });
  });
});

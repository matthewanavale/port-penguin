// B20: the new capture steps (type with no prompt, control key, wait), the
// job-PID rule of the normalizer, and the list of run-2b cases that wait for a
// capture. The cases are not in `CASES` yet: their fixtures need Docker.
import { describe, expect, it } from "vitest";
import {
  ASYNC_CASES,
  ASYNC_FEATURES,
  CASES,
  CONTROL_KEYS,
  promptStep,
} from "./cases";
import { normalize } from "./normalize";

describe("prompt steps (B20)", () => {
  it("reads a plain line and the 2a Ctrl-C at a prompt", () => {
    expect(promptStep("echo hi")).toEqual({ kind: "line", text: "echo hi" });
    expect(promptStep("^C")).toEqual({ kind: "ctrl-c-at-prompt" });
    expect(promptStep("")).toEqual({ kind: "line", text: "" });
  });

  it("reads typed text with no prompt, raw characters, control keys, and waits", () => {
    expect(promptStep("@type hello world")).toEqual({
      kind: "type",
      text: "hello world",
    });
    expect(promptStep("@type")).toEqual({ kind: "type", text: "" });
    expect(promptStep('@raw "x\\n"')).toEqual({ kind: "raw", text: "x\n" });
    expect(promptStep("@key ^D")).toEqual({
      kind: "key",
      key: "^D",
      byte: "\x04",
    });
    expect(promptStep("@key ^Z").kind).toBe("key");
    expect(promptStep("@wait 500")).toEqual({ kind: "wait", ms: 500 });
  });

  it("knows the control keys as the terminal sends them", () => {
    expect(CONTROL_KEYS).toEqual({
      "^C": "\x03",
      "^Z": "\x1a",
      "^D": "\x04",
      "^\\": "\x1c",
    });
    expect(promptStep("@key ^\\")).toMatchObject({ byte: "\x1c" });
  });

  it("rejects a malformed step, so a typo is not sent as a line", () => {
    expect(() => promptStep("@tpye x")).toThrow(/unknown step/);
    expect(() => promptStep("@key ^X")).toThrow(/unknown control key/);
    expect(() => promptStep("@wait soon")).toThrow(/bad wait/);
    expect(() => promptStep("@wait -5")).toThrow(/bad wait/);
    expect(() => promptStep("@raw 5")).toThrow(/needs a string/);
  });

  it("parses every step of every run-2b case", () => {
    for (const c of ASYNC_CASES)
      if (c.kind === "prompt") for (const i of c.inputs) promptStep(i);
  });
});

describe("run-2b reference cases (B20)", () => {
  it("have unique ids that do not clash with the captured cases", () => {
    const ids = [...CASES, ...ASYNC_CASES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("use only the listed features, and cover each of them", () => {
    const known = new Set(ASYNC_FEATURES);
    expect(
      ASYNC_CASES.filter((c) => !known.has(c.feature)).map((c) => c.id),
    ).toEqual([]);
    const used = new Set(ASYNC_CASES.map((c) => c.feature));
    expect(ASYNC_FEATURES.filter((f) => !used.has(f))).toEqual([]);
  });

  it("sit in one group, so a capture writes one new fixture file", () => {
    expect(new Set(ASYNC_CASES.map((c) => c.group))).toEqual(
      new Set(["async"]),
    );
  });

  it("cover AC3 to AC8 and AC14", () => {
    const text = ASYNC_FEATURES.join("\n");
    for (const part of [
      "pipe:",
      "keyboard:",
      "signal:",
      "job:",
      "nested:",
      "awk:",
    ])
      expect(text).toContain(part);
  });
});

describe("normalizer: job process ids (B20)", () => {
  it("replaces the PID of the line that `CMD &` prints", () => {
    expect(normalize("cadet@port-penguin:~$ sleep 5 &\r\n[1] 4242\r\n")).toBe(
      "cadet@<HOST>:~$ sleep 5 &\n[1] <PID>\n",
    );
  });

  it("replaces the PID column of jobs -l, and keeps the state text", () => {
    expect(
      normalize(
        "[1]-  4242 Running                 sleep 100 &\n[2]+  4243 Stopped                 sleep 101",
      ),
    ).toBe(
      "[1]-  <PID> Running                 sleep 100 &\n[2]+  <PID> Stopped                 sleep 101",
    );
  });

  it("leaves job lines without a PID and other numbers alone", () => {
    const keep =
      "[1]+  Stopped                 sleep 100\n[1]  Done  x\n4242\nexit 3\n[ok] 5";
    expect(normalize(keep)).toBe(keep);
  });
});

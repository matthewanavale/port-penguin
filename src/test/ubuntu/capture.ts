// D7: dev-only capture of the reference cases on real Ubuntu 24.04.
//
//   node --experimental-strip-types src/test/ubuntu/capture.ts [group ...]
//
// Needs Docker and Node 24. The image is built from a Dockerfile text that
// this script makes and sends to `docker build -` on stdin; no Dockerfile is
// committed. Tests do not need Docker: they read fixtures/*.json.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { CASES, SCRIPT_PATH } from "./cases.ts";
import type { Case, PromptCase, ScriptCase } from "./cases.ts";
import {
  CAPTURE_ENV,
  HOME_FILES,
  PROMPT_PS1,
  SKEL_BASHRC,
  SKEL_BASH_LOGOUT,
  SKEL_PROFILE,
} from "./home.ts";

/** The ubuntu:24.04 digest the fixtures are recorded against. */
const BASE_DIGEST =
  "sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b";
const IMAGE = "port-penguin-capture:24.04";
const FIXTURES = new URL("./fixtures/", import.meta.url);
const CONCURRENCY = 4;

/** Pinned packages (D7). `file` also gives the capture a `file` command. */
const PACKAGES = [
  "cron=3.0pl1-184ubuntu2",
  "procps=2:4.0.4-4ubuntu3.3",
  "tree=2.1.1-2ubuntu3.24.04.2",
  "file=1:5.45-3build1",
];

function dockerfile(): string {
  return [
    `FROM ubuntu:24.04@${BASE_DIGEST}`,
    "RUN apt-get update && apt-get install -y --no-install-recommends " +
      PACKAGES.join(" ") +
      " && rm -rf /var/lib/apt/lists/*",
    // Ubuntu 24.04 ships a user `ubuntu` with uid 1000; cadet takes that uid.
    "RUN userdel -r ubuntu && useradd -m -s /bin/bash cadet",
    "RUN printf 'set enable-bracketed-paste off\\n' > /home/cadet/.inputrc && chown cadet:cadet /home/cadet/.inputrc",
    "USER cadet",
    "WORKDIR /home/cadet",
    "",
  ].join("\n");
}

function run(
  cmd: string,
  args: string[],
  input?: string,
): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { input, encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout, err: r.stderr };
}

function buildImage(): void {
  const r = run("docker", ["build", "-q", "-t", IMAGE, "-"], dockerfile());
  if (r.code !== 0) throw new Error("docker build failed:\n" + r.err);
  // The image must still hold the skel files that home.ts holds.
  for (const [file, want] of [
    [".bashrc", SKEL_BASHRC],
    [".profile", SKEL_PROFILE],
    [".bash_logout", SKEL_BASH_LOGOUT],
  ]) {
    const got = run("docker", [
      "run",
      "--rm",
      IMAGE,
      "cat",
      `/etc/skel/${file}`,
    ]);
    if (got.out !== want)
      throw new Error(`/etc/skel/${file} differs from home.ts`);
  }
  const home = run("docker", ["run", "--rm", IMAGE, "ls", "-A", "/home/cadet"])
    .out.split("\n")
    .filter(Boolean)
    .sort();
  const want = HOME_FILES.map((f) => f.path).sort();
  if (JSON.stringify(home) !== JSON.stringify(want))
    throw new Error(`home holds ${home.join(",")}, expected ${want.join(",")}`);
}

function dockerArgs(name: string, inner: string[]): string[] {
  const env = Object.entries({ ...CAPTURE_ENV, PS1: PROMPT_PS1 }).map(
    ([k, v]) => `${k}=${v}`,
  );
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--hostname",
    "port-penguin",
    "--user",
    "cadet",
    "-w",
    "/home/cadet",
    IMAGE,
    "env",
    "-i",
    ...env,
    ...inner,
  ];
}

interface ScriptResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runScript(c: ScriptCase, n: number): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const inner = [
      "sh",
      "-c",
      `cat > ${SCRIPT_PATH}; exec bash ${SCRIPT_PATH}`,
    ];
    const p = spawn("docker", dockerArgs(`pp-cap-${n}`, inner));
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    p.on("error", reject);
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    p.stdin.end(c.lines.join("\n") + "\n");
  });
}

/** True when `text` ends at a prompt: the main prompt or `> `. */
const AT_PROMPT = /(cadet@port-penguin:[^\n]*\$ |\n> |^> )$/;
const QUIET_MS = 120;
const STEP_TIMEOUT_MS = 20000;

function runPrompt(c: PromptCase, n: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const inner = ["script", "-qfc", "bash -i", "/dev/null"];
    const name = `pp-cap-${n}`;
    const p = spawn("docker", dockerArgs(name, inner));
    let all = "";
    let sentAt = 0;
    let idx = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(guard);
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      if (err) reject(err);
      else resolve(all);
    };
    const arm = () => {
      clearTimeout(guard);
      guard = setTimeout(
        () =>
          finish(
            new Error(
              `case ${c.id}: no prompt after input ${idx}; output tail: ${JSON.stringify(all.slice(-200))}`,
            ),
          ),
        STEP_TIMEOUT_MS,
      );
    };
    const next = () => {
      if (idx >= c.inputs.length) return finish();
      const line = c.inputs[idx++];
      sentAt = all.length;
      arm();
      p.stdin.write(line === "^C" ? "\x03" : line + "\n");
    };
    p.stdout.on("data", (d: Buffer) => {
      all += d.toString("utf8");
      clearTimeout(timer);
      // Only look for the prompt in what came after the last input.
      const fresh = all.slice(sentAt);
      const ready =
        idx === 0
          ? AT_PROMPT.test(all)
          : AT_PROMPT.test(fresh) && fresh.length > 0;
      if (ready) timer = setTimeout(next, QUIET_MS);
    });
    p.stderr.on("data", () => {});
    p.on("error", finish);
    p.on("close", () => finish());
    arm();
  });
}

interface Fixture {
  id: string;
  kind: "prompt" | "script";
  feature: string;
  input: string[];
  transcript?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

async function capture(c: Case, n: number): Promise<Fixture> {
  if (c.kind === "script") {
    const r = await runScript(c, n);
    return {
      id: c.id,
      kind: "script",
      feature: c.feature,
      input: c.lines,
      stdout: r.stdout,
      stderr: r.stderr,
      code: r.code,
    };
  }
  const transcript = await runPrompt(c, n);
  return {
    id: c.id,
    kind: "prompt",
    feature: c.feature,
    input: c.inputs,
    // Raw: the shared normalizer (normalize.ts) runs when a test reads it.
    transcript,
  };
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const cases = CASES.filter(
    (c) => only.length === 0 || only.includes(c.group),
  );
  if (cases.length === 0) throw new Error("no case matches " + only.join(","));
  console.log("building the capture image");
  buildImage();
  const results = new Map<string, Fixture>();
  let next = 0;
  const worker = async (w: number) => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      results.set(c.id, await capture(c, w * 1000 + i));
      console.log(`captured ${c.id}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  mkdirSync(FIXTURES, { recursive: true });
  for (const group of new Set(cases.map((c) => c.group))) {
    const list = cases
      .filter((c) => c.group === group)
      .map((c) => results.get(c.id) as Fixture);
    const body = { image: `ubuntu:24.04@${BASE_DIGEST}`, cases: list };
    writeFileSync(
      new URL(`${group}.json`, FIXTURES),
      JSON.stringify(body, null, 2) + "\n",
    );
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

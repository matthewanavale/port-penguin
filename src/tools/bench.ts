// B23: speed benchmark of the shell loop. Not a CI test. It runs 100 000
// iterations of `i=$((i+1))` through `createEngine`, as 10 inputs of 10 000
// iterations (one input stays under the 2a step limit of 200 000), and prints
// the median time of 5 rounds in ms. Run it on the branch and on a checkout of
// `main` @ 6836593 (it works with a sync or an async `execute`), then compare:
//   node --experimental-strip-types src/tools/bench.ts
// It uses only syntax that Node type stripping accepts, like size.ts.
import { createServer } from "vite";

const LOOP = "i=0; while [ $i -lt 10000 ]; do i=$((i+1)); done; echo $i";
const INPUTS = 10;
const ROUNDS = 5;

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "silent",
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
});

try {
  const mod = await server.ssrLoadModule("/src/engine/index.ts");
  const times: number[] = [];
  for (let round = 0; round < ROUNDS + 1; round++) {
    const store = new Map<string, string>();
    const engine = mod.createEngine({
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    await engine.start();
    const t0 = performance.now();
    for (let n = 0; n < INPUTS; n++) {
      const r = await engine.execute(LOOP);
      const text = JSON.stringify(r.chunks ?? r.lines);
      if (!text.includes("10000")) throw new Error("bench loop gave: " + text);
    }
    const ms = performance.now() - t0;
    // The first round warms up the JIT and is not counted.
    if (round > 0) times.push(ms);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `bench: ${INPUTS * 10000} iterations, median ${median.toFixed(0)} ms (rounds: ${times.map((t) => t.toFixed(0)).join(", ")})`,
  );
} finally {
  await server.close();
}

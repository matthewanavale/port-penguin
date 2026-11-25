// Game state, the fresh state, and load and save through an injected
// storage. Ported from index.html:188, :342-378 at 5e96ce5. The save key and
// the saved JSON format do not change (D4).
import {
  APP,
  BROKEN_APP,
  BROKEN_DOCKERFILE,
  COMPOSE,
  CRANELOG,
  CREW,
  DEPLOY,
  DOCKERFILE,
  INDEX,
  MANIFEST,
  NOTES,
  OS_RELEASE,
  SECRET,
  SKEL_BASH_LOGOUT,
  SKEL_BASHRC,
  SKEL_PROFILE,
  SYSLOG,
  USR_BIN,
  WELCOME,
} from "./content";
import type { VarMeta } from "./shell/context";

export const HOME = "/home/cadet";
export const HOST = "port-penguin";
export const SAVE_KEY = "port-penguin-v2";

export interface FileNode {
  t: "f";
  x: string;
  m: string;
  sz?: number;
  /** Time of the last change in ms (D18). Absent: the run-1 time. */
  mtime?: number;
}
export interface DirNode {
  t: "d";
  c: Record<string, FsNode>;
  m: string;
  mtime?: number;
}
export type FsNode = FileNode | DirNode;

export interface Proc {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  cmd: string;
  stubborn?: boolean;
}

export interface Image {
  repo: string;
  tag: string;
  id: string;
  size: string;
  created: number;
  official?: boolean;
  cmd?: string;
  server?: boolean;
  expose?: string;
  reply?: string | null;
  files?: string[];
  filesText?: Record<string, string>;
  logs?: string[];
}

export interface Mount {
  type: "bind" | "volume";
  src?: string;
  name?: string;
  dst: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  repo: string;
  cmd: string;
  ports: string[];
  env: string[];
  mounts: Mount[];
  networks: Record<string, string>;
  aliases: string[];
  project: string | null;
  service: string | null;
  created: number;
  started: number;
  status: string;
  exit: number;
  logs: string[];
  stopped?: number;
}

export interface Network {
  name: string;
  id: string;
  driver: string;
  subnet?: string;
  next?: number;
  user?: boolean;
}

export interface Volume {
  name: string;
  created: number;
}

export interface DockerState {
  images: Image[];
  containers: Container[];
  volumes: Volume[];
  networks: Network[];
}

export interface State {
  fs: DirNode;
  cwd: string;
  oldpwd: string;
  env: Record<string, string>;
  procs: Proc[];
  lastCode: number;
  dk: DockerState;
  done: number[];
  cur: number;
  hist: string[];
  setup: Record<string, boolean>;
  unlocked: boolean;
  /* New optional fields (D11). A run-1 build ignores them. */
  /** Names of exported variables (D14). */
  exported?: string[];
  /** Arrays and variable attributes (D14). */
  vars?: Record<string, VarMeta>;
  /** Function name to its source text. */
  functions?: Record<string, string>;
  aliases?: Record<string, string>;
  options?: Record<string, boolean>;
  /** The crontab of `cadet` (AC4). */
  crontab?: string;
}

/** Where the game saves. `localStorage` fits; tests pass a Map. */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The live state that the engine modules read and change. It is an ES
 * module live binding: `setState` swaps it, and every importer sees the
 * new value.
 */
export let S: State;
export function setState(s: State): void {
  S = s;
}

export function hex(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++)
    s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

export const d = (c: Record<string, FsNode>): DirNode => ({
  t: "d",
  c: c,
  m: "rwxr-xr-x",
});
const dm = (m: string, c: Record<string, FsNode>): DirNode => ({
  t: "d",
  c: c,
  m: m,
});
export const f = (x: string, m?: string | null, sz?: number): FileNode => {
  const n: FileNode = { t: "f", x: x, m: m || "rw-r--r--" };
  if (sz) n.sz = sz;
  return n;
};

/** An executable stand-in for a simulated command, such as /usr/bin/ls (D15). */
const usrBin = (): Record<string, FsNode> => {
  const c: Record<string, FsNode> = {};
  for (const n of USR_BIN) c[n] = f("", "rwxr-xr-x");
  return c;
};

function freshFS(): DirNode {
  return d({
    home: d({
      cadet: dm("rwxr-x---", {
        "welcome.txt": f(WELCOME),
        ".secret": f(SECRET),
        ".bashrc": f(SKEL_BASHRC),
        ".profile": f(SKEL_PROFILE),
        ".bash_logout": f(SKEL_BASH_LOGOUT),
        "notes.txt": f(NOTES),
        "crew.txt": f(CREW),
        logs: d({ "system.log": f(SYSLOG), "crane.log": f(CRANELOG) }),
        projects: d({
          webapp: d({
            "index.html": f(INDEX),
            "app.py": f(APP),
            Dockerfile: f(DOCKERFILE),
            "deploy.sh": f(DEPLOY),
          }),
          legacy: d({
            old: d({ "crate-manifest.txt": f(MANIFEST) }),
            README: f("Nobody remembers what this folder is for.\n"),
          }),
          stack: d({ "docker-compose.yml": f(COMPOSE) }),
          broken: d({
            Dockerfile: f(BROKEN_DOCKERFILE),
            "app.py": f(BROKEN_APP),
          }),
        }),
      }),
    }),
    etc: d({
      hostname: f(HOST + "\n"),
      "os-release": f(OS_RELEASE),
    }),
    tmp: d({ "old-cargo.log": f("2026-11-01 crate 7781 lost at sea\n") }),
    usr: d({ bin: d(usrBin()), share: d({}) }),
    var: d({
      log: d({
        syslog: f(
          "Nov 24 06:00:01 port-penguin systemd[1]: Started harbor.\n",
          "rw-r-----",
          48e6,
        ),
        "auth.log": f(
          "Nov 24 06:00:03 sshd: session opened for cadet\n",
          "rw-r-----",
          2.1e6,
        ),
        "dpkg.log": f("2026-11-20 status installed docker-ce\n", null, 9e5),
      }),
    }),
  });
}

function freshProcs(): Proc[] {
  return [
    { pid: 1, user: "root", cpu: 0.0, mem: 0.3, cmd: "/sbin/init" },
    { pid: 214, user: "root", cpu: 0.0, mem: 0.2, cmd: "/usr/sbin/sshd -D" },
    { pid: 388, user: "root", cpu: 0.4, mem: 1.9, cmd: "/usr/bin/dockerd" },
    {
      pid: 1021,
      user: "cadet",
      cpu: 0.2,
      mem: 0.8,
      cmd: "harbor-radio --station 16",
    },
    { pid: 4242, user: "cadet", cpu: 99.1, mem: 2.3, cmd: "crane-sim --loop" },
    { pid: 5150, user: "cadet", cpu: 0.0, mem: 0.1, cmd: "-bash" },
  ];
}

export const fresh = (): State => ({
  fs: freshFS(),
  cwd: HOME,
  oldpwd: HOME,
  env: {},
  procs: freshProcs(),
  lastCode: 0,
  dk: {
    images: [],
    containers: [],
    volumes: [],
    networks: [
      {
        name: "bridge",
        id: hex(12),
        driver: "bridge",
        subnet: "172.17",
        next: 1,
      },
      { name: "host", id: hex(12), driver: "host" },
      { name: "none", id: hex(12), driver: "null" },
    ],
  },
  done: [],
  cur: 0,
  hist: [],
  setup: {},
  unlocked: false,
});

/**
 * Saves the game. Returns null when it worked, and the reason when it did
 * not (storage full or blocked). The game goes on either way (D21); the
 * caller shows the one dim line.
 */
export function save(storage: SaveStorage, s: State): string | null {
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(s));
    return null;
  } catch (e) {
    return e instanceof Error && e.message ? e.message : "storage unavailable";
  }
}

export function load(storage: SaveStorage): State | null {
  try {
    const r = storage.getItem(SAVE_KEY);
    if (r) {
      const o = JSON.parse(r) as Partial<State> | null;
      if (o && o.fs && o.dk && o.procs && Array.isArray(o.done))
        return o as State;
    }
  } catch {
    // A broken save starts a fresh game, as before.
  }
  return null;
}

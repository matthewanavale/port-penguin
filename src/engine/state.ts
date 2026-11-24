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
  SECRET,
  SYSLOG,
  WELCOME,
} from "./content";

export const HOME = "/home/cadet";
export const HOST = "port-penguin";
export const SAVE_KEY = "port-penguin-v2";

export interface FileNode {
  t: "f";
  x: string;
  m: string;
  sz?: number;
}
export interface DirNode {
  t: "d";
  c: Record<string, FsNode>;
  m: string;
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
export const f = (x: string, m?: string | null, sz?: number): FileNode => {
  const n: FileNode = { t: "f", x: x, m: m || "rw-r--r--" };
  if (sz) n.sz = sz;
  return n;
};

function freshFS(): DirNode {
  return d({
    home: d({
      cadet: d({
        "welcome.txt": f(WELCOME),
        ".secret": f(SECRET),
        ".bashrc": f("alias ll='ls -l'\n"),
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
      "os-release": f('NAME="Penguin Linux"\nVERSION="26.04 (Harbor)"\n'),
    }),
    tmp: d({ "old-cargo.log": f("2026-11-01 crate 7781 lost at sea\n") }),
    usr: d({ bin: d({}), share: d({}) }),
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

export function save(storage: SaveStorage, s: State): void {
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(s));
  } catch {
    // Storage full or blocked: the game goes on without saving, as before.
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

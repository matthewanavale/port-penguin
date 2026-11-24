// The Docker simulation. Ported from index.html:814-1160 at 5e96ce5. The
// output text and the order of Math.random calls must not change.
import { HELLO, NGINX_HTML, PG_ERR } from "./content";
import { compose } from "./compose";
import { ago, clone, E, pf, R, table } from "./helpers";
import type { Ctx, Res } from "./helpers";
import { get, norm } from "./paths";
import { hex, S } from "./state";
import type { Container, Image, Mount, Network, Volume } from "./state";

export const REG: Record<string, string> = {
  nginx: "192MB",
  redis: "117MB",
  alpine: "8.83MB",
  ubuntu: "78.1MB",
  python: "1.02GB",
  "hello-world": "13.3kB",
  postgres: "438MB",
  node: "1.12GB",
  busybox: "4.28MB",
};

const nowLog = () =>
  new Date().toISOString().slice(0, 19).replace("T", " ").replace(/-/g, "/");

interface Server {
  cmd: string;
  port: string;
  logs: () => string[];
}

const SERVERS: Record<string, Server> = {
  nginx: {
    cmd: '"/docker-entrypoint.…"',
    port: "80/tcp",
    logs: () => [
      "/docker-entrypoint.sh: Configuration complete; ready for start up",
      `${nowLog()} [notice] 1#1: nginx/1.27.2`,
      `${nowLog()} [notice] 1#1: start worker processes`,
    ],
  },
  redis: {
    cmd: '"docker-entrypoint.s…"',
    port: "6379/tcp",
    logs: () => [
      "1:C Redis version=7.4.1, bits=64, just started",
      "1:M Server initialized",
      "1:M Ready to accept connections tcp",
    ],
  },
  postgres: {
    cmd: '"docker-entrypoint.s…"',
    port: "5432/tcp",
    logs: () => [
      "PostgreSQL init process complete; ready for start up.",
      "LOG:  database system is ready to accept connections",
    ],
  },
};

const ADJ = [
  "brave",
  "sleepy",
  "jolly",
  "salty",
  "nimble",
  "quirky",
  "gallant",
  "rusty",
  "breezy",
  "plucky",
];
const NOUN = [
  "otter",
  "gull",
  "captain",
  "anchor",
  "walrus",
  "puffin",
  "tugboat",
  "lighthouse",
  "barnacle",
  "harbor",
];
const randName = () =>
  ADJ[Math.floor(Math.random() * ADJ.length)] +
  "_" +
  NOUN[Math.floor(Math.random() * NOUN.length)];

export function parseRef(r: string): { repo: string; tag: string } {
  const i = r.lastIndexOf(":");
  return i > 0 && !r.slice(i).includes("/")
    ? { repo: r.slice(0, i), tag: r.slice(i + 1) }
    : { repo: r, tag: "latest" };
}

export function findImg(r: string | null | undefined): Image | null {
  if (!r) return null;
  const { repo, tag } = parseRef(r);
  return (
    S.dk.images.find((m) => m.repo === repo && m.tag === tag) ||
    (r.length >= 4 && S.dk.images.find((m) => m.id.startsWith(r))) ||
    null
  );
}

export function findCt(r: string): Container | null {
  return (
    S.dk.containers.find((c) => c.name === r) ||
    (r && r.length >= 2 && S.dk.containers.find((c) => c.id.startsWith(r))) ||
    null
  );
}

export const imgName = (m: Image): string =>
  m.tag === "latest" ? m.repo : m.repo + ":" + m.tag;

export const findNet = (n: string): Network | undefined =>
  S.dk.networks.find((x) => x.name === n || x.id.startsWith(n));

function ipFor(net: string): string {
  const n = findNet(net);
  if (!n || !n.subnet) return "";
  n.next = (n.next || 1) + 1;
  return n.subnet + ".0." + n.next;
}

export function pull(r: string): Res {
  const { repo, tag } = parseRef(r);
  if (!REG[repo])
    return E(
      `Error response from daemon: pull access denied for ${repo}, repository does not exist or may require 'docker login'\n(In this sandbox you can pull: ${Object.keys(REG).join(", ")})`,
    );
  if (findImg(r))
    return R(
      `${tag}: Pulling from library/${repo}\nDigest: sha256:${hex(64)}\nStatus: Image is up to date for ${repo}:${tag}\ndocker.io/library/${repo}:${tag}`,
    );
  const ls = [`${tag}: Pulling from library/${repo}`];
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) ls.push(`${hex(12)}: Pull complete`);
  ls.push(
    `Digest: sha256:${hex(64)}`,
    `Status: Downloaded newer image for ${repo}:${tag}`,
    `docker.io/library/${repo}:${tag}`,
  );
  S.dk.images.push({
    repo,
    tag,
    id: hex(12),
    size: REG[repo],
    created: 0,
    official: true,
  });
  return R(ls.join("\n"));
}

function resolveHost(c: Container, host: string): string | null {
  const t = S.dk.containers.find(
    (x) =>
      x.status === "running" &&
      (x.name === host || (x.aliases || []).includes(host)),
  );
  if (t) {
    const shared = Object.keys(c.networks).filter(
      (n) => n !== "bridge" && t.networks[n],
    );
    if (shared.length) return t.networks[shared[0]];
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  return null;
}

function containerShell(c: Container, cmd: string[]): Res {
  const img: Partial<Image> = findImg(c.image) || {};
  const root =
    "bin   dev  etc  home  lib  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var";
  const fsmap: Record<string, string> = { "/": root };
  let wd = "/";
  if (c.repo === "nginx") {
    fsmap["/"] =
      "bin   boot  dev  docker-entrypoint.d  etc  home  lib  media  mnt  opt  proc  root  run  sbin  srv  sys  tmp  usr  var";
    fsmap["/usr/share/nginx/html"] = "50x.html  index.html";
    fsmap["/etc/nginx"] = "conf.d  mime.types  nginx.conf";
  }
  if (img.files) {
    wd = "/app";
    fsmap["/"] = "app  " + root;
    fsmap["/app"] = img.files.join("  ");
  }
  (c.mounts || []).forEach((m) => {
    if (fsmap[m.dst] === undefined)
      fsmap[m.dst] = c.repo === "redis" ? "dump.rdb" : "";
  });
  const a = cmd.slice(1);
  const arg = a.find((x) => x[0] !== "-");
  switch (cmd[0]) {
    case "ls": {
      const p = arg
        ? arg.startsWith("/")
          ? arg.replace(/\/$/, "") || "/"
          : (wd === "/" ? "" : wd) + "/" + arg
        : wd;
      return fsmap[p] !== undefined
        ? R(fsmap[p])
        : E(`ls: cannot access '${arg}': No such file or directory`);
    }
    case "cat": {
      if (c.repo === "nginx" && arg && arg.endsWith("nginx/html/index.html"))
        return R(NGINX_HTML);
      if (img.filesText && arg) {
        const k = arg.split("/").pop() as string;
        if (img.filesText[k] !== undefined) return R(img.filesText[k]);
      }
      if (arg === "/etc/os-release")
        return R(
          c.repo === "alpine"
            ? 'NAME="Alpine Linux"\nVERSION_ID=3.20.3'
            : 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"',
        );
      return E(`cat: ${arg || ""}: No such file or directory`);
    }
    case "pwd":
      return R(wd);
    case "whoami":
      return R("root");
    case "hostname":
      return R(c.id);
    case "echo":
      return R(a.join(" "));
    case "env":
      return R(
        [
          `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          `HOSTNAME=${c.id}`,
          "HOME=/root",
        ]
          .concat(c.env || [])
          .join("\n"),
      );
    case "ps":
      return R(
        c.repo === "nginx"
          ? "PID   USER     COMMAND\n    1 root     nginx: master process nginx -g daemon off;\n   29 nginx    nginx: worker process"
          : "PID   USER     COMMAND\n    1 root     " + c.cmd,
      );
    case "uname":
      return R("Linux");
    case "sleep":
      return R("");
    case "ping": {
      let cnt = 3;
      const pos: string[] = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "-c")
          cnt = Math.max(1, Math.min(5, parseInt(a[++i], 10) || 3));
        else if (a[i][0] !== "-") pos.push(a[i]);
      }
      const host = pos[pos.length - 1];
      if (!host) return E("ping: usage: ping [-c COUNT] HOST");
      const ip = resolveHost(c, host);
      if (!ip) return E(`ping: bad address '${host}'`);
      const out = [`PING ${host} (${ip}): 56 data bytes`];
      for (let i = 0; i < cnt; i++)
        out.push(`64 bytes from ${ip}: seq=${i} ttl=64 time=0.0${5 + i} ms`);
      out.push(
        "",
        `--- ${host} ping statistics ---`,
        `${cnt} packets transmitted, ${cnt} packets received, 0% packet loss`,
      );
      return R(out.join("\n"));
    }
    case "redis-cli":
      return c.repo === "redis"
        ? R(a.includes("ping") || a.includes("PING") ? "PONG" : "OK")
        : E("sh: redis-cli: not found", 127);
    case "psql":
      return c.repo === "postgres"
        ? R(
            "psql (16.4)\n(This sandbox can’t open an interactive database shell, but the server is up.)",
          )
        : E("sh: psql: not found", 127);
    case "bash":
    case "sh":
      return E(
        "This sandbox can’t open an interactive shell inside a container.\nOn a real machine, docker exec -it " +
          c.name +
          " sh would drop you inside.\nHere, run one command at a time, like: docker exec " +
          c.name +
          " ls /",
      );
    default:
      return E(
        `OCI runtime exec failed: exec: "${cmd[0]}": executable file not found in $PATH`,
        126,
      );
  }
}

function needsPgPassword(img: Image, cmd: string[], env: string[]): boolean {
  return (
    img.repo === "postgres" &&
    !cmd.length &&
    !env.some(
      (e) =>
        /^POSTGRES_PASSWORD=.+/.test(e) ||
        /^POSTGRES_HOST_AUTH_METHOD=/.test(e),
    )
  );
}

export interface MakeOptions {
  img: Image;
  name?: string | null;
  ports?: string[];
  env?: string[];
  mounts?: Mount[];
  network?: string | null;
  cmd: string[];
  det?: boolean;
  it?: boolean;
  project?: string | null;
  service?: string | null;
}

export function makeContainer(o: MakeOptions): { c: Container; out: string } {
  const img = o.img,
    sv = SERVERS[img.repo];
  const net = o.network || "bridge";
  const nets: Record<string, string> = {};
  nets[net] = ipFor(net);
  const c: Container = {
    id: hex(12),
    name: o.name || randName(),
    image: imgName(img),
    repo: img.repo,
    cmd: o.cmd.length
      ? o.cmd.join(" ")
      : img.cmd ||
        (sv ? sv.cmd : img.repo === "hello-world" ? "/hello" : "/bin/sh"),
    ports: o.ports || [],
    env: o.env || [],
    mounts: o.mounts || [],
    networks: nets,
    aliases: o.service ? [o.service] : [],
    project: o.project || null,
    service: o.service || null,
    created: Date.now(),
    started: Date.now(),
    status: "running",
    exit: 0,
    logs: [],
  };
  const full = c.id + hex(52);
  const stop = (code: number) => {
    c.status = "exited";
    c.exit = code || 0;
    c.stopped = Date.now();
  };
  const isServer = !o.cmd.length && (sv || img.server);
  let out: string;
  if (img.repo === "hello-world") {
    c.logs = HELLO.split("\n");
    stop(0);
    out = o.det ? full : HELLO;
  } else if (needsPgPassword(img, o.cmd, c.env)) {
    c.logs = PG_ERR.split("\n");
    stop(1);
    out = o.det ? full : PG_ERR;
  } else if (isServer) {
    c.logs = sv ? sv.logs() : (img.logs as string[]).slice();
    if (o.det) out = full;
    else {
      out =
        c.logs.join("\n") +
        "\n^C\n(You pressed Ctrl+C and the container stopped. Add -d to keep it running in the background.)";
      stop(0);
    }
  } else {
    if (!o.cmd.length) {
      out =
        o.it || img.repo === "python" || img.repo === "node"
          ? "(This sandbox can’t open an interactive shell. Try a single command, like: docker run alpine echo hello)"
          : "";
    } else {
      const r = containerShell(c, o.cmd);
      out = r.out || r.err || "";
      if (r.code) c.exit = r.code;
    }
    c.logs = out ? out.split("\n") : [];
    stop(c.exit);
    if (o.det) out = full;
  }
  return { c, out };
}

export function startCt(c: Container): void {
  const img: Partial<Image> = findImg(c.image) || {};
  const sv = SERVERS[c.repo];
  c.started = Date.now();
  for (const n in c.networks) c.networks[n] = ipFor(n);
  if (c.repo === "hello-world") {
    c.logs.push(...HELLO.split("\n"));
    c.status = "exited";
    c.exit = 0;
    c.stopped = Date.now();
    return;
  }
  if (
    c.repo === "postgres" &&
    !c.env.some(
      (e) =>
        /^POSTGRES_PASSWORD=.+/.test(e) ||
        /^POSTGRES_HOST_AUTH_METHOD=/.test(e),
    )
  ) {
    c.logs.push(...PG_ERR.split("\n"));
    c.status = "exited";
    c.exit = 1;
    c.stopped = Date.now();
    return;
  }
  if (sv || img.server) {
    c.status = "running";
    c.logs.push(...(sv ? sv.logs() : (img.logs as string[])));
    return;
  }
  c.status = "exited";
  c.exit = 0;
  c.stopped = Date.now();
}

export function portsText(c: Container): string {
  const sv = SERVERS[c.repo];
  const img: Partial<Image> = findImg(c.image) || {};
  if (c.status !== "running") return "";
  if (c.ports.length)
    return c.ports
      .map((p) => {
        const [h, k] = p.split(":");
        return `0.0.0.0:${h}->${k}/tcp`;
      })
      .join(", ");
  return sv ? sv.port : img.expose ? img.expose + "/tcp" : "";
}

export function statusText(c: Container): string {
  return c.status === "running"
    ? "Up " + ago(c.started)
    : `Exited (${c.exit || 0}) ${ago(c.stopped)} ago`;
}

export function cmdText(c: Container): string {
  const sv = SERVERS[c.repo];
  return sv && c.cmd === sv.cmd
    ? sv.cmd
    : '"' + (c.cmd.length > 20 ? c.cmd.slice(0, 19) + "…" : c.cmd) + '"';
}

function inspectCt(c: Container): Record<string, unknown> {
  const run = c.status === "running";
  const nets: Record<string, unknown> = {};
  for (const n in c.networks)
    nets[n] = {
      IPAddress: run ? c.networks[n] : "",
      Gateway:
        run && c.networks[n] ? c.networks[n].replace(/\.\d+$/, ".1") : "",
    };
  const ports: Record<string, unknown> = {};
  c.ports.forEach((p) => {
    const [h, k] = p.split(":");
    ports[k + "/tcp"] = [{ HostIp: "0.0.0.0", HostPort: h }];
  });
  return {
    Id: c.id + "…",
    Created: new Date(c.created).toISOString(),
    Name: "/" + c.name,
    State: { Status: c.status, Running: run, ExitCode: c.exit || 0 },
    Config: { Image: c.image, Env: c.env, Cmd: c.cmd.split(" ") },
    Mounts: c.mounts.map((m) => ({
      Type: m.type,
      Name: m.type === "volume" ? m.name : undefined,
      Source:
        m.type === "volume" ? `/var/lib/docker/volumes/${m.name}/_data` : m.src,
      Destination: m.dst,
    })),
    NetworkSettings: {
      IPAddress: run && c.networks.bridge ? c.networks.bridge : "",
      Ports: ports,
      Networks: nets,
    },
  };
}

function applyFormat(obj: unknown, fmt: string): string {
  const getPath = (o: unknown, p: string): unknown =>
    p
      .split(".")
      .filter(Boolean)
      .reduce<unknown>(
        (x, k) => (x == null ? undefined : (x as Record<string, unknown>)[k]),
        o,
      );
  const val = (v: unknown): string =>
    v === undefined || v === null
      ? "<no value>"
      : typeof v === "object"
        ? Array.isArray(v)
          ? "[" + v.join(" ") + "]"
          : "map[" + Object.keys(v).join(" ") + "]"
        : String(v);
  let s = fmt.replace(
    /\{\{\s*range\s+\.([\w.]*)\s*\}\}([\s\S]*?)\{\{\s*end\s*\}\}/g,
    (_, p: string, inner: string) => {
      const v = getPath(obj, p);
      if (!v || typeof v !== "object") return "";
      return Object.values(v)
        .map((x) => applyFormat(x, inner))
        .join("");
    },
  );
  s = s.replace(/\{\{\s*json\s+\.([\w.]*)\s*\}\}/g, (_, p: string) =>
    JSON.stringify(getPath(obj, p)),
  );
  s = s.replace(/\{\{\s*\.([\w.]*)\s*\}\}/g, (_, p: string) =>
    val(p ? getPath(obj, p) : obj),
  );
  return s;
}

export function docker(args: string[], ctx: Ctx): Res {
  const sub = args[0],
    a = args.slice(1);
  if (!sub || sub === "help" || sub === "--help")
    return R(`Usage:  docker COMMAND

Common commands:
  run       Create and start a container from an image
  ps        List containers (add -a for stopped ones too)
  images    List images on this machine
  pull      Download an image from Docker Hub
  build     Build an image from a Dockerfile
  tag       Give an image another name
  stop / start / restart / rm      Manage containers
  rmi       Remove an image
  logs      Show a container’s output
  exec      Run a command inside a running container
  inspect   Show details about a container, image, volume or network
  stats     Show CPU and memory use

Management commands:
  volume    create / ls / rm / inspect
  network   create / ls / rm / inspect / connect / disconnect
  system    df / prune
  compose   up / ps / logs / down`);
  if (sub === "--version" || sub === "-v" || sub === "version")
    return R("Docker version 27.3.1, build ce12230");
  if (sub === "container") {
    if (a[0] === "ls" || a[0] === "list")
      return docker(["ps"].concat(a.slice(1)), ctx);
    if (a[0] === "prune") return prune("container", a.slice(1));
    return docker(a, ctx);
  }
  if (sub === "image") {
    if (a[0] === "ls" || a[0] === "list") return docker(["images"], ctx);
    if (a[0] === "prune") return prune("image", a.slice(1));
    return docker(a, ctx);
  }
  switch (sub) {
    case "pull":
      return a[0]
        ? pull(a[0])
        : E(
            '"docker pull" requires exactly 1 argument. Try: docker pull nginx',
          );
    case "images": {
      const rows: (string | number)[][] = [
        ["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE"],
      ];
      for (const m of S.dk.images)
        rows.push([
          m.repo,
          m.tag,
          m.id,
          m.official ? "2 weeks ago" : ago(m.created) + " ago",
          m.size,
        ]);
      return R(table(rows));
    }
    case "ps": {
      const all = a.includes("-a") || a.includes("--all");
      const q = a.includes("-q");
      const list = S.dk.containers.filter((c) => all || c.status === "running");
      if (q) return R(list.map((c) => c.id).join("\n"));
      return R(
        table(
          [
            [
              "CONTAINER ID",
              "IMAGE",
              "COMMAND",
              "CREATED",
              "STATUS",
              "PORTS",
              "NAMES",
            ],
          ].concat(
            list.map((c) => [
              c.id,
              c.image,
              cmdText(c),
              ago(c.created) + " ago",
              statusText(c),
              portsText(c),
              c.name,
            ]),
          ),
        ),
      );
    }
    case "run":
      return dockerRun(a);
    case "stop":
    case "start":
    case "restart":
    case "kill": {
      const refs = a.filter((x) => x[0] !== "-");
      if (!refs.length)
        return E(
          `"docker ${sub}" requires at least 1 argument. Try: docker ${sub} web`,
        );
      const outs: string[] = [],
        errs: string[] = [];
      for (const r of refs) {
        const c = findCt(r);
        if (!c) {
          errs.push(`Error response from daemon: No such container: ${r}`);
          continue;
        }
        if (sub === "stop" || sub === "kill") {
          if (c.status === "running") {
            c.status = "exited";
            c.exit = sub === "kill" ? 137 : 0;
            c.stopped = Date.now();
          }
        } else {
          const hp = c.ports
            .map((p) => p.split(":")[0])
            .find((h) =>
              S.dk.containers.some(
                (o) =>
                  o !== c &&
                  o.status === "running" &&
                  o.ports.some((q) => q.split(":")[0] === h),
              ),
            );
          if (hp) {
            errs.push(
              `Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${hp} failed: port is already allocated`,
            );
            continue;
          }
          startCt(c);
        }
        outs.push(r);
      }
      return {
        out: outs.join("\n"),
        err: errs.join("\n"),
        code: errs.length ? 1 : 0,
      };
    }
    case "rm": {
      const { fl, pos } = pf(a);
      if (!pos.length)
        return E(
          '"docker rm" requires at least 1 argument. Try: docker rm web',
        );
      const outs: string[] = [],
        errs: string[] = [];
      for (const r of pos) {
        const c = findCt(r);
        if (!c) {
          errs.push(`Error response from daemon: No such container: ${r}`);
          continue;
        }
        if (c.status === "running" && !fl.has("f")) {
          errs.push(
            `Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove (docker rm -f)`,
          );
          continue;
        }
        S.dk.containers = S.dk.containers.filter((x) => x !== c);
        outs.push(r);
      }
      return {
        out: outs.join("\n"),
        err: errs.join("\n"),
        code: errs.length ? 1 : 0,
      };
    }
    case "rmi": {
      if (!a.length) return E('"docker rmi" requires at least 1 argument');
      const outs: string[] = [],
        errs: string[] = [];
      for (const r of a.filter((x) => x[0] !== "-")) {
        const m = findImg(r);
        if (!m) {
          errs.push(`Error response from daemon: No such image: ${r}`);
          continue;
        }
        const user = S.dk.containers.find((c) => c.image === imgName(m));
        if (user && !a.includes("-f")) {
          errs.push(
            `Error response from daemon: conflict: unable to remove repository reference "${r}" (must force) - container ${user.id} is using its referenced image ${m.id}`,
          );
          continue;
        }
        S.dk.images = S.dk.images.filter((x) => x !== m);
        outs.push(`Untagged: ${imgName(m)}`);
        if (!S.dk.images.some((x) => x.id === m.id))
          outs.push(`Deleted: sha256:${m.id}${hex(52)}`);
      }
      return {
        out: outs.join("\n"),
        err: errs.join("\n"),
        code: errs.length ? 1 : 0,
      };
    }
    case "tag": {
      if (a.length < 2)
        return E(
          '"docker tag" requires exactly 2 arguments. Try: docker tag myapp myapp:1.0',
        );
      const m = findImg(a[0]);
      if (!m) return E(`Error response from daemon: No such image: ${a[0]}`);
      const { repo, tag } = parseRef(a[1]);
      S.dk.images = S.dk.images.filter(
        (x) => !(x.repo === repo && x.tag === tag),
      );
      S.dk.images.push(Object.assign(clone(m), { repo, tag }));
      return R("");
    }
    case "logs": {
      const r = a.find((x) => x[0] !== "-");
      if (!r)
        return E(
          '"docker logs" requires exactly 1 argument. Try: docker logs web',
        );
      const c = findCt(r);
      if (!c) return E(`Error response from daemon: No such container: ${r}`);
      let out = c.logs.join("\n");
      if (a.includes("-f") || a.includes("--follow"))
        out +=
          "\n(-f keeps following new lines live on a real machine. Here you see everything so far.)";
      return R(out);
    }
    case "exec": {
      let i = 0;
      while (i < a.length && a[i][0] === "-") {
        if (a[i] === "-e" || a[i] === "-w" || a[i] === "-u") i++;
        i++;
      }
      const r = a[i],
        cmd = a.slice(i + 1);
      if (!r || !cmd.length)
        return E(
          '"docker exec" needs a container and a command. Try: docker exec web ls /',
        );
      const c = findCt(r);
      if (!c) return E(`Error response from daemon: No such container: ${r}`);
      if (c.status !== "running")
        return E(
          `Error response from daemon: container ${c.id} is not running`,
        );
      return containerShell(c, cmd);
    }
    case "inspect": {
      let fmt: string | null = null;
      const refs: string[] = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "-f" || a[i] === "--format") fmt = a[++i];
        else if (a[i].startsWith("--format=")) fmt = a[i].slice(9);
        else refs.push(a[i]);
      }
      if (!refs.length)
        return E(
          '"docker inspect" requires at least 1 argument. Try: docker inspect web',
        );
      const objs: unknown[] = [];
      for (const r of refs) {
        const c = findCt(r);
        if (c) {
          objs.push(inspectCt(c));
          continue;
        }
        const m = findImg(r);
        if (m) {
          objs.push({
            Id: "sha256:" + m.id,
            RepoTags: [imgName(m)],
            Size: m.size,
            Config: {
              Cmd: (m.cmd || "").split(" "),
              ExposedPorts: m.expose ? { [m.expose + "/tcp"]: {} } : {},
            },
          });
          continue;
        }
        const v = S.dk.volumes.find((x) => x.name === r);
        if (v) {
          objs.push(volInspect(v));
          continue;
        }
        const n = findNet(r);
        if (n) {
          objs.push(netInspect(n));
          continue;
        }
        return E(`Error: No such object: ${r}`);
      }
      return R(
        fmt
          ? objs.map((o) => applyFormat(o, fmt as string)).join("\n")
          : JSON.stringify(objs, null, 4),
      );
    }
    case "stats": {
      const run = S.dk.containers.filter((c) => c.status === "running");
      const MEM: Record<string, number> = {
        nginx: 7.2,
        redis: 4.1,
        postgres: 38.5,
      };
      return R(
        table(
          [
            [
              "CONTAINER ID",
              "NAME",
              "CPU %",
              "MEM USAGE / LIMIT",
              "MEM %",
              "NET I/O",
            ],
          ].concat(
            run.map((c) => {
              const seed = parseInt(c.id.slice(0, 4), 16);
              const mem = MEM[c.repo] || 31.8;
              return [
                c.id,
                c.name,
                ((seed % 40) / 100).toFixed(2) + "%",
                mem + "MiB / 3.84GiB",
                (mem / 39.3).toFixed(2) + "%",
                "1.2kB / 0B",
              ];
            }),
          ),
        ) +
          (a.includes("--no-stream")
            ? ""
            : "\n\n(stats normally updates live. Here you get one snapshot.)"),
      );
    }
    case "volume":
      return volume(a);
    case "network":
      return network(a);
    case "system": {
      if (a[0] === "df") {
        const run = S.dk.containers.filter(
          (c) => c.status === "running",
        ).length;
        return R(
          table([
            ["TYPE", "TOTAL", "ACTIVE", "SIZE", "RECLAIMABLE"],
            [
              "Images",
              S.dk.images.length,
              new Set(S.dk.containers.map((c) => c.image)).size,
              S.dk.images.length ? "1.4GB" : "0B",
              "0B",
            ],
            ["Containers", S.dk.containers.length, run, "0B", "0B"],
            [
              "Local Volumes",
              S.dk.volumes.length,
              S.dk.volumes.filter((v) => volUsers(v.name).length).length,
              S.dk.volumes.length ? "12MB" : "0B",
              "0B",
            ],
            ["Build Cache", 0, 0, "0B", "0B"],
          ]),
        );
      }
      if (a[0] === "prune") return prune("system", a.slice(1));
      return E("Usage: docker system df | docker system prune -f");
    }
    case "build":
      return dockerBuild(a);
    case "compose":
      return compose(a);
    default:
      return E(
        `docker: '${sub}' is not a docker command.\nSee 'docker --help'`,
      );
  }
}

function volUsers(n: string): Container[] {
  return S.dk.containers.filter((c) =>
    (c.mounts || []).some((m) => m.type === "volume" && m.name === n),
  );
}

function volInspect(v: Volume) {
  return {
    Name: v.name,
    Driver: "local",
    Mountpoint: `/var/lib/docker/volumes/${v.name}/_data`,
    CreatedAt: new Date(v.created).toISOString(),
  };
}

function netInspect(n: Network) {
  const cs: Record<string, { Name: string; IPv4Address: string }> = {};
  S.dk.containers
    .filter((c) => c.status === "running" && c.networks[n.name])
    .forEach((c) => {
      cs[c.id] = { Name: c.name, IPv4Address: c.networks[n.name] + "/16" };
    });
  return {
    Name: n.name,
    Id: n.id,
    Driver: n.driver,
    IPAM: { Config: n.subnet ? [{ Subnet: n.subnet + ".0.0/16" }] : [] },
    Containers: cs,
  };
}

function volume(a: string[]): Res {
  const sub = a[0],
    rest = a.slice(1);
  if (sub === "create") {
    const n = rest.find((x) => x[0] !== "-") || hex(32);
    if (!S.dk.volumes.some((v) => v.name === n))
      S.dk.volumes.push({ name: n, created: Date.now() });
    return R(n);
  }
  if (sub === "ls" || sub === "list")
    return R(
      table(
        [["DRIVER", "VOLUME NAME"]].concat(
          S.dk.volumes.map((v) => ["local", v.name]),
        ),
      ),
    );
  if (sub === "rm") {
    const outs: string[] = [],
      errs: string[] = [];
    for (const n of rest.filter((x) => x[0] !== "-")) {
      const v = S.dk.volumes.find((x) => x.name === n);
      if (!v) {
        errs.push(`Error response from daemon: get ${n}: no such volume`);
        continue;
      }
      const u = volUsers(n);
      if (u.length && !rest.includes("-f")) {
        errs.push(
          `Error response from daemon: remove ${n}: volume is in use - [${u.map((c) => c.id).join(", ")}]`,
        );
        continue;
      }
      S.dk.volumes = S.dk.volumes.filter((x) => x !== v);
      outs.push(n);
    }
    return {
      out: outs.join("\n"),
      err: errs.join("\n"),
      code: errs.length ? 1 : 0,
    };
  }
  if (sub === "inspect") {
    const v = S.dk.volumes.find((x) => x.name === rest[0]);
    return v
      ? R(JSON.stringify([volInspect(v)], null, 4))
      : E(`Error response from daemon: get ${rest[0]}: no such volume`);
  }
  if (sub === "prune") {
    const gone = S.dk.volumes.filter((v) => !volUsers(v.name).length);
    if (!rest.includes("-f"))
      return E(
        "(This sandbox can’t answer yes/no prompts. Add -f to confirm.)",
      );
    S.dk.volumes = S.dk.volumes.filter((v) => !gone.includes(v));
    return R(
      "Deleted Volumes:\n" +
        gone.map((v) => v.name).join("\n") +
        "\n\nTotal reclaimed space: 0B",
    );
  }
  return E("Usage: docker volume create | ls | rm | inspect | prune");
}

export function network(a: string[]): Res {
  const sub = a[0],
    rest = a.slice(1);
  if (sub === "create") {
    const n = rest.find((x) => x[0] !== "-");
    if (!n)
      return E(
        '"docker network create" requires exactly 1 argument. Try: docker network create harbor-net',
      );
    if (S.dk.networks.some((x) => x.name === n))
      return E(
        `Error response from daemon: network with name ${n} already exists`,
      );
    const used = S.dk.networks.filter((x) => x.subnet).length;
    const net: Network = {
      name: n,
      id: hex(12),
      driver: "bridge",
      subnet: "172." + (17 + used),
      next: 1,
      user: true,
    };
    S.dk.networks.push(net);
    return R(net.id + hex(52));
  }
  if (sub === "ls" || sub === "list")
    return R(
      table(
        [["NETWORK ID", "NAME", "DRIVER", "SCOPE"]].concat(
          S.dk.networks.map((n) => [n.id, n.name, n.driver, "local"]),
        ),
      ),
    );
  if (sub === "rm") {
    const outs: string[] = [],
      errs: string[] = [];
    for (const r of rest) {
      const n = findNet(r);
      if (!n) {
        errs.push(`Error response from daemon: network ${r} not found`);
        continue;
      }
      if (!n.user) {
        errs.push(
          `Error response from daemon: ${n.name} is a pre-defined network and cannot be removed`,
        );
        continue;
      }
      const u = S.dk.containers.filter(
        (c) => c.status === "running" && c.networks[n.name],
      );
      if (u.length) {
        errs.push(
          `Error response from daemon: error while removing network: network ${n.name} id ${n.id} has active endpoints`,
        );
        continue;
      }
      S.dk.networks = S.dk.networks.filter((x) => x !== n);
      outs.push(r);
    }
    return {
      out: outs.join("\n"),
      err: errs.join("\n"),
      code: errs.length ? 1 : 0,
    };
  }
  if (sub === "inspect") {
    const n = findNet(rest[0] || "");
    return n
      ? R(JSON.stringify([netInspect(n)], null, 4))
      : E(`Error response from daemon: network ${rest[0]} not found`);
  }
  if (sub === "connect" || sub === "disconnect") {
    const [nn, cn] = rest.filter((x) => x[0] !== "-");
    const n = findNet(nn || "");
    if (!n) return E(`Error response from daemon: network ${nn} not found`);
    const c = findCt(cn || "");
    if (!c) return E(`Error response from daemon: No such container: ${cn}`);
    if (sub === "connect") {
      if (c.networks[n.name])
        return E(
          `Error response from daemon: endpoint with name ${c.name} already exists in network ${n.name}`,
        );
      c.networks[n.name] = ipFor(n.name);
    } else {
      if (!c.networks[n.name])
        return E(
          `Error response from daemon: container ${c.id} is not connected to network ${n.name}`,
        );
      delete c.networks[n.name];
    }
    return R("");
  }
  if (sub === "prune") {
    if (!rest.includes("-f"))
      return E(
        "(This sandbox can’t answer yes/no prompts. Add -f to confirm.)",
      );
    const gone = S.dk.networks.filter(
      (n) => n.user && !S.dk.containers.some((c) => c.networks[n.name]),
    );
    S.dk.networks = S.dk.networks.filter((n) => !gone.includes(n));
    return R("Deleted Networks:\n" + gone.map((n) => n.name).join("\n"));
  }
  return E(
    "Usage: docker network create | ls | rm | inspect | connect | disconnect | prune",
  );
}

function prune(kind: string, a: string[]): Res {
  if (!a.includes("-f") && !a.includes("--force"))
    return E(
      `WARNING! This will remove ${kind === "image" ? "all dangling images" : kind === "system" ? "all stopped containers, unused networks and dangling images" : "all stopped containers"}.\n(This sandbox can’t answer yes/no prompts. Add -f to confirm.)`,
    );
  const out: string[] = [];
  if (kind === "container" || kind === "system") {
    const gone = S.dk.containers.filter((c) => c.status !== "running");
    S.dk.containers = S.dk.containers.filter((c) => c.status === "running");
    out.push("Deleted Containers:", ...gone.map((c) => c.id), "");
  }
  if (kind === "system") {
    const gone = S.dk.networks.filter(
      (n) => n.user && !S.dk.containers.some((c) => c.networks[n.name]),
    );
    S.dk.networks = S.dk.networks.filter((n) => !gone.includes(n));
    if (gone.length)
      out.push("Deleted Networks:", ...gone.map((n) => n.name), "");
  }
  if (kind === "image" || kind === "system") {
    const gone = S.dk.images.filter((m) => m.repo === "<none>");
    S.dk.images = S.dk.images.filter((m) => m.repo !== "<none>");
    if (gone.length)
      out.push(
        "Deleted Images:",
        ...gone.map((m) => "deleted: sha256:" + m.id),
        "",
      );
  }
  out.push("Total reclaimed space: 0B");
  return R(out.join("\n"));
}

export function parseMount(spec: string): Mount | null {
  const [src, dst] = spec.split(":");
  if (!src || !dst) return null;
  if (/^[/.~]/.test(src)) return { type: "bind", src: norm(src), dst: dst };
  return { type: "volume", name: src, dst: dst };
}

function dockerRun(a: string[]): Res {
  let det = false,
    name: string | null = null,
    rm = false,
    it = false,
    network: string | null = null;
  const ports: string[] = [],
    env: string[] = [],
    mounts: string[] = [];
  let i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (x[0] !== "-") break;
    if (x === "-d" || x === "--detach") det = true;
    else if (x === "--rm") rm = true;
    else if (x === "--name") name = a[++i];
    else if (x.startsWith("--name=")) name = x.slice(7);
    else if (x === "-p" || x === "--publish") ports.push(a[++i] || "");
    else if (x === "-e" || x === "--env") env.push(a[++i] || "");
    else if (x.startsWith("--env=")) env.push(x.slice(6));
    else if (x === "-v" || x === "--volume") mounts.push(a[++i] || "");
    else if (x === "--network" || x === "--net") network = a[++i];
    else if (x.startsWith("--network=")) network = x.slice(10);
    else if (x === "-w" || x === "--restart" || x === "-u") i++;
    else if (/^-[a-z]+$/.test(x)) {
      if (x.includes("d")) det = true;
      if (x.includes("i") || x.includes("t")) it = true;
      if (x.endsWith("p")) ports.push(a[++i] || "");
      else if (x.endsWith("e")) env.push(a[++i] || "");
      else if (x.endsWith("v")) mounts.push(a[++i] || "");
    }
  }
  const ref = a[i],
    cmd = a.slice(i + 1);
  if (!ref)
    return E(
      '"docker run" requires at least 1 argument.\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]',
    );
  if (name && S.dk.containers.some((c) => c.name === name)) {
    const o = S.dk.containers.find((c) => c.name === name) as Container;
    return E(
      `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${o.id}". You have to remove (or rename) that container to be able to reuse that name.`,
      125,
    );
  }
  if (network && !findNet(network))
    return E(
      `docker: Error response from daemon: network ${network} not found.`,
      125,
    );
  for (const p of ports) {
    if (!/^\d+:\d+$/.test(p))
      return E(
        `docker: invalid port mapping "${p}". Use HOST:CONTAINER, like 8080:80.`,
        125,
      );
    const hp = p.split(":")[0];
    if (
      S.dk.containers.some(
        (c) =>
          c.status === "running" && c.ports.some((q) => q.split(":")[0] === hp),
      )
    )
      return E(
        `docker: Error response from daemon: Bind for 0.0.0.0:${hp} failed: port is already allocated.`,
        125,
      );
  }
  const mts: Mount[] = [];
  for (const m of mounts) {
    const pm = parseMount(m);
    if (!pm)
      return E(
        `docker: invalid volume spec "${m}". Use NAME:/path/in/container, like harbor-data:/data.`,
        125,
      );
    mts.push(pm);
  }
  for (const e of env)
    if (!e.includes("="))
      return E(
        `docker: invalid environment variable "${e}". Use KEY=value.`,
        125,
      );
  let pre = "";
  let img = findImg(ref);
  if (!img) {
    const { repo, tag } = parseRef(ref);
    if (!REG[repo])
      return E(
        `Unable to find image '${repo}:${tag}' locally\ndocker: Error response from daemon: pull access denied for ${repo}, repository does not exist or may require 'docker login'.`,
        125,
      );
    pre =
      `Unable to find image '${repo}:${tag}' locally\n` + pull(ref).out + "\n";
    img = findImg(ref);
  }
  mts.forEach((m) => {
    if (m.type === "volume" && !S.dk.volumes.some((v) => v.name === m.name))
      S.dk.volumes.push({ name: m.name as string, created: Date.now() });
  });
  const { c, out } = makeContainer({
    img: img as Image,
    name,
    ports,
    env,
    mounts: mts,
    network,
    cmd,
    det,
    it,
  });
  if (!(rm && c.status !== "running")) S.dk.containers.push(c);
  return {
    out: pre + out,
    code: c.status !== "running" && c.exit && !det ? c.exit : 0,
  };
}

export function buildImage(
  path: string,
  tag: string | null,
):
  | { err: string; out?: undefined; img?: undefined }
  | { err?: undefined; out: string; img: Image } {
  const dn = get(path);
  if (!dn || dn.t !== "d")
    return {
      err: `ERROR: unable to prepare context: path "${path}" not found`,
    };
  const df = dn.c.Dockerfile;
  if (!df || df.t !== "f")
    return {
      err: "ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory\n(cd into the folder that has the Dockerfile first, then use . as the path)",
    };
  const OK = [
    "FROM",
    "RUN",
    "CMD",
    "LABEL",
    "EXPOSE",
    "ENV",
    "ADD",
    "COPY",
    "ENTRYPOINT",
    "VOLUME",
    "USER",
    "WORKDIR",
    "ARG",
    "ONBUILD",
    "STOPSIGNAL",
    "HEALTHCHECK",
    "SHELL",
    "MAINTAINER",
  ];
  const raw = df.x.split("\n");
  const ls: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i].trim();
    if (!l || l[0] === "#") continue;
    const ins = l.split(/\s+/)[0].toUpperCase();
    if (!OK.includes(ins))
      return {
        err: `ERROR: failed to solve: dockerfile parse error on line ${i + 1}: unknown instruction: ${l.split(/\s+/)[0]}`,
      };
    ls.push(l);
  }
  if (!ls.length || !/^FROM\s/i.test(ls[0]))
    return {
      err: "ERROR: failed to solve: no build stage in current context (a Dockerfile must start with FROM)",
    };
  const fromRef = ls[0].split(/\s+/)[1] || "";
  const fr = parseRef(fromRef);
  if (!REG[fr.repo] && !findImg(fromRef))
    return {
      err: `ERROR: failed to solve: ${fromRef}: failed to resolve source metadata for docker.io/library/${fromRef}: pull access denied, repository does not exist`,
    };
  const steps = ls.filter((l) => /^(FROM|WORKDIR|COPY|ADD|RUN)\s/i.test(l));
  const out = [
    `[+] Building 4.2s (${steps.length + 5}/${steps.length + 5}) FINISHED`,
    " => [internal] load build definition from Dockerfile",
    ` => [internal] load metadata for docker.io/library/${fromRef}`,
    " => [internal] load build context",
  ];
  steps.forEach((s, i) =>
    out.push(
      ` => [${i + 1}/${steps.length}] ${i === 0 ? "FROM docker.io/library/" + fromRef : s}`,
    ),
  );
  const { repo, tag: t } = tag
    ? parseRef(tag)
    : { repo: "<none>", tag: "<none>" };
  out.push(" => exporting to image", ` => => writing image sha256:${hex(64)}`);
  if (tag) out.push(` => => naming to docker.io/library/${repo}:${t}`);
  const cmdLine = ls.find((l) => /^CMD\s/i.test(l));
  let cmd = "/bin/sh";
  if (cmdLine) {
    try {
      cmd = (JSON.parse(cmdLine.slice(3).trim()) as string[]).join(" ");
    } catch {
      cmd = cmdLine.slice(3).trim();
    }
  }
  const exp = (ls.find((l) => /^EXPOSE\s/i.test(l)) || "").split(/\s+/)[1];
  const app = dn.c["app.py"];
  const reply =
    app && app.t === "f"
      ? (app.x.match(/return\s+["'](.*)["']/) || [])[1] || null
      : null;
  const files = Object.keys(dn.c)
    .filter((k) => k[0] !== ".")
    .sort();
  const filesText: Record<string, string> = {};
  files.forEach((k) => {
    const n = dn.c[k];
    if (n.t === "f") filesText[k] = n.x;
  });
  if (tag)
    S.dk.images = S.dk.images.filter((m) => !(m.repo === repo && m.tag === t));
  const img: Image = {
    repo,
    tag: t,
    id: hex(12),
    size: "156MB",
    created: Date.now(),
    cmd: cmd,
    server: !!exp,
    expose: exp,
    reply: reply,
    files: files,
    filesText: filesText,
    logs: [
      " * Serving Flask app 'app'",
      " * Debug mode: off",
      " * Running on all addresses (0.0.0.0)",
      ` * Running on http://127.0.0.1:${exp || 5000}`,
      "Press CTRL+C to quit",
    ],
  };
  S.dk.images.push(img);
  return { out: out.join("\n"), img: img };
}

function dockerBuild(a: string[]): Res {
  let tag: string | null = null,
    path: string | null = null;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "-t" || a[i] === "--tag") tag = a[++i];
    else if (a[i].startsWith("-t=")) tag = a[i].slice(3);
    else if (a[i] === "-f") ++i;
    else if (a[i][0] !== "-") path = a[i];
  }
  if (!path)
    return E(
      'ERROR: "docker buildx build" requires exactly 1 argument.\n(Add a path at the end. Use . for this folder, like: docker build -t myapp .)',
    );
  const r = buildImage(path, tag);
  return r.err !== undefined ? E(r.err) : R(r.out);
}

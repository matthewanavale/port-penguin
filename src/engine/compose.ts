// The Docker Compose simulation and its small YAML reader. Ported from
// index.html:1162-1242 at 5e96ce5.
import { clockNow } from "./clock";
import {
  buildImage,
  cmdText,
  findImg,
  findNet,
  makeContainer,
  network,
  parseMount,
  portsText,
  pull,
  startCt,
  statusText,
} from "./docker";
import { ago, E, R, table } from "./helpers";
import type { Res } from "./helpers";
import { base, cwd, get } from "./paths";
import { S } from "./state";
import type { Container, Image, Mount } from "./state";

export type Yaml = string | null | Yaml[] | { [key: string]: Yaml };
type YamlMap = { [key: string]: Yaml };

export function parseYaml(txt: string): Yaml {
  const ls = txt
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, "").replace(/\s+$/, ""))
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  let i = 0;
  const scalar = (v: string): string | null => {
    v = v.trim();
    if (/^".*"$|^'.*'$/.test(v)) return v.slice(1, -1);
    return v === "" ? null : v;
  };
  function block(ind: number): Yaml {
    const first = ls[i];
    if (!first) return null;
    if (first.trim().startsWith("- ")) {
      const arr: Yaml[] = [];
      while (i < ls.length) {
        const l = ls[i];
        const li = l.search(/\S/);
        if (li !== ind || !l.trim().startsWith("- ")) break;
        arr.push(scalar(l.trim().slice(2)));
        i++;
      }
      return arr;
    }
    const obj: YamlMap = {};
    while (i < ls.length) {
      const l = ls[i];
      const li = l.search(/\S/);
      if (li < ind) break;
      if (li > ind) {
        i++;
        continue;
      }
      if (l.trim().startsWith("- ")) break;
      const m = l.trim().match(/^([^:]+):\s*(.*)$/);
      i++;
      if (!m) continue;
      const key = m[1].trim().replace(/^["']|["']$/g, "");
      if (m[2] !== "") {
        obj[key] = scalar(m[2]);
        continue;
      }
      const nx = ls[i];
      if (
        nx &&
        (nx.search(/\S/) > li ||
          (nx.search(/\S/) === li && nx.trim().startsWith("- ")))
      )
        obj[key] = block(nx.search(/\S/));
      else obj[key] = null;
    }
    return obj;
  }
  return block(0);
}

/** A YAML value read as a map. The legacy code read fields off any value. */
const asMap = (v: Yaml | undefined): YamlMap => (v || {}) as YamlMap;

export function compose(a: string[]): Res {
  let args = a.slice();
  let file: string | null = null;
  while (args[0] && args[0][0] === "-") {
    if (args[0] === "-f") {
      file = args[1];
      args = args.slice(2);
    } else args = args.slice(1);
  }
  const sub = args[0],
    rest = args.slice(1);
  if (!sub || sub === "help" || sub === "--help")
    return R(
      "Usage:  docker compose COMMAND\n\n  up -d     Create and start the whole stack in the background\n  ps        List the stack’s containers\n  logs      Show output from all services\n  down      Stop and remove containers and networks (-v also volumes)",
    );
  const fn = file
    ? get(file)
    : get("docker-compose.yml") ||
      get("compose.yaml") ||
      get("compose.yml") ||
      get("docker-compose.yaml");
  if (!fn || fn.t !== "f")
    return E(
      "no configuration file provided: not found\n(cd into a folder that has a docker-compose.yml first)",
    );
  let cfg: YamlMap | null;
  try {
    cfg = parseYaml(fn.x) as YamlMap | null;
  } catch {
    cfg = null;
  }
  if (!cfg || !cfg.services || typeof cfg.services !== "object")
    return E("validating docker-compose.yml: services must be a mapping");
  const conf = cfg;
  const proj =
    base(cwd())
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "") || "default";
  const svcs = conf.services as YamlMap;
  const names = Object.keys(svcs);
  const mine = () => S.dk.containers.filter((c) => c.project === proj);
  const order: string[] = [];
  const seen: Record<string, number> = {};
  const visit = (n: string) => {
    if (seen[n]) return;
    seen[n] = 1;
    const dep = svcs[n] && asMap(svcs[n]).depends_on;
    (Array.isArray(dep)
      ? (dep as string[])
      : dep && typeof dep === "object"
        ? Object.keys(dep)
        : []
    ).forEach(visit);
    order.push(n);
  };
  names.forEach(visit);
  if (sub === "config") return R(fn.x.replace(/\n$/, ""));
  if (sub === "up") {
    const det = rest.includes("-d") || rest.includes("--detach");
    const rebuild = rest.includes("--build");
    const out: string[] = [];
    const netName = proj + "_default";
    if (!findNet(netName)) {
      network(["create", netName]);
      out.push(` ✔ Network ${netName}  Created`);
    }
    if (conf.volumes && typeof conf.volumes === "object")
      for (const v of Object.keys(conf.volumes)) {
        const vn = proj + "_" + v;
        if (!S.dk.volumes.some((x) => x.name === vn)) {
          S.dk.volumes.push({ name: vn, created: clockNow() });
          out.push(` ✔ Volume "${vn}"  Created`);
        }
      }
    const started: Container[] = [];
    for (const sname of order) {
      const s = asMap(svcs[sname]);
      const cname = `${proj}-${sname}-1`;
      const ex = S.dk.containers.find((c) => c.name === cname);
      if (ex && ex.status === "running" && !rebuild) {
        out.push(` ✔ Container ${cname}  Running`);
        continue;
      }
      if (ex) {
        S.dk.containers = S.dk.containers.filter((c) => c !== ex);
      }
      let img: Image | null;
      if (s.build) {
        const tag = `${proj}-${sname}`;
        img = findImg(tag);
        if (!img || rebuild) {
          const b = buildImage(
            typeof s.build === "string" ? s.build : ".",
            tag,
          );
          if (b.err !== undefined)
            return E(out.join("\n") + (out.length ? "\n" : "") + b.err);
          img = b.img;
          out.push(` ✔ Service ${sname}  Built`);
        }
      } else if (s.image) {
        const ref = s.image as string;
        img = findImg(ref);
        if (!img) {
          const p = pull(ref);
          if (p.err) return E(p.err);
          img = findImg(ref);
          out.push(` ✔ ${sname} Pulled`);
        }
      } else
        return E(
          `service "${sname}" has neither an image nor a build context specified`,
        );
      const ports = Array.isArray(s.ports) ? s.ports.map(String) : [];
      for (const p of ports) {
        const hp = p.split(":")[0];
        const o = S.dk.containers.find(
          (c) =>
            c.status === "running" &&
            c.ports.some((q) => q.split(":")[0] === hp),
        );
        if (o)
          return E(
            out.join("\n") +
              `\nError response from daemon: Bind for 0.0.0.0:${hp} failed: port is already allocated (used by ${o.name})`,
          );
      }
      const envMap = s.environment;
      const env = Array.isArray(envMap)
        ? (envMap as string[])
        : envMap && typeof envMap === "object"
          ? Object.keys(envMap).map((k) => k + "=" + envMap[k])
          : [];
      const vols = conf.volumes;
      const mts = (Array.isArray(s.volumes) ? (s.volumes as string[]) : [])
        .map((v) => {
          const pm = parseMount(v);
          if (
            pm &&
            pm.type === "volume" &&
            vols &&
            Object.prototype.hasOwnProperty.call(vols, pm.name as string)
          )
            pm.name = proj + "_" + pm.name;
          return pm;
        })
        .filter(Boolean) as Mount[];
      const cmd = s.command ? String(s.command).split(/\s+/) : [];
      const { c } = makeContainer({
        img: img as Image,
        name: cname,
        ports,
        env,
        mounts: mts,
        network: netName,
        cmd,
        det: true,
        project: proj,
        service: sname,
      });
      S.dk.containers.push(c);
      started.push(c);
      out.push(
        ` ✔ Container ${cname}  ${c.status === "running" ? "Started" : "Exited"}`,
      );
    }
    let text = `[+] Running ${out.length}/${out.length}\n` + out.join("\n");
    if (!det) {
      const logLines: string[] = [];
      started.forEach((c) =>
        c.logs.forEach((l) => logLines.push(`${c.service}-1  | ${l}`)),
      );
      text +=
        "\nAttaching to " +
        started.map((c) => c.name).join(", ") +
        "\n" +
        logLines.join("\n") +
        "\n^C\nGracefully stopping... (You pressed Ctrl+C, so the stack stopped. Add -d to keep it running in the background.)";
      started.forEach((c) => {
        if (c.status === "running") {
          c.status = "exited";
          c.exit = 0;
          c.stopped = clockNow();
        }
      });
    }
    return R(text);
  }
  if (sub === "ps") {
    const all = rest.includes("-a");
    const list = mine().filter((c) => all || c.status === "running");
    return R(
      table(
        [
          ["NAME", "IMAGE", "COMMAND", "SERVICE", "CREATED", "STATUS", "PORTS"],
        ].concat(
          list.map((c) => [
            c.name,
            c.image,
            cmdText(c),
            c.service as string,
            ago(c.created) + " ago",
            statusText(c),
            portsText(c),
          ]),
        ),
      ),
    );
  }
  if (sub === "logs") {
    const sv = rest.find((x) => x[0] !== "-");
    const list = mine().filter((c) => !sv || c.service === sv);
    if (sv && !list.length) return E(`no such service: ${sv}`);
    return R(
      list
        .map((c) => c.logs.map((l) => `${c.service}-1  | ${l}`).join("\n"))
        .join("\n"),
    );
  }
  if (sub === "stop" || sub === "start" || sub === "restart") {
    const list = mine();
    list.forEach((c) => {
      if (sub === "stop") {
        if (c.status === "running") {
          c.status = "exited";
          c.exit = 0;
          c.stopped = clockNow();
        }
      } else startCt(c);
    });
    return R(
      list
        .map(
          (c) =>
            ` ✔ Container ${c.name}  ${sub === "stop" ? "Stopped" : "Started"}`,
        )
        .join("\n"),
    );
  }
  if (sub === "down") {
    const list = mine();
    const out: string[] = [];
    list.forEach((c) => {
      out.push(` ✔ Container ${c.name}  Removed`);
    });
    S.dk.containers = S.dk.containers.filter((c) => c.project !== proj);
    const nn = proj + "_default";
    if (findNet(nn)) {
      S.dk.networks = S.dk.networks.filter((n) => n.name !== nn);
      out.push(` ✔ Network ${nn}  Removed`);
    }
    if (rest.includes("-v") || rest.includes("--volumes"))
      S.dk.volumes = S.dk.volumes.filter((v) => {
        if (v.name.startsWith(proj + "_")) {
          out.push(` ✔ Volume ${v.name}  Removed`);
          return false;
        }
        return true;
      });
    return R(
      out.length
        ? `[+] Running ${out.length}/${out.length}\n` + out.join("\n")
        : "Nothing to remove. The stack isn’t running.",
    );
  }
  return E(`unknown docker compose command: ${sub}`);
}

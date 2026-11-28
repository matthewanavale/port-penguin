// AC4: `date`, its `-d` text parser, and the `touch -t` parser. The clock is
// UTC (the TZ of the capture is UTC). `parseDate` and `parseTouchT` are
// exported for `touch -d` and `touch -t` (item 12).
import { clockNow } from "../clock";
import type { CmdFn } from "../shell/io";
import { errOut, getopt, tryHelp } from "./text";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number, w = 2, c = "0"): string => String(n).padStart(w, c);

/** Day of the year, 1 to 366. */
function yday(d: Date): number {
  return (
    Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) +
    1
  );
}

/** ISO 8601 week number and week-year. */
function isoWeek(d: Date): [number, number] {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return [w, y];
}

/** `strftime` for UTC, with the GNU flags `-`, `_`, `0`, and `^`. */
export function formatDate(ms: number, fmt: string): string {
  const d = new Date(ms);
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%" || i === fmt.length - 1) {
      out += fmt[i];
      continue;
    }
    let flag = "";
    let j = i + 1;
    while ("-_0^#".includes(fmt[j]) && j < fmt.length - 1) flag += fmt[j++];
    let width = "";
    while (/\d/.test(fmt[j] ?? "")) width += fmt[j++];
    const c = fmt[j];
    const num = (n: number, w: number, padc = "0"): string => {
      if (flag.includes("-")) return String(n);
      if (flag.includes("_")) padc = " ";
      else if (flag.includes("0")) padc = "0";
      return pad(n, width ? parseInt(width, 10) : w, padc);
    };
    const txt = (s: string): string => {
      let r = flag.includes("^") ? s.toUpperCase() : s;
      if (width) r = r.padStart(parseInt(width, 10));
      return r;
    };
    const h12 = d.getUTCHours() % 12 || 12;
    const sub = (f: string): string => formatDate(ms, f);
    let r: string;
    switch (c) {
      case "Y":
        r = String(d.getUTCFullYear());
        break;
      case "C":
        r = num(Math.floor(d.getUTCFullYear() / 100), 2);
        break;
      case "y":
        r = num(d.getUTCFullYear() % 100, 2);
        break;
      case "m":
        r = num(d.getUTCMonth() + 1, 2);
        break;
      case "d":
        r = num(d.getUTCDate(), 2);
        break;
      case "e":
        r = num(d.getUTCDate(), 2, " ");
        break;
      case "H":
        r = num(d.getUTCHours(), 2);
        break;
      case "k":
        r = num(d.getUTCHours(), 2, " ");
        break;
      case "I":
        r = num(h12, 2);
        break;
      case "l":
        r = num(h12, 2, " ");
        break;
      case "M":
        r = num(d.getUTCMinutes(), 2);
        break;
      case "S":
        r = num(d.getUTCSeconds(), 2);
        break;
      case "N":
        r = pad(d.getUTCMilliseconds(), 3) + "000000";
        break;
      case "j":
        r = num(yday(d), 3);
        break;
      case "u":
        r = String(d.getUTCDay() || 7);
        break;
      case "w":
        r = String(d.getUTCDay());
        break;
      case "a":
        r = txt(DAYS[d.getUTCDay()].slice(0, 3));
        break;
      case "A":
        r = txt(DAYS[d.getUTCDay()]);
        break;
      case "b":
      case "h":
        r = txt(MONTHS[d.getUTCMonth()].slice(0, 3));
        break;
      case "B":
        r = txt(MONTHS[d.getUTCMonth()]);
        break;
      case "p":
        r = txt(d.getUTCHours() < 12 ? "AM" : "PM");
        break;
      case "P":
        r = txt(d.getUTCHours() < 12 ? "am" : "pm");
        break;
      case "s":
        r = String(Math.floor(ms / 1000));
        break;
      case "Z":
        r = "UTC";
        break;
      case "z":
        r = "+0000";
        break;
      case "U":
        r = num(Math.floor((yday(d) - 1 + 7 - d.getUTCDay()) / 7), 2);
        break;
      case "W":
        r = num(
          Math.floor((yday(d) - 1 + 7 - ((d.getUTCDay() + 6) % 7)) / 7),
          2,
        );
        break;
      case "V":
        r = num(isoWeek(d)[0], 2);
        break;
      case "G":
        r = String(isoWeek(d)[1]);
        break;
      case "g":
        r = num(isoWeek(d)[1] % 100, 2);
        break;
      case "F":
        r = sub("%Y-%m-%d");
        break;
      case "T":
        r = sub("%H:%M:%S");
        break;
      case "D":
      case "x":
        r = sub("%m/%d/%y");
        break;
      case "R":
        r = sub("%H:%M");
        break;
      case "r":
        r = sub("%I:%M:%S %p");
        break;
      case "X":
        r = sub("%H:%M:%S");
        break;
      case "c":
        r = sub("%a %b %e %H:%M:%S %Y");
        break;
      case "n":
        r = "\n";
        break;
      case "t":
        r = "\t";
        break;
      case "%":
        r = "%";
        break;
      default:
        r = fmt.slice(i, j + 1);
    }
    out += r;
    i = j;
  }
  return out;
}

/* ---------- the -d parser ---------- */

const MON_ABBR = MONTHS.map((m) => m.slice(0, 3).toLowerCase());
const monthOf = (w: string): number => {
  const s = w.toLowerCase().replace(/\.$/, "");
  if (s === "sept") return 8;
  const i = MON_ABBR.indexOf(s.slice(0, 3));
  if (i >= 0 && (s.length === 3 || MONTHS[i].toLowerCase() === s)) return i;
  return -1;
};
const dayOf = (w: string): number => {
  const s = w.toLowerCase().replace(/\.$/, "");
  const i = DAYS.findIndex(
    (d) => d.toLowerCase() === s || d.slice(0, 3).toLowerCase() === s,
  );
  if (i >= 0) return i;
  if (s === "tues") return 2;
  if (s === "wednes") return 3;
  if (s === "thur" || s === "thurs") return 4;
  return -1;
};

const UNITS: Record<string, string> = {
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  min: "mi",
  mins: "mi",
  minute: "mi",
  minutes: "mi",
  hour: "h",
  hours: "h",
  day: "d",
  days: "d",
  week: "w",
  weeks: "w",
  fortnight: "f",
  fortnights: "f",
  month: "mo",
  months: "mo",
  year: "y",
  years: "y",
};

const dim = (y: number, m: number): number =>
  new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * Reads the text of `date -d` (a useful part of the GNU grammar). Returns
 * milliseconds since the epoch, or null when the text is not a date.
 */
export function parseDate(text: string, now: number): number | null {
  const src = text.trim();
  if (src === "") {
    const t = new Date(now);
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  }
  const abs = /^@(-?\d+)(?:\.\d+)?$/.exec(src);
  if (abs) return parseInt(abs[1], 10) * 1000;
  const toks = src
    .replace(/,/g, " ")
    .replace(/(\d)T(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  const n = new Date(now);
  let Y = n.getUTCFullYear();
  let M = n.getUTCMonth();
  let D = n.getUTCDate();
  let h = n.getUTCHours();
  let mi = n.getUTCMinutes();
  let s = n.getUTCSeconds();
  let dateSeen = false;
  let timeSeen = false;
  let daySeen = false;
  let relSeen = false;
  let tz = 0;
  let wday = 0;
  let wordinal = 0;
  const rel = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  let lastRel = null as { k: keyof typeof rel; amt: number } | null;
  const addRel = (k: string, v: number): void => {
    relSeen = true;
    const m: Record<string, [keyof typeof rel, number]> = {
      s: ["s", 1],
      mi: ["mi", 1],
      h: ["h", 1],
      d: ["d", 1],
      w: ["d", 7],
      f: ["d", 14],
      mo: ["mo", 1],
      y: ["y", 1],
    };
    const [key, mul] = m[k];
    rel[key] += v * mul;
    lastRel = { k: key, amt: v * mul };
  };
  const setDate = (y: number, m: number, d: number): boolean => {
    if (m < 0 || m > 11 || d < 1 || d > dim(y, m)) return false;
    if (dateSeen) return false;
    Y = y;
    M = m;
    D = d;
    dateSeen = true;
    return true;
  };
  const setTime = (hh: number, mm: number, ss: number): boolean => {
    if (hh > 23 || mm > 59 || ss > 60 || timeSeen) return false;
    h = hh;
    mi = mm;
    s = ss;
    timeSeen = true;
    return true;
  };
  const yr = (t: string): number => {
    const v = parseInt(t, 10);
    if (t.length <= 2) return v < 69 ? 2000 + v : 1900 + v;
    return v;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const low = t.toLowerCase();
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) {
      if (!setDate(+m[1], +m[2] - 1, +m[3])) return null;
    } else if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t))) {
      if (!setDate(m[3] ? yr(m[3]) : Y, +m[1] - 1, +m[2])) return null;
    } else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t)) && !/:/.test(t)) {
      if (!setDate(+m[1], +m[2] - 1, +m[3])) return null;
    } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(am|pm)?$/i.exec(t))) {
      let hh = +m[1];
      const ap = (m[4] ?? toks[i + 1] ?? "").toLowerCase();
      const ampm = m[4] ? ap : ap === "am" || ap === "pm" ? ap : "";
      if (ampm) {
        if (hh < 1 || hh > 12) return null;
        hh = (hh % 12) + (ampm === "pm" ? 12 : 0);
        if (!m[4]) i++;
      }
      if (!setTime(hh, +m[2], m[3] ? +m[3] : 0)) return null;
    } else if ((m = /^(\d{1,2})(am|pm)$/i.exec(t))) {
      const hh = +m[1];
      if (hh < 1 || hh > 12) return null;
      if (!setTime((hh % 12) + (m[2].toLowerCase() === "pm" ? 12 : 0), 0, 0))
        return null;
    } else if (low === "now" || low === "today") {
      /* the current time */
    } else if (low === "yesterday" || low === "tomorrow") {
      addRel("d", low === "yesterday" ? -1 : 1);
    } else if (UNITS[low]) {
      addRel(UNITS[low], 1);
    } else if (low === "midnight") {
      if (!setTime(0, 0, 0)) return null;
    } else if (low === "noon") {
      if (!setTime(12, 0, 0)) return null;
    } else if (low === "utc" || low === "z" || low === "gmt") {
      /* the zone */
    } else if (low === "ago") {
      if (!lastRel) return null;
      rel[lastRel.k] -= 2 * lastRel.amt;
      lastRel = null;
    } else if (monthOf(t) >= 0 && !/^\d/.test(t)) {
      // Month name: "Jan 5 2020", "January 5", "Jan"
      const mon = monthOf(t);
      let d = 1;
      let y = Y;
      const a = toks[i + 1];
      if (a && /^\d{1,2}$/.test(a) && +a >= 1 && +a <= 31) {
        d = +a;
        i++;
        const b = toks[i + 1];
        if (b && /^\d{4}$/.test(b)) {
          y = +b;
          i++;
        }
      } else if (a && /^\d{1,2}(st|nd|rd|th)$/i.test(a)) {
        d = parseInt(a, 10);
        i++;
      }
      if (!setDate(y, mon, d)) return null;
    } else if (/^\d{1,2}$/.test(t) && monthOf(toks[i + 1] ?? "") >= 0) {
      // "5 Jan 2020"
      const mon = monthOf(toks[i + 1]);
      let y = Y;
      i++;
      const b = toks[i + 1];
      if (b && /^\d{4}$/.test(b)) {
        y = +b;
        i++;
      }
      if (!setDate(y, mon, +t)) return null;
    } else if (
      (m = /^([+-])(\d{1,4})$/.exec(t)) &&
      timeSeen &&
      i > 0 &&
      /^\d{1,2}:\d{2}/.test(toks[i - 1]) &&
      (UNITS[(toks[i + 1] ?? "").toLowerCase()] || toks[i + 1] === undefined)
    ) {
      // A signed number right after a clock time is a zone offset (GNU).
      const v = parseInt(m[2], 10);
      const mins =
        m[2].length <= 2 ? v * 60 : Math.floor(v / 100) * 60 + (v % 100);
      tz = (m[1] === "-" ? -1 : 1) * mins;
    } else if (
      (m = /^([+-]?\d+)$/.exec(t)) &&
      UNITS[(toks[i + 1] ?? "").toLowerCase()]
    ) {
      addRel(UNITS[toks[i + 1].toLowerCase()], parseInt(m[1], 10));
      i++;
    } else if (/^[+-]\d+[a-z]+$/i.test(t)) {
      const mm = /^([+-]\d+)([a-z]+)$/i.exec(t) as RegExpExecArray;
      const u = UNITS[mm[2].toLowerCase()];
      if (!u) return null;
      addRel(u, parseInt(mm[1], 10));
    } else if (low === "next" || low === "last" || low === "this") {
      const w = (toks[i + 1] ?? "").toLowerCase();
      const k = low === "next" ? 1 : low === "last" ? -1 : 0;
      if (UNITS[w]) {
        addRel(UNITS[w], k);
        i++;
      } else if (dayOf(w) >= 0) {
        if (daySeen) return null;
        daySeen = true;
        wday = dayOf(w);
        wordinal = k;
        i++;
      } else return null;
    } else if (dayOf(t) >= 0) {
      if (daySeen) return null;
      daySeen = true;
      wday = dayOf(t);
      wordinal = 0;
    } else if (/^\d{4}$/.test(t) && dateSeen) {
      Y = +t;
    } else return null;
  }
  if ((dateSeen || daySeen || timeSeen) && !timeSeen) {
    h = 0;
    mi = 0;
    s = 0;
  }
  let t = Date.UTC(Y, M, D, h, mi, s) - tz * 60000;
  // Months and years first, as GNU does, then days and the clock.
  if (rel.y || rel.mo) {
    const d = new Date(t);
    t = Date.UTC(
      d.getUTCFullYear() + rel.y,
      d.getUTCMonth() + rel.mo,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    );
  }
  if (daySeen && !dateSeen) {
    const w = new Date(t).getUTCDay();
    const k =
      ((wday - w + 7) % 7) +
      7 * (wordinal - (wordinal > 0 && w !== wday ? 1 : 0));
    t += k * 86400000;
  }
  t += rel.d * 86400000 + rel.h * 3600000 + rel.mi * 60000 + rel.s * 1000;
  void relSeen;
  return t;
}

/** `touch -t [[CC]YY]MMDDhhmm[.ss]`. Returns milliseconds, or null. */
export function parseTouchT(text: string, now: number): number | null {
  const m = /^(\d{2}|\d{4})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(
    text,
  );
  if (!m) return null;
  let y = new Date(now).getUTCFullYear();
  if (m[1]) {
    const v = parseInt(m[1], 10);
    y = m[1].length === 4 ? v : v < 69 ? 2000 + v : 1900 + v;
  }
  const mo = +m[2] - 1;
  const d = +m[3];
  const hh = +m[4];
  const mm = +m[5];
  const ss = m[6] ? +m[6] : 0;
  if (
    mo < 0 ||
    mo > 11 ||
    d < 1 ||
    d > dim(y, mo) ||
    hh > 23 ||
    mm > 59 ||
    ss > 61
  )
    return null;
  return Date.UTC(y, mo, d, hh, mm, ss);
}

/* ---------- the command ---------- */

const date: CmdFn = (argv, sh, io) => {
  const p = getopt("date", argv, "d:uIRr:s:", {
    date: ["d", true],
    utc: ["u", false],
    universal: ["u", false],
    "iso-8601": ["I", false],
    "rfc-email": ["R", false],
    reference: ["r", true],
    set: ["s", true],
  });
  if (typeof p === "string") {
    io.err.write(p);
    return 1;
  }
  let when = clockNow();
  let fmt = "%a %b %e %H:%M:%S UTC %Y";
  for (const o of p.opts) {
    if (o.name === "d") {
      const t = parseDate(o.val ?? "", clockNow());
      if (t === null) {
        errOut(io, "date", `invalid date ‘${o.val}’`);
        return 1;
      }
      when = t;
    } else if (o.name === "I") fmt = "%Y-%m-%d";
    else if (o.name === "R") fmt = "%a, %d %b %Y %H:%M:%S %z";
    else if (o.name === "s") {
      errOut(io, "date", "cannot set date: Operation not permitted");
      return 1;
    }
  }
  if (p.rest.length > 1) {
    io.err.write(`date: extra operand ‘${p.rest[1]}’\n${tryHelp("date")}`);
    return 1;
  }
  if (p.rest.length === 1) {
    const a = p.rest[0];
    if (a.startsWith("+")) fmt = a.slice(1);
    else {
      errOut(io, "date", `invalid date ‘${a}’`);
      return 1;
    }
  }
  io.out.write(formatDate(when, fmt) + "\n");
  return 0;
};

export const DATE_CMDS: Record<string, CmdFn> = { date };

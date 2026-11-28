# Port Penguin

A browser game that teaches Linux commands and Docker. It's a Vite +
TypeScript static site with an xterm.js terminal, served by nginx in a
Docker container, with your own nginx in front of it handling the domain
and HTTPS.

## What's in here

| Path                                               | What it is                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `index.html`                                       | The page shell; Vite builds it with the code in `src/`                    |
| `src/engine/`                                      | The game: file system, shell, commands, Docker simulation, tasks          |
| `src/term/`                                        | The xterm.js terminal, line editor, and colors                            |
| `src/ui/panel.ts`, `src/main.ts`, `src/styles.css` | The side panel and the page wiring                                        |
| `src/sw/`                                          | The service worker template and the build plugin that writes `dist/sw.js` |
| `public/`                                          | `manifest.webmanifest` and the icons, copied as they are into `dist/`     |
| `src/test/`                                        | Tests, golden transcripts, and the Ubuntu reference fixtures              |
| `Dockerfile`, `nginx.conf`, `docker-compose.yml`   | The container that builds and serves the game                             |
| `proxy/port-penguin.conf`                          | Server block for your reverse proxy nginx                                 |
| `proxy/make-self-signed-cert.sh`                   | Creates a self-signed certificate                                         |

## Build and run locally

You need Node.js 24 and npm.

```bash
npm ci              # install the locked packages
npm run dev         # play at the address Vite prints, with live reload
npm run build       # write the site to dist/
npm run preview     # serve dist/ to check the build
```

Checks to run before a change goes in:

```bash
npm run lint          # ESLint, then the TypeScript type check
npm run format:check  # Prettier
npm test              # Vitest
npm run build
npm run size          # gzip size of dist/assets/, at most 225 KB
```

## Setup

Replace `penguin.example.com` with your domain everywhere below.

### 1. DNS (Route53)

Create an A record for the domain pointing at the server's public IP
(and an AAAA record if it has IPv6). Check it with:

```bash
dig +short penguin.example.com
```

### 2. Start the container

```bash
cd port-penguin
docker compose up -d --build
```

The image builds in two stages: a Node.js stage runs `npm ci` and the
Vite build, and the final image is nginx with only the built files. The
build downloads npm packages, so the server needs network access during
`docker compose up --build`. A small server (1 GB of memory) should build
it; if the build runs out of memory, build the image on another machine
and push it to the server instead.

It listens on `127.0.0.1:8080` only, so it's reachable through your nginx
and not directly from the internet. If 8080 is taken, change it in
`docker-compose.yml` and in `proxy_pass` in `proxy/port-penguin.conf`.

Check it's up: `curl -I http://127.0.0.1:8080` should return `200 OK`.

### 3. Create the certificate

```bash
sudo ./proxy/make-self-signed-cert.sh penguin.example.com
```

This writes `/etc/ssl/port-penguin/fullchain.pem` and `privkey.pem`.

### 4. Add the site to nginx

Edit `proxy/port-penguin.conf` and put in your domain, then:

```bash
sudo cp proxy/port-penguin.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/port-penguin.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

If your setup uses `/etc/nginx/conf.d/`, copy the file there and skip the
symlink. If `nginx -t` warns that `listen ... http2` is deprecated (nginx
1.25.1 and newer), remove `http2` from both `listen 443` lines and add
`http2 on;` below them. It's only a warning; the site still works.

Open `https://penguin.example.com`.

## About self-signed certificates

The connection is encrypted, but browsers don't trust a self-signed
certificate. That means:

- Visitors see a "Your connection is not private" warning and have to click
  through it.
- Browsers refuse to run the service worker on an untrusted certificate, so
  "Install app" and offline play won't work. The game itself plays fine.

Two ways around this:

**Trust the certificate on your own devices.** Copy
`/etc/ssl/port-penguin/fullchain.pem` to each device and import it as a
trusted certificate (Keychain Access on macOS, "Manage computer
certificates" on Windows, Settings > General > About > Certificate Trust
Settings on iOS after installing it). Good for a home lab or a few machines.

**Get a free trusted certificate using Route53.** Let's Encrypt can verify
your domain through a DNS record, which works even if the server isn't
reachable from the internet. Certbot creates the record in Route53 for you:

```bash
sudo apt install certbot python3-certbot-dns-route53
sudo certbot certonly --dns-route53 -d penguin.example.com
```

The server needs AWS credentials (an IAM role or `~/.aws/credentials`)
allowed to `route53:ListHostedZones`, `route53:GetChange` and
`route53:ChangeResourceRecordSets` on your zone. Then change the two
certificate lines in `port-penguin.conf` to:

```nginx
ssl_certificate     /etc/letsencrypt/live/penguin.example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/penguin.example.com/privkey.pem;
```

and reload nginx. Certbot renews it automatically.

## Hints, skipping and the instructor password

Hints are locked behind an instructor password. Unlocking also allows
skipping tasks and jumping between them by clicking boxes in the
container yard. Unlocking is remembered in that browser until someone
clicks "Lock hints".

The default password is `ahoy-captain`. To change it:

```bash
echo -n 'your-new-password' | sha256sum
```

Copy the long hex string, open `src/engine/index.ts`, find the line
`const HINT_HASH =`, and paste it between the quotes. Then rebuild with
`docker compose up -d --build`. The build gives the service worker a new
cache name by itself, so installed copies pick up the change.

Keep in mind the check happens in the browser. Only the hash is in the
page, so the password itself can't be read from the source, but a
determined student who knows JavaScript could bypass the lock. It's a
speed bump for a learning game, not real security.

## The shell

The game terminal runs a bash interpreter (`src/engine/shell/`). It parses
each input into a syntax tree before it runs anything. It supports:

- quoting, escapes, and heredocs (`<<`, `<<-`, `<<<`);
- variables, arrays, `${...}` forms, `$(...)`, `<(...)`, and `$((...))`;
- pipes, `&&`, `||`, `;`, `{ }`, `( )`, redirects, and globs;
- `if`, `for`, `while`, `until`, `case`, and functions;
- aliases, `source`, `bash FILE`, `sh -c`, and the common builtins;
- an unfinished input shows `> ` and waits for more lines; Ctrl-C drops it.

Commands can wait, and several commands can run at the same time:

- **Keyboard input.** A command that reads the terminal waits until you
  type. `read` (with `-n`, `-N`, `-s`, `-p`, `-t`, `-e`), `select`, `cat`,
  `head`, `wc`, `grep`, `sort`, and every other command that reads
  standard input with no file work this way. Press Enter to send a line.
  Press Ctrl-D on an empty line to end the input. The first time a command
  waits, the terminal shows a short hint.
- **Time.** `sleep` waits for real time, with the suffixes `s`, `m`, `h`,
  and `d`.
- **Ctrl-C, Ctrl-Z, and Ctrl-\\.** While a command runs, these keys send
  the signals INT, TSTP, and QUIT. `trap` can catch them. On a phone, use
  the `^C` and `^D` keys at the start of the key bar above the keyboard.
- **Pipes.** The stages of a pipeline run at the same time. `yes | head -1`
  stops at once, with `PIPESTATUS` of `141 0`, as in bash.
- **Jobs.** `CMD &` starts a background job. `jobs`, `fg`, `bg`, `wait`,
  `disown`, and `kill %N` work as in bash, with the job specs `%N`, `%%`,
  `%+`, `%-`, `%NAME`, and `%?TEXT`. A job that ends shows its `Done`
  line before the next prompt. Background jobs show in `ps`, `ps aux`, and
  `top`, and `kill PID` ends them. Each shell has its own jobs: a script, a
  subshell, and a nested shell do not see the jobs of the prompt shell.
- **Nested shell.** `bash` or `sh` on a line of its own starts a child
  shell. It has only the exported variables, `SHLVL` plus 1, and its own
  jobs. `exit` or Ctrl-D on an empty line goes back, and the parent shell
  has the same folder and variables as before. In another place (after
  `;`, in a pipe or a function), `bash` with no script prints a message and
  returns 1. `echo 'echo hi' | bash` and `bash < FILE` read a script.
- **Reload and panel.** A reload, `exit` at the top prompt, and the panel
  buttons (skip, jump, reset, lock, unlock) end every job. Jobs are not
  saved.

Limits. At the prompt there is no step limit and no output limit:
`while true; do :; done` and `yes` run until you press Ctrl-C. These limits
stay: 1 MB for a string value and for data that a command keeps whole (for
example `x=$(yes)`), 100 000 array items, 100 000 brace words, the nesting
depth (64 scripts or nested shells), the 5 MB file system, 200 000 steps
inside one call of `awk` or `sed`, 20 000 steps for `~/.bashrc`, and a
field width of 1 000 000 in `printf`, `awk`, and `date`. The terminal keeps
5000 lines of scrollback.

The utilities (`find`, `awk`, `sed`, `tar`, `date`, `cut`, `tr`, `crontab`,
and others) are in `src/engine/utils/`. Their messages follow Ubuntu 24.04.

### Goldens and Ubuntu fixtures

- `npm run golden:record` records `src/test/golden/*.json` from the engine.
  `src/test/golden-run1/` holds the run-1 baseline and is never edited. A
  step that differs from it needs a `reason` (R1 to R7) in
  `src/test/scripts.ts`. R7 is run-2b behavior: keyboard input, `sleep`,
  SIGPIPE, jobs, the nested `bash`, `kill`, and the learner hints.
- A script step can also be `{ keys: "text" }` (text typed while a command
  runs; `"\x04"` is Ctrl-D) or `{ signal: "INT" | "TSTP" | "QUIT" }`.
  `{ advanceMs: N }` moves the fake clock. A command that waits for one of
  these ends at the next step; a command that still waits at the next line
  of the script is an error.
- The reference fixtures in `src/test/ubuntu/fixtures/` come from real
  Ubuntu 24.04. To capture them again, run
  `node --experimental-strip-types src/test/ubuntu/capture.ts [group ...]`.
  This needs Docker and Node 24. Tests read the fixtures and do not need
  Docker. A prompt case can type with no prompt (`@type TEXT`, `@raw "JSON"`),
  press a control key (`@key ^C`, `^Z`, `^D`, `^\`), and wait
  (`@wait N`). The normalizer replaces job PIDs.
- `node --experimental-strip-types src/tools/bench.ts` times 100 000
  iterations of `i=$((i+1))` through the engine. It is not a test. Run it
  on a branch and on a checkout of the base commit, then compare the two
  medians.

## Where progress is stored

Each player's progress lives in their own browser's localStorage (key
`port-penguin-v2`). Nothing is sent to the server, there are no accounts,
and progress doesn't follow a player to another browser or device.
Clearing browser data or using a private window starts from task 1.

## Updating the game

1. Edit the code in `src/` (the game itself is in `src/engine/`).
2. Run the checks from "Build and run locally".
3. Run `docker compose up -d --build`.

There is no cache version to bump. Each build names the service worker
cache `port-penguin-<hash>` from the built files, so installed copies pick
up the new version on their next visit.

## Notes

- Progress is saved in each player's own browser (localStorage). There are
  no accounts and nothing is stored on the server.
- The game loads two fonts from Google Fonts. Offline, it falls back to
  system fonts and still works.

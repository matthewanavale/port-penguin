# Port Penguin

A browser game that teaches Linux commands and Docker. It's a static site
served by nginx in a Docker container, with your own nginx in front of it
handling the domain and HTTPS.

## What's in here

| Path | What it is |
| --- | --- |
| `index.html` | The game |
| `sw.js`, `manifest.webmanifest`, `icon*` | Make it installable and playable offline |
| `Dockerfile`, `nginx.conf`, `docker-compose.yml` | The container that serves the game |
| `proxy/port-penguin.conf` | Server block for your reverse proxy nginx |
| `proxy/make-self-signed-cert.sh` | Creates a self-signed certificate |

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

Copy the long hex string, open `index.html`, find the line starting with
`const HINT_HASH=` near the top of the script, and paste it between the
quotes. Then bump `CACHE` in `sw.js` and rebuild.

Keep in mind the check happens in the browser. Only the hash is in the
page, so the password itself can't be read from the source, but a
determined student who knows JavaScript could bypass the lock. It's a
speed bump for a learning game, not real security.

## Where progress is stored

Each player's progress lives in their own browser's localStorage (key
`port-penguin-v2`). Nothing is sent to the server, there are no accounts,
and progress doesn't follow a player to another browser or device.
Clearing browser data or using a private window starts from task 1.

## Updating the game

1. Edit `index.html`.
2. In `sw.js`, bump `CACHE` (for example `port-penguin-v2`) so installed
   copies pick up the change.
3. Run `docker compose up -d --build`.

## Notes

- Progress is saved in each player's own browser (localStorage). There are
  no accounts and nothing is stored on the server.
- The game loads two fonts from Google Fonts. Offline, it falls back to
  system fonts and still works.

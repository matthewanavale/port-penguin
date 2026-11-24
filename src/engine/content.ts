// File contents of the sandbox file system and of fixed command output.
// Ported from index.html:190-340 at 5e96ce5. The text must not change.

export const WELCOME = `Welcome to Port Penguin, dockhand! 🐧

This terminal is a sandbox. Nothing you type here can harm a real computer,
so experiment freely.

Your logbook lists one task at a time. Finish it and the next one appears.
There are 70 tasks, and they get harder as you go.

Handy keys
  Tab        finish a file or command name for you
  ↑ and ↓    bring back commands you typed before
  help       list every command this terminal knows
  man NAME   explain one command, like: man grep
`;
export const SECRET = `Psst. You found the hidden file.

Captain’s code word: BARNACLE

Files whose names start with a dot are hidden from a plain ls.
Settings files often hide this way, like .bashrc.
`;
export const NOTES = `Shipment schedule
Monday     40 containers of bananas
Wednesday  12 containers of rubber ducks
Friday     1 very suspicious crate
`;
export const CREW = `Marina
Otto
Gus
Pearl
Otto
Barney
Marina
Skip
Coral
Gus
`;
export const SYSLOG = `2026-11-24 06:00:01 INFO  Harbor systems online
2026-11-24 06:02:13 INFO  Crane 1 calibrated
2026-11-24 06:05:47 WARN  Fog detected near pier 3
2026-11-24 06:11:09 ERROR Crane 2 hydraulic pressure low
2026-11-24 06:15:30 INFO  Ship “Saltwater Sally” docked at pier 1
2026-11-24 06:21:52 INFO  Unloading started
2026-11-24 06:24:18 ERROR Container 4471 label unreadable
2026-11-24 06:30:00 INFO  Coffee machine refilled
2026-11-24 06:33:41 WARN  Seagull on conveyor belt
2026-11-24 06:40:05 ERROR Seagull stole a sandwich
2026-11-24 06:52:26 INFO  Unloading complete
2026-11-24 07:01:14 INFO  Ship “Knot Today” approaching
2026-11-24 07:03:58 ERROR Gate B stuck halfway open
2026-11-24 07:10:00 INFO  Shift change
`;
export const CRANELOG = `crane-1 lift ok 18t
crane-2 lift ok 22t
crane-2 pressure low
crane-1 idle
`;
export const MANIFEST = `CRATE MANIFEST (1998)
Crate 0001  Cargo: 300 tins of sardines
Crate 0002  Cargo: one (1) grand piano
Crate 0003  Cargo: classified
`;
export const INDEX = `<!DOCTYPE html>
<html>
  <head><title>Port Penguin</title></head>
  <body><h1>Welcome to Port Penguin</h1></body>
</html>
`;
export const APP = `from flask import Flask

app = Flask(__name__)

@app.route("/")
def home():
    return "Hello from the harbor! 🚢"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
`;
export const BROKEN_APP = `from flask import Flask

app = Flask(__name__)

@app.route("/")
def home():
    return "Status: all piers operational ⚓"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
`;
export const DOCKERFILE = `# Start from a small official Python image
FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install flask
EXPOSE 5000
CMD ["python", "app.py"]
`;
export const BROKEN_DOCKERFILE = `# Harbor status page
FORM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install flask
EXPOSE 5000
CMD ["python", "app.py"]
`;
export const COMPOSE = `# The harbor stack: a web server and a cache
services:
  web:
    image: nginx
    ports:
      - "8081:80"
    depends_on:
      - cache
  cache:
    image: redis
    volumes:
      - cache-data:/data

volumes:
  cache-data:
`;
export const DEPLOY = `#!/bin/bash
# Deploy script for the harbor website
echo "Loading cargo..."
echo "Securing containers..."
echo "🚢 Website deployed. Nice work, dockhand!"
`;
export const HELLO = `
Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
 3. The Docker daemon created a new container from that image which runs the
    executable that produces the output you are currently reading.
 4. The Docker daemon streamed that output to the Docker client, which sent it
    to your terminal.`;
export const PG_ERR = `Error: Database is uninitialized and superuser password is not specified.
       You must specify POSTGRES_PASSWORD to a non-empty value for the
       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".`;
export const NGINX_HTML = `<!DOCTYPE html>
<html>
<head><title>Welcome to nginx!</title></head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and working.</p>
</body>
</html>`;

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

/* ---- Ubuntu 24.04 skel files (D8) and system files (D15) ---- */
// The skel files are the ones in /etc/skel of the ubuntu:24.04 image. A test
// keeps them equal to src/test/ubuntu/home.ts, which the capture checks.
export const SKEL_BASHRC =
  "# ~/.bashrc: executed by bash(1) for non-login shells.\n# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)\n# for examples\n\n# If not running interactively, don't do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n# don't put duplicate lines or lines starting with space in the history.\n# See bash(1) for more options\nHISTCONTROL=ignoreboth\n\n# append to the history file, don't overwrite it\nshopt -s histappend\n\n# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)\nHISTSIZE=1000\nHISTFILESIZE=2000\n\n# check the window size after each command and, if necessary,\n# update the values of LINES and COLUMNS.\nshopt -s checkwinsize\n\n# If set, the pattern \"**\" used in a pathname expansion context will\n# match all files and zero or more directories and subdirectories.\n#shopt -s globstar\n\n# make less more friendly for non-text input files, see lesspipe(1)\n[ -x /usr/bin/lesspipe ] && eval \"$(SHELL=/bin/sh lesspipe)\"\n\n# set variable identifying the chroot you work in (used in the prompt below)\nif [ -z \"${debian_chroot:-}\" ] && [ -r /etc/debian_chroot ]; then\n    debian_chroot=$(cat /etc/debian_chroot)\nfi\n\n# set a fancy prompt (non-color, unless we know we \"want\" color)\ncase \"$TERM\" in\n    xterm-color|*-256color) color_prompt=yes;;\nesac\n\n# uncomment for a colored prompt, if the terminal has the capability; turned\n# off by default to not distract the user: the focus in a terminal window\n# should be on the output of commands, not on the prompt\n#force_color_prompt=yes\n\nif [ -n \"$force_color_prompt\" ]; then\n    if [ -x /usr/bin/tput ] && tput setaf 1 >&/dev/null; then\n\t# We have color support; assume it's compliant with Ecma-48\n\t# (ISO/IEC-6429). (Lack of such support is extremely rare, and such\n\t# a case would tend to support setf rather than setaf.)\n\tcolor_prompt=yes\n    else\n\tcolor_prompt=\n    fi\nfi\n\nif [ \"$color_prompt\" = yes ]; then\n    PS1='${debian_chroot:+($debian_chroot)}\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '\nelse\n    PS1='${debian_chroot:+($debian_chroot)}\\u@\\h:\\w\\$ '\nfi\nunset color_prompt force_color_prompt\n\n# If this is an xterm set the title to user@host:dir\ncase \"$TERM\" in\nxterm*|rxvt*)\n    PS1=\"\\[\\e]0;${debian_chroot:+($debian_chroot)}\\u@\\h: \\w\\a\\]$PS1\"\n    ;;\n*)\n    ;;\nesac\n\n# enable color support of ls and also add handy aliases\nif [ -x /usr/bin/dircolors ]; then\n    test -r ~/.dircolors && eval \"$(dircolors -b ~/.dircolors)\" || eval \"$(dircolors -b)\"\n    alias ls='ls --color=auto'\n    #alias dir='dir --color=auto'\n    #alias vdir='vdir --color=auto'\n\n    alias grep='grep --color=auto'\n    alias fgrep='fgrep --color=auto'\n    alias egrep='egrep --color=auto'\nfi\n\n# colored GCC warnings and errors\n#export GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01'\n\n# some more ls aliases\nalias ll='ls -alF'\nalias la='ls -A'\nalias l='ls -CF'\n\n# Add an \"alert\" alias for long running commands.  Use like so:\n#   sleep 10; alert\nalias alert='notify-send --urgency=low -i \"$([ $? = 0 ] && echo terminal || echo error)\" \"$(history|tail -n1|sed -e '\\''s/^\\s*[0-9]\\+\\s*//;s/[;&|]\\s*alert$//'\\'')\"'\n\n# Alias definitions.\n# You may want to put all your additions into a separate file like\n# ~/.bash_aliases, instead of adding them here directly.\n# See /usr/share/doc/bash-doc/examples in the bash-doc package.\n\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi\n\n# enable programmable completion features (you don't need to enable\n# this, if it's already enabled in /etc/bash.bashrc and /etc/profile\n# sources /etc/bash.bashrc).\nif ! shopt -oq posix; then\n  if [ -f /usr/share/bash-completion/bash_completion ]; then\n    . /usr/share/bash-completion/bash_completion\n  elif [ -f /etc/bash_completion ]; then\n    . /etc/bash_completion\n  fi\nfi\n";
export const SKEL_PROFILE =
  '# ~/.profile: executed by the command interpreter for login shells.\n# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login\n# exists.\n# see /usr/share/doc/bash/examples/startup-files for examples.\n# the files are located in the bash-doc package.\n\n# the default umask is set in /etc/profile; for setting the umask\n# for ssh logins, install and configure the libpam-umask package.\n#umask 022\n\n# if running bash\nif [ -n "$BASH_VERSION" ]; then\n    # include .bashrc if it exists\n    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n\n# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/bin" ] ; then\n    PATH="$HOME/bin:$PATH"\nfi\n\n# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n';
export const SKEL_BASH_LOGOUT =
  '# ~/.bash_logout: executed by bash(1) when login shell exits.\n\n# when leaving the console clear the screen to increase privacy\n\nif [ "$SHLVL" = 1 ]; then\n    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q\nfi\n';
export const OS_RELEASE = `PRETTY_NAME="Ubuntu 24.04.1 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION="24.04.1 LTS (Noble Numbat)"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
HOME_URL="https://www.ubuntu.com/"
SUPPORT_URL="https://help.ubuntu.com/"
BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"
PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"
UBUNTU_CODENAME=noble
LOGO=ubuntu-logo
`;

/** Stand-in files of /usr/bin (D15): the commands of the host table except `hint`. A test keeps this list equal to the table. */
export const USR_BIN: string[] = [
  "[",
  "awk",
  "basename",
  "bash",
  "cat",
  "chmod",
  "clear",
  "cp",
  "crontab",
  "curl",
  "cut",
  "date",
  "df",
  "diff",
  "dircolors",
  "dirname",
  "docker",
  "docker-compose",
  "du",
  "echo",
  "egrep",
  "env",
  "false",
  "fgrep",
  "file",
  "find",
  "free",
  "grep",
  "head",
  "hostname",
  "id",
  "kill",
  "killall",
  "ls",
  "man",
  "md5sum",
  "mkdir",
  "mv",
  "od",
  "paste",
  "pkill",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "rm",
  "rmdir",
  "sed",
  "seq",
  "sh",
  "sha256sum",
  "sleep",
  "sort",
  "stat",
  "tail",
  "tar",
  "tee",
  "test",
  "top",
  "touch",
  "tr",
  "tree",
  "true",
  "uname",
  "uniq",
  "uptime",
  "wc",
  "which",
  "whoami",
  "xargs",
];

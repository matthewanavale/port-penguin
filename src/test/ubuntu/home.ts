// D7, D8, D24: the test home. These are exactly the files that `useradd -m`
// copies from /etc/skel of ubuntu:24.04, plus ~/.inputrc. The capture script
// checks that the image still has the same skel files; the reference test
// builds the simulator's home from this module. Node type stripping runs this
// file, so it has no enums and imports use .ts extensions.

/** One home file: path under /home/cadet, content, and mode. */
export interface HomeFile {
  path: string;
  content: string;
  mode: number;
}

export const SKEL_BASHRC =
  "# ~/.bashrc: executed by bash(1) for non-login shells.\n# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)\n# for examples\n\n# If not running interactively, don't do anything\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\n# don't put duplicate lines or lines starting with space in the history.\n# See bash(1) for more options\nHISTCONTROL=ignoreboth\n\n# append to the history file, don't overwrite it\nshopt -s histappend\n\n# for setting history length see HISTSIZE and HISTFILESIZE in bash(1)\nHISTSIZE=1000\nHISTFILESIZE=2000\n\n# check the window size after each command and, if necessary,\n# update the values of LINES and COLUMNS.\nshopt -s checkwinsize\n\n# If set, the pattern \"**\" used in a pathname expansion context will\n# match all files and zero or more directories and subdirectories.\n#shopt -s globstar\n\n# make less more friendly for non-text input files, see lesspipe(1)\n[ -x /usr/bin/lesspipe ] && eval \"$(SHELL=/bin/sh lesspipe)\"\n\n# set variable identifying the chroot you work in (used in the prompt below)\nif [ -z \"${debian_chroot:-}\" ] && [ -r /etc/debian_chroot ]; then\n    debian_chroot=$(cat /etc/debian_chroot)\nfi\n\n# set a fancy prompt (non-color, unless we know we \"want\" color)\ncase \"$TERM\" in\n    xterm-color|*-256color) color_prompt=yes;;\nesac\n\n# uncomment for a colored prompt, if the terminal has the capability; turned\n# off by default to not distract the user: the focus in a terminal window\n# should be on the output of commands, not on the prompt\n#force_color_prompt=yes\n\nif [ -n \"$force_color_prompt\" ]; then\n    if [ -x /usr/bin/tput ] && tput setaf 1 >&/dev/null; then\n\t# We have color support; assume it's compliant with Ecma-48\n\t# (ISO/IEC-6429). (Lack of such support is extremely rare, and such\n\t# a case would tend to support setf rather than setaf.)\n\tcolor_prompt=yes\n    else\n\tcolor_prompt=\n    fi\nfi\n\nif [ \"$color_prompt\" = yes ]; then\n    PS1='${debian_chroot:+($debian_chroot)}\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '\nelse\n    PS1='${debian_chroot:+($debian_chroot)}\\u@\\h:\\w\\$ '\nfi\nunset color_prompt force_color_prompt\n\n# If this is an xterm set the title to user@host:dir\ncase \"$TERM\" in\nxterm*|rxvt*)\n    PS1=\"\\[\\e]0;${debian_chroot:+($debian_chroot)}\\u@\\h: \\w\\a\\]$PS1\"\n    ;;\n*)\n    ;;\nesac\n\n# enable color support of ls and also add handy aliases\nif [ -x /usr/bin/dircolors ]; then\n    test -r ~/.dircolors && eval \"$(dircolors -b ~/.dircolors)\" || eval \"$(dircolors -b)\"\n    alias ls='ls --color=auto'\n    #alias dir='dir --color=auto'\n    #alias vdir='vdir --color=auto'\n\n    alias grep='grep --color=auto'\n    alias fgrep='fgrep --color=auto'\n    alias egrep='egrep --color=auto'\nfi\n\n# colored GCC warnings and errors\n#export GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01'\n\n# some more ls aliases\nalias ll='ls -alF'\nalias la='ls -A'\nalias l='ls -CF'\n\n# Add an \"alert\" alias for long running commands.  Use like so:\n#   sleep 10; alert\nalias alert='notify-send --urgency=low -i \"$([ $? = 0 ] && echo terminal || echo error)\" \"$(history|tail -n1|sed -e '\\''s/^\\s*[0-9]\\+\\s*//;s/[;&|]\\s*alert$//'\\'')\"'\n\n# Alias definitions.\n# You may want to put all your additions into a separate file like\n# ~/.bash_aliases, instead of adding them here directly.\n# See /usr/share/doc/bash-doc/examples in the bash-doc package.\n\nif [ -f ~/.bash_aliases ]; then\n    . ~/.bash_aliases\nfi\n\n# enable programmable completion features (you don't need to enable\n# this, if it's already enabled in /etc/bash.bashrc and /etc/profile\n# sources /etc/bash.bashrc).\nif ! shopt -oq posix; then\n  if [ -f /usr/share/bash-completion/bash_completion ]; then\n    . /usr/share/bash-completion/bash_completion\n  elif [ -f /etc/bash_completion ]; then\n    . /etc/bash_completion\n  fi\nfi\n";

export const SKEL_PROFILE =
  '# ~/.profile: executed by the command interpreter for login shells.\n# This file is not read by bash(1), if ~/.bash_profile or ~/.bash_login\n# exists.\n# see /usr/share/doc/bash/examples/startup-files for examples.\n# the files are located in the bash-doc package.\n\n# the default umask is set in /etc/profile; for setting the umask\n# for ssh logins, install and configure the libpam-umask package.\n#umask 022\n\n# if running bash\nif [ -n "$BASH_VERSION" ]; then\n    # include .bashrc if it exists\n    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n\n# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/bin" ] ; then\n    PATH="$HOME/bin:$PATH"\nfi\n\n# set PATH so it includes user\'s private bin if it exists\nif [ -d "$HOME/.local/bin" ] ; then\n    PATH="$HOME/.local/bin:$PATH"\nfi\n';

export const SKEL_BASH_LOGOUT =
  '# ~/.bash_logout: executed by bash(1) when login shell exits.\n\n# when leaving the console clear the screen to increase privacy\n\nif [ "$SHLVL" = 1 ]; then\n    [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q\nfi\n';

/** One line: no bracketed paste, so the pty transcript has no escape noise. */
export const INPUTRC = "set enable-bracketed-paste off\n";

/**
 * `dircolors -b` under the capture environment (TERM=dumb) exports an empty
 * LS_COLORS, because the built-in database lists colors per TERM and dumb is
 * not in it. The fixtures hold this value.
 */
export const LS_COLORS = "";

export const HOME_FILES: HomeFile[] = [
  { path: ".bashrc", content: SKEL_BASHRC, mode: 0o644 },
  { path: ".profile", content: SKEL_PROFILE, mode: 0o644 },
  { path: ".bash_logout", content: SKEL_BASH_LOGOUT, mode: 0o644 },
  { path: ".inputrc", content: INPUTRC, mode: 0o644 },
];

/** The environment of the capture container (D7). */
export const CAPTURE_ENV: Record<string, string> = {
  HOME: "/home/cadet",
  USER: "cadet",
  LOGNAME: "cadet",
  SHELL: "/bin/bash",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  TZ: "UTC",
  TERM: "dumb",
  COLUMNS: "80",
};

export const PROMPT_PS1 = "cadet@port-penguin:\\w\\$ ";

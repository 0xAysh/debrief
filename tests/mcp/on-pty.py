"""Runs a command on a pseudo-terminal, as a user at a shell would.

Usage: python3 on-pty.py <answer> <command> [args...]

Types <answer> and Enter once the command prints "Type delete", then prints everything the
terminal showed and exits with the command's exit code. Node has no pty of its own, and
script(1) on macOS rejects Node's socket stdio, so tests use this.
"""

import os
import pty
import sys

answer, command = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
shown, typed = b"", False
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:  # EIO: the command exited and closed the terminal
        break
    if not chunk:
        break
    shown += chunk
    if not typed and b"Type delete" in shown:
        os.write(fd, answer.encode() + b"\n")
        typed = True
sys.stdout.buffer.write(shown)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))

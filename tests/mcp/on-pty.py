"""Runs a command on a pseudo-terminal, as a user at a shell would.

Usage: python3 on-pty.py [--prompt <text>] <answers> <command> [args...]

Types each line of <answers> and Enter the next time the command prints <prompt> (default
"Type delete") after the previous answer, then prints everything the terminal showed and exits
with the command's exit code. A command still running 5 seconds after the last answer is killed
and this exits 124: a terminal's input never ends, so a command that waits for more would hang.
Node has no pty of its own, and script(1) on macOS rejects Node's socket stdio, so tests use this.
"""

import os
import pty
import select
import signal
import sys
import time

args = sys.argv[1:]
prompt = b"Type delete"
if args[0] == "--prompt":
    prompt, args = args[1].encode(), args[2:]
answers, command = args[0].split("\n"), args[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
shown, seen, answered_at = b"", 0, None
while True:
    if answered_at is not None and not answers and time.time() - answered_at > 5:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        sys.stdout.buffer.write(shown + b"\n[on-pty: still running 5 s after the last answer; killed]\n")
        sys.exit(124)
    ready, _, _ = select.select([fd], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:  # EIO: the command exited and closed the terminal
        break
    if not chunk:
        break
    shown += chunk
    at = shown.find(prompt, seen)
    if answers and at >= 0:
        seen = at + len(prompt)
        os.write(fd, answers.pop(0).encode() + b"\n")
        answered_at = time.time()
sys.stdout.buffer.write(shown)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))

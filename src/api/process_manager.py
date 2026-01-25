"""Process Manager for spawning and managing Claude Code sessions.

This module provides functionality to spawn Claude processes with PTY,
stream output to WebSocket clients, and handle stdin injection.
"""

import asyncio
import os
import pty
import signal
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from fastapi import WebSocket


@dataclass
class ManagedProcess:
    """Represents a managed Claude Code process."""

    id: str
    pty_master_fd: int
    pid: int
    cwd: str
    state: str  # "running", "idle", "stopped", "error"
    started_at: datetime
    output_buffer: deque = field(default_factory=lambda: deque(maxlen=1000))
    websocket_clients: set = field(default_factory=set)
    exit_code: Optional[int] = None
    _read_task: Optional[asyncio.Task] = None


class ProcessManager:
    """Manages spawned Claude Code processes."""

    def __init__(self):
        self.processes: dict[str, ManagedProcess] = {}
        self._cleanup_lock = asyncio.Lock()

    async def spawn(
        self,
        cwd: str,
        args: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None
    ) -> ManagedProcess:
        """Spawn a new Claude process with PTY.

        Args:
            cwd: Working directory for the process
            args: Additional arguments to pass to claude command
            env: Additional environment variables

        Returns:
            ManagedProcess instance
        """
        process_id = str(uuid.uuid4())[:8]

        # Prepare command
        cmd_args = ["claude"]
        if args:
            cmd_args.extend(args)

        # Prepare environment
        process_env = os.environ.copy()
        process_env["TERM"] = "xterm-256color"
        process_env["COLORTERM"] = "truecolor"
        if env:
            process_env.update(env)

        # Create pseudo-terminal
        master_fd, slave_fd = pty.openpty()

        # Fork process
        pid = os.fork()

        if pid == 0:
            # Child process
            os.close(master_fd)
            os.setsid()

            # Set up slave as controlling terminal
            os.dup2(slave_fd, 0)  # stdin
            os.dup2(slave_fd, 1)  # stdout
            os.dup2(slave_fd, 2)  # stderr

            if slave_fd > 2:
                os.close(slave_fd)

            # Change to working directory
            os.chdir(cwd)

            # Execute claude
            os.execvpe(cmd_args[0], cmd_args, process_env)
        else:
            # Parent process
            os.close(slave_fd)

            # Set non-blocking mode for master fd
            import fcntl
            flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
            fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

            process = ManagedProcess(
                id=process_id,
                pty_master_fd=master_fd,
                pid=pid,
                cwd=cwd,
                state="running",
                started_at=datetime.now(timezone.utc),
            )

            self.processes[process_id] = process

            # Start background task to read output
            process._read_task = asyncio.create_task(
                self._read_output_loop(process)
            )

            return process

    async def _read_output_loop(self, process: ManagedProcess):
        """Background task to read PTY output and broadcast to clients."""
        loop = asyncio.get_event_loop()

        try:
            while process.state == "running":
                try:
                    # Read from PTY master using asyncio
                    data = await loop.run_in_executor(
                        None,
                        lambda: self._read_pty(process.pty_master_fd)
                    )

                    if data:
                        # Store in buffer
                        timestamp = datetime.now(timezone.utc).isoformat()
                        process.output_buffer.append({
                            "data": data,
                            "timestamp": timestamp
                        })

                        # Broadcast to connected clients
                        await self._broadcast_output(process, data, timestamp)
                    else:
                        # Small delay to prevent busy loop
                        await asyncio.sleep(0.01)

                except OSError as e:
                    if e.errno == 5:  # Input/output error - process closed
                        break
                    raise
                except Exception as e:
                    print(f"[ProcessManager] Read error: {e}")
                    await asyncio.sleep(0.1)

        except asyncio.CancelledError:
            pass
        finally:
            # Check if process has exited
            await self._check_process_exit(process)

    def _read_pty(self, fd: int, size: int = 4096) -> Optional[str]:
        """Read from PTY file descriptor (blocking call for executor)."""
        try:
            data = os.read(fd, size)
            if data:
                return data.decode("utf-8", errors="replace")
        except BlockingIOError:
            pass
        except OSError:
            raise
        return None

    async def _broadcast_output(
        self,
        process: ManagedProcess,
        data: str,
        timestamp: str
    ):
        """Broadcast output to all connected WebSocket clients."""
        if not process.websocket_clients:
            return

        message = {
            "type": "output",
            "stream": "stdout",
            "data": data,
            "timestamp": timestamp
        }

        # Send to all connected clients
        disconnected = set()
        for ws in process.websocket_clients:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.add(ws)

        # Remove disconnected clients
        process.websocket_clients -= disconnected

    async def _check_process_exit(self, process: ManagedProcess):
        """Check if process has exited and update state."""
        try:
            pid, status = os.waitpid(process.pid, os.WNOHANG)
            if pid != 0:
                process.state = "stopped"
                if os.WIFEXITED(status):
                    process.exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    process.exit_code = -os.WTERMSIG(status)

                # Notify clients of state change
                await self._broadcast_state_change(process)
        except ChildProcessError:
            process.state = "stopped"
            await self._broadcast_state_change(process)

    async def _broadcast_state_change(self, process: ManagedProcess):
        """Broadcast state change to all connected clients."""
        message = {
            "type": "state",
            "state": process.state,
            "exit_code": process.exit_code
        }

        disconnected = set()
        for ws in process.websocket_clients:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.add(ws)

        process.websocket_clients -= disconnected

    async def send_stdin(self, process_id: str, text: str, newline: bool = True):
        """Send text to process stdin.

        Args:
            process_id: ID of the process
            text: Text to send
            newline: Whether to append newline
        """
        process = self.processes.get(process_id)
        if not process:
            raise ValueError(f"Process {process_id} not found")

        if process.state != "running":
            raise ValueError(f"Process {process_id} is not running")

        data = text
        if newline and not text.endswith("\n"):
            data += "\n"

        # Write to PTY master
        os.write(process.pty_master_fd, data.encode("utf-8"))

    async def kill(self, process_id: str, force: bool = False):
        """Terminate a process.

        Args:
            process_id: ID of the process
            force: If True, send SIGKILL instead of SIGTERM
        """
        process = self.processes.get(process_id)
        if not process:
            raise ValueError(f"Process {process_id} not found")

        if process.state == "stopped":
            return

        # Cancel read task
        if process._read_task:
            process._read_task.cancel()
            try:
                await process._read_task
            except asyncio.CancelledError:
                pass

        # Send signal
        sig = signal.SIGKILL if force else signal.SIGTERM
        try:
            os.kill(process.pid, sig)
        except ProcessLookupError:
            pass

        # Close PTY
        try:
            os.close(process.pty_master_fd)
        except OSError:
            pass

        # Update state
        process.state = "stopped"
        await self._broadcast_state_change(process)

    async def stream_output(self, process_id: str, websocket: WebSocket):
        """Stream process output to a WebSocket client.

        Args:
            process_id: ID of the process
            websocket: WebSocket connection to stream to
        """
        process = self.processes.get(process_id)
        if not process:
            await websocket.send_json({
                "type": "error",
                "message": f"Process {process_id} not found"
            })
            return

        # Add client to broadcast list
        process.websocket_clients.add(websocket)

        # Send buffered history
        history_lines = [entry["data"] for entry in process.output_buffer]
        if history_lines:
            await websocket.send_json({
                "type": "history",
                "lines": history_lines
            })

        # Send current state
        await websocket.send_json({
            "type": "state",
            "state": process.state,
            "exit_code": process.exit_code
        })

        # Keep connection open and handle messages
        try:
            while True:
                try:
                    data = await websocket.receive_text()
                    # Handle ping/pong
                    import json
                    msg = json.loads(data)
                    if msg.get("type") == "ping":
                        await websocket.send_json({"type": "pong"})
                except Exception:
                    break
        finally:
            process.websocket_clients.discard(websocket)

    def get_process(self, process_id: str) -> Optional[ManagedProcess]:
        """Get a process by ID."""
        return self.processes.get(process_id)

    def list_processes(self) -> list[dict]:
        """List all managed processes."""
        return [
            {
                "id": p.id,
                "cwd": p.cwd,
                "state": p.state,
                "started_at": p.started_at.isoformat(),
                "exit_code": p.exit_code,
                "client_count": len(p.websocket_clients)
            }
            for p in self.processes.values()
        ]

    async def cleanup(self):
        """Clean up all processes on shutdown."""
        async with self._cleanup_lock:
            for process_id in list(self.processes.keys()):
                try:
                    await self.kill(process_id, force=True)
                except Exception as e:
                    print(f"[ProcessManager] Cleanup error for {process_id}: {e}")

            self.processes.clear()


# Global process manager instance
_process_manager: Optional[ProcessManager] = None


def get_process_manager() -> ProcessManager:
    """Get the global ProcessManager instance."""
    global _process_manager
    if _process_manager is None:
        _process_manager = ProcessManager()
    return _process_manager

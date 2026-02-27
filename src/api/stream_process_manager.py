"""Stream Process Manager for spawning Claude CLI processes using the stream-json NDJSON protocol.

This module provides the StreamProcessManager class which manages Claude CLI
subprocesses communicating via the stream-json protocol over asyncio pipes,
as opposed to the PTY-based approach in process_manager.py.
"""

import asyncio
import json
import os
import signal
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from .logging_config import get_logger

logger = get_logger(__name__, namespace='pty')


@dataclass
class ManagedStreamProcess:
    """Represents a managed Claude CLI process using the stream-json protocol."""

    id: str                                          # Short UUID (8 chars)
    pid: int                                         # OS process ID
    cwd: str                                         # Working directory
    session_id: Optional[str]                        # Claude session ID (from init message)
    state: str                                       # "running", "waiting", "stopped", "error"
    started_at: datetime
    process: asyncio.subprocess.Process              # The subprocess
    websocket_clients: set = field(default_factory=set)       # Connected WebSocket clients
    message_callbacks: list = field(default_factory=list)     # Callbacks for NDJSON messages
    exit_callbacks: list = field(default_factory=list)        # Callbacks for process exit
    _reader_task: Optional[asyncio.Task] = None
    _stderr_task: Optional[asyncio.Task] = None
    _heartbeat_task: Optional[asyncio.Task] = None
    _lifecycle_task: Optional[asyncio.Task] = None


class StreamProcessManager:
    """Manages Claude CLI processes using the stream-json NDJSON protocol over asyncio pipes."""

    def __init__(self):
        self.processes: dict[str, ManagedStreamProcess] = {}
        self._cleanup_lock = asyncio.Lock()

    async def spawn(
        self,
        cwd: str,
        resume_session_id: Optional[str] = None,
        fork: bool = False,
    ) -> str:
        """Spawn a new Claude CLI process using stream-json protocol.

        Args:
            cwd: Working directory for the process.
            resume_session_id: If set, resume this Claude session.
            fork: If True, fork the session instead of resuming.

        Returns:
            The process ID (8-char UUID).
        """
        process_id = str(uuid.uuid4())[:8]

        # Build command
        cmd = [
            "claude",
            "--print",
            "--output-format", "stream-json",
            "--input-format", "stream-json",
            "--verbose",
            "--permission-mode", "dontAsk",
        ]
        if resume_session_id:
            cmd.extend(["--resume", resume_session_id])
        if fork:
            cmd.append("--fork-session")

        # Prepare environment: copy current env and remove CLAUDECODE
        # to prevent "cannot launch inside another Claude" error
        env = os.environ.copy()
        env.pop("CLAUDECODE", None)

        logger.info(
            f"Spawning stream process {process_id} in {cwd} "
            f"(resume={resume_session_id}, fork={fork})"
        )

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
        )

        managed = ManagedStreamProcess(
            id=process_id,
            pid=proc.pid,
            cwd=cwd,
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=proc,
        )

        self.processes[process_id] = managed

        # Start background tasks
        managed._reader_task = asyncio.create_task(
            self._read_stdout_loop(managed)
        )
        managed._stderr_task = asyncio.create_task(
            self._read_stderr_loop(managed)
        )
        managed._heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(managed)
        )
        managed._lifecycle_task = asyncio.create_task(
            self._monitor_lifecycle(managed)
        )

        logger.info(f"Stream process {process_id} spawned with PID {proc.pid}")
        return process_id

    async def _read_stdout_loop(self, proc: ManagedStreamProcess):
        """Read NDJSON lines from stdout and dispatch to callbacks/WebSockets."""
        try:
            async for raw_line in proc.process.stdout:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning(
                        f"[{proc.id}] Non-JSON stdout line: {line[:200]}"
                    )
                    continue

                # Classify and handle message
                msg_type = msg.get("type")
                msg_subtype = msg.get("subtype")

                if msg_type == "system" and msg_subtype == "init":
                    session_id = msg.get("session_id")
                    if session_id:
                        proc.session_id = session_id
                        logger.info(
                            f"[{proc.id}] Session ID captured: {session_id}"
                        )

                elif msg_type == "result":
                    proc.state = "waiting"
                    logger.debug(f"[{proc.id}] Turn complete, state -> waiting")

                # Invoke registered message callbacks
                for cb in proc.message_callbacks:
                    try:
                        await cb(proc.id, msg)
                    except Exception as e:
                        logger.error(
                            f"[{proc.id}] Message callback error: {e}"
                        )

                # Forward to WebSocket clients
                await self._broadcast_to_websockets(proc, msg)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[{proc.id}] stdout reader error: {e}")

    async def _read_stderr_loop(self, proc: ManagedStreamProcess):
        """Read and log stderr output from the subprocess."""
        try:
            async for raw_line in proc.process.stderr:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line:
                    logger.debug(f"[{proc.id}] stderr: {line[:500]}")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[{proc.id}] stderr reader error: {e}")

    async def _heartbeat_loop(self, proc: ManagedStreamProcess):
        """Send periodic heartbeat messages to connected WebSocket clients."""
        try:
            while proc.state != "stopped":
                await asyncio.sleep(10)
                if proc.state == "stopped":
                    break
                heartbeat = {
                    "type": "heartbeat",
                    "process_id": proc.id,
                }
                await self._broadcast_to_websockets(proc, heartbeat)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"[{proc.id}] Heartbeat error: {e}")

    async def _monitor_lifecycle(self, proc: ManagedStreamProcess):
        """Wait for process exit, then clean up tasks and notify clients."""
        try:
            await proc.process.wait()
        except asyncio.CancelledError:
            return

        exit_code = proc.process.returncode
        proc.state = "stopped"
        logger.info(f"[{proc.id}] Process exited with code {exit_code}")

        # Cancel background tasks
        for task in (proc._reader_task, proc._stderr_task, proc._heartbeat_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        # Notify WebSocket clients
        exit_msg = {
            "type": "process_exited",
            "process_id": proc.id,
            "exit_code": exit_code,
        }
        await self._broadcast_to_websockets(proc, exit_msg)

        # Invoke exit callbacks
        for cb in proc.exit_callbacks:
            try:
                await cb(proc.id, exit_code)
            except Exception as e:
                logger.error(f"[{proc.id}] Exit callback error: {e}")

    async def send_message(self, process_id: str, text: str) -> None:
        """Send a user message to the Claude process via stdin.

        Args:
            process_id: The managed process ID.
            text: The user message text.

        Raises:
            ValueError: If the process is not found or not accepting input.
        """
        proc = self.processes.get(process_id)
        if not proc:
            raise ValueError(f"Process {process_id} not found")
        if proc.state == "stopped":
            raise ValueError(f"Process {process_id} is stopped")

        msg = {
            "type": "user",
            "message": {"role": "user", "content": text},
        }
        payload = json.dumps(msg) + "\n"

        logger.debug(f"[{process_id}] Sending message ({len(text)} chars)")
        proc.process.stdin.write(payload.encode("utf-8"))
        await proc.process.stdin.drain()
        proc.state = "running"

    async def release(self, process_id: str) -> None:
        """Release a process by closing its stdin pipe.

        This signals Claude to finish gracefully without killing it,
        allowing the session to be resumed from a terminal.

        Args:
            process_id: The managed process ID.

        Raises:
            ValueError: If the process is not found.
        """
        proc = self.processes.get(process_id)
        if not proc:
            raise ValueError(f"Process {process_id} not found")
        if proc.state == "stopped":
            return

        logger.info(f"[{process_id}] Releasing process (closing stdin)")

        try:
            proc.process.stdin.close()
            await proc.process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Already closed

    async def kill(self, process_id: str) -> None:
        """Terminate a managed process.

        Sends SIGTERM first, waits up to 5 seconds, then SIGKILL if needed.

        Args:
            process_id: The managed process ID.

        Raises:
            ValueError: If the process is not found.
        """
        proc = self.processes.get(process_id)
        if not proc:
            raise ValueError(f"Process {process_id} not found")

        if proc.state == "stopped":
            return

        logger.info(f"[{process_id}] Terminating process (PID {proc.pid})")

        # SIGTERM
        try:
            proc.process.terminate()
        except ProcessLookupError:
            pass

        # Wait up to 5 seconds for graceful exit
        try:
            await asyncio.wait_for(proc.process.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning(
                f"[{process_id}] Process did not exit after SIGTERM, sending SIGKILL"
            )
            try:
                proc.process.kill()
                await proc.process.wait()
            except ProcessLookupError:
                pass

        # Cancel all background tasks
        for task in (
            proc._reader_task,
            proc._stderr_task,
            proc._heartbeat_task,
            proc._lifecycle_task,
        ):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        proc.state = "stopped"
        logger.info(f"[{process_id}] Process terminated")

    def list_processes(self) -> list[dict]:
        """Return a summary list of all managed processes."""
        return [
            {
                "id": p.id,
                "session_id": p.session_id,
                "cwd": p.cwd,
                "pid": p.pid,
                "state": p.state,
                "started_at": p.started_at.isoformat(),
            }
            for p in self.processes.values()
        ]

    def get_process(self, process_id: str) -> Optional[dict]:
        """Return process info dict or None if not found."""
        proc = self.processes.get(process_id)
        if not proc:
            return None
        return {
            "id": proc.id,
            "session_id": proc.session_id,
            "cwd": proc.cwd,
            "pid": proc.pid,
            "state": proc.state,
            "started_at": proc.started_at.isoformat(),
        }

    async def add_websocket_client(self, process_id: str, ws: Any) -> None:
        """Register a WebSocket client for process output streaming.

        Args:
            process_id: The managed process ID.
            ws: FastAPI WebSocket instance.

        Raises:
            ValueError: If the process is not found.
        """
        proc = self.processes.get(process_id)
        if not proc:
            raise ValueError(f"Process {process_id} not found")
        proc.websocket_clients.add(ws)
        logger.debug(
            f"[{process_id}] WebSocket client added, "
            f"total: {len(proc.websocket_clients)}"
        )

    async def remove_websocket_client(self, process_id: str, ws: Any) -> None:
        """Unregister a WebSocket client.

        Args:
            process_id: The managed process ID.
            ws: FastAPI WebSocket instance.
        """
        proc = self.processes.get(process_id)
        if not proc:
            return
        proc.websocket_clients.discard(ws)
        logger.debug(
            f"[{process_id}] WebSocket client removed, "
            f"remaining: {len(proc.websocket_clients)}"
        )

    async def _broadcast_to_websockets(
        self, proc: ManagedStreamProcess, msg: dict
    ):
        """Send a JSON message to all connected WebSocket clients.

        Disconnected clients are automatically removed.
        """
        if not proc.websocket_clients:
            return

        disconnected: set = set()
        for ws in proc.websocket_clients:
            try:
                await ws.send_json(msg)
            except Exception:
                disconnected.add(ws)

        if disconnected:
            proc.websocket_clients -= disconnected
            logger.debug(
                f"[{proc.id}] Removed {len(disconnected)} disconnected "
                f"WebSocket client(s)"
            )

    async def cleanup(self):
        """Kill all managed processes. Called on server shutdown."""
        async with self._cleanup_lock:
            for process_id in list(self.processes.keys()):
                try:
                    await self.kill(process_id)
                except Exception as e:
                    logger.error(f"Cleanup error for {process_id}: {e}")

            self.processes.clear()
            logger.info("StreamProcessManager cleanup complete")


# Singleton instance
_stream_process_manager: Optional[StreamProcessManager] = None


def get_stream_process_manager() -> StreamProcessManager:
    """Get the global StreamProcessManager singleton."""
    global _stream_process_manager
    if _stream_process_manager is None:
        _stream_process_manager = StreamProcessManager()
    return _stream_process_manager

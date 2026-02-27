"""REST API routes for stream-based process management.

This module provides endpoints for spawning, controlling, and
monitoring Claude Code processes via the StreamProcessManager,
which uses subprocess pipes instead of PTY or SDK.
"""

import asyncio
import os
import signal
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from ..session_detector import get_sessions
from ..stream_process_manager import get_stream_process_manager

router = APIRouter(prefix="/api", tags=["stream_processes"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class SpawnRequest(BaseModel):
    cwd: str
    resume: Optional[str] = None

    @field_validator("cwd")
    @classmethod
    def validate_cwd(cls, v: str) -> str:
        p = Path(v).expanduser().resolve()
        if not p.exists():
            raise ValueError(f"Directory does not exist: {v}")
        if not p.is_dir():
            raise ValueError(f"Path is not a directory: {v}")
        return str(p)


class TakeoverRequest(BaseModel):
    fork: bool = False


class MessageRequest(BaseModel):
    text: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/sdk-mode")
async def get_sdk_mode():
    """Return stream/SDK mode status."""
    return {"mode": "sdk", "sdk_available": True}


@router.post("/process/spawn")
async def spawn_process(request: SpawnRequest):
    """Spawn a new Claude Code subprocess.

    Args:
        request: SpawnRequest with cwd and optional resume session ID.

    Returns:
        Process metadata including id, cwd, state, started_at.
    """
    manager = get_stream_process_manager()
    try:
        process_id = await manager.spawn(
            cwd=request.cwd,
            resume_session_id=request.resume,
        )
        proc_info = manager.get_process(process_id)
        return {
            "process_id": proc_info["id"],
            "cwd": proc_info["cwd"],
            "state": proc_info["state"],
            "started_at": proc_info["started_at"],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/spawn")
async def spawn_process_compat(request: SpawnRequest):
    """Spawn a new Claude Code subprocess (compat endpoint for frontend).

    Same as /process/spawn but at /spawn path for backwards compatibility.
    """
    return await spawn_process(request)


@router.get("/processes")
async def list_processes():
    """List all managed stream processes."""
    manager = get_stream_process_manager()
    return manager.list_processes()


@router.post("/process/{process_id}/message")
async def send_message(process_id: str, request: MessageRequest):
    """Send a user message to a running stream process.

    Args:
        process_id: ID of the target process.
        request: MessageRequest with text to send.

    Returns:
        Acknowledgement.
    """
    manager = get_stream_process_manager()
    try:
        await manager.send_message(process_id, request.text)
        return {"status": "sent"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process/{process_id}/kill")
async def kill_process(process_id: str):
    """Kill a managed stream process.

    Args:
        process_id: ID of the process to terminate.

    Returns:
        Success flag.
    """
    manager = get_stream_process_manager()
    try:
        await manager.kill(process_id)
        return {"success": True}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/session/{session_id}/takeover")
async def takeover_session(session_id: str, request: TakeoverRequest = TakeoverRequest()):
    """Take over an existing terminal-based Claude session.

    1. Find the session by ID.
    2. Kill the owning terminal process (if alive).
    3. Spawn a new stream subprocess with --resume pointing at the session.

    Args:
        session_id: The Claude session ID to take over.
        request: Optional TakeoverRequest (fork flag).

    Returns:
        New process_id, session_id, and cwd.
    """
    # 1. Find the session
    sessions = get_sessions()
    session = next((s for s in sessions if s["sessionId"] == session_id), None)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    cwd = session.get("cwd", "/tmp")
    pid = session.get("pid")
    state = session.get("state", "")

    # 2. Kill the terminal process (skip if already dead)
    if pid and state != "dead":
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass  # Already dead
        except PermissionError:
            raise HTTPException(
                status_code=403,
                detail=f"Permission denied killing PID {pid}",
            )

        # Poll for death: 100ms x 100 = 10s max
        for _ in range(100):
            try:
                os.kill(pid, 0)  # Check if still alive
                await asyncio.sleep(0.1)
            except ProcessLookupError:
                break  # Dead
        else:
            raise HTTPException(
                status_code=504,
                detail="Session process did not exit in time",
            )

    # 3. Spawn subprocess with --resume
    manager = get_stream_process_manager()
    try:
        process_id = await manager.spawn(
            cwd=cwd,
            resume_session_id=session_id,
            fork=request.fork,
        )
        return {
            "process_id": process_id,
            "session_id": session_id,
            "cwd": cwd,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process/{process_id}/release")
async def release_process(process_id: str):
    """Release a taken-over session back to the terminal.

    Closes stdin to signal Claude to exit, then returns the session ID
    so the terminal can resume it.

    Args:
        process_id: ID of the stream process to release.

    Returns:
        released flag and session_id.
    """
    manager = get_stream_process_manager()
    proc = manager.get_process(process_id)
    if not proc:
        raise HTTPException(status_code=404, detail=f"Process {process_id} not found")

    # Grab session_id before tearing down
    session_id = proc.get("session_id")

    # Close stdin pipe to signal Claude to finish gracefully
    await manager.release(process_id)

    return {"released": True, "session_id": session_id}

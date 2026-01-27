"""REST API routes for process management.

This module provides endpoints for spawning, controlling, and
monitoring Claude Code processes.
"""

import os
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from ..process_manager import get_process_manager
from ..sdk_session_manager import get_sdk_session_manager, SDK_AVAILABLE

# Feature flag for SDK sessions (default: True to use SDK)
USE_SDK_SESSIONS = os.getenv("USE_SDK_SESSIONS", "true").lower() == "true"


router = APIRouter(prefix="/api", tags=["processes"])


class SpawnRequest(BaseModel):
    """Request model for spawning a new process."""

    cwd: str
    args: Optional[list[str]] = None

    @field_validator("cwd")
    @classmethod
    def validate_cwd(cls, v: str) -> str:
        """Validate that cwd is a valid directory."""
        path = Path(v).expanduser().resolve()
        if not path.exists():
            raise ValueError(f"Directory does not exist: {v}")
        if not path.is_dir():
            raise ValueError(f"Path is not a directory: {v}")
        return str(path)


class SpawnResponse(BaseModel):
    """Response model for spawn endpoint."""

    process_id: str
    cwd: str
    state: str
    started_at: str


class StdinRequest(BaseModel):
    """Request model for sending stdin to a process."""

    text: str
    newline: bool = True


class MessageRequest(BaseModel):
    """Request model for sending a message via SDK."""

    text: str


class ToolApprovalRequest(BaseModel):
    """Request model for approving/denying tool use."""

    tool_use_id: str
    approved: bool


class PermissionModeRequest(BaseModel):
    """Request model for setting permission mode."""

    mode: Literal['normal', 'acceptEdits', 'bypassPermissions', 'planMode']


class CompactRequest(BaseModel):
    """Request model for compacting conversation."""

    instructions: Optional[str] = None


class ProcessInfo(BaseModel):
    """Process information model."""

    id: str
    cwd: str
    state: str
    started_at: str
    exit_code: Optional[int] = None
    client_count: int


@router.post("/spawn", response_model=SpawnResponse)
async def spawn_process(request: SpawnRequest):
    """Spawn a new Claude Code session.

    Uses SDK mode if USE_SDK_SESSIONS=true, otherwise PTY mode.

    Args:
        request: SpawnRequest with cwd and optional args

    Returns:
        Process information including ID and state
    """
    # Use SDK if enabled and available
    if USE_SDK_SESSIONS and SDK_AVAILABLE:
        sdk_manager = get_sdk_session_manager()
        try:
            session = await sdk_manager.create_session(cwd=request.cwd)
            return SpawnResponse(
                process_id=session.id,
                cwd=session.cwd,
                state=session.state,
                started_at=session.started_at.isoformat()
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Fall back to PTY mode
    manager = get_process_manager()

    try:
        process = await manager.spawn(
            cwd=request.cwd,
            args=request.args
        )

        return SpawnResponse(
            process_id=process.id,
            cwd=process.cwd,
            state=process.state,
            started_at=process.started_at.isoformat()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process/{process_id}/stdin")
async def send_stdin(process_id: str, request: StdinRequest):
    """Send text to process stdin.

    Args:
        process_id: ID of the target process
        request: StdinRequest with text to send

    Returns:
        Success status
    """
    manager = get_process_manager()

    try:
        await manager.send_stdin(
            process_id=process_id,
            text=request.text,
            newline=request.newline
        )
        return {"success": True, "process_id": process_id}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process/{process_id}/kill")
async def kill_process(process_id: str, force: bool = False):
    """Terminate a process (PTY or SDK session).

    Args:
        process_id: ID of the process to terminate
        force: If True, send SIGKILL instead of SIGTERM

    Returns:
        Success status
    """
    # Try PTY manager first
    pty_manager = get_process_manager()
    pty_process = pty_manager.get_process(process_id)

    if pty_process:
        try:
            await pty_manager.kill(process_id=process_id, force=force)
            return {"success": True, "process_id": process_id}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Try SDK manager if available
    if SDK_AVAILABLE:
        sdk_manager = get_sdk_session_manager()
        if sdk_manager.get_session(process_id):
            try:
                await sdk_manager.close_session(process_id)
                return {"success": True, "process_id": process_id}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

    # Process not found in either manager
    raise HTTPException(status_code=404, detail=f"Process {process_id} not found")


@router.get("/processes", response_model=list[ProcessInfo])
async def list_processes():
    """List all managed processes (PTY and SDK sessions).

    Returns:
        List of ProcessInfo for all managed processes
    """
    all_processes = []

    # Get PTY processes
    pty_manager = get_process_manager()
    all_processes.extend(pty_manager.list_processes())

    # Get SDK sessions if available
    if SDK_AVAILABLE:
        sdk_manager = get_sdk_session_manager()
        for session_info in sdk_manager.list_sessions():
            all_processes.append({
                "id": session_info["id"],
                "cwd": session_info["cwd"],
                "state": session_info["state"],
                "started_at": session_info["started_at"],
                "exit_code": None,
                "client_count": session_info["client_count"],
            })

    return [ProcessInfo(**p) for p in all_processes]


@router.get("/process/{process_id}", response_model=ProcessInfo)
async def get_process(process_id: str):
    """Get information about a specific process.

    Args:
        process_id: ID of the process

    Returns:
        ProcessInfo for the requested process
    """
    manager = get_process_manager()
    process = manager.get_process(process_id)

    if not process:
        raise HTTPException(status_code=404, detail=f"Process {process_id} not found")

    return ProcessInfo(
        id=process.id,
        cwd=process.cwd,
        state=process.state,
        started_at=process.started_at.isoformat(),
        exit_code=process.exit_code,
        client_count=len(process.websocket_clients)
    )


@router.get("/recent-directories")
async def get_recent_directories():
    """Get recently used directories for quick spawn selection.

    Returns directories from Claude's projects folder.
    """
    claude_projects = Path.home() / ".claude" / "projects"
    recent_dirs = []

    if claude_projects.exists():
        # Get directories sorted by modification time
        dirs = []
        for entry in claude_projects.iterdir():
            if entry.is_dir() and not entry.name.startswith("."):
                try:
                    # The directory name encodes the project path
                    # e.g., "-Users-nathan-project" -> "/Users/nathan/project"
                    decoded_path = "/" + entry.name.replace("-", "/")
                    if Path(decoded_path).exists():
                        dirs.append({
                            "path": decoded_path,
                            "name": Path(decoded_path).name,
                            "mtime": entry.stat().st_mtime
                        })
                except Exception:
                    pass

        # Sort by modification time (most recent first)
        dirs.sort(key=lambda x: x["mtime"], reverse=True)
        recent_dirs = [{"path": d["path"], "name": d["name"]} for d in dirs[:20]]

    return {"directories": recent_dirs}


# ============================================================================
# SDK-based endpoints (claude-agent-sdk)
# ============================================================================


@router.get("/sdk-mode")
async def get_sdk_mode():
    """Get current SDK mode status.

    Returns:
        SDK mode configuration and availability
    """
    return {
        "enabled": USE_SDK_SESSIONS,
        "sdk_available": SDK_AVAILABLE,
        "mode": "sdk" if (USE_SDK_SESSIONS and SDK_AVAILABLE) else "pty"
    }


@router.post("/process/{process_id}/message")
async def send_message(process_id: str, request: MessageRequest):
    """Send a message to an SDK session.

    Args:
        process_id: ID of the SDK session
        request: MessageRequest with text to send

    Returns:
        Success status
    """
    if not SDK_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="claude-agent-sdk not installed"
        )

    manager = get_sdk_session_manager()

    try:
        await manager.send_message(process_id, request.text)
        return {"status": "sent", "process_id": process_id}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process/{process_id}/tool-approval")
async def approve_tool(process_id: str, request: ToolApprovalRequest):
    """Approve or deny a pending tool use request.

    Args:
        process_id: ID of the SDK session
        request: ToolApprovalRequest with tool_use_id and approval decision

    Returns:
        Resolution status
    """
    if not SDK_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="claude-agent-sdk not installed"
        )

    manager = get_sdk_session_manager()

    try:
        await manager.approve_tool(
            process_id,
            request.tool_use_id,
            request.approved
        )
        return {
            "status": "resolved",
            "process_id": process_id,
            "tool_use_id": request.tool_use_id,
            "approved": request.approved
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/spawn-sdk")
async def spawn_sdk_session(request: SpawnRequest):
    """Spawn a new Claude SDK session.

    This uses claude-agent-sdk for direct programmatic interaction
    instead of PTY-based process spawning.

    Args:
        request: SpawnRequest with cwd and optional args

    Returns:
        Session information including ID and state
    """
    if not SDK_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="claude-agent-sdk not installed"
        )

    manager = get_sdk_session_manager()

    try:
        session = await manager.create_session(cwd=request.cwd)

        return SpawnResponse(
            process_id=session.id,
            cwd=session.cwd,
            state=session.state,
            started_at=session.started_at.isoformat()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process/{process_id}/permission-mode")
async def set_permission_mode(process_id: str, request: PermissionModeRequest):
    """Set the permission mode for an SDK session.

    Args:
        process_id: ID of the SDK session
        request: PermissionModeRequest with mode to set

    Returns:
        Success status with new mode
    """
    if not SDK_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="claude-agent-sdk not installed"
        )

    manager = get_sdk_session_manager()
    session = manager.get_session(process_id)

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {process_id} not found")

    session.permission_mode = request.mode
    return {"success": True, "process_id": process_id, "mode": request.mode}


@router.post("/process/{process_id}/compact")
async def compact_conversation(process_id: str, request: CompactRequest):
    """Trigger conversation compaction for an SDK session.

    Args:
        process_id: ID of the SDK session
        request: CompactRequest with optional instructions

    Returns:
        Success status
    """
    if not SDK_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="claude-agent-sdk not installed"
        )

    manager = get_sdk_session_manager()
    session = manager.get_session(process_id)

    if not session:
        raise HTTPException(status_code=404, detail=f"Session {process_id} not found")

    # Build compact command
    compact_cmd = "/compact"
    if request.instructions:
        compact_cmd += f" {request.instructions}"

    # Send through SDK session
    try:
        await manager.send_message(process_id, compact_cmd)
        return {
            "success": True,
            "process_id": process_id,
            "message": "Compaction initiated"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

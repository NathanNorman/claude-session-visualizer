"""REST API routes for process management.

This module provides endpoints for spawning, controlling, and
monitoring Claude Code processes.
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from ..process_manager import get_process_manager


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

    Args:
        request: SpawnRequest with cwd and optional args

    Returns:
        Process information including ID and state
    """
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
    """Terminate a process.

    Args:
        process_id: ID of the process to terminate
        force: If True, send SIGKILL instead of SIGTERM

    Returns:
        Success status
    """
    manager = get_process_manager()

    try:
        await manager.kill(process_id=process_id, force=force)
        return {"success": True, "process_id": process_id}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/processes", response_model=list[ProcessInfo])
async def list_processes():
    """List all managed processes.

    Returns:
        List of ProcessInfo for all managed processes
    """
    manager = get_process_manager()
    processes = manager.list_processes()

    return [ProcessInfo(**p) for p in processes]


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

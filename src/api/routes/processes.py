"""REST API routes for directory browsing utilities.

These routes support the spawn dialog's folder browser and recent
directory suggestions. Process management is handled by stream_processes.py.
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api", tags=["processes"])


@router.get("/list-directory")
async def list_directory(path: Optional[str] = None):
    """List directories in a given path for the web-based folder browser.

    Args:
        path: Directory path to list (defaults to $HOME)

    Returns:
        List of directories and parent path for navigation
    """
    # Default to home directory
    if not path:
        path = str(Path.home())

    target = Path(path).expanduser().resolve()

    # Security: Validate path exists and is a directory
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path does not exist: {path}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {path}")

    # Get parent path for navigation (None if at root)
    parent = str(target.parent) if target.parent != target else None

    directories = []
    try:
        for entry in sorted(target.iterdir(), key=lambda x: x.name.lower()):
            # Only include directories, skip hidden files unless explicitly navigating there
            if entry.is_dir():
                try:
                    # Check if readable (will raise PermissionError if not)
                    list(entry.iterdir())[:1]
                    accessible = True
                except PermissionError:
                    accessible = False

                directories.append({
                    "name": entry.name,
                    "path": str(entry),
                    "accessible": accessible
                })
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied: {path}")

    return {
        "current": str(target),
        "parent": parent,
        "directories": directories
    }


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

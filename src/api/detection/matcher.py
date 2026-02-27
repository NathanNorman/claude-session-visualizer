"""Session matching algorithms for Claude sessions.

This module provides functions for:
- Matching processes to sessions by various strategies
- Finding sessions for a given working directory
- Process-to-session matching with start time comparison
"""

import time
from datetime import datetime
from pathlib import Path

from ..config import CLAUDE_PROJECTS_DIR
from .jsonl_parser import extract_jsonl_metadata, cwd_to_project_slug


def get_sessions_for_cwd(cwd: str, activity_tracker: callable = None) -> list[dict]:
    """Find all JSONL session files for a given working directory.

    Returns list of metadata dicts for all sessions with matching internal cwd.
    """
    if not cwd or not CLAUDE_PROJECTS_DIR.exists():
        return []

    # Convert cwd to project slug (e.g., /Users/nathan/foo → -Users-nathan-foo)
    project_slug = cwd_to_project_slug(cwd)
    project_dir = CLAUDE_PROJECTS_DIR / project_slug

    if not project_dir.exists():
        return []

    # Find all non-agent JSONL files whose cwd matches
    sessions = []
    for jsonl_file in project_dir.glob("*.jsonl"):
        # Skip agent files
        if jsonl_file.stem.startswith('agent-'):
            continue
        try:
            metadata = extract_jsonl_metadata(jsonl_file, activity_tracker)
            # Only include if the session's cwd matches
            if metadata.get('cwd') == cwd:
                metadata['file_mtime'] = jsonl_file.stat().st_mtime
                sessions.append(metadata)
        except Exception:
            continue

    return sessions


def match_process_to_session(proc: dict, available_sessions: list[dict]) -> dict | None:
    """Match a process to its session by file modification time.

    When a user runs /continue, they create a new session but the process keeps
    running with the same PID. We must match to the most recently modified session
    file, not the one with the closest start time to the process.

    Args:
        proc: Process dict with process info
        available_sessions: List of session metadata dicts with 'file_mtime'

    Returns:
        Best matching session metadata (most recently modified), or None
    """
    if not available_sessions:
        return None

    # Always prefer the most recently modified session file
    # This handles /continue correctly - new session, same process
    available_sessions.sort(key=lambda x: x.get('file_mtime', 0), reverse=True)
    return available_sessions[0]

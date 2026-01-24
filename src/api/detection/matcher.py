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
    """Match a process to its session by comparing start times.

    Args:
        proc: Process dict with 'start_time' key
        available_sessions: List of session metadata dicts with 'startTimestamp'

    Returns:
        Best matching session metadata, or None
    """
    if not available_sessions:
        return None

    proc_start = proc.get('start_time')
    if not proc_start:
        # Fall back to most recent if we can't get process start time
        available_sessions.sort(key=lambda x: x.get('file_mtime', 0), reverse=True)
        return available_sessions[0]

    # Find session with start time closest to process start time
    best_match = None
    best_diff = float('inf')

    for session in available_sessions:
        session_start_str = session.get('startTimestamp')
        if not session_start_str:
            continue

        try:
            # Parse ISO timestamp
            session_start = datetime.fromisoformat(
                session_start_str.replace('Z', '+00:00')
            ).timestamp()

            diff = abs(session_start - proc_start)
            if diff < best_diff:
                best_diff = diff
                best_match = session
        except (ValueError, AttributeError):
            continue

    # If no timestamp match, fall back to most recent
    if not best_match and available_sessions:
        available_sessions.sort(key=lambda x: x.get('file_mtime', 0), reverse=True)
        best_match = available_sessions[0]

    return best_match

"""Session management routes."""

import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..session_detector import (
    get_sessions,
    get_all_sessions,
    get_dead_sessions,
    search_dead_sessions,
    extract_conversation,
    extract_metrics,
    extract_session_timeline,
    get_activity_periods,
    get_activity_timestamp,
    get_all_active_state_files,
    extract_detailed_tool_history,
    CLAUDE_PROJECTS_DIR,
)
from ..git_tracker import (
    get_git_status,
    get_recent_commits,
    get_diff_stats,
    find_related_pr,
)
from ..analytics import get_activity_summaries as db_get_activity_summaries

router = APIRouter(prefix="/api", tags=["sessions"])


class KillRequest(BaseModel):
    pid: int


class SendMessageRequest(BaseModel):
    message: str
    submit: bool = True


def write_to_tty(tty: str, message: str, submit: bool = True) -> dict:
    """Send text to a terminal session using AppleScript System Events.

    This activates Warp and uses System Events to type text and optionally press Enter.

    LIMITATION: This sends to the currently visible Warp tab. The user must have
    the target session in the foreground. Warp doesn't expose an API to select
    specific tabs by TTY.

    Args:
        tty: TTY identifier (e.g., 's000' or '/dev/ttys000') - for logging only
        message: Text to send to the session
        submit: If True, press Enter after typing the text

    Returns:
        dict with success status
    """
    import subprocess

    # Normalize TTY format (for logging)
    if tty.startswith('s') and tty[1:].isdigit():
        tty_match = f"/dev/tty{tty}"
    elif not tty.startswith('/dev/'):
        tty_match = f"/dev/{tty}"
    else:
        tty_match = tty

    # Escape message for AppleScript (escape backslashes and quotes)
    escaped_message = message.replace('\\', '\\\\').replace('"', '\\"')

    # Build keystroke command - type text then optionally press Enter
    if submit:
        keystroke_cmd = f'''
            keystroke "{escaped_message}"
            keystroke return
        '''
    else:
        keystroke_cmd = f'keystroke "{escaped_message}"'

    # Use System Events to send keystrokes to Warp
    # Note: Warp's process name is "stable", not "Warp"
    script = f'''
tell application "Warp"
    activate
end tell
delay 0.15
tell application "System Events"
    tell process "stable"
        {keystroke_cmd}
    end tell
end tell
return "sent"
'''

    result = subprocess.run(
        ['osascript', '-e', script],
        capture_output=True,
        text=True
    )

    output = result.stdout.strip()
    if result.returncode == 0:
        return {"success": True, "tty_path": tty_match, "note": "Sent to frontmost Warp tab"}
    else:
        raise RuntimeError(f"AppleScript error: {result.stderr or output}")


@router.get("/sessions")
async def api_get_sessions(include_summaries: bool = False):
    """Get sessions, optionally with AI summaries."""
    # Import here to avoid circular imports
    from ..server import _summary_cache, SUMMARY_TTL, generate_activity_summary, BEDROCK_TOKEN_FILE
    import asyncio

    sessions = get_sessions()

    if include_summaries and BEDROCK_TOKEN_FILE.exists():
        for session in sessions:
            cached = _summary_cache.get(session['sessionId'])
            if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
                session['aiSummary'] = cached['summary']

    # Generate activity summaries for sessions with new activity
    for session in sessions:
        if session.get('isGastown'):
            continue
        session_id = session.get('sessionId')
        if session_id:
            activities = session.get('recentActivity', [])
            if activities:
                cwd = session.get('cwd', '')
                asyncio.create_task(generate_activity_summary(session_id, activities, cwd))

    # Always include activity summaries
    for session in sessions:
        session_id = session.get('sessionId')
        if session_id:
            session['activitySummaries'] = db_get_activity_summaries(session_id)

    return {
        "sessions": sessions,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.get("/sessions/changed")
def check_sessions_changed(since: float = 0):
    """Fast dirty-check endpoint to determine if session data has changed."""
    get_all_active_state_files()
    current = get_activity_timestamp()
    return {
        "changed": current > since,
        "timestamp": current
    }


@router.get("/sessions/graveyard")
def get_graveyard_sessions(hours: int = 24):
    """Get dead (ended) sessions for the graveyard view."""
    sessions = get_dead_sessions(max_age_hours=hours)
    gastown = [s for s in sessions if s.get('isGastown')]
    regular = [s for s in sessions if not s.get('isGastown')]

    return {
        "sessions": sessions,
        "gastown": gastown,
        "regular": regular,
        "count": len(sessions),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.get("/sessions/graveyard/search")
def search_graveyard_sessions(q: str, hours: int = 168, content: bool = False):
    """Search dead sessions by text query."""
    if not q or not q.strip():
        return {
            "sessions": [],
            "gastown": [],
            "regular": [],
            "count": 0,
            "query": q,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

    sessions = search_dead_sessions(query=q.strip(), max_age_hours=hours, search_content=content)
    gastown = [s for s in sessions if s.get('isGastown')]
    regular = [s for s in sessions if not s.get('isGastown')]

    return {
        "sessions": sessions,
        "gastown": gastown,
        "regular": regular,
        "count": len(sessions),
        "query": q,
        "searchedContent": content,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.get("/timeline/sessions")
def get_timeline_sessions(hours: int = 24):
    """Get all sessions with activity in the last N hours."""
    sessions = get_all_sessions(max_age_hours=hours)
    running_sessions = {s['sessionId'] for s in get_sessions()}

    for session in sessions:
        session['isRunning'] = session['sessionId'] in running_sessions
        session['state'] = 'active' if session['isRunning'] else 'closed'

    return {
        "sessions": sessions,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.get("/session/{session_id}/timeline")
def get_session_timeline(session_id: str, bucket_minutes: int = 5):
    """Get activity timeline for a specific session."""
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    jsonl_file = None
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        candidate = project_dir / f"{session_id}.jsonl"
        if candidate.exists():
            jsonl_file = candidate
            break

    if not jsonl_file:
        raise HTTPException(404, f"Session {session_id} not found")

    events = extract_session_timeline(jsonl_file)
    periods = get_activity_periods(events, bucket_minutes=bucket_minutes)

    return {
        "sessionId": session_id,
        "activityPeriods": periods,
        "eventCount": len(events),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.post("/kill")
def kill_session(request: KillRequest):
    """Kill a Claude session by PID."""
    try:
        os.kill(request.pid, signal.SIGTERM)
        return {"success": True, "pid": request.pid}
    except ProcessLookupError:
        raise HTTPException(404, f"Process {request.pid} not found")
    except PermissionError:
        raise HTTPException(403, f"Cannot kill process {request.pid}")


@router.get("/session/{session_id}/jsonl-path")
def get_jsonl_path(session_id: str):
    """Get the path to a session's JSONL file."""
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            return {"path": str(jsonl)}

    raise HTTPException(404, "Session file not found")


@router.get("/session/{session_id}/conversation")
def get_conversation(session_id: str, limit: int = 0, follow_continuations: bool = True):
    """Get conversation for a session."""
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            messages = extract_conversation(jsonl, limit, follow_continuations)
            has_continuation = any(msg.get('isContinuation') for msg in messages)
            return {
                "messages": messages,
                "hasContinuation": has_continuation
            }

    raise HTTPException(404, "Session not found")


@router.get("/session/{session_id}/tools")
def get_tool_history(session_id: str, limit: int = 50):
    """Get detailed tool history for a session with inputs, outputs, and error status.

    Returns list of tools with:
    - name: tool name (Bash, Read, etc.)
    - input: tool input parameters
    - output: tool output/result
    - is_error: whether the tool failed
    - timestamp: when the tool was used
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            tools = extract_detailed_tool_history(jsonl, limit)
            return {
                "tools": tools,
                "count": len(tools)
            }

    raise HTTPException(404, "Session not found")


class DeleteMessageRequest(BaseModel):
    """Request to delete a message from conversation."""
    line_number: int


@router.delete("/session/{session_id}/message")
def delete_message(session_id: str, request: DeleteMessageRequest):
    """Delete a specific message from a session's JSONL file.

    Only removes the specified line, preserving all other content.
    Returns the new total token count after deletion.
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            try:
                # Read all lines
                with open(jsonl, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()

                # Validate line number
                if request.line_number < 0 or request.line_number >= len(lines):
                    raise HTTPException(400, f"Invalid line number {request.line_number}. File has {len(lines)} lines.")

                # Remove the specified line
                lines.pop(request.line_number)

                # Write back to file
                with open(jsonl, 'w', encoding='utf-8') as f:
                    f.writelines(lines)

                # Re-extract conversation to get new token count
                messages = extract_conversation(jsonl, limit=0, follow_continuations=False)
                new_total_tokens = sum(msg.get('tokens', 0) for msg in messages)

                return {
                    "success": True,
                    "deleted_line_number": request.line_number,
                    "remaining_lines": len(lines),
                    "new_total_tokens": new_total_tokens
                }

            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(500, f"Failed to delete message: {str(e)}")

    raise HTTPException(404, "Session not found")


@router.get("/session/{session_id}/metrics")
def get_session_metrics(session_id: str):
    """Get performance metrics for a session."""
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            metrics = extract_metrics(jsonl)
            return metrics

    raise HTTPException(404, "Session not found")


@router.get("/sessions/{session_id}/git")
def get_session_git_info(session_id: str):
    """Get detailed git information for a session."""
    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, "Session not found")

    cwd = session.get('cwd', '')
    if not cwd:
        raise HTTPException(400, "Session has no working directory")

    status = get_git_status(cwd)
    commits = get_recent_commits(cwd, limit=5)
    diff_stats = get_diff_stats(cwd) if status and status.has_uncommitted else None
    pr = find_related_pr(cwd, status.branch) if status else None

    return {
        'status': status.__dict__ if status else None,
        'commits': [c.__dict__ for c in commits],
        'diff_stats': diff_stats,
        'pr': pr
    }


@router.get("/sessions/{session_id}/activity-summaries")
def api_get_activity_summaries(session_id: str):
    """Get the AI activity summary log for a session."""
    entries = db_get_activity_summaries(session_id)
    return {
        'sessionId': session_id,
        'entries': entries
    }


@router.post("/session/{session_id}/send")
def send_message_to_session(session_id: str, request: SendMessageRequest):
    """Send a message to a Claude session via TTY.

    This writes directly to the session's TTY device to inject text
    into the terminal input.
    """
    # Validate message length
    if len(request.message) > 10240:  # 10KB limit
        raise HTTPException(400, "Message too long (max 10KB)")

    # Find the session
    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, f"Session {session_id} not found")

    # Check if session is alive
    state = session.get('state', 'unknown')
    if state == 'dead':
        raise HTTPException(400, "Session is not running")

    # Get TTY
    tty = session.get('tty')
    if not tty:
        raise HTTPException(400, "Session has no TTY")

    # Write to TTY
    try:
        result = write_to_tty(tty, request.message, request.submit)
        return {
            "success": True,
            "sessionId": session_id,
            "tty": result["tty_path"],
            "submitted": request.submit
        }
    except FileNotFoundError as e:
        raise HTTPException(400, str(e))
    except PermissionError:
        raise HTTPException(500, f"Permission denied writing to TTY: {tty}")
    except Exception as e:
        raise HTTPException(500, f"Failed to write to TTY: {str(e)}")

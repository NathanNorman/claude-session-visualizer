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

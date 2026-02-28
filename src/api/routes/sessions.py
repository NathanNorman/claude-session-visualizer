"""Session management routes."""

import asyncio
import logging
import os
import signal
import time
import tempfile
import base64
import binascii
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List

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
    extract_jsonl_metadata,
    extract_first_user_message,
    CLAUDE_PROJECTS_DIR,
)
from ..detection.activity import extract_event_markers
from ..git_tracker import (
    get_git_status,
    get_recent_commits,
    get_diff_stats,
    find_related_pr,
    get_commits_in_range,
)
from ..analytics import get_activity_summaries as db_get_activity_summaries, get_focus_summary, save_focus_summary
from ..services.summary import generate_focus_summary, get_summary_cache, SUMMARY_TTL, generate_activity_summary, BEDROCK_TOKEN_FILE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["sessions"])


def find_session_jsonl(session_id: str) -> Path:
    """Find the JSONL file for a session by searching project directories.

    Raises HTTPException(404) if not found.
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            return jsonl

    raise HTTPException(404, f"Session {session_id} not found")

# Dedup guard and concurrency limit for background summary generation
_inflight_summaries: set[str] = set()
_summary_semaphore = asyncio.Semaphore(3)


async def _generate_summary_background(session_id: str, jsonl_path: str):
    """Generate a focus summary for a dead session in the background."""
    try:
        async with _summary_semaphore:
            first_msg = extract_first_user_message(Path(jsonl_path))
            if not first_msg:
                return
            summary = await generate_focus_summary(session_id, first_user_message=first_msg)
            if summary:
                save_focus_summary(session_id, summary)
                logger.info(f"Graveyard summary for {session_id[:8]}: {summary}")
    except Exception as e:
        logger.warning(f"Background summary generation failed for {session_id}: {e}")
    finally:
        _inflight_summaries.discard(session_id)


class KillRequest(BaseModel):
    pid: int



class ImageUploadRequest(BaseModel):
    data: str  # Base64 encoded image data
    filename: Optional[str] = None  # Optional original filename
    mime_type: Optional[str] = None  # e.g., "image/png"


# Temp directory for uploaded images
IMAGE_UPLOAD_DIR = Path(tempfile.gettempdir()) / "claude-session-images"
IMAGE_UPLOAD_DIR.mkdir(exist_ok=True)



@router.get("/sessions")
async def api_get_sessions(include_summaries: bool = False):
    """Get sessions, optionally with AI summaries."""
    sessions = get_sessions()

    if include_summaries and BEDROCK_TOKEN_FILE.exists():
        for session in sessions:
            cached = get_summary_cache().get(session['sessionId'])
            if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
                session['aiSummary'] = cached['summary']

    # Generate activity summaries for sessions with new activity
    for session in sessions:
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
async def get_graveyard_sessions(hours: int = 24):
    """Get dead (ended) sessions for the graveyard view."""
    sessions = get_dead_sessions(max_age_hours=hours)

    # Attach stored summaries from database
    for session in sessions:
        session_id = session.get('sessionId')
        if session_id:
            session['focusSummary'] = get_focus_summary(session_id)
            session['activitySummaries'] = db_get_activity_summaries(session_id)

    # Trigger background generation for sessions without summaries
    for session in sessions:
        sid = session.get('sessionId')
        if sid and not session.get('focusSummary') and sid not in _inflight_summaries:
            jsonl_path = session.get('jsonlPath')
            if jsonl_path:
                _inflight_summaries.add(sid)
                asyncio.create_task(_generate_summary_background(sid, jsonl_path))

    return {
        "sessions": sessions,
        "count": len(sessions),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.get("/sessions/graveyard/search")
def search_graveyard_sessions(q: str, hours: int = 168, content: bool = False):
    """Search dead sessions by text query."""
    if not q or not q.strip():
        return {
            "sessions": [],
            "count": 0,
            "query": q,
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

    sessions = search_dead_sessions(query=q.strip(), max_age_hours=hours, search_content=content)

    # Attach stored summaries from database
    for session in sessions:
        session_id = session.get('sessionId')
        if session_id:
            session['focusSummary'] = get_focus_summary(session_id)
            session['activitySummaries'] = db_get_activity_summaries(session_id)

    return {
        "sessions": sessions,
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
    """Get activity timeline for a specific session.

    Returns:
        - activityPeriods: Time buckets showing when session was active
        - eventMarkers: Discrete point events (commits, compactions, agent spawns, tests)
    """
    jsonl_file = find_session_jsonl(session_id)

    events = extract_session_timeline(jsonl_file)
    periods = get_activity_periods(events, bucket_minutes=bucket_minutes)

    # Extract discrete event markers for timeline visualization
    session_info = extract_jsonl_metadata(jsonl_file)
    event_markers = extract_event_markers(events, session_info)

    # Add git commit markers if session has a working directory
    cwd = session_info.get('cwd', '')
    if cwd and events:
        # Get session time range from events
        try:
            timestamps: list[str] = [e['timestamp'] for e in events if e.get('timestamp')]
            if timestamps:
                start_ts = datetime.fromisoformat(min(timestamps).replace('Z', '+00:00'))
                end_ts = datetime.fromisoformat(max(timestamps).replace('Z', '+00:00'))

                # Get commits in this time range
                commits = get_commits_in_range(cwd, start_ts, end_ts)
                for commit in commits:
                    event_markers.append({
                        'type': 'commit',
                        'icon': '\U0001F4DD',  # 📝
                        'timestamp': commit.timestamp,
                        'label': f'Commit: {commit.message[:40]}',
                        'sha': commit.short_sha
                    })
        except (ValueError, AttributeError):
            pass  # Skip commit markers if timestamp parsing fails

    # Sort markers by timestamp
    event_markers.sort(key=lambda m: m.get('timestamp', ''))

    return {
        "sessionId": session_id,
        "activityPeriods": periods,
        "eventMarkers": event_markers,
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
    jsonl = find_session_jsonl(session_id)
    return {"path": str(jsonl)}


@router.get("/session/{session_id}/conversation")
def get_conversation(session_id: str, limit: int = 0, follow_continuations: bool = True):
    """Get conversation for a session."""
    jsonl = find_session_jsonl(session_id)
    messages = extract_conversation(jsonl, limit, follow_continuations)
    has_continuation = any(msg.get('isContinuation') for msg in messages)
    return {
        "messages": messages,
        "hasContinuation": has_continuation
    }


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
    jsonl = find_session_jsonl(session_id)
    tools = extract_detailed_tool_history(jsonl, limit)
    return {
        "tools": tools,
        "count": len(tools)
    }


class DeleteMessageRequest(BaseModel):
    """Request to delete a message from conversation."""
    line_number: int


@router.delete("/session/{session_id}/message")
def delete_message(session_id: str, request: DeleteMessageRequest):
    """Delete a specific message from a session's JSONL file.

    Only removes the specified line, preserving all other content.
    Returns the new total token count after deletion.
    """
    jsonl = find_session_jsonl(session_id)
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


@router.get("/session/{session_id}/metrics")
def get_session_metrics(session_id: str):
    """Get performance metrics for a session."""
    jsonl = find_session_jsonl(session_id)
    metrics = extract_metrics(jsonl)
    return metrics


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




@router.post("/upload-image")
def upload_image(request: ImageUploadRequest):
    """Upload a base64 encoded image and save to temp directory.

    Returns the file path that can be included in messages to Claude.
    """
    try:
        # Decode base64 data
        # Handle data URLs (e.g., "data:image/png;base64,...")
        data = request.data
        if data.startswith('data:'):
            # Extract the base64 part after the comma
            data = data.split(',', 1)[1]

        image_data = base64.b64decode(data)

        # Determine file extension from mime type or filename
        ext = '.png'  # Default
        if request.mime_type:
            mime_to_ext = {
                'image/png': '.png',
                'image/jpeg': '.jpg',
                'image/jpg': '.jpg',
                'image/gif': '.gif',
                'image/webp': '.webp',
                'image/bmp': '.bmp',
            }
            ext = mime_to_ext.get(request.mime_type, '.png')
        elif request.filename:
            ext = Path(request.filename).suffix or '.png'

        # Generate unique filename
        unique_id = uuid.uuid4().hex[:12]
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"image_{timestamp}_{unique_id}{ext}"
        filepath = IMAGE_UPLOAD_DIR / filename

        # Write the file
        with open(filepath, 'wb') as f:
            f.write(image_data)

        return {
            "success": True,
            "path": str(filepath),
            "filename": filename,
            "size": len(image_data)
        }

    except binascii.Error as e:
        raise HTTPException(400, f"Invalid base64 data: {str(e)}")
    except Exception as e:
        raise HTTPException(500, f"Failed to save image: {str(e)}")

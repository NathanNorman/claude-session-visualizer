"""Session sharing routes."""

import hashlib
import os
import time
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException

from ..session_detector import get_sessions

router = APIRouter(prefix="/api", tags=["sharing"])

# Shared sessions store: token -> {session, created_at, expires_at, created_by}
_shared_sessions: dict[str, dict] = {}


def generate_share_token(session_id: str) -> str:
    """Generate a unique share token."""
    data = f"{session_id}:{time.time()}:{os.urandom(8).hex()}"
    return hashlib.sha256(data.encode()).hexdigest()[:16]


def generate_markdown_export(session: dict) -> str:
    """Generate markdown export of session."""
    activities = session.get('recentActivity', [])
    activity_list = "\n".join(f"- {a}" for a in activities) if activities else "- No recent activity"

    ai_summary = session.get('aiSummary', '')
    summary_section = f"\n## AI Summary\n{ai_summary}\n" if ai_summary else ""

    return f"""# Session: {session['slug']}

**Project:** {session.get('cwd', 'Unknown')}
**Branch:** {session.get('gitBranch', 'Unknown')}
**Context:** {session.get('contextTokens', 0):,} tokens
**Status:** {session.get('state', 'unknown')}
{summary_section}
## Recent Activity
{activity_list}

---
*Exported from Claude Session Visualizer on {datetime.now().strftime('%B %d, %Y at %I:%M %p')}*
"""


@router.post("/sessions/{session_id}/share")
def create_share_link(session_id: str, expires_days: int = 7):
    """Create a shareable link for a session."""
    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, "Session not found")

    token = generate_share_token(session_id)
    expires_at = datetime.now(timezone.utc) + timedelta(days=expires_days)

    shared_data = {
        'session': session,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'expires_at': expires_at.isoformat(),
        'created_by': os.environ.get('USER', 'unknown'),
    }

    _shared_sessions[token] = shared_data

    return {
        'token': token,
        'url': f"/shared/{token}",
        'expires_at': expires_at.isoformat()
    }


@router.get("/shared/{token}")
def get_shared_session(token: str):
    """Get a shared session by token."""
    shared = _shared_sessions.get(token)

    if not shared:
        raise HTTPException(404, "Shared session not found or expired")

    expires_at = datetime.fromisoformat(shared['expires_at'])
    if datetime.now(timezone.utc) > expires_at:
        del _shared_sessions[token]
        raise HTTPException(410, "Shared session has expired")

    return shared


@router.post("/sessions/{session_id}/export")
def export_session_markdown(session_id: str):
    """Export session as markdown."""
    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, "Session not found")

    markdown = generate_markdown_export(session)
    return {"markdown": markdown, "filename": f"{session['slug']}.md"}

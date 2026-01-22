from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
from pathlib import Path
import subprocess
import time
import signal
import os
import json
import uuid
import hashlib
from typing import Optional
import asyncio
from .session_detector import (
    get_sessions,
    extract_conversation,
    extract_metrics,
    extract_session_timeline,
    get_activity_periods,
    CLAUDE_PROJECTS_DIR
)
from .git_tracker import (
    get_git_status,
    get_recent_commits,
    get_diff_stats,
    find_related_pr
)
from .analytics import (
    init_database,
    record_session_snapshot,
    get_analytics,
    get_session_history
)
from .tunnel_manager import get_tunnel_manager

# Feature 15: AI Summary via Toast Bedrock Proxy
import httpx

BEDROCK_PROXY_URL = "https://llm-proxy.build.eng.toasttab.com/bedrock"
BEDROCK_TOKEN_FILE = Path.home() / ".config" / "toast-bedrock-proxy" / "token"
HAIKU_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


def get_bedrock_token() -> str | None:
    """Read JWT token from toast-bedrock-proxy config."""
    try:
        if BEDROCK_TOKEN_FILE.exists():
            token_data = json.loads(BEDROCK_TOKEN_FILE.read_text())
            return token_data.get("access_token")
    except Exception as e:
        print(f"Failed to read bedrock token: {e}")
    return None


app = FastAPI(title="Claude Session Visualizer")

# Initialize database on startup
init_database()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Templates directory
TEMPLATES_DIR = Path.home() / ".claude" / "templates"
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

# Feature 15: Summary cache
_summary_cache: dict[str, dict] = {}  # sessionId -> {summary, timestamp}
SUMMARY_TTL = 300  # 5 minutes

# Feature 16: Shared sessions store
_shared_sessions: dict[str, dict] = {}  # token -> {session, created_at, expires_at, created_by}



class FocusRequest(BaseModel):
    search_terms: list[str]


def focus_iterm():
    """Bring iTerm2 to foreground."""
    subprocess.run(['osascript', '-e', 'tell application "iTerm2" to activate'], capture_output=True)
    time.sleep(0.2)


class FocusByTtyRequest(BaseModel):
    tty: str  # e.g., "s006"


class KillRequest(BaseModel):
    pid: int


class Template(BaseModel):
    name: str
    description: str
    icon: str = "📝"
    config: dict


def find_iterm_tab_by_tty(tty: str) -> dict:
    """Find iTerm2 tab by TTY and select it."""
    # iTerm2 exposes tty for each session via AppleScript
    result = subprocess.run([
        'osascript', '-e', f'''
tell application "iTerm2"
    activate
    set targetTty to "{tty}"
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                if tty of s contains targetTty then
                    select t
                    select s
                    return "found:" & (name of s)
                end if
            end repeat
        end repeat
    end repeat
    return "notfound"
end tell
'''], capture_output=True, text=True)

    output = result.stdout.strip()
    if output.startswith("found:"):
        return {"found": True, "name": output[6:], "tty": tty}
    return {"found": False, "tty": tty}


@app.post("/api/focus")
def focus_tab(request: FocusRequest):
    """Focus tab by keywords (fallback for non-TTY matching)."""
    return {"found": False, "message": "Use /api/focus-tty for iTerm2"}


@app.post("/api/focus-tty")
def focus_tab_by_tty(request: FocusByTtyRequest):
    """Find and focus iTerm2 tab by TTY - fast and reliable."""
    tty = request.tty
    if not tty:
        raise HTTPException(400, "No TTY provided")

    # Convert tty format if needed (s006 -> /dev/ttys006)
    if tty.startswith('s'):
        tty = f"/dev/ttys{tty[1:].zfill(3)}"
    elif not tty.startswith('/dev/'):
        tty = f"/dev/{tty}"

    result = find_iterm_tab_by_tty(tty)
    return result

@app.get("/api/sessions")
def api_get_sessions(include_summaries: bool = False):
    """Get sessions, optionally with AI summaries."""
    sessions = get_sessions()

    if include_summaries and BEDROCK_TOKEN_FILE.exists():
        # Add summaries to sessions that have them cached
        for session in sessions:
            cached = _summary_cache.get(session['sessionId'])
            if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
                session['aiSummary'] = cached['summary']

    return {
        "sessions": sessions,
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@app.get("/api/session/{session_id}/timeline")
def get_session_timeline(session_id: str, bucket_minutes: int = 5):
    """Get activity timeline for a specific session.

    Args:
        session_id: Session UUID
        bucket_minutes: Size of activity buckets in minutes (default: 5)

    Returns:
        Activity periods as list of {start, end, state}
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    # Search for session file
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

    # Extract timeline
    events = extract_session_timeline(jsonl_file)
    periods = get_activity_periods(events, bucket_minutes=bucket_minutes)

    return {
        "sessionId": session_id,
        "activityPeriods": periods,
        "eventCount": len(events),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@app.post("/api/kill")
def kill_session(request: KillRequest):
    """Kill a Claude session by PID."""
    try:
        os.kill(request.pid, signal.SIGTERM)
        return {"success": True, "pid": request.pid}
    except ProcessLookupError:
        raise HTTPException(404, f"Process {request.pid} not found")
    except PermissionError:
        raise HTTPException(403, f"Cannot kill process {request.pid}")


@app.get("/api/session/{session_id}/jsonl-path")
def get_jsonl_path(session_id: str):
    """Get the path to a session's JSONL file."""
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    # Search for the file
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            return {"path": str(jsonl)}

    raise HTTPException(404, "Session file not found")


@app.get("/api/session/{session_id}/conversation")
def get_conversation(session_id: str, limit: int = 20):
    """Get recent conversation for a session."""
    if not CLAUDE_PROJECTS_DIR.exists():
        raise HTTPException(404, "Claude projects directory not found")

    # Find JSONL file
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue
        jsonl = project_dir / f"{session_id}.jsonl"
        if jsonl.exists():
            messages = extract_conversation(jsonl, limit)
            return {"messages": messages}

    raise HTTPException(404, "Session not found")


@app.get("/api/session/{session_id}/metrics")
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


@app.get("/api/sessions/{session_id}/git")
def get_session_git_info(session_id: str):
    """Get detailed git information for a session.

    Returns git status, recent commits, diff stats, and related PR.

    Args:
        session_id: Session UUID

    Returns:
        Dictionary with status, commits, diff_stats, and pr information
    """
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


# Feature 17: Multi-Machine Support endpoints
class MachineRequest(BaseModel):
    name: str
    host: str
    ssh_key: Optional[str] = None
    auto_reconnect: bool = True


@app.get("/api/machines")
def list_machines():
    """List all configured remote machines with their connection status."""
    manager = get_tunnel_manager()
    return {
        "machines": manager.list_machines(),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@app.post("/api/machines")
def add_machine(request: MachineRequest):
    """Add and connect to a remote machine."""
    manager = get_tunnel_manager()
    result = manager.add_machine(
        name=request.name,
        host=request.host,
        ssh_key=request.ssh_key,
        auto_reconnect=request.auto_reconnect
    )

    if 'error' in result:
        raise HTTPException(400, result['error'])

    return result


@app.delete("/api/machines/{name}")
def remove_machine(name: str):
    """Disconnect and remove a remote machine."""
    manager = get_tunnel_manager()
    result = manager.remove_machine(name)

    if 'error' in result:
        raise HTTPException(404, result['error'])

    return result


@app.post("/api/machines/{name}/reconnect")
def reconnect_machine(name: str):
    """Reconnect to a remote machine."""
    manager = get_tunnel_manager()
    result = manager.reconnect_machine(name)

    if 'error' in result:
        raise HTTPException(400, result['error'])

    return result


@app.post("/api/machines/test")
def test_machine_connection(host: str, ssh_key: Optional[str] = None):
    """Test SSH connection to a host without persisting."""
    manager = get_tunnel_manager()
    return manager.test_connection(host, ssh_key)


@app.get("/api/sessions/all")
def get_all_sessions_multi_machine(include_summaries: bool = False):
    """Get sessions from all machines (local + remote).

    Returns:
        Dict with 'local' sessions and 'remote' sessions by machine name.
    """
    # Local sessions
    local_sessions = get_sessions()

    if include_summaries and BEDROCK_TOKEN_FILE.exists():
        for session in local_sessions:
            cached = _summary_cache.get(session['sessionId'])
            if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
                session['aiSummary'] = cached['summary']

    # Add machine info to local sessions
    import socket as sock
    local_hostname = sock.gethostname()
    for session in local_sessions:
        session['machine'] = 'local'
        session['machineHostname'] = local_hostname

    # Remote sessions
    manager = get_tunnel_manager()
    remote_sessions = manager.get_all_sessions()

    # Count totals
    local_active = sum(1 for s in local_sessions if s.get('state') == 'active')
    local_waiting = len(local_sessions) - local_active

    remote_totals = {}
    for name, data in remote_sessions.items():
        if 'error' not in data:
            sessions = data.get('sessions', [])
            active = sum(1 for s in sessions if s.get('state') == 'active')
            remote_totals[name] = {'active': active, 'waiting': len(sessions) - active}
        else:
            remote_totals[name] = {'error': data['error']}

    return {
        "local": {
            "sessions": local_sessions,
            "hostname": local_hostname,
            "totals": {"active": local_active, "waiting": local_waiting}
        },
        "remote": remote_sessions,
        "remoteTotals": remote_totals,
        "machineCount": 1 + len([r for r in remote_sessions.values() if 'error' not in r]),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


# Feature 15: AI Summary endpoints
async def generate_session_summary(session_id: str, activities: list[str], cwd: str) -> str:
    """Generate a human-readable summary of session activity."""

    # Check cache
    cached = _summary_cache.get(session_id)
    if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
        return cached['summary']

    # Get JWT token
    token = get_bedrock_token()
    if not token:
        return "AI summaries not available (run toastApiKeyHelper to refresh token)"

    # Build prompt
    activity_text = "\n".join(f"- {a}" for a in activities[-20:]) if activities else "- No recent activity"
    prompt = f"""Based on this Claude Code session activity, write a ONE sentence summary of what the user is working on. Be specific and actionable.

Working directory: {cwd}

Recent activity:
{activity_text}

Summary (one sentence, no quotes):"""

    try:
        # Call Toast Bedrock Proxy directly
        response = httpx.post(
            f"{BEDROCK_PROXY_URL}/model/{HAIKU_MODEL_ID}/invoke",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 100,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        summary = data["content"][0]["text"].strip()

        # Cache result
        _summary_cache[session_id] = {
            'summary': summary,
            'timestamp': time.time()
        }

        return summary
    except Exception as e:
        return f"Summary unavailable: {str(e)}"


@app.post("/api/sessions/{session_id}/summary")
async def get_session_summary(session_id: str, force_refresh: bool = False):
    """Get or generate AI summary for a session."""
    if force_refresh:
        _summary_cache.pop(session_id, None)

    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, "Session not found")

    summary = await generate_session_summary(
        session_id,
        session.get('recentActivity', []),
        session.get('cwd', '')
    )

    return {"sessionId": session_id, "summary": summary}


@app.post("/api/sessions/refresh-all-summaries")
async def refresh_all_summaries():
    """Refresh AI summaries for all non-gastown sessions that have new activity."""
    sessions = get_sessions()

    refreshed = []
    skipped = []
    errors = []

    for session in sessions:
        session_id = session.get('sessionId')
        if not session_id:
            continue

        # Skip gastown sessions
        if session.get('isGastown'):
            skipped.append({'sessionId': session_id, 'reason': 'gastown'})
            continue

        # Check if session has activity since last summary
        last_activity = session.get('lastActivity', '')
        cached = _summary_cache.get(session_id)

        if cached and last_activity:
            try:
                # Parse lastActivity ISO timestamp to Unix time
                activity_time = datetime.fromisoformat(
                    last_activity.replace('Z', '+00:00')
                ).timestamp()

                # If no new activity since last summary, skip but include cached summary
                if activity_time <= cached['timestamp']:
                    skipped.append({
                        'sessionId': session_id,
                        'reason': 'no_new_activity',
                        'summary': cached['summary']  # Include cached summary for frontend
                    })
                    continue
            except (ValueError, TypeError):
                pass  # If parsing fails, refresh anyway

        # Refresh the summary
        try:
            _summary_cache.pop(session_id, None)  # Force refresh
            summary = await generate_session_summary(
                session_id,
                session.get('recentActivity', []),
                session.get('cwd', '')
            )
            refreshed.append({'sessionId': session_id, 'summary': summary})
        except Exception as e:
            errors.append({'sessionId': session_id, 'error': str(e)})

    return {
        'refreshed': len(refreshed),
        'skipped': len(skipped),
        'errors': len(errors),
        'details': {
            'refreshed': refreshed,
            'skipped': skipped,
            'errors': errors
        }
    }


# Feature 16: Session Sharing endpoints
def generate_share_token(session_id: str) -> str:
    """Generate a unique share token."""
    data = f"{session_id}:{time.time()}:{os.urandom(8).hex()}"
    return hashlib.sha256(data.encode()).hexdigest()[:16]


@app.post("/api/sessions/{session_id}/share")
def create_share_link(session_id: str, expires_days: int = 7):
    """Create a shareable link for a session."""
    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, "Session not found")

    token = generate_share_token(session_id)
    expires_at = datetime.now(timezone.utc) + timedelta(days=expires_days)

    # Capture current state
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


@app.get("/api/shared/{token}")
def get_shared_session(token: str):
    """Get a shared session by token."""
    shared = _shared_sessions.get(token)

    if not shared:
        raise HTTPException(404, "Shared session not found or expired")

    # Check expiration
    expires_at = datetime.fromisoformat(shared['expires_at'])
    if datetime.now(timezone.utc) > expires_at:
        del _shared_sessions[token]
        raise HTTPException(410, "Shared session has expired")

    return shared


@app.post("/api/sessions/{session_id}/export")
def export_session_markdown(session_id: str):
    """Export session as markdown."""
    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        raise HTTPException(404, "Session not found")

    markdown = generate_markdown_export(session)
    return {"markdown": markdown, "filename": f"{session['slug']}.md"}


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


# Template endpoints
@app.get("/api/templates")
def list_templates():
    """List all saved templates."""
    templates = []
    for f in TEMPLATES_DIR.glob("*.json"):
        try:
            with open(f) as fp:
                templates.append(json.load(fp))
        except Exception as e:
            print(f"Error loading template {f}: {e}")
    return {"templates": templates}


@app.post("/api/templates")
def create_template(template: Template):
    """Create a new template."""
    template_id = str(uuid.uuid4())
    template_data = {
        "id": template_id,
        "name": template.name,
        "description": template.description,
        "icon": template.icon,
        "config": template.config,
        "created": datetime.now(timezone.utc).isoformat(),
        "updated": datetime.now(timezone.utc).isoformat()
    }

    with open(TEMPLATES_DIR / f"{template_id}.json", "w") as f:
        json.dump(template_data, f, indent=2)

    return template_data


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: str):
    """Delete a template."""
    path = TEMPLATES_DIR / f"{template_id}.json"
    if path.exists():
        path.unlink()
        return {"deleted": True}
    raise HTTPException(404, "Template not found")


@app.post("/api/templates/{template_id}/use")
def use_template(template_id: str, request: dict):
    """Start a new session from a template."""
    path = TEMPLATES_DIR / f"{template_id}.json"
    if not path.exists():
        raise HTTPException(404, "Template not found")

    with open(path) as f:
        template = json.load(f)

    # Return template data for client to use
    return {
        "template": template,
        "config": template.get("config", {})
    }


# Analytics endpoints
@app.get("/api/analytics")
def get_analytics_endpoint(period: str = 'week'):
    """Get analytics for the specified period.

    Args:
        period: One of 'day', 'week', 'month', 'year'

    Returns:
        Analytics data with totals, trends, and breakdowns
    """
    return get_analytics(period)


@app.get("/api/history")
def get_history(page: int = 1, per_page: int = 20, repo: str = None):
    """Get paginated session history.

    Args:
        page: Page number (1-indexed)
        per_page: Sessions per page
        repo: Optional repository filter

    Returns:
        Paginated list of sessions with metadata
    """
    return get_session_history(page, per_page, repo)


# Background task to record snapshots
_recording_task = None

async def record_snapshots_background():
    """Background task that records session snapshots every minute."""
    while True:
        try:
            sessions = get_sessions()
            for session in sessions:
                record_session_snapshot(session)
        except Exception as e:
            print(f"Error recording snapshots: {e}")
        await asyncio.sleep(60)  # Record every minute


@app.on_event("startup")
async def startup_event():
    """Start background recording task on app startup."""
    global _recording_task
    _recording_task = asyncio.create_task(record_snapshots_background())

    # Feature 17: Start tunnel manager and connect to saved machines
    manager = get_tunnel_manager()
    manager.connect_all()
    manager.start_monitor(interval=30)


@app.on_event("shutdown")
async def shutdown_event():
    """Cancel background task on shutdown."""
    global _recording_task
    if _recording_task:
        _recording_task.cancel()

    # Feature 17: Cleanup tunnel manager
    manager = get_tunnel_manager()
    manager.stop_monitor()
    manager.disconnect_all()


frontend_dir = Path(__file__).parent.parent / "frontend"

@app.get("/")
def serve_index():
    return FileResponse(frontend_dir / "index.html")


@app.get("/shared/{token}")
def serve_shared_page(token: str):
    """Serve the shared session view page."""
    shared_html = frontend_dir / "shared.html"
    if shared_html.exists():
        return FileResponse(shared_html)
    # Fallback to index if shared.html doesn't exist
    return FileResponse(frontend_dir / "index.html")


@app.get("/{filename:path}")
def serve_static(filename: str):
    file_path = frontend_dir / filename
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    return FileResponse(frontend_dir / "index.html")

"""Main FastAPI server for Claude Session Visualizer.

This module initializes the FastAPI application, registers routes,
and manages background tasks for session monitoring.
"""

import asyncio
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .session_detector import get_sessions
from .analytics import (
    init_database,
    record_session_snapshot,
    get_activity_summaries as db_get_activity_summaries,
)
from .tunnel_manager import get_tunnel_manager
from .websocket import ConnectionManager, compute_sessions_hash
from .services.summary import (
    generate_activity_summary,
    generate_session_summary,
    get_bedrock_token,
    get_summary_cache,
    BEDROCK_TOKEN_FILE,
    SUMMARY_TTL,
)

# Import route modules
from .routes import (
    sessions_router,
    analytics_router,
    machines_router,
    templates_router,
    sharing_router,
    processes_router,
)
from .process_manager import get_process_manager

# Export for use by routes
_summary_cache = get_summary_cache()

# Create FastAPI app
app = FastAPI(title="Claude Session Visualizer")

# Initialize database on startup
init_database()

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Register route modules
app.include_router(sessions_router)
app.include_router(analytics_router)
app.include_router(machines_router)
app.include_router(templates_router)
app.include_router(sharing_router)
app.include_router(processes_router)

# Global WebSocket manager
ws_manager = ConnectionManager()

# Background task references
_file_watcher_task: asyncio.Task | None = None
_recording_task: asyncio.Task | None = None
_last_sessions_hash: str = ""


# Request models for remaining routes
class FocusRequest(BaseModel):
    search_terms: list[str]


class FocusByTtyRequest(BaseModel):
    tty: str


def find_iterm_tab_by_tty(tty: str) -> dict:
    """Find iTerm2 tab by TTY and select it."""
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
        from fastapi import HTTPException
        raise HTTPException(400, "No TTY provided")

    if tty.startswith('s'):
        tty = f"/dev/ttys{tty[1:].zfill(3)}"
    elif not tty.startswith('/dev/'):
        tty = f"/dev/{tty}"

    result = find_iterm_tab_by_tty(tty)
    return result


# AI Summary routes that need access to server state
@app.post("/api/sessions/{session_id}/summary")
async def get_session_summary_endpoint(session_id: str, force_refresh: bool = False):
    """Get or generate AI summary for a session."""
    if force_refresh:
        _summary_cache.pop(session_id, None)

    sessions = get_sessions()
    session = next((s for s in sessions if s['sessionId'] == session_id), None)

    if not session:
        from fastapi import HTTPException
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

        if session.get('isGastown'):
            skipped.append({'sessionId': session_id, 'reason': 'gastown'})
            continue

        last_activity = session.get('lastActivity', '')
        cached = _summary_cache.get(session_id)

        if cached and last_activity:
            try:
                activity_time = datetime.fromisoformat(
                    last_activity.replace('Z', '+00:00')
                ).timestamp()

                if activity_time <= cached['timestamp']:
                    skipped.append({
                        'sessionId': session_id,
                        'reason': 'no_new_activity',
                        'summary': cached['summary']
                    })
                    continue
            except (ValueError, TypeError):
                pass

        try:
            _summary_cache.pop(session_id, None)
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


# WebSocket endpoint
@app.websocket("/ws/sessions")
async def websocket_sessions(websocket: WebSocket):
    """WebSocket endpoint for real-time session updates."""
    await ws_manager.connect(websocket)

    try:
        sessions = get_sessions()
        await websocket.send_json({
            'type': 'sessions_update',
            'sessions': sessions,
            'timestamp': datetime.now(timezone.utc).isoformat()
        })

        while True:
            try:
                data = await websocket.receive_text()
                msg = json.loads(data)

                if msg.get('type') == 'ping':
                    await websocket.send_json({'type': 'pong'})
                elif msg.get('type') == 'refresh':
                    sessions = get_sessions()
                    await websocket.send_json({
                        'type': 'sessions_update',
                        'sessions': sessions,
                        'timestamp': datetime.now(timezone.utc).isoformat()
                    })
            except json.JSONDecodeError:
                pass

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket)


@app.get("/api/ws/status")
def get_ws_status():
    """Get WebSocket connection status."""
    return {
        'connected_clients': ws_manager.connection_count,
        'watcher_running': _file_watcher_task is not None and not _file_watcher_task.done()
    }


# WebSocket endpoint for process output streaming
@app.websocket("/ws/process/{process_id}")
async def websocket_process(websocket: WebSocket, process_id: str):
    """Stream process output to WebSocket client."""
    await websocket.accept()

    process_manager = get_process_manager()
    await process_manager.stream_output(process_id, websocket)


# Background tasks
async def watch_sessions_loop(interval: float = 2.0):
    """Background task that watches for session changes and broadcasts updates."""
    global _last_sessions_hash

    print(f"[WS] Starting session watcher (interval={interval}s)")

    while True:
        try:
            if ws_manager.connection_count > 0:
                sessions = get_sessions()
                current_hash = compute_sessions_hash(sessions)

                if current_hash != _last_sessions_hash:
                    _last_sessions_hash = current_hash

                    for session in sessions:
                        if session.get('isGastown'):
                            continue
                        session_id = session.get('sessionId')
                        if session_id:
                            activities = session.get('recentActivity', [])
                            cwd = session.get('cwd', '')
                            asyncio.create_task(
                                generate_activity_summary(session_id, activities, cwd)
                            )

                    for session in sessions:
                        session_id = session.get('sessionId')
                        if session_id:
                            session['activitySummaries'] = db_get_activity_summaries(session_id)

                    await ws_manager.broadcast({
                        'type': 'sessions_update',
                        'sessions': sessions,
                        'timestamp': datetime.now(timezone.utc).isoformat()
                    })
                    print(f"[WS] Broadcast update to {ws_manager.connection_count} clients")

            await asyncio.sleep(interval)

        except asyncio.CancelledError:
            print("[WS] Session watcher cancelled")
            break
        except Exception as e:
            print(f"[WS] Error in session watcher: {e}")
            await asyncio.sleep(interval)


async def record_snapshots_background():
    """Background task that records session snapshots every minute."""
    while True:
        try:
            sessions = get_sessions()
            for session in sessions:
                record_session_snapshot(session)
        except Exception as e:
            print(f"Error recording snapshots: {e}")
        await asyncio.sleep(60)


@app.on_event("startup")
async def startup_event():
    """Start background tasks on app startup."""
    global _recording_task, _file_watcher_task

    _recording_task = asyncio.create_task(record_snapshots_background())
    _file_watcher_task = asyncio.create_task(watch_sessions_loop(interval=2.0))

    manager = get_tunnel_manager()
    manager.connect_all()
    manager.start_monitor(interval=30)


@app.on_event("shutdown")
async def shutdown_event():
    """Cancel background tasks on shutdown."""
    global _recording_task, _file_watcher_task

    if _recording_task:
        _recording_task.cancel()

    if _file_watcher_task:
        _file_watcher_task.cancel()

    # Clean up managed processes
    process_manager = get_process_manager()
    await process_manager.cleanup()

    manager = get_tunnel_manager()
    manager.stop_monitor()
    manager.disconnect_all()


# Static file serving
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
    return FileResponse(frontend_dir / "index.html")


@app.get("/{filename:path}")
def serve_static(filename: str):
    file_path = frontend_dir / filename
    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    return FileResponse(frontend_dir / "index.html")

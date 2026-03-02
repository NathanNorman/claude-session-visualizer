"""Main FastAPI server for Claude Session Visualizer.

This module initializes the FastAPI application, registers routes,
and manages background tasks for session monitoring.
"""

# Load environment variables before other imports
from dotenv import load_dotenv
load_dotenv()

import asyncio
import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

# Initialize logging early
from .logging_config import setup_logging, get_logger, get_ws_log_handler
setup_logging()

# Create namespace loggers
logger = get_logger(__name__)
ws_logger = get_logger(__name__, namespace='ws')

from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .session_detector import get_sessions, read_fast_session_state, merge_fast_state_with_baseline
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
    update_session_focus_summary,
    get_bedrock_token,
    get_summary_cache,
    BEDROCK_TOKEN_FILE,
    SUMMARY_TTL,
)
from .session_detector import (
    extract_first_user_message,
    get_recent_messages,
    count_user_messages,
)
from .config import CLAUDE_PROJECTS_DIR

# Import route modules
from .routes import (
    sessions_router,
    analytics_router,
    machines_router,
    templates_router,
    sharing_router,
    processes_router,
    skills_router,
    stream_processes_router,
)
from .stream_process_manager import get_stream_process_manager

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
# stream_processes_router MUST be before processes_router so new endpoints
# (/api/sdk-mode, /api/processes, /api/spawn) take precedence over old ones
app.include_router(stream_processes_router)
app.include_router(sessions_router)
app.include_router(analytics_router)
app.include_router(machines_router)
app.include_router(templates_router)
app.include_router(sharing_router)
app.include_router(processes_router)
app.include_router(skills_router)

# Global WebSocket manager
ws_manager = ConnectionManager()

# Background task references
_file_watcher_task: asyncio.Task | None = None
_recording_task: asyncio.Task | None = None
_last_sessions_hash: str = ""
_watcher_event: asyncio.Event | None = None
_udp_transport: asyncio.DatagramTransport | None = None


class UDPNotificationProtocol(asyncio.DatagramProtocol):
    """Receives UDP notifications from hooks to wake the session watcher.

    Hooks send a fire-and-forget UDP datagram containing a session ID
    after writing state files. This wakes the fast-path watcher immediately
    for sub-100ms UI updates.
    """

    def datagram_received(self, data, addr):
        try:
            session_id = data.decode('utf-8').strip()
            # Validate UUID format (8-4-4-4-12 hex chars)
            if len(session_id) == 36 and all(
                c in '0123456789abcdef-' for c in session_id
            ):
                if _watcher_event:
                    _watcher_event.set()
            else:
                ws_logger.debug(f"Invalid UDP datagram (not UUID): {session_id[:50]}")
        except Exception:
            pass

    def error_received(self, exc):
        ws_logger.debug(f"UDP protocol error: {exc}")

    def connection_lost(self, exc):
        pass


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
    """Refresh AI summaries for all sessions that have new activity."""
    sessions = get_sessions()

    refreshed = []
    skipped = []
    errors = []

    for session in sessions:
        session_id = session.get('sessionId')
        if not session_id:
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
                elif msg.get('type') == 'subscribe_logs':
                    # Handle log subscription
                    enabled = msg.get('enabled', True)
                    namespaces = msg.get('namespaces')  # None = all
                    await ws_manager.subscribe_to_logs(
                        websocket,
                        enabled=enabled,
                        namespaces=namespaces
                    )
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
    """Stream process output via WebSocket."""
    await websocket.accept()

    manager = get_stream_process_manager()
    proc = manager.get_process(process_id)

    if not proc:
        await websocket.send_json({"type": "error", "message": f"Process {process_id} not found"})
        await websocket.close()
        return

    await manager.add_websocket_client(process_id, websocket)

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            if msg.get('type') == 'ping':
                await websocket.send_json({'type': 'pong'})
            elif msg.get('type') == 'user_message':
                await manager.send_message(process_id, msg.get('text', ''))
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await manager.remove_websocket_client(process_id, websocket)


# Background tasks
async def watch_sessions_loop(interval: float = 0.5):
    """Two-tier background watcher for session changes.

    Fast path (every tick): reads hook-generated state files only, merges
    with cached baseline, broadcasts if state/activity changed.

    Slow path (every Nth tick): runs full get_sessions() pipeline (JSONL
    parse, process scan, git status), updates baseline, generates summaries.

    Uses asyncio.Event for interruptible sleep so UDP notifications can
    wake the loop immediately for sub-100ms updates.
    """
    global _last_sessions_hash, _watcher_event

    _watcher_event = asyncio.Event()
    baseline_sessions: list[dict] = []
    tick_count = 0
    slow_tick_interval = 10  # Full refresh every 10 ticks (~5s at 500ms)
    last_broadcast_time = time.time()
    heartbeat_interval = 5.0  # seconds

    ws_logger.info(
        f"Starting two-tier session watcher "
        f"(interval={interval}s, slow_every={slow_tick_interval} ticks)"
    )

    while True:
        try:
            if ws_manager.connection_count > 0:
                is_slow_tick = (tick_count % slow_tick_interval == 0)
                tick_count += 1

                if is_slow_tick:
                    # Slow path: full pipeline
                    sessions = get_sessions()

                    # Add activity summaries to baseline
                    for session in sessions:
                        session_id = session.get('sessionId')
                        if session_id:
                            session['activitySummaries'] = db_get_activity_summaries(session_id)

                    baseline_sessions = sessions
                else:
                    # Fast path: state files only, merge with baseline
                    fast_states = read_fast_session_state()
                    sessions = merge_fast_state_with_baseline(fast_states, baseline_sessions)

                # Compute hash and broadcast if changed
                current_hash = compute_sessions_hash(sessions)
                now_time = time.time()

                if current_hash != _last_sessions_hash:
                    _last_sessions_hash = current_hash

                    # Kick off async summary generation only on slow-path changes
                    if is_slow_tick:
                        for session in sessions:
                            session_id = session.get('sessionId')
                            if session_id:
                                activities = session.get('recentActivity', [])
                                cwd = session.get('cwd', '')
                                asyncio.create_task(
                                    generate_activity_summary(session_id, activities, cwd)
                                )

                        # Focus Summary Generation
                        for session in sessions:
                            session_id = session.get('sessionId')
                            cwd = session.get('cwd', '')
                            if not session_id or not cwd:
                                continue

                            jsonl_path = None
                            project_slug = cwd.replace('/', '-')
                            if project_slug.startswith('-'):
                                project_slug = project_slug[1:]
                            project_dir = CLAUDE_PROJECTS_DIR / f"-{project_slug}"
                            if project_dir.exists():
                                candidate = project_dir / f"{session_id}.jsonl"
                                if candidate.exists():
                                    jsonl_path = candidate

                            if jsonl_path:
                                message_count = count_user_messages(jsonl_path)
                                context_pct = int(session.get('tokenPercentage', 0))
                                last_activity = session.get('lastActivity')
                                current_summary = session.get('focusSummary')

                                first_msg = None
                                if not current_summary:
                                    first_msg = extract_first_user_message(jsonl_path)

                                recent_msgs = None
                                if current_summary and message_count > 0:
                                    recent_msgs = get_recent_messages(jsonl_path, limit=5)

                                asyncio.create_task(
                                    update_session_focus_summary(
                                        session_id=session_id,
                                        message_count=message_count,
                                        context_pct=context_pct,
                                        last_activity_at=last_activity,
                                        first_user_message=first_msg,
                                        recent_messages=recent_msgs,
                                        current_summary=current_summary
                                    )
                                )

                    await ws_manager.broadcast({
                        'type': 'sessions_update',
                        'sessions': sessions,
                        'timestamp': datetime.now(timezone.utc).isoformat()
                    })
                    last_broadcast_time = now_time
                    ws_logger.debug(f"Broadcast update to {ws_manager.connection_count} clients")

                elif now_time - last_broadcast_time >= heartbeat_interval:
                    # Heartbeat: keep WebSocket alive during quiet periods
                    await ws_manager.broadcast({
                        'type': 'heartbeat',
                        'timestamp': datetime.now(timezone.utc).isoformat()
                    })
                    last_broadcast_time = now_time
            else:
                tick_count = 0  # Reset so next connection gets a slow tick first

            # Interruptible sleep via asyncio.Event
            try:
                await asyncio.wait_for(_watcher_event.wait(), timeout=interval)
                _watcher_event.clear()
            except asyncio.TimeoutError:
                pass  # Normal timeout, proceed with next tick

        except asyncio.CancelledError:
            ws_logger.info("Session watcher cancelled")
            break
        except Exception as e:
            ws_logger.error(f"Error in session watcher: {e}")
            try:
                await asyncio.wait_for(_watcher_event.wait(), timeout=interval)
                _watcher_event.clear()
            except asyncio.TimeoutError:
                pass


async def record_snapshots_background():
    """Background task that records session snapshots every minute."""
    while True:
        try:
            sessions = get_sessions()
            for session in sessions:
                record_session_snapshot(session)
        except Exception as e:
            logger.error(f"Error recording snapshots: {e}")
        await asyncio.sleep(60)


def _create_log_broadcast_callback():
    """Create a callback that bridges sync logging to async WebSocket broadcast."""
    def callback(log_entry):
        # Schedule the async broadcast in the event loop
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(ws_manager.broadcast_log(log_entry.to_dict()))
        except RuntimeError:
            pass  # No event loop running, skip
    return callback


@app.on_event("startup")
async def startup_event():
    """Start background tasks on app startup."""
    global _recording_task, _file_watcher_task, _udp_transport

    # Wire up log streaming to WebSocket
    ws_log_handler = get_ws_log_handler()
    ws_log_handler.set_broadcast_callback(_create_log_broadcast_callback())

    _recording_task = asyncio.create_task(record_snapshots_background())
    _file_watcher_task = asyncio.create_task(watch_sessions_loop(interval=0.5))

    # Start UDP listener for hook-to-server push notifications (Phase 2)
    from .config import CSV_UDP_PORT
    try:
        loop = asyncio.get_running_loop()
        _udp_transport, _ = await loop.create_datagram_endpoint(
            UDPNotificationProtocol,
            local_addr=('127.0.0.1', CSV_UDP_PORT)
        )
        logger.info(f"UDP notification listener started on 127.0.0.1:{CSV_UDP_PORT}")
    except OSError as e:
        logger.warning(
            f"Could not start UDP listener on port {CSV_UDP_PORT}: {e}. "
            f"Falling back to poll-only mode."
        )
    except Exception as e:
        logger.warning(f"UDP listener failed: {e}")

    manager = get_tunnel_manager()
    manager.connect_all()
    manager.start_monitor(interval=30)


@app.on_event("shutdown")
async def shutdown_event():
    """Cancel background tasks on shutdown."""
    global _recording_task, _file_watcher_task, _udp_transport

    if _recording_task:
        _recording_task.cancel()

    if _file_watcher_task:
        _file_watcher_task.cancel()

    if _udp_transport:
        _udp_transport.close()

    # Clean up managed processes
    stream_manager = get_stream_process_manager()
    await stream_manager.cleanup()

    manager = get_tunnel_manager()
    manager.stop_monitor()
    manager.disconnect_all()


# Static file serving
frontend_dir = Path(__file__).parent.parent / "frontend"


@app.get("/api/browse-folder")
def browse_folder():
    """Open a native folder picker dialog and return the selected path."""
    import platform

    try:
        if platform.system() == "Darwin":  # macOS
            # Use PyObjC for fast native folder picker (no subprocess overhead)
            try:
                from AppKit import NSOpenPanel, NSApplication, NSApp

                # Ensure NSApplication is initialized
                if NSApp is None:
                    NSApplication.sharedApplication()

                # Create and configure the open panel
                panel = NSOpenPanel.openPanel()
                panel.setCanChooseFiles_(False)
                panel.setCanChooseDirectories_(True)
                panel.setAllowsMultipleSelection_(False)
                panel.setMessage_("Select a directory for Claude session")
                panel.setPrompt_("Select")

                # Run modal dialog (blocks until user responds)
                result = panel.runModal()

                if result == 1:  # NSModalResponseOK
                    urls = panel.URLs()
                    if urls and len(urls) > 0:
                        path = urls[0].path()
                        return {"path": str(path)}
                return {"error": "No folder selected"}

            except ImportError:
                # Fallback to osascript if PyObjC not available
                script = '''
                tell application "System Events"
                    activate
                    set folderPath to POSIX path of (choose folder with prompt "Select a directory for Claude session")
                end tell
                return folderPath
                '''
                result = subprocess.run(
                    ["osascript", "-e", script],
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                if result.returncode == 0 and result.stdout.strip():
                    return {"path": result.stdout.strip()}
                else:
                    return {"error": "No folder selected", "details": result.stderr}
        else:
            # For Linux/Windows, fall back to tkinter
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()  # Hide the main window
            root.attributes('-topmost', True)  # Bring dialog to front

            folder_path = filedialog.askdirectory(title="Select a directory for Claude session")
            root.destroy()

            if folder_path:
                return {"path": folder_path}
            else:
                return {"error": "No folder selected"}
    except subprocess.TimeoutExpired:
        return {"error": "Dialog timed out"}
    except Exception as e:
        return {"error": str(e)}


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
        # Disable caching for JS/CSS during development
        headers = {}
        if filename.endswith(('.js', '.css')):
            headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            headers["Pragma"] = "no-cache"
            headers["Expires"] = "0"
        return FileResponse(file_path, headers=headers)
    return FileResponse(frontend_dir / "index.html")

"""WebSocket connection management for real-time session updates."""

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import WebSocket


@dataclass
class ConnectionManager:
    """Manages WebSocket connections and broadcasts session updates."""
    active_connections: list[WebSocket] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def connect(self, websocket: WebSocket):
        """Accept a new WebSocket connection."""
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        print(f"[WS] Client connected. Total: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection."""
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        print(f"[WS] Client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Broadcast message to all connected clients."""
        if not self.active_connections:
            return

        data = json.dumps(message)
        disconnected = []

        async with self._lock:
            for connection in self.active_connections:
                try:
                    await connection.send_text(data)
                except Exception:
                    disconnected.append(connection)

        # Clean up disconnected clients
        for conn in disconnected:
            await self.disconnect(conn)

    @property
    def connection_count(self) -> int:
        return len(self.active_connections)


def compute_sessions_hash(sessions: list[dict]) -> str:
    """Compute a hash of session states for change detection."""
    key_data = []
    for s in sessions:
        key_data.append({
            'sessionId': s.get('sessionId'),
            'state': s.get('state'),
            'currentActivity': s.get('currentActivity'),
            'contextTokens': s.get('contextTokens'),
            'lastActivity': s.get('lastActivity'),
            'activityLog': s.get('activityLog', [])[-5:],
        })
    return hashlib.md5(json.dumps(key_data, sort_keys=True).encode()).hexdigest()


async def watch_sessions_loop(
    ws_manager: ConnectionManager,
    get_sessions_func,
    generate_summary_func,
    get_activity_summaries_func,
    interval: float = 2.0
):
    """Background task that watches for session changes and broadcasts updates.

    Args:
        ws_manager: WebSocket connection manager
        get_sessions_func: Function to get current sessions
        generate_summary_func: Function to generate activity summaries
        get_activity_summaries_func: Function to get activity summaries from DB
        interval: Seconds between checks (default 2.0 for responsive updates)
    """
    last_sessions_hash = ""

    print(f"[WS] Starting session watcher (interval={interval}s)")

    while True:
        try:
            if ws_manager.connection_count > 0:
                sessions = get_sessions_func()
                current_hash = compute_sessions_hash(sessions)

                if current_hash != last_sessions_hash:
                    last_sessions_hash = current_hash

                    # Generate activity summaries for sessions with changed activity
                    for session in sessions:
                        if session.get('isGastown'):
                            continue
                        session_id = session.get('sessionId')
                        if session_id:
                            activities = session.get('recentActivity', [])
                            cwd = session.get('cwd', '')
                            asyncio.create_task(
                                generate_summary_func(session_id, activities, cwd)
                            )

                    # Include activity summaries in session data
                    for session in sessions:
                        session_id = session.get('sessionId')
                        if session_id:
                            session['activitySummaries'] = get_activity_summaries_func(session_id)

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

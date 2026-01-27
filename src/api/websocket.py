"""WebSocket connection management for real-time session updates."""

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import WebSocket

from .logging_config import get_logger

# Create WebSocket logger
logger = get_logger(__name__, namespace='ws')


@dataclass
class LogSubscription:
    """Tracks a WebSocket client's log subscription."""
    websocket: WebSocket
    namespaces: set[str] = field(default_factory=set)  # Empty = all namespaces
    enabled: bool = True


@dataclass
class ConnectionManager:
    """Manages WebSocket connections and broadcasts session updates."""
    active_connections: list[WebSocket] = field(default_factory=list)
    log_subscribers: dict[WebSocket, LogSubscription] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def connect(self, websocket: WebSocket):
        """Accept a new WebSocket connection."""
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)
        logger.info(f"Client connected. Total: {len(self.active_connections)}")

    async def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection."""
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
            # Also remove from log subscribers
            self.log_subscribers.pop(websocket, None)
        logger.info(f"Client disconnected. Total: {len(self.active_connections)}")

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

    async def subscribe_to_logs(
        self,
        websocket: WebSocket,
        enabled: bool = True,
        namespaces: list[str] | None = None
    ):
        """Subscribe a WebSocket client to log streaming.

        Args:
            websocket: The WebSocket connection
            enabled: Whether to enable log streaming
            namespaces: List of namespaces to filter (None = all)
        """
        from .logging_config import get_ws_log_handler

        async with self._lock:
            if enabled:
                self.log_subscribers[websocket] = LogSubscription(
                    websocket=websocket,
                    namespaces=set(namespaces) if namespaces else set(),
                    enabled=True
                )
                logger.debug(f"Log subscriber added. Total: {len(self.log_subscribers)}")

                # Send log history
                ws_handler = get_ws_log_handler()
                history = ws_handler.get_history(100)
                await websocket.send_json({
                    'type': 'log_history',
                    'logs': history,
                    'count': len(history)
                })
            else:
                self.log_subscribers.pop(websocket, None)
                logger.debug(f"Log subscriber removed. Total: {len(self.log_subscribers)}")

    async def broadcast_log(self, log_entry: dict):
        """Broadcast a log entry to all log subscribers.

        Args:
            log_entry: Dict with timestamp, level, namespace, message
        """
        if not self.log_subscribers:
            return

        namespace = log_entry.get('namespace', 'general')
        disconnected = []

        async with self._lock:
            for ws, sub in self.log_subscribers.items():
                if not sub.enabled:
                    continue
                # Filter by namespace if specified
                if sub.namespaces and namespace not in sub.namespaces:
                    continue

                try:
                    await ws.send_json({
                        'type': 'log',
                        'log': log_entry
                    })
                except Exception:
                    disconnected.append(ws)

        # Clean up disconnected clients
        for ws in disconnected:
            await self.disconnect(ws)

    @property
    def connection_count(self) -> int:
        return len(self.active_connections)

    @property
    def log_subscriber_count(self) -> int:
        return len(self.log_subscribers)


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

    logger.info(f"Starting session watcher (interval={interval}s)")

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
                    logger.debug(f"Broadcast update to {ws_manager.connection_count} clients")

            await asyncio.sleep(interval)

        except asyncio.CancelledError:
            logger.info("Session watcher cancelled")
            break
        except Exception as e:
            logger.error(f"Error in session watcher: {e}")
            await asyncio.sleep(interval)

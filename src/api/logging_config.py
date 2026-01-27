"""Structured logging configuration for the session visualizer.

This module provides:
- WebSocketLogHandler for streaming logs to the frontend
- Namespace-based logging for filtering
- Runtime log level adjustment
- Log buffering for history on WebSocket connect
"""

import logging
import os
import sys
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional


# Log namespaces for filtering
NAMESPACES = {
    'ws': 'WebSocket',
    'pty': 'PTY/Process',
    'session': 'Session Detection',
    'api': 'API Routes',
    'bedrock': 'Bedrock/AI',
    'tunnel': 'SSH Tunnel',
    'git': 'Git Operations',
    'analytics': 'Analytics',
}


@dataclass
class LogEntry:
    """Structured log entry for WebSocket streaming."""
    timestamp: str
    level: str
    namespace: str
    message: str

    def to_dict(self) -> dict:
        return {
            'timestamp': self.timestamp,
            'level': self.level,
            'namespace': self.namespace,
            'message': self.message,
        }


class WebSocketLogHandler(logging.Handler):
    """Custom handler that buffers logs and broadcasts to WebSocket subscribers."""

    def __init__(self, buffer_size: int = 500):
        super().__init__()
        self.buffer_size = buffer_size
        self.buffer: deque[LogEntry] = deque(maxlen=buffer_size)
        self.broadcast_callback: Optional[Callable[[LogEntry], None]] = None
        self.enabled = True

    def emit(self, record: logging.LogRecord):
        if not self.enabled:
            return

        try:
            # Extract namespace from logger name (e.g., 'csv.ws' -> 'ws')
            namespace = 'general'
            if record.name.startswith('csv.'):
                namespace = record.name.split('.')[1] if '.' in record.name else 'general'

            entry = LogEntry(
                timestamp=datetime.now(timezone.utc).isoformat(),
                level=record.levelname,
                namespace=namespace,
                message=self.format(record),
            )

            # Add to buffer
            self.buffer.append(entry)

            # Broadcast if callback is set
            if self.broadcast_callback:
                try:
                    self.broadcast_callback(entry)
                except Exception:
                    pass  # Don't let broadcast errors affect logging

        except Exception:
            self.handleError(record)

    def get_history(self, count: int = 100) -> list[dict]:
        """Get recent log entries from buffer."""
        entries = list(self.buffer)[-count:]
        return [e.to_dict() for e in entries]

    def set_broadcast_callback(self, callback: Callable[[LogEntry], None]):
        """Set callback function for broadcasting logs."""
        self.broadcast_callback = callback

    def clear_buffer(self):
        """Clear the log buffer."""
        self.buffer.clear()


# Global WebSocket log handler instance
_ws_log_handler: Optional[WebSocketLogHandler] = None


def get_ws_log_handler() -> WebSocketLogHandler:
    """Get or create the global WebSocket log handler."""
    global _ws_log_handler
    if _ws_log_handler is None:
        buffer_size = int(os.environ.get('CSV_LOG_BUFFER_SIZE', '500'))
        _ws_log_handler = WebSocketLogHandler(buffer_size=buffer_size)
        _ws_log_handler.setFormatter(
            logging.Formatter('%(message)s')
        )
    return _ws_log_handler


def _get_log_level_from_env() -> int:
    """Get log level from environment variable."""
    env_level = os.environ.get('CSV_LOG_LEVEL', 'INFO').upper()
    return getattr(logging, env_level, logging.INFO)


def setup_logging(
    level: Optional[int] = None,
    log_format: Optional[str] = None,
) -> None:
    """
    Configure structured logging for the application.

    Args:
        level: Logging level (default: from CSV_LOG_LEVEL env var or INFO)
        log_format: Custom format string (default: timestamp - name - level - message)
    """
    # Determine level from environment if not specified
    log_level = level if level is not None else _get_log_level_from_env()

    if log_format is None:
        log_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)

    # Clear existing handlers
    root_logger.handlers.clear()

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(log_level)
    console_handler.setFormatter(logging.Formatter(log_format))
    root_logger.addHandler(console_handler)

    # WebSocket handler (if streaming enabled)
    if os.environ.get('CSV_LOG_STREAM', 'true').lower() == 'true':
        ws_handler = get_ws_log_handler()
        ws_handler.setLevel(log_level)
        root_logger.addHandler(ws_handler)

    # Reduce noise from third-party libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    # Create namespace loggers
    for namespace in NAMESPACES:
        logging.getLogger(f'csv.{namespace}').setLevel(log_level)


def set_log_level(level: str | int):
    """
    Set log level at runtime.

    Args:
        level: Level name ('DEBUG', 'INFO', etc.) or logging constant
    """
    if isinstance(level, str):
        level = getattr(logging, level.upper(), logging.INFO)

    # Update root logger
    logging.getLogger().setLevel(level)

    # Update all CSV loggers
    for namespace in NAMESPACES:
        logging.getLogger(f'csv.{namespace}').setLevel(level)

    # Update handlers
    for handler in logging.getLogger().handlers:
        handler.setLevel(level)


def get_logger(name: str, namespace: Optional[str] = None) -> logging.Logger:
    """
    Get a logger with the given name.

    Args:
        name: Logger name (typically __name__)
        namespace: Optional namespace (ws, pty, session, etc.)

    Returns:
        Configured logger instance
    """
    if namespace and namespace in NAMESPACES:
        return logging.getLogger(f'csv.{namespace}')
    return logging.getLogger(name)

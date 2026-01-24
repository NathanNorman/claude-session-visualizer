"""Structured logging configuration for the session visualizer."""

import logging
import sys
from typing import Optional


def setup_logging(
    level: int = logging.INFO,
    log_format: Optional[str] = None,
) -> None:
    """
    Configure structured logging for the application.

    Args:
        level: Logging level (default: INFO)
        log_format: Custom format string (default: timestamp - name - level - message)
    """
    if log_format is None:
        log_format = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

    # Configure root logger
    logging.basicConfig(
        level=level,
        format=log_format,
        handlers=[
            logging.StreamHandler(sys.stdout),
        ],
    )

    # Reduce noise from third-party libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger with the given name.

    Args:
        name: Logger name (typically __name__)

    Returns:
        Configured logger instance
    """
    return logging.getLogger(name)

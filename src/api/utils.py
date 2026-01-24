"""Shared utilities for the Claude Session Visualizer.

This module contains common functions and constants used across
session_detector.py and remote_agent.py to eliminate code duplication.
"""

import json
import logging
from typing import Any

from .config import PRICING, MAX_CONTEXT_TOKENS

logger = logging.getLogger(__name__)


def calculate_cost(usage: dict) -> float:
    """Calculate estimated cost from token usage.

    Args:
        usage: Dictionary containing token counts:
            - input_tokens: Regular input tokens
            - output_tokens: Output tokens
            - cache_read_input_tokens: Cached input tokens read
            - cache_creation_input_tokens: Tokens used to create cache

    Returns:
        Estimated cost in dollars, rounded to 2 decimal places
    """
    input_tokens = usage.get('input_tokens', 0)
    output_tokens = usage.get('output_tokens', 0)
    cache_read = usage.get('cache_read_input_tokens', 0)
    cache_write = usage.get('cache_creation_input_tokens', 0)

    cost = (
        (input_tokens / 1_000_000) * PRICING['input_per_mtok'] +
        (output_tokens / 1_000_000) * PRICING['output_per_mtok'] +
        (cache_read / 1_000_000) * PRICING['cache_read_per_mtok'] +
        (cache_write / 1_000_000) * PRICING['cache_write_per_mtok']
    )

    return round(cost, 2)


def get_token_percentage(tokens: int) -> float:
    """Calculate token usage percentage of max context window.

    Args:
        tokens: Current token count

    Returns:
        Percentage of context window used (0-100, capped at 100)
    """
    return min(100, (tokens / MAX_CONTEXT_TOKENS) * 100)


# extract_activity moved to detection/jsonl_parser.py to avoid duplication
# Import from there: from .detection.jsonl_parser import extract_activity


def parse_jsonl_line(line: str | bytes) -> dict[str, Any] | None:
    """Safely parse a single JSONL line.

    Args:
        line: A line from a JSONL file (string or bytes)

    Returns:
        Parsed JSON dictionary or None if parsing failed
    """
    try:
        if isinstance(line, bytes):
            line = line.decode('utf-8')
        return json.loads(line.strip())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def safe_get_nested(data: dict, *keys: str, default: Any = None) -> Any:
    """Safely get a nested value from a dictionary.

    Args:
        data: The dictionary to search
        *keys: The nested keys to follow
        default: Default value if key path not found

    Returns:
        The nested value or default

    Example:
        safe_get_nested({'a': {'b': 1}}, 'a', 'b') -> 1
        safe_get_nested({'a': {}}, 'a', 'b', default=0) -> 0
    """
    result = data
    for key in keys:
        if isinstance(result, dict):
            result = result.get(key, default)
        else:
            return default
    return result

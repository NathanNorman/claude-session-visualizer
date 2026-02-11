"""Configuration module for the Claude Session Visualizer.

Centralizes all configuration constants and environment variables
to eliminate scattered magic numbers and duplicated settings.
"""

import os
from pathlib import Path

# ============================================================================
# Path Configuration
# ============================================================================

# Base directory for Claude projects containing JSONL files
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"

# Database path for session history
DB_PATH = Path.home() / ".claude" / "session_history.db"


# ============================================================================
# Session Detection Thresholds
# ============================================================================

# CPU percentage above which a session is considered "active"
# Claude uses minimal CPU when waiting for API responses
ACTIVE_CPU_THRESHOLD = 0.5

# File modification recency threshold for "active" state (seconds)
# If JSONL file was modified within this time, session is active
ACTIVE_RECENCY_SECONDS = 30

# Maximum age of sessions to display (hours)
MAX_SESSION_AGE_HOURS = 2

# Maximum age for "all sessions" view including dead sessions (hours)
MAX_ALL_SESSION_AGE_HOURS = 24


# ============================================================================
# Token Configuration
# ============================================================================

# Maximum context window size for Claude models
MAX_CONTEXT_TOKENS = 200000

# Pricing for cost estimation (Claude 3.5 Sonnet per million tokens)
PRICING = {
    'input_per_mtok': 3.00,
    'output_per_mtok': 15.00,
    'cache_read_per_mtok': 0.30,
    'cache_write_per_mtok': 3.75,
}


# ============================================================================
# Cache TTL Settings (seconds)
# ============================================================================

# How long to cache JSONL metadata before re-reading
METADATA_CACHE_TTL = 60

# How long to cache process list from ps command
PROCESS_CACHE_TTL = 2

# How long to cache AI-generated activity summaries
SUMMARY_CACHE_TTL = 300


# ============================================================================
# Bedrock API Configuration
# ============================================================================

# Bedrock proxy URL for AI summaries
BEDROCK_PROXY_URL = os.getenv(
    "BEDROCK_PROXY_URL",
    "https://bedrock-runtime.us-east-1.amazonaws.com"
)

# Model to use for activity summaries (Haiku for cost efficiency)
BEDROCK_MODEL_ID = os.getenv(
    "BEDROCK_MODEL_ID",
    "anthropic.claude-3-5-haiku-20241022-v1:0"
)

# Maximum tokens for summary generation
BEDROCK_MAX_TOKENS = 150


# ============================================================================
# Server Configuration
# ============================================================================

# Default host and port
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8000

# WebSocket settings
WEBSOCKET_HEARTBEAT_INTERVAL = 30  # seconds

# Remote agent default port (for multi-machine support)
REMOTE_AGENT_PORT = 8081


# ============================================================================
# Timeline Configuration
# ============================================================================

# Activity bucket size for timeline aggregation (minutes)
TIMELINE_BUCKET_MINUTES = 5

# Minimum activity count for summaries to be useful
MIN_ACTIVITY_FOR_SUMMARY = 3

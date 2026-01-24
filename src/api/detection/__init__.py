"""Detection modules for Claude session discovery and parsing.

This package contains modules for:
- Process detection and management (processes.py)
- JSONL file parsing (jsonl_parser.py)
- Activity extraction and timeline generation (activity.py)
- Session matching algorithms (matcher.py)

Import functions from here for a clean API:
    from src.api.detection import get_claude_processes, extract_jsonl_metadata
"""

# Process detection
from .processes import (
    get_claude_processes,
    get_claude_processes_cached,
    get_process_cwd,
    get_process_start_time,
)

# JSONL parsing
from .jsonl_parser import (
    extract_jsonl_metadata,
    extract_activity,
    extract_text_content,
    extract_tool_calls,
    cwd_to_project_slug,
    is_gastown_path,
    extract_gastown_role_from_cwd,
    get_session_metadata,
    get_recent_session_for_project,
)

# Activity timeline
from .activity import (
    extract_session_timeline,
    get_activity_periods,
)

# Session matching
from .matcher import (
    get_sessions_for_cwd,
    match_process_to_session,
)

__all__ = [
    # Process detection
    'get_claude_processes',
    'get_claude_processes_cached',
    'get_process_cwd',
    'get_process_start_time',
    # JSONL parsing
    'extract_jsonl_metadata',
    'extract_activity',
    'extract_text_content',
    'extract_tool_calls',
    'cwd_to_project_slug',
    'is_gastown_path',
    'extract_gastown_role_from_cwd',
    'get_session_metadata',
    'get_recent_session_for_project',
    # Activity timeline
    'extract_session_timeline',
    'get_activity_periods',
    # Session matching
    'get_sessions_for_cwd',
    'match_process_to_session',
]

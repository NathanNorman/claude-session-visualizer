import subprocess
import json
import re
import logging
from pathlib import Path
from datetime import datetime, timezone
import time
from collections import Counter
from statistics import mean, median
from .git_tracker import get_cached_git_status
from .config import (
    CLAUDE_PROJECTS_DIR,
    ACTIVE_CPU_THRESHOLD,
    ACTIVE_RECENCY_SECONDS,
)
from .utils import calculate_cost, get_token_percentage

# Import stateless helper functions from detection modules to reduce duplication
from .detection.jsonl_parser import (
    is_gastown_path,
    extract_gastown_role_from_cwd,
    cwd_to_project_slug,
    extract_text_content,
    extract_tool_calls,
    extract_activity,
)
from .detection.matcher import match_process_to_session

logger = logging.getLogger(__name__)


def estimate_tokens(text: str) -> int:
    """Estimate token count for text using a simple heuristic.

    Claude uses roughly 4 characters per token on average.
    This is a fast approximation without needing a tokenizer.
    """
    if not text:
        return 0
    # Rough estimate: ~4 chars per token for English text
    return max(1, len(text) // 4)
MAX_SESSION_AGE_HOURS = 2  # Only show sessions with activity in last N hours
STATE_DIR = Path.home() / ".claude" / "visualizer" / "session-state"
STATE_FILE_MAX_AGE_SECONDS = 300  # Consider state files stale after 5 minutes

# No longer need TTY cache - we now match by process cwd

# Activity timestamp tracking for dirty-check optimization
_last_activity_time: float = 0.0

def update_activity_timestamp():
    """Update the activity timestamp when session data changes."""
    global _last_activity_time
    _last_activity_time = time.time()

def get_activity_timestamp() -> float:
    """Get the last activity timestamp for dirty-check endpoint."""
    return _last_activity_time

# JSONL metadata cache: {path_str: (mtime, cache_time, metadata_dict)}
_metadata_cache: dict[str, tuple[float, float, dict]] = {}
METADATA_CACHE_TTL = 60  # Max cache age in seconds

# State file mtime cache for dirty-check: {session_id: mtime}
_state_file_mtimes: dict[str, float] = {}

# Continuation cache: {session_id: continuation_session_id or None}
_continuation_cache: dict[str, str | None] = {}
_continuation_cache_mtime: dict[str, float] = {}  # Track when cache was built
CACHE_CLEANUP_INTERVAL = 3600  # Clean caches every hour
_last_cache_cleanup: float = 0.0

# Process list cache: (timestamp, processes_list)
_process_cache: tuple[float, list] | None = None
PROCESS_CACHE_TTL = 2  # Cache processes for 2 seconds (faster stale session detection)

# Note: MAX_CONTEXT_TOKENS, PRICING, calculate_cost, and get_token_percentage
# are now imported from config.py and utils.py


def cleanup_stale_caches(current_state_files: set[str] | None = None) -> None:
    """Clean up stale entries from caches to prevent memory leaks.

    Args:
        current_state_files: Set of currently active state file session IDs.
                            If provided, cleans continuation cache for removed sessions.
    """
    global _metadata_cache, _continuation_cache, _continuation_cache_mtime, _last_cache_cleanup

    now = time.time()

    # Only run cleanup periodically
    if now - _last_cache_cleanup < CACHE_CLEANUP_INTERVAL:
        return

    _last_cache_cleanup = now

    # Clean metadata cache: remove entries older than 1 hour
    max_cache_age = 3600  # 1 hour
    stale_paths = [
        path for path, (_, cache_time, _) in _metadata_cache.items()
        if now - cache_time > max_cache_age
    ]
    for path in stale_paths:
        del _metadata_cache[path]

    # Clean continuation cache: remove entries for sessions that no longer exist
    stale_sessions: list[str] = []
    if current_state_files is not None:
        stale_sessions = [
            sid for sid in _continuation_cache
            if sid not in current_state_files
        ]
        for sid in stale_sessions:
            _continuation_cache.pop(sid, None)
            _continuation_cache_mtime.pop(sid, None)

    if stale_paths or stale_sessions:
        logger.debug(
            "Cache cleanup: removed %d metadata entries, %d continuation entries",
            len(stale_paths),
            len(stale_sessions)
        )


def check_background_shell_status(shells: list[dict], cwd: str) -> list[dict]:
    """Check status of background shells and compute durations.

    For each shell:
    - If running: check if process still exists
    - Compute duration (running time or total time if completed)

    Returns updated shell list with computed status.
    """
    if not shells:
        return []

    now = time.time()
    result = []

    # Get list of running processes to check against
    try:
        ps_result = subprocess.run(
            ['ps', 'aux'],
            capture_output=True, text=True, timeout=5
        )
        running_processes = ps_result.stdout
    except Exception:
        running_processes = ""

    for shell in shells:
        shell_copy = dict(shell)
        started_at = shell.get('started_at', '')
        command = shell.get('command', '')

        # Calculate duration
        try:
            start_time = datetime.fromisoformat(started_at.replace('Z', '+00:00')).timestamp()
        except (ValueError, AttributeError):
            start_time = now

        if shell.get('status') == 'running':
            # Check if process is still running by looking for command in ps output
            # Use first 30 chars of command as identifier
            cmd_snippet = command[:30] if command else ''
            is_still_running = cmd_snippet and cmd_snippet in running_processes

            if is_still_running:
                shell_copy['computed_status'] = 'running'
                shell_copy['duration_seconds'] = int(now - start_time)
            else:
                # Process died - mark as completed
                shell_copy['computed_status'] = 'completed'
                shell_copy['completed_at'] = datetime.now(timezone.utc).isoformat()
                shell_copy['duration_seconds'] = int(now - start_time)
        else:
            # Already completed
            shell_copy['computed_status'] = 'completed'
            if shell.get('completed_at'):
                try:
                    end_time = datetime.fromisoformat(shell['completed_at'].replace('Z', '+00:00')).timestamp()
                    shell_copy['duration_seconds'] = int(end_time - start_time)
                except (ValueError, AttributeError):
                    shell_copy['duration_seconds'] = 0
            else:
                shell_copy['duration_seconds'] = 0

        result.append(shell_copy)

    return result


def read_session_state(session_id: str, ignore_stale: bool = False) -> dict | None:
    """Read hook-generated state file for a session.

    Args:
        session_id: The session UUID
        ignore_stale: If True, return state even if file is stale (for graveyard)

    Returns:
        State dict with 'state', 'current_activity', etc. or None if not found/stale
    """
    if not session_id:
        return None

    state_file = STATE_DIR / f"{session_id}.json"

    if not state_file.exists():
        return None

    try:
        # Check file age
        mtime = state_file.stat().st_mtime
        age = time.time() - mtime

        # For active sessions, ignore stale files
        if not ignore_stale and age > STATE_FILE_MAX_AGE_SECONDS:
            return None

        with open(state_file, 'r') as f:
            state = json.load(f)

        # For graveyard, we only need activity_log - don't validate state fields
        if ignore_stale:
            state['_state_file_age'] = age
            state['_is_stale'] = age > STATE_FILE_MAX_AGE_SECONDS
            return state

        # Validate required fields for active sessions
        if 'state' not in state or 'updated_at' not in state:
            return None

        # Ensure state is valid value
        if state['state'] not in ('active', 'waiting'):
            return None

        # Add metadata
        state['_state_file_age'] = age
        return state

    except (json.JSONDecodeError, OSError, KeyError):
        return None


def get_all_active_state_files() -> dict[str, dict]:
    """Scan all state files and return valid (non-stale) ones.

    Also updates activity timestamp if any state file has changed (for dirty-check).

    Returns:
        Dict mapping session_id -> state dict (includes cwd, transcript_path)
    """
    global _state_file_mtimes

    if not STATE_DIR.exists():
        return {}

    now = time.time()
    active_states = {}
    current_mtimes = {}
    state_changed = False

    for state_file in STATE_DIR.glob("*.json"):
        try:
            mtime = state_file.stat().st_mtime
            age = now - mtime
            session_id = state_file.stem

            # Track mtime for dirty-check
            current_mtimes[session_id] = mtime
            if _state_file_mtimes.get(session_id) != mtime:
                state_changed = True

            if age > STATE_FILE_MAX_AGE_SECONDS:
                continue

            with open(state_file, 'r') as f:
                state = json.load(f)

            # Validate required fields
            if 'state' not in state or 'session_id' not in state:
                continue

            if state['state'] not in ('active', 'waiting'):
                continue

            state['_state_file_age'] = age
            active_states[state['session_id']] = state

        except (json.JSONDecodeError, OSError, KeyError):
            continue

    # Check for removed state files
    if set(_state_file_mtimes.keys()) != set(current_mtimes.keys()):
        state_changed = True

    # Update mtime cache and activity timestamp
    _state_file_mtimes = current_mtimes
    if state_changed:
        update_activity_timestamp()

    # Periodically clean up stale cache entries to prevent memory leaks
    cleanup_stale_caches(set(current_mtimes.keys()))

    return active_states


def get_process_cwd(pid: int) -> str | None:
    """Get the current working directory of a process using lsof."""
    try:
        result = subprocess.run(
            ['lsof', '-a', '-d', 'cwd', '-p', str(pid)],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.split('\n'):
            if str(pid) in line and '/' in line:
                # Last field is the path
                parts = line.split()
                if parts:
                    return parts[-1]
    except Exception:
        pass
    return None


def get_process_start_time(pid: int) -> float | None:
    """Get process start time as Unix timestamp."""
    try:
        # Get elapsed time in seconds
        result = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'etimes='],
            capture_output=True, text=True, timeout=5
        )
        elapsed = int(result.stdout.strip())
        return time.time() - elapsed
    except Exception:
        pass
    return None


def get_claude_processes() -> list[dict]:
    """Get all running claude CLI processes with metadata."""
    result = subprocess.run(["ps", "aux"], capture_output=True, text=True)
    processes = []

    for line in result.stdout.split('\n'):
        # Skip non-claude lines
        if 'claude' not in line.lower():
            continue
        # Skip non-CLI processes
        if any(skip in line for skip in ['/bin/zsh', 'grep', 'Claude.app', 'node_modules', 'chrome-', '@claude-flow']):
            continue

        parts = line.split()
        if len(parts) < 11:
            continue

        # Only consider processes where command is claude CLI
        cmd_start = parts[10]
        if not (cmd_start == 'claude' or cmd_start.endswith('/claude')):
            continue

        try:
            pid = int(parts[1])
            cpu = float(parts[2])
            tty = parts[6]
            state = parts[7]
            cmd = ' '.join(parts[10:])
        except (ValueError, IndexError):
            continue

        # Skip processes with no controlling terminal (orphaned after terminal close)
        # TTY of '?' or '??' indicates no controlling terminal
        if tty in ('?', '??'):
            continue

        # Skip zombie processes
        if state.startswith('Z'):
            continue

        # Verify TTY device still exists (terminal window not closed)
        # ps aux returns TTY like 's000', 's007' which maps to /dev/ttys000, /dev/ttys007
        if tty.startswith('s') and tty[1:].isdigit():
            tty_path = Path(f"/dev/tty{tty}")
            if not tty_path.exists():
                continue

        # Get actual working directory and start time of the process
        cwd = get_process_cwd(pid)

        # Detect gastown agent sessions (multi-agent orchestration)
        # Check command line markers
        is_gastown_cmd = (
            '[GAS TOWN]' in cmd or      # gastown prompt marker
            'gt boot' in cmd or          # gastown boot command
            'GT_ROLE=' in line           # gastown env var (tmux-spawned agents)
        )
        # Check cwd for gastown directory patterns
        is_gastown_cwd = cwd and any(pattern in cwd for pattern in [
            '/deacon',      # deacon service
            '/witness',     # witness monitor
            '/mayor',       # mayor orchestrator
            '/polecats/',   # polecat workers
            '/refinery/',   # rig refineries
            '/rig',         # rig directories
            '/gt/',         # general gastown directory
        ])
        is_gastown = is_gastown_cmd or is_gastown_cwd

        # Extract gastown role from command/env/cwd
        gastown_role = None
        if is_gastown:
            # Try GT_ROLE env var first (e.g., "GT_ROLE=mayor")
            role_match = re.search(r'GT_ROLE=(\w+)', line)
            if role_match:
                gastown_role = role_match.group(1)
            # Try [GAS TOWN] prompt format (e.g., "[GAS TOWN] mayor <- human")
            elif '[GAS TOWN]' in cmd:
                prompt_match = re.search(r'\[GAS TOWN\]\s+(\w+)', cmd)
                if prompt_match:
                    gastown_role = prompt_match.group(1)
            # Fallback: extract role from cwd path
            if not gastown_role and cwd:
                if cwd.endswith('/rig'):
                    gastown_role = 'rig'
                elif '/deacon' in cwd:
                    gastown_role = 'deacon'
                elif '/mayor' in cwd:
                    gastown_role = 'mayor'
                elif '/witness' in cwd:
                    gastown_role = 'witness'
                elif '/refinery' in cwd and '/rig' not in cwd:
                    gastown_role = 'refinery'
                elif '/polecats/' in cwd:
                    gastown_role = 'polecat'

        # Extract session ID from --resume flag if present
        session_id = None
        if '--resume' in cmd:
            match = re.search(r'--resume\s+([a-f0-9-]{36})', cmd)
            if match:
                session_id = match.group(1)

        # Get process start time (cwd already fetched above for gastown check)
        start_time = get_process_start_time(pid)

        processes.append({
            'pid': pid,
            'cpu': cpu,
            'tty': tty,
            'state': state,
            'cmd': cmd,
            'session_id': session_id,
            'cwd': cwd,
            'start_time': start_time,
            'is_gastown': is_gastown,
            'gastown_role': gastown_role,
        })

    return processes


def get_claude_processes_cached() -> list[dict]:
    """Get claude processes with caching to avoid frequent subprocess calls.

    Caches process list for PROCESS_CACHE_TTL seconds.
    """
    global _process_cache
    now = time.time()

    if _process_cache and (now - _process_cache[0]) < PROCESS_CACHE_TTL:
        return _process_cache[1]

    processes = get_claude_processes()
    _process_cache = (now, processes)
    return processes


def get_session_metadata(session_id: str) -> dict | None:
    """Get metadata for a specific session ID from its JSONL file."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return None

    # Search all project directories for the session file
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        jsonl_file = project_dir / f"{session_id}.jsonl"
        if jsonl_file.exists():
            return extract_jsonl_metadata(jsonl_file)

    return None


def get_recent_session_for_project(project_slug: str) -> dict | None:
    """Get the most recently modified non-agent session for a project."""
    project_dir = CLAUDE_PROJECTS_DIR / project_slug
    if not project_dir.exists():
        return None

    # Find most recent non-agent JSONL file
    candidates = []
    for jsonl_file in project_dir.glob("*.jsonl"):
        # Skip agent files
        if jsonl_file.stem.startswith('agent-'):
            continue
        candidates.append((jsonl_file.stat().st_mtime, jsonl_file))

    if not candidates:
        return None

    # Get most recent
    candidates.sort(reverse=True)
    _, best_file = candidates[0]
    return extract_jsonl_metadata(best_file)


def extract_jsonl_metadata(jsonl_file: Path) -> dict:
    """Extract metadata from a JSONL file.

    Uses caching based on file mtime to avoid re-parsing unchanged files.
    """
    global _metadata_cache
    path_str = str(jsonl_file)
    now = time.time()

    try:
        current_mtime = jsonl_file.stat().st_mtime
    except OSError:
        # File doesn't exist or can't be accessed
        return {'sessionId': jsonl_file.stem, 'slug': jsonl_file.stem, 'cwd': ''}

    # Check cache: return cached value if mtime hasn't changed and cache isn't stale
    if path_str in _metadata_cache:
        cached_mtime, cached_time, cached_data = _metadata_cache[path_str]
        if cached_mtime == current_mtime and (now - cached_time) < METADATA_CACHE_TTL:
            return cached_data

    # File changed or cache miss - re-extract metadata
    # Try to derive a slug from the project directory name if needed
    # Project dirs are like: -Users-nathan-norman-projectname
    project_dir_name = jsonl_file.parent.name
    fallback_slug = project_dir_name.split('-')[-1] if project_dir_name else jsonl_file.stem

    metadata = {
        'sessionId': jsonl_file.stem,
        'slug': jsonl_file.stem,  # Will be overwritten if JSONL has slug
        'cwd': '',
        'gitBranch': '',
        'summary': None,
        'contextTokens': 0,
        'timestamp': '',
        'startTimestamp': '',  # Feature 05: Session start time
        'file_mtime': current_mtime,
        'recentActivity': [],
        '_fallback_slug': fallback_slug,  # Store for later use
    }

    # Feature 04: Track cumulative token usage for cost calculation
    cumulative_usage = {
        'input_tokens': 0,
        'output_tokens': 0,
        'cache_read_input_tokens': 0,
        'cache_creation_input_tokens': 0
    }

    try:
        file_size = jsonl_file.stat().st_size
        read_size = min(file_size, 100000)  # Read more for activity

        activities = []

        # Feature 05: Read first few lines to get session start time
        with open(jsonl_file, 'r') as f:
            for _ in range(20):  # Check first 20 lines for a timestamp
                line = f.readline()
                if not line:
                    break
                try:
                    data = json.loads(line.strip())
                    if data.get('timestamp'):
                        metadata['startTimestamp'] = data['timestamp']
                        break
                except (json.JSONDecodeError, ValueError):
                    continue

        with open(jsonl_file, 'rb') as f:
            if file_size > read_size:
                f.seek(file_size - read_size)
                f.readline()  # Skip partial line

            for line in f:
                try:
                    data = json.loads(line.decode('utf-8').strip())

                    # Get basic metadata
                    if 'sessionId' in data:
                        metadata['sessionId'] = data['sessionId']
                    if 'slug' in data and data['slug']:
                        metadata['slug'] = data['slug']
                    if data.get('cwd'):
                        metadata['cwd'] = data['cwd']
                    if data.get('gitBranch'):
                        metadata['gitBranch'] = data['gitBranch']
                    if data.get('timestamp'):
                        metadata['timestamp'] = data['timestamp']

                    # Get summary
                    if data.get('type') == 'summary' and data.get('summary'):
                        metadata['summary'] = data['summary']

                    # Get context tokens from assistant messages
                    if data.get('type') == 'assistant' and isinstance(data.get('message'), dict):
                        msg = data['message']
                        usage = msg.get('usage', {})
                        if usage:
                            metadata['contextTokens'] = (
                                usage.get('cache_read_input_tokens', 0) +
                                usage.get('input_tokens', 0)
                            )

                            # Feature 04: Accumulate all usage for cost calculation
                            cumulative_usage['input_tokens'] += usage.get('input_tokens', 0)
                            cumulative_usage['output_tokens'] += usage.get('output_tokens', 0)
                            cumulative_usage['cache_read_input_tokens'] += usage.get('cache_read_input_tokens', 0)
                            cumulative_usage['cache_creation_input_tokens'] += usage.get('cache_creation_input_tokens', 0)

                        # Extract activity from tool calls and text
                        content = msg.get('content', [])
                        for item in content:
                            activity = extract_activity(item)
                            if activity:
                                activities.append(activity)

                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue

        # Keep last 10 activities
        metadata['recentActivity'] = activities[-10:] if activities else []

        # Feature 03: Add token percentage
        metadata['tokenPercentage'] = get_token_percentage(metadata['contextTokens'])

        # Feature 04: Add estimated cost
        metadata['estimatedCost'] = calculate_cost(cumulative_usage)
        metadata['cumulativeUsage'] = cumulative_usage

    except Exception:
        logger.exception("Failed to extract metadata from %s", jsonl_file)

    # If slug is still a UUID (same as sessionId), try to use a better name
    if metadata['slug'] == metadata['sessionId']:
        # Prefer cwd-derived name if available
        if metadata['cwd']:
            # Use last component of path as slug
            metadata['slug'] = metadata['cwd'].rstrip('/').split('/')[-1]
        elif metadata.get('_fallback_slug'):
            metadata['slug'] = metadata['_fallback_slug']

    # Clean up internal field
    metadata.pop('_fallback_slug', None)

    # Detect gastown sessions from cwd path
    cwd = metadata.get('cwd', '')
    metadata['isGastown'] = is_gastown_path(cwd)
    if metadata['isGastown']:
        metadata['gastownRole'] = extract_gastown_role_from_cwd(cwd)

    # Cache the result and update activity timestamp
    _metadata_cache[path_str] = (current_mtime, time.time(), metadata)
    update_activity_timestamp()

    return metadata


# is_gastown_path, extract_gastown_role_from_cwd, cwd_to_project_slug, and extract_activity
# are imported from detection.jsonl_parser


def extract_session_timeline(jsonl_file: Path) -> list[dict]:
    """Extract activity periods from JSONL file with tool details.

    Returns:
        List of events with timestamps, activity type, and tool details
    """
    events = []

    try:
        with open(jsonl_file, 'r') as f:
            for line in f:
                try:
                    data = json.loads(line.strip())

                    if 'timestamp' not in data:
                        continue

                    event_type = data.get('type', 'unknown')
                    # Consider assistant and tool_use as active states
                    is_active = event_type in ['assistant', 'tool_use', 'tool_result']

                    event = {
                        'timestamp': data['timestamp'],
                        'type': event_type,
                        'active': is_active
                    }

                    # Extract tool details from assistant messages
                    if event_type == 'assistant' and isinstance(data.get('message'), dict):
                        content = data['message'].get('content', [])
                        for item in content:
                            if isinstance(item, dict) and item.get('type') == 'tool_use':
                                tool_name = item.get('name', '')
                                tool_input = item.get('input', {})
                                activity = extract_activity(item)
                                events.append({
                                    'timestamp': data['timestamp'],
                                    'type': 'tool_use',
                                    'active': True,
                                    'tool': tool_name,
                                    'activity': activity or tool_name
                                })
                        # Also add text activity if present
                        for item in content:
                            if isinstance(item, dict) and item.get('type') == 'text':
                                text = item.get('text', '').strip()
                                if text:
                                    # Get first line/sentence as summary
                                    first_line = text.split('\n')[0][:80]
                                    events.append({
                                        'timestamp': data['timestamp'],
                                        'type': 'text',
                                        'active': True,
                                        'activity': first_line
                                    })
                                    break  # Only one text summary per message

                    # Add human prompts as markers
                    elif event_type == 'user':
                        msg = data.get('message', {})
                        if isinstance(msg, dict):
                            text = ''
                            content = msg.get('content', [])
                            if isinstance(content, str):
                                text = content[:60]
                            elif isinstance(content, list):
                                for item in content:
                                    if isinstance(item, dict) and item.get('type') == 'text':
                                        text = item.get('text', '')[:60]
                                        break
                            event['activity'] = f"User: {text}" if text else "User prompt"
                            event['tool'] = 'human'
                        events.append(event)
                    else:
                        events.append(event)

                except (json.JSONDecodeError, KeyError):
                    continue
    except Exception:
        logger.exception("Failed to extract session timeline from %s", jsonl_file)

    return events


def get_activity_periods(events: list[dict], bucket_minutes: int = 5) -> list[dict]:
    """Bucket events into activity periods with activity summaries.

    Args:
        events: List of events with timestamp, type, active flag, and optional tool/activity
        bucket_minutes: Size of time buckets in minutes

    Returns:
        List of activity periods: [{'start': ISO, 'end': ISO, 'state': str, 'activities': list, 'tools': dict}]
    """
    if not events:
        return []

    periods = []
    bucket_seconds = bucket_minutes * 60

    # Sort events by timestamp
    sorted_events = sorted(events, key=lambda e: e['timestamp'])

    # Group events into time buckets
    current_bucket_start = None
    current_bucket_end = None
    bucket_has_activity = False
    bucket_activities = []  # List of activity descriptions
    bucket_tools = {}  # tool_name -> count

    def save_bucket():
        """Save the current bucket to periods."""
        nonlocal bucket_activities, bucket_tools
        if bucket_has_activity:
            # Dedupe consecutive same activities
            deduped = []
            prev = None
            for act in bucket_activities:
                if act != prev:
                    deduped.append(act)
                    prev = act

            periods.append({
                'start': datetime.fromtimestamp(current_bucket_start, tz=timezone.utc).isoformat(),
                'end': datetime.fromtimestamp(current_bucket_end, tz=timezone.utc).isoformat(),
                'state': 'active',
                'activities': deduped[-10:],  # Keep last 10 for the bucket
                'tools': dict(bucket_tools)
            })
        bucket_activities = []
        bucket_tools = {}

    for event in sorted_events:
        try:
            event_time = datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00'))
            event_timestamp = event_time.timestamp()
        except (ValueError, AttributeError):
            continue

        # Initialize first bucket
        if current_bucket_start is None:
            current_bucket_start = event_timestamp
            current_bucket_end = current_bucket_start + bucket_seconds
            bucket_has_activity = event['active']
            if event.get('activity'):
                bucket_activities.append(event['activity'])
            if event.get('tool'):
                bucket_tools[event['tool']] = bucket_tools.get(event['tool'], 0) + 1
            continue

        # Check if event is in current bucket
        if event_timestamp < current_bucket_end:
            # Update activity state (if any event is active, bucket is active)
            bucket_has_activity = bucket_has_activity or event['active']
            if event.get('activity'):
                bucket_activities.append(event['activity'])
            if event.get('tool'):
                bucket_tools[event['tool']] = bucket_tools.get(event['tool'], 0) + 1
        else:
            # Save current bucket
            save_bucket()

            # Start new bucket
            current_bucket_start = event_timestamp
            current_bucket_end = current_bucket_start + bucket_seconds
            bucket_has_activity = event['active']
            bucket_activities = []
            bucket_tools = {}
            if event.get('activity'):
                bucket_activities.append(event['activity'])
            if event.get('tool'):
                bucket_tools[event['tool']] = bucket_tools.get(event['tool'], 0) + 1

    # Add final bucket if it had activity
    if current_bucket_start is not None:
        save_bucket()

    return periods


def get_all_sessions(max_age_hours: int = 24) -> list[dict]:
    """Get all sessions modified within max_age_hours."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return []

    now = time.time()
    cutoff = now - (max_age_hours * 3600)
    results = []

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            # Skip agent files
            if jsonl_file.stem.startswith('agent-'):
                continue

            try:
                mtime = jsonl_file.stat().st_mtime
                if mtime > cutoff:
                    metadata = extract_jsonl_metadata(jsonl_file)
                    metadata['recency'] = now - mtime
                    results.append(metadata)
            except Exception:
                logger.debug("Error reading session file %s", jsonl_file, exc_info=True)
                continue

    # Sort by most recent first
    results.sort(key=lambda x: x['recency'])
    return results


def get_dead_sessions(max_age_hours: int = 24) -> list[dict]:
    """Get dead (ended) sessions - sessions with JSONL files but no running process.

    Args:
        max_age_hours: Only include sessions modified within this time window

    Returns:
        List of session metadata dicts with state='dead'
    """
    if not CLAUDE_PROJECTS_DIR.exists():
        return []

    now = time.time()
    cutoff = now - (max_age_hours * 3600)

    # Get all currently running session IDs
    running_sessions = get_sessions()
    running_session_ids = {s['sessionId'] for s in running_sessions}

    results = []

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            # Skip agent files
            if jsonl_file.stem.startswith('agent-'):
                continue

            session_id = jsonl_file.stem

            # Skip if this session is currently running
            if session_id in running_session_ids:
                continue

            try:
                mtime = jsonl_file.stat().st_mtime
                if mtime > cutoff:
                    metadata = extract_jsonl_metadata(jsonl_file)
                    metadata['state'] = 'dead'
                    metadata['recency'] = now - mtime
                    metadata['endedAt'] = datetime.fromtimestamp(mtime).isoformat()
                    metadata['jsonlPath'] = str(jsonl_file)

                    # Try to get activity logs from (possibly stale) state file
                    state = read_session_state(session_id, ignore_stale=True)
                    if state:
                        metadata['activityLog'] = state.get('activity_log', [])
                        metadata['hasActivityLog'] = len(metadata['activityLog']) > 0
                    else:
                        metadata['activityLog'] = []
                        metadata['hasActivityLog'] = False

                    results.append(metadata)
            except Exception:
                logger.debug("Error reading dead session file %s", jsonl_file, exc_info=True)
                continue

    # Sort by most recent first (smallest recency = most recent)
    results.sort(key=lambda x: x['recency'])
    return results


def search_dead_sessions(query: str, max_age_hours: int = 24, search_content: bool = False) -> list[dict]:
    """Search dead sessions by text query.

    Args:
        query: Search query string (case-insensitive)
        max_age_hours: Only include sessions modified within this time window
        search_content: If True, also search conversation content (slower)

    Returns:
        List of matching session metadata dicts with match info
    """
    if not query or not CLAUDE_PROJECTS_DIR.exists():
        return []

    query_lower = query.lower()
    query_terms = query_lower.split()
    now = time.time()
    cutoff = now - (max_age_hours * 3600)

    # Get running session IDs to exclude
    running_sessions = get_sessions()
    running_session_ids = {s['sessionId'] for s in running_sessions}

    results = []

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            # Skip agent files
            if jsonl_file.stem.startswith('agent-'):
                continue

            session_id = jsonl_file.stem

            # Skip running sessions
            if session_id in running_session_ids:
                continue

            try:
                mtime = jsonl_file.stat().st_mtime
                if mtime < cutoff:
                    continue

                metadata = extract_jsonl_metadata(jsonl_file)
                matches = []
                match_snippets = []

                # Search metadata fields
                searchable_meta = ' '.join([
                    metadata.get('slug', ''),
                    metadata.get('cwd', ''),
                    metadata.get('summary', '') or '',
                    metadata.get('gitBranch', ''),
                ]).lower()

                # Check if all query terms appear in metadata
                meta_match = all(term in searchable_meta for term in query_terms)
                if meta_match:
                    matches.append('metadata')
                    if metadata.get('summary'):
                        match_snippets.append(f"Summary: {metadata['summary'][:100]}")

                # Optionally search conversation content
                if search_content:
                    content_match, snippet = _search_jsonl_content(jsonl_file, query_terms)
                    if content_match:
                        matches.append('content')
                        if snippet:
                            match_snippets.append(snippet)

                if matches:
                    metadata['state'] = 'dead'
                    metadata['recency'] = now - mtime
                    metadata['endedAt'] = datetime.fromtimestamp(mtime).isoformat()
                    metadata['jsonlPath'] = str(jsonl_file)
                    metadata['matchType'] = matches
                    metadata['matchSnippets'] = match_snippets[:3]  # Limit snippets

                    # Try to get activity logs from (possibly stale) state file
                    state = read_session_state(session_id, ignore_stale=True)
                    if state:
                        metadata['activityLog'] = state.get('activity_log', [])
                        metadata['hasActivityLog'] = len(metadata['activityLog']) > 0
                    else:
                        metadata['activityLog'] = []
                        metadata['hasActivityLog'] = False

                    results.append(metadata)

            except Exception:
                logger.debug("Error searching session file %s", jsonl_file, exc_info=True)
                continue

    # Sort by recency (most recent first)
    results.sort(key=lambda x: x['recency'])
    return results


def _search_jsonl_content(jsonl_file: Path, query_terms: list[str]) -> tuple[bool, str | None]:
    """Search JSONL conversation content for query terms.

    Args:
        jsonl_file: Path to JSONL file
        query_terms: List of lowercase search terms

    Returns:
        Tuple of (matched: bool, snippet: str | None)
    """
    try:
        # Read limited amount to avoid huge files
        max_bytes = 500000  # 500KB
        file_size = jsonl_file.stat().st_size

        with open(jsonl_file, 'r', encoding='utf-8', errors='ignore') as f:
            if file_size > max_bytes:
                # Read from end for recent content
                f.seek(file_size - max_bytes)
                f.readline()  # Skip partial line

            for line in f:
                try:
                    data = json.loads(line)
                    line_lower = line.lower()

                    # Quick check: all terms in the raw line
                    if all(term in line_lower for term in query_terms):
                        # Extract a snippet from user or assistant message
                        if data.get('type') == 'user':
                            content = extract_text_content(data.get('message', {}))
                            if content:
                                return True, f"User: {content[:80]}..."
                        elif data.get('type') == 'assistant':
                            content = extract_text_content(data.get('message', {}))
                            if content:
                                return True, f"Assistant: {content[:80]}..."

                except json.JSONDecodeError:
                    continue

    except Exception:
        pass

    return False, None


def get_sessions_for_cwd(cwd: str) -> list[dict]:
    """Find all JSONL session files for a given working directory.

    Returns list of metadata dicts for all sessions with matching internal cwd.
    """
    if not cwd or not CLAUDE_PROJECTS_DIR.exists():
        return []

    # Convert cwd to project slug (e.g., /Users/nathan/foo → -Users-nathan-foo)
    project_slug = cwd_to_project_slug(cwd)
    project_dir = CLAUDE_PROJECTS_DIR / project_slug

    if not project_dir.exists():
        return []

    # Find all non-agent JSONL files whose cwd matches
    sessions = []
    for jsonl_file in project_dir.glob("*.jsonl"):
        # Skip agent files
        if jsonl_file.stem.startswith('agent-'):
            continue
        try:
            metadata = extract_jsonl_metadata(jsonl_file)
            # Only include if the session's cwd matches
            if metadata.get('cwd') == cwd:
                metadata['file_mtime'] = jsonl_file.stat().st_mtime
                sessions.append(metadata)
        except Exception:
            logger.debug("Error reading session for cwd %s", cwd, exc_info=True)
            continue

    return sessions


# match_process_to_session imported from detection.matcher


def get_sessions() -> list[dict]:
    """Get all running Claude sessions with metadata and activity state.

    Uses process-centric approach: each running claude process is a session.
    Activity is determined by:
    - CPU > threshold, OR
    - JSONL file modified in last 30 seconds

    Matches processes to sessions by:
    1. --resume sessionId in command line (definitive)
    2. State file CWD matching (handles sessions that cd'd to different dirs)
    3. Process CWD + start time matching (fallback)
    """
    processes = get_claude_processes_cached()
    result = []
    now = time.time()

    # Get all active state files upfront for state-based matching
    active_states = get_all_active_state_files()

    # Multi-pass matching to ensure each process gets its own session
    claimed_session_ids = set()
    matched_processes = {}  # pid -> metadata
    claimed_pids = set()

    # Pass 1: Match processes with explicit --resume session IDs
    for proc in processes:
        if proc['session_id']:
            metadata = get_session_metadata(proc['session_id'])
            if metadata:
                metadata['recency'] = now - metadata.get('file_mtime', 0)
                matched_processes[proc['pid']] = metadata
                claimed_session_ids.add(proc['session_id'])
                claimed_pids.add(proc['pid'])

    # Pass 2: Match using state files (handles sessions that changed directories)
    # State files have current CWD which may differ from original project CWD
    for session_id, state in active_states.items():
        if session_id in claimed_session_ids:
            continue

        state_cwd = state.get('cwd', '')
        transcript_path = state.get('transcript_path', '')

        # Find a process with matching CWD that isn't already matched
        for proc in processes:
            if proc['pid'] in claimed_pids:
                continue
            if proc.get('cwd') == state_cwd:
                # Found matching process - get metadata from transcript path
                if transcript_path and Path(transcript_path).exists():
                    metadata = extract_jsonl_metadata(Path(transcript_path))
                    metadata['recency'] = now - metadata.get('file_mtime', 0)
                    matched_processes[proc['pid']] = metadata
                    claimed_session_ids.add(session_id)
                    claimed_pids.add(proc['pid'])
                    break

    # Pass 3: Match remaining processes by original cwd + start time (fallback)
    # Group processes by cwd to handle multiple sessions in same directory
    procs_by_cwd = {}
    for proc in processes:
        if proc['pid'] not in claimed_pids and proc.get('cwd'):
            procs_by_cwd.setdefault(proc['cwd'], []).append(proc)

    for cwd, cwd_procs in procs_by_cwd.items():
        # Get all sessions for this cwd, excluding already-claimed ones
        all_sessions = get_sessions_for_cwd(cwd)
        available_sessions = [
            s for s in all_sessions
            if s['sessionId'] not in claimed_session_ids
        ]

        # Match each process to a session by start time
        for proc in cwd_procs:
            metadata = match_process_to_session(proc, available_sessions)
            if metadata:
                metadata['recency'] = now - metadata.get('file_mtime', 0)
                matched_processes[proc['pid']] = metadata
                # Remove this session from available pool so next process gets different one
                available_sessions = [
                    s for s in available_sessions
                    if s['sessionId'] != metadata['sessionId']
                ]
                claimed_session_ids.add(metadata['sessionId'])
                claimed_pids.add(proc['pid'])

    # Build result from matched processes
    for proc in processes:
        metadata = matched_processes.get(proc['pid'])

        # Only include sessions we could match to a JSONL file
        if not metadata:
            continue

        recency = metadata.get('recency', 999999)

        # Try hooks-based state first (instant, accurate)
        hook_state = read_session_state(metadata.get('sessionId'))

        if hook_state:
            state = hook_state['state']
            state_source = 'hooks'
            current_activity = hook_state.get('current_activity')
        else:
            # Fallback to CPU/recency heuristics
            file_recently_modified = recency < ACTIVE_RECENCY_SECONDS
            high_cpu = proc['cpu'] > ACTIVE_CPU_THRESHOLD
            state = 'active' if (file_recently_modified or high_cpu) else 'waiting'
            state_source = 'polling'
            current_activity = None

        result.append({
            'sessionId': metadata['sessionId'],
            'slug': metadata['slug'],
            'cwd': metadata['cwd'],
            'gitBranch': metadata.get('gitBranch', ''),
            'summary': metadata.get('summary'),
            'contextTokens': metadata.get('contextTokens', 0),
            'recentActivity': metadata.get('recentActivity', []),
            'pid': proc['pid'],
            'tty': proc['tty'],
            'cpuPercent': proc['cpu'],
            'lastActivity': metadata.get('timestamp', ''),
            'startTimestamp': metadata.get('startTimestamp', ''),
            'state': state,
            'isGastown': proc.get('is_gastown', False),
            'gastownRole': proc.get('gastown_role'),
            # Feature 03: Token usage visualization
            'tokenPercentage': metadata.get('tokenPercentage', 0),
            # Feature 04: Cost tracking
            'estimatedCost': metadata.get('estimatedCost', 0),
            'cumulativeUsage': metadata.get('cumulativeUsage', {}),
            # Hooks-based state info
            'stateSource': state_source,
            'currentActivity': current_activity,
            'spawnedAgents': hook_state.get('spawned_agents', []) if hook_state else [],
            'backgroundShells': check_background_shell_status(
                hook_state.get('background_shells', []) if hook_state else [],
                metadata.get('cwd', '')
            ),
            # Activity log for emoji trail (last 20 entries)
            'activityLog': hook_state.get('activity_log', [])[-20:] if hook_state else [],
        })

    # Add basic git info to each session
    for session in result:
        cwd = session.get('cwd', '')
        if cwd:
            git_status = get_cached_git_status(cwd)
            if git_status:
                session['git'] = {
                    'branch': git_status.branch,
                    'uncommitted': git_status.has_uncommitted,
                    'modified_count': len(git_status.modified) + len(git_status.added),
                    'ahead': git_status.ahead
                }

    # Sort by activity (active first) then by CPU descending
    result.sort(key=lambda x: (-1 if x['state'] == 'active' else 0, -x['cpuPercent']))

    return result


# ============================================================================
# Compaction Continuation Linking
# ============================================================================

def get_session_start_timestamp(jsonl_path: Path) -> datetime | None:
    """Get the start timestamp from a JSONL file's first few lines."""
    try:
        with open(jsonl_path, 'r', encoding='utf-8', errors='ignore') as f:
            for _ in range(20):  # Check first 20 lines
                line = f.readline()
                if not line:
                    break
                try:
                    data = json.loads(line.strip())
                    ts = data.get('timestamp')
                    if ts:
                        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
                except (json.JSONDecodeError, ValueError):
                    continue
    except Exception:
        pass
    return None


def get_session_cwd(jsonl_path: Path) -> str | None:
    """Get the working directory from a JSONL file."""
    try:
        with open(jsonl_path, 'r', encoding='utf-8', errors='ignore') as f:
            for _ in range(50):  # Check first 50 lines
                line = f.readline()
                if not line:
                    break
                try:
                    data = json.loads(line.strip())
                    cwd = data.get('cwd')
                    if cwd:
                        return cwd
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return None


def find_session_continuation(session_id: str, project_dir: Path, compaction_timestamp: str) -> str | None:
    """
    Find a session that continues from a compacted session.

    Strategy: Look for JSONL files in same project that started
    within 60 seconds after compaction timestamp and have the same cwd.

    Args:
        session_id: The ID of the compacted session
        project_dir: The project directory containing JSONL files
        compaction_timestamp: ISO timestamp of the compaction event

    Returns:
        Session ID of the continuation, or None if not found
    """
    # Check cache first
    if session_id in _continuation_cache:
        # Verify cache is still fresh (check project dir mtime)
        try:
            dir_mtime = project_dir.stat().st_mtime
            cached_mtime = _continuation_cache_mtime.get(session_id, 0)
            if dir_mtime <= cached_mtime:
                return _continuation_cache[session_id]
        except OSError:
            pass

    # Parse compaction timestamp
    try:
        compaction_time = datetime.fromisoformat(compaction_timestamp.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        return None

    # Get the source session's cwd for matching
    source_jsonl = project_dir / f"{session_id}.jsonl"
    source_cwd = get_session_cwd(source_jsonl) if source_jsonl.exists() else None

    # List all JSONL files in project dir
    best_match = None
    best_delta = float('inf')

    for jsonl_path in project_dir.glob("*.jsonl"):
        # Skip the source session
        if jsonl_path.stem == session_id:
            continue

        # Skip agent files
        if jsonl_path.stem.startswith('agent-'):
            continue

        # Read first line to get start timestamp
        start_time = get_session_start_timestamp(jsonl_path)
        if not start_time:
            continue

        # Check if started within 60s after compaction
        delta = (start_time - compaction_time).total_seconds()
        if 0 < delta < 60 and delta < best_delta:
            # Verify same cwd if available
            if source_cwd:
                candidate_cwd = get_session_cwd(jsonl_path)
                if candidate_cwd != source_cwd:
                    continue

            best_match = jsonl_path.stem
            best_delta = delta

    # Cache result (even if None) with directory mtime
    _continuation_cache[session_id] = best_match
    try:
        _continuation_cache_mtime[session_id] = project_dir.stat().st_mtime
    except OSError:
        _continuation_cache_mtime[session_id] = time.time()

    return best_match


def extract_conversation(jsonl_file: Path, limit: int = 0, follow_continuations: bool = True) -> list[dict]:
    """Extract conversation turns from JSONL, optionally following continuation chains.

    Args:
        jsonl_file: Path to the JSONL file
        limit: Max messages to return (0 = no limit, return all)
        follow_continuations: If True, follow compaction continuations to linked sessions

    Returns:
        List of message dicts with role, content, timestamp, and optionally tools
    """
    messages = _extract_single_file_conversation(jsonl_file)

    # Check if ends with compaction and follow continuations
    if follow_continuations and messages:
        # Find the last compaction message
        last_compaction_idx = None
        last_compaction_ts = None
        for idx in range(len(messages) - 1, -1, -1):
            if messages[idx].get('isCompaction'):
                last_compaction_idx = idx
                last_compaction_ts = messages[idx].get('timestamp')
                break

        # If there's a compaction, look for continuation
        if last_compaction_ts:
            project_dir = jsonl_file.parent
            session_id = jsonl_file.stem

            continuation_id = find_session_continuation(session_id, project_dir, last_compaction_ts)
            if continuation_id:
                continuation_path = project_dir / f"{continuation_id}.jsonl"
                if continuation_path.exists():
                    # Add continuation marker after the compaction
                    insert_idx = (last_compaction_idx + 1) if last_compaction_idx is not None else len(messages)
                    messages.insert(insert_idx, {
                        'role': 'system',
                        'content': '⬇️ Session continued after compaction...',
                        'isContinuation': True,
                        'continuationId': continuation_id,
                        'timestamp': last_compaction_ts
                    })

                    # Recursively get continuation messages (handles chains)
                    continuation_messages = extract_conversation(
                        continuation_path, limit=0, follow_continuations=True
                    )
                    messages.extend(continuation_messages)

    # Apply limit at the end
    if limit > 0:
        return messages[-limit:]
    return messages


def _extract_single_file_conversation(jsonl_file: Path) -> list[dict]:
    """Extract conversation turns from a single JSONL file (no continuation following).

    Args:
        jsonl_file: Path to the JSONL file

    Returns:
        List of message dicts with role, content, timestamp, and optionally tools
    """
    messages = []

    try:
        # Read the entire file to get full conversation history
        with open(jsonl_file, 'r', encoding='utf-8', errors='ignore') as f:
            for line_num, line in enumerate(f):
                try:
                    data = json.loads(line)

                    if data.get('type') == 'user':
                        content = extract_text_content(data.get('message', {}))
                        messages.append({
                            'role': 'user',
                            'content': content,
                            'timestamp': data.get('timestamp'),
                            'lineNumber': line_num,
                            'tokens': estimate_tokens(content)
                        })

                    elif data.get('type') == 'assistant':
                        msg = data.get('message', {})
                        msg_content = msg.get('content', [])
                        content = extract_text_content(msg)

                        messages.append({
                            'role': 'assistant',
                            'content': content,
                            'tools': extract_tool_calls(msg_content),
                            'timestamp': data.get('timestamp'),
                            'lineNumber': line_num,
                            'tokens': estimate_tokens(content)
                        })

                    elif data.get('type') == 'summary':
                        # Compaction summary - shows where conversation was compressed
                        summary_text = data.get('summary', '')
                        if summary_text:
                            display_content = f"📋 [Conversation compacted]\n{summary_text[:500]}{'...' if len(summary_text) > 500 else ''}"
                            messages.append({
                                'role': 'system',
                                'content': display_content,
                                'timestamp': data.get('timestamp'),
                                'isCompaction': True,
                                'lineNumber': line_num,
                                'tokens': estimate_tokens(summary_text)
                            })

                except json.JSONDecodeError:
                    continue
    except Exception:
        pass

    return messages


# extract_text_content and extract_tool_calls imported from detection.jsonl_parser


def extract_metrics(jsonl_file: Path) -> dict:
    """Extract performance metrics from JSONL."""
    response_times = []
    tool_counts = Counter()
    turn_tokens = []
    first_timestamp = None
    last_timestamp = None
    prev_timestamp = None

    try:
        with open(jsonl_file) as f:
            for line in f:
                try:
                    data = json.loads(line)
                    ts = data.get('timestamp')

                    if ts:
                        if not first_timestamp:
                            first_timestamp = ts
                        last_timestamp = ts

                    # Calculate response time (user -> assistant)
                    if data.get('type') == 'user':
                        prev_timestamp = ts

                    elif data.get('type') == 'assistant':
                        # Response time only for first assistant after user
                        if prev_timestamp:
                            try:
                                t1 = datetime.fromisoformat(prev_timestamp.replace('Z', '+00:00'))
                                t2 = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                                response_time = (t2 - t1).total_seconds()
                                if 0 < response_time < 300:  # Sanity check
                                    response_times.append(response_time)
                            except (ValueError, AttributeError):
                                pass  # Invalid timestamp format, skip this pair
                            prev_timestamp = None

                        # Token usage (all assistant messages)
                        usage = data.get('message', {}).get('usage', {})
                        if usage:
                            turn_tokens.append(
                                usage.get('input_tokens', 0) +
                                usage.get('output_tokens', 0)
                            )

                        # Tool calls (all assistant messages)
                        content = data.get('message', {}).get('content', [])
                        for item in content:
                            if isinstance(item, dict) and item.get('type') == 'tool_use':
                                tool_counts[item.get('name', 'Unknown')] += 1

                except json.JSONDecodeError:
                    continue
    except Exception:
        logger.exception("Failed to extract metrics from %s", jsonl_file)

    # Calculate duration
    duration_seconds = 0
    if first_timestamp and last_timestamp:
        try:
            t1 = datetime.fromisoformat(first_timestamp.replace('Z', '+00:00'))
            t2 = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
            duration_seconds = (t2 - t1).total_seconds()
        except (ValueError, AttributeError):
            pass  # Invalid timestamp format

    return {
        'responseTime': {
            'min': round(min(response_times), 2) if response_times else 0,
            'avg': round(mean(response_times), 2) if response_times else 0,
            'max': round(max(response_times), 2) if response_times else 0,
            'median': round(median(response_times), 2) if response_times else 0,
        },
        'toolCalls': dict(tool_counts),
        'totalToolCalls': sum(tool_counts.values()),
        'turns': len(turn_tokens),
        'avgTokensPerTurn': round(mean(turn_tokens)) if turn_tokens else 0,
        'durationSeconds': int(duration_seconds),
        'toolsPerHour': round(sum(tool_counts.values()) / (duration_seconds / 3600), 1) if duration_seconds > 0 else 0,
    }

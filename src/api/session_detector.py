import subprocess
import json
import re
from pathlib import Path
from datetime import datetime, timezone
import time
from collections import Counter
from statistics import mean, median
from .git_tracker import get_cached_git_status

CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
ACTIVE_CPU_THRESHOLD = 0.5  # CPU% above this = active (Claude uses little CPU when waiting for API)
ACTIVE_RECENCY_SECONDS = 30  # File modified within this many seconds = active
MAX_SESSION_AGE_HOURS = 2  # Only show sessions with activity in last N hours
STATE_DIR = Path.home() / ".claude" / "visualizer" / "session-state"
STATE_FILE_MAX_AGE_SECONDS = 300  # Consider state files stale after 5 minutes

# No longer need TTY cache - we now match by process cwd

# Feature 03: Token Usage Visualization
MAX_CONTEXT_TOKENS = 200000  # Claude's context window

# Feature 04: Cost Tracking
# Claude 3.5 Sonnet pricing (as of 2024)
PRICING = {
    'input_per_mtok': 3.00,      # $3 per million input tokens
    'output_per_mtok': 15.00,    # $15 per million output tokens
    'cache_read_per_mtok': 0.30, # $0.30 per million cached tokens
    'cache_write_per_mtok': 3.75 # $3.75 per million cache writes
}


def get_token_percentage(tokens: int) -> float:
    """Calculate token usage percentage of max context window."""
    return min(100, (tokens / MAX_CONTEXT_TOKENS) * 100)


def calculate_cost(usage: dict) -> float:
    """Calculate estimated cost from token usage.

    Args:
        usage: Dict with keys: input_tokens, output_tokens,
               cache_read_input_tokens, cache_creation_input_tokens

    Returns:
        Estimated cost in USD
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


def read_session_state(session_id: str) -> dict | None:
    """Read hook-generated state file for a session.

    Returns:
        State dict with 'state', 'current_activity', etc. or None if not found/stale
    """
    if not session_id:
        return None

    state_file = STATE_DIR / f"{session_id}.json"

    if not state_file.exists():
        return None

    try:
        # Check file age - ignore stale files
        mtime = state_file.stat().st_mtime
        age = time.time() - mtime

        if age > STATE_FILE_MAX_AGE_SECONDS:
            return None

        with open(state_file, 'r') as f:
            state = json.load(f)

        # Validate required fields
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

        # Only consider processes where command starts with 'claude'
        cmd_start = parts[10]
        if cmd_start != 'claude':
            continue

        try:
            pid = int(parts[1])
            cpu = float(parts[2])
            tty = parts[6]
            state = parts[7]
            cmd = ' '.join(parts[10:])
        except (ValueError, IndexError):
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
            '/polecats/',   # polecat workers
            '/refinery/',   # rig refineries
            '/rig',         # rig directories
        ])
        is_gastown = is_gastown_cmd or is_gastown_cwd

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
        })

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
    """Extract metadata from a JSONL file."""
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
        'file_mtime': jsonl_file.stat().st_mtime,
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
        pass

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

    return metadata


def extract_activity(content_item: dict) -> str | None:
    """Extract a one-sentence activity description from a content item."""
    item_type = content_item.get('type')

    if item_type == 'tool_use':
        tool_name = content_item.get('name', '')
        tool_input = content_item.get('input', {})

        if tool_name == 'Read':
            path = tool_input.get('file_path', '')
            filename = path.split('/')[-1] if path else 'file'
            return f"Reading {filename}"

        elif tool_name == 'Write':
            path = tool_input.get('file_path', '')
            filename = path.split('/')[-1] if path else 'file'
            return f"Writing {filename}"

        elif tool_name == 'Edit':
            path = tool_input.get('file_path', '')
            filename = path.split('/')[-1] if path else 'file'
            return f"Editing {filename}"

        elif tool_name == 'Bash':
            cmd = tool_input.get('command', '')[:50]
            desc = tool_input.get('description', '')
            if desc:
                return desc[:60]
            elif cmd:
                return f"Running: {cmd}"

        elif tool_name == 'Grep':
            pattern = tool_input.get('pattern', '')[:30]
            return f"Searching for '{pattern}'"

        elif tool_name == 'Glob':
            pattern = tool_input.get('pattern', '')[:30]
            return f"Finding files: {pattern}"

        elif tool_name == 'Task':
            desc = tool_input.get('description', '')[:50]
            return f"Spawning agent: {desc}" if desc else "Spawning agent"

        elif tool_name == 'TodoWrite':
            return "Updating task list"

        elif tool_name == 'WebFetch':
            url = tool_input.get('url', '')[:40]
            return f"Fetching {url}"

        elif tool_name:
            return f"Using {tool_name}"

    elif item_type == 'text':
        text = content_item.get('text', '').strip()
        if text:
            # Get first sentence or first 80 chars
            first_line = text.split('\n')[0][:100]
            if '. ' in first_line:
                return first_line.split('. ')[0] + '.'
            elif len(first_line) > 60:
                return first_line[:60] + '...'
            elif first_line:
                return first_line

    return None


def cwd_to_project_slug(cwd: str) -> str:
    """Convert a cwd path to the project slug format used by Claude."""
    # Claude uses paths like: -Users-nathan-norman-projectname
    # Note: keeps leading dash, replaces both / and . with -
    return cwd.replace('/', '-').replace('.', '-')


def extract_session_timeline(jsonl_file: Path) -> list[dict]:
    """Extract activity periods from JSONL file.

    Returns:
        List of events with timestamps and activity type
    """
    events = []

    try:
        with open(jsonl_file, 'r') as f:
            for line in f:
                try:
                    data = json.loads(line.strip())

                    if 'timestamp' in data:
                        event_type = data.get('type', 'unknown')
                        # Consider assistant and tool_use as active states
                        is_active = event_type in ['assistant', 'tool_use', 'tool_result']

                        events.append({
                            'timestamp': data['timestamp'],
                            'type': event_type,
                            'active': is_active
                        })
                except (json.JSONDecodeError, KeyError):
                    continue
    except Exception:
        pass

    return events


def get_activity_periods(events: list[dict], bucket_minutes: int = 5) -> list[dict]:
    """Bucket events into activity periods.

    Args:
        events: List of events with timestamp, type, and active flag
        bucket_minutes: Size of time buckets in minutes

    Returns:
        List of activity periods: [{'start': ISO, 'end': ISO, 'state': 'active'|'waiting'}]
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
            continue

        # Check if event is in current bucket
        if event_timestamp < current_bucket_end:
            # Update activity state (if any event is active, bucket is active)
            bucket_has_activity = bucket_has_activity or event['active']
        else:
            # Save current bucket
            if bucket_has_activity:
                periods.append({
                    'start': datetime.fromtimestamp(current_bucket_start, tz=timezone.utc).isoformat(),
                    'end': datetime.fromtimestamp(current_bucket_end, tz=timezone.utc).isoformat(),
                    'state': 'active'
                })

            # Start new bucket
            current_bucket_start = event_timestamp
            current_bucket_end = current_bucket_start + bucket_seconds
            bucket_has_activity = event['active']

    # Add final bucket if it had activity
    if current_bucket_start is not None and bucket_has_activity:
        periods.append({
            'start': datetime.fromtimestamp(current_bucket_start, tz=timezone.utc).isoformat(),
            'end': datetime.fromtimestamp(current_bucket_end, tz=timezone.utc).isoformat(),
            'state': 'active'
        })

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
            except:
                continue

    # Sort by most recent first
    results.sort(key=lambda x: x['recency'])
    return results


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
        except:
            continue

    return sessions


def match_process_to_session(proc: dict, available_sessions: list[dict]) -> dict | None:
    """Match a process to its session by comparing start times.

    Args:
        proc: Process dict with 'start_time' key
        available_sessions: List of session metadata dicts with 'startTimestamp'

    Returns:
        Best matching session metadata, or None
    """
    if not available_sessions:
        return None

    proc_start = proc.get('start_time')
    if not proc_start:
        # Fall back to most recent if we can't get process start time
        available_sessions.sort(key=lambda x: x.get('file_mtime', 0), reverse=True)
        return available_sessions[0]

    # Find session with start time closest to process start time
    best_match = None
    best_diff = float('inf')

    for session in available_sessions:
        session_start_str = session.get('startTimestamp')
        if not session_start_str:
            continue

        try:
            # Parse ISO timestamp
            session_start = datetime.fromisoformat(
                session_start_str.replace('Z', '+00:00')
            ).timestamp()

            diff = abs(session_start - proc_start)
            if diff < best_diff:
                best_diff = diff
                best_match = session
        except (ValueError, AttributeError):
            continue

    # If no timestamp match, fall back to most recent
    if not best_match and available_sessions:
        available_sessions.sort(key=lambda x: x.get('file_mtime', 0), reverse=True)
        best_match = available_sessions[0]

    return best_match


def get_sessions() -> list[dict]:
    """Get all running Claude sessions with metadata and activity state.

    Uses process-centric approach: each running claude process is a session.
    Activity is determined by:
    - CPU > threshold, OR
    - JSONL file modified in last 30 seconds

    Matches processes to sessions by:
    1. --resume sessionId in command line (definitive)
    2. Process start time matched to JSONL session start time
    """
    processes = get_claude_processes()
    result = []
    now = time.time()

    # Two-pass matching to ensure each process gets its own session
    # Pass 1: Match processes with explicit --resume session IDs
    claimed_session_ids = set()
    matched_processes = {}  # pid -> metadata

    for proc in processes:
        if proc['session_id']:
            metadata = get_session_metadata(proc['session_id'])
            if metadata:
                metadata['recency'] = now - metadata.get('file_mtime', 0)
                matched_processes[proc['pid']] = metadata
                claimed_session_ids.add(proc['session_id'])

    # Pass 2: Match remaining processes by cwd + start time
    # Group processes by cwd to handle multiple sessions in same directory
    procs_by_cwd = {}
    for proc in processes:
        if proc['pid'] not in matched_processes and proc.get('cwd'):
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
            'state': state,
            'isGastown': proc.get('is_gastown', False),
            # Feature 03: Token usage visualization
            'tokenPercentage': metadata.get('tokenPercentage', 0),
            # Feature 04: Cost tracking
            'estimatedCost': metadata.get('estimatedCost', 0),
            'cumulativeUsage': metadata.get('cumulativeUsage', {}),
            # Hooks-based state info
            'stateSource': state_source,
            'currentActivity': current_activity,
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


def extract_conversation(jsonl_file: Path, limit: int = 10) -> list[dict]:
    """Extract recent conversation turns from JSONL."""
    messages = []

    try:
        with open(jsonl_file, 'rb') as f:
            # Read from end for efficiency
            file_size = f.seek(0, 2)
            read_size = min(file_size, 500000)  # Last 500KB
            f.seek(max(0, file_size - read_size))
            if file_size > read_size:
                f.readline()  # Skip partial line

            for line in f:
                try:
                    data = json.loads(line.decode('utf-8'))

                    if data.get('type') == 'human':
                        messages.append({
                            'role': 'human',
                            'content': extract_text_content(data.get('message', {})),
                            'timestamp': data.get('timestamp')
                        })

                    elif data.get('type') == 'assistant':
                        msg = data.get('message', {})
                        content = msg.get('content', [])

                        messages.append({
                            'role': 'assistant',
                            'content': extract_text_content(msg),
                            'tools': extract_tool_calls(content),
                            'timestamp': data.get('timestamp')
                        })

                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
    except Exception:
        pass

    return messages[-limit:]


def extract_text_content(message: dict) -> str:
    """Extract text from message content."""
    content = message.get('content', [])
    if isinstance(content, str):
        return content[:500]  # Truncate long messages

    texts = []
    for item in content:
        if isinstance(item, dict) and item.get('type') == 'text':
            texts.append(item.get('text', '')[:500])

    return '\n'.join(texts)[:1000]


def extract_tool_calls(content: list) -> list[str]:
    """Extract tool call names from content."""
    tools = []
    for item in content:
        if isinstance(item, dict) and item.get('type') == 'tool_use':
            tools.append(item.get('name', 'Unknown'))
    return tools


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

                    # Calculate response time (human -> assistant)
                    if data.get('type') == 'human':
                        prev_timestamp = ts

                    elif data.get('type') == 'assistant' and prev_timestamp:
                        try:
                            t1 = datetime.fromisoformat(prev_timestamp.replace('Z', '+00:00'))
                            t2 = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                            response_time = (t2 - t1).total_seconds()
                            if 0 < response_time < 300:  # Sanity check
                                response_times.append(response_time)
                        except:
                            pass
                        prev_timestamp = None

                        # Token usage
                        usage = data.get('message', {}).get('usage', {})
                        if usage:
                            turn_tokens.append(
                                usage.get('input_tokens', 0) +
                                usage.get('output_tokens', 0)
                            )

                        # Tool calls
                        content = data.get('message', {}).get('content', [])
                        for item in content:
                            if isinstance(item, dict) and item.get('type') == 'tool_use':
                                tool_counts[item.get('name', 'Unknown')] += 1

                except json.JSONDecodeError:
                    continue
    except Exception:
        pass

    # Calculate duration
    duration_seconds = 0
    if first_timestamp and last_timestamp:
        try:
            t1 = datetime.fromisoformat(first_timestamp.replace('Z', '+00:00'))
            t2 = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
            duration_seconds = (t2 - t1).total_seconds()
        except:
            pass

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

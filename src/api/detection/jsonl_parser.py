"""JSONL file parsing for Claude session data.

This module provides functions for:
- Extracting metadata from JSONL session files
- Parsing session content (messages, tools, activities)
- Caching parsed metadata for performance
"""

import json
import logging
import time
from pathlib import Path

from ..config import CLAUDE_PROJECTS_DIR
from ..utils import calculate_cost, get_token_percentage

logger = logging.getLogger(__name__)

# JSONL metadata cache: {path_str: (mtime, cache_time, metadata_dict)}
_metadata_cache: dict[str, tuple[float, float, dict]] = {}
METADATA_CACHE_TTL = 60  # Max cache age in seconds


def is_gastown_path(cwd: str) -> bool:
    """Check if a cwd path indicates a gastown session."""
    if not cwd:
        return False
    # Check for gastown directory patterns
    # Note: '/gt' matches both '/gt/' and paths ending in '/gt'
    if cwd.endswith('/gt') or '/gt/' in cwd:
        return True
    return any(pattern in cwd for pattern in [
        '/deacon', '/witness', '/mayor', '/polecats/',
        '/refinery/', '/rig'
    ])


def extract_gastown_role_from_cwd(cwd: str) -> str | None:
    """Extract gastown role from cwd path."""
    if not cwd:
        return None
    if cwd.endswith('/rig'):
        return 'rig'
    if '/deacon' in cwd:
        return 'deacon'
    if '/mayor' in cwd:
        return 'mayor'
    if '/witness' in cwd:
        return 'witness'
    if '/refinery' in cwd and '/rig' not in cwd:
        return 'refinery'
    if '/polecats/' in cwd:
        return 'polecat'
    # Generic gastown directory (e.g., /gt or /gt/something)
    if cwd.endswith('/gt') or '/gt/' in cwd:
        return 'gastown'
    return None


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

        elif tool_name == 'Skill':
            skill_name = tool_input.get('skill', '')
            args = tool_input.get('args', '')
            if skill_name:
                if args:
                    return f"Running /{skill_name} {args[:30]}"
                return f"Running /{skill_name} skill"
            return "Running skill"

        elif tool_name == 'AskUserQuestion':
            questions = tool_input.get('questions', [])
            if questions and isinstance(questions, list):
                first_q = questions[0].get('question', '')[:40] if questions else ''
                return f"Asking: {first_q}" if first_q else "Asking user question"
            return "Asking user question"

        elif tool_name and tool_name.startswith('mcp__'):
            # MCP tool - extract meaningful name
            parts = tool_name.split('__')
            if len(parts) >= 3:
                server = parts[1]
                action = parts[2]
                return f"{server}: {action}"
            return f"MCP: {tool_name[5:]}"

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


def extract_jsonl_metadata(jsonl_file: Path, activity_tracker: callable = None) -> dict:
    """Extract metadata from a JSONL file.

    Uses caching based on file mtime to avoid re-parsing unchanged files.

    Args:
        jsonl_file: Path to the JSONL file
        activity_tracker: Optional callback to update activity timestamp
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
        'startTimestamp': '',  # Session start time
        'file_mtime': current_mtime,
        'recentActivity': [],
        '_fallback_slug': fallback_slug,  # Store for later use
    }

    # Track cumulative token usage for cost calculation
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

        # Read first few lines to get session start time
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

                            # Accumulate all usage for cost calculation
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

        # Add token percentage
        metadata['tokenPercentage'] = get_token_percentage(metadata['contextTokens'])

        # Add estimated cost
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
    if activity_tracker:
        activity_tracker()

    return metadata


def cwd_to_project_slug(cwd: str) -> str:
    """Convert a cwd path to the project slug format used by Claude."""
    # Claude uses paths like: -Users-nathan-norman-projectname
    # Note: keeps leading dash, replaces /, ., and _ with -
    return cwd.replace('/', '-').replace('.', '-').replace('_', '-')


def extract_text_content(message: dict) -> str:
    """Extract text from message content."""
    content = message.get('content', [])
    if isinstance(content, str):
        return content

    texts = []
    for item in content:
        if isinstance(item, dict) and item.get('type') == 'text':
            texts.append(item.get('text', ''))

    return '\n'.join(texts)


def extract_tool_calls(content: list) -> list[str]:
    """Extract tool call summaries from content with details."""
    tools = []
    for item in content:
        if isinstance(item, dict) and item.get('type') == 'tool_use':
            tool_name = item.get('name', 'Unknown')
            tool_input = item.get('input', {})

            # Build informative summary based on tool type
            if tool_name == 'Read':
                path = tool_input.get('file_path', '')
                filename = path.split('/')[-1] if path else 'file'
                tools.append(f"Read {filename}")
            elif tool_name == 'Write':
                path = tool_input.get('file_path', '')
                filename = path.split('/')[-1] if path else 'file'
                tools.append(f"Write {filename}")
            elif tool_name == 'Edit':
                path = tool_input.get('file_path', '')
                filename = path.split('/')[-1] if path else 'file'
                tools.append(f"Edit {filename}")
            elif tool_name == 'Bash':
                cmd = tool_input.get('command', '')[:40]
                desc = tool_input.get('description', '')
                if desc:
                    tools.append(f"Bash: {desc[:40]}")
                elif cmd:
                    tools.append(f"Bash: {cmd}")
                else:
                    tools.append("Bash")
            elif tool_name == 'Grep':
                pattern = tool_input.get('pattern', '')[:25]
                tools.append(f"Grep '{pattern}'")
            elif tool_name == 'Glob':
                pattern = tool_input.get('pattern', '')[:25]
                tools.append(f"Glob {pattern}")
            elif tool_name == 'Task':
                desc = tool_input.get('description', '')[:30]
                tools.append(f"Task: {desc}" if desc else "Task")
            elif tool_name == 'TodoWrite':
                tools.append("Update todos")
            elif tool_name == 'WebFetch':
                url = tool_input.get('url', '')
                # Extract domain from URL
                domain = url.split('/')[2] if url.count('/') >= 2 else url[:30]
                tools.append(f"Fetch {domain}")
            else:
                tools.append(tool_name)
    return tools


def get_session_metadata(session_id: str, activity_tracker: callable = None) -> dict | None:
    """Get metadata for a specific session ID from its JSONL file."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return None

    # Search all project directories for the session file
    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        jsonl_file = project_dir / f"{session_id}.jsonl"
        if jsonl_file.exists():
            return extract_jsonl_metadata(jsonl_file, activity_tracker)

    return None


def get_recent_session_for_project(project_slug: str, activity_tracker: callable = None) -> dict | None:
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
    return extract_jsonl_metadata(best_file, activity_tracker)

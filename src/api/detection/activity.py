"""Activity extraction and timeline generation for Claude sessions.

This module provides functions for:
- Extracting activity periods from JSONL files
- Generating session timelines
- Bucketing events into activity periods
- Extracting discrete event markers for timeline visualization
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .jsonl_parser import extract_activity

logger = logging.getLogger(__name__)


def extract_event_markers(events: list[dict], session_info: Optional[dict] = None) -> list[dict]:
    """Extract discrete point-in-time events for timeline markers.

    Scans events for significant discrete moments like compactions, agent spawns,
    and test runs. Only includes notable events, not routine user prompts.

    Args:
        events: List of events from extract_session_timeline()
        session_info: Optional session metadata dict

    Returns:
        List of marker dicts: {type, icon, timestamp, label}
    """
    markers = []

    for event in events:
        timestamp = event.get('timestamp')
        if not timestamp:
            continue

        event_type = event.get('type', '')
        tool = event.get('tool', '')
        activity = event.get('activity', '')

        # Compaction events (from summary type with "compacted" in activity)
        if event_type == 'summary' or (activity and 'compacted' in activity.lower()):
            markers.append({
                'type': 'compaction',
                'icon': '\U0001F5DC\uFE0F',  # 🗜️
                'timestamp': timestamp,
                'label': 'Context compacted'
            })
            continue

        # Agent spawns (Task tool)
        if tool == 'Task':
            # Extract agent description from activity
            desc = activity[:30] if activity else 'agent'
            markers.append({
                'type': 'agent_spawn',
                'icon': '\U0001F916',  # 🤖
                'timestamp': timestamp,
                'label': f'Spawned: {desc}'
            })
            continue

        # Test runs (Bash with test commands)
        if tool == 'Bash' and activity:
            activity_lower = activity.lower()
            test_commands = ['pytest', 'jest', 'npm test', 'npm run test', 'cargo test',
                            'go test', 'mvn test', 'gradle test', 'rspec', 'mocha']
            if any(tc in activity_lower for tc in test_commands):
                # Truncate command for display
                cmd_display = activity[:40] + '...' if len(activity) > 40 else activity
                markers.append({
                    'type': 'test_run',
                    'icon': '\U0001F9EA',  # 🧪
                    'timestamp': timestamp,
                    'label': f'Tests: {cmd_display}'
                })
                continue

        # Note: User prompts are intentionally NOT included as markers
        # They're too frequent and create visual clutter

    return dedupe_markers(markers)


def dedupe_markers(markers: list[dict], min_gap_seconds: int = 60) -> list[dict]:
    """Remove markers that are too close together to prevent visual overlap.

    Groups markers by type and removes duplicates within min_gap_seconds.
    Keeps the first occurrence in each cluster.

    Args:
        markers: List of marker dicts with timestamps
        min_gap_seconds: Minimum seconds between markers of the same type

    Returns:
        Deduplicated list of markers
    """
    if not markers:
        return []

    # Sort by timestamp
    sorted_markers = sorted(markers, key=lambda m: m.get('timestamp', ''))

    # Track last timestamp per marker type
    last_ts_by_type: dict[str, datetime] = {}
    result = []

    for marker in sorted_markers:
        marker_type = marker.get('type', '')
        ts_str = marker.get('timestamp', '')

        try:
            ts = datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
        except (ValueError, AttributeError):
            continue

        # Check if enough time has passed since last marker of this type
        last_ts = last_ts_by_type.get(marker_type)
        if last_ts is None or (ts - last_ts).total_seconds() >= min_gap_seconds:
            result.append(marker)
            last_ts_by_type[marker_type] = ts

    return result


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

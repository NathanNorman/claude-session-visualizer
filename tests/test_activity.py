"""Tests for activity extraction and timeline generation."""

from datetime import datetime

from src.api.detection.activity import (
    extract_session_timeline,
    get_activity_periods,
)


class TestExtractSessionTimeline:
    """Tests for extract_session_timeline function."""

    def test_empty_file(self, tmp_path):
        """Test with empty JSONL file."""
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text("")

        events = extract_session_timeline(jsonl_file)
        assert events == []

    def test_extracts_tool_use(self, tmp_path):
        """Test extraction of tool use events."""
        # JSONL requires each JSON object on a single line
        jsonl_content = '{"timestamp": "2024-01-01T12:00:00Z", "type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/test.py"}}]}}'
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text(jsonl_content)

        events = extract_session_timeline(jsonl_file)

        assert len(events) >= 1
        tool_events = [e for e in events if e.get('tool') == 'Read']
        assert len(tool_events) == 1
        assert tool_events[0]['activity'] == 'Reading test.py'

    def test_extracts_user_prompt(self, tmp_path):
        """Test extraction of user prompt events."""
        jsonl_content = '{"timestamp": "2024-01-01T12:00:00Z", "type": "user", "message": {"content": [{"type": "text", "text": "Please fix the bug"}]}}'
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text(jsonl_content)

        events = extract_session_timeline(jsonl_file)

        user_events = [e for e in events if e.get('tool') == 'human']
        assert len(user_events) == 1
        assert 'User: Please fix the bug' in user_events[0]['activity']

    def test_extracts_text_content(self, tmp_path):
        """Test extraction of assistant text responses."""
        jsonl_content = '{"timestamp": "2024-01-01T12:00:00Z", "type": "assistant", "message": {"content": [{"type": "text", "text": "I will now fix the authentication bug."}]}}'
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text(jsonl_content)

        events = extract_session_timeline(jsonl_file)

        text_events = [e for e in events if e.get('type') == 'text']
        assert len(text_events) >= 1
        assert 'authentication bug' in text_events[0]['activity']

    def test_skips_invalid_json(self, tmp_path):
        """Test that invalid JSON lines are skipped."""
        jsonl_content = '''{"timestamp": "2024-01-01T12:00:00Z", "type": "user"}
invalid json line
{"timestamp": "2024-01-01T12:01:00Z", "type": "assistant"}'''
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text(jsonl_content)

        events = extract_session_timeline(jsonl_file)
        # Should have 2 events (skipping the invalid line)
        assert len(events) == 2

    def test_skips_lines_without_timestamp(self, tmp_path):
        """Test that lines without timestamp are skipped."""
        jsonl_content = '''{"type": "user", "message": {"content": "test"}}
{"timestamp": "2024-01-01T12:00:00Z", "type": "assistant"}'''
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text(jsonl_content)

        events = extract_session_timeline(jsonl_file)
        assert len(events) == 1

    def test_nonexistent_file(self, tmp_path):
        """Test with nonexistent file."""
        jsonl_file = tmp_path / "nonexistent.jsonl"
        events = extract_session_timeline(jsonl_file)
        assert events == []

    def test_multiple_tool_calls(self, tmp_path):
        """Test extraction of multiple tool calls in one message."""
        jsonl_content = '{"timestamp": "2024-01-01T12:00:00Z", "type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/a.py"}}, {"type": "tool_use", "name": "Read", "input": {"file_path": "/b.py"}}]}}'
        jsonl_file = tmp_path / "test.jsonl"
        jsonl_file.write_text(jsonl_content)

        events = extract_session_timeline(jsonl_file)

        tool_events = [e for e in events if e.get('tool') == 'Read']
        assert len(tool_events) == 2


class TestGetActivityPeriods:
    """Tests for get_activity_periods function."""

    def test_empty_events(self):
        """Test with empty event list."""
        periods = get_activity_periods([])
        assert periods == []

    def test_single_active_event(self):
        """Test with single active event."""
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'tool': 'Read',
                'activity': 'Reading file'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        assert len(periods) == 1
        assert periods[0]['state'] == 'active'
        assert 'Reading file' in periods[0]['activities']
        assert periods[0]['tools']['Read'] == 1

    def test_events_bucketed_by_time(self):
        """Test that events are bucketed by time."""
        # Events 10 minutes apart should be in different buckets (with 5 min bucket size)
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'First activity'
            },
            {
                'timestamp': '2024-01-01T12:10:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Second activity'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        assert len(periods) == 2

    def test_events_in_same_bucket(self):
        """Test that events within bucket time are combined."""
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Activity 1'
            },
            {
                'timestamp': '2024-01-01T12:01:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Activity 2'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        # Should be in same bucket
        assert len(periods) == 1
        assert len(periods[0]['activities']) == 2

    def test_dedupes_consecutive_activities(self):
        """Test that consecutive identical activities are deduped."""
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Same activity'
            },
            {
                'timestamp': '2024-01-01T12:00:30Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Same activity'
            },
            {
                'timestamp': '2024-01-01T12:01:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Same activity'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        # Should dedupe consecutive same activities
        assert len(periods) == 1
        assert len(periods[0]['activities']) == 1

    def test_tool_counts(self):
        """Test that tool usage is counted."""
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'tool': 'Read',
                'activity': 'Reading file1'
            },
            {
                'timestamp': '2024-01-01T12:01:00Z',
                'type': 'tool_use',
                'active': True,
                'tool': 'Read',
                'activity': 'Reading file2'
            },
            {
                'timestamp': '2024-01-01T12:02:00Z',
                'type': 'tool_use',
                'active': True,
                'tool': 'Edit',
                'activity': 'Editing file'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        assert len(periods) == 1
        assert periods[0]['tools']['Read'] == 2
        assert periods[0]['tools']['Edit'] == 1

    def test_inactive_events_ignored(self):
        """Test that inactive events don't create periods."""
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'unknown',
                'active': False
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        # No active events, so no periods
        assert len(periods) == 0

    def test_handles_invalid_timestamps(self):
        """Test graceful handling of invalid timestamps."""
        events = [
            {
                'timestamp': 'not-a-valid-timestamp',
                'type': 'tool_use',
                'active': True
            },
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Valid event'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        # Should skip invalid timestamp and process valid one
        assert len(periods) == 1

    def test_sorts_events_by_timestamp(self):
        """Test that events are sorted by timestamp."""
        events = [
            {
                'timestamp': '2024-01-01T12:10:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Second'
            },
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'First'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        # Should be sorted - first activity in first period
        assert periods[0]['activities'][0] == 'First'

    def test_limits_activities_per_bucket(self):
        """Test that activities are limited to last 10 per bucket."""
        events = [
            {
                'timestamp': f'2024-01-01T12:0{i}:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': f'Activity {i}'
            }
            for i in range(5)  # 5 unique activities within bucket
        ]

        periods = get_activity_periods(events, bucket_minutes=10)

        # Should have at most 10 activities
        assert len(periods[0]['activities']) <= 10

    def test_period_timestamps(self):
        """Test that period start/end timestamps are ISO formatted."""
        events = [
            {
                'timestamp': '2024-01-01T12:00:00Z',
                'type': 'tool_use',
                'active': True,
                'activity': 'Activity'
            }
        ]

        periods = get_activity_periods(events, bucket_minutes=5)

        # Should have ISO formatted timestamps
        assert 'T' in periods[0]['start']
        assert 'T' in periods[0]['end']
        # Verify parseable
        datetime.fromisoformat(periods[0]['start'].replace('Z', '+00:00'))
        datetime.fromisoformat(periods[0]['end'].replace('Z', '+00:00'))

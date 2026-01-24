"""Tests for session detector functions."""

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from src.api.detection.matcher import match_process_to_session


class TestMatchProcessToSession:
    """Tests for process-to-session matching."""

    def test_empty_sessions_returns_none(self):
        """Test that empty session list returns None."""
        proc = {'start_time': 1000.0}
        assert match_process_to_session(proc, []) is None

    def test_no_start_time_uses_most_recent(self):
        """Test fallback to most recent when no start time."""
        proc = {'pid': 123}  # No start_time
        sessions = [
            {'sessionId': 'old', 'file_mtime': 100.0},
            {'sessionId': 'new', 'file_mtime': 200.0},
        ]

        result = match_process_to_session(proc, sessions)
        assert result['sessionId'] == 'new'

    def test_matches_closest_start_time(self):
        """Test matching session with closest start time."""
        proc = {'start_time': 1000.0}

        # Create sessions with different start times
        sessions = [
            {
                'sessionId': 'early',
                'startTimestamp': '2024-01-01T00:00:00Z',
                'file_mtime': 100.0
            },
            {
                'sessionId': 'close',
                'startTimestamp': datetime.fromtimestamp(1001.0, tz=timezone.utc).isoformat(),
                'file_mtime': 200.0
            },
            {
                'sessionId': 'late',
                'startTimestamp': '2025-01-01T00:00:00Z',
                'file_mtime': 300.0
            },
        ]

        result = match_process_to_session(proc, sessions)
        assert result['sessionId'] == 'close'

    def test_handles_missing_timestamps(self):
        """Test handling of sessions without timestamps."""
        proc = {'start_time': 1000.0}
        sessions = [
            {'sessionId': 'no-ts', 'file_mtime': 100.0},  # No startTimestamp
            {'sessionId': 'has-ts', 'startTimestamp': '2024-01-01T00:00:00Z', 'file_mtime': 200.0},
        ]

        # Should still return a result (falling back or matching the one with timestamp)
        result = match_process_to_session(proc, sessions)
        assert result is not None

    def test_handles_invalid_timestamps(self):
        """Test handling of invalid timestamp formats."""
        proc = {'start_time': 1000.0}
        sessions = [
            {'sessionId': 'invalid', 'startTimestamp': 'not-a-date', 'file_mtime': 100.0},
            {'sessionId': 'valid', 'startTimestamp': '2024-01-01T00:00:00Z', 'file_mtime': 200.0},
        ]

        # Should skip invalid and match valid
        result = match_process_to_session(proc, sessions)
        assert result['sessionId'] == 'valid'


class TestCacheCleanup:
    """Tests for cache cleanup functionality."""

    def test_cleanup_stale_caches_exists(self):
        """Test that cleanup_stale_caches function exists."""
        from src.api.session_detector import cleanup_stale_caches
        assert callable(cleanup_stale_caches)

    def test_cleanup_with_empty_state_files(self):
        """Test cleanup with empty state files set."""
        from src.api.session_detector import cleanup_stale_caches

        # Should not raise even with empty set
        cleanup_stale_caches(set())


class TestActivityTimestamp:
    """Tests for activity timestamp tracking."""

    def test_update_and_get_timestamp(self):
        """Test updating and retrieving activity timestamp."""
        from src.api.session_detector import (
            update_activity_timestamp,
            get_activity_timestamp
        )

        # Update timestamp
        update_activity_timestamp()
        ts = get_activity_timestamp()

        assert ts > 0
        assert isinstance(ts, float)


class TestGetSessions:
    """Tests for get_sessions function."""

    @patch('src.api.session_detector.get_claude_processes')
    @patch('src.api.session_detector.get_all_active_state_files')
    def test_returns_list(self, mock_state_files, mock_processes):
        """Test that get_sessions returns a list."""
        mock_processes.return_value = []
        mock_state_files.return_value = {}

        from src.api.session_detector import get_sessions
        result = get_sessions()

        assert isinstance(result, list)

    @patch('src.api.session_detector.get_claude_processes')
    @patch('src.api.session_detector.get_all_active_state_files')
    def test_empty_when_no_processes(self, mock_state_files, mock_processes):
        """Test empty result when no processes."""
        mock_processes.return_value = []
        mock_state_files.return_value = {}

        from src.api.session_detector import get_sessions
        result = get_sessions()

        assert result == []

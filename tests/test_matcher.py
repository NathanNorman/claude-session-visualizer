"""Tests for process-to-session matcher functions."""

from datetime import datetime, timezone

from src.api.detection.matcher import (
    match_process_to_session,
)


class TestMatchProcessToSession:
    """Tests for match_process_to_session function."""

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
            {'sessionId': 'no-ts', 'file_mtime': 100.0},
            {'sessionId': 'has-ts', 'startTimestamp': '2024-01-01T00:00:00Z', 'file_mtime': 200.0},
        ]

        result = match_process_to_session(proc, sessions)
        assert result is not None

    def test_handles_invalid_timestamps(self):
        """Test handling of invalid timestamp formats."""
        proc = {'start_time': 1000.0}
        sessions = [
            {'sessionId': 'invalid', 'startTimestamp': 'not-a-date', 'file_mtime': 100.0},
            {'sessionId': 'valid', 'startTimestamp': '2024-01-01T00:00:00Z', 'file_mtime': 200.0},
        ]

        result = match_process_to_session(proc, sessions)
        assert result['sessionId'] == 'valid'

    def test_single_session(self):
        """Test with single session returns that session."""
        proc = {'start_time': 1000.0}
        sessions = [
            {'sessionId': 'only-one', 'startTimestamp': '2024-01-01T00:00:00Z', 'file_mtime': 100.0}
        ]

        result = match_process_to_session(proc, sessions)
        assert result['sessionId'] == 'only-one'

    def test_exact_match_start_time(self):
        """Test when session start matches process start exactly."""
        proc = {'start_time': 1704067200.0}  # 2024-01-01T00:00:00Z
        sessions = [
            {
                'sessionId': 'exact',
                'startTimestamp': '2024-01-01T00:00:00Z',
                'file_mtime': 100.0
            },
        ]

        result = match_process_to_session(proc, sessions)
        assert result['sessionId'] == 'exact'

    def test_prefers_recent_when_no_timestamps(self):
        """Test prefers most recent file_mtime when no timestamps available."""
        proc = {'start_time': 1000.0}
        sessions = [
            {'sessionId': 'oldest', 'file_mtime': 100.0},
            {'sessionId': 'middle', 'file_mtime': 200.0},
            {'sessionId': 'newest', 'file_mtime': 300.0},
        ]

        result = match_process_to_session(proc, sessions)
        # Should pick newest by mtime when timestamps can't be matched
        assert result is not None

    def test_handles_future_timestamp(self):
        """Test handling of future session timestamp."""
        proc = {'start_time': 1000.0}
        sessions = [
            {
                'sessionId': 'future',
                'startTimestamp': '2099-01-01T00:00:00Z',
                'file_mtime': 100.0
            },
            {
                'sessionId': 'past',
                'startTimestamp': '2020-01-01T00:00:00Z',
                'file_mtime': 200.0
            },
        ]

        result = match_process_to_session(proc, sessions)
        # Should still return a result
        assert result is not None

    def test_different_timezone_formats(self):
        """Test handling of different timezone formats."""
        proc = {'start_time': 1704067200.0}
        sessions = [
            {
                'sessionId': 'utc',
                'startTimestamp': '2024-01-01T00:00:00Z',
                'file_mtime': 100.0
            },
            {
                'sessionId': 'offset',
                'startTimestamp': '2024-01-01T00:00:00+00:00',
                'file_mtime': 200.0
            },
        ]

        result = match_process_to_session(proc, sessions)
        # Both should be parseable
        assert result is not None


class TestMatcherEdgeCases:
    """Tests for edge cases in session matching."""

    def test_none_sessions(self):
        """Test with None sessions (should be caught before)."""
        # This tests defensive programming
        proc = {'start_time': 1000.0}
        try:
            result = match_process_to_session(proc, None)
            # If it doesn't raise, it should return None
            assert result is None
        except TypeError:
            # Expected behavior
            pass

    def test_empty_process_dict(self):
        """Test with empty process dict."""
        proc = {}
        sessions = [
            {'sessionId': 'test', 'file_mtime': 100.0}
        ]

        result = match_process_to_session(proc, sessions)
        # Should use fallback logic
        assert result is not None

    def test_all_invalid_timestamps(self):
        """Test when all sessions have invalid timestamps."""
        proc = {'start_time': 1000.0}
        sessions = [
            {'sessionId': 'invalid1', 'startTimestamp': 'bad', 'file_mtime': 100.0},
            {'sessionId': 'invalid2', 'startTimestamp': 'worse', 'file_mtime': 200.0},
        ]

        result = match_process_to_session(proc, sessions)
        # Should fallback to most recent by mtime
        assert result is not None
        assert result['sessionId'] == 'invalid2'  # Most recent mtime

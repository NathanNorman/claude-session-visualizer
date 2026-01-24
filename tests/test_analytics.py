"""Tests for analytics database operations."""

import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from src.api.analytics import (
    init_database,
    record_session_snapshot,
    get_analytics,
    get_session_history,
    save_activity_summary,
    get_activity_summaries,
    get_last_activity_hash,
)


@pytest.fixture
def temp_db():
    """Create a temporary database for testing."""
    with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as f:
        db_path = Path(f.name)

    with patch('src.api.analytics.DB_PATH', db_path):
        init_database()
        yield db_path

    # Cleanup
    db_path.unlink(missing_ok=True)


class TestDatabaseInit:
    """Tests for database initialization."""

    def test_creates_tables(self, temp_db):
        """Test that all tables are created."""
        with sqlite3.connect(temp_db) as conn:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
            tables = {row[0] for row in cursor.fetchall()}

        assert 'sessions' in tables
        assert 'session_snapshots' in tables
        assert 'activity_summaries' in tables
        assert 'activity_summary_state' in tables

    def test_creates_indexes(self, temp_db):
        """Test that indexes are created."""
        with sqlite3.connect(temp_db) as conn:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
            indexes = {row[0] for row in cursor.fetchall()}

        assert 'idx_sessions_start_time' in indexes
        assert 'idx_sessions_cwd' in indexes
        assert 'idx_sessions_cwd_start_time' in indexes  # New composite index


class TestRecordSessionSnapshot:
    """Tests for recording session snapshots."""

    def test_records_session(self, temp_db):
        """Test basic session recording."""
        session = {
            'sessionId': 'test-session-123',
            'slug': 'test-project',
            'cwd': '/Users/test/project',
            'gitBranch': 'main',
            'state': 'active',
            'contextTokens': 50000,
        }

        with patch('src.api.analytics.DB_PATH', temp_db):
            record_session_snapshot(session)

        with sqlite3.connect(temp_db) as conn:
            cursor = conn.execute(
                "SELECT id, slug, cwd, state FROM sessions WHERE id = ?",
                ('test-session-123',)
            )
            row = cursor.fetchone()

        assert row is not None
        assert row[1] == 'test-project'
        assert row[2] == '/Users/test/project'
        assert row[3] == 'active'

    def test_handles_missing_session_id(self, temp_db):
        """Test that sessions without ID are skipped."""
        session = {'slug': 'test', 'cwd': '/path'}

        with patch('src.api.analytics.DB_PATH', temp_db):
            record_session_snapshot(session)  # Should not raise

        with sqlite3.connect(temp_db) as conn:
            cursor = conn.execute("SELECT COUNT(*) FROM sessions")
            count = cursor.fetchone()[0]

        assert count == 0


class TestActivitySummaries:
    """Tests for activity summary storage."""

    def test_save_and_retrieve(self, temp_db):
        """Test saving and retrieving activity summaries."""
        session_id = 'test-session'
        summary = 'User implemented a new feature'
        activity_hash = 'abc123'

        with patch('src.api.analytics.DB_PATH', temp_db):
            save_activity_summary(session_id, summary, activity_hash)
            summaries = get_activity_summaries(session_id)

        assert len(summaries) == 1
        assert summaries[0]['summary'] == summary
        assert summaries[0]['hash'] == activity_hash

    def test_get_last_hash(self, temp_db):
        """Test getting last activity hash."""
        session_id = 'test-session'

        with patch('src.api.analytics.DB_PATH', temp_db):
            # Initially None
            assert get_last_activity_hash(session_id) is None

            # After saving
            save_activity_summary(session_id, 'Summary 1', 'hash1')
            assert get_last_activity_hash(session_id) == 'hash1'

            # After update
            save_activity_summary(session_id, 'Summary 2', 'hash2')
            assert get_last_activity_hash(session_id) == 'hash2'


class TestGetAnalytics:
    """Tests for analytics retrieval."""

    def test_empty_database(self, temp_db):
        """Test analytics on empty database."""
        with patch('src.api.analytics.DB_PATH', temp_db):
            result = get_analytics('week')

        assert result['total_sessions'] == 0
        assert result['total_tokens'] == 0
        assert result['estimated_cost'] == 0

    def test_returns_expected_keys(self, temp_db):
        """Test that all expected keys are present."""
        with patch('src.api.analytics.DB_PATH', temp_db):
            result = get_analytics('week')

        expected_keys = [
            'period', 'total_sessions', 'total_sessions_change',
            'total_tokens', 'total_tokens_change',
            'estimated_cost', 'estimated_cost_change',
            'active_time_hours', 'active_time_change',
            'time_breakdown', 'top_repos', 'activity_by_hour',
            'peak_hour', 'duration_distribution'
        ]

        for key in expected_keys:
            assert key in result


class TestGetSessionHistory:
    """Tests for session history retrieval."""

    def test_empty_history(self, temp_db):
        """Test history on empty database."""
        with patch('src.api.analytics.DB_PATH', temp_db):
            result = get_session_history()

        assert result['sessions'] == []
        assert result['total'] == 0
        assert result['page'] == 1

    def test_pagination_info(self, temp_db):
        """Test pagination information."""
        with patch('src.api.analytics.DB_PATH', temp_db):
            result = get_session_history(page=2, per_page=10)

        assert result['page'] == 2
        assert result['per_page'] == 10
        assert result['total_pages'] >= 1

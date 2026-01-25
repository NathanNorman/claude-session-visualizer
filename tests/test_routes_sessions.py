"""Tests for session routes."""

from datetime import datetime
from unittest.mock import patch, MagicMock
import signal

import pytest
from fastapi.testclient import TestClient

from src.api.server import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


class TestGetSessions:
    """Tests for GET /api/sessions endpoint."""

    @patch('src.api.routes.sessions.get_sessions')
    def test_returns_sessions_list(self, mock_get, client):
        """Test endpoint returns sessions list."""
        mock_get.return_value = [
            {'sessionId': 'test-1', 'state': 'active'},
            {'sessionId': 'test-2', 'state': 'waiting'},
        ]

        response = client.get('/api/sessions')

        assert response.status_code == 200
        data = response.json()
        assert 'sessions' in data
        assert 'timestamp' in data
        assert len(data['sessions']) == 2

    @patch('src.api.routes.sessions.get_sessions')
    def test_returns_empty_list(self, mock_get, client):
        """Test endpoint returns empty list when no sessions."""
        mock_get.return_value = []

        response = client.get('/api/sessions')

        assert response.status_code == 200
        data = response.json()
        assert data['sessions'] == []

    @patch('src.api.routes.sessions.get_sessions')
    def test_includes_timestamp(self, mock_get, client):
        """Test response includes ISO timestamp."""
        mock_get.return_value = []

        response = client.get('/api/sessions')

        data = response.json()
        # Should be a valid ISO timestamp
        timestamp = datetime.fromisoformat(data['timestamp'].replace('Z', '+00:00'))
        assert timestamp is not None


class TestCheckSessionsChanged:
    """Tests for GET /api/sessions/changed endpoint."""

    @patch('src.api.routes.sessions.get_activity_timestamp')
    @patch('src.api.routes.sessions.get_all_active_state_files')
    def test_returns_changed_true_when_newer(self, mock_files, mock_ts, client):
        """Test returns changed=true when activity is newer than since."""
        mock_files.return_value = {}
        mock_ts.return_value = 1000.0

        response = client.get('/api/sessions/changed?since=500')

        assert response.status_code == 200
        data = response.json()
        assert data['changed'] is True
        assert data['timestamp'] == 1000.0

    @patch('src.api.routes.sessions.get_activity_timestamp')
    @patch('src.api.routes.sessions.get_all_active_state_files')
    def test_returns_changed_false_when_older(self, mock_files, mock_ts, client):
        """Test returns changed=false when activity is older than since."""
        mock_files.return_value = {}
        mock_ts.return_value = 500.0

        response = client.get('/api/sessions/changed?since=1000')

        assert response.status_code == 200
        data = response.json()
        assert data['changed'] is False

    @patch('src.api.routes.sessions.get_activity_timestamp')
    @patch('src.api.routes.sessions.get_all_active_state_files')
    def test_default_since_zero(self, mock_files, mock_ts, client):
        """Test default since=0 means always changed."""
        mock_files.return_value = {}
        mock_ts.return_value = 1.0  # Any positive value

        response = client.get('/api/sessions/changed')

        data = response.json()
        assert data['changed'] is True


class TestGetGraveyardSessions:
    """Tests for GET /api/sessions/graveyard endpoint."""

    @patch('src.api.routes.sessions.get_dead_sessions')
    def test_returns_dead_sessions(self, mock_get, client):
        """Test endpoint returns dead sessions."""
        mock_get.return_value = [
            {'sessionId': 'dead-1', 'state': 'dead', 'isGastown': False},
            {'sessionId': 'dead-2', 'state': 'dead', 'isGastown': True},
        ]

        response = client.get('/api/sessions/graveyard')

        assert response.status_code == 200
        data = response.json()
        assert len(data['sessions']) == 2
        assert len(data['gastown']) == 1
        assert len(data['regular']) == 1
        assert data['count'] == 2

    @patch('src.api.routes.sessions.get_dead_sessions')
    def test_respects_hours_param(self, mock_get, client):
        """Test hours parameter is passed to get_dead_sessions."""
        mock_get.return_value = []

        client.get('/api/sessions/graveyard?hours=48')

        mock_get.assert_called_once_with(max_age_hours=48)


class TestSearchGraveyardSessions:
    """Tests for GET /api/sessions/graveyard/search endpoint."""

    @patch('src.api.routes.sessions.search_dead_sessions')
    def test_search_with_query(self, mock_search, client):
        """Test search with query parameter."""
        mock_search.return_value = [
            {'sessionId': 'match-1', 'isGastown': False}
        ]

        response = client.get('/api/sessions/graveyard/search?q=test')

        assert response.status_code == 200
        mock_search.assert_called_once_with(query='test', max_age_hours=168, search_content=False)

    @patch('src.api.routes.sessions.search_dead_sessions')
    def test_empty_query_returns_empty(self, mock_search, client):
        """Test empty query returns empty results without searching."""
        response = client.get('/api/sessions/graveyard/search?q=')

        assert response.status_code == 200
        data = response.json()
        assert data['sessions'] == []
        assert data['count'] == 0
        mock_search.assert_not_called()

    @patch('src.api.routes.sessions.search_dead_sessions')
    def test_content_search_param(self, mock_search, client):
        """Test content search parameter."""
        mock_search.return_value = []

        client.get('/api/sessions/graveyard/search?q=test&content=true')

        mock_search.assert_called_once_with(query='test', max_age_hours=168, search_content=True)


class TestGetTimelineSessions:
    """Tests for GET /api/timeline/sessions endpoint."""

    @patch('src.api.routes.sessions.get_sessions')
    @patch('src.api.routes.sessions.get_all_sessions')
    def test_returns_timeline_sessions(self, mock_all, mock_running, client):
        """Test timeline sessions endpoint."""
        mock_all.return_value = [
            {'sessionId': 'run-1'},
            {'sessionId': 'closed-1'},
        ]
        mock_running.return_value = [{'sessionId': 'run-1'}]

        response = client.get('/api/timeline/sessions')

        assert response.status_code == 200
        data = response.json()
        sessions = data['sessions']

        # Check isRunning flag is set correctly
        running = [s for s in sessions if s['sessionId'] == 'run-1'][0]
        closed = [s for s in sessions if s['sessionId'] == 'closed-1'][0]

        assert running['isRunning'] is True
        assert running['state'] == 'active'
        assert closed['isRunning'] is False
        assert closed['state'] == 'closed'


class TestGetSessionTimeline:
    """Tests for GET /api/session/{session_id}/timeline endpoint."""

    @patch('src.api.routes.sessions.get_activity_periods')
    @patch('src.api.routes.sessions.extract_session_timeline')
    @patch('src.api.routes.sessions.CLAUDE_PROJECTS_DIR')
    def test_returns_timeline(self, mock_dir, mock_extract, mock_periods, client, tmp_path):
        """Test session timeline endpoint."""
        # Setup mock directory structure
        project_dir = tmp_path / "project"
        project_dir.mkdir()
        jsonl_file = project_dir / "test-session.jsonl"
        jsonl_file.write_text('{"test": true}')

        mock_dir.exists.return_value = True
        mock_dir.iterdir.return_value = [project_dir]

        mock_extract.return_value = [{'timestamp': '2024-01-01T12:00:00Z'}]
        mock_periods.return_value = [{'start': '2024-01-01T12:00:00Z', 'state': 'active'}]

        response = client.get('/api/session/test-session/timeline')

        assert response.status_code == 200
        data = response.json()
        assert data['sessionId'] == 'test-session'
        assert 'activityPeriods' in data
        assert 'eventCount' in data

    @patch('src.api.routes.sessions.CLAUDE_PROJECTS_DIR')
    def test_not_found_no_directory(self, mock_dir, client):
        """Test 404 when claude projects directory doesn't exist."""
        mock_dir.exists.return_value = False

        response = client.get('/api/session/test-session/timeline')

        assert response.status_code == 404


class TestKillSession:
    """Tests for POST /api/kill endpoint."""

    @patch('os.kill')
    def test_successful_kill(self, mock_kill, client):
        """Test successful process termination."""
        mock_kill.return_value = None

        response = client.post('/api/kill', json={'pid': 12345})

        assert response.status_code == 200
        data = response.json()
        assert data['success'] is True
        assert data['pid'] == 12345
        mock_kill.assert_called_once_with(12345, signal.SIGTERM)

    @patch('os.kill')
    def test_process_not_found(self, mock_kill, client):
        """Test 404 when process not found."""
        mock_kill.side_effect = ProcessLookupError()

        response = client.post('/api/kill', json={'pid': 99999})

        assert response.status_code == 404

    @patch('os.kill')
    def test_permission_denied(self, mock_kill, client):
        """Test 403 when permission denied."""
        mock_kill.side_effect = PermissionError()

        response = client.post('/api/kill', json={'pid': 1})

        assert response.status_code == 403


class TestGetSessionGitInfo:
    """Tests for GET /api/sessions/{session_id}/git endpoint."""

    @patch('src.api.routes.sessions.find_related_pr')
    @patch('src.api.routes.sessions.get_diff_stats')
    @patch('src.api.routes.sessions.get_recent_commits')
    @patch('src.api.routes.sessions.get_git_status')
    @patch('src.api.routes.sessions.get_sessions')
    def test_returns_git_info(self, mock_sessions, mock_status, mock_commits,
                              mock_diff, mock_pr, client):
        """Test git info endpoint."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'cwd': '/path/to/project'}
        ]

        from src.api.git_tracker import GitStatus, GitCommit

        mock_status.return_value = GitStatus(
            branch='main', modified=['file.py'], added=[], deleted=[],
            untracked=[], ahead=1, behind=0, has_uncommitted=True
        )
        mock_commits.return_value = [
            GitCommit(sha='abc123', short_sha='abc1', message='Fix bug',
                      author='Test', timestamp='1 day ago', files_changed=1)
        ]
        mock_diff.return_value = {'files': [], 'summary': ''}
        mock_pr.return_value = None

        response = client.get('/api/sessions/test-1/git')

        assert response.status_code == 200
        data = response.json()
        assert data['status']['branch'] == 'main'
        assert len(data['commits']) == 1

    @patch('src.api.routes.sessions.get_sessions')
    def test_session_not_found(self, mock_sessions, client):
        """Test 404 when session not found."""
        mock_sessions.return_value = []

        response = client.get('/api/sessions/nonexistent/git')

        assert response.status_code == 404


class TestGetActivitySummaries:
    """Tests for GET /api/sessions/{session_id}/activity-summaries endpoint."""

    @patch('src.api.routes.sessions.db_get_activity_summaries')
    def test_returns_summaries(self, mock_get, client):
        """Test activity summaries endpoint."""
        mock_get.return_value = [
            {'summary': 'Editing files', 'hash': 'abc123', 'timestamp': '2024-01-01T12:00:00Z'}
        ]

        response = client.get('/api/sessions/test-session/activity-summaries')

        assert response.status_code == 200
        data = response.json()
        assert data['sessionId'] == 'test-session'
        assert len(data['entries']) == 1

    @patch('src.api.routes.sessions.db_get_activity_summaries')
    def test_empty_summaries(self, mock_get, client):
        """Test empty summaries list."""
        mock_get.return_value = []

        response = client.get('/api/sessions/new-session/activity-summaries')

        assert response.status_code == 200
        data = response.json()
        assert data['entries'] == []


class TestSendMessageToSession:
    """Tests for POST /api/session/{session_id}/send endpoint."""

    @patch('src.api.routes.sessions.write_to_tty')
    @patch('src.api.routes.sessions.get_sessions')
    def test_successful_send(self, mock_sessions, mock_write, client):
        """Test successful message send to session."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'state': 'active', 'tty': 's000'}
        ]
        mock_write.return_value = {'success': True, 'tty_path': '/dev/ttys000'}

        response = client.post('/api/session/test-1/send', json={
            'message': 'Hello Claude',
            'submit': True
        })

        assert response.status_code == 200
        data = response.json()
        assert data['success'] is True
        assert data['sessionId'] == 'test-1'
        assert data['tty'] == '/dev/ttys000'
        assert data['submitted'] is True
        mock_write.assert_called_once_with('s000', 'Hello Claude', True)

    @patch('src.api.routes.sessions.write_to_tty')
    @patch('src.api.routes.sessions.get_sessions')
    def test_send_without_submit(self, mock_sessions, mock_write, client):
        """Test sending message without auto-submit (no newline)."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'state': 'waiting', 'tty': 's001'}
        ]
        mock_write.return_value = {'success': True, 'tty_path': '/dev/ttys001'}

        response = client.post('/api/session/test-1/send', json={
            'message': 'partial text',
            'submit': False
        })

        assert response.status_code == 200
        data = response.json()
        assert data['submitted'] is False
        mock_write.assert_called_once_with('s001', 'partial text', False)

    @patch('src.api.routes.sessions.get_sessions')
    def test_session_not_found(self, mock_sessions, client):
        """Test 404 when session doesn't exist."""
        mock_sessions.return_value = []

        response = client.post('/api/session/nonexistent/send', json={
            'message': 'Hello'
        })

        assert response.status_code == 404
        assert 'not found' in response.json()['detail'].lower()

    @patch('src.api.routes.sessions.get_sessions')
    def test_session_is_dead(self, mock_sessions, client):
        """Test 400 when session is not running."""
        mock_sessions.return_value = [
            {'sessionId': 'dead-1', 'state': 'dead', 'tty': 's000'}
        ]

        response = client.post('/api/session/dead-1/send', json={
            'message': 'Hello'
        })

        assert response.status_code == 400
        assert 'not running' in response.json()['detail'].lower()

    @patch('src.api.routes.sessions.get_sessions')
    def test_session_no_tty(self, mock_sessions, client):
        """Test 400 when session has no TTY."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'state': 'active', 'tty': None}
        ]

        response = client.post('/api/session/test-1/send', json={
            'message': 'Hello'
        })

        assert response.status_code == 400
        assert 'no tty' in response.json()['detail'].lower()

    @patch('src.api.routes.sessions.get_sessions')
    def test_message_too_long(self, mock_sessions, client):
        """Test 400 when message exceeds 10KB limit."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'state': 'active', 'tty': 's000'}
        ]

        # Create a message > 10KB
        long_message = 'x' * 11000

        response = client.post('/api/session/test-1/send', json={
            'message': long_message
        })

        assert response.status_code == 400
        assert 'too long' in response.json()['detail'].lower()

    @patch('src.api.routes.sessions.write_to_tty')
    @patch('src.api.routes.sessions.get_sessions')
    def test_tty_not_found(self, mock_sessions, mock_write, client):
        """Test 400 when TTY device doesn't exist."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'state': 'active', 'tty': 's999'}
        ]
        mock_write.side_effect = FileNotFoundError('TTY device not found: /dev/ttys999')

        response = client.post('/api/session/test-1/send', json={
            'message': 'Hello'
        })

        assert response.status_code == 400
        assert 'not found' in response.json()['detail'].lower()

    @patch('src.api.routes.sessions.write_to_tty')
    @patch('src.api.routes.sessions.get_sessions')
    def test_tty_permission_denied(self, mock_sessions, mock_write, client):
        """Test 500 when TTY write permission denied."""
        mock_sessions.return_value = [
            {'sessionId': 'test-1', 'state': 'active', 'tty': 's000'}
        ]
        mock_write.side_effect = PermissionError()

        response = client.post('/api/session/test-1/send', json={
            'message': 'Hello'
        })

        assert response.status_code == 500
        assert 'permission denied' in response.json()['detail'].lower()


class TestWriteToTty:
    """Tests for write_to_tty helper function (AppleScript-based implementation)."""

    def test_tty_path_conversion_short_format(self):
        """Test TTY path conversion from 's000' format."""
        from src.api.routes.sessions import write_to_tty

        # Mock subprocess.run for AppleScript execution
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = 'sent'
        mock_result.stderr = ''

        with patch('subprocess.run', return_value=mock_result) as mock_run:
            result = write_to_tty('s000', 'test message', submit=True)

            # Verify subprocess was called with osascript
            mock_run.assert_called_once()
            call_args = mock_run.call_args
            assert call_args[0][0][0] == 'osascript'
            assert call_args[0][0][1] == '-e'

            # Verify script contains keystroke and return
            script = call_args[0][0][2]
            assert 'keystroke "test message"' in script
            assert 'keystroke return' in script

            assert result['success'] is True
            assert result['tty_path'] == '/dev/ttys000'

    def test_tty_path_conversion_full_format(self):
        """Test TTY path when already in full /dev/ format."""
        from src.api.routes.sessions import write_to_tty

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = 'sent'
        mock_result.stderr = ''

        with patch('subprocess.run', return_value=mock_result):
            result = write_to_tty('/dev/ttys001', 'test', submit=False)

            assert result['tty_path'] == '/dev/ttys001'

    def test_no_newline_when_submit_false(self):
        """Test no keystroke return when submit=False."""
        from src.api.routes.sessions import write_to_tty

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = 'sent'
        mock_result.stderr = ''

        with patch('subprocess.run', return_value=mock_result) as mock_run:
            write_to_tty('s000', 'test', submit=False)

            # Verify script does NOT contain keystroke return
            script = mock_run.call_args[0][0][2]
            assert 'keystroke "test"' in script
            assert 'keystroke return' not in script

    def test_raises_when_applescript_fails(self):
        """Test RuntimeError when AppleScript execution fails."""
        from src.api.routes.sessions import write_to_tty

        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ''
        mock_result.stderr = 'AppleScript error: access not allowed'

        with patch('subprocess.run', return_value=mock_result):
            with pytest.raises(RuntimeError) as exc_info:
                write_to_tty('s999', 'test')

            assert 'AppleScript error' in str(exc_info.value)

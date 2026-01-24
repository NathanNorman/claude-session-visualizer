"""Tests for session sharing routes."""

from datetime import datetime, timezone, timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.api.server import app
from src.api.routes.sharing import (
    generate_share_token,
    generate_markdown_export,
    _shared_sessions,
)


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture(autouse=True)
def clear_shared_sessions():
    """Clear shared sessions before each test."""
    _shared_sessions.clear()
    yield
    _shared_sessions.clear()


class TestGenerateShareToken:
    """Tests for generate_share_token function."""

    def test_generates_16_char_token(self):
        """Test token is 16 characters."""
        token = generate_share_token('session-123')
        assert len(token) == 16

    def test_generates_hex_token(self):
        """Test token is valid hex."""
        token = generate_share_token('session-123')
        # Should not raise
        int(token, 16)

    def test_generates_unique_tokens(self):
        """Test different calls produce different tokens."""
        token1 = generate_share_token('session-123')
        token2 = generate_share_token('session-123')
        assert token1 != token2

    def test_different_sessions_different_tokens(self):
        """Test different session IDs produce different tokens."""
        token1 = generate_share_token('session-1')
        token2 = generate_share_token('session-2')
        assert token1 != token2


class TestGenerateMarkdownExport:
    """Tests for generate_markdown_export function."""

    def test_basic_export(self):
        """Test basic markdown export."""
        session = {
            'slug': 'test-project',
            'cwd': '/path/to/project',
            'gitBranch': 'main',
            'contextTokens': 50000,
            'state': 'active',
            'recentActivity': ['Reading file.py', 'Editing config.json']
        }

        markdown = generate_markdown_export(session)

        assert '# Session: test-project' in markdown
        assert '/path/to/project' in markdown
        assert 'main' in markdown
        assert '50,000 tokens' in markdown
        assert 'active' in markdown
        assert 'Reading file.py' in markdown
        assert 'Editing config.json' in markdown

    def test_export_with_ai_summary(self):
        """Test export includes AI summary when present."""
        session = {
            'slug': 'project',
            'aiSummary': 'Working on authentication feature',
            'recentActivity': []
        }

        markdown = generate_markdown_export(session)

        assert '## AI Summary' in markdown
        assert 'Working on authentication feature' in markdown

    def test_export_without_activity(self):
        """Test export handles empty activity list."""
        session = {
            'slug': 'project',
            'recentActivity': []
        }

        markdown = generate_markdown_export(session)

        assert 'No recent activity' in markdown

    def test_export_with_missing_fields(self):
        """Test export handles missing fields gracefully."""
        session = {'slug': 'minimal'}

        markdown = generate_markdown_export(session)

        assert '# Session: minimal' in markdown
        assert 'Unknown' in markdown  # Default for missing fields


class TestCreateShareLink:
    """Tests for POST /api/sessions/{session_id}/share endpoint."""

    @patch('src.api.routes.sharing.get_sessions')
    def test_creates_share_link(self, mock_get, client):
        """Test creating a share link."""
        mock_get.return_value = [
            {'sessionId': 'test-session', 'slug': 'test', 'state': 'active'}
        ]

        response = client.post('/api/sessions/test-session/share')

        assert response.status_code == 200
        data = response.json()
        assert 'token' in data
        assert 'url' in data
        assert 'expires_at' in data
        assert len(data['token']) == 16
        assert data['url'].startswith('/shared/')

    @patch('src.api.routes.sharing.get_sessions')
    def test_custom_expiry(self, mock_get, client):
        """Test custom expiry days."""
        mock_get.return_value = [
            {'sessionId': 'test-session', 'slug': 'test'}
        ]

        response = client.post('/api/sessions/test-session/share?expires_days=30')

        assert response.status_code == 200
        data = response.json()
        expires = datetime.fromisoformat(data['expires_at'])
        # Should be about 30 days from now
        expected = datetime.now(timezone.utc) + timedelta(days=30)
        assert abs((expires - expected).days) <= 1

    @patch('src.api.routes.sharing.get_sessions')
    def test_session_not_found(self, mock_get, client):
        """Test 404 when session doesn't exist."""
        mock_get.return_value = []

        response = client.post('/api/sessions/nonexistent/share')

        assert response.status_code == 404


class TestGetSharedSession:
    """Tests for GET /api/shared/{token} endpoint."""

    def test_get_shared_session(self, client):
        """Test retrieving a shared session."""
        # Create a shared session directly
        _shared_sessions['test-token'] = {
            'session': {'sessionId': 'test', 'slug': 'test-project'},
            'created_at': datetime.now(timezone.utc).isoformat(),
            'expires_at': (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
            'created_by': 'tester',
        }

        response = client.get('/api/shared/test-token')

        assert response.status_code == 200
        data = response.json()
        assert data['session']['sessionId'] == 'test'
        assert 'created_at' in data
        assert 'expires_at' in data

    def test_token_not_found(self, client):
        """Test 404 when token doesn't exist."""
        response = client.get('/api/shared/nonexistent-token')

        assert response.status_code == 404

    def test_expired_token(self, client):
        """Test 410 when token is expired."""
        # Create an expired session
        _shared_sessions['expired-token'] = {
            'session': {'sessionId': 'test'},
            'created_at': (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(),
            'expires_at': (datetime.now(timezone.utc) - timedelta(days=3)).isoformat(),
            'created_by': 'tester',
        }

        response = client.get('/api/shared/expired-token')

        assert response.status_code == 410
        # Expired token should be removed
        assert 'expired-token' not in _shared_sessions


class TestExportSessionMarkdown:
    """Tests for POST /api/sessions/{session_id}/export endpoint."""

    @patch('src.api.routes.sharing.get_sessions')
    def test_export_markdown(self, mock_get, client):
        """Test exporting session as markdown."""
        mock_get.return_value = [
            {
                'sessionId': 'test-session',
                'slug': 'my-project',
                'cwd': '/path/to/project',
                'gitBranch': 'main',
                'contextTokens': 25000,
                'state': 'active',
                'recentActivity': ['Reading file.py']
            }
        ]

        response = client.post('/api/sessions/test-session/export')

        assert response.status_code == 200
        data = response.json()
        assert 'markdown' in data
        assert 'filename' in data
        assert data['filename'] == 'my-project.md'
        assert '# Session: my-project' in data['markdown']

    @patch('src.api.routes.sharing.get_sessions')
    def test_export_session_not_found(self, mock_get, client):
        """Test 404 when session doesn't exist."""
        mock_get.return_value = []

        response = client.post('/api/sessions/nonexistent/export')

        assert response.status_code == 404

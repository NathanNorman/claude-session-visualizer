"""Tests for analytics routes."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.api.server import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


class TestGetAnalyticsEndpoint:
    """Tests for GET /api/analytics endpoint."""

    @patch('src.api.routes.analytics.get_analytics')
    def test_default_period_is_week(self, mock_get, client):
        """Test default period is 'week'."""
        mock_get.return_value = {'period': 'week', 'total_sessions': 0}

        client.get('/api/analytics')

        mock_get.assert_called_once_with('week')

    @patch('src.api.routes.analytics.get_analytics')
    def test_accepts_period_param(self, mock_get, client):
        """Test period parameter is passed through."""
        mock_get.return_value = {'period': 'month', 'total_sessions': 0}

        client.get('/api/analytics?period=month')

        mock_get.assert_called_once_with('month')

    @patch('src.api.routes.analytics.get_analytics')
    def test_returns_analytics_data(self, mock_get, client):
        """Test returns analytics data from service."""
        expected = {
            'period': 'week',
            'total_sessions': 10,
            'total_tokens': 50000,
            'estimated_cost': 1.50
        }
        mock_get.return_value = expected

        response = client.get('/api/analytics')

        assert response.status_code == 200
        assert response.json() == expected

    @patch('src.api.routes.analytics.get_analytics')
    def test_day_period(self, mock_get, client):
        """Test 'day' period."""
        mock_get.return_value = {'period': 'day'}

        response = client.get('/api/analytics?period=day')

        assert response.status_code == 200
        mock_get.assert_called_once_with('day')

    @patch('src.api.routes.analytics.get_analytics')
    def test_year_period(self, mock_get, client):
        """Test 'year' period."""
        mock_get.return_value = {'period': 'year'}

        response = client.get('/api/analytics?period=year')

        assert response.status_code == 200
        mock_get.assert_called_once_with('year')


class TestGetHistoryEndpoint:
    """Tests for GET /api/history endpoint."""

    @patch('src.api.routes.analytics.get_session_history')
    def test_default_pagination(self, mock_get, client):
        """Test default pagination parameters."""
        mock_get.return_value = {'sessions': [], 'total': 0, 'page': 1}

        client.get('/api/history')

        mock_get.assert_called_once_with(1, 20, None)

    @patch('src.api.routes.analytics.get_session_history')
    def test_custom_pagination(self, mock_get, client):
        """Test custom pagination parameters."""
        mock_get.return_value = {'sessions': [], 'total': 0, 'page': 2}

        client.get('/api/history?page=2&per_page=50')

        mock_get.assert_called_once_with(2, 50, None)

    @patch('src.api.routes.analytics.get_session_history')
    def test_repo_filter(self, mock_get, client):
        """Test repository filter parameter."""
        mock_get.return_value = {'sessions': [], 'total': 0}

        client.get('/api/history?repo=my-project')

        mock_get.assert_called_once_with(1, 20, 'my-project')

    @patch('src.api.routes.analytics.get_session_history')
    def test_returns_session_history(self, mock_get, client):
        """Test returns session history data."""
        expected = {
            'sessions': [
                {'sessionId': 'test-1', 'cwd': '/project'},
                {'sessionId': 'test-2', 'cwd': '/other'},
            ],
            'total': 2,
            'page': 1,
            'per_page': 20,
            'total_pages': 1
        }
        mock_get.return_value = expected

        response = client.get('/api/history')

        assert response.status_code == 200
        assert response.json() == expected

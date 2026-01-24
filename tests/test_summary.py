"""Tests for AI summary generation services."""

import time
from unittest.mock import patch, MagicMock

import pytest

from src.api.services.summary import (
    compute_activity_hash,
    is_meaningful_activity,
    get_bedrock_token,
    generate_session_summary,
    generate_activity_summary,
    get_summary_cache,
    GENERIC_ACTIVITY_PATTERNS,
    MIN_ACTIVITIES_FOR_SUMMARY,
    _summary_cache,
)


class TestComputeActivityHash:
    """Tests for compute_activity_hash function."""

    def test_empty_list(self):
        """Test hash of empty activity list."""
        result = compute_activity_hash([])
        assert isinstance(result, str)
        assert len(result) == 8  # First 8 chars of MD5

    def test_single_activity(self):
        """Test hash of single activity."""
        result = compute_activity_hash(['Reading file.py'])
        assert isinstance(result, str)
        assert len(result) == 8

    def test_uses_last_5_activities(self):
        """Test that only last 5 activities are used."""
        activities = [f'Activity {i}' for i in range(10)]

        # Full list hash should equal hash of just last 5
        full_hash = compute_activity_hash(activities)
        last_5_hash = compute_activity_hash(activities[-5:])

        assert full_hash == last_5_hash

    def test_different_activities_different_hash(self):
        """Test different activities produce different hashes."""
        hash1 = compute_activity_hash(['Activity A'])
        hash2 = compute_activity_hash(['Activity B'])

        assert hash1 != hash2

    def test_same_activities_same_hash(self):
        """Test same activities produce same hash."""
        activities = ['Reading file.py', 'Editing config.json']

        hash1 = compute_activity_hash(activities)
        hash2 = compute_activity_hash(activities)

        assert hash1 == hash2


class TestIsMeaningfulActivity:
    """Tests for is_meaningful_activity function."""

    def test_empty_activity(self):
        """Test empty activity is not meaningful."""
        assert is_meaningful_activity('') is False

    def test_generic_skill_activity(self):
        """Test generic 'Using Skill' is not meaningful."""
        assert is_meaningful_activity('Using Skill') is False

    def test_running_skill_activity(self):
        """Test 'Running skill' is not meaningful."""
        assert is_meaningful_activity('Running skill') is False

    def test_short_using_activity(self):
        """Test short 'Using X' is not meaningful."""
        assert is_meaningful_activity('Using X') is False

    def test_long_using_activity(self):
        """Test longer 'Using X' is meaningful."""
        assert is_meaningful_activity('Using the git_tracker module for diff analysis') is True

    def test_updating_task_list(self):
        """Test 'Updating task list' is not meaningful."""
        assert is_meaningful_activity('Updating task list') is False

    def test_asking_question(self):
        """Test 'Asking user question' is not meaningful."""
        assert is_meaningful_activity('Asking user question') is False

    def test_specific_file_operation(self):
        """Test specific file operations are meaningful."""
        assert is_meaningful_activity('Reading src/api/server.py') is True
        assert is_meaningful_activity('Editing config.json') is True
        assert is_meaningful_activity('Writing new_file.txt') is True

    def test_bash_command(self):
        """Test bash commands are meaningful."""
        assert is_meaningful_activity('Running npm test') is True
        assert is_meaningful_activity('Build the project') is True

    def test_search_activity(self):
        """Test search activities are meaningful."""
        assert is_meaningful_activity("Searching for 'def test_'") is True


class TestGetBedrockToken:
    """Tests for get_bedrock_token function."""

    @patch('src.api.services.summary.BEDROCK_TOKEN_FILE')
    def test_returns_token_when_file_exists(self, mock_path):
        """Test returns token from file."""
        mock_path.exists.return_value = True
        mock_path.read_text.return_value = '{"access_token": "test_token_123"}'

        token = get_bedrock_token()
        assert token == 'test_token_123'

    @patch('src.api.services.summary.BEDROCK_TOKEN_FILE')
    def test_returns_none_when_file_missing(self, mock_path):
        """Test returns None when token file doesn't exist."""
        mock_path.exists.return_value = False

        token = get_bedrock_token()
        assert token is None

    @patch('src.api.services.summary.BEDROCK_TOKEN_FILE')
    def test_returns_none_on_invalid_json(self, mock_path):
        """Test returns None on invalid JSON."""
        mock_path.exists.return_value = True
        mock_path.read_text.return_value = 'not valid json'

        token = get_bedrock_token()
        assert token is None

    @patch('src.api.services.summary.BEDROCK_TOKEN_FILE')
    def test_returns_none_on_read_error(self, mock_path):
        """Test returns None on file read error."""
        mock_path.exists.return_value = True
        mock_path.read_text.side_effect = IOError("Read error")

        token = get_bedrock_token()
        assert token is None


class TestGenerateSessionSummary:
    """Tests for generate_session_summary function."""

    @pytest.fixture(autouse=True)
    def clear_cache(self):
        """Clear summary cache before each test."""
        _summary_cache.clear()
        yield
        _summary_cache.clear()

    @pytest.mark.asyncio
    @patch('src.api.services.summary.get_bedrock_token')
    async def test_returns_cached_summary(self, mock_token):
        """Test returns cached summary when valid."""
        session_id = 'test-session'
        _summary_cache[session_id] = {
            'summary': 'Cached summary',
            'timestamp': time.time()
        }

        result = await generate_session_summary(session_id, ['activity'], '/cwd')

        assert result == 'Cached summary'
        mock_token.assert_not_called()

    @pytest.mark.asyncio
    @patch('src.api.services.summary.get_bedrock_token')
    async def test_returns_error_when_no_token(self, mock_token):
        """Test returns error message when no token available."""
        mock_token.return_value = None

        result = await generate_session_summary('session', ['activity'], '/cwd')

        assert 'not available' in result

    @pytest.mark.asyncio
    @patch('httpx.post')
    @patch('src.api.services.summary.get_bedrock_token')
    async def test_generates_summary_via_api(self, mock_token, mock_post):
        """Test generates summary via Bedrock API."""
        mock_token.return_value = 'test_token'
        mock_response = MagicMock()
        mock_response.json.return_value = {
            'content': [{'text': 'Generated summary'}]
        }
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        result = await generate_session_summary(
            'session',
            ['Reading file.py', 'Editing config'],
            '/project'
        )

        assert result == 'Generated summary'
        assert 'session' in _summary_cache
        mock_post.assert_called_once()

    @pytest.mark.asyncio
    @patch('httpx.post')
    @patch('src.api.services.summary.get_bedrock_token')
    async def test_handles_api_error(self, mock_token, mock_post):
        """Test handles API error gracefully."""
        mock_token.return_value = 'test_token'
        mock_post.side_effect = Exception("API error")

        result = await generate_session_summary('session', ['activity'], '/cwd')

        assert 'unavailable' in result


class TestGenerateActivitySummary:
    """Tests for generate_activity_summary function."""

    @pytest.fixture(autouse=True)
    def clear_cache(self):
        """Clear cache before each test."""
        _summary_cache.clear()
        yield
        _summary_cache.clear()

    @pytest.mark.asyncio
    async def test_returns_none_for_empty_activities(self):
        """Test returns None for empty activity list."""
        result = await generate_activity_summary('session', [], '/cwd')
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_insufficient_activities(self):
        """Test returns None when not enough meaningful activities."""
        activities = ['Using Skill', 'Updating task list']  # Generic activities

        result = await generate_activity_summary('session', activities, '/cwd')
        assert result is None

    @pytest.mark.asyncio
    @patch('src.api.services.summary.get_bedrock_token')
    async def test_returns_none_when_no_token(self, mock_token):
        """Test returns None when no token available."""
        mock_token.return_value = None
        activities = ['Reading file.py', 'Editing config.json', 'Writing output.txt']

        result = await generate_activity_summary('session', activities, '/cwd')
        assert result is None

    @pytest.mark.asyncio
    @patch('src.api.services.summary.save_activity_summary')
    @patch('src.api.services.summary.db_get_activity_summaries')
    @patch('src.api.services.summary.get_last_activity_hash')
    @patch('httpx.post')
    @patch('src.api.services.summary.get_bedrock_token')
    async def test_generates_summary_on_hash_change(
        self, mock_token, mock_post, mock_last_hash, mock_get_summaries, mock_save
    ):
        """Test generates summary when activity hash changes."""
        mock_token.return_value = 'test_token'
        mock_last_hash.return_value = 'old_hash'
        mock_get_summaries.return_value = [{'summary': 'old'}]

        mock_response = MagicMock()
        mock_response.json.return_value = {
            'content': [{'text': 'New activity summary'}]
        }
        mock_response.raise_for_status = MagicMock()
        mock_post.return_value = mock_response

        activities = ['Reading file.py', 'Editing config.json', 'Writing new.txt']

        result = await generate_activity_summary('session', activities, '/cwd')

        assert result == 'New activity summary'
        mock_save.assert_called_once()


class TestGetSummaryCache:
    """Tests for get_summary_cache function."""

    def test_returns_cache_dict(self):
        """Test returns the cache dictionary."""
        cache = get_summary_cache()

        assert isinstance(cache, dict)
        # Should be the same object as _summary_cache
        assert cache is _summary_cache


class TestGenericActivityPatterns:
    """Tests for generic activity patterns list."""

    def test_patterns_exist(self):
        """Test that generic patterns are defined."""
        assert len(GENERIC_ACTIVITY_PATTERNS) > 0

    def test_patterns_are_strings(self):
        """Test that all patterns are strings."""
        for pattern in GENERIC_ACTIVITY_PATTERNS:
            assert isinstance(pattern, str)

    def test_common_patterns_present(self):
        """Test that common generic patterns are included."""
        patterns_lower = [p.lower() for p in GENERIC_ACTIVITY_PATTERNS]

        assert any('skill' in p for p in patterns_lower)
        assert any('task' in p for p in patterns_lower)


class TestMinActivitiesForSummary:
    """Tests for minimum activities threshold."""

    def test_threshold_is_reasonable(self):
        """Test threshold is a reasonable number."""
        assert MIN_ACTIVITIES_FOR_SUMMARY >= 1
        assert MIN_ACTIVITIES_FOR_SUMMARY <= 10

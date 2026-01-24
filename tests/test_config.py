"""Tests for configuration module."""

from pathlib import Path

from src.api.config import (
    # Path Configuration
    CLAUDE_PROJECTS_DIR,
    DB_PATH,
    # Session Detection Thresholds
    ACTIVE_CPU_THRESHOLD,
    ACTIVE_RECENCY_SECONDS,
    MAX_SESSION_AGE_HOURS,
    MAX_ALL_SESSION_AGE_HOURS,
    # Token Configuration
    MAX_CONTEXT_TOKENS,
    PRICING,
    # Cache TTL Settings
    METADATA_CACHE_TTL,
    PROCESS_CACHE_TTL,
    SUMMARY_CACHE_TTL,
    # Bedrock API Configuration
    BEDROCK_PROXY_URL,
    BEDROCK_MODEL_ID,
    BEDROCK_MAX_TOKENS,
    # Server Configuration
    DEFAULT_HOST,
    DEFAULT_PORT,
    WEBSOCKET_HEARTBEAT_INTERVAL,
    REMOTE_AGENT_PORT,
    # Timeline Configuration
    TIMELINE_BUCKET_MINUTES,
    MIN_ACTIVITY_FOR_SUMMARY,
)


class TestPathConfiguration:
    """Tests for path configuration constants."""

    def test_claude_projects_dir_is_path(self):
        """Test CLAUDE_PROJECTS_DIR is a Path object."""
        assert isinstance(CLAUDE_PROJECTS_DIR, Path)

    def test_claude_projects_dir_under_home(self):
        """Test CLAUDE_PROJECTS_DIR is under home directory."""
        assert str(Path.home()) in str(CLAUDE_PROJECTS_DIR)

    def test_claude_projects_dir_contains_claude(self):
        """Test CLAUDE_PROJECTS_DIR contains .claude."""
        assert '.claude' in str(CLAUDE_PROJECTS_DIR)

    def test_db_path_is_path(self):
        """Test DB_PATH is a Path object."""
        assert isinstance(DB_PATH, Path)

    def test_db_path_is_sqlite(self):
        """Test DB_PATH ends with .db."""
        assert str(DB_PATH).endswith('.db')


class TestSessionDetectionThresholds:
    """Tests for session detection threshold constants."""

    def test_active_cpu_threshold_is_reasonable(self):
        """Test CPU threshold is reasonable (0-100%)."""
        assert 0 < ACTIVE_CPU_THRESHOLD <= 100

    def test_active_recency_seconds_is_positive(self):
        """Test recency threshold is positive."""
        assert ACTIVE_RECENCY_SECONDS > 0

    def test_active_recency_under_one_minute(self):
        """Test recency threshold is under 1 minute for responsiveness."""
        assert ACTIVE_RECENCY_SECONDS <= 60

    def test_max_session_age_is_positive(self):
        """Test max session age is positive."""
        assert MAX_SESSION_AGE_HOURS > 0

    def test_max_all_session_age_greater_than_regular(self):
        """Test all sessions age is greater than regular max."""
        assert MAX_ALL_SESSION_AGE_HOURS >= MAX_SESSION_AGE_HOURS


class TestTokenConfiguration:
    """Tests for token configuration constants."""

    def test_max_context_tokens_is_positive(self):
        """Test max context tokens is positive."""
        assert MAX_CONTEXT_TOKENS > 0

    def test_max_context_tokens_is_reasonable(self):
        """Test max context is a reasonable value for Claude (>=100k)."""
        assert MAX_CONTEXT_TOKENS >= 100_000

    def test_pricing_has_required_keys(self):
        """Test pricing dict has all required keys."""
        required_keys = [
            'input_per_mtok',
            'output_per_mtok',
            'cache_read_per_mtok',
            'cache_write_per_mtok',
        ]
        for key in required_keys:
            assert key in PRICING

    def test_pricing_values_are_positive(self):
        """Test all pricing values are positive."""
        for key, value in PRICING.items():
            assert value > 0, f"{key} should be positive"

    def test_pricing_output_higher_than_input(self):
        """Test output tokens cost more than input."""
        assert PRICING['output_per_mtok'] > PRICING['input_per_mtok']

    def test_pricing_cache_read_cheaper_than_regular(self):
        """Test cache read is cheaper than regular input."""
        assert PRICING['cache_read_per_mtok'] < PRICING['input_per_mtok']


class TestCacheTTLSettings:
    """Tests for cache TTL configuration."""

    def test_metadata_cache_ttl_is_positive(self):
        """Test metadata cache TTL is positive."""
        assert METADATA_CACHE_TTL > 0

    def test_process_cache_ttl_is_positive(self):
        """Test process cache TTL is positive."""
        assert PROCESS_CACHE_TTL > 0

    def test_process_cache_is_short(self):
        """Test process cache is short for responsiveness."""
        assert PROCESS_CACHE_TTL <= 10

    def test_summary_cache_ttl_is_positive(self):
        """Test summary cache TTL is positive."""
        assert SUMMARY_CACHE_TTL > 0

    def test_summary_cache_longer_than_process(self):
        """Test summary cache is longer than process cache."""
        assert SUMMARY_CACHE_TTL > PROCESS_CACHE_TTL


class TestBedrockAPIConfiguration:
    """Tests for Bedrock API configuration."""

    def test_proxy_url_is_string(self):
        """Test proxy URL is a string."""
        assert isinstance(BEDROCK_PROXY_URL, str)

    def test_proxy_url_is_valid_url(self):
        """Test proxy URL looks like a valid URL."""
        assert BEDROCK_PROXY_URL.startswith('http')

    def test_model_id_is_string(self):
        """Test model ID is a string."""
        assert isinstance(BEDROCK_MODEL_ID, str)

    def test_model_id_contains_claude(self):
        """Test model ID contains 'claude'."""
        assert 'claude' in BEDROCK_MODEL_ID.lower()

    def test_max_tokens_is_positive(self):
        """Test max tokens is positive."""
        assert BEDROCK_MAX_TOKENS > 0


class TestServerConfiguration:
    """Tests for server configuration."""

    def test_default_host_is_string(self):
        """Test default host is a string."""
        assert isinstance(DEFAULT_HOST, str)

    def test_default_port_is_valid(self):
        """Test default port is in valid range."""
        assert 1 <= DEFAULT_PORT <= 65535

    def test_websocket_heartbeat_is_positive(self):
        """Test WebSocket heartbeat interval is positive."""
        assert WEBSOCKET_HEARTBEAT_INTERVAL > 0

    def test_remote_agent_port_is_valid(self):
        """Test remote agent port is in valid range."""
        assert 1 <= REMOTE_AGENT_PORT <= 65535

    def test_ports_are_different(self):
        """Test default port and remote port are different."""
        assert DEFAULT_PORT != REMOTE_AGENT_PORT


class TestTimelineConfiguration:
    """Tests for timeline configuration."""

    def test_bucket_minutes_is_positive(self):
        """Test bucket size is positive."""
        assert TIMELINE_BUCKET_MINUTES > 0

    def test_bucket_minutes_is_reasonable(self):
        """Test bucket size is reasonable (1-30 minutes)."""
        assert 1 <= TIMELINE_BUCKET_MINUTES <= 30

    def test_min_activity_for_summary_is_positive(self):
        """Test minimum activity count is positive."""
        assert MIN_ACTIVITY_FOR_SUMMARY > 0

    def test_min_activity_is_reasonable(self):
        """Test minimum activity count is reasonable (1-10)."""
        assert 1 <= MIN_ACTIVITY_FOR_SUMMARY <= 10

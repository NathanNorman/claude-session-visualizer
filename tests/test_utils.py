"""Tests for utility functions."""

from src.api.utils import (
    calculate_cost,
    get_token_percentage,
    parse_jsonl_line,
    safe_get_nested,
)


class TestCalculateCost:
    """Tests for calculate_cost function."""

    def test_empty_usage(self):
        """Test with empty usage dict."""
        assert calculate_cost({}) == 0.0

    def test_input_tokens_only(self):
        """Test cost with only input tokens."""
        # 1 million tokens * $3/MTok = $3.00
        usage = {'input_tokens': 1_000_000}
        assert calculate_cost(usage) == 3.00

    def test_output_tokens_only(self):
        """Test cost with only output tokens."""
        # 1 million tokens * $15/MTok = $15.00
        usage = {'output_tokens': 1_000_000}
        assert calculate_cost(usage) == 15.00

    def test_cache_read_only(self):
        """Test cost with only cache read tokens."""
        # 1 million tokens * $0.30/MTok = $0.30
        usage = {'cache_read_input_tokens': 1_000_000}
        assert calculate_cost(usage) == 0.30

    def test_cache_write_only(self):
        """Test cost with only cache write tokens."""
        # 1 million tokens * $3.75/MTok = $3.75
        usage = {'cache_creation_input_tokens': 1_000_000}
        assert calculate_cost(usage) == 3.75

    def test_combined_usage(self):
        """Test cost with all token types."""
        usage = {
            'input_tokens': 100_000,       # $0.30
            'output_tokens': 10_000,       # $0.15
            'cache_read_input_tokens': 50_000,   # $0.015
            'cache_creation_input_tokens': 20_000,  # $0.075
        }
        # Total: $0.30 + $0.15 + $0.015 + $0.075 = $0.54
        assert calculate_cost(usage) == 0.54

    def test_small_values(self):
        """Test with small token counts."""
        usage = {'input_tokens': 100, 'output_tokens': 50}
        # Very small cost rounds to 0.00
        assert calculate_cost(usage) == 0.0

    def test_rounding(self):
        """Test that result is rounded to 2 decimal places."""
        usage = {'input_tokens': 333_333}  # $0.999999
        assert calculate_cost(usage) == 1.0

    def test_missing_keys(self):
        """Test graceful handling of missing keys."""
        usage = {'unknown_key': 1000}
        assert calculate_cost(usage) == 0.0


class TestGetTokenPercentage:
    """Tests for get_token_percentage function."""

    def test_zero_tokens(self):
        """Test with zero tokens."""
        assert get_token_percentage(0) == 0.0

    def test_half_context(self):
        """Test with half the context window."""
        # 200000 / 2 = 100000 tokens = 50%
        assert get_token_percentage(100_000) == 50.0

    def test_full_context(self):
        """Test with full context window."""
        assert get_token_percentage(200_000) == 100.0

    def test_over_context_capped(self):
        """Test that values over 100% are capped."""
        assert get_token_percentage(300_000) == 100.0

    def test_small_percentage(self):
        """Test small token counts."""
        # 2000 / 200000 = 1%
        assert get_token_percentage(2_000) == 1.0


class TestParseJsonlLine:
    """Tests for parse_jsonl_line function."""

    def test_valid_json_string(self):
        """Test parsing valid JSON string."""
        line = '{"key": "value", "number": 42}'
        result = parse_jsonl_line(line)
        assert result == {"key": "value", "number": 42}

    def test_valid_json_bytes(self):
        """Test parsing valid JSON from bytes."""
        line = b'{"key": "value"}'
        result = parse_jsonl_line(line)
        assert result == {"key": "value"}

    def test_whitespace_handling(self):
        """Test that whitespace is stripped."""
        line = '  {"key": "value"}  \n'
        result = parse_jsonl_line(line)
        assert result == {"key": "value"}

    def test_invalid_json(self):
        """Test invalid JSON returns None."""
        line = '{invalid json}'
        assert parse_jsonl_line(line) is None

    def test_empty_string(self):
        """Test empty string returns None."""
        assert parse_jsonl_line('') is None
        assert parse_jsonl_line('   ') is None

    def test_unicode_bytes(self):
        """Test UTF-8 encoded bytes."""
        line = '{"emoji": "🎉"}'.encode('utf-8')
        result = parse_jsonl_line(line)
        assert result == {"emoji": "🎉"}

    def test_invalid_unicode(self):
        """Test invalid UTF-8 returns None."""
        line = b'\xff\xfe'  # Invalid UTF-8
        assert parse_jsonl_line(line) is None


class TestSafeGetNested:
    """Tests for safe_get_nested function."""

    def test_single_level(self):
        """Test single level access."""
        data = {'key': 'value'}
        assert safe_get_nested(data, 'key') == 'value'

    def test_nested_access(self):
        """Test nested key access."""
        data = {'a': {'b': {'c': 42}}}
        assert safe_get_nested(data, 'a', 'b', 'c') == 42

    def test_missing_key_returns_default(self):
        """Test missing key returns default."""
        data = {'a': {'b': 1}}
        assert safe_get_nested(data, 'a', 'missing') is None
        assert safe_get_nested(data, 'a', 'missing', default=0) == 0

    def test_missing_nested_returns_default(self):
        """Test missing nested key returns default."""
        data = {'a': 1}
        assert safe_get_nested(data, 'a', 'b', 'c', default='default') == 'default'

    def test_non_dict_intermediate(self):
        """Test non-dict intermediate value returns default."""
        data = {'a': 'string'}
        assert safe_get_nested(data, 'a', 'b') is None

    def test_empty_keys(self):
        """Test with no keys returns data itself."""
        data = {'key': 'value'}
        assert safe_get_nested(data) == data

    def test_list_value(self):
        """Test accessing list value."""
        data = {'items': [1, 2, 3]}
        assert safe_get_nested(data, 'items') == [1, 2, 3]

    def test_none_value(self):
        """Test accessing None value."""
        data = {'key': None}
        assert safe_get_nested(data, 'key') is None
        # Default is returned when key value IS None (due to get behavior)
        assert safe_get_nested(data, 'key', default='default') is None

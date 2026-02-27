"""Tests for JSONL parsing functions."""

import pytest
from src.api.detection.jsonl_parser import (
    extract_activity,
    cwd_to_project_slug,
    extract_text_content,
    extract_tool_calls,
)


class TestExtractActivity:
    """Tests for extract_activity function."""

    def test_read_tool(self):
        """Test Read tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'Read',
            'input': {'file_path': '/Users/test/project/src/main.py'}
        }
        assert extract_activity(content_item) == "Reading main.py"

    def test_write_tool(self):
        """Test Write tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'Write',
            'input': {'file_path': '/Users/test/project/new_file.txt'}
        }
        assert extract_activity(content_item) == "Writing new_file.txt"

    def test_edit_tool(self):
        """Test Edit tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'Edit',
            'input': {'file_path': '/path/to/config.json'}
        }
        assert extract_activity(content_item) == "Editing config.json"

    def test_bash_tool_with_description(self):
        """Test Bash tool with description."""
        content_item = {
            'type': 'tool_use',
            'name': 'Bash',
            'input': {
                'command': 'npm run build',
                'description': 'Build the project'
            }
        }
        assert extract_activity(content_item) == "Build the project"

    def test_bash_tool_without_description(self):
        """Test Bash tool without description falls back to command."""
        content_item = {
            'type': 'tool_use',
            'name': 'Bash',
            'input': {'command': 'git status'}
        }
        assert extract_activity(content_item) == "Running: git status"

    def test_grep_tool(self):
        """Test Grep tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'Grep',
            'input': {'pattern': 'def test_'}
        }
        assert extract_activity(content_item) == "Searching for 'def test_'"

    def test_glob_tool(self):
        """Test Glob tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'Glob',
            'input': {'pattern': '**/*.py'}
        }
        assert extract_activity(content_item) == "Finding files: **/*.py"

    def test_task_tool(self):
        """Test Task tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'Task',
            'input': {'description': 'Run tests'}
        }
        assert extract_activity(content_item) == "Spawning agent: Run tests"

    def test_unknown_tool(self):
        """Test unknown tool falls back to tool name."""
        content_item = {
            'type': 'tool_use',
            'name': 'CustomTool',
            'input': {}
        }
        assert extract_activity(content_item) == "Using CustomTool"

    def test_text_content(self):
        """Test text content extraction."""
        content_item = {
            'type': 'text',
            'text': 'This is a short response.'
        }
        assert extract_activity(content_item) == "This is a short response."

    def test_text_truncation(self):
        """Test long text is truncated."""
        long_text = "A" * 100
        content_item = {
            'type': 'text',
            'text': long_text
        }
        result = extract_activity(content_item)
        assert len(result) <= 63  # 60 + "..."

    def test_empty_content(self):
        """Test empty content returns None."""
        assert extract_activity({}) is None
        assert extract_activity({'type': 'unknown'}) is None

    def test_mcp_tool(self):
        """Test MCP tool activity extraction."""
        content_item = {
            'type': 'tool_use',
            'name': 'mcp__github__create_pr',
            'input': {}
        }
        assert extract_activity(content_item) == "github: create_pr"


class TestCwdToProjectSlug:
    """Tests for cwd_to_project_slug function."""

    def test_basic_conversion(self):
        """Test basic path conversion."""
        result = cwd_to_project_slug("/Users/test/project")
        assert result == "-Users-test-project"

    def test_dots_replaced(self):
        """Test dots are replaced with dashes."""
        result = cwd_to_project_slug("/Users/test/.hidden")
        assert result == "-Users-test--hidden"

    def test_underscores_replaced(self):
        """Test underscores are replaced with dashes."""
        result = cwd_to_project_slug("/path/my_project")
        assert result == "-path-my-project"


class TestExtractTextContent:
    """Tests for extract_text_content function."""

    def test_string_content(self):
        """Test string content extraction."""
        message = {'content': 'Simple text response'}
        assert extract_text_content(message) == "Simple text response"

    def test_list_content(self):
        """Test list content extraction."""
        message = {
            'content': [
                {'type': 'text', 'text': 'First part'},
                {'type': 'text', 'text': 'Second part'}
            ]
        }
        result = extract_text_content(message)
        assert 'First part' in result
        assert 'Second part' in result

    def test_long_content_returned_fully(self):
        """Test long content is returned without truncation."""
        message = {'content': 'A' * 600}
        result = extract_text_content(message)
        assert len(result) == 600


class TestExtractToolCalls:
    """Tests for extract_tool_calls function."""

    def test_read_tool_summary(self):
        """Test Read tool summary."""
        content = [
            {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': '/path/file.py'}}
        ]
        assert extract_tool_calls(content) == ["Read file.py"]

    def test_bash_tool_summary(self):
        """Test Bash tool with description."""
        content = [
            {'type': 'tool_use', 'name': 'Bash', 'input': {'description': 'Run tests'}}
        ]
        assert extract_tool_calls(content) == ["Bash: Run tests"]

    def test_multiple_tools(self):
        """Test multiple tool calls."""
        content = [
            {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': '/a.py'}},
            {'type': 'tool_use', 'name': 'Edit', 'input': {'file_path': '/b.py'}},
        ]
        result = extract_tool_calls(content)
        assert len(result) == 2
        assert "Read a.py" in result
        assert "Edit b.py" in result

"""Tests for git tracking functions."""

from pathlib import Path
from unittest.mock import patch

from src.api.git_tracker import (
    run_git,
    get_git_status,
    get_recent_commits,
    get_diff_stats,
    get_cached_git_status,
    GitStatus,
    GitCommit,
    _git_status_cache,
)


class TestRunGit:
    """Tests for run_git function."""

    def test_successful_command(self, tmp_path):
        """Test successful git command."""
        # Create a git repo for testing
        (tmp_path / '.git').mkdir()

        output, success = run_git(str(tmp_path), 'status')
        # Even if not a full repo, it should execute without error
        assert isinstance(output, str)
        assert isinstance(success, bool)

    def test_invalid_directory(self):
        """Test with non-existent directory."""
        output, success = run_git('/nonexistent/path', 'status')
        assert success is False

    @patch('subprocess.run')
    def test_timeout_handling(self, mock_run):
        """Test timeout handling."""
        import subprocess
        mock_run.side_effect = subprocess.TimeoutExpired('git', 10)

        output, success = run_git('/tmp', 'log')
        assert success is False
        assert 'TimeoutExpired' in output or 'timeout' in output.lower() or output != ''

    @patch('subprocess.run')
    def test_git_not_found(self, mock_run):
        """Test when git is not installed."""
        mock_run.side_effect = FileNotFoundError()

        output, success = run_git('/tmp', 'status')
        assert success is False


class TestGetGitStatus:
    """Tests for get_git_status function."""

    def test_nonexistent_path(self):
        """Test with non-existent path."""
        result = get_git_status('/nonexistent/path/to/repo')
        assert result is None

    def test_non_git_directory(self, tmp_path):
        """Test with directory that is not a git repo."""
        result = get_git_status(str(tmp_path))
        assert result is None

    @patch('src.api.git_tracker.run_git')
    def test_basic_status(self, mock_run_git):
        """Test basic git status parsing."""
        # Mock the git commands
        def run_git_mock(cwd, *args):
            if args[0] == 'rev-parse':
                return '.git', True
            elif args[0] == 'branch':
                return 'main', True
            elif args[0] == 'status':
                return ' M modified.py\nA  added.py\n D deleted.py\n?? untracked.py', True
            elif args[0] == 'rev-list':
                return '2\t1', True
            return '', True

        mock_run_git.side_effect = run_git_mock

        with patch.object(Path, 'exists', return_value=True):
            result = get_git_status('/fake/repo')

        assert result is not None
        assert result.branch == 'main'
        assert 'modified.py' in result.modified
        assert 'added.py' in result.added
        assert 'deleted.py' in result.deleted
        assert 'untracked.py' in result.untracked
        assert result.ahead == 2
        assert result.behind == 1
        assert result.has_uncommitted is True

    @patch('src.api.git_tracker.run_git')
    def test_detached_head(self, mock_run_git):
        """Test detached HEAD state."""
        def run_git_mock(cwd, *args):
            if args[0] == 'rev-parse' and '--git-dir' in args:
                return '.git', True
            if args[0] == 'branch':
                return '', True  # Empty branch = detached HEAD
            if args[0] == 'rev-parse' and '--short' in args:
                return 'abc1234', True
            if args[0] == 'status':
                return '', True
            if args[0] == 'rev-list':
                return '', False
            return '', True

        mock_run_git.side_effect = run_git_mock

        with patch.object(Path, 'exists', return_value=True):
            result = get_git_status('/fake/repo')

        assert result is not None
        assert result.branch == 'detached:abc1234'

    @patch('src.api.git_tracker.run_git')
    def test_clean_repo(self, mock_run_git):
        """Test clean repository with no changes."""
        def run_git_mock(cwd, *args):
            if args[0] == 'rev-parse':
                return '.git', True
            elif args[0] == 'branch':
                return 'main', True
            elif args[0] == 'status':
                return '', True  # No changes
            elif args[0] == 'rev-list':
                return '0\t0', True
            return '', True

        mock_run_git.side_effect = run_git_mock

        with patch.object(Path, 'exists', return_value=True):
            result = get_git_status('/fake/repo')

        assert result is not None
        assert result.modified == []
        assert result.added == []
        assert result.deleted == []
        assert result.has_uncommitted is False


class TestGetRecentCommits:
    """Tests for get_recent_commits function."""

    @patch('src.api.git_tracker.run_git')
    def test_returns_commits(self, mock_run_git):
        """Test getting recent commits."""
        def run_git_mock(cwd, *args):
            if args[0] == 'log':
                return 'abc123|abc1|Fix bug|Author|2 days ago|\ndef456|def4|Add feature|Author|5 days ago|', True
            if args[0] == 'diff-tree':
                return 'file1.py\nfile2.py', True
            return '', True

        mock_run_git.side_effect = run_git_mock

        commits = get_recent_commits('/fake/repo', limit=2)

        assert len(commits) == 2
        assert commits[0].sha == 'abc123'
        assert commits[0].short_sha == 'abc1'
        assert commits[0].message == 'Fix bug'
        assert commits[0].author == 'Author'
        assert commits[0].files_changed == 2

    @patch('src.api.git_tracker.run_git')
    def test_empty_on_failure(self, mock_run_git):
        """Test returns empty list on failure."""
        mock_run_git.return_value = ('', False)

        commits = get_recent_commits('/fake/repo')
        assert commits == []

    @patch('src.api.git_tracker.run_git')
    def test_handles_malformed_output(self, mock_run_git):
        """Test handling of malformed git log output."""
        def run_git_mock(cwd, *args):
            if args[0] == 'log':
                return 'malformed line without pipes\nabc|def|msg|auth|time|', True
            if args[0] == 'diff-tree':
                return '', True
            return '', True

        mock_run_git.side_effect = run_git_mock

        # Should skip malformed lines without crashing
        commits = get_recent_commits('/fake/repo')
        assert len(commits) == 1


class TestGetDiffStats:
    """Tests for get_diff_stats function."""

    @patch('src.api.git_tracker.run_git')
    def test_diff_stats(self, mock_run_git):
        """Test parsing diff stats."""
        mock_run_git.return_value = (
            ' file1.py | 10 +++\n file2.py | 5 +-\n 2 files changed, 12 insertions(+), 3 deletions(-)',
            True
        )

        result = get_diff_stats('/fake/repo')

        assert len(result['files']) == 2
        assert result['files'][0]['file'] == 'file1.py'
        assert result['files'][0]['changes'] == '10 +++'
        assert '2 files changed' in result['summary']

    @patch('src.api.git_tracker.run_git')
    def test_empty_diff(self, mock_run_git):
        """Test empty diff."""
        mock_run_git.return_value = ('', True)

        result = get_diff_stats('/fake/repo')

        assert result == {'files': [], 'summary': ''}


class TestGetCachedGitStatus:
    """Tests for get_cached_git_status function."""

    def setup_method(self):
        """Clear cache before each test."""
        _git_status_cache.clear()

    @patch('src.api.git_tracker.get_git_status')
    def test_caches_result(self, mock_get_status):
        """Test that result is cached."""
        mock_status = GitStatus(
            branch='main', modified=[], added=[], deleted=[],
            untracked=[], ahead=0, behind=0, has_uncommitted=False
        )
        mock_get_status.return_value = mock_status

        # First call
        result1 = get_cached_git_status('/fake/repo')
        # Second call (should use cache)
        result2 = get_cached_git_status('/fake/repo')

        assert result1 == mock_status
        assert result2 == mock_status
        # Should only call get_git_status once
        assert mock_get_status.call_count == 1

    @patch('src.api.git_tracker.get_git_status')
    @patch('time.time')
    def test_cache_expiry(self, mock_time, mock_get_status):
        """Test cache expiry."""
        mock_status = GitStatus(
            branch='main', modified=[], added=[], deleted=[],
            untracked=[], ahead=0, behind=0, has_uncommitted=False
        )
        mock_get_status.return_value = mock_status

        # Initial time
        mock_time.return_value = 1000

        # First call
        get_cached_git_status('/fake/repo')

        # Advance time past TTL (60 seconds)
        mock_time.return_value = 1100

        # Second call (should refresh cache)
        get_cached_git_status('/fake/repo')

        # Should call get_git_status twice
        assert mock_get_status.call_count == 2


class TestGitStatusDataclass:
    """Tests for GitStatus dataclass."""

    def test_creation(self):
        """Test creating GitStatus instance."""
        status = GitStatus(
            branch='feature/test',
            modified=['file1.py'],
            added=['file2.py'],
            deleted=['file3.py'],
            untracked=['file4.py'],
            ahead=3,
            behind=1,
            has_uncommitted=True
        )

        assert status.branch == 'feature/test'
        assert status.modified == ['file1.py']
        assert status.ahead == 3
        assert status.has_uncommitted is True


class TestGitCommitDataclass:
    """Tests for GitCommit dataclass."""

    def test_creation(self):
        """Test creating GitCommit instance."""
        commit = GitCommit(
            sha='abc123def456',
            short_sha='abc123d',
            message='Fix critical bug',
            author='Test Author',
            timestamp='2 days ago',
            files_changed=5
        )

        assert commit.sha == 'abc123def456'
        assert commit.short_sha == 'abc123d'
        assert commit.message == 'Fix critical bug'
        assert commit.files_changed == 5

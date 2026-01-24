"""Tests for process detection functions."""

from unittest.mock import patch, MagicMock
import subprocess

from src.api.detection.processes import (
    get_process_cwd,
    get_process_start_time,
    get_claude_processes,
    get_claude_processes_cached,
    PROCESS_CACHE_TTL,
)


class TestGetProcessCwd:
    """Tests for get_process_cwd function."""

    @patch('subprocess.run')
    def test_returns_cwd(self, mock_run):
        """Test extracting cwd from lsof output."""
        mock_run.return_value = MagicMock(
            stdout='claude 12345 user cwd DIR 1,4 12345 /Users/test/project\n'
        )

        result = get_process_cwd(12345)
        assert result == '/Users/test/project'

    @patch('subprocess.run')
    def test_returns_none_on_no_match(self, mock_run):
        """Test returns None when no cwd found."""
        mock_run.return_value = MagicMock(stdout='')

        result = get_process_cwd(12345)
        assert result is None

    @patch('subprocess.run')
    def test_handles_exception(self, mock_run):
        """Test returns None on exception."""
        mock_run.side_effect = Exception("lsof failed")

        result = get_process_cwd(12345)
        assert result is None

    @patch('subprocess.run')
    def test_handles_timeout(self, mock_run):
        """Test returns None on timeout."""
        mock_run.side_effect = subprocess.TimeoutExpired('lsof', 5)

        result = get_process_cwd(12345)
        assert result is None


class TestGetProcessStartTime:
    """Tests for get_process_start_time function."""

    @patch('subprocess.run')
    @patch('time.time')
    def test_returns_start_time(self, mock_time, mock_run):
        """Test calculating start time from elapsed time."""
        mock_time.return_value = 1000.0
        mock_run.return_value = MagicMock(stdout='  300  ')  # 300 seconds elapsed

        result = get_process_start_time(12345)
        assert result == 700.0  # 1000 - 300

    @patch('subprocess.run')
    def test_returns_none_on_failure(self, mock_run):
        """Test returns None on failure."""
        mock_run.side_effect = Exception("ps failed")

        result = get_process_start_time(12345)
        assert result is None

    @patch('subprocess.run')
    def test_handles_invalid_output(self, mock_run):
        """Test handles non-integer output."""
        mock_run.return_value = MagicMock(stdout='invalid')

        result = get_process_start_time(12345)
        assert result is None


class TestGetClaudeProcesses:
    """Tests for get_claude_processes function."""

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_detects_claude_process(self, mock_run, mock_cwd, mock_start):
        """Test detection of claude CLI process."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project'
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['pid'] == 12345
        assert processes[0]['cwd'] == '/Users/test/project'
        assert processes[0]['is_gastown'] is False

    @patch('subprocess.run')
    def test_skips_non_cli_processes(self, mock_run):
        """Test that non-CLI claude processes are skipped."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 Claude.app
user             12346   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 /bin/zsh claude
user             12347   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 grep claude
user             12348   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 node_modules/claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)

        processes = get_claude_processes()
        assert len(processes) == 0

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_detects_gastown_by_command(self, mock_run, mock_cwd, mock_start):
        """Test detection of gastown process by command markers."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude [GAS TOWN] mayor <- human
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project'
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['is_gastown'] is True
        assert processes[0]['gastown_role'] == 'mayor'

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_detects_gastown_by_cwd(self, mock_run, mock_cwd, mock_start):
        """Test detection of gastown process by cwd patterns."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project/gt/deacon'
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['is_gastown'] is True
        assert processes[0]['gastown_role'] == 'deacon'

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_extracts_session_id_from_resume(self, mock_run, mock_cwd, mock_start):
        """Test extraction of session ID from --resume flag."""
        session_id = '12345678-1234-1234-1234-123456789abc'
        ps_output = f'''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude --resume {session_id}
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project'
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['session_id'] == session_id

    @patch('subprocess.run')
    def test_skips_no_tty_processes(self, mock_run):
        """Test that processes without TTY are skipped."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 ?     S+   10:00AM   0:05.00 claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)

        processes = get_claude_processes()
        assert len(processes) == 0

    @patch('subprocess.run')
    def test_skips_zombie_processes(self, mock_run):
        """Test that zombie processes are skipped."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  Z+   10:00AM   0:05.00 claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)

        processes = get_claude_processes()
        assert len(processes) == 0


class TestGetClaudeProcessesCached:
    """Tests for get_claude_processes_cached function."""

    @patch('src.api.detection.processes.get_claude_processes')
    def test_uses_cache(self, mock_get):
        """Test that results are cached."""
        import src.api.detection.processes as proc_module

        # Reset cache
        proc_module._process_cache = None

        mock_get.return_value = [{'pid': 123}]

        # First call
        with patch('time.time', return_value=1000.0):
            result1 = get_claude_processes_cached()

        # Second call within TTL
        with patch('time.time', return_value=1000.5):
            result2 = get_claude_processes_cached()

        # Should only call get_claude_processes once
        assert mock_get.call_count == 1
        assert result1 == result2

    @patch('src.api.detection.processes.get_claude_processes')
    def test_refreshes_after_ttl(self, mock_get):
        """Test that cache is refreshed after TTL."""
        import src.api.detection.processes as proc_module

        # Reset cache
        proc_module._process_cache = None

        mock_get.return_value = [{'pid': 123}]

        # First call
        with patch('time.time', return_value=1000.0):
            get_claude_processes_cached()

        # Call after TTL expires
        with patch('time.time', return_value=1000.0 + PROCESS_CACHE_TTL + 1):
            get_claude_processes_cached()

        # Should call get_claude_processes twice
        assert mock_get.call_count == 2


class TestGastownRoleExtraction:
    """Tests for gastown role extraction from various sources."""

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_role_from_gt_role_env(self, mock_run, mock_cwd, mock_start):
        """Test role extraction from GT_ROLE environment variable."""
        # The env var appears in the full ps aux line, and command must be 'claude'
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude GT_ROLE=witness
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project/gt/witness'  # Gastown cwd triggers detection
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['is_gastown'] is True
        assert processes[0]['gastown_role'] == 'witness'

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_rig_role_from_cwd(self, mock_run, mock_cwd, mock_start):
        """Test rig role from cwd ending in /rig."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project/rig'
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['is_gastown'] is True
        assert processes[0]['gastown_role'] == 'rig'

    @patch('src.api.detection.processes.get_process_start_time')
    @patch('src.api.detection.processes.get_process_cwd')
    @patch('subprocess.run')
    def test_polecat_role_from_cwd(self, mock_run, mock_cwd, mock_start):
        """Test polecat role from cwd containing /polecats/."""
        ps_output = '''USER               PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
user             12345   0.5  1.0   123456  12345 s000  S+   10:00AM   0:05.00 claude
'''
        mock_run.return_value = MagicMock(stdout=ps_output)
        mock_cwd.return_value = '/Users/test/project/polecats/worker1'
        mock_start.return_value = 1000.0

        with patch('pathlib.Path.exists', return_value=True):
            processes = get_claude_processes()

        assert len(processes) == 1
        assert processes[0]['is_gastown'] is True
        assert processes[0]['gastown_role'] == 'polecat'

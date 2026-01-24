"""Tests for SSH tunnel manager."""

import subprocess
from unittest.mock import patch, MagicMock

from src.api.tunnel_manager import SSHTunnel


class TestSSHTunnel:
    """Tests for SSHTunnel dataclass."""

    def test_creation(self):
        """Test creating SSHTunnel instance."""
        tunnel = SSHTunnel(
            name='test-server',
            host='user@host.example.com',
            local_port=8082
        )

        assert tunnel.name == 'test-server'
        assert tunnel.host == 'user@host.example.com'
        assert tunnel.local_port == 8082
        assert tunnel.remote_port == 8081  # Default
        assert tunnel.connected is False
        assert tunnel.process is None

    def test_default_values(self):
        """Test default values."""
        tunnel = SSHTunnel(
            name='test',
            host='host',
            local_port=8082
        )

        assert tunnel.remote_port == 8081
        assert tunnel.ssh_key is None
        assert tunnel.auto_reconnect is True
        assert tunnel.last_error is None

    def test_with_ssh_key(self):
        """Test creating tunnel with SSH key."""
        tunnel = SSHTunnel(
            name='test',
            host='host',
            local_port=8082,
            ssh_key='/path/to/key'
        )

        assert tunnel.ssh_key == '/path/to/key'


class TestSSHTunnelConnect:
    """Tests for SSHTunnel.connect method."""

    @patch('subprocess.Popen')
    def test_successful_connect(self, mock_popen):
        """Test successful tunnel connection."""
        mock_process = MagicMock()
        mock_process.poll.return_value = None  # Process still running
        mock_popen.return_value = mock_process

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)

        with patch('time.sleep'):  # Skip actual sleep
            result = tunnel.connect()

        assert result is True
        assert tunnel.connected is True
        assert tunnel.last_error is None
        mock_popen.assert_called_once()

    @patch('subprocess.Popen')
    def test_failed_connect(self, mock_popen):
        """Test failed tunnel connection."""
        mock_process = MagicMock()
        mock_process.poll.return_value = 1  # Process exited
        mock_process.communicate.return_value = (b'', b'Connection refused')
        mock_popen.return_value = mock_process

        tunnel = SSHTunnel(name='test', host='user@badhost', local_port=8082)

        with patch('time.sleep'):
            result = tunnel.connect()

        assert result is False
        assert tunnel.connected is False
        assert tunnel.last_error is not None
        assert 'Connection refused' in tunnel.last_error

    @patch('subprocess.Popen')
    def test_connect_with_ssh_key(self, mock_popen):
        """Test connection includes SSH key in command."""
        mock_process = MagicMock()
        mock_process.poll.return_value = None
        mock_popen.return_value = mock_process

        tunnel = SSHTunnel(
            name='test',
            host='user@host',
            local_port=8082,
            ssh_key='/path/to/key'
        )

        with patch('time.sleep'):
            tunnel.connect()

        # Check that -i flag is in the command
        call_args = mock_popen.call_args[0][0]
        assert '-i' in call_args
        assert '/path/to/key' in call_args

    @patch('subprocess.Popen')
    def test_connect_exception(self, mock_popen):
        """Test connection handles exceptions."""
        mock_popen.side_effect = Exception("SSH not found")

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)

        with patch('time.sleep'):
            result = tunnel.connect()

        assert result is False
        assert tunnel.last_error is not None
        assert 'SSH not found' in tunnel.last_error

    def test_already_connected(self):
        """Test connect returns True if already connected."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        tunnel.process = MagicMock()
        tunnel.process.poll.return_value = None  # Still running
        tunnel.connected = True

        result = tunnel.connect()

        assert result is True


class TestSSHTunnelDisconnect:
    """Tests for SSHTunnel.disconnect method."""

    def test_disconnect(self):
        """Test disconnecting tunnel."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        mock_process = MagicMock()
        tunnel.process = mock_process
        tunnel.connected = True

        tunnel.disconnect()

        mock_process.terminate.assert_called_once()
        assert tunnel.process is None
        assert tunnel.connected is False

    def test_disconnect_no_process(self):
        """Test disconnect when no process."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)

        # Should not raise
        tunnel.disconnect()

        assert tunnel.connected is False

    def test_disconnect_force_kill(self):
        """Test force kill on timeout."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        mock_process = MagicMock()
        mock_process.wait.side_effect = subprocess.TimeoutExpired('ssh', 5)
        tunnel.process = mock_process

        tunnel.disconnect()

        mock_process.kill.assert_called_once()


class TestSSHTunnelIsConnected:
    """Tests for SSHTunnel.is_connected method."""

    def test_connected_with_running_process(self):
        """Test is_connected returns True when process running."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        mock_process = MagicMock()
        mock_process.poll.return_value = None  # Running
        tunnel.process = mock_process

        assert tunnel.is_connected() is True

    def test_not_connected_no_process(self):
        """Test is_connected returns False when no process."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)

        assert tunnel.is_connected() is False

    def test_not_connected_dead_process(self):
        """Test is_connected returns False when process exited."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        mock_process = MagicMock()
        mock_process.poll.return_value = 1  # Exited
        tunnel.process = mock_process
        tunnel.connected = True

        result = tunnel.is_connected()

        assert result is False
        assert tunnel.connected is False  # Should be updated


class TestSSHTunnelGetSessions:
    """Tests for SSHTunnel.get_sessions method."""

    @patch('requests.get')
    def test_get_sessions_success(self, mock_get):
        """Test successful session fetch."""
        mock_response = MagicMock()
        mock_response.json.return_value = {
            'sessions': [{'sessionId': 'test-1'}]
        }
        mock_get.return_value = mock_response

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        tunnel.process = MagicMock()
        tunnel.process.poll.return_value = None

        result = tunnel.get_sessions()

        assert 'sessions' in result
        assert len(result['sessions']) == 1
        assert tunnel.last_health_check is not None

    def test_get_sessions_disconnected(self):
        """Test get_sessions when disconnected."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)

        result = tunnel.get_sessions()

        assert result == {'error': 'Disconnected'}

    @patch('requests.get')
    def test_get_sessions_timeout(self, mock_get):
        """Test get_sessions handles timeout."""
        import requests
        mock_get.side_effect = requests.exceptions.Timeout()

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        tunnel.process = MagicMock()
        tunnel.process.poll.return_value = None

        result = tunnel.get_sessions()

        assert 'error' in result
        assert 'Timeout' in result['error']

    @patch('requests.get')
    def test_get_sessions_connection_error(self, mock_get):
        """Test get_sessions handles connection error."""
        import requests
        mock_get.side_effect = requests.exceptions.ConnectionError()

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        tunnel.process = MagicMock()
        tunnel.process.poll.return_value = None

        result = tunnel.get_sessions()

        assert 'error' in result
        assert 'Connection refused' in result['error']


class TestSSHTunnelHealthCheck:
    """Tests for SSHTunnel.health_check method."""

    @patch('requests.get')
    def test_health_check_success(self, mock_get):
        """Test successful health check."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_get.return_value = mock_response

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        tunnel.process = MagicMock()
        tunnel.process.poll.return_value = None

        result = tunnel.health_check()

        assert result is True
        assert tunnel.last_health_check is not None

    def test_health_check_disconnected(self):
        """Test health check when disconnected."""
        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)

        result = tunnel.health_check()

        assert result is False

    @patch('requests.get')
    def test_health_check_failure(self, mock_get):
        """Test health check failure."""
        mock_get.side_effect = Exception("Connection failed")

        tunnel = SSHTunnel(name='test', host='user@host', local_port=8082)
        tunnel.process = MagicMock()
        tunnel.process.poll.return_value = None

        result = tunnel.health_check()

        assert result is False

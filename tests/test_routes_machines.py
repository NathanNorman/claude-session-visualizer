"""Tests for multi-machine management routes."""

from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from src.api.server import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


class TestListMachines:
    """Tests for GET /api/machines endpoint."""

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_returns_machine_list(self, mock_get_manager, client):
        """Test returns list of machines."""
        mock_manager = MagicMock()
        mock_manager.list_machines.return_value = [
            {'name': 'server1', 'host': 'host1', 'connected': True},
            {'name': 'server2', 'host': 'host2', 'connected': False},
        ]
        mock_get_manager.return_value = mock_manager

        response = client.get('/api/machines')

        assert response.status_code == 200
        data = response.json()
        assert 'machines' in data
        assert 'timestamp' in data
        assert len(data['machines']) == 2

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_empty_machine_list(self, mock_get_manager, client):
        """Test returns empty list when no machines configured."""
        mock_manager = MagicMock()
        mock_manager.list_machines.return_value = []
        mock_get_manager.return_value = mock_manager

        response = client.get('/api/machines')

        assert response.status_code == 200
        assert response.json()['machines'] == []


class TestAddMachine:
    """Tests for POST /api/machines endpoint."""

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_add_machine_success(self, mock_get_manager, client):
        """Test successful machine addition."""
        mock_manager = MagicMock()
        mock_manager.add_machine.return_value = {
            'name': 'new-server',
            'connected': True,
            'message': 'Connected successfully'
        }
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines', json={
            'name': 'new-server',
            'host': 'host.example.com'
        })

        assert response.status_code == 200
        mock_manager.add_machine.assert_called_once()

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_add_machine_with_ssh_key(self, mock_get_manager, client):
        """Test adding machine with SSH key."""
        mock_manager = MagicMock()
        mock_manager.add_machine.return_value = {'name': 'server', 'connected': True}
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines', json={
            'name': 'server',
            'host': 'host.example.com',
            'ssh_key': '/path/to/key',
            'auto_reconnect': True
        })

        assert response.status_code == 200
        mock_manager.add_machine.assert_called_once_with(
            name='server',
            host='host.example.com',
            ssh_key='/path/to/key',
            auto_reconnect=True
        )

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_add_machine_error(self, mock_get_manager, client):
        """Test machine addition error returns 400."""
        mock_manager = MagicMock()
        mock_manager.add_machine.return_value = {'error': 'Connection failed'}
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines', json={
            'name': 'bad-server',
            'host': 'invalid.host'
        })

        assert response.status_code == 400


class TestRemoveMachine:
    """Tests for DELETE /api/machines/{name} endpoint."""

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_remove_machine_success(self, mock_get_manager, client):
        """Test successful machine removal."""
        mock_manager = MagicMock()
        mock_manager.remove_machine.return_value = {
            'name': 'server1',
            'removed': True
        }
        mock_get_manager.return_value = mock_manager

        response = client.delete('/api/machines/server1')

        assert response.status_code == 200
        mock_manager.remove_machine.assert_called_once_with('server1')

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_remove_machine_not_found(self, mock_get_manager, client):
        """Test removing non-existent machine returns 404."""
        mock_manager = MagicMock()
        mock_manager.remove_machine.return_value = {'error': 'Machine not found'}
        mock_get_manager.return_value = mock_manager

        response = client.delete('/api/machines/nonexistent')

        assert response.status_code == 404


class TestReconnectMachine:
    """Tests for POST /api/machines/{name}/reconnect endpoint."""

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_reconnect_success(self, mock_get_manager, client):
        """Test successful reconnection."""
        mock_manager = MagicMock()
        mock_manager.reconnect_machine.return_value = {
            'name': 'server1',
            'connected': True
        }
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines/server1/reconnect')

        assert response.status_code == 200
        mock_manager.reconnect_machine.assert_called_once_with('server1')

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_reconnect_error(self, mock_get_manager, client):
        """Test reconnection error returns 400."""
        mock_manager = MagicMock()
        mock_manager.reconnect_machine.return_value = {'error': 'Reconnection failed'}
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines/server1/reconnect')

        assert response.status_code == 400


class TestTestMachineConnection:
    """Tests for POST /api/machines/test endpoint."""

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_connection_test_success(self, mock_get_manager, client):
        """Test successful connection test."""
        mock_manager = MagicMock()
        mock_manager.test_connection.return_value = {
            'success': True,
            'latency_ms': 50
        }
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines/test?host=test.example.com')

        assert response.status_code == 200
        data = response.json()
        assert data['success'] is True

    @patch('src.api.routes.machines.get_tunnel_manager')
    def test_connection_test_with_ssh_key(self, mock_get_manager, client):
        """Test connection test with SSH key."""
        mock_manager = MagicMock()
        mock_manager.test_connection.return_value = {'success': True}
        mock_get_manager.return_value = mock_manager

        response = client.post('/api/machines/test?host=test.example.com&ssh_key=/path/key')

        mock_manager.test_connection.assert_called_once_with('test.example.com', '/path/key')


class TestGetAllSessionsMultiMachine:
    """Tests for GET /api/sessions/all endpoint."""

    @patch('src.api.routes.machines.get_tunnel_manager')
    @patch('src.api.routes.machines.get_sessions')
    @patch('socket.gethostname')
    def test_returns_local_and_remote_sessions(self, mock_hostname, mock_get_sessions,
                                                mock_get_manager, client):
        """Test returns both local and remote sessions."""
        mock_hostname.return_value = 'local-machine'
        mock_get_sessions.return_value = [
            {'sessionId': 'local-1', 'state': 'active'},
            {'sessionId': 'local-2', 'state': 'waiting'},
        ]

        mock_manager = MagicMock()
        mock_manager.get_all_sessions.return_value = {
            'remote-server': {
                'sessions': [
                    {'sessionId': 'remote-1', 'state': 'active'}
                ]
            }
        }
        mock_get_manager.return_value = mock_manager

        response = client.get('/api/sessions/all')

        assert response.status_code == 200
        data = response.json()
        assert 'local' in data
        assert 'remote' in data
        assert data['local']['hostname'] == 'local-machine'
        assert len(data['local']['sessions']) == 2
        assert data['machineCount'] == 2  # 1 local + 1 remote

    @patch('src.api.routes.machines.get_tunnel_manager')
    @patch('src.api.routes.machines.get_sessions')
    @patch('socket.gethostname')
    def test_handles_remote_errors(self, mock_hostname, mock_get_sessions,
                                   mock_get_manager, client):
        """Test handles errors from remote machines."""
        mock_hostname.return_value = 'local'
        mock_get_sessions.return_value = []

        mock_manager = MagicMock()
        mock_manager.get_all_sessions.return_value = {
            'bad-server': {'error': 'Connection refused'}
        }
        mock_get_manager.return_value = mock_manager

        response = client.get('/api/sessions/all')

        assert response.status_code == 200
        data = response.json()
        assert 'error' in data['remoteTotals']['bad-server']
        assert data['machineCount'] == 1  # Only local counts

    @patch('src.api.routes.machines.get_tunnel_manager')
    @patch('src.api.routes.machines.get_sessions')
    @patch('socket.gethostname')
    def test_calculates_totals(self, mock_hostname, mock_get_sessions,
                               mock_get_manager, client):
        """Test calculates active/waiting totals correctly."""
        mock_hostname.return_value = 'local'
        mock_get_sessions.return_value = [
            {'sessionId': '1', 'state': 'active'},
            {'sessionId': '2', 'state': 'active'},
            {'sessionId': '3', 'state': 'waiting'},
        ]

        mock_manager = MagicMock()
        mock_manager.get_all_sessions.return_value = {}
        mock_get_manager.return_value = mock_manager

        response = client.get('/api/sessions/all')

        data = response.json()
        assert data['local']['totals']['active'] == 2
        assert data['local']['totals']['waiting'] == 1

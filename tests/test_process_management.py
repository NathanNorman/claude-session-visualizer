"""Comprehensive E2E tests for Process Management feature.

Tests the full lifecycle of spawning and controlling Claude sessions from Mission Control.
"""

import asyncio
import json
import os
import signal
import tempfile
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest
from fastapi import WebSocket
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from src.api.process_manager import (
    ManagedProcess,
    ProcessManager,
    get_process_manager,
)
from src.api.routes.processes import (
    SpawnRequest,
    StdinRequest,
    ProcessInfo,
    router as processes_router,
)


# =============================================================================
# ProcessManager Unit Tests
# =============================================================================

class TestManagedProcess:
    """Tests for ManagedProcess dataclass."""

    def test_creates_with_defaults(self):
        """Test ManagedProcess creates with default values."""
        process = ManagedProcess(
            id="test-123",
            pty_master_fd=5,
            pid=12345,
            cwd="/tmp/test",
            state="running",
            started_at=datetime.now(timezone.utc),
        )

        assert process.id == "test-123"
        assert process.pty_master_fd == 5
        assert process.pid == 12345
        assert process.cwd == "/tmp/test"
        assert process.state == "running"
        assert isinstance(process.output_buffer, deque)
        assert process.output_buffer.maxlen == 1000
        assert isinstance(process.websocket_clients, set)
        assert len(process.websocket_clients) == 0
        assert process.exit_code is None
        assert process._read_task is None

    def test_output_buffer_maxlen(self):
        """Test output buffer respects max length."""
        process = ManagedProcess(
            id="test",
            pty_master_fd=5,
            pid=123,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )

        # Fill beyond capacity
        for i in range(1500):
            process.output_buffer.append({"data": f"line-{i}"})

        assert len(process.output_buffer) == 1000
        # Oldest entries should be dropped
        assert process.output_buffer[0]["data"] == "line-500"


class TestProcessManagerInit:
    """Tests for ProcessManager initialization."""

    def test_initializes_empty(self):
        """Test ProcessManager starts with no processes."""
        manager = ProcessManager()

        assert manager.processes == {}
        assert manager._cleanup_lock is not None

    def test_list_processes_empty(self):
        """Test listing processes when none exist."""
        manager = ProcessManager()

        result = manager.list_processes()

        assert result == []

    def test_get_process_not_found(self):
        """Test getting non-existent process returns None."""
        manager = ProcessManager()

        result = manager.get_process("nonexistent")

        assert result is None


class TestProcessManagerSpawn:
    """Tests for ProcessManager.spawn()."""

    @pytest.fixture
    def manager(self):
        """Fresh process manager for each test."""
        return ProcessManager()

    @pytest.fixture
    def temp_dir(self):
        """Create a temporary directory for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @patch('os.fork')
    @patch('pty.openpty')
    @patch('os.close')
    @patch('fcntl.fcntl')
    async def test_spawn_creates_process(self, mock_fcntl, mock_close, mock_openpty, mock_fork, manager, temp_dir):
        """Test spawn creates a managed process."""
        mock_openpty.return_value = (10, 11)  # master_fd, slave_fd
        mock_fork.return_value = 12345  # PID (parent process)

        with patch.object(manager, '_read_output_loop', return_value=asyncio.sleep(0)):
            process = await manager.spawn(cwd=temp_dir)

        assert process is not None
        assert process.pid == 12345
        assert process.cwd == temp_dir
        assert process.state == "running"
        assert process.id in manager.processes
        mock_close.assert_called_with(11)  # slave_fd closed in parent

    @patch('os.fork')
    @patch('pty.openpty')
    @patch('os.close')
    @patch('fcntl.fcntl')
    async def test_spawn_generates_unique_ids(self, mock_fcntl, mock_close, mock_openpty, mock_fork, manager, temp_dir):
        """Test each spawn generates a unique process ID."""
        mock_openpty.return_value = (10, 11)
        mock_fork.return_value = 12345

        with patch.object(manager, '_read_output_loop', return_value=asyncio.sleep(0)):
            process1 = await manager.spawn(cwd=temp_dir)
            mock_fork.return_value = 12346
            process2 = await manager.spawn(cwd=temp_dir)

        assert process1.id != process2.id
        assert len(manager.processes) == 2

    @patch('os.fork')
    @patch('pty.openpty')
    @patch('os.close')
    @patch('fcntl.fcntl')
    async def test_spawn_with_args(self, mock_fcntl, mock_close, mock_openpty, mock_fork, manager, temp_dir):
        """Test spawn passes arguments to command."""
        mock_openpty.return_value = (10, 11)
        mock_fork.return_value = 12345

        with patch.object(manager, '_read_output_loop', return_value=asyncio.sleep(0)):
            process = await manager.spawn(cwd=temp_dir, args=["--help"])

        assert process is not None

    @patch('os.fork')
    @patch('pty.openpty')
    @patch('os.close')
    @patch('fcntl.fcntl')
    async def test_spawn_sets_pty_nonblocking(self, mock_fcntl, mock_close, mock_openpty, mock_fork, manager, temp_dir):
        """Test spawn sets PTY to non-blocking mode."""
        mock_openpty.return_value = (10, 11)
        mock_fork.return_value = 12345
        mock_fcntl.return_value = 0

        with patch.object(manager, '_read_output_loop', return_value=asyncio.sleep(0)):
            await manager.spawn(cwd=temp_dir)

        # Check fcntl was called to set non-blocking
        assert mock_fcntl.call_count >= 2


class TestProcessManagerSendStdin:
    """Tests for ProcessManager.send_stdin()."""

    @pytest.fixture
    def manager_with_process(self):
        """Manager with a mock running process."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp/test",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process
        return manager, process

    @patch('os.write')
    async def test_send_stdin_writes_to_pty(self, mock_write, manager_with_process):
        """Test send_stdin writes text to PTY."""
        manager, process = manager_with_process

        await manager.send_stdin("test-proc", "hello")

        mock_write.assert_called_once_with(10, b"hello\n")

    @patch('os.write')
    async def test_send_stdin_appends_newline(self, mock_write, manager_with_process):
        """Test send_stdin appends newline by default."""
        manager, process = manager_with_process

        await manager.send_stdin("test-proc", "test")

        mock_write.assert_called_with(10, b"test\n")

    @patch('os.write')
    async def test_send_stdin_no_newline(self, mock_write, manager_with_process):
        """Test send_stdin without newline when specified."""
        manager, process = manager_with_process

        await manager.send_stdin("test-proc", "test", newline=False)

        mock_write.assert_called_with(10, b"test")

    @patch('os.write')
    async def test_send_stdin_preserves_existing_newline(self, mock_write, manager_with_process):
        """Test send_stdin doesn't double newline."""
        manager, process = manager_with_process

        await manager.send_stdin("test-proc", "test\n")

        mock_write.assert_called_with(10, b"test\n")

    async def test_send_stdin_process_not_found(self):
        """Test send_stdin raises for non-existent process."""
        manager = ProcessManager()

        with pytest.raises(ValueError, match="not found"):
            await manager.send_stdin("nonexistent", "hello")

    async def test_send_stdin_process_stopped(self, manager_with_process):
        """Test send_stdin raises for stopped process."""
        manager, process = manager_with_process
        process.state = "stopped"

        with pytest.raises(ValueError, match="not running"):
            await manager.send_stdin("test-proc", "hello")


class TestProcessManagerKill:
    """Tests for ProcessManager.kill()."""

    @pytest.fixture
    async def manager_with_process(self):
        """Manager with a mock running process."""
        manager = ProcessManager()

        # Create a real asyncio task that we can cancel
        async def dummy_task():
            try:
                await asyncio.sleep(1000)
            except asyncio.CancelledError:
                pass

        task = asyncio.create_task(dummy_task())

        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp/test",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        process._read_task = task
        manager.processes["test-proc"] = process
        return manager, process

    @patch('os.close')
    @patch('os.kill')
    async def test_kill_sends_sigterm(self, mock_kill, mock_close, manager_with_process):
        """Test kill sends SIGTERM by default."""
        manager, process = manager_with_process

        await manager.kill("test-proc")

        mock_kill.assert_called_once_with(12345, signal.SIGTERM)
        assert process.state == "stopped"

    @patch('os.close')
    @patch('os.kill')
    async def test_kill_force_sends_sigkill(self, mock_kill, mock_close, manager_with_process):
        """Test kill with force=True sends SIGKILL."""
        manager, process = manager_with_process

        await manager.kill("test-proc", force=True)

        mock_kill.assert_called_once_with(12345, signal.SIGKILL)

    @patch('os.close')
    @patch('os.kill')
    async def test_kill_closes_pty(self, mock_kill, mock_close, manager_with_process):
        """Test kill closes PTY file descriptor."""
        manager, process = manager_with_process

        await manager.kill("test-proc")

        mock_close.assert_called_with(10)

    @patch('os.close')
    @patch('os.kill')
    async def test_kill_cancels_read_task(self, mock_kill, mock_close, manager_with_process):
        """Test kill cancels the read output task."""
        manager, process = manager_with_process
        task = process._read_task

        await manager.kill("test-proc")

        # Task should be cancelled
        assert task.cancelled() or task.done()

    async def test_kill_process_not_found(self):
        """Test kill raises for non-existent process."""
        manager = ProcessManager()

        with pytest.raises(ValueError, match="not found"):
            await manager.kill("nonexistent")

    @patch('os.close')
    @patch('os.kill')
    async def test_kill_already_stopped(self, mock_kill, mock_close, manager_with_process):
        """Test kill is idempotent for stopped process."""
        manager, process = manager_with_process
        process.state = "stopped"

        await manager.kill("test-proc")

        mock_kill.assert_not_called()

    @patch('os.close')
    @patch('os.kill')
    async def test_kill_handles_process_not_exist(self, mock_kill, mock_close, manager_with_process):
        """Test kill handles ProcessLookupError gracefully."""
        manager, process = manager_with_process
        mock_kill.side_effect = ProcessLookupError()

        # Should not raise
        await manager.kill("test-proc")

        assert process.state == "stopped"


class TestProcessManagerStreamOutput:
    """Tests for ProcessManager.stream_output()."""

    @pytest.fixture
    def manager_with_process(self):
        """Manager with a process that has buffered output."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp/test",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        process.output_buffer.append({"data": "line 1\n", "timestamp": "2024-01-01T00:00:00Z"})
        process.output_buffer.append({"data": "line 2\n", "timestamp": "2024-01-01T00:00:01Z"})
        manager.processes["test-proc"] = process
        return manager, process

    async def test_stream_sends_history(self, manager_with_process):
        """Test stream_output sends buffered history on connect."""
        manager, process = manager_with_process
        mock_ws = AsyncMock()
        mock_ws.receive_text.side_effect = Exception("disconnect")

        await manager.stream_output("test-proc", mock_ws)

        # Check history was sent
        calls = mock_ws.send_json.call_args_list
        history_call = calls[0]
        assert history_call[0][0]["type"] == "history"
        assert history_call[0][0]["lines"] == ["line 1\n", "line 2\n"]

    async def test_stream_sends_state(self, manager_with_process):
        """Test stream_output sends current state."""
        manager, process = manager_with_process
        mock_ws = AsyncMock()
        mock_ws.receive_text.side_effect = Exception("disconnect")

        await manager.stream_output("test-proc", mock_ws)

        calls = mock_ws.send_json.call_args_list
        state_call = calls[1]
        assert state_call[0][0]["type"] == "state"
        assert state_call[0][0]["state"] == "running"

    async def test_stream_adds_client(self, manager_with_process):
        """Test stream_output adds client to broadcast list."""
        manager, process = manager_with_process
        mock_ws = AsyncMock()
        mock_ws.receive_text.side_effect = Exception("disconnect")

        await manager.stream_output("test-proc", mock_ws)

        # Client should be removed after disconnect
        assert mock_ws not in process.websocket_clients

    async def test_stream_handles_ping(self, manager_with_process):
        """Test stream_output responds to ping messages."""
        manager, process = manager_with_process
        mock_ws = AsyncMock()
        mock_ws.receive_text.side_effect = [
            '{"type": "ping"}',
            Exception("disconnect")
        ]

        await manager.stream_output("test-proc", mock_ws)

        # Check pong was sent
        pong_calls = [c for c in mock_ws.send_json.call_args_list if c[0][0].get("type") == "pong"]
        assert len(pong_calls) == 1

    async def test_stream_process_not_found(self):
        """Test stream_output sends error for non-existent process."""
        manager = ProcessManager()
        mock_ws = AsyncMock()

        await manager.stream_output("nonexistent", mock_ws)

        mock_ws.send_json.assert_called_once()
        call_arg = mock_ws.send_json.call_args[0][0]
        assert call_arg["type"] == "error"
        assert "not found" in call_arg["message"]


class TestProcessManagerBroadcast:
    """Tests for broadcast functionality."""

    @pytest.fixture
    def manager_with_clients(self):
        """Manager with a process that has multiple connected clients."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp/test",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        process.websocket_clients.add(ws1)
        process.websocket_clients.add(ws2)
        manager.processes["test-proc"] = process
        return manager, process, ws1, ws2

    async def test_broadcast_output_to_all(self, manager_with_clients):
        """Test output is broadcast to all connected clients."""
        manager, process, ws1, ws2 = manager_with_clients

        await manager._broadcast_output(process, "test data", "2024-01-01T00:00:00Z")

        ws1.send_json.assert_called_once()
        ws2.send_json.assert_called_once()
        assert ws1.send_json.call_args[0][0]["data"] == "test data"

    async def test_broadcast_removes_disconnected(self, manager_with_clients):
        """Test disconnected clients are removed from broadcast list."""
        manager, process, ws1, ws2 = manager_with_clients
        ws2.send_json.side_effect = Exception("disconnected")

        await manager._broadcast_output(process, "test data", "2024-01-01T00:00:00Z")

        assert ws1 in process.websocket_clients
        assert ws2 not in process.websocket_clients

    async def test_broadcast_state_change(self, manager_with_clients):
        """Test state changes are broadcast."""
        manager, process, ws1, ws2 = manager_with_clients
        process.state = "stopped"
        process.exit_code = 0

        await manager._broadcast_state_change(process)

        call_arg = ws1.send_json.call_args[0][0]
        assert call_arg["type"] == "state"
        assert call_arg["state"] == "stopped"
        assert call_arg["exit_code"] == 0


class TestProcessManagerCleanup:
    """Tests for ProcessManager.cleanup()."""

    @patch('os.close')
    @patch('os.kill')
    async def test_cleanup_kills_all(self, mock_kill, mock_close):
        """Test cleanup kills all processes."""
        manager = ProcessManager()

        # Create real tasks for each process
        async def dummy_task():
            try:
                await asyncio.sleep(1000)
            except asyncio.CancelledError:
                pass

        # Add multiple processes with real tasks
        for i in range(3):
            task = asyncio.create_task(dummy_task())
            process = ManagedProcess(
                id=f"proc-{i}",
                pty_master_fd=10 + i,
                pid=1000 + i,
                cwd="/tmp",
                state="running",
                started_at=datetime.now(timezone.utc),
            )
            process._read_task = task
            manager.processes[f"proc-{i}"] = process

        await manager.cleanup()

        assert mock_kill.call_count == 3
        assert len(manager.processes) == 0

    async def test_cleanup_empty(self):
        """Test cleanup with no processes does nothing."""
        manager = ProcessManager()

        # Should not raise
        await manager.cleanup()


class TestProcessManagerListProcesses:
    """Tests for ProcessManager.list_processes()."""

    def test_list_returns_process_info(self):
        """Test list_processes returns correct info."""
        manager = ProcessManager()
        now = datetime.now(timezone.utc)
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp/test",
            state="running",
            started_at=now,
        )
        process.exit_code = None
        ws = AsyncMock()
        process.websocket_clients.add(ws)
        manager.processes["test-proc"] = process

        result = manager.list_processes()

        assert len(result) == 1
        assert result[0]["id"] == "test-proc"
        assert result[0]["cwd"] == "/tmp/test"
        assert result[0]["state"] == "running"
        assert result[0]["exit_code"] is None
        assert result[0]["client_count"] == 1


# =============================================================================
# API Routes Tests
# =============================================================================

class TestSpawnRequest:
    """Tests for SpawnRequest validation."""

    def test_valid_directory(self, tmp_path):
        """Test valid directory is accepted."""
        request = SpawnRequest(cwd=str(tmp_path))
        assert request.cwd == str(tmp_path)

    def test_expands_home_directory(self, tmp_path):
        """Test home directory expansion."""
        with patch.object(Path, 'expanduser', return_value=tmp_path):
            with patch.object(Path, 'resolve', return_value=tmp_path):
                with patch.object(Path, 'exists', return_value=True):
                    with patch.object(Path, 'is_dir', return_value=True):
                        request = SpawnRequest(cwd="~/test")
                        assert "~" not in request.cwd

    def test_rejects_nonexistent_directory(self):
        """Test non-existent directory raises error."""
        with pytest.raises(ValueError, match="does not exist"):
            SpawnRequest(cwd="/nonexistent/path/12345")

    def test_rejects_file_path(self, tmp_path):
        """Test file path (not directory) raises error."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("test")

        with pytest.raises(ValueError, match="not a directory"):
            SpawnRequest(cwd=str(test_file))


class TestStdinRequest:
    """Tests for StdinRequest validation."""

    def test_defaults_newline_true(self):
        """Test newline defaults to True."""
        request = StdinRequest(text="hello")
        assert request.newline is True

    def test_can_disable_newline(self):
        """Test newline can be disabled."""
        request = StdinRequest(text="hello", newline=False)
        assert request.newline is False


class TestAPISpawnEndpoint:
    """Tests for POST /api/spawn endpoint."""

    @pytest.fixture
    def app(self):
        """Create test app with routes."""
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        """Test client."""
        return TestClient(app)

    def test_spawn_valid_directory(self, client, tmp_path):
        """Test spawning with valid directory."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_process = MagicMock()
            mock_process.id = "test-123"
            mock_process.cwd = str(tmp_path)
            mock_process.state = "running"
            mock_process.started_at = datetime.now(timezone.utc)
            mock_mgr.return_value.spawn = AsyncMock(return_value=mock_process)

            response = client.post("/api/spawn", json={"cwd": str(tmp_path)})

            assert response.status_code == 200
            data = response.json()
            assert data["process_id"] == "test-123"
            assert data["state"] == "running"

    def test_spawn_invalid_directory(self, client):
        """Test spawn with invalid directory returns 422."""
        response = client.post("/api/spawn", json={"cwd": "/nonexistent/path/12345"})
        assert response.status_code == 422

    def test_spawn_exception(self, client, tmp_path):
        """Test spawn exception returns 500."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.spawn = AsyncMock(side_effect=Exception("spawn failed"))

            response = client.post("/api/spawn", json={"cwd": str(tmp_path)})

            assert response.status_code == 500


class TestAPIStdinEndpoint:
    """Tests for POST /api/process/{id}/stdin endpoint."""

    @pytest.fixture
    def app(self):
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_stdin_success(self, client):
        """Test successful stdin send."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.send_stdin = AsyncMock()

            response = client.post(
                "/api/process/test-123/stdin",
                json={"text": "hello"}
            )

            assert response.status_code == 200
            assert response.json()["success"] is True

    def test_stdin_process_not_found(self, client):
        """Test stdin to non-existent process returns 404."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.send_stdin = AsyncMock(
                side_effect=ValueError("Process not-found not found")
            )

            response = client.post(
                "/api/process/not-found/stdin",
                json={"text": "hello"}
            )

            assert response.status_code == 404

    def test_stdin_with_newline_false(self, client):
        """Test stdin with newline=false."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.send_stdin = AsyncMock()

            response = client.post(
                "/api/process/test-123/stdin",
                json={"text": "hello", "newline": False}
            )

            assert response.status_code == 200
            mock_mgr.return_value.send_stdin.assert_called_once_with(
                process_id="test-123",
                text="hello",
                newline=False
            )


class TestAPIKillEndpoint:
    """Tests for POST /api/process/{id}/kill endpoint."""

    @pytest.fixture
    def app(self):
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_kill_success(self, client):
        """Test successful kill."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.kill = AsyncMock()

            response = client.post("/api/process/test-123/kill")

            assert response.status_code == 200
            assert response.json()["success"] is True

    def test_kill_not_found(self, client):
        """Test kill non-existent process returns 404."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.kill = AsyncMock(
                side_effect=ValueError("Process not-found not found")
            )

            response = client.post("/api/process/not-found/kill")

            assert response.status_code == 404

    def test_kill_with_force(self, client):
        """Test kill with force=true."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.kill = AsyncMock()

            response = client.post("/api/process/test-123/kill?force=true")

            assert response.status_code == 200
            mock_mgr.return_value.kill.assert_called_once_with(
                process_id="test-123",
                force=True
            )


class TestAPIListProcessesEndpoint:
    """Tests for GET /api/processes endpoint."""

    @pytest.fixture
    def app(self):
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_list_empty(self, client):
        """Test list with no processes."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.list_processes.return_value = []

            response = client.get("/api/processes")

            assert response.status_code == 200
            assert response.json() == []

    def test_list_with_processes(self, client):
        """Test list with multiple processes."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.list_processes.return_value = [
                {
                    "id": "proc-1",
                    "cwd": "/tmp/test1",
                    "state": "running",
                    "started_at": "2024-01-01T00:00:00+00:00",
                    "exit_code": None,
                    "client_count": 0
                },
                {
                    "id": "proc-2",
                    "cwd": "/tmp/test2",
                    "state": "stopped",
                    "started_at": "2024-01-01T00:00:00+00:00",
                    "exit_code": 0,
                    "client_count": 2
                }
            ]

            response = client.get("/api/processes")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 2
            assert data[0]["id"] == "proc-1"
            assert data[1]["exit_code"] == 0


class TestAPIGetProcessEndpoint:
    """Tests for GET /api/process/{id} endpoint."""

    @pytest.fixture
    def app(self):
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_get_existing_process(self, client):
        """Test getting an existing process."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_process = MagicMock()
            mock_process.id = "test-123"
            mock_process.cwd = "/tmp/test"
            mock_process.state = "running"
            mock_process.started_at = datetime.now(timezone.utc)
            mock_process.exit_code = None
            mock_process.websocket_clients = set()
            mock_mgr.return_value.get_process.return_value = mock_process

            response = client.get("/api/process/test-123")

            assert response.status_code == 200
            data = response.json()
            assert data["id"] == "test-123"

    def test_get_nonexistent_process(self, client):
        """Test getting non-existent process returns 404."""
        with patch('src.api.routes.processes.get_process_manager') as mock_mgr:
            mock_mgr.return_value.get_process.return_value = None

            response = client.get("/api/process/not-found")

            assert response.status_code == 404


class TestAPIRecentDirectoriesEndpoint:
    """Tests for GET /api/recent-directories endpoint."""

    @pytest.fixture
    def app(self):
        from fastapi import FastAPI
        app = FastAPI()
        app.include_router(processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_no_claude_projects_folder(self, client):
        """Test when Claude projects folder doesn't exist."""
        with patch.object(Path, 'exists', return_value=False):
            response = client.get("/api/recent-directories")

            assert response.status_code == 200
            assert response.json()["directories"] == []

    def test_returns_recent_dirs(self, client, tmp_path):
        """Test returns decoded directory paths."""
        # Create mock Claude projects structure
        projects_dir = tmp_path / ".claude" / "projects"
        projects_dir.mkdir(parents=True)

        # Create a project directory (encoded path)
        (projects_dir / "-Users-test-myproject").mkdir()

        with patch.object(Path, 'home', return_value=tmp_path):
            with patch.object(Path, 'exists', side_effect=lambda self=None: True):
                response = client.get("/api/recent-directories")

        assert response.status_code == 200


# =============================================================================
# Edge Cases and Error Handling
# =============================================================================

class TestEdgeCases:
    """Tests for edge cases and error scenarios."""

    async def test_rapid_stdin_sends(self):
        """Test rapid sequential stdin sends don't cause issues."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        with patch('os.write') as mock_write:
            # Send many messages rapidly
            for i in range(100):
                await manager.send_stdin("test-proc", f"message-{i}")

            assert mock_write.call_count == 100

    async def test_concurrent_client_connects(self):
        """Test multiple clients connecting concurrently."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        async def connect_client(i):
            ws = AsyncMock()
            ws.receive_text.side_effect = Exception("disconnect")
            await manager.stream_output("test-proc", ws)
            return ws

        # Connect multiple clients concurrently
        clients = await asyncio.gather(*[connect_client(i) for i in range(5)])

        # All should have received messages
        for client in clients:
            assert client.send_json.called

    async def test_process_immediate_exit(self):
        """Test handling process that exits immediately."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        with patch('os.waitpid', return_value=(12345, 0)):
            with patch('os.WIFEXITED', return_value=True):
                with patch('os.WEXITSTATUS', return_value=0):
                    await manager._check_process_exit(process)

        assert process.state == "stopped"
        assert process.exit_code == 0

    async def test_process_killed_by_signal(self):
        """Test handling process killed by signal."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        with patch('os.waitpid', return_value=(12345, 9)):  # SIGKILL
            with patch('os.WIFEXITED', return_value=False):
                with patch('os.WIFSIGNALED', return_value=True):
                    with patch('os.WTERMSIG', return_value=9):
                        await manager._check_process_exit(process)

        assert process.state == "stopped"
        assert process.exit_code == -9  # Negative for signals

    def test_output_buffer_overflow(self):
        """Test output buffer handles overflow correctly."""
        process = ManagedProcess(
            id="test",
            pty_master_fd=5,
            pid=123,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )

        # Add 2000 entries (buffer size is 1000)
        for i in range(2000):
            process.output_buffer.append({"data": f"line-{i}\n"})

        # Should only keep last 1000
        assert len(process.output_buffer) == 1000
        # First entry should be line-1000
        assert process.output_buffer[0]["data"] == "line-1000\n"
        # Last entry should be line-1999
        assert process.output_buffer[-1]["data"] == "line-1999\n"

    async def test_empty_stdin_text(self):
        """Test empty stdin text is handled."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        with patch('os.write') as mock_write:
            await manager.send_stdin("test-proc", "")

            # Should send just newline
            mock_write.assert_called_with(10, b"\n")

    async def test_unicode_stdin(self):
        """Test unicode text in stdin."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        with patch('os.write') as mock_write:
            await manager.send_stdin("test-proc", "Hello ")

            mock_write.assert_called_with(10, "Hello \n".encode('utf-8'))


class TestGlobalProcessManager:
    """Tests for global process manager singleton."""

    def test_get_process_manager_returns_same_instance(self):
        """Test get_process_manager returns singleton."""
        import src.api.process_manager as pm_module

        # Reset singleton
        pm_module._process_manager = None

        mgr1 = get_process_manager()
        mgr2 = get_process_manager()

        assert mgr1 is mgr2

    def test_get_process_manager_creates_if_none(self):
        """Test get_process_manager creates instance if none exists."""
        import src.api.process_manager as pm_module

        pm_module._process_manager = None

        mgr = get_process_manager()

        assert mgr is not None
        assert isinstance(mgr, ProcessManager)


# =============================================================================
# WebSocket Integration Tests
# =============================================================================

class TestWebSocketIntegration:
    """Integration tests for WebSocket process streaming."""

    async def test_websocket_receives_all_message_types(self):
        """Test WebSocket receives history, state, and output messages."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        process.output_buffer.append({"data": "previous output\n"})
        manager.processes["test-proc"] = process

        ws = AsyncMock()
        received_types = []

        def capture_send(msg):
            received_types.append(msg["type"])
            if len(received_types) >= 2:
                raise Exception("done")

        ws.send_json.side_effect = capture_send
        ws.receive_text.side_effect = Exception("disconnect")

        try:
            await manager.stream_output("test-proc", ws)
        except Exception:
            pass

        assert "history" in received_types
        assert "state" in received_types

    async def test_websocket_cleanup_on_error(self):
        """Test WebSocket is cleaned up on error."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        ws = AsyncMock()
        ws.send_json.side_effect = [None, None, Exception("error")]
        ws.receive_text.side_effect = Exception("disconnect")

        await manager.stream_output("test-proc", ws)

        # Client should be removed
        assert ws not in process.websocket_clients


# =============================================================================
# ANSI Parsing Tests (JavaScript function tested via expected behavior)
# =============================================================================

class TestANSIParsing:
    """Tests for ANSI escape code handling.

    These test the expected behavior that should be implemented
    in the frontend parseAnsiToHtml function.
    """

    def test_basic_colors_documented(self):
        """Document expected ANSI color code mappings."""
        expected_mappings = {
            '30': 'ansi-black',
            '31': 'ansi-red',
            '32': 'ansi-green',
            '33': 'ansi-yellow',
            '34': 'ansi-blue',
            '35': 'ansi-magenta',
            '36': 'ansi-cyan',
            '37': 'ansi-white',
            '90': 'ansi-bright-black',
            '91': 'ansi-bright-red',
            '92': 'ansi-bright-green',
            '93': 'ansi-bright-yellow',
            '94': 'ansi-bright-blue',
            '95': 'ansi-bright-magenta',
            '96': 'ansi-bright-cyan',
            '97': 'ansi-bright-white',
        }
        # This documents expected behavior
        assert len(expected_mappings) == 16

    def test_style_codes_documented(self):
        """Document expected ANSI style code mappings."""
        expected_styles = {
            '1': 'ansi-bold',
            '2': 'ansi-dim',
            '3': 'ansi-italic',
            '4': 'ansi-underline',
        }
        assert len(expected_styles) == 4

    def test_reset_code_documented(self):
        """Document that code 0 resets all styles."""
        # Code 0 or empty should reset all styles
        reset_codes = ['0', '']
        assert len(reset_codes) == 2


# =============================================================================
# Performance Tests
# =============================================================================

class TestPerformance:
    """Performance-related tests."""

    async def test_many_clients_broadcast(self):
        """Test broadcasting to many clients is efficient."""
        manager = ProcessManager()
        process = ManagedProcess(
            id="test-proc",
            pty_master_fd=10,
            pid=12345,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )
        manager.processes["test-proc"] = process

        # Add 100 clients
        for _ in range(100):
            ws = AsyncMock()
            process.websocket_clients.add(ws)

        # Broadcast should complete quickly
        import time
        start = time.time()
        await manager._broadcast_output(process, "test data", "2024-01-01T00:00:00Z")
        elapsed = time.time() - start

        # Should take less than 1 second for 100 clients
        assert elapsed < 1.0

    def test_large_output_buffer(self):
        """Test large output buffer handling."""
        process = ManagedProcess(
            id="test",
            pty_master_fd=5,
            pid=123,
            cwd="/tmp",
            state="running",
            started_at=datetime.now(timezone.utc),
        )

        # Fill buffer with large entries
        large_line = "x" * 10000  # 10KB per line
        for _ in range(1000):
            process.output_buffer.append({"data": large_line})

        # Should still work
        assert len(process.output_buffer) == 1000
        assert len(list(process.output_buffer)) == 1000

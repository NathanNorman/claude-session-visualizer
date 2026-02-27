"""Tests for StreamProcessManager and stream process API routes.

Tests the stream-based process management that replaced the PTY approach.
"""

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api.stream_process_manager import (
    ManagedStreamProcess,
    StreamProcessManager,
    get_stream_process_manager,
)
from src.api.routes.stream_processes import (
    SpawnRequest,
    TakeoverRequest,
    MessageRequest,
    router as stream_processes_router,
)


# =============================================================================
# StreamProcessManager Unit Tests
# =============================================================================

class TestManagedStreamProcess:
    """Tests for ManagedStreamProcess dataclass."""

    def test_creates_with_defaults(self):
        """Test ManagedStreamProcess creates with default values."""
        mock_proc = MagicMock()
        process = ManagedStreamProcess(
            id="test-123",
            pid=12345,
            cwd="/tmp/test",
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )

        assert process.id == "test-123"
        assert process.pid == 12345
        assert process.cwd == "/tmp/test"
        assert process.state == "running"
        assert process.session_id is None
        assert isinstance(process.websocket_clients, set)
        assert len(process.websocket_clients) == 0
        assert isinstance(process.message_callbacks, list)
        assert isinstance(process.exit_callbacks, list)
        assert process._reader_task is None
        assert process._stderr_task is None
        assert process._heartbeat_task is None
        assert process._lifecycle_task is None


class TestStreamProcessManagerInit:
    """Tests for StreamProcessManager initialization."""

    def test_initializes_empty(self):
        """Test StreamProcessManager starts with no processes."""
        manager = StreamProcessManager()

        assert manager.processes == {}
        assert manager._cleanup_lock is not None

    def test_list_processes_empty(self):
        """Test listing processes when none exist."""
        manager = StreamProcessManager()

        result = manager.list_processes()
        assert result == []

    def test_get_process_not_found(self):
        """Test getting non-existent process returns None."""
        manager = StreamProcessManager()

        result = manager.get_process("nonexistent")
        assert result is None


class TestStreamProcessManagerSpawn:
    """Tests for StreamProcessManager.spawn()."""

    @pytest.fixture
    def manager(self):
        return StreamProcessManager()

    @pytest.mark.asyncio
    async def test_spawn_returns_process_id(self, manager, tmp_path):
        """Test spawn returns a string process ID."""
        mock_proc = AsyncMock()
        mock_proc.pid = 12345
        mock_proc.stdout = AsyncMock()
        mock_proc.stderr = AsyncMock()
        mock_proc.stdin = AsyncMock()
        mock_proc.wait = AsyncMock(return_value=0)

        # Make stdout/stderr iterators return empty
        mock_proc.stdout.__aiter__ = AsyncMock(return_value=iter([]))
        mock_proc.stderr.__aiter__ = AsyncMock(return_value=iter([]))

        with patch('asyncio.create_subprocess_exec', return_value=mock_proc):
            with patch.object(manager, '_read_stdout_loop', return_value=None):
                with patch.object(manager, '_read_stderr_loop', return_value=None):
                    with patch.object(manager, '_heartbeat_loop', return_value=None):
                        with patch.object(manager, '_monitor_lifecycle', return_value=None):
                            process_id = await manager.spawn(cwd=str(tmp_path))

        assert isinstance(process_id, str)
        assert len(process_id) == 8
        assert process_id in manager.processes

    @pytest.mark.asyncio
    async def test_spawn_removes_claudecode_env(self, manager, tmp_path):
        """Test spawn removes CLAUDECODE from environment."""
        mock_proc = AsyncMock()
        mock_proc.pid = 12345
        mock_proc.stdout = AsyncMock()
        mock_proc.stderr = AsyncMock()
        mock_proc.stdin = AsyncMock()

        captured_env = {}

        async def capture_exec(*args, **kwargs):
            captured_env.update(kwargs.get('env', {}))
            return mock_proc

        with patch('asyncio.create_subprocess_exec', side_effect=capture_exec):
            with patch.object(manager, '_read_stdout_loop', return_value=None):
                with patch.object(manager, '_read_stderr_loop', return_value=None):
                    with patch.object(manager, '_heartbeat_loop', return_value=None):
                        with patch.object(manager, '_monitor_lifecycle', return_value=None):
                            with patch.dict('os.environ', {'CLAUDECODE': '1'}):
                                await manager.spawn(cwd=str(tmp_path))

        assert 'CLAUDECODE' not in captured_env

    @pytest.mark.asyncio
    async def test_spawn_with_resume(self, manager, tmp_path):
        """Test spawn passes --resume flag."""
        mock_proc = AsyncMock()
        mock_proc.pid = 12345
        mock_proc.stdout = AsyncMock()
        mock_proc.stderr = AsyncMock()
        mock_proc.stdin = AsyncMock()

        captured_cmd = []

        async def capture_exec(*args, **kwargs):
            captured_cmd.extend(args)
            return mock_proc

        with patch('asyncio.create_subprocess_exec', side_effect=capture_exec):
            with patch.object(manager, '_read_stdout_loop', return_value=None):
                with patch.object(manager, '_read_stderr_loop', return_value=None):
                    with patch.object(manager, '_heartbeat_loop', return_value=None):
                        with patch.object(manager, '_monitor_lifecycle', return_value=None):
                            await manager.spawn(
                                cwd=str(tmp_path),
                                resume_session_id="abc-123",
                            )

        assert "--resume" in captured_cmd
        assert "abc-123" in captured_cmd


class TestStreamProcessManagerSendMessage:
    """Tests for StreamProcessManager.send_message()."""

    @pytest.fixture
    def manager_with_process(self):
        manager = StreamProcessManager()
        mock_proc = MagicMock()
        mock_proc.stdin = MagicMock()
        mock_proc.stdin.write = MagicMock()
        mock_proc.stdin.drain = AsyncMock()

        process = ManagedStreamProcess(
            id="test-proc",
            pid=12345,
            cwd="/tmp/test",
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )
        manager.processes["test-proc"] = process
        return manager, process, mock_proc

    @pytest.mark.asyncio
    async def test_send_message_writes_json(self, manager_with_process):
        """Test send_message writes correct NDJSON to stdin."""
        manager, process, mock_proc = manager_with_process

        await manager.send_message("test-proc", "hello world")

        mock_proc.stdin.write.assert_called_once()
        written = mock_proc.stdin.write.call_args[0][0]
        msg = json.loads(written.decode("utf-8"))
        assert msg["type"] == "user"
        assert msg["message"]["role"] == "user"
        assert msg["message"]["content"] == "hello world"

    @pytest.mark.asyncio
    async def test_send_message_sets_running_state(self, manager_with_process):
        """Test send_message sets state to running."""
        manager, process, _ = manager_with_process
        process.state = "waiting"

        await manager.send_message("test-proc", "test")

        assert process.state == "running"

    @pytest.mark.asyncio
    async def test_send_message_process_not_found(self):
        """Test send_message raises for non-existent process."""
        manager = StreamProcessManager()

        with pytest.raises(ValueError, match="not found"):
            await manager.send_message("nonexistent", "hello")

    @pytest.mark.asyncio
    async def test_send_message_process_stopped(self, manager_with_process):
        """Test send_message raises for stopped process."""
        manager, process, _ = manager_with_process
        process.state = "stopped"

        with pytest.raises(ValueError, match="stopped"):
            await manager.send_message("test-proc", "hello")


class TestStreamProcessManagerKill:
    """Tests for StreamProcessManager.kill()."""

    @pytest.fixture
    def manager_with_process(self):
        manager = StreamProcessManager()
        mock_proc = MagicMock()
        mock_proc.terminate = MagicMock()
        mock_proc.kill = MagicMock()
        mock_proc.wait = AsyncMock(return_value=0)
        mock_proc.returncode = 0

        process = ManagedStreamProcess(
            id="test-proc",
            pid=12345,
            cwd="/tmp/test",
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )
        manager.processes["test-proc"] = process
        return manager, process, mock_proc

    @pytest.mark.asyncio
    async def test_kill_calls_terminate(self, manager_with_process):
        """Test kill sends SIGTERM via terminate()."""
        manager, process, mock_proc = manager_with_process

        await manager.kill("test-proc")

        mock_proc.terminate.assert_called_once()
        assert process.state == "stopped"

    @pytest.mark.asyncio
    async def test_kill_process_not_found(self):
        """Test kill raises for non-existent process."""
        manager = StreamProcessManager()

        with pytest.raises(ValueError, match="not found"):
            await manager.kill("nonexistent")

    @pytest.mark.asyncio
    async def test_kill_already_stopped(self, manager_with_process):
        """Test kill is idempotent for stopped process."""
        manager, process, mock_proc = manager_with_process
        process.state = "stopped"

        await manager.kill("test-proc")

        mock_proc.terminate.assert_not_called()

    @pytest.mark.asyncio
    async def test_kill_handles_process_lookup_error(self, manager_with_process):
        """Test kill handles ProcessLookupError gracefully."""
        manager, process, mock_proc = manager_with_process
        mock_proc.terminate.side_effect = ProcessLookupError()

        await manager.kill("test-proc")

        assert process.state == "stopped"


class TestStreamProcessManagerRelease:
    """Tests for StreamProcessManager.release()."""

    @pytest.fixture
    def manager_with_process(self):
        manager = StreamProcessManager()
        mock_proc = MagicMock()
        mock_proc.stdin = MagicMock()
        mock_proc.stdin.close = MagicMock()
        mock_proc.stdin.drain = AsyncMock()

        process = ManagedStreamProcess(
            id="test-proc",
            pid=12345,
            cwd="/tmp/test",
            session_id="session-abc",
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )
        manager.processes["test-proc"] = process
        return manager, process, mock_proc

    @pytest.mark.asyncio
    async def test_release_closes_stdin(self, manager_with_process):
        """Test release closes stdin pipe."""
        manager, process, mock_proc = manager_with_process

        await manager.release("test-proc")

        mock_proc.stdin.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_release_process_not_found(self):
        """Test release raises for non-existent process."""
        manager = StreamProcessManager()

        with pytest.raises(ValueError, match="not found"):
            await manager.release("nonexistent")

    @pytest.mark.asyncio
    async def test_release_already_stopped(self, manager_with_process):
        """Test release is no-op for stopped process."""
        manager, process, mock_proc = manager_with_process
        process.state = "stopped"

        await manager.release("test-proc")

        mock_proc.stdin.close.assert_not_called()


class TestStreamProcessManagerBroadcast:
    """Tests for broadcast functionality."""

    @pytest.fixture
    def manager_with_clients(self):
        manager = StreamProcessManager()
        mock_proc = MagicMock()
        process = ManagedStreamProcess(
            id="test-proc",
            pid=12345,
            cwd="/tmp/test",
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        process.websocket_clients.add(ws1)
        process.websocket_clients.add(ws2)
        manager.processes["test-proc"] = process
        return manager, process, ws1, ws2

    @pytest.mark.asyncio
    async def test_broadcast_to_all(self, manager_with_clients):
        """Test message is broadcast to all connected clients."""
        manager, process, ws1, ws2 = manager_with_clients

        msg = {"type": "assistant", "text": "hello"}
        await manager._broadcast_to_websockets(process, msg)

        ws1.send_json.assert_called_once_with(msg)
        ws2.send_json.assert_called_once_with(msg)

    @pytest.mark.asyncio
    async def test_broadcast_removes_disconnected(self, manager_with_clients):
        """Test disconnected clients are removed from broadcast list."""
        manager, process, ws1, ws2 = manager_with_clients
        ws2.send_json.side_effect = Exception("disconnected")

        msg = {"type": "test"}
        await manager._broadcast_to_websockets(process, msg)

        assert ws1 in process.websocket_clients
        assert ws2 not in process.websocket_clients

    @pytest.mark.asyncio
    async def test_broadcast_skips_empty_clients(self):
        """Test broadcast is no-op when no clients connected."""
        manager = StreamProcessManager()
        mock_proc = MagicMock()
        process = ManagedStreamProcess(
            id="test",
            pid=123,
            cwd="/tmp",
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )

        # Should not raise
        await manager._broadcast_to_websockets(process, {"type": "test"})


class TestStreamProcessManagerListGet:
    """Tests for list_processes and get_process."""

    def test_list_returns_process_info(self):
        """Test list_processes returns correct info dict."""
        manager = StreamProcessManager()
        now = datetime.now(timezone.utc)
        mock_proc = MagicMock()
        process = ManagedStreamProcess(
            id="test-proc",
            pid=12345,
            cwd="/tmp/test",
            session_id="sess-1",
            state="running",
            started_at=now,
            process=mock_proc,
        )
        manager.processes["test-proc"] = process

        result = manager.list_processes()

        assert len(result) == 1
        assert result[0]["id"] == "test-proc"
        assert result[0]["cwd"] == "/tmp/test"
        assert result[0]["state"] == "running"
        assert result[0]["session_id"] == "sess-1"
        assert result[0]["pid"] == 12345

    def test_get_process_returns_dict(self):
        """Test get_process returns info dict."""
        manager = StreamProcessManager()
        mock_proc = MagicMock()
        process = ManagedStreamProcess(
            id="test-proc",
            pid=12345,
            cwd="/tmp",
            session_id=None,
            state="running",
            started_at=datetime.now(timezone.utc),
            process=mock_proc,
        )
        manager.processes["test-proc"] = process

        result = manager.get_process("test-proc")

        assert result is not None
        assert result["id"] == "test-proc"
        assert result["state"] == "running"


class TestStreamProcessManagerCleanup:
    """Tests for StreamProcessManager.cleanup()."""

    @pytest.mark.asyncio
    async def test_cleanup_kills_all(self):
        """Test cleanup kills all processes."""
        manager = StreamProcessManager()

        for i in range(3):
            mock_proc = MagicMock()
            mock_proc.terminate = MagicMock()
            mock_proc.wait = AsyncMock(return_value=0)
            process = ManagedStreamProcess(
                id=f"proc-{i}",
                pid=1000 + i,
                cwd="/tmp",
                session_id=None,
                state="running",
                started_at=datetime.now(timezone.utc),
                process=mock_proc,
            )
            manager.processes[f"proc-{i}"] = process

        await manager.cleanup()

        assert len(manager.processes) == 0

    @pytest.mark.asyncio
    async def test_cleanup_empty(self):
        """Test cleanup with no processes does nothing."""
        manager = StreamProcessManager()
        await manager.cleanup()


class TestGlobalStreamProcessManager:
    """Tests for global singleton."""

    def test_get_stream_process_manager_returns_same_instance(self):
        """Test get_stream_process_manager returns singleton."""
        import src.api.stream_process_manager as spm_module

        spm_module._stream_process_manager = None

        mgr1 = get_stream_process_manager()
        mgr2 = get_stream_process_manager()

        assert mgr1 is mgr2

    def test_get_stream_process_manager_creates_if_none(self):
        """Test get_stream_process_manager creates instance if none exists."""
        import src.api.stream_process_manager as spm_module

        spm_module._stream_process_manager = None

        mgr = get_stream_process_manager()

        assert mgr is not None
        assert isinstance(mgr, StreamProcessManager)


# =============================================================================
# API Route Tests
# =============================================================================

class TestSpawnRequestValidation:
    """Tests for SpawnRequest model validation."""

    def test_valid_directory(self, tmp_path):
        """Test valid directory is accepted."""
        request = SpawnRequest(cwd=str(tmp_path))
        assert Path(request.cwd).exists()

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


class TestAPISpawnEndpoint:
    """Tests for POST /api/process/spawn endpoint."""

    @pytest.fixture
    def app(self):
        app = FastAPI()
        app.include_router(stream_processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_spawn_valid_directory(self, client, tmp_path):
        """Test spawning with valid directory."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.spawn = AsyncMock(return_value="abc12345")
            mock_mgr_inst.get_process.return_value = {
                "id": "abc12345",
                "cwd": str(tmp_path),
                "state": "running",
                "started_at": "2026-01-01T00:00:00+00:00",
            }
            mock_mgr.return_value = mock_mgr_inst

            response = client.post("/api/process/spawn", json={"cwd": str(tmp_path)})

            assert response.status_code == 200
            data = response.json()
            assert data["process_id"] == "abc12345"
            assert data["state"] == "running"

    def test_spawn_invalid_directory(self, client):
        """Test spawn with invalid directory returns 422."""
        response = client.post("/api/process/spawn", json={"cwd": "/nonexistent/path/12345"})
        assert response.status_code == 422

    def test_spawn_exception(self, client, tmp_path):
        """Test spawn exception returns 500."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.spawn = AsyncMock(side_effect=Exception("spawn failed"))
            mock_mgr.return_value = mock_mgr_inst

            response = client.post("/api/process/spawn", json={"cwd": str(tmp_path)})

            assert response.status_code == 500


class TestAPIMessageEndpoint:
    """Tests for POST /api/process/{id}/message endpoint."""

    @pytest.fixture
    def app(self):
        app = FastAPI()
        app.include_router(stream_processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_message_success(self, client):
        """Test successful message send."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.send_message = AsyncMock()
            mock_mgr.return_value = mock_mgr_inst

            response = client.post(
                "/api/process/test-123/message",
                json={"text": "hello"}
            )

            assert response.status_code == 200
            assert response.json()["status"] == "sent"

    def test_message_process_not_found(self, client):
        """Test message to non-existent process returns 404."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.send_message = AsyncMock(
                side_effect=ValueError("Process not found")
            )
            mock_mgr.return_value = mock_mgr_inst

            response = client.post(
                "/api/process/not-found/message",
                json={"text": "hello"}
            )

            assert response.status_code == 404


class TestAPIKillEndpoint:
    """Tests for POST /api/process/{id}/kill endpoint."""

    @pytest.fixture
    def app(self):
        app = FastAPI()
        app.include_router(stream_processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_kill_success(self, client):
        """Test successful kill."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.kill = AsyncMock()
            mock_mgr.return_value = mock_mgr_inst

            response = client.post("/api/process/test-123/kill")

            assert response.status_code == 200
            assert response.json()["success"] is True

    def test_kill_not_found(self, client):
        """Test kill non-existent process returns 404."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.kill = AsyncMock(
                side_effect=ValueError("Process not found")
            )
            mock_mgr.return_value = mock_mgr_inst

            response = client.post("/api/process/not-found/kill")

            assert response.status_code == 404


class TestAPIListProcessesEndpoint:
    """Tests for GET /api/processes endpoint."""

    @pytest.fixture
    def app(self):
        app = FastAPI()
        app.include_router(stream_processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_list_empty(self, client):
        """Test list with no processes."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.list_processes.return_value = []
            mock_mgr.return_value = mock_mgr_inst

            response = client.get("/api/processes")

            assert response.status_code == 200
            assert response.json() == []

    def test_list_with_processes(self, client):
        """Test list with multiple processes."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.list_processes.return_value = [
                {
                    "id": "proc-1",
                    "session_id": None,
                    "cwd": "/tmp/test1",
                    "pid": 123,
                    "state": "running",
                    "started_at": "2026-01-01T00:00:00+00:00",
                },
                {
                    "id": "proc-2",
                    "session_id": "sess-2",
                    "cwd": "/tmp/test2",
                    "pid": 456,
                    "state": "stopped",
                    "started_at": "2026-01-01T00:00:00+00:00",
                },
            ]
            mock_mgr.return_value = mock_mgr_inst

            response = client.get("/api/processes")

            assert response.status_code == 200
            data = response.json()
            assert len(data) == 2
            assert data[0]["id"] == "proc-1"
            assert data[1]["state"] == "stopped"


class TestAPIReleaseEndpoint:
    """Tests for POST /api/process/{id}/release endpoint."""

    @pytest.fixture
    def app(self):
        app = FastAPI()
        app.include_router(stream_processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_release_success(self, client):
        """Test successful release."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.get_process.return_value = {
                "id": "test-123",
                "session_id": "sess-abc",
            }
            mock_mgr_inst.release = AsyncMock()
            mock_mgr.return_value = mock_mgr_inst

            response = client.post("/api/process/test-123/release")

            assert response.status_code == 200
            data = response.json()
            assert data["released"] is True
            assert data["session_id"] == "sess-abc"

    def test_release_not_found(self, client):
        """Test release non-existent process returns 404."""
        with patch('src.api.routes.stream_processes.get_stream_process_manager') as mock_mgr:
            mock_mgr_inst = MagicMock()
            mock_mgr_inst.get_process.return_value = None
            mock_mgr.return_value = mock_mgr_inst

            response = client.post("/api/process/not-found/release")

            assert response.status_code == 404


class TestAPISDKModeEndpoint:
    """Tests for GET /api/sdk-mode endpoint."""

    @pytest.fixture
    def app(self):
        app = FastAPI()
        app.include_router(stream_processes_router)
        return app

    @pytest.fixture
    def client(self, app):
        return TestClient(app)

    def test_sdk_mode_returns_status(self, client):
        """Test sdk-mode returns correct status."""
        response = client.get("/api/sdk-mode")

        assert response.status_code == 200
        data = response.json()
        assert data["mode"] == "sdk"
        assert data["sdk_available"] is True

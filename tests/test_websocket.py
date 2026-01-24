"""Tests for WebSocket connection management."""

import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from src.api.websocket import (
    ConnectionManager,
    compute_sessions_hash,
)


class TestConnectionManager:
    """Tests for ConnectionManager class."""

    @pytest.fixture
    def manager(self):
        """Create a fresh connection manager for each test."""
        return ConnectionManager()

    @pytest.mark.asyncio
    async def test_initial_state(self, manager):
        """Test initial state of connection manager."""
        assert manager.connection_count == 0
        assert manager.active_connections == []

    @pytest.mark.asyncio
    async def test_connect_adds_connection(self, manager):
        """Test connecting a WebSocket."""
        mock_ws = AsyncMock()

        await manager.connect(mock_ws)

        assert manager.connection_count == 1
        assert mock_ws in manager.active_connections
        mock_ws.accept.assert_called_once()

    @pytest.mark.asyncio
    async def test_disconnect_removes_connection(self, manager):
        """Test disconnecting a WebSocket."""
        mock_ws = AsyncMock()
        await manager.connect(mock_ws)

        await manager.disconnect(mock_ws)

        assert manager.connection_count == 0
        assert mock_ws not in manager.active_connections

    @pytest.mark.asyncio
    async def test_disconnect_nonexistent_connection(self, manager):
        """Test disconnecting a connection that doesn't exist."""
        mock_ws = AsyncMock()

        # Should not raise
        await manager.disconnect(mock_ws)

        assert manager.connection_count == 0

    @pytest.mark.asyncio
    async def test_multiple_connections(self, manager):
        """Test managing multiple connections."""
        ws1 = AsyncMock()
        ws2 = AsyncMock()
        ws3 = AsyncMock()

        await manager.connect(ws1)
        await manager.connect(ws2)
        await manager.connect(ws3)

        assert manager.connection_count == 3

        await manager.disconnect(ws2)

        assert manager.connection_count == 2
        assert ws1 in manager.active_connections
        assert ws2 not in manager.active_connections
        assert ws3 in manager.active_connections

    @pytest.mark.asyncio
    async def test_broadcast_to_all(self, manager):
        """Test broadcasting message to all connections."""
        ws1 = AsyncMock()
        ws2 = AsyncMock()

        await manager.connect(ws1)
        await manager.connect(ws2)

        message = {'type': 'test', 'data': 'hello'}
        await manager.broadcast(message)

        expected = json.dumps(message)
        ws1.send_text.assert_called_once_with(expected)
        ws2.send_text.assert_called_once_with(expected)

    @pytest.mark.asyncio
    async def test_broadcast_no_connections(self, manager):
        """Test broadcast with no connections does nothing."""
        message = {'type': 'test'}

        # Should not raise
        await manager.broadcast(message)

    @pytest.mark.asyncio
    async def test_broadcast_handles_disconnected_client(self, manager):
        """Test that failed sends result in client disconnect."""
        ws_good = AsyncMock()
        ws_bad = AsyncMock()
        ws_bad.send_text.side_effect = Exception("Connection closed")

        await manager.connect(ws_good)
        await manager.connect(ws_bad)

        assert manager.connection_count == 2

        await manager.broadcast({'type': 'test'})

        # Bad connection should be removed
        assert ws_bad not in manager.active_connections
        # Good connection should remain
        assert ws_good in manager.active_connections

    @pytest.mark.asyncio
    async def test_connection_count_property(self, manager):
        """Test connection_count property."""
        assert manager.connection_count == 0

        ws1 = AsyncMock()
        await manager.connect(ws1)
        assert manager.connection_count == 1

        ws2 = AsyncMock()
        await manager.connect(ws2)
        assert manager.connection_count == 2

    @pytest.mark.asyncio
    async def test_concurrent_connect_disconnect(self, manager):
        """Test concurrent connect and disconnect operations."""
        websockets = [AsyncMock() for _ in range(5)]

        # Connect all concurrently
        await asyncio.gather(*[manager.connect(ws) for ws in websockets])

        assert manager.connection_count == 5

        # Disconnect some concurrently
        await asyncio.gather(*[manager.disconnect(ws) for ws in websockets[:3]])

        assert manager.connection_count == 2


class TestComputeSessionsHash:
    """Tests for compute_sessions_hash function."""

    def test_empty_sessions(self):
        """Test hash of empty session list."""
        result = compute_sessions_hash([])

        assert isinstance(result, str)
        assert len(result) == 32  # MD5 hex digest length

    def test_same_sessions_same_hash(self):
        """Test same sessions produce same hash."""
        sessions = [
            {'sessionId': 'test-1', 'state': 'active', 'contextTokens': 1000}
        ]

        hash1 = compute_sessions_hash(sessions)
        hash2 = compute_sessions_hash(sessions)

        assert hash1 == hash2

    def test_different_sessions_different_hash(self):
        """Test different sessions produce different hash."""
        sessions1 = [{'sessionId': 'test-1', 'state': 'active'}]
        sessions2 = [{'sessionId': 'test-2', 'state': 'active'}]

        hash1 = compute_sessions_hash(sessions1)
        hash2 = compute_sessions_hash(sessions2)

        assert hash1 != hash2

    def test_state_change_changes_hash(self):
        """Test that state change produces different hash."""
        sessions_active = [{'sessionId': 'test-1', 'state': 'active'}]
        sessions_waiting = [{'sessionId': 'test-1', 'state': 'waiting'}]

        hash1 = compute_sessions_hash(sessions_active)
        hash2 = compute_sessions_hash(sessions_waiting)

        assert hash1 != hash2

    def test_token_change_changes_hash(self):
        """Test that token count change produces different hash."""
        sessions1 = [{'sessionId': 'test-1', 'contextTokens': 1000}]
        sessions2 = [{'sessionId': 'test-1', 'contextTokens': 2000}]

        hash1 = compute_sessions_hash(sessions1)
        hash2 = compute_sessions_hash(sessions2)

        assert hash1 != hash2

    def test_activity_change_changes_hash(self):
        """Test that activity change produces different hash."""
        sessions1 = [{'sessionId': 'test-1', 'currentActivity': 'Reading'}]
        sessions2 = [{'sessionId': 'test-1', 'currentActivity': 'Writing'}]

        hash1 = compute_sessions_hash(sessions1)
        hash2 = compute_sessions_hash(sessions2)

        assert hash1 != hash2

    def test_uses_last_5_activity_log(self):
        """Test that only last 5 activity log entries affect hash."""
        # Same last 5, different earlier entries
        sessions1 = [{
            'sessionId': 'test-1',
            'activityLog': ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
        }]
        sessions2 = [{
            'sessionId': 'test-1',
            'activityLog': ['b1', 'b2', 'a3', 'a4', 'a5', 'a6', 'a7']
        }]

        hash1 = compute_sessions_hash(sessions1)
        hash2 = compute_sessions_hash(sessions2)

        # Should be same since last 5 are same (a3-a7)
        assert hash1 == hash2

    def test_multiple_sessions(self):
        """Test hash with multiple sessions."""
        sessions = [
            {'sessionId': 'test-1', 'state': 'active'},
            {'sessionId': 'test-2', 'state': 'waiting'},
            {'sessionId': 'test-3', 'state': 'paused'},
        ]

        result = compute_sessions_hash(sessions)

        assert isinstance(result, str)
        assert len(result) == 32

    def test_missing_keys_handled(self):
        """Test that missing keys don't cause errors."""
        sessions = [
            {'sessionId': 'test-1'},  # Only sessionId, missing other keys
        ]

        # Should not raise
        result = compute_sessions_hash(sessions)

        assert isinstance(result, str)

    def test_order_matters(self):
        """Test that session order affects hash."""
        sessions1 = [
            {'sessionId': 'test-1'},
            {'sessionId': 'test-2'},
        ]
        sessions2 = [
            {'sessionId': 'test-2'},
            {'sessionId': 'test-1'},
        ]

        hash1 = compute_sessions_hash(sessions1)
        hash2 = compute_sessions_hash(sessions2)

        assert hash1 != hash2


class TestConnectionManagerThreadSafety:
    """Tests for thread safety of ConnectionManager."""

    @pytest.mark.asyncio
    async def test_lock_exists(self):
        """Test that manager has a lock for thread safety."""
        manager = ConnectionManager()
        assert manager._lock is not None
        assert isinstance(manager._lock, asyncio.Lock)

    @pytest.mark.asyncio
    async def test_concurrent_broadcasts(self):
        """Test concurrent broadcast operations."""
        manager = ConnectionManager()
        ws = AsyncMock()
        await manager.connect(ws)

        # Multiple concurrent broadcasts
        messages = [{'type': 'test', 'id': i} for i in range(10)]

        await asyncio.gather(*[manager.broadcast(msg) for msg in messages])

        # All messages should be sent
        assert ws.send_text.call_count == 10

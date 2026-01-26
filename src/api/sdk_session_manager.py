"""SDK-based session management for Claude interactions.

This module provides a clean, programmatic interface to Claude using
the claude-agent-sdk instead of PTY-based process spawning.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Any
from collections import deque
import asyncio
import uuid

from fastapi import WebSocket

# Import will be validated when SDK is installed
try:
    from claude_agent_sdk import (
        ClaudeSDKClient,
        ClaudeAgentOptions,
        PermissionResultAllow,
        PermissionResultDeny,
    )
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False
    ClaudeSDKClient = None
    ClaudeAgentOptions = None
    PermissionResultAllow = None
    PermissionResultDeny = None


@dataclass
class SDKSession:
    """Represents an active Claude SDK session."""

    id: str
    cwd: str
    state: str  # "running", "waiting", "stopped"
    started_at: datetime
    client: Optional[Any] = None  # ClaudeSDKClient when active
    messages: deque = field(default_factory=lambda: deque(maxlen=500))
    output_buffer: deque = field(default_factory=lambda: deque(maxlen=1000))
    websocket_clients: set = field(default_factory=set)
    pending_approval: Optional[dict] = None
    is_streaming: bool = False
    _approval_futures: dict = field(default_factory=dict)


class SDKSessionManager:
    """Manages Claude SDK sessions with WebSocket integration."""

    def __init__(self):
        self.sessions: dict[str, SDKSession] = {}

    async def create_session(self, cwd: str) -> SDKSession:
        """Create a new SDK session with tool approval callback.

        Args:
            cwd: Working directory for the Claude session

        Returns:
            SDKSession instance ready for interaction
        """
        if not SDK_AVAILABLE:
            raise RuntimeError("claude-agent-sdk not installed")

        session_id = str(uuid.uuid4())[:8]
        session = SDKSession(
            id=session_id,
            cwd=cwd,
            state="waiting",
            started_at=datetime.now(timezone.utc)
        )

        # Tool approval callback - broadcasts to WebSocket, waits for response
        async def can_use_tool(tool_name: str, tool_input: dict, context: Any):
            tool_use_id = str(uuid.uuid4())[:8]
            future = asyncio.Future()
            session._approval_futures[tool_use_id] = future
            session.pending_approval = {
                "tool_use_id": tool_use_id,
                "name": tool_name,
                "input": tool_input
            }

            # Broadcast tool approval request to all connected clients
            await self._broadcast(session, {
                "type": "tool_approval",
                "tool_use_id": tool_use_id,
                "name": tool_name,
                "input": tool_input
            })

            try:
                # Wait for user approval with 5-minute timeout
                approved = await asyncio.wait_for(future, timeout=300)
                if approved:
                    return PermissionResultAllow(updated_input=tool_input)
                else:
                    return PermissionResultDeny(message="User denied", interrupt=False)
            except asyncio.TimeoutError:
                return PermissionResultDeny(message="Approval timeout", interrupt=True)
            finally:
                session.pending_approval = None
                session._approval_futures.pop(tool_use_id, None)

        # Store the callback reference for the session
        session._can_use_tool = can_use_tool

        options = ClaudeAgentOptions(
            cwd=cwd,
            can_use_tool=can_use_tool
        )

        # Create client - note: actual connection happens on first query
        client = ClaudeSDKClient(options=options)
        session.client = client

        self.sessions[session_id] = session
        return session

    async def send_message(self, session_id: str, text: str):
        """Send a message to a session and stream responses.

        Args:
            session_id: ID of the target session
            text: Message text to send

        Raises:
            ValueError: If session not found
        """
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        if not session.client:
            raise ValueError(f"Session {session_id} has no active client")

        session.state = "running"
        session.is_streaming = True

        # Broadcast user message to all clients
        await self._broadcast(session, {
            "type": "message",
            "role": "user",
            "content": text
        })

        try:
            # Send query and process streaming responses
            await session.client.query(text)

            async for message in session.client.receive_messages():
                await self._handle_sdk_message(session, message)

        except Exception as e:
            await self._broadcast(session, {
                "type": "error",
                "error": str(e)
            })
        finally:
            session.is_streaming = False
            session.state = "waiting"
            await self._broadcast(session, {"type": "state", "state": "waiting"})

    async def approve_tool(self, session_id: str, tool_use_id: str, approved: bool):
        """Resolve a pending tool approval request.

        Args:
            session_id: ID of the session
            tool_use_id: ID of the tool use request
            approved: Whether to allow the tool use
        """
        session = self.sessions.get(session_id)
        if not session:
            return

        future = session._approval_futures.get(tool_use_id)
        if future and not future.done():
            future.set_result(approved)

    def get_session(self, session_id: str) -> Optional[SDKSession]:
        """Get a session by ID."""
        return self.sessions.get(session_id)

    def list_sessions(self) -> list[dict]:
        """List all sessions with their current state."""
        return [
            {
                "id": s.id,
                "cwd": s.cwd,
                "state": s.state,
                "started_at": s.started_at.isoformat(),
                "client_count": len(s.websocket_clients),
                "has_pending_approval": s.pending_approval is not None
            }
            for s in self.sessions.values()
        ]

    async def close_session(self, session_id: str):
        """Close and clean up a session."""
        session = self.sessions.pop(session_id, None)
        if session:
            session.state = "stopped"
            if session.client:
                try:
                    await session.client.close()
                except Exception:
                    pass
            # Notify clients
            await self._broadcast(session, {"type": "state", "state": "stopped"})

    async def add_websocket_client(self, session_id: str, ws: WebSocket):
        """Add a WebSocket client to a session."""
        session = self.sessions.get(session_id)
        if session:
            session.websocket_clients.add(ws)

    async def remove_websocket_client(self, session_id: str, ws: WebSocket):
        """Remove a WebSocket client from a session."""
        session = self.sessions.get(session_id)
        if session:
            session.websocket_clients.discard(ws)

    async def _broadcast(self, session: SDKSession, message: dict):
        """Broadcast a message to all WebSocket clients of a session."""
        disconnected = set()
        for ws in session.websocket_clients:
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.add(ws)
        session.websocket_clients -= disconnected

    async def _handle_sdk_message(self, session: SDKSession, message):
        """Convert SDK message to WebSocket format and broadcast.

        Args:
            session: Target session
            message: SDK message object
        """
        # Handle different message types from SDK
        if hasattr(message, 'content'):
            for block in message.content:
                if hasattr(block, 'text'):
                    # Text content block
                    await self._broadcast(session, {
                        "type": "output",
                        "stream": "stdout",
                        "data": block.text
                    })
                elif hasattr(block, 'name'):
                    # ToolUseBlock - tool is being invoked
                    await self._broadcast(session, {
                        "type": "tool_use",
                        "name": block.name,
                        "input": getattr(block, 'input', {}),
                        "tool_use_id": getattr(block, 'id', str(uuid.uuid4())[:8])
                    })
        elif hasattr(message, 'delta'):
            # Streaming delta - partial content
            delta = message.delta
            if hasattr(delta, 'text'):
                await self._broadcast(session, {
                    "type": "output",
                    "stream": "stdout",
                    "data": delta.text
                })


# Singleton instance
_sdk_session_manager: Optional[SDKSessionManager] = None


def get_sdk_session_manager() -> SDKSessionManager:
    """Get the singleton SDK session manager instance."""
    global _sdk_session_manager
    if _sdk_session_manager is None:
        _sdk_session_manager = SDKSessionManager()
    return _sdk_session_manager

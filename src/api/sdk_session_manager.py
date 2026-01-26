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
        query,
        ClaudeAgentOptions,
        AssistantMessage,
        TextBlock,
        ToolUseBlock,
        ResultMessage,
    )
    from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny
    SDK_AVAILABLE = True
except ImportError:
    SDK_AVAILABLE = False
    query = None
    ClaudeAgentOptions = None
    AssistantMessage = None
    TextBlock = None
    ToolUseBlock = None
    ResultMessage = None
    PermissionResultAllow = None
    PermissionResultDeny = None


@dataclass
class SDKSession:
    """Represents an active Claude SDK session."""

    id: str
    cwd: str
    state: str  # "running", "waiting", "stopped"
    started_at: datetime
    session_id: Optional[str] = None  # Claude's internal session ID for resuming
    messages: deque = field(default_factory=lambda: deque(maxlen=500))
    output_buffer: str = ""
    websocket_clients: set = field(default_factory=set)
    pending_approval: Optional[dict] = None
    is_streaming: bool = False
    _approval_futures: dict = field(default_factory=dict)
    _can_use_tool: Optional[Any] = None


class SDKSessionManager:
    """Manages Claude SDK sessions with WebSocket integration."""

    def __init__(self):
        self.sessions: dict[str, SDKSession] = {}

    async def create_session(self, cwd: str) -> SDKSession:
        """Create a new SDK session placeholder.

        The actual Claude session starts on first message.
        """
        if not SDK_AVAILABLE:
            raise RuntimeError("claude-agent-sdk not installed. Run: pip install claude-agent-sdk")

        session_id = str(uuid.uuid4())[:8]
        session = SDKSession(
            id=session_id,
            cwd=cwd,
            state="waiting",
            started_at=datetime.now(timezone.utc)
        )

        # Create tool approval callback
        session._can_use_tool = self._make_approval_callback(session)

        self.sessions[session_id] = session
        return session

    def _make_approval_callback(self, session: SDKSession):
        """Create a tool approval callback for a session."""

        async def can_use_tool(tool_name: str, tool_input: dict, context: Any):
            """Callback invoked before each tool use."""
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

                # Python SDK requires PermissionResultAllow/Deny types
                if approved:
                    return PermissionResultAllow(updated_input=tool_input)
                else:
                    return PermissionResultDeny(message="User denied")

            except asyncio.TimeoutError:
                return PermissionResultDeny(message="Approval timeout")
            finally:
                session.pending_approval = None
                session._approval_futures.pop(tool_use_id, None)

        return can_use_tool

    async def send_message(self, session_id: str, text: str):
        """Send a message to a session and stream responses.

        Uses the query() async generator from claude-agent-sdk.
        """
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        session.state = "running"
        session.is_streaming = True

        # Broadcast user message
        await self._broadcast(session, {
            "type": "message",
            "role": "user",
            "content": text
        })

        try:
            # Build options with tool approval callback
            options = ClaudeAgentOptions(
                cwd=session.cwd,
                can_use_tool=session._can_use_tool,
            )

            # If we have a previous session ID, resume it
            if session.session_id:
                options = ClaudeAgentOptions(
                    cwd=session.cwd,
                    can_use_tool=session._can_use_tool,
                    resume=session.session_id,
                )

            # can_use_tool requires streaming mode - message type must be "user"
            async def prompt_stream():
                yield {"type": "user", "text": text}

            # Use query() with streaming prompt
            async for message in query(prompt=prompt_stream(), options=options):
                # Capture session ID from init message for future resume
                if hasattr(message, 'subtype') and message.subtype == 'init':
                    if hasattr(message, 'session_id'):
                        session.session_id = message.session_id
                    elif hasattr(message, 'data') and isinstance(message.data, dict):
                        session.session_id = message.data.get('session_id')

                # Handle the message
                await self._handle_sdk_message(session, message)

        except Exception as e:
            import traceback
            traceback.print_exc()
            await self._broadcast(session, {
                "type": "error",
                "error": str(e)
            })
        finally:
            session.is_streaming = False
            session.state = "waiting"
            await self._broadcast(session, {"type": "state", "state": "waiting"})

    async def approve_tool(self, session_id: str, tool_use_id: str, approved: bool):
        """Resolve a pending tool approval request."""
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
                "has_pending_approval": s.pending_approval is not None,
                "has_claude_session": s.session_id is not None,
            }
            for s in self.sessions.values()
        ]

    async def close_session(self, session_id: str):
        """Close and clean up a session."""
        session = self.sessions.pop(session_id, None)
        if session:
            session.state = "stopped"
            await self._broadcast(session, {"type": "state", "state": "stopped"})

    async def add_websocket_client(self, session_id: str, ws: WebSocket):
        """Add a WebSocket client to a session."""
        session = self.sessions.get(session_id)
        if session:
            session.websocket_clients.add(ws)
            # Send current output buffer to new client
            if session.output_buffer:
                try:
                    await ws.send_json({
                        "type": "history",
                        "content": session.output_buffer
                    })
                except Exception:
                    pass

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
        """Convert SDK message to WebSocket format and broadcast."""

        # Handle AssistantMessage with content blocks
        if AssistantMessage and isinstance(message, AssistantMessage):
            for block in message.content:
                if TextBlock and isinstance(block, TextBlock):
                    text = block.text
                    session.output_buffer += text
                    await self._broadcast(session, {
                        "type": "output",
                        "stream": "stdout",
                        "data": text
                    })
                elif ToolUseBlock and isinstance(block, ToolUseBlock):
                    await self._broadcast(session, {
                        "type": "tool_use",
                        "name": block.name,
                        "input": getattr(block, 'input', {}),
                        "tool_use_id": getattr(block, 'id', str(uuid.uuid4())[:8])
                    })
            return

        # Handle ResultMessage (final result)
        if ResultMessage and isinstance(message, ResultMessage):
            if hasattr(message, 'result'):
                await self._broadcast(session, {
                    "type": "result",
                    "result": message.result
                })
            return

        # Handle streaming events (partial content)
        if hasattr(message, 'type'):
            msg_type = message.type

            if msg_type == 'content_block_delta':
                delta = getattr(message, 'delta', None)
                if delta and hasattr(delta, 'text'):
                    text = delta.text
                    session.output_buffer += text
                    await self._broadcast(session, {
                        "type": "output",
                        "stream": "stdout",
                        "data": text
                    })
            elif msg_type == 'system':
                # System messages (init, etc.)
                subtype = getattr(message, 'subtype', '')
                if subtype == 'init':
                    await self._broadcast(session, {
                        "type": "system",
                        "subtype": "init",
                        "message": "Session initialized"
                    })

        # Fallback: try to extract text from unknown message types
        elif hasattr(message, 'content'):
            content = message.content
            if isinstance(content, list):
                for block in content:
                    if hasattr(block, 'text'):
                        text = block.text
                        session.output_buffer += text
                        await self._broadcast(session, {
                            "type": "output",
                            "stream": "stdout",
                            "data": text
                        })


# Singleton instance
_sdk_session_manager: Optional[SDKSessionManager] = None


def get_sdk_session_manager() -> SDKSessionManager:
    """Get the singleton SDK session manager instance."""
    global _sdk_session_manager
    if _sdk_session_manager is None:
        _sdk_session_manager = SDKSessionManager()
    return _sdk_session_manager

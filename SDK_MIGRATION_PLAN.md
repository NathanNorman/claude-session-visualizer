# Claude Agent SDK Migration Plan

## Overview

Migrate Mission Control's managed sessions from PTY-based process spawning to using `claude-agent-sdk` directly for reliable, programmatic Claude interactions.

## Why This Migration?

| PTY Approach (Current) | SDK Approach (Target) |
|------------------------|----------------------|
| Spawns CLI in pseudo-terminal | Direct Python SDK calls |
| Fragile input handling (100ms delay hack) | Native async message passing |
| ANSI escape code parsing issues | Structured message objects |
| No tool approval handling | Built-in `can_use_tool` callback |
| Terminal size/mode dependencies | No terminal emulation needed |

## Architecture

```
Current PTY Flow:
  User -> POST /api/spawn -> pty.openpty() + os.fork() -> execvpe("claude")
  User -> POST /api/process/{id}/stdin -> os.write(pty_fd) + sleep(0.1) + \r
  WS <- os.read(pty_fd) -> broadcast raw bytes

New SDK Flow:
  User -> POST /api/spawn -> SDKSessionManager.create_session() -> ClaudeSDKClient
  User -> POST /api/process/{id}/message -> client.query(text)
  WS <- async for msg in client.receive_messages() -> broadcast structured messages
```

## Files to Modify

| File | Changes |
|------|---------|
| `pyproject.toml` | Add `claude-agent-sdk` dependency |
| `src/api/sdk_session_manager.py` | **NEW** - SDK session management |
| `src/api/routes/processes.py` | Update endpoints, add `/message`, `/tool-approval` |
| `src/api/server.py` | Update WebSocket handler for SDK messages |
| `src/frontend/app.js` | Handle new message types, tool approval UI |
| `src/frontend/styles.css` | Tool approval card styling |

## Implementation Steps

### Phase 1: Add SDK Infrastructure

**1.1 Add dependency to `pyproject.toml`:**
```toml
dependencies = [
    # ... existing
    "claude-agent-sdk>=0.1.22",
]
```

**1.2 Create `src/api/sdk_session_manager.py`:**

```python
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Any
from collections import deque
import asyncio
import uuid

from fastapi import WebSocket
from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    TextBlock,
    PermissionResultAllow,
    PermissionResultDeny,
)

@dataclass
class SDKSession:
    id: str
    cwd: str
    state: str  # "running", "waiting", "stopped"
    started_at: datetime
    client: Optional[ClaudeSDKClient] = None
    messages: deque = field(default_factory=lambda: deque(maxlen=500))
    output_buffer: deque = field(default_factory=lambda: deque(maxlen=1000))
    websocket_clients: set = field(default_factory=set)
    pending_approval: Optional[dict] = None
    is_streaming: bool = False

class SDKSessionManager:
    def __init__(self):
        self.sessions: dict[str, SDKSession] = {}

    async def create_session(self, cwd: str) -> SDKSession:
        """Create new SDK session with tool approval callback."""
        session_id = str(uuid.uuid4())[:8]
        session = SDKSession(
            id=session_id,
            cwd=cwd,
            state="waiting",
            started_at=datetime.now(timezone.utc)
        )

        # Tool approval callback - broadcasts to WebSocket, waits for response
        approval_futures = {}

        async def can_use_tool(tool_name: str, tool_input: dict, context):
            """Callback invoked before each tool use. Broadcasts to WebSocket for user approval."""
            tool_use_id = str(uuid.uuid4())[:8]
            future = asyncio.Future()
            approval_futures[tool_use_id] = future
            session.pending_approval = {
                "tool_use_id": tool_use_id,
                "name": tool_name,
                "input": tool_input
            }

            await self._broadcast(session, {
                "type": "tool_approval",
                "tool_use_id": tool_use_id,
                "name": tool_name,
                "input": tool_input
            })

            try:
                approved = await asyncio.wait_for(future, timeout=300)
                if approved:
                    return PermissionResultAllow(updated_input=tool_input)
                else:
                    return PermissionResultDeny(message="User denied", interrupt=False)
            except asyncio.TimeoutError:
                return PermissionResultDeny(message="Approval timeout", interrupt=True)
            finally:
                session.pending_approval = None
                approval_futures.pop(tool_use_id, None)

        session._approval_futures = approval_futures

        options = ClaudeAgentOptions(
            cwd=cwd,
            can_use_tool=can_use_tool,
            permission_mode='acceptEdits',  # Let callback handle approvals
        )

        # Create client (don't use async with - we keep it alive)
        client = ClaudeSDKClient(options=options)
        await client.connect()
        session.client = client

        self.sessions[session_id] = session
        return session

    async def close_session(self, session_id: str):
        """Close an SDK session and clean up resources."""
        session = self.sessions.pop(session_id, None)
        if session and session.client:
            await session.client.disconnect()
            session.state = "stopped"

    async def send_message(self, session_id: str, text: str):
        """Send message and stream responses to WebSocket clients."""
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
            await session.client.query(text)

            async for message in session.client.receive_messages():
                # Map SDK messages to WebSocket format
                await self._handle_sdk_message(session, message)

        finally:
            session.is_streaming = False
            session.state = "waiting"
            await self._broadcast(session, {"type": "state", "state": "waiting"})

    async def approve_tool(self, session_id: str, tool_use_id: str, approved: bool):
        """Resolve pending tool approval."""
        session = self.sessions.get(session_id)
        if session and hasattr(session, '_approval_futures'):
            future = session._approval_futures.get(tool_use_id)
            if future and not future.done():
                future.set_result(approved)

    async def _broadcast(self, session: SDKSession, message: dict):
        """Broadcast message to all WebSocket clients."""
        disconnected = set()
        for ws in session.websocket_clients:
            try:
                await ws.send_json(message)
            except:
                disconnected.add(ws)
        session.websocket_clients -= disconnected

    async def _handle_sdk_message(self, session: SDKSession, message):
        """Convert SDK message to WebSocket format and broadcast."""
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    await self._broadcast(session, {
                        "type": "output",
                        "stream": "stdout",
                        "data": block.text
                    })
                elif hasattr(block, 'name'):  # ToolUseBlock
                    await self._broadcast(session, {
                        "type": "tool_use",
                        "name": block.name,
                        "input": getattr(block, 'input', {}),
                        "tool_use_id": getattr(block, 'id', '')
                    })
```

### Phase 2: Update API Endpoints

**2.1 Update `routes/processes.py`:**

```python
# Add new request model
class MessageRequest(BaseModel):
    text: str

class ToolApprovalRequest(BaseModel):
    tool_use_id: str
    approved: bool

# New endpoint for sending messages
@router.post("/process/{process_id}/message")
async def send_message(process_id: str, request: MessageRequest):
    manager = get_sdk_session_manager()
    await manager.send_message(process_id, request.text)
    return {"status": "sent"}

# New endpoint for tool approval
@router.post("/process/{process_id}/tool-approval")
async def approve_tool(process_id: str, request: ToolApprovalRequest):
    manager = get_sdk_session_manager()
    await manager.approve_tool(process_id, request.tool_use_id, request.approved)
    return {"status": "resolved"}

# Update spawn to use SDK
@router.post("/spawn")
async def spawn_session(request: SpawnRequest):
    manager = get_sdk_session_manager()
    session = await manager.create_session(request.cwd)
    return {
        "process_id": session.id,
        "cwd": session.cwd,
        "state": session.state,
        "started_at": session.started_at.isoformat()
    }
```

### Phase 3: Update Frontend

**3.1 Update `handleProcessMessage()` in `app.js`:**

```javascript
function handleProcessMessage(processId, msg) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    switch (msg.type) {
        case 'output':
            // Keep existing terminal output handling
            process.outputBuffer = (process.outputBuffer || '') + msg.data;
            if (selectedProcessId === processId) {
                appendTerminalOutputDirect(msg.data);
            }
            break;

        case 'message':
            // Structured message - render as formatted block
            appendStructuredMessage(processId, msg);
            break;

        case 'tool_use':
            appendToolUseBlock(processId, msg);
            break;

        case 'tool_approval':
            showToolApprovalUI(processId, msg);
            break;

        case 'state':
        case 'history':
        case 'error':
            // Keep existing handlers
            break;
    }
}
```

**3.2 Add tool approval UI:**

```javascript
function showToolApprovalUI(processId, msg) {
    const html = `
        <div class="tool-approval" data-tool-id="${msg.tool_use_id}">
            <div class="tool-header">Tool: ${escapeHtml(msg.name)}</div>
            <pre class="tool-input">${escapeHtml(JSON.stringify(msg.input, null, 2))}</pre>
            <div class="tool-actions">
                <button onclick="approveToolUse('${processId}', '${msg.tool_use_id}', true)">Allow</button>
                <button onclick="approveToolUse('${processId}', '${msg.tool_use_id}', false)">Deny</button>
            </div>
        </div>
    `;
    appendTerminalOutputDirect(html);
}

async function approveToolUse(processId, toolUseId, approved) {
    await fetch(`/api/process/${processId}/tool-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_use_id: toolUseId, approved })
    });
}
```

**3.3 Update `sendProcessInput()` to use `/message` endpoint:**

```javascript
async function sendProcessInput() {
    if (!selectedProcessId) return;
    const text = document.getElementById('mc-input')?.innerText?.trim();
    if (!text) return;

    await fetch(`/api/process/${selectedProcessId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
    });

    document.getElementById('mc-input').innerHTML = '';
}
```

**3.4 Add CSS for tool approval UI in `styles.css`:**

```css
.tool-approval {
    background: var(--bg-tertiary);
    border: 1px solid var(--accent-warning);
    border-radius: 8px;
    padding: 1rem;
    margin: 0.5rem 0;
}

.tool-approval .tool-header {
    font-weight: 600;
    color: var(--accent-warning);
    margin-bottom: 0.5rem;
}

.tool-approval .tool-input {
    background: var(--bg-primary);
    padding: 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    overflow-x: auto;
    max-height: 200px;
    margin-bottom: 0.75rem;
}

.tool-approval .tool-actions {
    display: flex;
    gap: 0.5rem;
}

.tool-approval .tool-actions button {
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s ease;
}

.tool-approval .tool-actions button:first-child {
    background: var(--accent-success);
    color: white;
    border: none;
}

.tool-approval .tool-actions button:first-child:hover {
    filter: brightness(1.1);
}

.tool-approval .tool-actions button:last-child {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
}

.tool-approval .tool-actions button:last-child:hover {
    border-color: var(--accent-error);
    color: var(--accent-error);
}
```

### Phase 4: Testing & Cleanup

1. Install SDK: `pip install claude-agent-sdk`
2. Test session creation
3. Test message sending/receiving
4. Test tool approval flow
5. Remove PTY code (keep as fallback initially)

## Verification

1. **Spawn test**: Click "+ New" in Mission Control, select directory, verify session created
2. **Message test**: Type "hi" and send, verify response streams back
3. **Tool approval test**: Ask Claude to read a file, verify approval dialog appears
4. **Multi-turn test**: Have a conversation, verify context maintained
5. **Cleanup test**: Close browser, reconnect, verify session still available

## Rollback Plan

Keep `process_manager.py` (PTY code) intact. Add feature flag:
```python
USE_SDK_SESSIONS = os.getenv("USE_SDK_SESSIONS", "true").lower() == "true"
```

If SDK issues arise, flip flag to fall back to PTY approach.

## Known Considerations

### SDK API (Verified)

The SDK API has been verified against `claude-agent-sdk==0.1.22`:
- **Client**: `ClaudeSDKClient(options=ClaudeAgentOptions(...))`
- **Connect**: `await client.connect()`
- **Send**: `await client.query(text)`
- **Receive**: `async for msg in client.receive_messages()` or `client.receive_response()`
- **Tool approval**: Return `PermissionResultAllow(updated_input=...)` or `PermissionResultDeny(message=..., interrupt=...)`
- **Disconnect**: `await client.disconnect()`

### WebSocket Integration

The SDK session manager needs to integrate with the existing WebSocket infrastructure in `server.py`. Consider:
- Sharing the same WebSocket connections
- Message format compatibility
- Connection lifecycle management

### Session Persistence

Unlike PTY processes, SDK sessions may need explicit session management:
- Session ID generation and tracking
- Resume capability for reconnecting clients
- Cleanup of stale sessions

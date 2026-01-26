# SDK Migration Phase 2: Complete Frontend Integration

## Overview

Phase 1 implemented the SDK backend infrastructure. Phase 2 completes the migration by:
1. Fixing the SDK permission callback to use correct return types
2. Adding a feature flag for SDK vs PTY mode
3. Updating the frontend to use SDK endpoints when enabled
4. Adding a UI toggle for SDK mode

## Current State

| Component | Status |
|-----------|--------|
| `sdk_session_manager.py` | ✅ Created but has incorrect callback returns |
| `/spawn-sdk` endpoint | ✅ Works |
| `/message` endpoint | ✅ Works |
| `/tool-approval` endpoint | ✅ Works |
| Frontend tool approval UI | ✅ Works |
| `sendProcessInput()` | ❌ Still uses `/stdin` (PTY) |
| Spawn button | ❌ Still uses `/spawn` (PTY) |

## Files to Modify

| File | Changes |
|------|---------|
| `src/api/sdk_session_manager.py` | Fix permission callback return types |
| `src/api/routes/processes.py` | Add feature flag logic to `/spawn` |
| `src/frontend/app.js` | Update spawn and input to use SDK mode |
| `src/frontend/index.html` | Add SDK mode toggle in Mission Control settings |

## Implementation Steps

### Step 1: Fix Permission Callback Return Types

**File:** `src/api/sdk_session_manager.py`

**Problem:** Lines 91-93 return dict format instead of SDK permission result objects.

**Current (wrong):**
```python
return {"behavior": "allow"} if approved else {"behavior": "deny"}
except asyncio.TimeoutError:
    return {"behavior": "deny", "message": "Approval timeout"}
```

**Fix:** Update imports and callback returns:

```python
# Add to imports at top (lines 17-23)
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
```

```python
# Replace lines 88-93 in can_use_tool callback
try:
    approved = await asyncio.wait_for(future, timeout=300)
    if approved:
        return PermissionResultAllow(updated_input=tool_input)
    else:
        return PermissionResultDeny(message="User denied", interrupt=False)
except asyncio.TimeoutError:
    return PermissionResultDeny(message="Approval timeout", interrupt=True)
```

### Step 2: Add Feature Flag to Backend

**File:** `src/api/routes/processes.py`

Add at top of file after imports:
```python
import os

# Feature flag for SDK sessions (default: True to use SDK)
USE_SDK_SESSIONS = os.getenv("USE_SDK_SESSIONS", "true").lower() == "true"
```

Update `/spawn` endpoint to respect feature flag:
```python
@router.post("/spawn", response_model=SpawnResponse)
async def spawn_process(request: SpawnRequest):
    """Spawn a new Claude Code session.

    Uses SDK mode if USE_SDK_SESSIONS=true, otherwise PTY mode.
    """
    # Use SDK if enabled and available
    if USE_SDK_SESSIONS and SDK_AVAILABLE:
        manager = get_sdk_session_manager()
        try:
            session = await manager.create_session(cwd=request.cwd)
            return SpawnResponse(
                process_id=session.id,
                cwd=session.cwd,
                state=session.state,
                started_at=session.started_at.isoformat()
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Fall back to PTY mode
    manager = get_process_manager()
    try:
        process = await manager.spawn(cwd=request.cwd, args=request.args)
        return SpawnResponse(
            process_id=process.id,
            cwd=process.cwd,
            state=process.state,
            started_at=process.started_at.isoformat()
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
```

Add endpoint to query/set SDK mode:
```python
@router.get("/sdk-mode")
async def get_sdk_mode():
    """Get current SDK mode status."""
    return {
        "enabled": USE_SDK_SESSIONS,
        "sdk_available": SDK_AVAILABLE,
        "mode": "sdk" if (USE_SDK_SESSIONS and SDK_AVAILABLE) else "pty"
    }
```

### Step 3: Update Frontend sendProcessInput()

**File:** `src/frontend/app.js`

**Location:** `sendProcessInput()` function (around line 6058)

Replace the entire function:
```javascript
/**
 * Send input to a managed process.
 * Uses /message endpoint for SDK sessions, /stdin for PTY sessions.
 */
async function sendProcessInput() {
    if (!selectedProcessId) return;

    const inputEl = document.getElementById('mc-input');
    const statusEl = document.getElementById('mc-input-status');
    const text = inputEl?.innerText?.trim();

    if (!text) return;

    console.log('[MC-DEBUG] sendProcessInput:', { processId: selectedProcessId, text: text.substring(0, 50) });

    const process = managedProcesses.get(selectedProcessId);
    const isSDKSession = process?.isSDK || window.mcSDKMode;

    try {
        let response;

        if (isSDKSession) {
            // SDK mode: use /message endpoint
            response = await fetch(`/api/process/${selectedProcessId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
        } else {
            // PTY mode: use /stdin endpoint
            response = await fetch(`/api/process/${selectedProcessId}/stdin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, newline: true })
            });
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Clear input on success
        if (inputEl) inputEl.innerHTML = '';
        if (statusEl) {
            statusEl.textContent = 'Sent!';
            setTimeout(() => { statusEl.textContent = ''; }, 1000);
        }

    } catch (error) {
        console.error('Failed to send process input:', error);
        if (statusEl) {
            statusEl.textContent = error.message;
            statusEl.className = 'error';
            setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
        }
    }
}
```

### Step 4: Add SDK Mode Detection on Spawn

**File:** `src/frontend/app.js`

Find the spawn response handler and mark SDK sessions. Look for where `managedProcesses.set()` is called after spawn:

```javascript
// When storing a new process after spawn, detect SDK mode
async function spawnProcess(cwd) {
    // ... existing spawn logic ...

    const response = await fetch('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd })
    });

    const data = await response.json();

    // Check if this is an SDK session
    const sdkModeResponse = await fetch('/api/sdk-mode');
    const sdkMode = await sdkModeResponse.json();

    // Store process with SDK flag
    managedProcesses.set(data.process_id, {
        ...data,
        isSDK: sdkMode.mode === 'sdk',
        outputBuffer: ''
    });

    // ... rest of spawn logic ...
}
```

### Step 5: Add SDK Mode Toggle to UI (Optional)

**File:** `src/frontend/index.html`

Add a toggle in the Mission Control header area:

```html
<!-- Add near the Mission Control header controls -->
<div class="mc-sdk-toggle">
    <label class="toggle-label">
        <input type="checkbox" id="mc-sdk-mode" onchange="toggleSDKMode(this.checked)">
        <span class="toggle-slider"></span>
        <span class="toggle-text">SDK Mode</span>
    </label>
    <span id="mc-sdk-status" class="sdk-status"></span>
</div>
```

**File:** `src/frontend/styles.css`

Add styling:
```css
.mc-sdk-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
}

.mc-sdk-toggle .toggle-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.85rem;
}

.mc-sdk-toggle .toggle-text {
    color: var(--text-secondary);
}

.mc-sdk-toggle .sdk-status {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    background: var(--bg-tertiary);
}

.mc-sdk-toggle .sdk-status.active {
    background: var(--accent-success);
    color: white;
}
```

**File:** `src/frontend/app.js`

Add toggle handler:
```javascript
// Global SDK mode state
window.mcSDKMode = false;

/**
 * Initialize SDK mode status on page load
 */
async function initSDKMode() {
    try {
        const response = await fetch('/api/sdk-mode');
        const data = await response.json();

        window.mcSDKMode = data.mode === 'sdk';

        const checkbox = document.getElementById('mc-sdk-mode');
        const status = document.getElementById('mc-sdk-status');

        if (checkbox) checkbox.checked = window.mcSDKMode;
        if (status) {
            status.textContent = data.sdk_available
                ? (window.mcSDKMode ? 'SDK Active' : 'PTY Mode')
                : 'SDK Unavailable';
            status.className = 'sdk-status' + (window.mcSDKMode ? ' active' : '');
        }
    } catch (error) {
        console.error('Failed to get SDK mode:', error);
    }
}

/**
 * Toggle SDK mode (requires server restart to take effect for new sessions)
 */
function toggleSDKMode(enabled) {
    window.mcSDKMode = enabled;
    const status = document.getElementById('mc-sdk-status');
    if (status) {
        status.textContent = enabled ? 'SDK (new sessions)' : 'PTY Mode';
        status.className = 'sdk-status' + (enabled ? ' active' : '');
    }
    // Note: This only affects client-side routing. Server-side requires env var.
    console.log('[MC] SDK mode toggled:', enabled);
}

// Call on page load
document.addEventListener('DOMContentLoaded', initSDKMode);
```

## Summary of Changes

| File | Lines Changed | Description |
|------|---------------|-------------|
| `sdk_session_manager.py` | ~15 | Fix imports and callback returns |
| `routes/processes.py` | ~30 | Add feature flag, update `/spawn` |
| `app.js` | ~50 | Update `sendProcessInput()`, add SDK mode |
| `index.html` | ~10 | Add SDK toggle UI |
| `styles.css` | ~25 | SDK toggle styling |

**Total: ~130 lines of changes**

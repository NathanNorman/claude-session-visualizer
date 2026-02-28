// ============================================================================
// Feature: Mission Control - Live Session Monitoring
// ============================================================================

// Mission Control state
let mcSelectedSessionId = null;
let mcSelectedSessionPid = null;  // PID of selected detected session (for kill button)
let mcSelectedSessionSlug = null;  // Slug of selected detected session
let mcConversationCache = new Map();
let mcStickyScroll = null;  // StickyScroll instance for Mission Control
let mcLastMessageCount = 0;
let mcAttachedImages = [];  // Array of {path, dataUrl, filename} for attached images
let mcProcessWebSocket = null;  // WebSocket for real-time conversation updates

/**
 * Initialize Mission Control event listeners
 */
function initMissionControl() {
    // Initialize SDK mode status
    initSDKMode();

    // Fetch managed processes on init (for SDK sessions that persist across page loads)
    refreshManagedProcessList().then(() => {
        // Re-render mission control after managed processes are loaded
        if (missionControl.getCurrentView() === 'mission-control') {
            refreshMissionControl();
        }
    });

    // Refresh button
    const refreshBtn = document.getElementById('mc-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            await refreshManagedProcessList();
            refreshMissionControl();
            showToast('Mission Control refreshed');
        });
    }

    // Set up sticky scroll for conversation stream
    const streamEl = document.getElementById('mc-conversation-stream');
    if (streamEl) {
        mcStickyScroll = new StickyScroll(streamEl, { showIndicator: true }).attach();
    }

    // Initialize message input
    initMCInput();
}

/**
 * Initialize Mission Control message input
 */
function initMCInput() {
    const inputEl = document.getElementById('mc-input');
    const sendBtn = document.getElementById('mc-send-btn');

    if (!inputEl || !sendBtn) return;

    // Handle input for syntax highlighting and autocomplete
    inputEl.addEventListener('input', () => {
        highlightMCInput(inputEl);
        handleSlashAutocomplete(inputEl);
    });

    // Handle Cmd+Enter to send, and autocomplete navigation
    inputEl.addEventListener('keydown', (e) => {
        // Check if autocomplete is open and handle navigation
        const autocomplete = document.getElementById('mc-autocomplete');
        if (autocomplete && !autocomplete.classList.contains('hidden')) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                navigateAutocomplete(1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                navigateAutocomplete(-1);
                return;
            }
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                const selected = autocomplete.querySelector('.mc-autocomplete-item.selected');
                if (selected) {
                    e.preventDefault();
                    selectAutocompleteItem(selected);
                    return;
                }
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                hideAutocomplete();
                return;
            }
            if (e.key === 'Tab') {
                const selected = autocomplete.querySelector('.mc-autocomplete-item.selected');
                if (selected) {
                    e.preventDefault();
                    selectAutocompleteItem(selected);
                    return;
                }
            }
        }

        // Cmd+Enter to send
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            hideAutocomplete();
            sendMCMessage();
        }
    });

    // Handle paste - strip formatting for text, handle images
    inputEl.addEventListener('paste', async (e) => {
        // Check for images in clipboard
        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find(item => item.type.startsWith('image/'));

        if (imageItem) {
            e.preventDefault();
            const file = imageItem.getAsFile();
            if (file) {
                await handleImageAttachment(file);
            }
            return;
        }

        // Plain text - strip formatting
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
    });

    // Handle drag and drop for images
    inputEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        inputEl.classList.add('drag-over');
    });

    inputEl.addEventListener('dragleave', (e) => {
        e.preventDefault();
        inputEl.classList.remove('drag-over');
    });

    inputEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        inputEl.classList.remove('drag-over');

        const files = Array.from(e.dataTransfer.files);
        const imageFiles = files.filter(f => f.type.startsWith('image/'));

        for (const file of imageFiles) {
            await handleImageAttachment(file);
        }
    });

    // Send button click
    sendBtn.addEventListener('click', () => {
        hideAutocomplete();
        sendMCMessage();
    });

    // Hide autocomplete and pickers when clicking outside
    document.addEventListener('click', (e) => {
        const autocomplete = document.getElementById('mc-autocomplete');
        const slashPicker = document.getElementById('mc-slash-picker');
        const slashBtn = document.getElementById('mc-slash-btn');

        // Hide autocomplete
        if (autocomplete && !autocomplete.contains(e.target) && e.target !== inputEl) {
            hideAutocomplete();
        }

        // Hide slash picker if clicking outside
        if (slashPicker && !slashPicker.classList.contains('hidden')) {
            if (!slashPicker.contains(e.target) && e.target !== slashBtn && !slashBtn.contains(e.target)) {
                hideSlashPicker();
            }
        }
    });

    // Handle Escape key to close pickers
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const slashPicker = document.getElementById('mc-slash-picker');

            if (slashPicker && !slashPicker.classList.contains('hidden')) {
                hideSlashPicker();
                e.preventDefault();
            }
        }
    });
}

/**
 * Handle an image file attachment - upload to server and add to preview
 */
async function handleImageAttachment(file) {
    // Read file as data URL for preview
    const dataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });

    // Upload to server
    try {
        const response = await fetch('/api/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: dataUrl,
                filename: file.name,
                mime_type: file.type
            })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Upload failed' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const result = await response.json();

        // Add to attached images
        mcAttachedImages.push({
            path: result.path,
            dataUrl: dataUrl,
            filename: result.filename
        });

        // Update preview UI
        renderImagePreviews();
        showToast(`Image attached: ${file.name}`, 'success');

    } catch (error) {
        console.error('Failed to upload image:', error);
        showToast(`Failed to attach image: ${error.message}`, 'error');
    }
}

/**
 * Remove an attached image by index
 */
function removeAttachedImage(index) {
    mcAttachedImages.splice(index, 1);
    renderImagePreviews();
}

/**
 * Render image preview thumbnails in the input area
 */
function renderImagePreviews() {
    let previewContainer = document.getElementById('mc-image-previews');

    // Create container if it doesn't exist
    if (!previewContainer) {
        previewContainer = document.createElement('div');
        previewContainer.id = 'mc-image-previews';
        previewContainer.className = 'mc-image-previews';

        // Insert before the input wrapper
        const inputWrapper = document.querySelector('.mc-input-wrapper');
        if (inputWrapper) {
            inputWrapper.parentNode.insertBefore(previewContainer, inputWrapper);
        }
    }

    // Render thumbnails
    if (mcAttachedImages.length === 0) {
        previewContainer.innerHTML = '';
        previewContainer.classList.add('hidden');
        return;
    }

    previewContainer.classList.remove('hidden');
    previewContainer.innerHTML = mcAttachedImages.map((img, index) => `
        <div class="mc-image-preview" title="${escapeHtml(img.filename)}">
            <img src="${img.dataUrl}" alt="${escapeHtml(img.filename)}">
            <button class="mc-image-remove" onclick="removeAttachedImage(${index})" title="Remove image">×</button>
        </div>
    `).join('');
}

/**
 * Clear all attached images
 */
function clearAttachedImages() {
    mcAttachedImages = [];
    renderImagePreviews();
}

/**
 * Apply syntax highlighting for backtick code in the input
 */
function highlightMCInput(el) {
    // Get current text and cursor position
    const sel = window.getSelection();
    const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    let cursorOffset = 0;

    if (range && el.contains(range.startContainer)) {
        // Calculate cursor offset in plain text
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(el);
        preCaretRange.setEnd(range.startContainer, range.startOffset);
        cursorOffset = preCaretRange.toString().length;
    }

    // Get plain text
    const text = el.innerText || '';

    // If no backticks, no highlighting needed
    if (!text.includes('`')) {
        return;
    }

    // Highlight code blocks (```...```) and inline code (`...`)
    let html = escapeHtml(text);

    // Code blocks first (triple backticks)
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

    // Then inline code (single backticks)
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Only update if changed
    if (el.innerHTML !== html) {
        el.innerHTML = html;

        // Restore cursor position
        if (cursorOffset > 0) {
            restoreCursor(el, cursorOffset);
        }
    }
}

/**
 * Restore cursor position after HTML modification
 */
function restoreCursor(el, offset) {
    const range = document.createRange();
    const sel = window.getSelection();

    let charCount = 0;
    let found = false;

    function walkNodes(node) {
        if (found) return;

        if (node.nodeType === Node.TEXT_NODE) {
            const nextCount = charCount + node.textContent.length;
            if (offset <= nextCount) {
                range.setStart(node, offset - charCount);
                range.collapse(true);
                found = true;
            }
            charCount = nextCount;
        } else {
            for (const child of node.childNodes) {
                walkNodes(child);
                if (found) break;
            }
        }
    }

    walkNodes(el);

    if (found) {
        sel.removeAllRanges();
        sel.addRange(range);
    } else {
        // Put cursor at end if offset not found
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

/**
 * Send message to the selected session
 */
async function sendMCMessage() {
    const inputEl = document.getElementById('mc-input');
    const sendBtn = document.getElementById('mc-send-btn');
    const statusEl = document.getElementById('mc-input-status');

    if (!inputEl || !mcSelectedSessionId) return;

    // Get plain text content
    let message = inputEl.innerText.trim();

    // Prepend image paths if any attached
    if (mcAttachedImages.length > 0) {
        const imagePaths = mcAttachedImages.map(img => img.path).join(' ');
        message = message ? `${imagePaths} ${message}` : imagePaths;
    }

    if (!message) return;

    // Disable input during send
    sendBtn.disabled = true;
    inputEl.contentEditable = 'false';
    if (statusEl) {
        statusEl.textContent = 'Sending...';
        statusEl.className = 'sending';
    }

    try {
        const response = await fetch(`/api/session/${mcSelectedSessionId}/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, submit: true })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Success - clear input and attached images
        inputEl.innerHTML = '';
        clearAttachedImages();
        if (statusEl) {
            statusEl.textContent = 'Sent!';
            statusEl.className = '';
            setTimeout(() => { statusEl.textContent = ''; }, 2000);
        }

        // Refresh conversation after a short delay
        setTimeout(() => {
            loadConversationHistory(mcSelectedSessionId, true);
        }, 500);

    } catch (error) {
        console.error('Failed to send message:', error);
        if (statusEl) {
            statusEl.textContent = error.message;
            statusEl.className = 'error';
            setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
        }
        showToast(`Failed to send: ${error.message}`, 'error');
    } finally {
        // Re-enable input
        sendBtn.disabled = false;
        inputEl.contentEditable = 'true';
        inputEl.focus();
    }
}

/**
 * Show the Mission Control message input
 */
function showMCInput() {
    const container = document.getElementById('mc-input-container');
    if (container) {
        container.classList.remove('hidden');
    }
}

/**
 * Hide the Mission Control message input
 */
function hideMCInput() {
    const container = document.getElementById('mc-input-container');
    const inputEl = document.getElementById('mc-input');
    const statusEl = document.getElementById('mc-input-status');

    if (container) {
        container.classList.add('hidden');
    }
    if (inputEl) {
        inputEl.innerHTML = '';
    }
    if (statusEl) {
        statusEl.textContent = '';
        statusEl.className = '';
    }
}

/**
 * Refresh Mission Control with current session data
 */
function refreshMissionControl() {
    const sessions = Array.from(previousSessions.values());
    const activeSessions = sessions.filter(s => s.state === 'active' || s.state === 'waiting');

    renderMissionControlSessions(activeSessions);
    updateMissionControlStatus(activeSessions.length > 0);

    // Reload conversation if session still exists (skip loading state for background refresh)
    if (mcSelectedSessionId) {
        const selectedSession = sessions.find(s => s.sessionId === mcSelectedSessionId);
        if (selectedSession) {
            loadConversationHistory(mcSelectedSessionId, true);
            // Update context indicator with latest token data
            if (selectedSession.contextTokens) {
                updateContextIndicator(selectedSession.contextTokens, MAX_CONTEXT_TOKENS);
            }
        } else {
            // Session ended, clear selection
            mcSelectedSessionId = null;
            clearMissionControlConversation();
        }
    }
}

/**
 * Update Mission Control connection status indicator
 */
function updateMissionControlStatus(hasActiveSessions) {
    const statusEl = document.getElementById('mc-connection-status');
    if (!statusEl) return;

    if (hasActiveSessions) {
        statusEl.textContent = '● Connected';
        statusEl.classList.remove('disconnected');
        statusEl.classList.add('connected');
    } else {
        statusEl.textContent = '● No Active Sessions';
        statusEl.classList.remove('connected');
        statusEl.classList.add('disconnected');
    }
}

/**
 * Render the list of sessions in Mission Control (differential updates to prevent blinking)
 */
function renderMissionControlSessions(sessions) {
    const container = document.getElementById('mc-sessions-list');
    const countEl = document.getElementById('mc-active-count');

    if (!container) return;

    // Update count
    if (countEl) {
        countEl.textContent = sessions.length;
    }

    // Handle empty state
    if (sessions.length === 0) {
        if (!container.querySelector('.mc-empty')) {
            container.innerHTML = '<div class="mc-empty">No active sessions</div>';
        }
        return;
    }

    // Group sessions by repo
    const groups = groupSessionsByRepo(sessions);

    // Differential update: update existing items in place, only add/remove as needed
    const existingItems = new Map();
    container.querySelectorAll('.mc-session-item').forEach(el => {
        existingItems.set(el.dataset.sessionId, el);
    });

    // Build new HTML only if structure changed (add/remove sessions)
    const allSessions = sessions;
    const currentIdsSet = new Set(allSessions.map(s => s.sessionId));
    const previousIdsRaw = container.dataset.sessionIds || '';
    const previousIdsSet = new Set(previousIdsRaw ? previousIdsRaw.split(',') : []);

    // Efficient Set comparison for detecting adds/removes
    const structureChanged = currentIdsSet.size !== previousIdsSet.size ||
        [...currentIdsSet].some(id => !previousIdsSet.has(id));

    // If session list structure changed (add/remove), do full rebuild
    if (structureChanged) {
        // Build HTML
        let html = '';

        // Regular session groups
        for (const group of groups) {
            html += `
                <div class="mc-repo-group">
                    <div class="mc-repo-header">${escapeHtml(group.repoName)}</div>
                    <div class="mc-repo-sessions">
                        ${group.sessions.map(session => renderMCSessionItem(session)).join('')}
                    </div>
                </div>
            `;
        }

        container.innerHTML = html;
        container.dataset.sessionIds = [...currentIdsSet].join(',');

        // Reattach click handlers
        container.querySelectorAll('.mc-session-item').forEach(el => {
            el.onclick = () => selectMissionControlSession(el.dataset.sessionId);
        });
    } else {
        // Structure unchanged - do in-place updates of existing items
        for (const session of allSessions) {
            const existingEl = existingItems.get(session.sessionId);
            if (existingEl) {
                // Update in place - just update the inner content
                const newHtml = renderMCSessionItem(session);
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = newHtml;
                const newEl = tempDiv.firstElementChild;

                // Only update if content changed
                if (existingEl.innerHTML !== newEl.innerHTML ||
                    existingEl.className !== newEl.className) {
                    existingEl.innerHTML = newEl.innerHTML;
                    existingEl.className = newEl.className;
                }
            }
        }
    }
}

function groupSessionsByRepo(sessions) {
    const groups = {};

    for (const session of sessions) {
        const cwd = session.cwd || '';
        const parts = cwd.split('/').filter(Boolean);
        let repoName = 'Unknown';

        // Extract repo name from path
        if (parts.length >= 3 && parts[0] === 'Users') {
            repoName = parts[2];
        } else if (parts.length >= 3 && parts[0] === 'home') {
            repoName = parts[2];
        } else if (parts.length > 0) {
            repoName = parts.find(p => !p.startsWith('.')) || parts[0];
        }

        if (!groups[repoName]) {
            groups[repoName] = { repoName, sessions: [] };
        }
        groups[repoName].sessions.push(session);
    }

    // Sort groups by most recent activity, then sort sessions within each group
    const sortedGroups = Object.values(groups).sort((a, b) => {
        const aMax = Math.max(...a.sessions.map(s => s.lastActivity ? new Date(s.lastActivity).getTime() : 0));
        const bMax = Math.max(...b.sessions.map(s => s.lastActivity ? new Date(s.lastActivity).getTime() : 0));
        return bMax - aMax;
    });

    // Sort sessions within each group: active first, then by activity
    for (const group of sortedGroups) {
        group.sessions.sort((a, b) => {
            const stateOrder = { active: 0, waiting: 1, idle: 2 };
            const aOrder = stateOrder[a.state] ?? 3;
            const bOrder = stateOrder[b.state] ?? 3;
            if (aOrder !== bOrder) return aOrder - bOrder;
            const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
            const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
            return bTime - aTime;
        });
    }

    return sortedGroups;
}

function renderMCSessionItem(session) {
    const isSelected = session.sessionId === mcSelectedSessionId;
    const displayName = session.cwd ? session.cwd.split('/').pop() : session.sessionId.slice(0, 8);
    const duration = formatAgentDuration(session.startTimestamp) || '0m';
    const contextPct = Math.round(session.tokenPercentage || 0);

    // Activity status for the pill
    const activityStatus = getActivityStatus(session.lastActivity);

    // Show activity status - always use activityStatus for consistent display
    const activityHtml = activityStatus.text
        ? `<span class="idle-badge" style="background: ${activityStatus.color}; color: ${activityStatus.idleMins > 30 ? '#fff' : '#000'}">${activityStatus.text}</span>`
        : '<span class="idle-indicator">idle</span>';

    // Take Over button: show for terminal sessions with PID that aren't already managed
    const hasPid = session.pid && !managedProcesses.has(session.sessionId);
    const takeOverBtn = hasPid ? `
        <button class="mc-takeover-btn" onclick="event.stopPropagation(); takeOverSession('${escapeJsString(session.sessionId)}')" title="Take over this session in the browser">
            Take Over
        </button>` : '';

    return `
        <div class="mc-session-item ${session.state === 'active' ? 'active' : ''} ${isSelected ? 'selected' : ''}"
             data-session-id="${session.sessionId}">
            <div class="mc-session-name">${escapeHtml(displayName)}</div>
            <div class="mc-session-meta">
                <span>${duration}</span>
                <span>${contextPct}% ctx</span>
            </div>
            <div class="mc-session-activity">${activityHtml}${takeOverBtn}</div>
        </div>
    `;
}

/**
 * Select a session in Mission Control
 */
function selectMissionControlSession(sessionId) {
    // Disconnect any existing process WebSocket when switching sessions
    disconnectMissionControlProcess();

    mcSelectedSessionId = sessionId;
    // Reset auto-scroll when selecting a new session
    if (mcStickyScroll) {
        mcStickyScroll.autoScroll = true;
    }

    // Update session list UI
    document.querySelectorAll('.mc-session-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.sessionId === sessionId);
    });

    // Update selected label
    const session = previousSessions.get(sessionId);
    const labelEl = document.getElementById('mc-selected-session');
    if (labelEl && session) {
        const displayName = session.cwd ? session.cwd.split('/').pop() : sessionId.slice(0, 8);
        labelEl.textContent = displayName;
    }

    // Store PID/slug for kill button
    mcSelectedSessionPid = session?.pid || null;
    mcSelectedSessionSlug = session?.slug || session?.cwd?.split('/').pop() || sessionId.slice(0, 8);

    // Show kill button if session has a PID
    const killBtn = document.getElementById('mc-kill-btn');
    if (killBtn) {
        killBtn.classList.toggle('hidden', !mcSelectedSessionPid);
        killBtn.textContent = 'Kill';
        killBtn.title = mcSelectedSessionPid ? `Kill process ${mcSelectedSessionPid}` : '';
    }
    // Hide release button for terminal sessions (only for managed processes)
    const releaseBtn = document.getElementById('mc-release-btn');
    if (releaseBtn) {
        releaseBtn.classList.add('hidden');
    }

    // Update context indicator with session's token data
    if (session && session.contextTokens) {
        updateContextIndicator(session.contextTokens, MAX_CONTEXT_TOKENS);
    } else {
        updateContextIndicator(0, MAX_CONTEXT_TOKENS);
    }

    // Show/hide message input based on session state
    if (session && (session.state === 'active' || session.state === 'waiting')) {
        showMCInput();
    } else {
        hideMCInput();
    }

    // Load conversation
    loadConversationHistory(sessionId);

    // Connect to process WebSocket for real-time updates if there's a matching managed process
    const matchingProcessId = findMatchingManagedProcess(session);
    if (matchingProcessId) {
        console.log(`[MC] Found matching managed process ${matchingProcessId} for session, enabling real-time updates`);
        connectMissionControlToProcess(matchingProcessId);
    }
}

/**
 * Load conversation history from API
 */
async function loadConversationHistory(sessionId, skipLoadingState = false) {
    const streamEl = document.getElementById('mc-conversation-stream');
    if (!streamEl) return;

    // Show loading state only on initial load
    if (!skipLoadingState) {
        streamEl.innerHTML = '<div class="mc-empty">Loading conversation...</div>';
    }

    try {
        const response = await fetch(`/api/session/${sessionId}/conversation`);
        if (!response.ok) {
            throw new Error('Failed to load conversation');
        }

        const data = await response.json();
        const messages = data.messages || [];

        // Cache the messages
        mcConversationCache.set(sessionId, messages);
        mcLastMessageCount = messages.length;

        renderConversation(messages);

    } catch (error) {
        console.error('Failed to load conversation:', error);
        streamEl.innerHTML = `<div class="mc-empty">Failed to load conversation</div>`;
    }
}

/**
 * Render inline expandable tool blocks for a message
 * @param {Array} tools - Array of tool objects
 * @param {boolean} canHaveRunningTools - Whether this message can have running tools (only true for last assistant msg)
 */
function renderInlineToolBlocks(tools, canHaveRunningTools = false) {
    if (!tools || tools.length === 0) return '';

    const errorCount = tools.filter(t => t.is_error).length;

    const toolsHtml = tools.map((tool, idx) => {
        const isError = tool.is_error;
        const toolName = tool.name || 'Unknown';
        const summary = getInlineToolSummary(tool);
        const isAgent = toolName === 'Task';
        // Tool is only running if: no output AND this message can have running tools
        const hasNoOutput = !tool.output && tool.output !== '';
        const isRunning = hasNoOutput && canHaveRunningTools;

        // Calculate duration
        const durationHtml = getToolDurationHtml(tool, isRunning);

        // Estimate tokens for tool (roughly 4 chars per token)
        const inputTokens = Math.ceil(JSON.stringify(tool.input || {}).length / 4);
        const outputTokens = Math.ceil((tool.output || '').length / 4);
        const totalTokens = inputTokens + outputTokens;
        const tokenDisplay = formatToolTokens(inputTokens, outputTokens);

        // Format input - returns { text, type }
        const inputResult = formatInlineToolInput(tool);
        const inputStr = inputResult.text;
        const inputType = inputResult.type;

        // Format output (truncated if too long) - ensure string
        const rawOutput = tool.output;
        const output = typeof rawOutput === 'string' ? rawOutput : (rawOutput ? JSON.stringify(rawOutput, null, 2) : '');
        const outputIsTruncated = output.length > 1000;
        const outputTruncated = outputIsTruncated ? output.slice(0, 1000) : output;

        // Check if output looks like JSON
        let outputType = 'plain';
        if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
            try {
                JSON.parse(output);
                outputType = 'json';
            } catch {}
        }

        // Escape content for data attributes
        const inputEscaped = inputStr.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const outputEscaped = output.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        // Render content with syntax highlighting based on type
        const inputHtml = inputType === 'json' ? highlightJson(inputStr) :
                          inputType === 'bash' ? highlightBash(inputStr) :
                          escapeHtml(inputStr);
        const outputHtml = outputType === 'json' ? highlightJson(outputTruncated) : escapeHtml(outputTruncated);

        return `
            <div class="mc-inline-tool ${isError ? 'error' : ''} ${isAgent ? 'agent' : ''} ${isRunning ? 'running' : ''}" data-tool-idx="${idx}">
                <div class="mc-inline-tool-header" onclick="toggleInlineToolExpand(this)">
                    <span class="tool-expand-icon">▶</span>
                    <span class="tool-status-icon">${isRunning ? '<span class="tool-running-pulse"></span>' : (isError ? icon('x-circle', {size:14}) : icon('check-circle', {size:14}))}</span>
                    <span class="tool-name">${escapeHtml(toolName)}</span>
                    ${isAgent ? `<span class="tool-agent-badge">${icon('bot', {size:14})} Agent</span>` : ''}
                    <span class="tool-summary">${escapeHtml(summary)}</span>
                    ${durationHtml}
                    <span class="tool-tokens" title="Input: ~${inputTokens} tokens, Output: ~${outputTokens} tokens">${tokenDisplay}</span>
                </div>
                <div class="mc-inline-tool-details hidden">
                    ${inputStr ? `
                        <div class="tool-input">
                            <div class="detail-header">
                                <span class="detail-label">Input</span>
                                <button class="detail-copy-btn" onclick="event.stopPropagation(); copyToolContent(this)" data-content="${inputEscaped}" title="Copy input">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>
                                </button>
                            </div>
                            <pre class="detail-content ${inputType}-content">${inputHtml}</pre>
                        </div>
                    ` : ''}
                    ${output ? `
                        <div class="tool-output ${isError ? 'error-output' : ''} ${outputIsTruncated ? 'truncated' : ''}">
                            <div class="detail-header">
                                <span class="detail-label">Output${isError ? ' (Error)' : ''}</span>
                                <button class="detail-copy-btn" onclick="event.stopPropagation(); copyToolContent(this)" data-content="${outputEscaped}" title="Copy output">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>
                                </button>
                            </div>
                            <pre class="detail-content ${outputType}-content" data-truncated="${outputIsTruncated}" data-full-content="${outputEscaped}">${outputHtml}${outputIsTruncated ? '\n<span class="truncation-indicator">... (truncated)</span>' : ''}</pre>
                            ${outputIsTruncated ? `
                                <button class="expand-output-btn" onclick="event.stopPropagation(); toggleOutputExpand(this)">
                                    <span class="expand-icon">▶</span>
                                    <span class="expand-text">Show full output (${Math.round(output.length / 1024)}KB)</span>
                                </button>
                            ` : ''}
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');

    return `
        <div class="mc-inline-tools">
            ${errorCount > 0 ? `<div class="mc-inline-tools-error-badge">${errorCount} failed</div>` : ''}
            ${toolsHtml}
        </div>
    `;
}

/**
 * Toggle inline tool expansion
 */
function toggleInlineToolExpand(header) {
    const item = header.closest('.mc-inline-tool');
    const details = item.querySelector('.mc-inline-tool-details');
    const icon = header.querySelector('.tool-expand-icon');

    if (details.classList.contains('hidden')) {
        details.classList.remove('hidden');
        icon.textContent = '▼';
        item.classList.add('expanded');
    } else {
        details.classList.add('hidden');
        icon.textContent = '▶';
        item.classList.remove('expanded');
    }
}

/**
 * Toggle expanded output view
 */
function toggleOutputExpand(button) {
    const outputDiv = button.closest('.tool-output');
    const pre = outputDiv.querySelector('pre.detail-content');
    const icon = button.querySelector('.expand-icon');
    const text = button.querySelector('.expand-text');
    const isExpanded = outputDiv.classList.contains('expanded');

    if (isExpanded) {
        // Collapse back to truncated view
        outputDiv.classList.remove('expanded');
        icon.textContent = '▶';
        text.textContent = text.dataset.originalText || 'Show full output';

        // Get truncated content (first 1000 chars)
        const fullContent = pre.dataset.fullContent || '';
        const decoded = fullContent.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const truncated = decoded.slice(0, 1000);

        // Check if JSON for highlighting
        let html;
        if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[')) {
            try {
                JSON.parse(decoded);
                html = highlightJson(truncated);
            } catch {
                html = escapeHtml(truncated);
            }
        } else {
            html = escapeHtml(truncated);
        }
        pre.innerHTML = html + '\n<span class="truncation-indicator">... (truncated)</span>';
    } else {
        // Expand to full view
        outputDiv.classList.add('expanded');
        icon.textContent = '▼';
        text.dataset.originalText = text.textContent;
        text.textContent = 'Collapse output';

        // Get full content from data attribute
        const fullContent = pre.dataset.fullContent || '';
        const decoded = fullContent.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

        // Check if JSON for highlighting
        let html;
        if (decoded.trim().startsWith('{') || decoded.trim().startsWith('[')) {
            try {
                JSON.parse(decoded);
                html = highlightJson(decoded);
            } catch {
                html = escapeHtml(decoded);
            }
        } else {
            html = escapeHtml(decoded);
        }
        pre.innerHTML = html;
    }
}

/**
 * Toggle expanded user message content
 */
function toggleUserMessage(msgId) {
    const preview = document.getElementById(`${msgId}-preview`);
    const full = document.getElementById(`${msgId}-full`);
    const btn = preview?.parentElement?.querySelector('.user-message-toggle');

    if (!preview || !full || !btn) return;

    const isExpanded = full.classList.contains('hidden');

    if (isExpanded) {
        preview.classList.add('hidden');
        full.classList.remove('hidden');
        btn.textContent = 'Show less';
    } else {
        preview.classList.remove('hidden');
        full.classList.add('hidden');
        btn.textContent = 'Show more';
    }
}

/**
 * Toggle compaction details accordion
 */
function toggleCompactionDetails(markerId) {
    const preview = document.getElementById(`${markerId}-preview`);
    const details = document.getElementById(`${markerId}-details`);
    const badge = preview?.parentElement?.querySelector('.mc-compaction-badge');
    const toggle = badge?.querySelector('.mc-compaction-toggle');

    if (!preview || !details) return;

    const isExpanded = !details.classList.contains('hidden');

    if (isExpanded) {
        // Collapse
        details.classList.add('hidden');
        preview.classList.remove('hidden');
        if (toggle) toggle.textContent = '▶';
    } else {
        // Expand
        preview.classList.add('hidden');
        details.classList.remove('hidden');
        if (toggle) toggle.textContent = '▼';
    }
}

/**
 * Copy tool input/output content to clipboard
 */
function copyToolContent(button) {
    const content = button.dataset.content || '';
    // Decode HTML entities
    const decoded = content.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

    navigator.clipboard.writeText(decoded).then(() => {
        // Show success feedback
        const originalHtml = button.innerHTML;
        button.innerHTML = icon('check', {size:12});
        button.classList.add('copied');
        setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied');
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

/**
 * Get summary text for inline tool display
 */
function getInlineToolSummary(tool) {
    const name = tool.name || '';
    const input = tool.input || {};

    if (name === 'Bash') {
        return input.description || (input.command || '').slice(0, 60);
    } else if (name === 'Read') {
        const path = input.file_path || '';
        return path.split('/').pop() || 'file';
    } else if (name === 'Write' || name === 'Edit') {
        const path = input.file_path || '';
        return path.split('/').pop() || 'file';
    } else if (name === 'Grep') {
        return `'${(input.pattern || '').slice(0, 40)}'`;
    } else if (name === 'Glob') {
        return (input.pattern || '').slice(0, 40);
    } else if (name === 'Task') {
        return input.description || '';
    } else if (name === 'WebFetch') {
        const url = input.url || '';
        try {
            return new URL(url).hostname;
        } catch {
            return url.slice(0, 40);
        }
    }
    return '';
}

/**
 * Format tool input for inline display
 * Returns { text: string, type: 'json'|'bash'|'plain' } for proper rendering
 */
function formatInlineToolInput(tool) {
    const name = tool.name || '';
    const input = tool.input || {};

    if (name === 'Bash') {
        return { text: input.command || '', type: 'bash' };
    } else if (name === 'Read') {
        return { text: input.file_path || '', type: 'plain' };
    } else if (name === 'Write') {
        const content = input.content || '';
        return { text: `${input.file_path || ''}\n---\n${content.slice(0, 300)}${content.length > 300 ? '...' : ''}`, type: 'plain' };
    } else if (name === 'Edit') {
        const oldStr = input.old_string || '';
        const newStr = input.new_string || '';
        return { text: `${input.file_path || ''}\n---\nold: ${oldStr.slice(0, 150)}\nnew: ${newStr.slice(0, 150)}`, type: 'plain' };
    } else if (name === 'Grep') {
        return { text: `pattern: ${input.pattern || ''}\npath: ${input.path || '.'}`, type: 'plain' };
    } else if (name === 'Glob') {
        return { text: `pattern: ${input.pattern || ''}\npath: ${input.path || '.'}`, type: 'plain' };
    } else if (name === 'WebFetch') {
        return { text: input.url || '', type: 'plain' };
    }

    // Generic: show full input as JSON with syntax highlighting
    try {
        return { text: JSON.stringify(input, null, 2), type: 'json' };
    } catch {
        return { text: String(input), type: 'plain' };
    }
}

/**
 * Syntax highlight JSON string using highlight.js
 */
function highlightJson(jsonStr) {
    try {
        return hljs.highlight(jsonStr, { language: 'json' }).value;
    } catch {
        return escapeHtml(jsonStr);
    }
}

/**
 * Syntax highlight Bash/shell commands using highlight.js
 */
function highlightBash(bashStr) {
    try {
        return hljs.highlight(bashStr, { language: 'bash' }).value;
    } catch {
        return escapeHtml(bashStr);
    }
}

/**
 * Get tool duration HTML
 * For completed tools: shows how long the tool took
 * For running tools: shows elapsed time with live indicator
 */
function getToolDurationHtml(tool, isRunning) {
    const timestamp = tool.timestamp;
    if (!timestamp) return '';

    const startTime = new Date(timestamp).getTime();

    if (isRunning) {
        // Tool still running - show elapsed time
        const elapsed = Date.now() - startTime;
        const durationStr = formatDurationMs(elapsed);
        return `<span class="tool-duration running" data-start="${startTime}">${durationStr}</span>`;
    } else if (tool.resultTimestamp) {
        // Tool completed - calculate actual duration
        const endTime = new Date(tool.resultTimestamp).getTime();
        const durationMs = endTime - startTime;
        if (durationMs > 0) {
            return `<span class="tool-duration completed">${formatDurationMs(durationMs)}</span>`;
        }
    }

    // No duration available
    return '';
}

/**
 * Format duration in human-readable form (takes milliseconds)
 */
function formatDurationMs(ms) {
    if (ms < 1000) return '<1s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
}

/**
 * Format tool token counts for display
 */
function formatToolTokens(inputTokens, outputTokens) {
    const total = inputTokens + outputTokens;
    if (total < 1000) {
        return `~${total} tok`;
    } else {
        return `~${(total / 1000).toFixed(1)}k tok`;
    }
}

/**
 * Render conversation messages
 */
function renderConversation(messages) {
    const streamEl = document.getElementById('mc-conversation-stream');
    if (!streamEl) return;

    if (!messages || messages.length === 0) {
        streamEl.innerHTML = '<div class="mc-empty">No conversation yet</div>';
        return;
    }

    // Filter out empty messages, but keep tool-only assistant messages and system messages
    const filteredMessages = messages.filter(msg => {
        const hasContent = msg.content && msg.content.trim();
        const hasTools = (msg.tools && msg.tools.length > 0) || (msg.toolsDetailed && msg.toolsDetailed.length > 0);
        const isSystem = msg.role === 'system';
        return hasContent || hasTools || isSystem;
    });

    // Check if we need to re-render (message count changed)
    const existingCount = streamEl.querySelectorAll('.mc-message').length;
    const needsFullRender = existingCount !== filteredMessages.length;

    if (!needsFullRender) {
        // Same count - just update timestamps
        streamEl.querySelectorAll('.mc-message').forEach((el, idx) => {
            const msg = filteredMessages[idx];
            if (msg) {
                const timeEl = el.querySelector('.mc-message-time');
                if (timeEl && msg.timestamp) {
                    timeEl.textContent = formatTimeAgo(new Date(msg.timestamp));
                }
            }
        });
        return;
    }

    // Full render
    // Capture expanded tool states before re-rendering
    const expandedTools = new Set();
    streamEl.querySelectorAll('.mc-message').forEach(msgEl => {
        const msgIdx = msgEl.dataset.idx;
        msgEl.querySelectorAll('.mc-inline-tool.expanded').forEach(toolEl => {
            const toolIdx = toolEl.dataset.toolIdx;
            if (msgIdx !== undefined && toolIdx !== undefined) {
                expandedTools.add(`${msgIdx}-${toolIdx}`);
            }
        });
    });

    // Build all message HTML
    const html = filteredMessages.map((msg, idx) => {
        const role = msg.role || 'unknown';
        const roleClass = role === 'user' ? 'human' : role === 'system' ? 'system' : 'assistant';
        const roleLabel = role === 'user' ? `${icon('user', {size:14})} You` : role === 'system' ? `${icon('clipboard-list', {size:14})} System` : `${icon('bot', {size:14})} Assistant`;
        const timestamp = msg.timestamp ? formatTimeAgo(new Date(msg.timestamp)) : '';

        // Handle continuation markers specially
        if (msg.isContinuation) {
            const continuationId = msg.continuationId || '';
            const shortId = continuationId.slice(0, 8);
            return `
                <div class="mc-continuation-marker" data-idx="${idx}" data-continuation-id="${continuationId}">
                    <div class="mc-continuation-line"></div>
                    <div class="mc-continuation-content">
                        <span class="mc-continuation-icon">${icon('chevrons-down', {size:14})}</span>
                        <span class="mc-continuation-text">Conversation continued...</span>
                        ${shortId ? `<span class="mc-continuation-id">${shortId}</span>` : ''}
                    </div>
                    <div class="mc-continuation-line"></div>
                </div>
            `;
        }

        // Handle compaction markers with accordion-style divider
        if (msg.isCompaction) {
            const markerId = `compaction-${idx}`;
            const content = msg.content || '';

            // Check if this is a trailing compaction (no real messages after it)
            // Trailing compactions are just context saves, not historical compaction points
            const isTrailingCompaction = !filteredMessages.slice(idx + 1).some(m =>
                m.role === 'user' || m.role === 'assistant' || m.isContinuation
            );

            // For trailing compactions, don't show anything - it's just an internal summary
            // that doesn't affect the user's view of the conversation
            if (isTrailingCompaction) {
                return '';
            }

            // Get preview (first 120 chars, clean up newlines)
            const preview = content.replace(/\n/g, ' ').slice(0, 120);
            const hasMore = content.length > 120;
            const escapedContent = escapeHtml(content).replace(/\n/g, '<br>');
            const messagesCompacted = msg.messagesCompacted || '';
            const statsText = messagesCompacted ? ` · ${messagesCompacted} messages` : '';

            return `
                <div class="mc-compaction-marker" data-idx="${idx}">
                    <div class="mc-compaction-divider">
                        <div class="mc-compaction-line"></div>
                        <div class="mc-compaction-badge" onclick="toggleCompactionDetails('${markerId}')" title="Click to ${hasMore ? 'expand' : 'view'} summary">
                            <span class="mc-compaction-icon">${icon('clipboard-list', {size:14})}</span>
                            <span class="mc-compaction-label">Compacted${statsText}</span>
                            ${hasMore ? '<span class="mc-compaction-toggle">▶</span>' : ''}
                        </div>
                        <div class="mc-compaction-line"></div>
                    </div>
                    <div class="mc-compaction-preview" id="${markerId}-preview">
                        ${escapeHtml(preview)}${hasMore ? '...' : ''}
                    </div>
                    <div class="mc-compaction-details hidden" id="${markerId}-details">
                        ${escapedContent}
                    </div>
                </div>
            `;
        }

        let displayContent = '';
        let isToolOnly = false;
        let toolsText = '';
        let inlineToolsHtml = '';

        // Render inline tool blocks if detailed tools are available
        const toolsDetailed = msg.toolsDetailed || [];
        if (toolsDetailed.length > 0) {
            // Only the last assistant message can have running tools
            const isLastAssistantMsg = idx === filteredMessages.length - 1 ||
                filteredMessages.slice(idx + 1).every(m => m.role !== 'assistant');
            inlineToolsHtml = renderInlineToolBlocks(toolsDetailed, isLastAssistantMsg);
            toolsText = (msg.tools || []).join(', ');
        }

        if (msg.content && msg.content.trim()) {
            if (role === 'user') {
                // Check for task notifications first (only at start of message)
                const parsed = msg.content.includes('<task-notification>') ? parseTaskNotifications(msg.content) : null;
                if (parsed) {
                    displayContent = parsed;
                } else {
                    // User messages: escape HTML with expand toggle for long content
                    const escapedContent = escapeHtml(msg.content);
                    if (msg.content.length > 300) {
                        const msgId = `user-msg-${idx}`;
                        displayContent = `<div class="user-message-expandable">
                            <div class="user-message-preview" id="${msgId}-preview">${escapedContent.slice(0, 300)}...</div>
                            <div class="user-message-full hidden" id="${msgId}-full">${escapedContent.replace(/\n/g, '<br>')}</div>
                            <button class="user-message-toggle" onclick="toggleUserMessage('${msgId}')">Show more</button>
                        </div>`;
                    } else {
                        displayContent = escapedContent;
                    }
                }
            } else {
                // Assistant/system messages: full markdown rendering
                displayContent = renderMarkdown(msg.content);
            }
        } else if (toolsDetailed.length > 0) {
            // Tool-only message - tools are already in inlineToolsHtml
            isToolOnly = true;
        } else if (msg.tools && msg.tools.length > 0) {
            // Fallback for messages without detailed tools
            isToolOnly = true;
            toolsText = msg.tools.join(', ');
            const formattedTools = msg.tools.map(tool => {
                const match = tool.match(/^(\w+)(.*)/);
                if (match) {
                    const toolName = match[1];
                    const rest = match[2] || '';
                    return `<span class="mc-tool-item"><span class="mc-tool-name">${toolName}</span><span class="mc-tool-detail">${escapeHtml(rest)}</span></span>`;
                }
                return `<span class="mc-tool-item">${escapeHtml(tool)}</span>`;
            }).join('');
            displayContent = `<div class="mc-tools">${formattedTools}</div>`;
        }

        // Store raw content for copy (include tools if tool-only message)
        const copyContent = msg.content || toolsText;
        const rawContent = copyContent.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        const lineNumber = msg.lineNumber !== undefined ? msg.lineNumber : -1;
        const tokens = msg.tokens || 0;
        const tokenDisplay = formatTokenCount(tokens);
        const toolOnlyClass = isToolOnly ? ' tool-only' : '';

        return `
            <div class="mc-message ${roleClass}${toolOnlyClass}" data-idx="${idx}" data-line="${lineNumber}">
                <div class="mc-message-header">
                    <span class="mc-message-role">${roleLabel}</span>
                    <span class="mc-message-time">${timestamp}</span>
                    <button class="mc-copy-btn" onclick="copyMessageContent(this)" data-content="${rawContent}" title="Copy to clipboard">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                    ${lineNumber >= 0 ? `<button class="mc-delete-btn" onclick="handleDeleteClick(this)" data-line="${lineNumber}" data-role="${role}" title="Delete message">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>` : ''}
                    ${tokenDisplay ? `<span class="mc-message-tokens" title="${tokens} tokens">${tokenDisplay} tokens</span>` : ''}
                </div>
                <div class="mc-message-content">${displayContent}</div>
                ${inlineToolsHtml}
            </div>
        `;
    }).join('');

    streamEl.innerHTML = html;

    // Restore expanded tool states
    if (expandedTools.size > 0) {
        streamEl.querySelectorAll('.mc-message').forEach(msgEl => {
            const msgIdx = msgEl.dataset.idx;
            msgEl.querySelectorAll('.mc-inline-tool').forEach(toolEl => {
                const toolIdx = toolEl.dataset.toolIdx;
                if (msgIdx !== undefined && toolIdx !== undefined && expandedTools.has(`${msgIdx}-${toolIdx}`)) {
                    // Restore expanded state
                    toolEl.classList.add('expanded');
                    const details = toolEl.querySelector('.mc-inline-tool-details');
                    const icon = toolEl.querySelector('.tool-expand-icon');
                    if (details) details.classList.remove('hidden');
                    if (icon) icon.textContent = '▼';
                }
            });
        });
    }

    // Auto-scroll to bottom if auto-scroll is enabled
    if (mcStickyScroll && filteredMessages.length > 0) {
        mcStickyScroll.scrollToBottom();
    }
}

/**
 * Clear Mission Control conversation view
 */
function clearMissionControlConversation() {
    const streamEl = document.getElementById('mc-conversation-stream');
    const labelEl = document.getElementById('mc-selected-session');

    if (streamEl) {
        streamEl.innerHTML = '<div class="mc-empty">Select a session to view conversation</div>';
    }
    if (labelEl) {
        labelEl.textContent = 'Select a session';
    }

    // Hide message input
    hideMCInput();
}

/**
 * Connect Mission Control conversation view to a process WebSocket for real-time updates
 * @param {string} processId - The process ID to connect to
 */
function connectMissionControlToProcess(processId) {
    // Close existing connection if any
    if (mcProcessWebSocket) {
        mcProcessWebSocket.close();
        mcProcessWebSocket = null;
    }

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/process/${processId}`;
    console.log(`[MC-WS] Connecting conversation view to process ${processId}`);

    mcProcessWebSocket = new WebSocket(wsUrl);

    mcProcessWebSocket.onopen = () => {
        console.log(`[MC-WS] Connected to process ${processId} for real-time updates`);
    };

    mcProcessWebSocket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleMissionControlProcessMessage(msg);
        } catch (e) {
            console.warn('[MC-WS] Failed to parse message:', e);
        }
    };

    mcProcessWebSocket.onerror = (e) => {
        console.warn('[MC-WS] WebSocket error:', e);
    };

    mcProcessWebSocket.onclose = () => {
        console.log('[MC-WS] WebSocket closed');
        mcProcessWebSocket = null;
    };
}

/**
 * Disconnect Mission Control process WebSocket
 */
function disconnectMissionControlProcess() {
    if (mcProcessWebSocket) {
        mcProcessWebSocket.close();
        mcProcessWebSocket = null;
    }
}

/**
 * Handle incoming WebSocket messages for Mission Control conversation view
 * @param {Object} msg - The parsed WebSocket message
 */
function handleMissionControlProcessMessage(msg) {
    if (!mcSelectedSessionId) return;

    switch (msg.type) {
        case 'message':
            // Structured assistant message - append to conversation
            appendToMissionControlConversation({
                role: 'assistant',
                content: msg.content || msg.text || '',
                timestamp: new Date().toISOString(),
                tools: msg.tools || [],
                toolsDetailed: msg.toolsDetailed || []
            });
            break;

        case 'tool_use':
            // Tool being invoked - could show as activity indicator
            // For now, we'll let the next full message include the tool
            console.log('[MC-WS] Tool use:', msg.name);
            break;

        case 'tool_result':
            // Tool completed - the result will be in the next message
            console.log('[MC-WS] Tool result:', msg.tool_use_id, msg.is_error ? 'error' : 'success');
            break;

        case 'output':
            // Streaming text output - append to streaming element
            if (msg.data) {
                appendStreamingTextToConversation(msg.data);
            }
            break;

        case 'result':
            // Final result with usage stats - conversation complete
            console.log('[MC-WS] Result received, refreshing conversation');
            // Clear streaming element and do a full refresh to get final state
            clearStreamingText();
            if (mcSelectedSessionId) {
                loadConversationHistory(mcSelectedSessionId, true);
            }
            break;

        case 'state':
            // Process state changed - might need to update UI
            if (msg.state === 'stopped') {
                disconnectMissionControlProcess();
            }
            break;
    }
}

/**
 * Append a new message to the Mission Control conversation view
 * @param {Object} msg - Message object with role, content, timestamp, etc.
 */
function appendToMissionControlConversation(msg) {
    const streamEl = document.getElementById('mc-conversation-stream');
    if (!streamEl) return;

    // Clear any streaming text first
    clearStreamingText();

    // Remove "no conversation" placeholder if present
    const emptyEl = streamEl.querySelector('.mc-empty');
    if (emptyEl) {
        emptyEl.remove();
    }

    // Create message element
    const role = msg.role || 'assistant';
    const roleClass = role === 'user' ? 'human' : role === 'system' ? 'system' : 'assistant';
    const roleLabel = role === 'user' ? `${icon('user', {size:14})} You` : role === 'system' ? `${icon('clipboard-list', {size:14})} System` : `${icon('bot', {size:14})} Assistant`;
    const timestamp = msg.timestamp ? formatTimeAgo(new Date(msg.timestamp)) : '';

    let displayContent = '';
    if (msg.content && msg.content.trim()) {
        displayContent = role === 'user' ? escapeHtml(msg.content) : renderMarkdown(msg.content);
    }

    // Render inline tools if present
    let inlineToolsHtml = '';
    if (msg.toolsDetailed && msg.toolsDetailed.length > 0) {
        inlineToolsHtml = renderInlineToolBlocks(msg.toolsDetailed, true);
    }

    const idx = streamEl.querySelectorAll('.mc-message').length;
    const messageHtml = `
        <div class="mc-message ${roleClass} mc-live-message" data-idx="${idx}">
            <div class="mc-message-header">
                <span class="mc-message-role">${roleLabel}</span>
                <span class="mc-message-time">${timestamp}</span>
                <span class="mc-live-indicator" title="Live update">●</span>
            </div>
            <div class="mc-message-content">${displayContent}</div>
            ${inlineToolsHtml}
        </div>
    `;

    streamEl.insertAdjacentHTML('beforeend', messageHtml);

    // Auto-scroll to bottom
    if (mcStickyScroll) {
        mcStickyScroll.scrollToBottom();
    }

    // Update cache
    const cached = mcConversationCache.get(mcSelectedSessionId) || [];
    cached.push(msg);
    mcConversationCache.set(mcSelectedSessionId, cached);
    mcLastMessageCount = cached.length;
}

/**
 * Append streaming text to a dedicated streaming element in the conversation
 * @param {string} text - Text chunk to append
 */
function appendStreamingTextToConversation(text) {
    const streamEl = document.getElementById('mc-conversation-stream');
    if (!streamEl) return;

    // Find or create streaming element for current assistant message
    let streamingEl = streamEl.querySelector('.mc-streaming-text');
    if (!streamingEl) {
        // Remove "no conversation" placeholder if present
        const emptyEl = streamEl.querySelector('.mc-empty');
        if (emptyEl) {
            emptyEl.remove();
        }

        streamingEl = document.createElement('div');
        streamingEl.className = 'mc-message assistant mc-streaming-text';
        streamingEl.innerHTML = `
            <div class="mc-message-header">
                <span class="mc-message-role">${icon('bot', {size:14})} Assistant</span>
                <span class="mc-message-time">now</span>
                <span class="mc-live-indicator streaming" title="Streaming">●</span>
            </div>
            <div class="mc-message-content mc-streaming-content"></div>
        `;
        streamEl.appendChild(streamingEl);
    }

    const contentEl = streamingEl.querySelector('.mc-streaming-content');
    if (contentEl) {
        contentEl.textContent += text;
    }

    // Auto-scroll to bottom
    if (mcStickyScroll) {
        mcStickyScroll.scrollToBottom();
    }
}

/**
 * Clear the streaming text element
 */
function clearStreamingText() {
    const streamEl = document.getElementById('mc-conversation-stream');
    if (!streamEl) return;

    const streamingEl = streamEl.querySelector('.mc-streaming-text');
    if (streamingEl) {
        streamingEl.remove();
    }
}

/**
 * Find a managed process that matches a detected session by cwd
 * @param {Object} session - The detected session
 * @returns {string|null} - The process ID if found, null otherwise
 */
function findMatchingManagedProcess(session) {
    if (!session || !session.cwd) return null;

    for (const [processId, process] of managedProcesses) {
        if (process.cwd === session.cwd && process.state !== 'stopped') {
            return processId;
        }
    }
    return null;
}

/**
 * Kill the currently selected Mission Control session (detected or managed)
 */
async function killSelectedMcSession() {
    // Check for managed process first
    if (selectedProcessId) {
        await killSelectedProcess();
        return;
    }

    // Otherwise kill detected session
    if (mcSelectedSessionPid) {
        await killSession(mcSelectedSessionPid, mcSelectedSessionSlug);
    } else {
        showToast('No session selected or no PID available', 'error');
    }
}

// Initialize Mission Control on DOM ready
document.addEventListener('DOMContentLoaded', initMissionControl);


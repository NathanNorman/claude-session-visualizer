// ============================================================================
// Process Management - Spawn and control Claude sessions from Mission Control
// ============================================================================

// Track managed processes (spawned from MC)
let managedProcesses = new Map(); // processId -> { ws, state, cwd }
let selectedProcessId = null; // Currently selected managed process
let processOutputStickyScroll = null;

/**
 * Show the spawn session modal
 */
async function showSpawnModal() {
    const modal = document.getElementById('spawn-modal');
    const directoryInput = document.getElementById('spawn-directory');

    if (modal) {
        modal.classList.remove('hidden');
        if (directoryInput) {
            directoryInput.value = '';
            directoryInput.focus();
        }
        await loadRecentDirectories();
    }
}

/**
 * Hide the spawn session modal
 */
function hideSpawnModal() {
    const modal = document.getElementById('spawn-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

/**
 * Load recent directories for quick selection
 */
async function loadRecentDirectories() {
    const listEl = document.getElementById('spawn-recent-list');
    if (!listEl) return;

    listEl.innerHTML = '<div class="spawn-loading">Loading recent directories...</div>';

    try {
        const response = await fetch('/api/recent-directories');
        if (!response.ok) throw new Error('Failed to load directories');

        const data = await response.json();
        const directories = data.directories || [];

        if (directories.length === 0) {
            listEl.innerHTML = '<div class="spawn-loading">No recent directories found</div>';
            return;
        }

        listEl.innerHTML = directories.map((dir, idx) => `
            <div class="spawn-recent-item" data-path-idx="${idx}" data-path="${escapeHtml(dir.path)}">
                <span class="dir-icon">${icon('folder', {size:14})}</span>
                <div class="dir-info">
                    <div class="dir-name">${escapeHtml(dir.name)}</div>
                    <div class="dir-path">${escapeHtml(dir.path)}</div>
                </div>
            </div>
        `).join('');

        // Attach click handlers to each item
        listEl.querySelectorAll('.spawn-recent-item').forEach((item, idx) => {
            item.addEventListener('click', () => {
                const path = directories[idx]?.path;
                if (path) {
                    selectSpawnDirectory(path);
                }
            });
        });
    } catch (error) {
        console.error('Failed to load recent directories:', error);
        listEl.innerHTML = '<div class="spawn-loading">Failed to load directories</div>';
    }
}

/**
 * Select a directory from the recent list
 */
function selectSpawnDirectory(path) {
    const input = document.getElementById('spawn-directory');
    if (input) {
        input.value = path;
        input.focus();
    }
}

/**
 * Open web-based directory browser modal
 */
async function browseForFolder() {
    // Get current input value as starting path, or default to home
    const input = document.getElementById('spawn-directory');
    const startPath = input?.value?.trim() || null;

    showDirectoryBrowser(startPath);
}

/**
 * Show the web-based directory browser modal
 */
async function showDirectoryBrowser(startPath = null) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('directory-browser-modal');
    if (!modal) {
        modal = createDirectoryBrowserModal();
        document.body.appendChild(modal);
    }

    // Show modal
    modal.classList.remove('hidden');

    // Load initial directory
    await loadDirectoryContents(startPath);
}

/**
 * Create the directory browser modal element
 */
function createDirectoryBrowserModal() {
    const modal = document.createElement('div');
    modal.id = 'directory-browser-modal';
    modal.className = 'directory-browser-modal hidden';

    modal.innerHTML = `
        <div class="directory-browser-content">
            <div class="directory-browser-header">
                <h3>Select Directory</h3>
                <button class="directory-browser-close" onclick="closeDirectoryBrowser()">×</button>
            </div>
            <div class="directory-browser-path">
                <button class="directory-browser-up" onclick="navigateToParent()" title="Go to parent directory">
                    ⬆️
                </button>
                <input type="text" id="directory-browser-path-input"
                       placeholder="/path/to/directory"
                       onkeydown="if(event.key==='Enter') navigateToPath(this.value)">
            </div>
            <div class="directory-browser-body">
                <div id="directory-browser-list" class="directory-list">
                    <div class="directory-loading">Loading...</div>
                </div>
            </div>
            <div class="directory-browser-footer">
                <button class="btn btn-secondary" onclick="closeDirectoryBrowser()">Cancel</button>
                <button class="btn btn-primary" onclick="selectCurrentDirectory()">Select This Folder</button>
            </div>
        </div>
    `;

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeDirectoryBrowser();
        }
    });

    // Close on Escape key
    modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDirectoryBrowser();
        }
    });

    return modal;
}

// Store current directory state
let currentBrowserPath = null;
let currentBrowserParent = null;

/**
 * Load and display directory contents
 */
async function loadDirectoryContents(path = null) {
    const listContainer = document.getElementById('directory-browser-list');
    const pathInput = document.getElementById('directory-browser-path-input');
    const upButton = document.querySelector('.directory-browser-up');

    // Show loading state
    if (listContainer) {
        listContainer.innerHTML = '<div class="directory-loading">Loading...</div>';
    }

    try {
        const url = path ? `/api/list-directory?path=${encodeURIComponent(path)}` : '/api/list-directory';
        const response = await fetch(url);

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to load directory');
        }

        const data = await response.json();

        // Update state
        currentBrowserPath = data.current;
        currentBrowserParent = data.parent;

        // Update path input
        if (pathInput) {
            pathInput.value = data.current;
        }

        // Enable/disable up button
        if (upButton) {
            upButton.disabled = !data.parent;
            upButton.style.opacity = data.parent ? '1' : '0.5';
        }

        // Render directory list
        renderDirectoryList(data.directories);

    } catch (error) {
        console.error('Failed to load directory:', error);
        if (listContainer) {
            listContainer.innerHTML = `
                <div class="directory-error">
                    <span>${icon('alert-triangle', {size:14})} ${error.message}</span>
                    <button class="btn btn-small" onclick="loadDirectoryContents()">Go Home</button>
                </div>
            `;
        }
    }
}

/**
 * Render the list of directories
 */
function renderDirectoryList(directories) {
    const listContainer = document.getElementById('directory-browser-list');
    if (!listContainer) return;

    if (directories.length === 0) {
        listContainer.innerHTML = '<div class="directory-empty">No subdirectories</div>';
        return;
    }

    const html = directories.map(dir => {
        const accessibleClass = dir.accessible ? '' : 'inaccessible';
        const dirIcon = dir.accessible ? icon('folder', {size:14}) : icon('lock', {size:14});
        const clickHandler = dir.accessible ? `onclick="navigateToDirectory('${dir.path.replace(/'/g, "\\'")}')"` : '';

        return `
            <div class="directory-item ${accessibleClass}" ${clickHandler}>
                <span class="directory-icon">${dirIcon}</span>
                <span class="directory-name">${escapeHtml(dir.name)}</span>
            </div>
        `;
    }).join('');

    listContainer.innerHTML = html;
}

/**
 * Navigate to a specific directory
 */
async function navigateToDirectory(path) {
    await loadDirectoryContents(path);
}

/**
 * Navigate to parent directory
 */
async function navigateToParent() {
    if (currentBrowserParent) {
        await loadDirectoryContents(currentBrowserParent);
    }
}

/**
 * Navigate to a path entered in the input
 */
async function navigateToPath(path) {
    if (path?.trim()) {
        await loadDirectoryContents(path.trim());
    }
}

/**
 * Select the current directory and close browser
 */
function selectCurrentDirectory() {
    if (currentBrowserPath) {
        selectSpawnDirectory(currentBrowserPath);
    }
    closeDirectoryBrowser();
}

/**
 * Close the directory browser modal
 */
function closeDirectoryBrowser() {
    const modal = document.getElementById('directory-browser-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

/**
 * Spawn a new Claude session
 */
async function spawnSession() {
    const input = document.getElementById('spawn-directory');
    const cwd = input?.value?.trim();

    if (!cwd) {
        showToast('Please enter a directory path', 'error');
        return;
    }

    try {
        const response = await fetch('/api/spawn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const processId = data.process_id;

        // Check if this is an SDK session
        let isSDK = false;
        try {
            const sdkModeResponse = await fetch('/api/sdk-mode');
            const sdkMode = await sdkModeResponse.json();
            isSDK = sdkMode.mode === 'sdk';
        } catch (e) {
            console.warn('Could not detect SDK mode:', e);
        }

        // Build initial placeholder banner
        const dirName = data.cwd.split('/').pop() || data.cwd;
        const placeholderBanner = `<div class="sdk-welcome-banner sdk-placeholder">
<div class="sdk-banner-info">
<div class="sdk-banner-title">Claude Code SDK Session</div>
<div class="sdk-banner-cwd">${escapeHtml(data.cwd)}</div>
</div>
</div>
<div class="sdk-ready-message">Send a message to start</div>`;

        // Track the managed process with SDK flag
        managedProcesses.set(processId, {
            id: processId,
            cwd: data.cwd,
            state: data.state,
            isSDK: isSDK,
            ws: null,
            outputBuffer: isSDK ? placeholderBanner : '', // Show placeholder for SDK sessions
            startedAt: data.started_at || new Date().toISOString()
        });

        hideSpawnModal();
        showToast(`Spawned ${isSDK ? 'SDK' : 'PTY'} session in ${data.cwd}`, 'success');

        // Connect to process output stream
        connectToProcess(processId);

        // Refresh the session list (managed processes first, then render)
        await refreshManagedProcessList();
        refreshMissionControl();

        // Auto-select the newly spawned process
        selectManagedProcess(processId);

    } catch (error) {
        console.error('Failed to spawn session:', error);
        showToast(`Failed to spawn: ${error.message}`, 'error');
    }
}

/**
 * Connect to a managed process WebSocket for output streaming
 */
function connectToProcess(processId) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    // Close existing connection if any
    if (process.ws) {
        process.ws.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/process/${processId}`);

    ws.onopen = () => {
        console.log(`[Process ${processId}] WebSocket connected`);
        process.state = 'running';
        updateProcessUI(processId);
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleProcessMessage(processId, msg);
        } catch (e) {
            console.error('Failed to parse process message:', e);
        }
    };

    ws.onclose = () => {
        console.log(`[Process ${processId}] WebSocket closed`);
        process.ws = null;
    };

    ws.onerror = (error) => {
        console.error(`[Process ${processId}] WebSocket error:`, error);
    };

    process.ws = ws;
}

/**
 * Handle incoming process WebSocket message
 */
function handleProcessMessage(processId, msg) {
    Logger.debug('mc', 'handleProcessMessage:', { processId, type: msg.type, hasData: !!msg.data, dataLen: msg.data?.length });

    const process = managedProcesses.get(processId);
    if (!process) return;

    // Track activity for idle timer display
    process.lastActivity = Date.now();

    switch (msg.type) {
        case 'output':
            // Always store in buffer, display if selected
            process.outputBuffer = (process.outputBuffer || '') + msg.data;
            if (selectedProcessId === processId) {
                appendTerminalOutputDirect(msg.data);
            }
            break;

        case 'history':
            // Received buffered history on connect - replace buffer
            // Handle both PTY format (lines array) and SDK format (content string)
            let historyContent = '';
            if (Array.isArray(msg.lines)) {
                historyContent = msg.lines.join('');
            } else if (msg.content) {
                historyContent = msg.content;
            }
            if (historyContent) {
                process.outputBuffer = historyContent;
                if (selectedProcessId === processId) {
                    // SDK sessions store pre-formatted HTML
                    if (process.isSDK) {
                        setTerminalHtml(historyContent);
                    } else {
                        setTerminalOutputDirect(historyContent);
                    }
                }
            }
            break;

        case 'state':
            process.state = msg.state;
            if (msg.exit_code !== undefined && msg.exit_code !== null) {
                process.exitCode = msg.exit_code;
            }
            updateProcessUI(processId);
            if (msg.state === 'stopped') {
                showToast(`Process stopped (exit ${msg.exit_code || 0})`, 'info');
            }
            break;

        case 'error':
            showToast(`Process error: ${msg.message}`, 'error');
            break;

        case 'message':
            // SDK: Structured message from Claude
            appendStructuredMessage(processId, msg);
            break;

        case 'tool_use':
            // SDK: Tool being invoked
            appendToolUseBlock(processId, msg);
            break;

        case 'tool_result':
            // SDK: Tool execution completed
            updateToolUseBlock(msg.tool_use_id, msg.is_error ? 'failed' : 'completed', msg.output);
            break;

        case 'tool_approval':
            // SDK: Tool requires user approval
            // Check if this is an edit tool that should show diff UI
            if (isEditTool(msg.name)) {
                showEditApprovalUI(processId, msg);
            } else {
                showToolApprovalUI(processId, msg);
            }
            break;

        case 'user_choice':
            // SDK: Claude is asking user to choose from options
            showUserChoiceUI(processId, msg);
            break;

        case 'result':
            // SDK: Final result from Claude with usage stats
            Logger.debug('mc', 'SDK result:', msg);
            {
                const proc = managedProcesses.get(processId);
                if (proc) {
                    // Extract usage from either msg.usage or top-level fields
                    const usage = msg.usage || msg;
                    proc.inputTokens = usage.input_tokens || proc.inputTokens || 0;
                    proc.outputTokens = usage.output_tokens || proc.outputTokens || 0;
                    proc.totalCostUsd = usage.total_cost_usd || msg.cost_usd || proc.totalCostUsd || 0;
                    // Context tokens = total tokens used in the session
                    proc.contextTokens = proc.inputTokens + proc.outputTokens +
                        (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
                    Logger.debug('mc', 'Updated usage:', { input: proc.inputTokens, output: proc.outputTokens, context: proc.contextTokens });

                    // Update context indicator if this process is selected
                    if (selectedProcessId === processId) {
                        updateContextIndicator(proc.contextTokens, MAX_CONTEXT_TOKENS);
                    }
                    // Re-render session list to show updated context %
                    refreshMissionControl();
                }
            }
            break;

        case 'system':
            // SDK: System message (init, session info)
            Logger.debug('mc', 'SDK system:', msg.subtype, msg.data);
            if (msg.subtype === 'init') {
                showSDKWelcomeBanner(processId, msg);
            }
            break;

        case 'heartbeat':
            // Reset stale detection timer
            {
                const hbProc = managedProcesses.get(processId);
                if (hbProc) {
                    hbProc.lastHeartbeat = Date.now();
                }
            }
            break;

        case 'process_exited':
            // Process died - update state
            {
                const exitProc = managedProcesses.get(processId);
                if (exitProc) {
                    exitProc.state = 'stopped';
                    exitProc.exitCode = msg.exit_code;
                    updateProcessUI(processId);
                    showToast(`Process exited (code ${msg.exit_code || 0})`, 'info');
                }
            }
            break;
    }
}

/**
 * Set terminal output content directly (no processId check)
 */
function setTerminalOutputDirect(content) {
    const terminalEl = document.getElementById('mc-terminal-output');
    const contentEl = terminalEl?.querySelector('.mc-terminal-content');

    if (contentEl) {
        contentEl.innerHTML = parseAnsiToHtml(content);

        // Initialize sticky scroll if needed
        if (!processOutputStickyScroll && terminalEl) {
            processOutputStickyScroll = new StickyScroll(terminalEl, { showIndicator: true });
            processOutputStickyScroll.attach();
        }
        processOutputStickyScroll?.scrollToBottom();
    }
}

/**
 * Append content to terminal output directly (no processId check)
 * For raw terminal output - parses ANSI codes
 */
function appendTerminalOutputDirect(content) {
    Logger.debug('mc', 'appendTerminalOutputDirect:', { contentLen: content?.length, contentPreview: content?.substring(0, 100) });

    const terminalEl = document.getElementById('mc-terminal-output');
    const contentEl = terminalEl?.querySelector('.mc-terminal-content');

    if (contentEl) {
        contentEl.innerHTML += parseAnsiToHtml(content);
        processOutputStickyScroll?.scrollToBottom();
    }
}

/**
 * Append pre-formatted HTML to terminal output directly
 * For SDK messages that already contain HTML - does NOT escape
 */
function appendTerminalHtml(html) {
    Logger.debug('mc', 'appendTerminalHtml:', { htmlLen: html?.length });

    const contentEl = _getSDKTarget();
    if (contentEl) {
        contentEl.innerHTML += html;
        contentEl.scrollTop = contentEl.scrollHeight;
    }
}

/** Get the correct content target — mc-conversation-stream for SDK, mc-terminal-content for PTY */
function _getSDKTarget() {
    const proc = selectedProcessId ? managedProcesses.get(selectedProcessId) : null;
    if (proc?.isSDK) {
        return document.getElementById('mc-conversation-stream');
    }
    const terminalEl = document.getElementById('mc-terminal-output');
    return terminalEl?.querySelector('.mc-terminal-content');
}

/**
 * Set terminal content with pre-formatted HTML (no ANSI parsing)
 * For SDK sessions that store HTML in their buffer
 */
function setTerminalHtml(html) {
    const contentEl = _getSDKTarget();
    if (contentEl) {
        contentEl.innerHTML = html;
        contentEl.scrollTop = contentEl.scrollHeight;
    }
}

/**
 * Display buffered output for a process (called when selecting)
 */
function displayProcessBuffer(processId) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    Logger.debug('mc', 'displayProcessBuffer:', { processId, bufferLen: process.outputBuffer?.length, isSDK: process.isSDK });

    if (process.outputBuffer) {
        // SDK sessions store pre-formatted HTML, PTY sessions store raw ANSI
        if (process.isSDK) {
            setTerminalHtml(process.outputBuffer);
        } else {
            setTerminalOutputDirect(process.outputBuffer);
        }
    }
}

/**
 * Parse ANSI escape codes to HTML
 */
function parseAnsiToHtml(text) {
    if (!text) return '';

    // First, strip ALL non-color ANSI escape sequences (cursor movement, screen control, etc.)
    // These include: cursor movement (A,B,C,D,E,F,G,H,J,K), scroll (S,T), cursor save/restore, etc.
    // Also handle private mode sequences like [?2026l and [?2026h
    text = text
        // Standard escape sequences: ESC [ ... <letter>
        .replace(/\x1b\[\??[0-9;]*[ABCDEFGHJKSTfnsu]/g, '')
        // OSC sequences (Operating System Command): ESC ] ... BEL or ESC ] ... ESC \
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // Other escape sequences we don't handle
        .replace(/\x1b\[\?[0-9;]*[hl]/g, '')  // Private mode set/reset like [?2026l
        // Raw escape codes that lost their ESC character (showing as literal [ sequences)
        .replace(/\[\?[0-9]+[hl]/g, '')  // [?2026l, [?2026h
        .replace(/\[[0-9]+[ABCDEFGJKST]/g, '')  // [2C, [4A, [1B, etc.
        .replace(/\[[0-9]*[HJKfnsu]/g, '');  // [H, [2J, etc.

    // ANSI color code mapping
    const ansiColors = {
        '30': 'ansi-black', '31': 'ansi-red', '32': 'ansi-green', '33': 'ansi-yellow',
        '34': 'ansi-blue', '35': 'ansi-magenta', '36': 'ansi-cyan', '37': 'ansi-white',
        '90': 'ansi-bright-black', '91': 'ansi-bright-red', '92': 'ansi-bright-green',
        '93': 'ansi-bright-yellow', '94': 'ansi-bright-blue', '95': 'ansi-bright-magenta',
        '96': 'ansi-bright-cyan', '97': 'ansi-bright-white'
    };

    const ansiStyles = {
        '1': 'ansi-bold', '2': 'ansi-dim', '3': 'ansi-italic', '4': 'ansi-underline'
    };

    let result = '';
    let currentClasses = [];

    // Escape HTML first
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Parse color ANSI sequences (ending in 'm')
    const ansiRegex = /\x1b\[([0-9;]*)m/g;
    let lastIndex = 0;
    let match;

    while ((match = ansiRegex.exec(text)) !== null) {
        // Add text before this escape sequence
        if (match.index > lastIndex) {
            const segment = text.slice(lastIndex, match.index);
            if (currentClasses.length > 0) {
                result += `<span class="${currentClasses.join(' ')}">${segment}</span>`;
            } else {
                result += segment;
            }
        }

        // Process the escape sequence
        const codes = match[1].split(';');
        for (const code of codes) {
            if (code === '0' || code === '') {
                // Reset
                currentClasses = [];
            } else if (ansiColors[code]) {
                // Remove existing color class
                currentClasses = currentClasses.filter(c => !c.startsWith('ansi-') || c.includes('bold') || c.includes('dim') || c.includes('italic') || c.includes('underline'));
                currentClasses.push(ansiColors[code]);
            } else if (ansiStyles[code]) {
                currentClasses.push(ansiStyles[code]);
            }
        }

        lastIndex = ansiRegex.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
        const segment = text.slice(lastIndex);
        if (currentClasses.length > 0) {
            result += `<span class="${currentClasses.join(' ')}">${segment}</span>`;
        } else {
            result += segment;
        }
    }

    return result;
}

// ============================================================================
// SDK Message Handlers (claude-agent-sdk)
// ============================================================================

/**
 * Configure marked.js for Claude-like rendering
 */
function initMarkdownRenderer() {
    if (typeof marked === 'undefined') {
        console.warn('marked.js not loaded, using fallback renderer');
        return;
    }

    // Configure marked with highlight.js
    marked.setOptions({
        highlight: function(code, lang) {
            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                try {
                    return hljs.highlight(code, { language: lang }).value;
                } catch (e) {}
            }
            // Fallback to auto-detection
            if (typeof hljs !== 'undefined') {
                try {
                    return hljs.highlightAuto(code).value;
                } catch (e) {}
            }
            return code;
        },
        breaks: true,
        gfm: true,
    });
}

// Initialize when DOM loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMarkdownRenderer);
} else {
    initMarkdownRenderer();
}

/**
 * Render markdown content to HTML with syntax highlighting
 */
function renderMarkdown(content) {
    if (typeof marked === 'undefined') {
        // Fallback: basic escaping with some formatting
        return escapeHtml(content)
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
            .replace(/\n/g, '<br>');
    }

    // Use marked for full markdown rendering
    let html = marked.parse(content);

    // Post-process: apply syntax highlighting to any missed code blocks
    if (typeof hljs !== 'undefined') {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        tempDiv.querySelectorAll('pre code:not(.hljs)').forEach(block => {
            hljs.highlightElement(block);
        });
        html = tempDiv.innerHTML;
    }

    return html;
}

/**
 * Append a structured message from the SDK to the terminal
 */
function appendStructuredMessage(processId, msg) {
    console.log('[SDK-MSG] appendStructuredMessage called:', { processId, role: msg.role, selectedProcessId, match: selectedProcessId === processId });

    const process = managedProcesses.get(processId);
    if (!process) {
        console.warn('[SDK-MSG] Process not found in managedProcesses:', processId);
        return;
    }

    // When a new assistant message arrives, mark any running tools as completed
    // This indicates the tool has finished and Claude is continuing
    if (msg.role === 'assistant') {
        completeRunningTools();
    }

    const isUser = msg.role === 'user';
    const mcRoleClass = isUser ? 'human' : 'assistant';
    const roleLabel = isUser ? `${icon('user', {size:14})} You` : `${icon('bot', {size:14})} Assistant`;

    // Render markdown for assistant messages, escape for user messages
    const renderedContent = isUser
        ? `<p>${escapeHtml(msg.content)}</p>`
        : renderMarkdown(msg.content);

    // Store raw content for copy (escape quotes for data attribute)
    const rawContent = (msg.content || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Build message HTML matching regular session mc-message structure
    const html = `<div class="mc-message ${mcRoleClass}">
        <div class="mc-message-header">
            <span class="mc-message-role">${roleLabel}</span>
            <span class="mc-message-time">just now</span>
            <button class="mc-copy-btn" onclick="copyMessageContent(this)" data-content="${rawContent}" title="Copy to clipboard"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
        </div>
        <div class="mc-message-content">${renderedContent}</div>
    </div>`;

    if (!isUser) {
        // Replace loading wrapper with the response (atomic swap, no visual gap)
        const loadingWrapperRegex = /<div class="sdk-loading-wrapper"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g;
        if (process.outputBuffer?.match(loadingWrapperRegex)) {
            process.outputBuffer = process.outputBuffer.replace(loadingWrapperRegex, html);
        } else {
            process.outputBuffer = (process.outputBuffer || '') + html;
        }

        if (selectedProcessId === processId) {
            const wrapper = document.getElementById(`sdk-loading-wrapper-${processId}`);
            if (wrapper) {
                wrapper.insertAdjacentHTML('afterend', html);
                wrapper.remove();
            } else {
                appendTerminalHtml(html);
            }
        }
    } else {
        process.outputBuffer = (process.outputBuffer || '') + html;

        if (selectedProcessId === processId) {
            appendTerminalHtml(html);
            showSDKLoadingIndicator(processId);
        }
    }
}

/**
 * Show loading indicator while waiting for Claude response
 */
function showSDKLoadingIndicator(processId) {
    const process = managedProcesses.get(processId);
    const loadingHtml = `<div class="sdk-loading-wrapper" id="sdk-loading-wrapper-${processId}"><div class="sdk-loading" id="sdk-loading-${processId}"><div class="sdk-loading-dots"><span></span><span></span><span></span></div><span>Claude is thinking...</span></div></div>`;

    // Add to buffer so it survives re-renders (e.g. system/init banner)
    if (process) {
        // Remove any existing loading wrapper from buffer first
        process.outputBuffer = (process.outputBuffer || '').replace(
            /<div class="sdk-loading-wrapper"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g, ''
        );
        process.outputBuffer += loadingHtml;
    }

    // Also update DOM directly — remove existing wrapper first
    const existing = document.getElementById(`sdk-loading-wrapper-${processId}`);
    if (existing) existing.remove();
    appendTerminalHtml(loadingHtml);
}

/**
 * Remove loading indicator when response arrives
 */
function removeSDKLoadingIndicator(processId) {
    // Remove wrapper from DOM (single element, no sibling navigation needed)
    const wrapper = document.getElementById(`sdk-loading-wrapper-${processId}`);
    if (wrapper) wrapper.remove();

    // Remove from buffer so it doesn't reappear on re-render
    const process = managedProcesses.get(processId);
    if (process) {
        process.outputBuffer = (process.outputBuffer || '').replace(
            /<div class="sdk-loading-wrapper"[^>]*>[\s\S]*?<\/div>\s*<\/div>/g, ''
        );
    }
}

/**
 * Show SDK session welcome banner when init message received
 */
function showSDKWelcomeBanner(processId, msg) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    // Extract info from init message - data is nested under msg.data
    const data = msg.data || msg;
    const cwd = data.cwd || process.cwd;
    const claudeSessionId = data.session_id || null;
    const toolCount = data.tools?.length || 0;
    const model = data.model || 'Claude';

    // Auto-save session for resume capability (Phase 4)
    if (claudeSessionId) {
        autoSaveSession(processId, claudeSessionId);
    }

    // Build clean banner
    const bannerHtml = `<div class="sdk-welcome-banner">
<div class="sdk-banner-info">
<div class="sdk-banner-title">Claude Code SDK Session</div>
<div class="sdk-banner-model">${escapeHtml(model)} · ${toolCount} tools</div>
<div class="sdk-banner-cwd">${escapeHtml(cwd)}</div>
</div>
</div>`;

    // Replace placeholder banner if present, otherwise prepend
    if (process.outputBuffer?.includes('sdk-placeholder')) {
        // Remove placeholder banner and ready message
        process.outputBuffer = process.outputBuffer
            .replace(/<div class="sdk-welcome-banner sdk-placeholder">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '')
            .replace(/<div class="sdk-ready-message">[\s\S]*?<\/div>/, '');
        process.outputBuffer = bannerHtml + process.outputBuffer;
    } else if (!process.outputBuffer?.includes('sdk-welcome-banner')) {
        process.outputBuffer = bannerHtml + (process.outputBuffer || '');
    }

    // If this process is currently selected, re-display the full buffer
    if (selectedProcessId === processId) {
        setTerminalHtml(process.outputBuffer);
    }
}

/**
 * Generate a brief summary for a tool use
 */
function getToolSummary(toolName, input) {
    switch (toolName) {
        case 'Read':
            return `Reading ${input.file_path?.split('/').pop() || 'file'}`;
        case 'Write':
            return `Writing to ${input.file_path?.split('/').pop() || 'file'}`;
        case 'Edit':
            return `Editing ${input.file_path?.split('/').pop() || 'file'}`;
        case 'Bash':
            const cmd = input.command || '';
            return `Running: ${cmd.substring(0, 50)}${cmd.length > 50 ? '...' : ''}`;
        case 'Glob':
            return `Searching for ${input.pattern || 'files'}`;
        case 'Grep':
            return `Searching for "${input.pattern?.substring(0, 30) || ''}"`;
        case 'Task':
            return `Spawning ${input.subagent_type || 'agent'}`;
        case 'WebFetch':
            return `Fetching ${input.url?.substring(0, 40) || 'URL'}`;
        default:
            return `Using ${toolName}`;
    }
}

/**
 * Toggle tool details expansion
 */
function toggleToolDetails(btn) {
    // Support both old and new tool block structures
    const block = btn.closest('.mc-inline-tool') || btn.closest('.tool-use-block');
    if (block) {
        const details = block.querySelector('.mc-inline-tool-details');
        if (details) {
            details.classList.toggle('hidden');
            const expandIcon = btn.querySelector('.tool-expand-icon');
            if (expandIcon) {
                expandIcon.textContent = details.classList.contains('hidden') ? '▶' : '▼';
            }
        }
    }
}

/**
 * Append a tool use block to the terminal
 */
function appendToolUseBlock(processId, msg) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    const toolId = msg.tool_use_id || `tool-${Date.now()}`;
    const summary = getToolSummary(msg.name, msg.input || {});
    const inputStr = JSON.stringify(msg.input, null, 2);

    // Get icon for tool type
    const toolIconHtml = toolIcon(msg.name, 16);

    const inputEscaped = inputStr.replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const html = `
        <div class="mc-inline-tools">
        <div class="mc-inline-tool running" data-tool-id="${escapeHtml(toolId)}">
            <div class="mc-inline-tool-header" onclick="toggleInlineToolExpand(this)">
                <span class="tool-expand-icon">▶</span>
                <span class="tool-status-icon"><span class="tool-running-pulse"></span></span>
                <span class="tool-name">${escapeHtml(msg.name)}</span>
                <span class="tool-summary">${escapeHtml(summary)}</span>
            </div>
            <div class="mc-inline-tool-details hidden">
                <div class="tool-input">
                    <div class="detail-header">
                        <span class="detail-label">Input</span>
                        <button class="detail-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.tool-input').querySelector('pre').textContent)" title="Copy">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                    </div>
                    <pre class="detail-content">${escapeHtml(inputStr)}</pre>
                </div>
                <div class="tool-output" style="display: none;">
                    <div class="detail-header">
                        <span class="detail-label">Output</span>
                    </div>
                    <pre class="detail-content tool-output-content"></pre>
                </div>
            </div>
        </div>
        </div>
    `;

    process.outputBuffer = (process.outputBuffer || '') + html;
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }
}

/**
 * Update a tool use block with result/completion status
 */
function updateToolUseBlock(toolId, status, output) {
    const block = document.querySelector(`.mc-inline-tool[data-tool-id="${toolId}"]`);
    if (!block) return;

    // Update status
    block.classList.remove('running');
    if (status !== 'completed') {
        block.classList.add('error');
    }

    // Replace running pulse with status icon
    const statusIcon = block.querySelector('.tool-status-icon');
    if (statusIcon) {
        statusIcon.innerHTML = status === 'completed'
            ? icon('check-circle', {size: 14})
            : icon('x-circle', {size: 14});
    }

    // Show output if provided
    if (output) {
        const outputSection = block.querySelector('.tool-output');
        const outputPre = block.querySelector('.tool-output-content');
        if (outputSection && outputPre) {
            outputSection.style.display = 'block';
            const displayOutput = output.length > 2000
                ? output.substring(0, 2000) + '\n... (truncated)'
                : output;
            outputPre.textContent = displayOutput;
        }
    }
}

/**
 * Mark all running tool use blocks as completed
 * Called when a new assistant message arrives, indicating tools have finished
 */
function completeRunningTools() {
    const runningTools = document.querySelectorAll('.mc-inline-tool.running');
    runningTools.forEach(block => {
        block.classList.remove('running');
        const statusIcon = block.querySelector('.tool-status-icon');
        if (statusIcon) {
            statusIcon.innerHTML = icon('check-circle', {size: 14});
        }
    });
}

/**
 * Show tool approval UI for pending tool use request
 */
function showToolApprovalUI(processId, msg) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    const inputStr = JSON.stringify(msg.input, null, 2);
    const html = `
        <div class="tool-approval" data-tool-id="${escapeHtml(msg.tool_use_id)}">
            <div class="tool-header">Tool: ${escapeHtml(msg.name)}</div>
            <pre class="tool-input">${escapeHtml(inputStr)}</pre>
            <div class="tool-actions">
                <button onclick="approveToolUse('${escapeHtml(processId)}', '${escapeHtml(msg.tool_use_id)}', true)">Allow</button>
                <button onclick="approveToolUse('${escapeHtml(processId)}', '${escapeHtml(msg.tool_use_id)}', false)">Deny</button>
            </div>
        </div>
    `;

    // Store in buffer and display
    process.outputBuffer = (process.outputBuffer || '') + html;
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }

    // Also show a toast notification
    showToast(`Tool "${msg.name}" requires approval`, 'warning');
}

/**
 * Approve or deny a tool use request
 */
async function approveToolUse(processId, toolUseId, approved) {
    try {
        const response = await fetch(`/api/process/${processId}/tool-approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_use_id: toolUseId, approved })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Remove the approval UI from the terminal
        const approvalEl = document.querySelector(`.tool-approval[data-tool-id="${toolUseId}"]`);
        if (approvalEl) {
            approvalEl.classList.add('resolved');
            approvalEl.querySelector('.tool-actions').innerHTML =
                `<span class="tool-resolved ${approved ? 'approved' : 'denied'}">${approved ? 'Allowed' : 'Denied'}</span>`;
        }

        // Update the tool use block status
        updateToolUseBlock(toolUseId, approved ? 'completed' : 'failed');

        showToast(`Tool ${approved ? 'allowed' : 'denied'}`, approved ? 'success' : 'info');

    } catch (error) {
        console.error('Failed to send tool approval:', error);
        showToast(`Failed to send approval: ${error.message}`, 'error');
    }
}

// ============================================================================
// Phase 2: User Choice UI
// ============================================================================

/**
 * Check if a message contains user choice/question data
 */
function isUserChoiceMessage(msg) {
    // Check for AskUserQuestion tool or choice patterns
    return msg.type === 'user_choice' ||
           (msg.input && msg.input.questions) ||
           (msg.name === 'AskUserQuestion');
}

/**
 * Show user choice UI when Claude asks for selection
 */
function showUserChoiceUI(processId, msg) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    const choiceId = msg.tool_use_id || `choice-${Date.now()}`;

    // Extract questions from message
    const questions = msg.input?.questions || msg.questions || [];
    if (questions.length === 0) {
        console.warn('[SDK] No questions found in user_choice message:', msg);
        return;
    }

    // Build HTML for each question
    let html = `<div class="sdk-user-choice" data-choice-id="${escapeHtml(choiceId)}">`;
    html += `<div class="sdk-user-choice-header"><span>${icon('help-circle', {size:14})}</span> Claude needs your input</div>`;

    questions.forEach((q, qIndex) => {
        const question = q.question || q;
        const options = q.options || [];
        const header = q.header || '';
        const multiSelect = q.multiSelect || false;

        html += `<div class="sdk-choice-question-block" data-question-index="${qIndex}">`;

        if (header) {
            html += `<div class="sdk-choice-header-tag">${escapeHtml(header)}</div>`;
        }

        html += `<div class="sdk-user-choice-question">${escapeHtml(question)}</div>`;
        html += `<div class="sdk-choice-options" data-multi="${multiSelect}">`;

        options.forEach((opt, optIndex) => {
            const label = opt.label || opt;
            const description = opt.description || '';

            if (description) {
                html += `<button class="sdk-choice-btn sdk-choice-btn-detailed"
                         onclick="selectUserChoice('${escapeHtml(processId)}', '${escapeHtml(choiceId)}', ${qIndex}, ${optIndex}, '${escapeHtml(label)}')"
                         data-option-index="${optIndex}">
                    <div class="sdk-choice-btn-label">${escapeHtml(label)}</div>
                    <div class="sdk-choice-btn-desc">${escapeHtml(description)}</div>
                </button>`;
            } else {
                html += `<button class="sdk-choice-btn"
                         onclick="selectUserChoice('${escapeHtml(processId)}', '${escapeHtml(choiceId)}', ${qIndex}, ${optIndex}, '${escapeHtml(label)}')"
                         data-option-index="${optIndex}">${escapeHtml(label)}</button>`;
            }
        });

        html += `</div>`; // close options

        // Add "Other" input option
        html += `<div class="sdk-choice-other">
            <input type="text" class="sdk-choice-other-input"
                   placeholder="Or type a custom response..."
                   id="choice-other-${choiceId}-${qIndex}">
            <button class="sdk-choice-other-submit"
                    onclick="submitOtherChoice('${escapeHtml(processId)}', '${escapeHtml(choiceId)}', ${qIndex})">
                Submit
            </button>
        </div>`;

        html += `</div>`; // close question block
    });

    html += `</div>`; // close user-choice

    // Store in buffer and display
    process.outputBuffer = (process.outputBuffer || '') + html;
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }

    showToast('Claude is waiting for your input', 'info');
}

/**
 * Handle user selecting a choice option
 */
async function selectUserChoice(processId, choiceId, questionIndex, optionIndex, label) {
    const choiceEl = document.querySelector(`.sdk-user-choice[data-choice-id="${choiceId}"]`);

    // Visual feedback
    const buttons = choiceEl?.querySelectorAll(`.sdk-choice-question-block[data-question-index="${questionIndex}"] .sdk-choice-btn`);
    buttons?.forEach(btn => btn.classList.remove('selected'));
    buttons?.[optionIndex]?.classList.add('selected');

    // Disable all buttons while processing
    choiceEl?.querySelectorAll('.sdk-choice-btn').forEach(btn => btn.classList.add('disabled'));

    // Send the selection to Claude
    const response = await sendUserChoiceResponse(processId, choiceId, label);

    if (response) {
        // Mark as resolved
        choiceEl?.classList.add('resolved');
        showToast(`Selected: ${label}`, 'success');
    } else {
        // Re-enable buttons on failure
        choiceEl?.querySelectorAll('.sdk-choice-btn').forEach(btn => btn.classList.remove('disabled'));
    }
}

/**
 * Handle user submitting a custom "Other" response
 */
async function submitOtherChoice(processId, choiceId, questionIndex) {
    const inputEl = document.getElementById(`choice-other-${choiceId}-${questionIndex}`);
    const text = inputEl?.value?.trim();

    if (!text) {
        showToast('Please enter a response', 'warning');
        return;
    }

    const choiceEl = document.querySelector(`.sdk-user-choice[data-choice-id="${choiceId}"]`);
    choiceEl?.querySelectorAll('.sdk-choice-btn').forEach(btn => btn.classList.add('disabled'));

    const response = await sendUserChoiceResponse(processId, choiceId, text);

    if (response) {
        choiceEl?.classList.add('resolved');
        showToast(`Submitted: ${text}`, 'success');
    } else {
        choiceEl?.querySelectorAll('.sdk-choice-btn').forEach(btn => btn.classList.remove('disabled'));
    }
}

/**
 * Send user choice response to the SDK session
 */
async function sendUserChoiceResponse(processId, choiceId, answer) {
    try {
        // Send as a regular message - the SDK will interpret it as a choice response
        const response = await fetch(`/api/process/${processId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: answer })
        });

        return response.ok;
    } catch (error) {
        console.error('Failed to send choice response:', error);
        showToast(`Failed to send response: ${error.message}`, 'error');
        return false;
    }
}

// ============================================================================
// Phase 3: Edit Approval UI with Diff Viewer
// ============================================================================

/**
 * Check if a tool is an edit tool that should show diff UI
 */
function isEditTool(toolName) {
    const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
    return editTools.includes(toolName);
}

/**
 * Show edit approval UI with diff viewer
 */
function showEditApprovalUI(processId, msg) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    const toolUseId = msg.tool_use_id;
    const toolName = msg.name;
    const input = msg.input || {};

    // Extract file path and content based on tool type
    let filePath = '';
    let oldContent = '';
    let newContent = '';

    if (toolName === 'Edit') {
        filePath = input.file_path || '';
        oldContent = input.old_string || '';
        newContent = input.new_string || '';
    } else if (toolName === 'Write') {
        filePath = input.file_path || '';
        oldContent = ''; // New file or full replacement
        newContent = input.content || '';
    } else if (toolName === 'MultiEdit') {
        // MultiEdit has array of edits - show first one or summary
        filePath = input.file_path || '';
        const edits = input.edits || [];
        if (edits.length > 0) {
            oldContent = edits.map(e => e.old_string || '').join('\n---\n');
            newContent = edits.map(e => e.new_string || '').join('\n---\n');
        }
    }

    // Generate diff HTML
    const diffHtml = generateDiffView(oldContent, newContent);
    const stats = calculateDiffStats(oldContent, newContent);

    const html = `
        <div class="sdk-edit-approval" data-tool-id="${escapeHtml(toolUseId)}">
            <div class="sdk-edit-header">
                <div class="sdk-edit-file-info">
                    <span class="sdk-edit-icon">${icon('pencil', {size:14})}</span>
                    <span class="sdk-edit-file-path">${escapeHtml(filePath || 'unknown file')}</span>
                    <span class="sdk-edit-tool-name">${escapeHtml(toolName)}</span>
                </div>
            </div>
            <div class="sdk-diff-viewer">
                ${diffHtml}
            </div>
            <div class="sdk-diff-stats">
                <span class="sdk-diff-stat-added">+${stats.added} additions</span>
                <span class="sdk-diff-stat-removed">-${stats.removed} deletions</span>
            </div>
            <div class="sdk-edit-actions">
                <button class="sdk-edit-btn sdk-edit-btn-approve"
                        onclick="approveEdit('${escapeHtml(processId)}', '${escapeHtml(toolUseId)}', true)">
                    ${icon('check', {size:12})} Approve
                </button>
                <button class="sdk-edit-btn sdk-edit-btn-reject"
                        onclick="approveEdit('${escapeHtml(processId)}', '${escapeHtml(toolUseId)}', false)">
                    ${icon('x', {size:12})} Reject
                </button>
            </div>
        </div>
    `;

    // Store in buffer and display
    process.outputBuffer = (process.outputBuffer || '') + html;
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }

    showToast(`Edit to ${filePath.split('/').pop() || 'file'} requires approval`, 'warning');
}

/**
 * Generate a diff view HTML from old and new content
 */
function generateDiffView(oldContent, newContent) {
    if (!oldContent && !newContent) {
        return '<div class="sdk-diff-line context"><span class="sdk-diff-line-content">(empty)</span></div>';
    }

    // Handle new file case
    if (!oldContent && newContent) {
        const lines = newContent.split('\n');
        return lines.map((line, i) => `
            <div class="sdk-diff-line added">
                <span class="sdk-diff-line-number">${i + 1}</span>
                <span class="sdk-diff-line-content">+ ${escapeHtml(line)}</span>
            </div>
        `).join('');
    }

    // Handle delete case
    if (oldContent && !newContent) {
        const lines = oldContent.split('\n');
        return lines.map((line, i) => `
            <div class="sdk-diff-line removed">
                <span class="sdk-diff-line-number">${i + 1}</span>
                <span class="sdk-diff-line-content">- ${escapeHtml(line)}</span>
            </div>
        `).join('');
    }

    // Simple line-by-line diff for edits
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    let html = '';

    // Show header
    html += `<div class="sdk-diff-line header">
        <span class="sdk-diff-line-content">@@ Edit: ${oldLines.length} lines → ${newLines.length} lines @@</span>
    </div>`;

    // Show removed lines
    oldLines.forEach((line, i) => {
        html += `<div class="sdk-diff-line removed">
            <span class="sdk-diff-line-number">${i + 1}</span>
            <span class="sdk-diff-line-content">- ${escapeHtml(line)}</span>
        </div>`;
    });

    // Show added lines
    newLines.forEach((line, i) => {
        html += `<div class="sdk-diff-line added">
            <span class="sdk-diff-line-number">${i + 1}</span>
            <span class="sdk-diff-line-content">+ ${escapeHtml(line)}</span>
        </div>`;
    });

    return html;
}

/**
 * Calculate diff statistics
 */
function calculateDiffStats(oldContent, newContent) {
    const oldLines = oldContent ? oldContent.split('\n').length : 0;
    const newLines = newContent ? newContent.split('\n').length : 0;

    return {
        added: newLines,
        removed: oldLines
    };
}

/**
 * Approve or reject an edit
 */
async function approveEdit(processId, toolUseId, approved) {
    try {
        const response = await fetch(`/api/process/${processId}/tool-approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_use_id: toolUseId, approved })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Update the UI
        const editEl = document.querySelector(`.sdk-edit-approval[data-tool-id="${toolUseId}"]`);
        if (editEl) {
            editEl.classList.add('resolved');
            const actionsEl = editEl.querySelector('.sdk-edit-actions');
            if (actionsEl) {
                actionsEl.innerHTML = `
                    <span class="sdk-edit-resolved-badge ${approved ? 'approved' : 'rejected'}">
                        ${approved ? icon('check', {size:12}) + ' Approved' : icon('x', {size:12}) + ' Rejected'}
                    </span>
                `;
            }
        }

        showToast(`Edit ${approved ? 'approved' : 'rejected'}`, approved ? 'success' : 'info');

    } catch (error) {
        console.error('Failed to send edit approval:', error);
        showToast(`Failed to send approval: ${error.message}`, 'error');
    }
}

// ============================================================================
// Phase 4: Skills Browser and Session Resume
// ============================================================================

/**
 * Session persistence key for localStorage
 */
const SDK_SESSION_STORAGE_KEY = 'sdk_sessions';
const SDK_LAST_SESSION_KEY = 'sdk_last_session';

/**
 * Save session info to localStorage for resume
 */
function saveSessionToStorage(processId, sessionInfo) {
    try {
        const sessions = JSON.parse(localStorage.getItem(SDK_SESSION_STORAGE_KEY) || '{}');
        sessions[processId] = {
            ...sessionInfo,
            savedAt: new Date().toISOString()
        };
        // Keep only last 10 sessions
        const keys = Object.keys(sessions);
        if (keys.length > 10) {
            const sortedKeys = keys.sort((a, b) =>
                new Date(sessions[b].savedAt) - new Date(sessions[a].savedAt)
            );
            sortedKeys.slice(10).forEach(k => delete sessions[k]);
        }
        localStorage.setItem(SDK_SESSION_STORAGE_KEY, JSON.stringify(sessions));
        localStorage.setItem(SDK_LAST_SESSION_KEY, processId);
    } catch (e) {
        console.warn('Failed to save session to storage:', e);
    }
}

/**
 * Get saved sessions from localStorage
 */
function getSavedSessions() {
    try {
        return JSON.parse(localStorage.getItem(SDK_SESSION_STORAGE_KEY) || '{}');
    } catch (e) {
        return {};
    }
}

/**
 * Get the last used session ID
 */
function getLastSessionId() {
    return localStorage.getItem(SDK_LAST_SESSION_KEY);
}

/**
 * Show saved sessions that can be resumed
 */
function showSavedSessions(processId) {
    const sessions = getSavedSessions();
    const sessionList = Object.entries(sessions);

    if (sessionList.length === 0) {
        showLocalSystemMessage(processId, icon('folder-open', {size:14}), 'No saved sessions found. Sessions are saved automatically when you use them.');
        return;
    }

    let html = `<div class="sdk-system-message">
        <div class="sdk-system-header">${icon('folder-open', {size:14})} Saved Sessions</div>
        <div class="sdk-sessions-list">`;

    sessionList.sort((a, b) => new Date(b[1].savedAt) - new Date(a[1].savedAt));

    sessionList.forEach(([id, info]) => {
        const dirName = info.cwd?.split('/').pop() || 'Unknown';
        const savedAt = new Date(info.savedAt).toLocaleString();
        const claudeSessionId = info.claudeSessionId || 'No Claude session';

        html += `<div class="sdk-session-item" data-session-id="${escapeHtml(id)}">
            <div class="sdk-session-item-header">
                <span class="sdk-session-item-dir">${escapeHtml(dirName)}</span>
                <span class="sdk-session-item-time">${escapeHtml(savedAt)}</span>
            </div>
            <div class="sdk-session-item-path">${escapeHtml(info.cwd || '')}</div>
            <div class="sdk-session-item-actions">
                <button onclick="resumeSavedSession('${escapeHtml(id)}')" class="sdk-btn-resume">Resume</button>
            </div>
        </div>`;
    });

    html += `</div></div>`;

    const process = managedProcesses.get(processId);
    if (process) {
        process.outputBuffer = (process.outputBuffer || '') + html;
    }
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }
}

/**
 * Resume a saved session
 */
async function resumeSavedSession(sessionId) {
    const sessions = getSavedSessions();
    const sessionInfo = sessions[sessionId];

    if (!sessionInfo) {
        showToast('Session not found', 'error');
        return;
    }

    showToast(`Resuming session in ${sessionInfo.cwd?.split('/').pop() || 'directory'}...`, 'info');

    try {
        // Spawn a new session with the same cwd
        const response = await fetch('/api/spawn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cwd: sessionInfo.cwd,
                resume_session_id: sessionInfo.claudeSessionId // Pass the Claude session ID for resuming
            })
        });

        if (!response.ok) {
            throw new Error('Failed to spawn session');
        }

        const data = await response.json();
        showToast(`Session resumed: ${data.process_id}`, 'success');

        // Connect to the new session
        connectToProcess(data.process_id);
        selectManagedProcess(data.process_id);

    } catch (error) {
        console.error('Failed to resume session:', error);
        showToast(`Failed to resume: ${error.message}`, 'error');
    }
}

/**
 * Handle /skills or /skill command
 */
async function handleSkillsCommand(processId, args) {
    if (!args || args.trim() === '' || args.trim() === 'list') {
        // Show available skills
        await showAvailableSkills(processId);
    } else {
        // Invoke a specific skill - send to Claude with skill prefix
        const skillName = args.trim();
        showLocalSystemMessage(processId, icon('target', {size:14}), `Invoking skill: /${skillName}`);

        // Send the skill command to Claude
        try {
            const response = await fetch(`/api/process/${processId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: `/${skillName}` })
            });

            if (!response.ok) {
                throw new Error('Failed to send skill command');
            }
        } catch (error) {
            showToast(`Failed to invoke skill: ${error.message}`, 'error');
        }
    }
}

/**
 * Show available skills
 */
async function showAvailableSkills(processId) {
    // Common Claude Code skills - this is a curated list
    const commonSkills = [
        { name: 'commit', description: 'Create a git commit with generated message' },
        { name: 'debug', description: 'Systematic debugging workflow' },
        { name: 'review-pr', description: 'Review a pull request' },
        { name: 'help', description: 'Show Claude Code help' },
        { name: 'init', description: 'Initialize project configuration' },
        { name: 'test', description: 'Run tests and analyze results' },
        { name: 'refactor', description: 'Refactor code with best practices' },
        { name: 'explain', description: 'Explain code in detail' },
        { name: 'docs', description: 'Generate documentation' }
    ];

    let html = `<div class="sdk-system-message">
        <div class="sdk-system-header">${icon('target', {size:14})} Available Skills</div>
        <div class="sdk-skills-list">
            <table class="sdk-help-table">
                <tr><th>Skill</th><th>Description</th></tr>`;

    commonSkills.forEach(skill => {
        html += `<tr>
            <td><code>/${skill.name}</code></td>
            <td>${escapeHtml(skill.description)}</td>
        </tr>`;
    });

    html += `</table>
        <div class="sdk-help-note">
            <strong>Usage:</strong> Type <code>/skill &lt;name&gt;</code> or just <code>/&lt;name&gt;</code> to invoke a skill.
            <br>Skills that aren't built-in will be sent to Claude for handling.
        </div>
        </div>
    </div>`;

    const process = managedProcesses.get(processId);
    if (process) {
        process.outputBuffer = (process.outputBuffer || '') + html;
    }
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }
}

/**
 * Auto-save session when Claude session ID is received
 */
function autoSaveSession(processId, claudeSessionId) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    saveSessionToStorage(processId, {
        cwd: process.cwd,
        claudeSessionId: claudeSessionId,
        state: process.state
    });

    console.log(`[SDK] Auto-saved session ${processId} with Claude session ${claudeSessionId}`);
}

/**
 * Send a message to an SDK session (alternative to stdin for SDK sessions)
 */
async function sendSDKMessage(processId, text) {
    try {
        const response = await fetch(`/api/process/${processId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        return true;
    } catch (error) {
        console.error('Failed to send SDK message:', error);
        showToast(`Failed to send message: ${error.message}`, 'error');
        return false;
    }
}

/**
 * Update UI for a managed process
 */
function updateProcessUI(processId) {
    refreshManagedProcessList();

    // Update kill/release button visibility
    if (selectedProcessId === processId) {
        const killBtn = document.getElementById('mc-kill-btn');
        const releaseBtn = document.getElementById('mc-release-btn');
        const process = managedProcesses.get(processId);
        if (killBtn && process) {
            killBtn.classList.toggle('hidden', process.state === 'stopped');
        }
        if (releaseBtn && process) {
            releaseBtn.classList.toggle('hidden', process.state === 'stopped');
        }
    }
}

/**
 * Refresh the managed processes in the session list
 */
async function refreshManagedProcessList() {
    try {
        const response = await fetch('/api/processes');
        if (!response.ok) return;

        const processes = await response.json();

        // Update local tracking
        for (const p of processes) {
            if (!managedProcesses.has(p.id)) {
                managedProcesses.set(p.id, {
                    id: p.id,
                    cwd: p.cwd,
                    state: p.state,
                    ws: null,
                    outputBuffer: '', // Store all output even when not selected
                    startedAt: p.started_at,
                    clientCount: p.client_count,
                    inputTokens: p.input_tokens || 0,
                    outputTokens: p.output_tokens || 0,
                    totalCostUsd: p.total_cost_usd || 0
                });
            } else {
                const existing = managedProcesses.get(p.id);
                existing.state = p.state;
                existing.exitCode = p.exit_code;
                existing.clientCount = p.client_count;
                existing.inputTokens = p.input_tokens || existing.inputTokens || 0;
                existing.outputTokens = p.output_tokens || existing.outputTokens || 0;
                existing.totalCostUsd = p.total_cost_usd || existing.totalCostUsd || 0;
                if (!existing.startedAt && p.started_at) {
                    existing.startedAt = p.started_at;
                }
            }
        }

        // Clean up processes no longer tracked by server
        const activeIds = new Set(processes.map(p => p.id));
        for (const [id, process] of managedProcesses) {
            if (!activeIds.has(id)) {
                // Close WebSocket if open
                if (process.ws && process.ws.readyState === WebSocket.OPEN) {
                    process.ws.close();
                }
                managedProcesses.delete(id);
                console.log(`[MC] Removed stale process ${id} from tracking`);
            }
        }

    } catch (error) {
        console.error('Failed to refresh managed processes:', error);
    }
}

/**
 * Select a managed process in Mission Control
 */
function selectManagedProcess(processId) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    // Disconnect MC conversation WebSocket when switching to managed process
    disconnectMissionControlProcess();

    // Deselect detected session
    mcSelectedSessionId = null;
    selectedProcessId = processId;

    // Update session list selection
    document.querySelectorAll('.mc-session-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.processId === processId);
    });

    // Update panel header
    const labelEl = document.getElementById('mc-selected-session');
    const typeEl = document.getElementById('mc-session-type');
    const titleEl = document.getElementById('mc-panel-title');
    const killBtn = document.getElementById('mc-kill-btn');

    if (labelEl) {
        const dirName = process.cwd.split('/').pop() || process.cwd;
        labelEl.textContent = dirName;
    }

    if (typeEl) {
        typeEl.textContent = 'Managed';
        typeEl.className = 'mc-session-type-badge managed';
    }

    if (titleEl) {
        titleEl.textContent = 'Live Conversation';
    }

    if (killBtn) {
        killBtn.classList.toggle('hidden', process.state === 'stopped');
    }

    // Show release button for managed processes
    const releaseBtn = document.getElementById('mc-release-btn');
    if (releaseBtn) {
        releaseBtn.classList.toggle('hidden', process.state === 'stopped');
    }

    // Update context indicator (contextTokens set by result message handler)
    const tokens = process.contextTokens || (process.inputTokens || 0) + (process.outputTokens || 0);
    updateContextIndicator(tokens, MAX_CONTEXT_TOKENS);

    // Show conversation stream for SDK sessions (same panel as regular sessions)
    const streamEl = document.getElementById('mc-conversation-stream');
    const terminalEl = document.getElementById('mc-terminal-output');

    if (process.isSDK) {
        if (streamEl) streamEl.classList.remove('hidden');
        if (terminalEl) terminalEl.classList.add('hidden');
    } else {
        if (streamEl) streamEl.classList.add('hidden');
        if (terminalEl) terminalEl.classList.remove('hidden');
    }

    // Display buffered output for this process
    displayProcessBuffer(processId);

    // Show input for managed processes
    showMCInput();

    // Connect to WebSocket if not already
    if (!process.ws || process.ws.readyState !== WebSocket.OPEN) {
        connectToProcess(processId);
    }
}

/**
 * Release a managed process back to the terminal.
 */
async function releaseSelectedProcess() {
    if (!selectedProcessId) return;

    try {
        const response = await fetch(`/api/process/${selectedProcessId}/release`, {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error('Release failed');
        }

        const data = await response.json();

        // Clean up the managed process
        const proc = managedProcesses.get(selectedProcessId);
        if (proc && proc.ws) {
            proc.ws.close();
        }
        managedProcesses.delete(selectedProcessId);

        // Clear selection
        selectedProcessId = null;
        clearMissionControlConversation();

        const sessionId = data.session_id || 'unknown';
        showToast(`Released to terminal. Resume with: claude --resume ${sessionId}`, 'success');

        await refreshManagedProcessList();
        refreshMissionControl();
    } catch (e) {
        console.error('Release failed:', e);
        showToast(`Release failed: ${e.message}`, 'error');
    }
}


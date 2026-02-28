
// Activity Summary Log Renderer - shows AI-generated summaries of session activity
function renderActivitySummaryLog(entries) {
    if (!entries || entries.length === 0) {
        return '<div class="activity-summary-log empty">No activity summaries yet</div>';
    }

    const items = entries.map((entry, i) => {
        const time = formatRelativeTime(entry.timestamp);
        const isCurrent = i === entries.length - 1;
        return `
            <div class="summary-entry ${isCurrent ? 'current' : ''}">
                <span class="summary-time">${time}</span>
                <span class="summary-text">${escapeHtml(entry.summary)}</span>
            </div>
        `;
    }).join('');  // Oldest first, newest at bottom

    return `<div class="activity-summary-log">${items}</div>`;
}

// Format timestamp to relative time (e.g., "2m ago", "1h ago")
function formatRelativeTime(isoTimestamp) {
    if (!isoTimestamp) return '';
    const date = new Date(isoTimestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    return `${Math.floor(diffHours / 24)}d`;
}

function createCard(session, index = 0) {
    const card = document.createElement('div');
    card.className = `session-card ${session.state}`;
    card.dataset.sessionId = session.sessionId;

    const branchHtml = session.gitBranch
        ? `<span class="branch">${escapeHtml(session.gitBranch)}</span>`
        : '';

    const summaryHtml = session.summary
        ? `<div class="summary">${escapeHtml(session.summary)}</div>`
        : '';

    // Activity status for Mission Control style display
    const activityStatus = getActivityStatus(session.lastActivity);
    let stateEmoji = statusDot('active');
    if (session.state !== 'active') {
        stateEmoji = activityStatus.isStale ? statusDot('stale') : statusDot('waiting');
    }

    // Activity badge HTML - always use activityStatus for consistent display
    const activityBadgeHtml = activityStatus.text
        ? `<span class="idle-badge" style="background: ${activityStatus.color}; color: ${activityStatus.idleMins > 30 ? '#fff' : '#000'}">${activityStatus.text}</span>`
        : '<span class="idle-indicator">idle</span>';

    // Session duration
    const duration = formatAgentDuration(session.startTimestamp) || '0m';


    // Feature 20: Git Status display
    const gitHtml = session.git ? `
        <div class="git-status" onclick="event.stopPropagation(); showGitDetails('${escapeJsString(session.sessionId)}')">
            <span class="git-branch">${icon('git-branch', {size:14})} ${escapeHtml(session.git.branch)}</span>
            ${session.git.uncommitted ? `
                <span class="git-uncommitted">
                    ${icon('alert-triangle', {size:14})} ${session.git.modified_count} uncommitted
                </span>
            ` : `<span class="git-clean">${icon('check', {size:12})} clean</span>`}
            ${session.git.ahead > 0 ? `
                <span class="git-ahead">↑${session.git.ahead}</span>
            ` : ''}
        </div>
    ` : '';

    // Activity summary log (AI-generated summaries)
    const activitySummaryLogHtml = renderActivitySummaryLog(session.activitySummaries);

    // State source indicator (hooks = real-time, polling = heuristic)
    const stateIcon = session.stateSource === 'hooks' ? `<span class="state-source-indicator" title="Real-time hooks detection">${icon('zap', {size:14})}</span>` : '';

    // Current activity display (only when hooks-based and active)
    // Agent tree display (spawned agents)
    const agentTreeHtml = renderAgentTree(session.spawnedAgents);

    // Background shells display
    const backgroundShellsHtml = renderBackgroundShells(session.backgroundShells);

    // Emoji activity trail (hieroglyphic history)
    const activityTrailHtml = renderEmojiTrail(session.activityLog, session.state === 'active');

    // Tool history panel (expandable details)
    const toolHistoryHtml = renderToolHistoryPanel(session.sessionId);

    // Display focus summary if available, otherwise fall back to slug
    const displayTitle = session.focusSummary || session.slug;
    const hasFocusSummary = !!session.focusSummary;
    const focusSummaryClass = hasFocusSummary ? ' focus-summary' : '';
    const titleTooltip = hasFocusSummary ? `title="${escapeHtml(session.slug)}"` : '';

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="card-header">
            <div class="slug${focusSummaryClass}" ${titleTooltip}>${stateEmoji} ${escapeHtml(displayTitle)}</div>
            <div class="card-actions">
                <button class="action-menu-btn" onclick="event.stopPropagation(); toggleActionMenu('${escapeJsString(session.sessionId)}')">⋮</button>
                <div class="action-menu hidden" id="menu-${session.sessionId}">
                    <button onclick="event.stopPropagation(); copySessionId('${escapeJsString(session.sessionId)}')">${icon('clipboard-list', {size:14})} Copy Session ID</button>
                    <button onclick="event.stopPropagation(); openJsonl('${escapeJsString(session.sessionId)}')">${icon('folder-open', {size:14})} Open JSONL File</button>
                    <button onclick="event.stopPropagation(); copyResumeCmd('${escapeJsString(session.sessionId)}', '${escapeJsString(session.cwd || '')}')">${icon('link', {size:14})} Copy Resume Command</button>
                    <hr class="menu-divider">
                    <button onclick="event.stopPropagation(); refreshSummary('${escapeJsString(session.sessionId)}')">${icon('bot', {size:14})} Generate AI Summary</button>
                    <button onclick="event.stopPropagation(); shareSession('${escapeJsString(session.sessionId)}')">${icon('share', {size:14})} Share Session</button>
                    <button onclick="event.stopPropagation(); exportSession('${escapeJsString(session.sessionId)}')">${icon('file', {size:14})} Export Markdown</button>
                    <hr class="menu-divider">
                    <button class="danger" onclick="event.stopPropagation(); killSession(${session.pid}, '${escapeJsString(session.slug)}')">${icon('alert-triangle', {size:14})} Kill Session</button>
                </div>
            </div>
        </div>
        <div class="card-body">
            ${summaryHtml}
            ${activityTrailHtml}
            ${toolHistoryHtml}
            ${agentTreeHtml}
            ${backgroundShellsHtml}
            ${activitySummaryLogHtml}
        </div>
        <div class="card-bottom">
            ${formatTokenBar(session.contextTokens)}
            <div class="card-footer">
            <div class="meta">
                <span>PID: ${session.pid || '--'}</span>
            </div>
            <div class="footer-right">
                <span class="session-duration" title="Session duration">${icon('clock', {size:14})} ${duration}</span>
                ${activityBadgeHtml}
                <button class="metrics-btn" onclick="event.stopPropagation(); showMetricsModal('${escapeJsString(session.sessionId)}')" title="View Metrics">${icon('bar-chart-3', {size:14})}</button>
            </div>
            </div>
        </div>`;

    // No fade-in animation - cards appear instantly for visual stability

    // Auto-scroll activity summary log to bottom (newest entries at bottom)
    const summaryLogEl = card.querySelector('.activity-summary-log');
    if (summaryLogEl && !summaryLogEl.classList.contains('empty')) {
        new StickyScroll(summaryLogEl).attach();
    }

    // Make card clickable to focus iTerm tab
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => focusWarpTab(session));

    return card;
}

// Compact card - shows only essential info
function createCompactCard(session, index = 0) {
    const card = document.createElement('div');
    card.className = `session-card compact ${session.state}`;
    card.dataset.sessionId = session.sessionId;

    const tokenPct = session.contextTokens
        ? Math.min(100, (session.contextTokens / MAX_CONTEXT_TOKENS) * 100)
        : 0;
    const tokenClass = tokenPct > 80 ? 'critical' : tokenPct > 50 ? 'warning' : 'ok';

    const latestActivity = (session.recentActivity || [])[0] || 'Idle';

    // Session duration
    const duration = formatAgentDuration(session.startTimestamp) || '0m';

    // Show activity status - always use activityStatus for consistent display
    const activityStatus = getActivityStatus(session.lastActivity);
    const activityHtml = activityStatus.text
        ? `<span class="idle-badge" style="background: ${activityStatus.color}; color: ${activityStatus.idleMins > 30 ? '#fff' : '#000'}">${activityStatus.text}</span>`
        : '<span class="idle-indicator">idle</span>';

    // Display focus summary if available, otherwise fall back to slug
    const compactTitle = session.focusSummary || session.slug;
    const compactHasFocus = !!session.focusSummary;
    const compactFocusClass = compactHasFocus ? ' focus-summary' : '';
    const compactTooltip = compactHasFocus ? `title="${escapeHtml(session.slug)}"` : '';

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="compact-name${compactFocusClass}" ${compactTooltip}>${escapeHtml(compactTitle)}</div>
        <div class="compact-meta">
            <span>${duration}</span>
            <span>${Math.round(tokenPct)}% ctx</span>
            <button class="compact-expand" onclick="event.stopPropagation(); expandCard('${escapeJsString(session.sessionId)}')" title="Show details">▼</button>
        </div>
        <div class="compact-activity">${activityHtml}</div>
    `;

    card.style.cursor = 'pointer';
    card.addEventListener('click', () => focusWarpTab(session));

    return card;
}

// Toggle between compact and detailed view
function toggleCardMode() {
    cardDisplayMode = cardDisplayMode === 'compact' ? 'detailed' : 'compact';
    localStorage.setItem('cardDisplayMode', cardDisplayMode);
    updateViewModeButton();
    renderCurrentSessions(null, true); // Force full render
    showToast(`Switched to ${cardDisplayMode} view`);
}

// Expand a single compact card to detailed view
function expandCard(sessionId) {
    const session = previousSessions.get(sessionId);
    if (!session) return;

    const compactCard = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (compactCard && compactCard.classList.contains('compact')) {
        const index = Array.from(document.querySelectorAll('[data-session-id]')).indexOf(compactCard);
        const detailedCard = createCard(session, index);
        detailedCard.classList.add('expanded');
        compactCard.replaceWith(detailedCard);
    }
}

// Toggle focus mode (show only active sessions)
function toggleFocusMode() {
    focusMode = !focusMode;
    localStorage.setItem('focusMode', JSON.stringify(focusMode));
    document.body.classList.toggle('focus-mode', focusMode);
    updateFocusModeButton();
    renderCurrentSessions(null, true); // Force full render
    showToast(focusMode ? 'Focus mode: showing active only' : 'Focus mode off');
}

// Update the view mode button UI
function updateViewModeButton() {
    const btn = document.getElementById('view-mode-toggle');
    if (btn) {
        btn.innerHTML = cardDisplayMode === 'compact' ? icon('clipboard-list', {size:16}) : icon('bar-chart-3', {size:16});
        btn.title = cardDisplayMode === 'compact' ? 'Switch to detailed view' : 'Switch to compact view';
    }
}

// Update focus mode button UI
function updateFocusModeButton() {
    const btn = document.getElementById('focus-mode-toggle');
    if (btn) {
        btn.classList.toggle('active', focusMode);
        btn.title = focusMode ? 'Show all sessions' : 'Show active only';
    }
}

function toggleActionMenu(sessionId) {
    const menu = document.getElementById(`menu-${sessionId}`);
    // Close all other menus
    document.querySelectorAll('.action-menu').forEach(m => {
        if (m.id !== `menu-${sessionId}`) {
            m.classList.add('hidden');
        }
    });
    menu.classList.toggle('hidden');
}

// Feature 06: Quick Actions
async function copySessionId(sessionId) {
    try {
        await navigator.clipboard.writeText(sessionId);
        showToast('Session ID copied!');
    } catch (e) {
        showToast('Failed to copy');
    }
    closeAllMenus();
}

async function copyResumeCmd(sessionId, cwd) {
    // Build command with cd to session directory if cwd provided
    const resumeCmd = `claude --resume ${sessionId}`;
    const cmd = cwd ? `cd ${cwd} && ${resumeCmd}` : resumeCmd;
    try {
        await navigator.clipboard.writeText(cmd);
        showToast('Resume command copied!');
    } catch (e) {
        showToast('Failed to copy');
    }
    closeAllMenus();
}

async function openJsonl(sessionId) {
    try {
        const resp = await fetch(`/api/session/${sessionId}/jsonl-path`);
        if (!resp.ok) {
            showToast('Session file not found', 'error');
            return;
        }
        const data = await resp.json();
        // Copy path to clipboard since file:// URLs may be blocked
        await navigator.clipboard.writeText(data.path);
        showToast('JSONL path copied! Open in editor.');
    } catch (e) {
        showToast('Failed to get session file');
    }
    closeAllMenus();
}

/**
 * Copy message content to clipboard
 * @param {HTMLElement} btn - The copy button element
 */
async function copyMessageContent(btn) {
    const content = btn.dataset.content
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    try {
        await navigator.clipboard.writeText(content);
        // Visual feedback - change icon briefly
        const originalHtml = btn.innerHTML;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.classList.remove('copied');
        }, 1500);
    } catch (e) {
        showToast('Failed to copy', 'error');
    }
}

// Delete message state
let pendingDeleteMessage = null;

/**
 * Handle delete button click - extract data and show modal
 * @param {HTMLElement} btn - The delete button element
 */
function handleDeleteClick(btn) {
    const lineNumber = parseInt(btn.dataset.line, 10);
    const role = btn.dataset.role;

    // Get the message content from the sibling content element
    const messageEl = btn.closest('.mc-message');
    const contentEl = messageEl?.querySelector('.mc-message-content');
    const preview = contentEl?.textContent || '';

    showDeleteModal(mcSelectedSessionId, lineNumber, preview, role);
}

/**
 * Show delete confirmation modal
 * @param {string} sessionId - Session ID
 * @param {number} lineNumber - Line number in JSONL
 * @param {string} preview - Message preview
 * @param {string} role - Message role (user/assistant)
 */
function showDeleteModal(sessionId, lineNumber, preview, role) {
    pendingDeleteMessage = { sessionId, lineNumber };

    const modal = document.getElementById('delete-message-modal');
    const previewEl = document.getElementById('delete-message-preview');

    if (previewEl) {
        const truncatedPreview = preview.length > 150 ? preview.substring(0, 150) + '...' : preview;
        previewEl.innerHTML = `<span class="delete-preview-role">${role}:</span> ${escapeHtml(truncatedPreview)}`;
    }

    if (modal) {
        modal.classList.remove('hidden');
    }
}

/**
 * Hide delete confirmation modal
 */
function hideDeleteModal() {
    const modal = document.getElementById('delete-message-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
    pendingDeleteMessage = null;
}

/**
 * Confirm and execute message deletion
 */
async function confirmDeleteMessage() {
    if (!pendingDeleteMessage) return;

    const { sessionId, lineNumber } = pendingDeleteMessage;
    hideDeleteModal();

    try {
        const response = await fetch(`/api/session/${sessionId}/message`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ line_number: lineNumber })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        const result = await response.json();

        // Update context indicator with new token count
        if (result.new_total_tokens !== undefined) {
            updateContextIndicator(result.new_total_tokens, MAX_CONTEXT_TOKENS);
        }

        showToast('Message deleted', 'success');

        // Refresh conversation to show updated list
        if (mcSelectedSessionId === sessionId) {
            loadConversationHistory(sessionId);
        }

    } catch (error) {
        console.error('Failed to delete message:', error);
        showToast(`Failed to delete: ${error.message}`, 'error');
    }
}

/**
 * Format token count for display
 */
function formatTokenCount(tokens) {
    if (!tokens || tokens === 0) return '';
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`;
    }
    return tokens.toString();
}

async function killSession(pid, slug) {
    closeAllMenus();
    if (!pid) {
        showToast('No PID available', 'error');
        return;
    }
    if (!confirm(`Kill session "${slug}" (PID ${pid})?`)) return;

    try {
        const resp = await fetch('/api/kill', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ pid })
        });

        if (resp.ok) {
            showToast('Session killed');
            // Refresh to update the UI
            setTimeout(fetchSessions, 500);
        } else {
            const error = await resp.json();
            showToast(`Failed: ${error.detail || 'Unknown error'}`, 'error');
        }
    } catch (e) {
        showToast('Failed to kill session', 'error');
    }
}

function closeAllMenus() {
    document.querySelectorAll('.action-menu').forEach(m => m.classList.add('hidden'));
}

// Feature 15: AI Summary - now auto-generated on activity change
async function refreshSummary(sessionId) {
    closeAllMenus();
    showToast('AI summaries are now generated automatically when activity changes');
}

// Feature 16: Session sharing
async function shareSession(sessionId) {
    closeAllMenus();

    try {
        const response = await fetch(`/api/sessions/${sessionId}/share`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ expires_days: 7 })
        });

        if (!response.ok) {
            showToast('Failed to create share link', 'error');
            return;
        }

        const data = await response.json();
        const shareUrl = window.location.origin + data.url;

        showModal(`
            <div class="share-modal">
                <h3>${icon('share', {size:18})} Share Session</h3>
                <p>Share this link to let others view this session snapshot:</p>
                <input type="text" class="share-url" value="${escapeHtml(shareUrl)}" readonly onclick="this.select()">
                <div class="modal-actions">
                    <button onclick="navigator.clipboard.writeText('${escapeJsString(shareUrl)}'); showToast('Link copied!');">Copy Link</button>
                    <button onclick="closeModal()">Close</button>
                </div>
                <p class="share-expiry">${icon('clock', {size:14})} Expires: ${new Date(data.expires_at).toLocaleDateString()}</p>
            </div>
        `);
    } catch (e) {
        showToast('Failed to create share link', 'error');
    }
}

// Feature 16: Export session as markdown
async function exportSession(sessionId) {
    closeAllMenus();

    try {
        const response = await fetch(`/api/sessions/${sessionId}/export`, {
            method: 'POST'
        });

        if (!response.ok) {
            showToast('Failed to export session', 'error');
            return;
        }

        const data = await response.json();

        // Create download
        const blob = new Blob([data.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Session exported!');
    } catch (e) {
        showToast('Failed to export session', 'error');
    }
}

// Feature 20: Git Details modal
async function showGitDetails(sessionId) {
    closeAllMenus();

    try {
        const response = await fetch(`/api/sessions/${sessionId}/git`);

        if (!response.ok) {
            if (response.status === 400) {
                showToast('Session has no working directory', 'error');
            } else {
                showToast('Failed to fetch git info', 'error');
            }
            return;
        }

        const data = await response.json();

        // Build modal content
        let statusHtml = '';
        if (data.status) {
            statusHtml = `
                <div class="git-section">
                    <h4>Status</h4>
                    <p><strong>Branch:</strong> <code>${escapeHtml(data.status.branch)}</code></p>
                    <p><strong>Tracking:</strong> ${data.status.ahead} ahead, ${data.status.behind} behind</p>
                </div>
            `;
        }

        let uncommittedHtml = '';
        if (data.status?.has_uncommitted) {
            const modifiedList = data.status.modified.map(f => `<li class="modified">M ${escapeHtml(f)}</li>`).join('');
            const addedList = data.status.added.map(f => `<li class="added">A ${escapeHtml(f)}</li>`).join('');
            const deletedList = data.status.deleted.map(f => `<li class="deleted">D ${escapeHtml(f)}</li>`).join('');
            const untrackedList = data.status.untracked.map(f => `<li class="untracked">? ${escapeHtml(f)}</li>`).join('');

            uncommittedHtml = `
                <div class="git-section">
                    <h4>Uncommitted Changes</h4>
                    <ul class="file-list">
                        ${modifiedList}
                        ${addedList}
                        ${deletedList}
                        ${untrackedList}
                    </ul>
                </div>
            `;
        }

        let commitsHtml = '';
        if (data.commits && data.commits.length > 0) {
            const commitList = data.commits.map(c => `
                <li class="commit-item">
                    <code>${escapeHtml(c.short_sha)}</code>
                    <span class="commit-message">${escapeHtml(c.message)}</span>
                    <span class="commit-meta">${escapeHtml(c.timestamp)} · ${c.files_changed} file${c.files_changed !== 1 ? 's' : ''}</span>
                </li>
            `).join('');

            commitsHtml = `
                <div class="git-section">
                    <h4>Recent Commits</h4>
                    <ul class="commit-list">
                        ${commitList}
                    </ul>
                </div>
            `;
        }

        let prHtml = '';
        if (data.pr) {
            const stateClass = data.pr.state.toLowerCase();
            prHtml = `
                <div class="git-section">
                    <h4>Pull Request</h4>
                    <a href="${escapeHtml(data.pr.url)}" target="_blank" class="pr-link">
                        #${data.pr.number}: ${escapeHtml(data.pr.title)}
                        <span class="pr-state ${stateClass}">${data.pr.state}</span>
                    </a>
                </div>
            `;
        }

        showModal(`
            <div class="git-details">
                <div class="git-details-header">
                    <h3>${icon('git-branch', {size:18})} Git Details</h3>
                    <button onclick="closeModal()" class="modal-close">Close</button>
                </div>
                ${statusHtml}
                ${uncommittedHtml}
                ${commitsHtml}
                ${prHtml}
                ${!data.status ? '<p class="git-empty">Not a git repository</p>' : ''}
            </div>
        `);
    } catch (e) {
        console.error('Failed to fetch git details:', e);
        showToast('Failed to fetch git details', 'error');
    }
}

// Feature 10: Performance Metrics Modal
async function showMetricsModal(sessionId) {
    closeAllMenus();

    try {
        const response = await fetch(`/api/session/${sessionId}/metrics`);

        if (!response.ok) {
            showToast('Failed to fetch metrics', 'error');
            return;
        }

        const metrics = await response.json();

        // Build tool usage list
        const toolListHtml = Object.entries(metrics.toolCalls || {})
            .sort((a, b) => b[1] - a[1])
            .map(([tool, count]) =>
                `<li><span class="tool-name">${escapeHtml(tool)}</span><span class="tool-count">${count}</span></li>`
            ).join('') || '<li class="no-data">No tool calls recorded</li>';

        showModal(`
            <div class="metrics-modal">
                <div class="metrics-modal-header">
                    <h3>${icon('bar-chart-3', {size:18})} Session Metrics</h3>
                    <button onclick="closeModal()" class="modal-close">Close</button>
                </div>

                <div class="metrics-grid">
                    <div class="metrics-section">
                        <h4>${icon('zap', {size:14})} Response Times</h4>
                        <dl class="metrics-stats">
                            <dt>Minimum</dt><dd>${metrics.responseTime.min}s</dd>
                            <dt>Average</dt><dd>${metrics.responseTime.avg}s</dd>
                            <dt>Median</dt><dd>${metrics.responseTime.median}s</dd>
                            <dt>Maximum</dt><dd>${metrics.responseTime.max}s</dd>
                        </dl>
                    </div>

                    <div class="metrics-section">
                        <h4>${icon('wrench', {size:14})} Tool Usage</h4>
                        <ul class="tool-list">
                            ${toolListHtml}
                        </ul>
                        <div class="tool-summary">
                            Total: ${metrics.totalToolCalls} calls (${metrics.toolsPerHour}/hr)
                        </div>
                    </div>

                    <div class="metrics-section">
                        <h4>${icon('trending-up', {size:14})} Session Stats</h4>
                        <dl class="metrics-stats">
                            <dt>Total turns</dt><dd>${metrics.turns}</dd>
                            <dt>Avg tokens/turn</dt><dd>${metrics.avgTokensPerTurn.toLocaleString()}</dd>
                            <dt>Duration</dt><dd>${formatDuration(metrics.durationSeconds)}</dd>
                            <dt>Tools/hour</dt><dd>${metrics.toolsPerHour}</dd>
                        </dl>
                    </div>
                </div>
            </div>
        `);
    } catch (e) {
        console.error('Failed to fetch metrics:', e);
        showToast('Failed to fetch metrics', 'error');
    }
}

function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '--';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
        return `${minutes}m`;
    } else {
        return `${seconds}s`;
    }
}

async function focusWarpTab(session) {
    // Use TTY directly - instant jump, no scanning needed
    if (session.tty) {
        try {
            const response = await fetch('/api/focus-tty', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tty: session.tty })
            });
            const result = await response.json();
            if (result.found) {
                console.log('Jumped to tab', result.tab_index, 'via TTY', session.tty);
                return;
            }
        } catch (error) {
            console.error('TTY focus error:', error);
        }
    }
    console.log('No TTY for session:', session.slug);
}

function updateCard(card, session) {
    const prev = previousSessions.get(session.sessionId);

    // For compact cards, replace entirely to avoid complex partial updates
    if (card.classList.contains('compact')) {
        const index = parseInt(card.querySelector('.card-number')?.textContent || '1') - 1;
        const newCard = createCompactCard(session, index);
        card.replaceWith(newCard);
        return;
    }

    if (!prev || prev.state !== session.state) {
        card.classList.remove('active', 'waiting');
        card.classList.add(session.state);

        // Update activity trail - remove pulse animation when session goes idle
        const lastTrailEmoji = card.querySelector('.trail-emoji:last-child');
        if (lastTrailEmoji) {
            if (session.state === 'active') {
                lastTrailEmoji.classList.add('current');
            } else {
                lastTrailEmoji.classList.remove('current');
            }
        }
    }

    // Update context size
    const contextEl = card.querySelector('.context-size');
    if (contextEl) {
        contextEl.textContent = formatTokens(session.contextTokens);
    }

    // Update token usage bar (Feature 03)
    const tokenUsageEl = card.querySelector('.token-usage');
    if (tokenUsageEl && session.contextTokens) {
        const percentage = Math.min(100, (session.contextTokens / MAX_CONTEXT_TOKENS) * 100);
        let colorClass = 'token-green';
        if (percentage > 80) colorClass = 'token-red';
        else if (percentage > 50) colorClass = 'token-yellow';

        const tokenBar = tokenUsageEl.querySelector('.token-bar');
        const tokenPercentage = tokenUsageEl.querySelector('.token-percentage');
        if (tokenBar) {
            tokenBar.style.width = `${percentage}%`;
            tokenBar.className = `token-bar ${colorClass}`;
        }
        if (tokenPercentage) {
            tokenPercentage.textContent = `${Math.round(percentage)}%`;
        }
        tokenUsageEl.title = `${session.contextTokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens`;
    }

    // Update activity summary log (AI-generated summaries)
    const summaryLogEl = card.querySelector('.activity-summary-log');
    if (summaryLogEl) {
        const newSummaries = session.activitySummaries || [];
        const prevSummaries = prev?.activitySummaries || [];

        // Check if summaries changed (new entries added)
        if (newSummaries.length !== prevSummaries.length) {
            const oldStickyId = summaryLogEl.dataset.stickyScrollId;
            const wasEmpty = summaryLogEl.classList.contains('empty');
            summaryLogEl.outerHTML = renderActivitySummaryLog(newSummaries);
            // Re-query and set up scroll tracking on new element
            const newLogEl = card.querySelector('.activity-summary-log');
            if (newLogEl && !newLogEl.classList.contains('empty')) {
                if (oldStickyId && !wasEmpty) {
                    // Transfer state from destroyed element to new element
                    StickyScroll.transferState(oldStickyId, newLogEl);
                } else {
                    // First time (was empty) - create fresh instance
                    new StickyScroll(newLogEl).attach();
                }
            }
        }
    }

    // Update current activity display (hooks-based real-time activity)
    updateCurrentActivity(card, session, prev);

    // Update meta info (may not exist on all card types)
    const metaEl = card.querySelector('.meta');
    if (metaEl) {
        metaEl.innerHTML = `<span>PID: ${session.pid || '--'}</span>`;
    }

    // Update footer-right with duration and activity badge
    const footerRight = card.querySelector('.footer-right');
    if (footerRight) {
        const duration = formatAgentDuration(session.startTimestamp) || '0m';
        const activityStatus = getActivityStatus(session.lastActivity);
        // Always use activityStatus for consistent display (avoids flicker when state changes)
        const activityBadgeHtml = activityStatus.text
            ? `<span class="idle-badge" style="background: ${activityStatus.color}; color: ${activityStatus.idleMins > 30 ? '#fff' : '#000'}">${activityStatus.text}</span>`
            : '';
        footerRight.innerHTML = `
            <span class="session-duration" title="Session duration">${icon('clock', {size:14})} ${duration}</span>
            ${activityBadgeHtml}
            <button class="metrics-btn" onclick="event.stopPropagation(); showMetricsModal('${escapeJsString(session.sessionId)}')" title="View Metrics">${icon('bar-chart-3', {size:14})}</button>`;
    }

    // Update slug with state emoji
    const slugEl = card.querySelector('.slug');
    if (slugEl) {
        const activityStatus = getActivityStatus(session.lastActivity);
        let stateEmoji = statusDot('active');
        if (session.state !== 'active') {
            stateEmoji = activityStatus.isStale ? statusDot('stale') : statusDot('waiting');
        }
        slugEl.innerHTML = `${stateEmoji} ${escapeHtml(session.slug)}`;
    }
}

// Update current activity element - DISABLED (feature removed, redundant with activity logs)
function updateCurrentActivity(card, session, prev) {
    // No-op - current activity display was removed
}

function formatTime(isoString) {
    if (!isoString) return '--';
    try {
        const diffSec = Math.floor((new Date() - new Date(isoString)) / 1000);
        if (diffSec < 0) return 'just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        return `${Math.floor(diffSec / 3600)}h ago`;
    } catch { return '--'; }
}

function formatTokens(tokens) {
    if (!tokens || tokens === 0) return '--';
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return `${tokens}`;
}

// Feature 03: Token Usage Visualization
const MAX_CONTEXT_TOKENS = 200000;

function formatTokenBar(tokens) {
    if (!tokens || tokens === 0) {
        return `
            <div class="token-usage">
                <span class="token-label">Context:</span>
                <div class="token-bar-container">
                    <div class="token-bar token-green" style="width: 0%"></div>
                </div>
                <span class="token-percentage">--</span>
            </div>
        `;
    }

    const percentage = Math.min(100, (tokens / MAX_CONTEXT_TOKENS) * 100);

    let colorClass = 'token-green';
    if (percentage > 80) colorClass = 'token-red';
    else if (percentage > 50) colorClass = 'token-yellow';

    return `
        <div class="token-usage" title="${tokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens">
            <span class="token-label">Context:</span>
            <div class="token-bar-container">
                <div class="token-bar ${colorClass}" style="width: ${percentage}%"></div>
            </div>
            <span class="token-percentage">${Math.round(percentage)}%</span>
            <span class="token-count">${formatTokens(tokens)}</span>
        </div>
    `;
}

function formatCpu(cpu) {
    if (cpu === null || cpu === undefined) return '--';
    return cpu.toFixed(1);
}

// Convert hooks-based activityLog to format for formatActivityLog
function convertActivityLogForDisplay(activityLog) {
    if (!activityLog || activityLog.length === 0) return null;

    const result = [];
    for (const entry of activityLog) {
        if (entry.event === 'PostToolUse' && entry.tool) {
            result.push({
                text: entry.description || entry.tool,
                timestamp: entry.timestamp
            });
        } else if (entry.event === 'UserPromptSubmit') {
            result.push({
                text: 'User message',
                timestamp: entry.timestamp
            });
        }
    }

    // Return last 15 items
    return result.length > 0 ? result.slice(-15) : null;
}

function formatActivityLog(activities) {
    if (!activities || activities.length === 0) {
        return '<div class="activity-item empty">No recent activity</div>';
    }
    return activities.map(a => {
        // Support both old format (string) and new format ({text, timestamp})
        const text = typeof a === 'string' ? a : a.text;
        const timestamp = typeof a === 'string' ? '' : a.timestamp;
        const timeStr = timestamp ? formatActivityTime(timestamp) : '';
        return `<div class="activity-item">
            ${timeStr ? `<span class="activity-time">${timeStr}</span>` : ''}
            <span class="activity-text">${escapeHtml(text)}</span>
        </div>`;
    }).join('');
}

function formatActivityTime(isoTimestamp) {
    if (!isoTimestamp) return '';
    try {
        const date = new Date(isoTimestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
        return '';
    }
}

// ============================================================================
// ASCII Art Animations for Activity Indicators
// ============================================================================

const ASCII_ANIMATIONS = {
    // Reading files - scanning eye
    read: {
        frames: ['[▓░░░]', '[░▓░░]', '[░░▓░]', '[░░░▓]', '[░░▓░]', '[░▓░░]'],
        interval: 150
    },
    // Writing/Editing - typing cursor
    write: {
        frames: ['█_', '_█', '█_', '_█'],
        interval: 400
    },
    // Searching - magnifying sweep
    search: {
        frames: ['◎··', '·◎·', '··◎', '·◎·'],
        interval: 200
    },
    // Bash commands - terminal cursor
    bash: {
        frames: ['>_', '>█', '>_', '>█'],
        interval: 500
    },
    // Thinking/Processing - braille spinner
    thinking: {
        frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
        interval: 80
    },
    // Agent spawning - robot assembly
    agent: {
        frames: ['[□]', '[▣]', '[■]', '[▣]'],
        interval: 250
    },
    // Waiting - breathing pulse
    waiting: {
        frames: ['○', '◎', '●', '◎'],
        interval: 300
    },
    // WebFetch - network waves
    network: {
        frames: ['◌─○', '○─◌', '◌─○', '○─◌'],
        interval: 300
    },
    // MCP tools - plugin pulse
    mcp: {
        frames: ['✧', '✦', '✧', '✦'],
        interval: 400
    },
    // Default - simple spinner
    default: {
        frames: ['◐', '◓', '◑', '◒'],
        interval: 150
    }
};

// Track animation state per session
const animationState = new Map();

// Get animation type from activity
function getAnimationType(activity) {
    if (!activity) return 'waiting';

    const toolName = activity.tool_name || '';

    if (toolName === 'Bash') return 'bash';
    if (toolName === 'Read') return 'read';
    if (toolName === 'Write' || toolName === 'Edit') return 'write';
    if (toolName === 'Grep' || toolName === 'Glob') return 'search';
    if (toolName === 'Task') return 'agent';
    if (toolName === 'WebFetch') return 'network';
    if (toolName.startsWith('mcp__')) return 'mcp';

    if (activity.type === 'tool_use') return 'thinking';
    if (activity.type === 'user_prompt') return 'waiting';
    if (activity.type === 'idle') return 'waiting';

    return 'default';
}

// Get current animation frame for a session
function getAnimationFrame(sessionId, activity) {
    const animType = getAnimationType(activity);
    const anim = ASCII_ANIMATIONS[animType];

    // Initialize or get animation state
    let state = animationState.get(sessionId);
    if (!state || state.type !== animType) {
        state = { type: animType, frameIndex: 0, lastUpdate: Date.now() };
        animationState.set(sessionId, state);
    }

    // Check if it's time to advance frame
    const now = Date.now();
    if (now - state.lastUpdate >= anim.interval) {
        state.frameIndex = (state.frameIndex + 1) % anim.frames.length;
        state.lastUpdate = now;
        animationState.set(sessionId, state);
    }

    return anim.frames[state.frameIndex];
}

// Render animated activity indicator
function renderAnimatedActivity(sessionId, activity) {
    const frame = getAnimationFrame(sessionId, activity);
    return `<span class="ascii-animation" data-session="${sessionId}">${frame}</span>`;
}

// Start animation loop for active sessions
let animationLoopRunning = false;
function startAnimationLoop() {
    if (animationLoopRunning) return;
    animationLoopRunning = true;

    function tick() {
        // Update all visible animations
        document.querySelectorAll('.ascii-animation').forEach(el => {
            const sessionId = el.dataset.session;
            const session = previousSessions.get(sessionId);
            if (session && session.currentActivity && session.state === 'active') {
                const frame = getAnimationFrame(sessionId, session.currentActivity);
                if (el.textContent !== frame) {
                    el.textContent = frame;
                }
            }
        });

        // Continue loop if there are active animations
        if (document.querySelectorAll('.ascii-animation').length > 0) {
            requestAnimationFrame(tick);
        } else {
            animationLoopRunning = false;
        }
    }

    requestAnimationFrame(tick);
}

// Clean up animation state for removed sessions
function cleanupAnimationState(activeSessionIds) {
    for (const sessionId of animationState.keys()) {
        if (!activeSessionIds.has(sessionId)) {
            animationState.delete(sessionId);
        }
    }
}

// ============================================================================
// Emoji Activity Trail - Visual history of what Claude did
// ============================================================================


// Convert activity log to emoji trail (deduplicated, only showing completed actions)
function buildEmojiTrail(activityLog, maxLength = 30) {
    if (!activityLog || activityLog.length === 0) return [];

    const trail = [];
    let lastTool = null;

    for (const entry of activityLog) {
        // Only count PostToolUse (completed tools) and UserPromptSubmit
        if (entry.event === 'PostToolUse' && entry.tool) {
            // Skip if same tool repeated consecutively
            if (entry.tool !== lastTool) {
                trail.push({
                    emoji: toolIcon(entry.tool, 14),
                    tool: entry.tool,
                    description: entry.description || entry.tool,
                    timestamp: entry.timestamp
                });
                lastTool = entry.tool;
            }
        } else if (entry.event === 'UserPromptSubmit') {
            // User prompt marks a new "chapter" - reset dedup
            trail.push({
                emoji: toolIcon('UserPromptSubmit', 14),
                tool: 'User prompt',
                description: 'New user message',
                timestamp: entry.timestamp,
                isPrompt: true
            });
            lastTool = null;
        }
    }

    // Return last N items
    return trail.slice(-maxLength);
}

// Render the emoji trail as HTML with clickable popovers
function renderEmojiTrail(activityLog, isSessionActive = false) {
    const trail = buildEmojiTrail(activityLog);

    if (trail.length === 0) {
        return `
            <div class="activity-trail">
                <span class="trail-label">Activity:</span>
                <div class="trail-emojis empty"></div>
            </div>
        `;
    }

    const emojisHtml = trail.map((item, idx) => {
        const isLast = idx === trail.length - 1;
        const isPrompt = item.isPrompt;
        // Only pulse the last emoji if the session is actively working
        const classes = [
            'trail-emoji',
            (isLast && isSessionActive) ? 'current' : '',
            isPrompt ? 'prompt-marker' : ''
        ].filter(Boolean).join(' ');

        // Encode data for the tooltip
        const dataAttrs = `data-tool="${escapeHtml(item.tool)}" data-desc="${escapeHtml(item.description)}" data-time="${escapeHtml(item.timestamp || '')}"`;

        return `<span class="${classes}" ${dataAttrs} onmouseenter="showActivityTooltip(event, this)" onmouseleave="hideActivityTooltip()">${item.emoji}</span>`;
    }).join('');

    return `
        <div class="activity-trail">
            <span class="trail-label">Activity:</span>
            <div class="trail-emojis">${emojisHtml}</div>
        </div>
    `;
}

// Render expandable tool history panel
function renderToolHistoryPanel(sessionId) {
    return `
        <div class="tool-history-container" data-session-id="${escapeHtml(sessionId)}">
            <button class="tool-history-toggle" onclick="toggleToolHistory('${escapeJsString(sessionId)}')">
                <span class="toggle-icon">▶</span>
                <span class="toggle-label">View Tool Details</span>
                <span class="tool-error-badge hidden" title="Failed tools"></span>
            </button>
            <div class="tool-history-panel hidden"></div>
        </div>
    `;
}

// Toggle tool history panel visibility
async function toggleToolHistory(sessionId) {
    const container = document.querySelector(`.tool-history-container[data-session-id="${sessionId}"]`);
    if (!container) return;

    const panel = container.querySelector('.tool-history-panel');
    const toggle = container.querySelector('.tool-history-toggle');
    const icon = toggle.querySelector('.toggle-icon');

    if (panel.classList.contains('hidden')) {
        // Show panel and fetch data
        panel.classList.remove('hidden');
        icon.textContent = '▼';
        panel.innerHTML = '<div class="loading">Loading tool history...</div>';

        try {
            const response = await fetch(`/api/session/${sessionId}/tools?limit=100`);
            if (!response.ok) throw new Error('Failed to fetch tool history');

            const data = await response.json();
            renderToolHistoryContent(panel, data.tools);
        } catch (err) {
            panel.innerHTML = `<div class="error">Failed to load tool history: ${escapeHtml(err.message)}</div>`;
        }
    } else {
        // Hide panel
        panel.classList.add('hidden');
        icon.textContent = '▶';
    }
}

// Render tool history content inside the panel
function renderToolHistoryContent(panel, tools) {
    if (!tools || tools.length === 0) {
        panel.innerHTML = '<div class="tool-history-empty">No tool history available</div>';
        return;
    }

    const errorCount = tools.filter(t => t.is_error).length;
    const container = panel.closest('.tool-history-container');
    const badge = container?.querySelector('.tool-error-badge');

    if (badge && errorCount > 0) {
        badge.textContent = `${errorCount} failed`;
        badge.classList.remove('hidden');
    }

    const toolsHtml = tools.map((tool, idx) => {
        const isError = tool.is_error;
        const toolName = tool.name || 'Unknown';
        const timestamp = tool.timestamp ? formatActivityTime(tool.timestamp) : '';

        // Get summary for the tool
        const summary = getToolSummaryText(tool);

        // Format input (truncated for display)
        const inputStr = formatToolInput(tool);

        // Format output (truncated)
        const output = tool.output || '';
        const outputTruncated = output.length > 500 ? output.slice(0, 500) + '...' : output;

        return `
            <div class="tool-history-item ${isError ? 'error' : ''}" data-tool-idx="${idx}">
                <div class="tool-item-header" onclick="toggleToolItemExpand(this)">
                    <span class="tool-status-icon">${isError ? icon('x-circle', {size:14}) : icon('check-circle', {size:14})}</span>
                    <span class="tool-name">${escapeHtml(toolName)}</span>
                    <span class="tool-summary">${escapeHtml(summary)}</span>
                    <span class="tool-time">${timestamp}</span>
                    <span class="tool-expand-icon">▶</span>
                </div>
                <div class="tool-item-details hidden">
                    ${inputStr ? `
                        <div class="tool-input">
                            <div class="detail-label">Input:</div>
                            <pre class="detail-content">${escapeHtml(inputStr)}</pre>
                        </div>
                    ` : ''}
                    <div class="tool-output ${isError ? 'error-output' : ''}">
                        <div class="detail-label">Output${isError ? ' (Error)' : ''}:</div>
                        <pre class="detail-content">${escapeHtml(outputTruncated)}</pre>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    panel.innerHTML = `
        <div class="tool-history-list">
            ${errorCount > 0 ? `<div class="tool-error-summary">${errorCount} tool${errorCount > 1 ? 's' : ''} failed</div>` : ''}
            ${toolsHtml}
        </div>
    `;
}

// Toggle individual tool item expansion
function toggleToolItemExpand(header) {
    const item = header.closest('.tool-history-item');
    const details = item.querySelector('.tool-item-details');
    const icon = header.querySelector('.tool-expand-icon');

    if (details.classList.contains('hidden')) {
        details.classList.remove('hidden');
        icon.textContent = '▼';
    } else {
        details.classList.add('hidden');
        icon.textContent = '▶';
    }
}

// Get summary text for a tool
function getToolSummaryText(tool) {
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

// Format tool input for display
function formatToolInput(tool) {
    const name = tool.name || '';
    const input = tool.input || {};

    if (name === 'Bash') {
        return input.command || '';
    } else if (name === 'Read') {
        return input.file_path || '';
    } else if (name === 'Write') {
        return `${input.file_path || ''}\n---\n${(input.content || '').slice(0, 200)}${input.content?.length > 200 ? '...' : ''}`;
    } else if (name === 'Edit') {
        return `${input.file_path || ''}\n---\nold: ${(input.old_string || '').slice(0, 100)}\nnew: ${(input.new_string || '').slice(0, 100)}`;
    } else if (name === 'Grep') {
        return `pattern: ${input.pattern || ''}\npath: ${input.path || '.'}`;
    } else if (name === 'Glob') {
        return `pattern: ${input.pattern || ''}\npath: ${input.path || '.'}`;
    } else if (name === 'WebFetch') {
        return input.url || '';
    }

    // Generic: show full input as JSON
    try {
        return JSON.stringify(input, null, 2);
    } catch {
        return String(input);
    }
}

// Show tooltip with activity details on hover
function showActivityTooltip(event, element) {
    // Remove any existing tooltip
    hideActivityTooltip();

    const tool = element.dataset.tool;
    const desc = element.dataset.desc;
    const time = element.dataset.time;
    const formattedTime = formatActivityTime(time);

    // Create tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'activity-tooltip';
    tooltip.id = 'activity-tooltip';
    tooltip.innerHTML = `
        <div class="tooltip-header">${element.textContent} ${escapeHtml(tool)}</div>
        <div class="tooltip-desc">${escapeHtml(desc)}</div>
        ${formattedTime ? `<div class="tooltip-time">${formattedTime}</div>` : ''}
    `;

    // Position tooltip near the element
    document.body.appendChild(tooltip);
    const rect = element.getBoundingClientRect();

    // Position above the element by default, below if not enough space
    const tooltipHeight = tooltip.offsetHeight;
    const spaceAbove = rect.top;

    if (spaceAbove > tooltipHeight + 10) {
        tooltip.style.left = `${rect.left + window.scrollX}px`;
        tooltip.style.top = `${rect.top + window.scrollY - tooltipHeight - 6}px`;
    } else {
        tooltip.style.left = `${rect.left + window.scrollX}px`;
        tooltip.style.top = `${rect.bottom + window.scrollY + 6}px`;
    }
}

function hideActivityTooltip() {
    const tooltip = document.getElementById('activity-tooltip');
    if (tooltip) tooltip.remove();
}

// Get icon for current activity based on activity type/tool (fallback for non-animated contexts)
function getActivityIcon(activity) {
    if (!activity) return icon('play', {size: 14});
    const toolName = activity.tool_name || '';
    if (toolName) return toolIcon(toolName, 14);
    if (activity.type === 'tool_use') return icon('settings', {size: 14});
    if (activity.type === 'user_prompt') return icon('message-circle', {size: 14});
    if (activity.type === 'idle') return icon('pause', {size: 14});
    return icon('play', {size: 14});
}

// Get icon for agent type
function getAgentTypeIcon(subagentType) {
    return getSubagentTypeIcon(subagentType);
}

// Format duration from ISO timestamp to human-readable
function formatAgentDuration(startedAt) {
    if (!startedAt) return '';
    try {
        const start = new Date(startedAt);
        const now = new Date();
        const diffMs = now - start;
        const diffMins = Math.floor(diffMs / 60000);
        const diffSecs = Math.floor((diffMs % 60000) / 1000);

        if (diffMins >= 60) {
            const hours = Math.floor(diffMins / 60);
            const mins = diffMins % 60;
            return `${hours}h ${mins}m`;
        }
        if (diffMins > 0) {
            return `${diffMins}m ${diffSecs}s`;
        }
        return `${diffSecs}s`;
    } catch {
        return '';
    }
}

/**
 * Compute idle badge color as gradient from green → yellow → orange → red
 * @param {number} idleMins - minutes idle
 * @returns {string} - CSS color value
 */
function getIdleColor(idleMins) {
    // 0-5 min: bright green
    // 5-20 min: green → yellow
    // 20-40 min: yellow → orange
    // 40-60 min: orange → red
    // 60+ min: red

    if (idleMins <= 5) {
        return '#4ade80'; // bright green
    } else if (idleMins <= 20) {
        // Green to yellow (hue 120 → 60)
        const t = (idleMins - 5) / 15;
        const hue = 120 - (t * 60); // 120 (green) to 60 (yellow)
        return `hsl(${hue}, 85%, 55%)`;
    } else if (idleMins <= 40) {
        // Yellow to orange (hue 60 → 30)
        const t = (idleMins - 20) / 20;
        const hue = 60 - (t * 30); // 60 (yellow) to 30 (orange)
        return `hsl(${hue}, 90%, 50%)`;
    } else if (idleMins <= 60) {
        // Orange to red (hue 30 → 0)
        const t = (idleMins - 40) / 20;
        const hue = 30 - (t * 30); // 30 (orange) to 0 (red)
        return `hsl(${hue}, 90%, 50%)`;
    } else {
        return '#ef4444'; // red
    }
}

// Format activity status based on lastActivity timestamp
// Returns { isActive: bool, text: string, class: string, color: string, idleMins: number }
function getActivityStatus(lastActivity) {
    if (!lastActivity) return { isActive: false, isStale: false, text: '', class: '', color: '', idleMins: 0 };
    try {
        const last = new Date(lastActivity);
        const now = new Date();
        const diffMs = now - last;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffMs / 60000);

        // Active if activity within last 60 seconds
        if (diffSecs < 60) {
            return {
                isActive: true,
                isStale: false,
                text: diffSecs < 5 ? 'just now' : `${diffSecs}s active`,
                class: 'active-indicator',
                color: '#4ade80',
                idleMins: 0
            };
        }

        // Idle: use gradient color based on idle time
        const color = getIdleColor(diffMins);

        if (diffMins < 60) {
            return {
                isActive: false,
                isStale: diffMins > 15,
                text: `${diffMins}m idle`,
                class: 'idle-badge',
                color: color,
                idleMins: diffMins
            };
        }

        // Idle: >= 1 hour
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        return {
            isActive: false,
            isStale: true,
            text: `${hours}h ${mins}m idle`,
            class: 'idle-badge',
            color: color,
            idleMins: diffMins
        };
    } catch {
        return { isActive: false, isStale: false, text: '', class: '', color: '', idleMins: 0 };
    }
}

// Backwards-compatible wrapper
function formatIdleTime(lastActivity) {
    const status = getActivityStatus(lastActivity);
    return status.isActive ? '' : status.text;
}

// Render agent tree for session card
function renderAgentTree(agents) {
    if (!agents || agents.length === 0) return '';

    // Always start collapsed to keep cards compact - user can expand if needed
    const collapsed = 'collapsed';

    return `
        <div class="agent-tree">
            <div class="tree-header ${collapsed}" onclick="toggleAgentTree(this)">
                <span class="tree-toggle">▼</span>
                <span class="tree-label">${icon('bot', {size:14})} ${agents.length} agent${agents.length > 1 ? 's' : ''}</span>
            </div>
            <div class="tree-children" ${collapsed ? 'style="display:none"' : ''}>
                ${agents.map((agent, idx) => `
                    <div class="tree-node ${agent.status}">
                        <span class="tree-connector">${idx === agents.length - 1 ? '└─' : '├─'}</span>
                        <span class="agent-type">${getAgentTypeIcon(agent.subagent_type)}</span>
                        <span class="agent-desc" title="${escapeHtml(agent.description || '')}">${escapeHtml(agent.description || agent.subagent_type || 'Agent')}</span>
                        <span class="agent-status ${agent.status}">${agent.status}${agent.background ? ` ${icon('zap', {size:12})}` : ''}</span>
                        <span class="agent-duration">${formatAgentDuration(agent.started_at)}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// Toggle agent tree visibility
function toggleAgentTree(header) {
    header.classList.toggle('collapsed');
    const children = header.nextElementSibling;
    if (children) {
        children.style.display = header.classList.contains('collapsed') ? 'none' : 'block';
    }
}

// Format duration in seconds to human-readable string
function formatDurationSeconds(seconds) {
    if (!seconds || seconds < 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m ${secs}s`;
    }
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
}

// Render background shells for session card
function renderBackgroundShells(shells) {
    if (!shells || shells.length === 0) return '';

    // Always start collapsed
    const collapsed = 'collapsed';

    return `
        <div class="background-shells">
            <div class="shells-header ${collapsed}" onclick="toggleAgentTree(this)">
                <span class="tree-toggle">▼</span>
                <span class="shells-label">${icon('monitor', {size:14})} ${shells.length} background${shells.length > 1 ? ' tasks' : ' task'}</span>
            </div>
            <div class="tree-children" style="display:none">
                ${shells.map((shell, idx) => `
                    <div class="tree-node ${shell.computed_status}" title="${escapeHtml(shell.command || '')}">
                        <span class="tree-connector">${idx === shells.length - 1 ? '└─' : '├─'}</span>
                        <span class="shell-icon">${icon('settings', {size:14})}</span>
                        <span class="agent-desc">${escapeHtml(shell.description || 'Background task')}</span>
                        <span class="agent-status ${shell.computed_status}">${shell.computed_status}</span>
                        <span class="agent-duration">${formatDurationSeconds(shell.duration_seconds)}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Escape a string for safe use inside JavaScript string literals (onclick handlers).
 * Unlike escapeHtml() which escapes HTML entities, this escapes JS string delimiters.
 * @param {string} str - The string to escape
 * @returns {string} - The escaped string safe for JS string contexts
 */
function escapeJsString(str) {
    return String(str)
        .replace(/\\/g, '\\\\')     // Backslashes first
        .replace(/'/g, "\\'")       // Single quotes
        .replace(/"/g, '\\"')       // Double quotes
        .replace(/\n/g, '\\n')      // Newlines
        .replace(/\r/g, '\\r')      // Carriage returns
        .replace(/\t/g, '\\t');     // Tabs
}

/**
 * Parse task notification XML blocks and render as styled cards
 * @param {string} content - Raw content that may contain <task-notification> blocks
 * @returns {string} - HTML with task notifications rendered as styled cards
 */
function parseTaskNotifications(content) {
    // Normalize literal \n to actual newlines for regex matching
    const normalized = content.replace(/\\n/g, '\n');

    // Check if content is primarily a task notification (starts with it or very short preamble)
    // This prevents matching example XML inside long plan documents
    const notificationStart = normalized.indexOf('<task-notification>');
    if (notificationStart > 100) {
        // Task notification is too far into the content - likely an example in documentation
        return null;
    }

    // Flexible regex to match task-notification blocks with various field orders
    const notificationRegex = /<task-notification>\s*([\s\S]*?)<\/task-notification>/g;

    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = notificationRegex.exec(normalized)) !== null) {
        // Skip if this appears to be inside a code block (preceded by ```)
        const textBefore = normalized.slice(0, match.index);
        const codeBlockCount = (textBefore.match(/```/g) || []).length;
        if (codeBlockCount % 2 === 1) {
            // Inside a code block - skip this match
            continue;
        }

        // Add escaped text before this notification
        if (match.index > lastIndex) {
            const textBeforeNotif = normalized.slice(lastIndex, match.index).trim();
            if (textBeforeNotif) {
                parts.push(`<div class="task-notification-text">${escapeHtml(textBeforeNotif)}</div>`);
            }
        }

        const innerContent = match[1];

        // Extract fields flexibly
        const taskIdMatch = innerContent.match(/<task-id>([^<]*)<\/task-id>/);
        const statusMatch = innerContent.match(/<status>([^<]*)<\/status>/);
        const summaryMatch = innerContent.match(/<summary>([^<]*)<\/summary>/);
        const resultMatch = innerContent.match(/<result>([\s\S]*?)<\/result>/);
        const outputFileMatch = innerContent.match(/<output-file>([^<]*)<\/output-file>/);

        const taskId = taskIdMatch ? taskIdMatch[1].trim() : 'unknown';
        const status = statusMatch ? statusMatch[1].trim() : 'pending';
        const summary = summaryMatch ? summaryMatch[1].trim() : 'Task notification';
        const resultText = resultMatch ? resultMatch[1].trim() : '';
        const outputFile = outputFileMatch ? outputFileMatch[1].trim() : '';

        const statusIcon = status === 'completed' ? icon('check-circle', {size:14}) : status === 'failed' ? icon('x-circle', {size:14}) : icon('hourglass', {size:14});
        const statusClass = status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'pending';

        // Create styled notification card
        const card = `<div class="task-notification ${statusClass}">
            <div class="task-notification-header">
                <span class="task-notification-icon">${statusIcon}</span>
                <span class="task-notification-summary">${escapeHtml(summary)}</span>
                <span class="task-notification-id">${escapeHtml(taskId.slice(0,7))}</span>
            </div>
            ${resultText ? `<div class="task-notification-result">${escapeHtml(resultText.slice(0, 300))}${resultText.length > 300 ? '...' : ''}</div>` : ''}
            ${outputFile ? `<div class="task-notification-output">Output: ${escapeHtml(outputFile.split('/').pop())}</div>` : ''}
        </div>`;

        parts.push(card);
        lastIndex = match.index + match[0].length;
    }

    // Add any remaining text after the last notification
    if (lastIndex < normalized.length) {
        const textAfter = normalized.slice(lastIndex).trim();
        if (textAfter) {
            parts.push(`<div class="task-notification-text">${escapeHtml(textAfter)}</div>`);
        }
    }

    return parts.length > 0 ? parts.join('') : null;
}


function updateStatus(activeCount, totalCount, timestamp) {
    const label = activeCount > 0
        ? `${activeCount} active, ${totalCount - activeCount} waiting`
        : `${totalCount} session${totalCount !== 1 ? 's' : ''}`;
    document.getElementById('session-count').textContent = label;
    try {
        document.getElementById('last-update').textContent = `Updated: ${new Date(timestamp).toLocaleTimeString()}`;
    } catch {}
}


// ============================================================================
// Session Graveyard - View dead/ended sessions
// ============================================================================

let graveyardData = { regular: [] };
let graveyardSearchActive = false;

/**
 * Search graveyard sessions by text query
 */
async function searchGraveyard() {
    const searchInput = document.getElementById('graveyard-search');
    const container = document.getElementById('graveyard-container');
    const countEl = document.getElementById('graveyard-count');
    const rangeSelect = document.getElementById('graveyard-range-select');
    const clearBtn = document.getElementById('graveyard-clear-search');
    const searchContent = document.getElementById('graveyard-search-content')?.checked || false;

    if (!container || !searchInput) return;

    const query = searchInput.value.trim();
    if (!query) {
        clearGraveyardSearch();
        return;
    }

    const hours = rangeSelect ? parseInt(rangeSelect.value) : 168;
    graveyardSearchActive = true;

    container.innerHTML = '<div class="graveyard-loading">Searching...</div>';
    clearBtn?.classList.remove('hidden');

    try {
        const response = await fetch(`/api/sessions/graveyard/search?q=${encodeURIComponent(query)}&hours=${hours}&content=${searchContent}`);
        if (!response.ok) throw new Error('Search failed');

        const data = await response.json();
        graveyardData = data;

        if (countEl) {
            countEl.textContent = `${data.count} match${data.count !== 1 ? 'es' : ''} for "${query}"`;
        }

        renderGraveyard(data, true);
    } catch (error) {
        console.error('Graveyard search failed:', error);
        container.innerHTML = '<div class="graveyard-error">Search failed</div>';
    }
}

/**
 * Clear graveyard search and restore normal view
 */
function clearGraveyardSearch() {
    const searchInput = document.getElementById('graveyard-search');
    const clearBtn = document.getElementById('graveyard-clear-search');

    if (searchInput) searchInput.value = '';
    clearBtn?.classList.add('hidden');
    graveyardSearchActive = false;

    refreshGraveyard();
}

/**
 * Refresh the graveyard view with dead sessions
 */
async function refreshGraveyard() {
    const container = document.getElementById('graveyard-container');
    const countEl = document.getElementById('graveyard-count');
    const rangeSelect = document.getElementById('graveyard-range-select');

    if (!container) return;

    const hours = rangeSelect ? parseInt(rangeSelect.value) : 24;

    container.innerHTML = '<div class="graveyard-loading">Loading dead sessions...</div>';

    try {
        const response = await fetch(`/api/sessions/graveyard?hours=${hours}`);
        if (!response.ok) throw new Error('Failed to fetch graveyard data');

        const data = await response.json();
        graveyardData = data;

        if (countEl) {
            countEl.textContent = `${data.count} session${data.count !== 1 ? 's' : ''}`;
        }

        renderGraveyard(data);
    } catch (error) {
        console.error('Failed to load graveyard:', error);
        container.innerHTML = '<div class="graveyard-error">Failed to load dead sessions</div>';
    }
}

/**
 * Render the graveyard with grouped sessions
 * @param {Object} data - Graveyard data with sessions
 * @param {boolean} isSearch - Whether this is a search result
 */
function renderGraveyard(data, isSearch = false) {
    const container = document.getElementById('graveyard-container');
    if (!container) return;

    if (data.count === 0) {
        const emptyMsg = isSearch
            ? `No sessions found matching "${escapeHtml(data.query || '')}"`
            : 'No dead sessions in this time range';
        container.innerHTML = `<div class="graveyard-empty">${emptyMsg}</div>`;
        return;
    }

    let html = '';

    // Regular sessions section
    if (data.regular.length > 0) {
        const regularGroups = groupGraveyardByRepo(data.regular);
        html += '<div class="graveyard-section">';
        html += `<div class="graveyard-section-header">${icon('folder', {size:14})} Regular Sessions</div>`;

        for (const group of regularGroups) {
            html += `
                <div class="graveyard-group">
                    <div class="graveyard-group-header">${escapeHtml(group.name)}</div>
                    <div class="graveyard-group-sessions">
                        ${group.sessions.map(s => renderGraveyardCard(s)).join('')}
                    </div>
                </div>
            `;
        }
        html += '</div>';
    }

    container.innerHTML = html;

    // Attach click handlers
    container.querySelectorAll('.graveyard-card').forEach(card => {
        card.addEventListener('click', () => {
            const sessionId = card.dataset.sessionId;
            showGraveyardDetails(sessionId);
        });
    });
}

/**
 * Group graveyard sessions by repo/project
 */
function groupGraveyardByRepo(sessions) {
    const groups = {};

    for (const session of sessions) {
        const cwd = session.cwd || '';
        const parts = cwd.split('/').filter(Boolean);
        let repoName = session.slug || 'Unknown';

        // Extract repo name from path
        if (parts.length >= 3 && parts[0] === 'Users') {
            repoName = parts[2];
        }

        if (!groups[repoName]) {
            groups[repoName] = { name: repoName, sessions: [] };
        }
        groups[repoName].sessions.push(session);
    }

    // Sort by most recent session in each group
    return Object.values(groups).sort((a, b) => {
        const aRecent = Math.min(...a.sessions.map(s => s.recency || Infinity));
        const bRecent = Math.min(...b.sessions.map(s => s.recency || Infinity));
        return aRecent - bRecent;
    });
}

/**
 * Render a single graveyard card
 */
function renderGraveyardCard(session) {
    // Show branch name or short session ID (repo name is already in group header)
    const displayName = session.gitBranch || session.sessionId.slice(0, 8);
    const contextPct = Math.round(session.tokenPercentage || 0);
    const duration = formatAgentDuration(session.startTimestamp) || '?';

    // Format ended time
    const endedAgo = formatRecency(session.recency);

    // Summary preview or match snippets (for search results)
    let previewContent = '';
    if (session.matchSnippets && session.matchSnippets.length > 0) {
        // Show match snippets for search results
        const snippetHtml = session.matchSnippets
            .map(s => `<div class="match-snippet">${escapeHtml(s)}</div>`)
            .join('');
        const matchTypes = (session.matchType || []).join(', ');
        previewContent = `
            <div class="graveyard-matches">
                <div class="match-types">${icon('map-pin', {size:14})} Found in: ${escapeHtml(matchTypes)}</div>
                ${snippetHtml}
            </div>
        `;
    } else if (session.focusSummary || session.summary) {
        // Show focus summary (3-5 words) or longer summary
        const summaryText = session.focusSummary || session.summary.substring(0, 200);
        const truncated = !session.focusSummary && session.summary && session.summary.length > 200 ? '...' : '';
        const summaryClass = session.focusSummary ? 'graveyard-focus-summary' : 'graveyard-summary';
        previewContent = `<div class="${summaryClass}">${escapeHtml(summaryText)}${truncated}</div>`;
    } else if (session.hasActivityLog && session.activityLog && session.activityLog.length > 0) {
        // Fallback: show most recent activity description if no summary
        const postEvents = session.activityLog.filter(a => a.event === 'PostToolUse' && a.description);
        if (postEvents.length > 0) {
            const lastActivity = postEvents[postEvents.length - 1];
            const activityDesc = lastActivity.description || `Used ${lastActivity.tool}`;
            previewContent = `<div class="graveyard-summary" title="Most recent activity">${escapeHtml(activityDesc.substring(0, 150))}${activityDesc.length > 150 ? '...' : ''}</div>`;
        }
    }

    // Activity log section (if available) - show emoji trail
    let activityLogContent = '';
    if (session.hasActivityLog && session.activityLog && session.activityLog.length > 0) {
        // Filter to only PostToolUse events (more informative)
        const postEvents = session.activityLog.filter(a => a.event === 'PostToolUse');
        const recentActivities = postEvents.slice(-10); // Last 10 activities for row layout
        const activityHtml = recentActivities
            .map(a => {
                const toolIconHtml = toolIcon(a.tool || 'unknown', 14);
                const desc = a.description || a.tool || 'Activity';
                return `<span class="activity-item" title="${escapeHtml(desc)}">${toolIconHtml}</span>`;
            })
            .join('');
        activityLogContent = `
            <div class="graveyard-activity-log">
                <div class="activity-trail">${activityHtml}</div>
                <span class="activity-count">${postEvents.length}</span>
            </div>
        `;
    }

    return `
        <div class="graveyard-card${session.matchSnippets ? ' search-match' : ''}${session.hasActivityLog ? ' has-activity' : ''}" data-session-id="${session.sessionId}">
            <div class="graveyard-card-header">
                <span class="graveyard-name">${icon('skull', {size:14})} ${escapeHtml(displayName)}</span>
                <span class="graveyard-ended">${endedAgo}</span>
            </div>
            <div class="graveyard-card-meta">
                <span>${duration}</span>
                <span>${contextPct}% ctx</span>
            </div>
            ${previewContent}
            ${activityLogContent}
            <div class="graveyard-card-actions">
                <button class="graveyard-btn" onclick="event.stopPropagation(); takeOverSession('${escapeJsString(session.sessionId)}', '${escapeJsString(session.cwd || '')}')" title="Take over this session in the browser">
                    ${icon('play', {size:14})} Take Over
                </button>
            </div>
        </div>
    `;
}

/**
 * Format recency (seconds ago) to human-readable string
 */
function formatRecency(recencySeconds) {
    if (!recencySeconds) return 'unknown';

    const mins = Math.floor(recencySeconds / 60);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);

    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ${mins % 60}m ago`;
    return `${days}d ${hours % 24}h ago`;
}

/**
 * Show detailed modal for a graveyard session
 */
function showGraveyardDetails(sessionId) {
    const session = graveyardData.regular.find(s => s.sessionId === sessionId);
    if (!session) return;

    const displayName = session.cwd ? session.cwd.split('/').pop() : session.slug;
    const endedAgo = formatRecency(session.recency);

    showModal(`
        <div class="graveyard-details">
            <button class="modal-close-x" onclick="closeModal()" title="Close (Esc)">&times;</button>
            <h2>${icon('skull', {size:18})} ${escapeHtml(displayName)}</h2>
            <div class="graveyard-details-meta">
                <p><strong>Session ID:</strong> <code>${session.sessionId}</code></p>
                <p><strong>Ended:</strong> ${endedAgo}</p>
                <p><strong>Duration:</strong> ${formatAgentDuration(session.startTimestamp) || 'Unknown'}</p>
                <p><strong>Context:</strong> ${Math.round(session.tokenPercentage || 0)}%</p>
                <p><strong>Working Directory:</strong> <code>${escapeHtml(session.cwd || 'Unknown')}</code></p>
                ${session.gitBranch ? `<p><strong>Branch:</strong> ${escapeHtml(session.gitBranch)}</p>` : ''}
            </div>

            ${session.summary ? `
                <div class="graveyard-details-summary">
                    <h3>Summary</h3>
                    <p>${escapeHtml(session.summary)}</p>
                </div>
            ` : ''}

            <div class="graveyard-details-actions">
                <button class="btn-primary" onclick="takeOverSession('${escapeJsString(session.sessionId)}', '${escapeJsString(session.cwd || '')}')">
                    ${icon('play', {size:14})} Take Over Session
                </button>
                <button class="btn-secondary" onclick="openJsonl('${escapeJsString(session.sessionId)}')">
                    ${icon('folder-open', {size:14})} Open JSONL File
                </button>
            </div>
        </div>
    `);
}

/**
 * Take over a session (active or dead) via the takeover endpoint.
 * Kills the terminal process (if alive), spawns a stream subprocess with --resume.
 * @param {string} sessionId - Claude session ID
 * @param {string} [cwd] - Working directory (optional, for graveyard sessions)
 */
async function takeOverSession(sessionId, cwd) {
    try {
        // Check SDK availability
        const sdkResponse = await fetch('/api/sdk-mode');
        const sdkMode = await sdkResponse.json();

        if (!sdkMode.sdk_available) {
            copyResumeCmd(sessionId, cwd);
            showToast('SDK not available - command copied to clipboard', 'info');
            return;
        }

        showToast('Taking over session...', 'info');

        // Call takeover endpoint (handles kill + spawn)
        const response = await fetch(`/api/session/${sessionId}/takeover`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fork: false })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || 'Takeover failed');
        }

        const data = await response.json();
        const processId = data.process_id;
        const sessionCwd = data.cwd || cwd || '/tmp';

        // Close graveyard modal if open
        closeModal();

        // Add to managed processes
        managedProcesses.set(processId, {
            id: processId,
            cwd: sessionCwd,
            state: 'running',
            isSDK: true,
            ws: null,
            outputBuffer: `<div class="sdk-welcome-banner sdk-placeholder">
<div class="sdk-banner-info">
<div class="sdk-banner-title">${icon('clipboard-list', {size:14})} Taken Over Session</div>
<div class="sdk-banner-model">${sessionId.substring(0, 8)}...</div>
<div class="sdk-banner-cwd">${escapeHtml(sessionCwd)}</div>
</div>
</div>
<div class="sdk-ready-message">Session taken over — send a message to continue</div>`,
            startedAt: new Date().toISOString()
        });

        // Switch to Mission Control view
        switchView('mission-control');

        // Connect WebSocket and select the process
        connectToProcess(processId);

        // Refresh the sidebar to show the new process
        await refreshManagedProcessList();
        refreshMissionControl();

        // Select the newly taken over process
        selectManagedProcess(processId);

        // Load conversation history from the JSONL file
        try {
            const convResponse = await fetch(`/api/session/${sessionId}/conversation?limit=50`);
            if (convResponse.ok) {
                const convData = await convResponse.json();
                const messages = convData.messages || [];
                if (messages.length > 0) {
                    const proc = managedProcesses.get(processId);
                    if (proc) {
                        let historyHtml = '<div class="sdk-history-divider">Previous conversation</div>';
                        for (const m of messages) {
                            const isUser = m.role === 'human';
                            const mcRoleClass = isUser ? 'human' : 'assistant';
                            const roleLabel = isUser ? `${icon('user', {size:14})} You` : `${icon('bot', {size:14})} Assistant`;
                            const content = isUser
                                ? `<p>${escapeHtml(m.content || '')}</p>`
                                : renderMarkdown(m.content || '');
                            historyHtml += `<div class="mc-message ${mcRoleClass}"><div class="mc-message-header"><span class="mc-message-role">${roleLabel}</span></div><div class="mc-message-content">${content}</div></div>`;
                        }
                        historyHtml += '<div class="sdk-history-divider">Session resumed</div>';
                        // Insert history after the banner but before any new messages
                        proc.outputBuffer = proc.outputBuffer + historyHtml;
                        if (selectedProcessId === processId) {
                            setTerminalHtml(proc.outputBuffer);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load conversation history:', e);
        }

        showToast('Session taken over in Mission Control', 'success');

    } catch (e) {
        console.error('Takeover failed:', e);
        copyResumeCmd(sessionId, cwd);
        showToast(`Takeover failed: ${e.message} - command copied`, 'info');
    }
}

// Backwards compat alias
function resumeSession(sessionId, cwd) {
    return takeOverSession(sessionId, cwd);
}

console.log('Claude Session Visualizer loaded - All features active (including Feature 17: Multi-Machine Support)');

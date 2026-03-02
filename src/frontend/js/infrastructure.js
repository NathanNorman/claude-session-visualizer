
// WebSocket connection for log streaming
let logWebSocket = null;

function connectLogWebSocket() {
    if (logWebSocket && logWebSocket.readyState === WebSocket.OPEN) {
        return; // Already connected
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    logWebSocket = new WebSocket(`${protocol}//${window.location.host}/ws/sessions`);

    logWebSocket.onopen = () => {
        Logger.ws.info('Log WebSocket connected');
        // Subscribe to logs if server logs are enabled
        if (Logger.serverLogsEnabled) {
            logWebSocket.send(JSON.stringify({
                type: 'subscribe_logs',
                enabled: true,
                namespaces: Logger.enabledNamespaces.size > 0 ? Array.from(Logger.enabledNamespaces) : null
            }));
        }
    };

    logWebSocket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case 'log':
                    Logger.handleServerLog(msg.log);
                    break;
                case 'log_history':
                    Logger.handleLogHistory(msg.logs || []);
                    break;
                case 'pong':
                    // Keep-alive response, ignore
                    break;
                case 'sessions_update':
                    // Real-time session updates via WebSocket - much faster than polling!
                    handleWebSocketSessionsUpdate(msg);
                    break;
                case 'heartbeat':
                    // Server liveness signal - reset staleness timer without triggering render
                    lastWsUpdateTime = Date.now();
                    wsSessionUpdatesActive = true;
                    break;
                default:
                    // Other session messages - ignore for log streaming
                    break;
            }
        } catch (e) {
            // Ignore parse errors
        }
    };

    logWebSocket.onclose = () => {
        Logger.ws.debug('Log WebSocket closed');
        logWebSocket = null;
        // Reset WebSocket session updates state
        wsSessionUpdatesActive = false;
        // Always reconnect - WebSocket is essential for real-time session updates
        setTimeout(connectLogWebSocket, 2000);
    };

    logWebSocket.onerror = (error) => {
        Logger.ws.error('Log WebSocket error');
        wsSessionUpdatesActive = false;
    };

    // Keep-alive ping every 30 seconds
    setInterval(() => {
        if (logWebSocket && logWebSocket.readyState === WebSocket.OPEN) {
            logWebSocket.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
}

// Subscribe/unsubscribe from server logs
function setServerLogsEnabled(enabled) {
    Logger.setServerLogs(enabled);
    if (enabled && (!logWebSocket || logWebSocket.readyState !== WebSocket.OPEN)) {
        connectLogWebSocket();
    } else if (logWebSocket && logWebSocket.readyState === WebSocket.OPEN) {
        logWebSocket.send(JSON.stringify({
            type: 'subscribe_logs',
            enabled: enabled,
            namespaces: Logger.enabledNamespaces.size > 0 ? Array.from(Logger.enabledNamespaces) : null
        }));
    }
}

// Always connect WebSocket - essential for real-time session updates
// Also needed if debug mode is enabled for log streaming
connectLogWebSocket();

// MissionControlManager - centralized view state and navigation
class MissionControlManager {
    constructor() {
        this.views = ['mission-control', 'sessions', 'timeline', 'analytics', 'graveyard'];
        this.currentView = localStorage.getItem('missionControlView') || 'mission-control';
    }

    getCurrentView() {
        return this.currentView;
    }

    setView(viewName) {
        if (this.views.includes(viewName)) {
            this.currentView = viewName;
            localStorage.setItem('missionControlView', viewName);
            return true;
        }
        return false;
    }

    cycleView(direction = 1) {
        const currentIndex = this.views.indexOf(this.currentView);
        const nextIndex = (currentIndex + direction + this.views.length) % this.views.length;
        return this.views[nextIndex];
    }

    getViewDisplayName(viewName) {
        const names = {
            'sessions': 'Sessions',
            'timeline': 'Timeline',
            'analytics': 'Analytics',
            'mission-control': 'Mission Control'
        };
        return names[viewName] || viewName;
    }
}

const missionControl = new MissionControlManager();

// Feature 11: Template management
async function loadTemplates() {
    const resp = await fetch('/api/templates');
    const data = await resp.json();
    return data.templates;
}

async function saveAsTemplate(session) {
    const name = prompt('Template name:');
    if (!name) return;

    const description = prompt('Brief description:') || '';

    const template = {
        name,
        description,
        icon: 'pencil',
        config: {
            initialPrompt: '',
            sourceSession: {
                sessionId: session.sessionId,
                cwd: session.cwd,
                slug: session.slug
            }
        }
    };

    const resp = await fetch('/api/templates', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(template)
    });

    if (resp.ok) {
        showToast('Template saved!');
        return await resp.json();
    }
}

async function deleteTemplate(templateId) {
    if (!confirm('Delete this template?')) return;

    const resp = await fetch(`/api/templates/${templateId}`, {
        method: 'DELETE'
    });

    if (resp.ok) {
        showToast('Template deleted');
        showTemplateLibrary();
    }
}

async function useTemplate(templateId) {
    const resp = await fetch(`/api/templates/${templateId}/use`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({})
    });

    if (resp.ok) {
        const data = await resp.json();
        const template = data.template;
        const cwd = prompt('Working directory:', template.config?.sourceSession?.cwd || '');
        if (cwd) {
            showToast(`Template ready! Run: cd ${cwd} && claude`);
        }
    }
}

async function showTemplateLibrary() {
    const templates = await loadTemplates();

    showModal(`
        <div class="template-library">
            <div class="library-header">
                <h2>Session Templates</h2>
                <button onclick="closeModal()" class="modal-close">Close</button>
            </div>
            <div class="template-grid">
                ${templates.length === 0 ? `
                    <div class="empty-state">
                        <p>No templates yet. Save a session as a template to get started!</p>
                    </div>
                ` : templates.map(t => `
                    <div class="template-card">
                        <div class="template-icon">${escapeHtml(t.icon)}</div>
                        <h3>${escapeHtml(t.name)}</h3>
                        <p>${escapeHtml(t.description)}</p>
                        <div class="template-actions">
                            <button onclick="useTemplate('${escapeJsString(t.id)}')">Use</button>
                            <button onclick="deleteTemplate('${escapeJsString(t.id)}')">Delete</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `);
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showModal(content) {
    const overlay = document.getElementById('modal-overlay');
    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = content;
    overlay.classList.remove('hidden');

    // Close on backdrop click (not on content click)
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            closeModal();
        }
    };
}

function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('hidden');
    overlay.onclick = null;
}

// Global escape key handler for modals
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const overlay = document.getElementById('modal-overlay');
        if (overlay && !overlay.classList.contains('hidden')) {
            closeModal();
        }
    }
});

function showSoundSettings() {
    const settings = soundManager.settings;
    const volumePercent = Math.round(soundManager.volume * 100);

    showModal(`
        <div class="sound-settings">
            <div class="settings-header">
                <h2>${icon('volume-2', {size:18})} Sound Settings</h2>
                <button onclick="closeModal()" class="modal-close">Close</button>
            </div>

            <div class="setting-group">
                <label>Master Volume</label>
                <div class="volume-control">
                    <input type="range" id="volume-slider"
                           min="0" max="100" value="${volumePercent}"
                           oninput="soundManager.setVolume(this.value / 100); document.getElementById('volume-value').textContent = this.value + '%'">
                    <span id="volume-value">${volumePercent}%</span>
                </div>
            </div>

            <div class="setting-group">
                <h3>Event Sounds</h3>
                <div class="sound-event">
                    <label>
                        <input type="checkbox" ${settings.active.enabled ? 'checked' : ''}
                               onchange="soundManager.toggleEventSound('active'); closeModal(); showSoundSettings();">
                        Session became active
                    </label>
                    <button class="test-btn" onclick="soundManager.testSound('active')">Test</button>
                </div>
                <div class="sound-event">
                    <label>
                        <input type="checkbox" ${settings.waiting.enabled ? 'checked' : ''}
                               onchange="soundManager.toggleEventSound('waiting'); closeModal(); showSoundSettings();">
                        Session became waiting
                    </label>
                    <button class="test-btn" onclick="soundManager.testSound('waiting')">Test</button>
                </div>
                <div class="sound-event">
                    <label>
                        <input type="checkbox" ${settings.highContext.enabled ? 'checked' : ''}
                               onchange="soundManager.toggleEventSound('highContext'); closeModal(); showSoundSettings();">
                        High context warning (180k tokens)
                    </label>
                    <button class="test-btn" onclick="soundManager.testSound('highContext')">Test</button>
                </div>
                <div class="sound-event">
                    <label>
                        <input type="checkbox" ${settings.error.enabled ? 'checked' : ''}
                               onchange="soundManager.toggleEventSound('error'); closeModal(); showSoundSettings();">
                        Session error/failure
                    </label>
                    <button class="test-btn" onclick="soundManager.testSound('error')">Test</button>
                </div>
            </div>

            <div class="setting-group">
                <button class="btn-secondary" onclick="soundManager.mute(); closeModal()">Mute All</button>
                <button class="btn-secondary" onclick="soundManager.settings = soundManager.loadSettings(); soundManager.saveSettings(); closeModal(); showSoundSettings();">Reset to Default</button>
            </div>
        </div>
    `);
}

async function fetchSessions() {
    try {
        // Feature 15: Periodically fetch AI summaries
        const now = Date.now();
        const includeSummaries = (now - lastSummaryRefresh) > summaryRefreshInterval;
        const url = includeSummaries ? `${API_URL}?include_summaries=true` : API_URL;

        const response = await fetch(url);
        if (!response.ok) throw new Error('API error');
        const data = await response.json();

        if (includeSummaries) {
            lastSummaryRefresh = now;
        }

        // Feature 07: Check for state changes and send notifications
        checkStateChanges(previousSessionsForNotifications, data.sessions);
        previousSessionsForNotifications = [...data.sessions];

        // Store all sessions
        data.sessions.forEach(s => previousSessions.set(s.sessionId, { ...s }));

        // Render with filters and grouping
        renderCurrentSessions(data.sessions);

        const activeCount = data.sessions.filter(s => s.state === 'active').length;
        updateStatus(activeCount, data.sessions.length, data.timestamp);

        // Refresh Mission Control if active
        if (missionControl.getCurrentView() === 'mission-control') {
            refreshMissionControl();
        }

        // Schedule next poll with adaptive interval
        scheduleNextPoll(activeCount > 0);
    } catch (error) {
        console.error('Failed to fetch sessions:', error);
        // On error, still schedule next poll
        scheduleNextPoll(false);
    }
}

// Force refresh all session data
async function forceRefreshSessions() {
    showToast('Refreshing all session data...');
    try {
        // Force include summaries
        const response = await fetch(`${API_URL}?include_summaries=true`);
        if (!response.ok) throw new Error('API error');
        const data = await response.json();

        lastSummaryRefresh = Date.now();

        // Clear and repopulate
        previousSessions.clear();
        data.sessions.forEach(s => previousSessions.set(s.sessionId, { ...s }));

        // Force full render
        renderCurrentSessions(data.sessions, true);

        const activeCount = data.sessions.filter(s => s.state === 'active').length;
        updateStatus(activeCount, data.sessions.length, data.timestamp);

        showToast(`Refreshed ${data.sessions.length} sessions`);
    } catch (error) {
        console.error('Failed to refresh sessions:', error);
        showToast('Failed to refresh sessions', 'error');
    }
}

// Handle real-time session updates from WebSocket (much faster than polling!)
function handleWebSocketSessionsUpdate(msg) {
    const sessions = msg.sessions || [];
    const timestamp = msg.timestamp;

    // Mark WebSocket as active for session updates
    wsSessionUpdatesActive = true;
    lastWsUpdateTime = Date.now();

    // Update timestamp for dirty-check fallback
    if (timestamp) {
        lastKnownTimestamp = new Date(timestamp).getTime();
    }

    // Store in previousSessions map for change detection
    const newSessionsMap = new Map();
    sessions.forEach(s => newSessionsMap.set(s.sessionId, { ...s }));

    // Check if anything actually changed (avoid unnecessary renders)
    let hasChanges = false;
    if (newSessionsMap.size !== previousSessions.size) {
        hasChanges = true;
    } else {
        for (const [id, session] of newSessionsMap) {
            const prev = previousSessions.get(id);
            if (!prev) {
                hasChanges = true;
                break;
            }
            // Quick comparison of key fields that affect display
            if (prev.state !== session.state ||
                prev.contextTokens !== session.contextTokens ||
                prev.estimatedCost !== session.estimatedCost ||
                prev.tokenPercentage !== session.tokenPercentage ||
                prev.currentActivity?.description !== session.currentActivity?.description ||
                prev.activityLog?.length !== session.activityLog?.length ||
                JSON.stringify(prev.activitySummaries) !== JSON.stringify(session.activitySummaries)) {
                hasChanges = true;
                break;
            }
        }
    }

    if (!hasChanges) {
        return; // No changes, skip render
    }

    previousSessions = newSessionsMap;

    // Render updates (incremental if initial render done)
    const forceFullRender = !initialRenderComplete;
    renderCurrentSessions(sessions, forceFullRender);

    // Update status bar
    const activeCount = sessions.filter(s => s.state === 'active').length;
    updateStatus(activeCount, sessions.length, timestamp);
}

// Dirty-check polling: fast lightweight checks with full refresh only when needed
async function pollForChanges() {
    if (dirtyCheckTimeoutId) {
        clearTimeout(dirtyCheckTimeoutId);
    }

    // If WebSocket is actively delivering updates, skip polling
    const timeSinceWsUpdate = Date.now() - lastWsUpdateTime;
    if (wsSessionUpdatesActive && timeSinceWsUpdate < WS_UPDATE_TIMEOUT) {
        // WebSocket is working, just schedule next check as fallback
        scheduleDirtyCheck();
        return;
    }

    // WebSocket hasn't updated recently, fall back to HTTP polling
    if (wsSessionUpdatesActive && timeSinceWsUpdate >= WS_UPDATE_TIMEOUT) {
        console.warn('WebSocket session updates stale, falling back to HTTP polling');
        wsSessionUpdatesActive = false;
    }

    try {
        const resp = await fetch(`${API_URL_CHANGED}?since=${lastKnownTimestamp}`);
        if (!resp.ok) {
            // Dirty-check endpoint not available, fall back to legacy polling
            console.warn('Dirty-check unavailable, falling back to legacy polling');
            dirtyCheckEnabled = false;
            scheduleNextPoll(true);
            return;
        }

        const data = await resp.json();

        if (data.changed) {
            lastKnownTimestamp = data.timestamp;
            await fetchSessions();  // Full refresh - will call scheduleDirtyCheck
        } else {
            // No changes, schedule next dirty-check
            scheduleDirtyCheck();
        }
    } catch (error) {
        console.error('Dirty-check failed:', error);
        // On error, fall back to legacy polling
        dirtyCheckEnabled = false;
        scheduleNextPoll(true);
    }
}

// Schedule the next dirty-check poll
function scheduleDirtyCheck() {
    if (dirtyCheckTimeoutId) {
        clearTimeout(dirtyCheckTimeoutId);
    }
    // Use longer interval when WebSocket is active (just a safety check)
    const interval = wsSessionUpdatesActive ? 5000 : DIRTY_CHECK_INTERVAL;
    dirtyCheckTimeoutId = setTimeout(pollForChanges, interval);
}

// Legacy adaptive polling: used as fallback when dirty-check unavailable
function scheduleNextPoll(hasActiveSessions) {
    if (pollTimeoutId) {
        clearTimeout(pollTimeoutId);
    }

    // If dirty-check is enabled, use that instead
    if (dirtyCheckEnabled) {
        scheduleDirtyCheck();
        return;
    }

    // Fallback to legacy adaptive polling
    currentPollInterval = hasActiveSessions ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE;

    pollTimeoutId = setTimeout(() => {
        fetchSessions();
    }, currentPollInterval);
}

// Old renderSessions removed - replaced by renderCurrentSessions with grouping support

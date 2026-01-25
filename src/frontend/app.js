// Dirty-check polling intervals (fast lightweight checks)
const DIRTY_CHECK_INTERVAL = 500;     // 500ms dirty-check frequency
const FULL_POLL_FALLBACK = 30000;     // 30s fallback if dirty-check fails

// Legacy adaptive intervals (used when dirty-check unavailable)
const POLL_INTERVAL_ACTIVE = 3000;    // 3s when sessions are active
const POLL_INTERVAL_IDLE = 10000;     // 10s when all sessions idle
let currentPollInterval = POLL_INTERVAL_ACTIVE;
let pollTimeoutId = null;

// Dirty-check state
let lastKnownTimestamp = 0;
let dirtyCheckEnabled = true;
let dirtyCheckTimeoutId = null;

const API_URL = '/api/sessions';
const API_URL_CHANGED = '/api/sessions/changed';
const API_URL_ALL = '/api/sessions/all';
let previousSessions = new Map();

// Polecat avatar images for Gastown agents
const POLECAT_IMAGES = [
    'assets/polecats/polecat-rider.png',
    'assets/polecats/polecat-scout.png',
    'assets/polecats/polecat-pyro.png',
    'assets/polecats/polecat-bandit.png',
    'assets/polecats/polecat-sniper.png',
    'assets/polecats/polecat-mechanic.png'
];

// Get consistent polecat image based on session/slug hash
function getPolecatImage(identifier) {
    const hash = (identifier || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return POLECAT_IMAGES[hash % POLECAT_IMAGES.length];
}

// Track if initial render has happened (for differential updates)
let initialRenderComplete = false;
// Track current rendered session IDs for diffing
let renderedSessionIds = new Set();

// Feature 01: Search/Filter state
let searchQuery = '';
let statusFilter = 'all';
let searchDebounceTimer = null;

// Feature 17: Multi-Machine state
let multiMachineMode = JSON.parse(localStorage.getItem('multiMachineMode') || 'false');
let machineFilter = 'all'; // 'all' or specific machine name
let machinesData = { local: null, remote: {} };

// Feature 02: Session grouping state
let groupCollapsedState = JSON.parse(localStorage.getItem('groupCollapsedState') || '{}');

// Feature 07: Notification state
let notificationSettings = loadNotificationSettings();
let previousSessionsForNotifications = [];

function loadNotificationSettings() {
    const defaults = {
        enabled: true,
        onActive: true,
        onWaiting: false,
        onWarning: true
    };
    try {
        const saved = localStorage.getItem('notificationSettings');
        if (saved) {
            return { ...defaults, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.warn('Failed to load notification settings:', e);
    }
    return defaults;
}

function saveNotificationSettings() {
    try {
        localStorage.setItem('notificationSettings', JSON.stringify(notificationSettings));
    } catch (e) {
        console.warn('Failed to save notification settings:', e);
    }
}

// Session selection state
let selectedIndex = -1;
let allVisibleSessions = [];

// Feature 15: AI Summary state
let summaryRefreshInterval = 300000; // 5 minutes
let lastSummaryRefresh = 0;

// UX Enhancement: Compact card mode and focus mode
let cardDisplayMode = localStorage.getItem('cardDisplayMode') || 'compact'; // 'compact' or 'detailed'
let focusMode = JSON.parse(localStorage.getItem('focusMode') || 'false');

// ============================================================================
// StickyScroll - Unified sticky scroll behavior for activity windows
// ============================================================================

class StickyScroll {
    static THRESHOLD = 30;  // Unified threshold for all scroll containers
    static instances = new Map();
    static nextId = 1;

    constructor(element, options = {}) {
        this.element = element;
        this.autoScroll = true;
        this.showIndicator = options.showIndicator ?? false;
        this.id = `sticky-scroll-${StickyScroll.nextId++}`;
        element.dataset.stickyScrollId = this.id;
        StickyScroll.instances.set(this.id, this);
    }

    attach(skipInitialScroll = false) {
        this.element.addEventListener('scroll', () => this.handleScroll());
        if (!skipInitialScroll) {
            // Defer initial scroll until element is in DOM and rendered
            requestAnimationFrame(() => {
                this.element.scrollTop = this.element.scrollHeight;
            });
        }
        return this;
    }

    handleScroll() {
        const wasAutoScroll = this.autoScroll;
        this.autoScroll = this.isAtBottom();

        // Update visual indicator if enabled
        if (this.showIndicator && wasAutoScroll !== this.autoScroll) {
            this.updateIndicator();
        }
    }

    isAtBottom() {
        const el = this.element;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - StickyScroll.THRESHOLD;
    }

    scrollToBottom() {
        // Only scroll if auto-scroll is enabled
        if (this.autoScroll) {
            this.element.scrollTop = this.element.scrollHeight;
        }
    }

    forceScrollToBottom() {
        // Force scroll regardless of auto-scroll state, and re-enable auto-scroll
        this.autoScroll = true;
        this.element.scrollTop = this.element.scrollHeight;
        if (this.showIndicator) {
            this.updateIndicator();
        }
    }

    updateIndicator() {
        let indicator = this.element.querySelector('.sticky-scroll-indicator');

        if (this.autoScroll) {
            // Remove indicator when auto-scroll is enabled
            if (indicator) {
                indicator.remove();
            }
        } else {
            // Show indicator when auto-scroll is paused
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.className = 'sticky-scroll-indicator';
                indicator.innerHTML = `
                    <span class="indicator-text">Scroll paused</span>
                    <button class="indicator-resume" onclick="StickyScroll.resumeById('${this.id}')">Resume</button>
                `;
                this.element.appendChild(indicator);
            }
        }
    }

    static resumeById(id) {
        const instance = StickyScroll.instances.get(id);
        if (instance) {
            instance.forceScrollToBottom();
        }
    }

    static transferState(oldId, newElement) {
        // Transfer state from old element (destroyed by outerHTML) to new element
        const oldInstance = StickyScroll.instances.get(oldId);
        if (oldInstance) {
            const wasAutoScroll = oldInstance.autoScroll;
            const showIndicator = oldInstance.showIndicator;
            StickyScroll.instances.delete(oldId);

            // Create new instance with preserved state, skip initial scroll
            const newInstance = new StickyScroll(newElement, { showIndicator });
            newInstance.autoScroll = wasAutoScroll;
            newInstance.attach(true);  // Skip initial scroll, we handle it below

            // Scroll to bottom only if auto-scroll was enabled
            if (wasAutoScroll) {
                requestAnimationFrame(() => {
                    newElement.scrollTop = newElement.scrollHeight;
                });
            }

            return newInstance;
        }
        return null;
    }

    static getById(id) {
        return StickyScroll.instances.get(id);
    }

    static cleanup(element) {
        // Clean up StickyScroll instance when element is removed from DOM
        const id = element?.dataset?.stickyScrollId;
        if (id) {
            StickyScroll.instances.delete(id);
        }
    }

    static cleanupAll() {
        // Remove instances for elements no longer in the DOM (periodic cleanup)
        for (const [id, instance] of StickyScroll.instances) {
            if (!document.contains(instance.element)) {
                StickyScroll.instances.delete(id);
            }
        }
    }
}

// ============================================================================
// Session Diffing Helpers (for differential DOM updates)
// ============================================================================

function hasSessionChanged(oldSession, newSession) {
    if (!oldSession) return true;
    // Only check fields that affect visual display
    return oldSession.state !== newSession.state ||
           oldSession.contextTokens !== newSession.contextTokens ||
           oldSession.cpuPercent !== newSession.cpuPercent ||
           JSON.stringify(oldSession.recentActivity) !== JSON.stringify(newSession.recentActivity) ||
           oldSession.aiSummary !== newSession.aiSummary ||
           oldSession.lastActivity !== newSession.lastActivity ||
           oldSession.stateSource !== newSession.stateSource ||
           hasActivityChanged(oldSession, newSession);
}

// Detect currentActivity changes (hooks-based real-time activity)
function hasActivityChanged(oldSession, newSession) {
    if (!oldSession || !newSession) return true;
    const oldActivity = oldSession.currentActivity?.description || oldSession.currentActivity?.tool_name || '';
    const newActivity = newSession.currentActivity?.description || newSession.currentActivity?.tool_name || '';
    return oldActivity !== newActivity;
}

function computeSessionDiff(oldSessions, newSessions) {
    const oldMap = new Map(oldSessions.map(s => [s.sessionId, s]));
    const newMap = new Map(newSessions.map(s => [s.sessionId, s]));

    const added = [];
    const removed = [];
    const updated = [];

    // Find added and updated
    for (const [id, session] of newMap) {
        const old = oldMap.get(id);
        if (!old) {
            added.push(session);
        } else if (hasSessionChanged(old, session)) {
            updated.push(session);
        }
    }

    // Find removed
    for (const id of oldMap.keys()) {
        if (!newMap.has(id)) {
            removed.push(id);
        }
    }

    return { added, removed, updated };
}

// Sound Manager - Feature 14
class SoundManager {
    constructor() {
        this.audioContext = null;
        this.enabled = true;
        this.volume = 0.7;
        this.settings = this.loadSettings();
        this.userHasInteracted = false;

        // Listen for first user interaction to enable audio
        const enableAudio = () => {
            this.userHasInteracted = true;
            this.initAudioContext();
            document.removeEventListener('click', enableAudio);
            document.removeEventListener('keydown', enableAudio);
        };
        document.addEventListener('click', enableAudio, { once: true });
        document.addEventListener('keydown', enableAudio, { once: true });
    }

    initAudioContext() {
        // Only init if user has interacted with the page
        if (!this.userHasInteracted) return;
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('Web Audio API not supported:', e);
            }
        }
    }

    // Generate tones using Web Audio API
    playTone(frequency, duration, type = 'sine') {
        if (!this.enabled) return;
        // Lazy init on first sound play (requires user gesture)
        this.initAudioContext();
        if (!this.audioContext) return;

        try {
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();

            oscillator.type = type;
            oscillator.frequency.value = frequency;

            gainNode.gain.value = this.volume;
            gainNode.gain.exponentialRampToValueAtTime(
                0.01,
                this.audioContext.currentTime + duration
            );

            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);

            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + duration);
        } catch (e) {
            console.warn('Sound playback failed:', e);
        }
    }

    play(soundName) {
        // Sound playback disabled - kept as no-op for API compatibility
    }

    setVolume(vol) {
        this.volume = Math.max(0, Math.min(1, vol));
        this.saveSettings();
    }

    mute() {
        this.enabled = false;
        this.saveSettings();
        this.updateMuteIndicator();
    }

    unmute() {
        this.enabled = true;
        this.saveSettings();
        this.updateMuteIndicator();
    }

    toggle() {
        this.enabled = !this.enabled;
        this.saveSettings();
        this.updateMuteIndicator();
        return this.enabled;
    }

    updateMuteIndicator() {
        const button = document.getElementById('sound-toggle');
        if (button) {
            button.textContent = this.enabled ? '🔊' : '🔇';
            button.title = this.enabled ? 'Mute sounds (M)' : 'Unmute sounds (M)';
        }
    }

    loadSettings() {
        const defaults = {
            active: { enabled: true },
            waiting: { enabled: true },
            error: { enabled: false },
            highContext: { enabled: true },
        };
        try {
            const saved = localStorage.getItem('soundSettings');
            if (saved) {
                const parsed = JSON.parse(saved);
                this.enabled = parsed.enabled !== undefined ? parsed.enabled : true;
                this.volume = parsed.volume !== undefined ? parsed.volume : 0.7;
                return { ...defaults, ...parsed };
            }
        } catch (e) {
            console.warn('Failed to load sound settings:', e);
        }
        return defaults;
    }

    saveSettings() {
        try {
            localStorage.setItem('soundSettings', JSON.stringify({
                enabled: this.enabled,
                volume: this.volume,
                active: this.settings.active,
                waiting: this.settings.waiting,
                error: this.settings.error,
                highContext: this.settings.highContext,
            }));
        } catch (e) {
            console.warn('Failed to save sound settings:', e);
        }
    }

    toggleEventSound(eventName) {
        if (this.settings[eventName]) {
            this.settings[eventName].enabled = !this.settings[eventName].enabled;
            this.saveSettings();
        }
    }

    testSound(soundName) {
        const wasEnabled = this.enabled;
        this.enabled = true;
        this.play(soundName);
        this.enabled = wasEnabled;
    }

    openSettings() {
        showSoundSettings();
    }
}

const soundManager = new SoundManager();

// MissionControlManager - centralized view state and navigation
class MissionControlManager {
    constructor() {
        this.views = ['sessions', 'gastown', 'timeline', 'analytics', 'mission-control'];
        this.currentView = localStorage.getItem('missionControlView') || 'sessions';
        this.viewShortcuts = {
            's': 'sessions',
            'g': 'gastown',
            't': 'timeline',
            'a': 'analytics',
            'c': 'mission-control'
        };
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

    getViewForShortcut(key) {
        return this.viewShortcuts[key] || null;
    }

    cycleView(direction = 1) {
        const currentIndex = this.views.indexOf(this.currentView);
        const nextIndex = (currentIndex + direction + this.views.length) % this.views.length;
        return this.views[nextIndex];
    }

    getViewDisplayName(viewName) {
        const names = {
            'sessions': 'Sessions',
            'gastown': 'Gastown',
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
        icon: '📝',
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
                            <button onclick="useTemplate('${t.id}')">Use</button>
                            <button onclick="deleteTemplate('${t.id}')">Delete</button>
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
}

function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('hidden');
}

function showSoundSettings() {
    const settings = soundManager.settings;
    const volumePercent = Math.round(soundManager.volume * 100);

    showModal(`
        <div class="sound-settings">
            <div class="settings-header">
                <h2>🔊 Sound Settings</h2>
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

// Dirty-check polling: fast lightweight checks with full refresh only when needed
async function pollForChanges() {
    if (dirtyCheckTimeoutId) {
        clearTimeout(dirtyCheckTimeoutId);
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
    dirtyCheckTimeoutId = setTimeout(pollForChanges, DIRTY_CHECK_INTERVAL);
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
    let stateEmoji = '🟢';  // active
    if (session.state !== 'active') {
        stateEmoji = activityStatus.isStale ? '🟠' : '🟡';
    }

    // Activity badge HTML - always use activityStatus for consistent display
    const activityBadgeHtml = activityStatus.text
        ? `<span class="${activityStatus.class}">${activityStatus.text}</span>`
        : '<span class="idle-indicator">idle</span>';

    // Session duration
    const duration = formatAgentDuration(session.startTimestamp) || '0m';


    // Feature 20: Git Status display
    const gitHtml = session.git ? `
        <div class="git-status" onclick="event.stopPropagation(); showGitDetails('${session.sessionId}')">
            <span class="git-branch">🌿 ${escapeHtml(session.git.branch)}</span>
            ${session.git.uncommitted ? `
                <span class="git-uncommitted">
                    ⚠️ ${session.git.modified_count} uncommitted
                </span>
            ` : '<span class="git-clean">✓ clean</span>'}
            ${session.git.ahead > 0 ? `
                <span class="git-ahead">↑${session.git.ahead}</span>
            ` : ''}
        </div>
    ` : '';

    // Activity summary log (AI-generated summaries)
    const activitySummaryLogHtml = renderActivitySummaryLog(session.activitySummaries);

    // State source indicator (hooks = real-time, polling = heuristic)
    const stateIcon = session.stateSource === 'hooks' ? '<span class="state-source-indicator" title="Real-time hooks detection">⚡</span>' : '';

    // Current activity display (only when hooks-based and active)
    // Agent tree display (spawned agents)
    const agentTreeHtml = renderAgentTree(session.spawnedAgents);

    // Background shells display
    const backgroundShellsHtml = renderBackgroundShells(session.backgroundShells);

    // Emoji activity trail (hieroglyphic history)
    const activityTrailHtml = renderEmojiTrail(session.activityLog, session.state === 'active');

    // Polecat avatar for Gastown agents
    const agentType = session.isGastown ? getGastownAgentType(session.gastownRole || session.slug) : null;
    const polecatAvatarHtml = (agentType?.type === 'polecat')
        ? `<img class="polecat-avatar" src="${getPolecatImage(session.slug)}" alt="Polecat" />`
        : '';

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="card-header">
            <div class="slug">${stateEmoji} ${session.isGastown ? `<span class="gt-icon ${getGastownAgentType(session.gastownRole || session.slug).css}" title="${getGastownAgentType(session.gastownRole || session.slug).label}">${getGastownAgentType(session.gastownRole || session.slug).icon}</span> ` : ''}${escapeHtml(session.slug)}</div>
            <div class="card-actions">
                <button class="action-menu-btn" onclick="event.stopPropagation(); toggleActionMenu('${session.sessionId}')">⋮</button>
                <div class="action-menu hidden" id="menu-${session.sessionId}">
                    <button onclick="event.stopPropagation(); copySessionId('${session.sessionId}')">📋 Copy Session ID</button>
                    <button onclick="event.stopPropagation(); openJsonl('${session.sessionId}')">📂 Open JSONL File</button>
                    <button onclick="event.stopPropagation(); copyResumeCmd('${session.sessionId}')">🔗 Copy Resume Command</button>
                    <hr class="menu-divider">
                    <button onclick="event.stopPropagation(); refreshSummary('${session.sessionId}')">🤖 Generate AI Summary</button>
                    <button onclick="event.stopPropagation(); shareSession('${session.sessionId}')">📤 Share Session</button>
                    <button onclick="event.stopPropagation(); exportSession('${session.sessionId}')">📄 Export Markdown</button>
                    <hr class="menu-divider">
                    <button class="danger" onclick="event.stopPropagation(); killSession(${session.pid}, '${escapeHtml(session.slug)}')">⚠️ Kill Session</button>
                </div>
            </div>
        </div>
        <div class="card-body">
            ${polecatAvatarHtml}
            ${summaryHtml}
            ${activityTrailHtml}
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
                <span class="session-duration" title="Session duration">⏱️ ${duration}</span>
                ${activityBadgeHtml}
                <button class="metrics-btn" onclick="event.stopPropagation(); showMetricsModal('${session.sessionId}')" title="View Metrics">📊</button>
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
        ? `<span class="${activityStatus.class}">${activityStatus.text}</span>`
        : '<span class="idle-indicator">idle</span>';

    // State emoji like Mission Control
    let stateEmoji = '🟢';  // active
    if (session.state !== 'active') {
        stateEmoji = activityStatus.isStale ? '🟠' : '🟡';  // orange for stale, yellow for idle
    }

    // Gastown role icon
    const roleIcon = session.isGastown
        ? `<span class="gt-icon ${getGastownAgentType(session.gastownRole || session.slug).css}">${getGastownAgentType(session.gastownRole || session.slug).icon}</span> `
        : '';

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="compact-name">${stateEmoji} ${roleIcon}${escapeHtml(session.slug)}</div>
        <div class="compact-meta">
            <span>${duration}</span>
            <span>${Math.round(tokenPct)}% ctx</span>
            ${activityHtml}
            <button class="compact-expand" onclick="event.stopPropagation(); expandCard('${session.sessionId}')" title="Show details">▼</button>
        </div>
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
        btn.textContent = cardDisplayMode === 'compact' ? '📋' : '📊';
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

async function copyResumeCmd(sessionId) {
    const cmd = `claude --resume ${sessionId}`;
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
                <h3>📤 Share Session</h3>
                <p>Share this link to let others view this session snapshot:</p>
                <input type="text" class="share-url" value="${escapeHtml(shareUrl)}" readonly onclick="this.select()">
                <div class="modal-actions">
                    <button onclick="navigator.clipboard.writeText('${escapeHtml(shareUrl)}'); showToast('Link copied!');">Copy Link</button>
                    <button onclick="closeModal()">Close</button>
                </div>
                <p class="share-expiry">⏱️ Expires: ${new Date(data.expires_at).toLocaleDateString()}</p>
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
                    <h3>🌿 Git Details</h3>
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
                    <h3>📊 Session Metrics</h3>
                    <button onclick="closeModal()" class="modal-close">Close</button>
                </div>

                <div class="metrics-grid">
                    <div class="metrics-section">
                        <h4>⚡ Response Times</h4>
                        <dl class="metrics-stats">
                            <dt>Minimum</dt><dd>${metrics.responseTime.min}s</dd>
                            <dt>Average</dt><dd>${metrics.responseTime.avg}s</dd>
                            <dt>Median</dt><dd>${metrics.responseTime.median}s</dd>
                            <dt>Maximum</dt><dd>${metrics.responseTime.max}s</dd>
                        </dl>
                    </div>

                    <div class="metrics-section">
                        <h4>🔧 Tool Usage</h4>
                        <ul class="tool-list">
                            ${toolListHtml}
                        </ul>
                        <div class="tool-summary">
                            Total: ${metrics.totalToolCalls} calls (${metrics.toolsPerHour}/hr)
                        </div>
                    </div>

                    <div class="metrics-section">
                        <h4>📈 Session Stats</h4>
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

    card.querySelector('.meta').innerHTML = `
        <span>PID: ${session.pid || '--'}</span>`;

    // Update footer-right with duration and activity badge
    const footerRight = card.querySelector('.footer-right');
    if (footerRight) {
        const duration = formatAgentDuration(session.startTimestamp) || '0m';
        const activityStatus = getActivityStatus(session.lastActivity);
        // Always use activityStatus for consistent display (avoids flicker when state changes)
        const activityBadgeHtml = activityStatus.text
            ? `<span class="${activityStatus.class}">${activityStatus.text}</span>`
            : '';
        footerRight.innerHTML = `
            <span class="session-duration" title="Session duration">⏱️ ${duration}</span>
            ${activityBadgeHtml}
            <button class="metrics-btn" onclick="event.stopPropagation(); showMetricsModal('${session.sessionId}')" title="View Metrics">📊</button>`;
    }

    // Update slug with state emoji
    const slugEl = card.querySelector('.slug');
    if (slugEl) {
        const activityStatus = getActivityStatus(session.lastActivity);
        let stateEmoji = '🟢';
        if (session.state !== 'active') {
            stateEmoji = activityStatus.isStale ? '🟠' : '🟡';
        }
        const gastownIcon = session.isGastown
            ? `<span class="gt-icon ${getGastownAgentType(session.gastownRole || session.slug).css}" title="${getGastownAgentType(session.gastownRole || session.slug).label}">${getGastownAgentType(session.gastownRole || session.slug).icon}</span> `
            : '';
        slugEl.innerHTML = `${stateEmoji} ${gastownIcon}${escapeHtml(session.slug)}`;
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
                text: '💬 User message',
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
        frames: ['⚡', '✦', '⚡', '✦'],
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

const ACTIVITY_EMOJIS = {
    // Tools
    'Read': '📖',
    'Write': '✏️',
    'Edit': '✏️',
    'Bash': '⚡',
    'Grep': '🔍',
    'Glob': '📁',
    'Task': '🤖',
    'WebFetch': '🌐',
    'TodoWrite': '📋',
    'NotebookEdit': '📓',
    // Events
    'UserPromptSubmit': '💬',
    'Stop': '🛑',
    'SessionStart': '🚀',
    'SessionEnd': '🏁',
    // MCP tools get plugin emoji
    'mcp': '🔌',
    // Fallback
    'default': '⚙️'
};

// Get emoji for a tool or event
function getActivityEmoji(toolOrEvent) {
    if (!toolOrEvent) return ACTIVITY_EMOJIS.default;

    // Check for MCP tools
    if (toolOrEvent.startsWith('mcp__')) return ACTIVITY_EMOJIS.mcp;

    return ACTIVITY_EMOJIS[toolOrEvent] || ACTIVITY_EMOJIS.default;
}

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
                    emoji: getActivityEmoji(entry.tool),
                    tool: entry.tool,
                    description: entry.description || entry.tool,
                    timestamp: entry.timestamp
                });
                lastTool = entry.tool;
            }
        } else if (entry.event === 'UserPromptSubmit') {
            // User prompt marks a new "chapter" - reset dedup
            trail.push({
                emoji: getActivityEmoji('UserPromptSubmit'),
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

// Format timestamp for display
function formatActivityTime(timestamp) {
    if (!timestamp) return '';
    try {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    } catch {
        return '';
    }
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
    if (!activity) return '▶';

    const toolName = activity.tool_name || '';

    // Map tool names to icons
    if (toolName === 'Bash') return '⚡';
    if (toolName === 'Read') return '📖';
    if (toolName === 'Write') return '✏️';
    if (toolName === 'Edit') return '✏️';
    if (toolName === 'Grep') return '🔍';
    if (toolName === 'Glob') return '📁';
    if (toolName === 'Task') return '🤖';
    if (toolName === 'WebFetch') return '🌐';
    if (toolName.startsWith('mcp__')) return '🔌';

    // Activity type fallback
    if (activity.type === 'tool_use') return '⚙️';
    if (activity.type === 'user_prompt') return '💬';
    if (activity.type === 'idle') return '⏸';

    return '▶';
}

// Get icon for agent type
function getAgentTypeIcon(subagentType) {
    if (!subagentType) return '🤖';

    const type = subagentType.toLowerCase();
    if (type.includes('explore')) return '🔍';
    if (type.includes('plan')) return '📋';
    if (type.includes('haiku')) return '⚡';
    if (type.includes('code')) return '💻';
    if (type.includes('test')) return '🧪';
    if (type.includes('review')) return '👁️';

    return '🤖';
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

// Format activity status based on lastActivity timestamp
// Returns { isActive: bool, text: string, class: string }
function getActivityStatus(lastActivity) {
    if (!lastActivity) return { isActive: false, isStale: false, text: '', class: '' };
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
                class: 'active-indicator'
            };
        }

        // Stale: >1 min and <1 hour idle (orange)
        if (diffMins < 60) {
            return {
                isActive: false,
                isStale: true,
                text: `${diffMins}m idle`,
                class: 'stale-indicator'
            };
        }

        // Idle: >= 1 hour (yellow)
        const hours = Math.floor(diffMins / 60);
        const mins = diffMins % 60;
        return {
            isActive: false,
            isStale: false,
            text: `${hours}h ${mins}m idle`,
            class: 'idle-indicator'
        };
    } catch {
        return { isActive: false, isStale: false, text: '', class: '' };
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
                <span class="tree-label">🤖 ${agents.length} agent${agents.length > 1 ? 's' : ''}</span>
            </div>
            <div class="tree-children" ${collapsed ? 'style="display:none"' : ''}>
                ${agents.map((agent, idx) => `
                    <div class="tree-node ${agent.status}">
                        <span class="tree-connector">${idx === agents.length - 1 ? '└─' : '├─'}</span>
                        <span class="agent-type">${getAgentTypeIcon(agent.subagent_type)}</span>
                        <span class="agent-desc" title="${escapeHtml(agent.description || '')}">${escapeHtml(agent.description || agent.subagent_type || 'Agent')}</span>
                        <span class="agent-status ${agent.status}">${agent.status}${agent.background ? ' ⚡' : ''}</span>
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
                <span class="shells-label">🖥️ ${shells.length} background${shells.length > 1 ? ' tasks' : ' task'}</span>
            </div>
            <div class="tree-children" style="display:none">
                ${shells.map((shell, idx) => `
                    <div class="tree-node ${shell.computed_status}" title="${escapeHtml(shell.command || '')}">
                        <span class="tree-connector">${idx === shells.length - 1 ? '└─' : '├─'}</span>
                        <span class="shell-icon">⚙️</span>
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
 * Get emoji for a tool name (used in activity trails)
 */
function getToolEmoji(tool) {
    const toolEmojis = {
        'Read': '📖',
        'Write': '✍️',
        'Edit': '✏️',
        'Bash': '💻',
        'Grep': '🔍',
        'Glob': '📁',
        'Task': '🤖',
        'TodoWrite': '📋',
        'WebFetch': '🌐',
        'AskUserQuestion': '❓',
        'NotebookEdit': '📓',
        'MultiEdit': '✏️',
        'Skill': '⚡',
        'EnterPlanMode': '📝',
        'ExitPlanMode': '✅',
    };
    return toolEmojis[tool] || '🔧';
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

// ============================================================================
// Feature 01: Search/Filter Implementation
// ============================================================================

function initializeFilters() {
    const searchInput = document.getElementById('search');
    const statusSelect = document.getElementById('status-filter');
    const clearButton = document.getElementById('clear-filters');

    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            searchQuery = e.target.value;
            renderCurrentSessions(null, true); // Force full render on filter change
        }, 150);
    });

    statusSelect.addEventListener('change', (e) => {
        statusFilter = e.target.value;
        renderCurrentSessions(null, true); // Force full render on filter change
    });

    clearButton.addEventListener('click', () => {
        searchInput.value = '';
        statusSelect.value = 'all';
        searchQuery = '';
        statusFilter = 'all';
        renderCurrentSessions(null, true); // Force full render on filter change
    });
}

function filterSessions(sessions) {
    return sessions.filter(s => {
        // Focus mode: only show active sessions
        if (focusMode && s.state !== 'active') return false;
        if (statusFilter !== 'all' && s.state !== statusFilter) return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            const searchable = [
                s.slug || '',
                s.cwd || '',
                s.gitBranch || '',
                ...(s.recentActivity || [])
            ].join(' ').toLowerCase();
            if (!searchable.includes(q)) return false;
        }
        return true;
    });
}

// ============================================================================
// Feature 02: Session Grouping Implementation
// ============================================================================

function groupSessionsByProject(sessions) {
    const groups = {};
    for (const session of sessions) {
        const project = session.cwd?.split('/').pop() || session.slug || 'Unknown';
        if (!groups[project]) {
            groups[project] = {
                name: project,
                sessions: [],
                activeCount: 0,
                collapsed: groupCollapsedState[project] || false
            };
        }
        groups[project].sessions.push(session);
        if (session.state === 'active') {
            groups[project].activeCount++;
        }
    }
    // Sort: repos with active sessions first, then alphabetically within each tier
    return Object.values(groups).sort((a, b) => {
        // First by active count (descending) - repos with active sessions come first
        if (a.activeCount !== b.activeCount) {
            return b.activeCount - a.activeCount;
        }
        // Then alphabetically for stability
        return a.name.localeCompare(b.name);
    });
}

function toggleGroup(projectName) {
    groupCollapsedState[projectName] = !groupCollapsedState[projectName];
    localStorage.setItem('groupCollapsedState', JSON.stringify(groupCollapsedState));
    renderCurrentSessions(null, true); // Force full render on group toggle
}

function renderGroups(groups) {
    const container = document.getElementById('sessions-container');
    container.innerHTML = '';
    let cardIndex = 0;

    // Choose card creation function based on display mode
    const createCardFn = cardDisplayMode === 'compact' ? createCompactCard : createCard;

    groups.forEach(group => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'session-row';

        // Get git status from first session (all sessions in group share same repo)
        const firstSession = group.sessions[0];
        const git = firstSession?.git;
        const gitStatusHtml = git ? `
            <div class="row-git-status">
                <span class="git-branch">🌿 ${escapeHtml(git.branch)}</span>
                ${git.uncommitted ? `<span class="git-uncommitted">⚠️ ${git.modified_count} uncommitted</span>` : '<span class="git-clean">✓ clean</span>'}
                ${git.ahead > 0 ? `<span class="git-ahead">↑${git.ahead}</span>` : ''}
            </div>
        ` : '';

        // Left side: repo name + git status
        const labelDiv = document.createElement('div');
        labelDiv.className = 'session-row-label';
        labelDiv.innerHTML = `
            <span class="row-name">${escapeHtml(group.name)}</span>
            ${gitStatusHtml}
            <span class="row-stats">
                ${group.sessions.length}${group.activeCount > 0 ? ` <span class="row-active">(${group.activeCount} active)</span>` : ''}
            </span>
        `;
        groupDiv.appendChild(labelDiv);

        // Right side: horizontal cards
        const sessionsDiv = document.createElement('div');
        sessionsDiv.className = 'session-row-cards';
        sessionsDiv.dataset.cardCount = Math.min(group.sessions.length, 4);

        group.sessions.forEach(session => {
            const card = createCardFn(session, cardIndex++);
            sessionsDiv.appendChild(card);
        });

        groupDiv.appendChild(sessionsDiv);
        container.appendChild(groupDiv);
    });
    allVisibleSessions = groups.flatMap(g => g.sessions);
}

// Gastown dedicated tab view
let gastownSessions = [];

function renderGastownView(gastown) {
    gastownSessions = gastown || [];
    const container = document.getElementById('gastown-container');
    const countEl = document.getElementById('gastown-count');

    if (!container) return;

    const activeCount = gastownSessions.filter(s => s.state === 'active').length;
    const totalCount = gastownSessions.length;

    // Update count badge in header
    if (countEl) {
        countEl.textContent = `${totalCount} agent${totalCount !== 1 ? 's' : ''}${activeCount > 0 ? ` (${activeCount} active)` : ''}`;
    }

    // Update tab badge
    const tabButton = document.querySelector('[data-view="gastown"]');
    if (tabButton) {
        // Add/update badge on the tab
        let badge = tabButton.querySelector('.tab-badge');
        if (totalCount > 0) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'tab-badge';
                tabButton.appendChild(badge);
            }
            badge.textContent = totalCount;
            badge.classList.toggle('has-active', activeCount > 0);
        } else if (badge) {
            badge.remove();
        }
    }

    // Empty state
    if (gastownSessions.length === 0) {
        container.innerHTML = `
            <div class="empty-state gastown-empty">
                <h2>🏭 No Gastown Agents</h2>
                <p>No gastown agents are currently running.</p>
                <p class="hint">Gastown agents appear here when spawned via <code>gt sling</code></p>
            </div>`;
        return;
    }

    // Group gastown sessions by repo/cwd
    container.innerHTML = '';
    container.className = 'gastown-grouped';

    const groups = groupGastownByRepo(gastownSessions);
    const createCardFn = cardDisplayMode === 'compact' ? createCompactCard : createCard;

    groups.forEach(group => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'gastown-repo-group';

        // Repo header with path and agent count
        const header = document.createElement('div');
        header.className = 'gastown-repo-header';
        const activeText = group.activeCount > 0 ? ` (${group.activeCount} active)` : '';
        header.innerHTML = `
            <div class="repo-info">
                <span class="repo-icon">📁</span>
                <span class="repo-path">${escapeHtml(group.repoPath)}</span>
            </div>
            <span class="agent-count">${group.sessions.length} agent${group.sessions.length !== 1 ? 's' : ''}${activeText}</span>
        `;
        groupDiv.appendChild(header);

        // Agent cards container
        const cardsContainer = document.createElement('div');
        cardsContainer.className = 'gastown-cards';
        cardsContainer.dataset.cardCount = Math.min(group.sessions.length, 4);

        group.sessions.forEach((session, idx) => {
            const card = createCardFn(session, idx);
            card.classList.add('gastown-card');
            cardsContainer.appendChild(card);
        });

        groupDiv.appendChild(cardsContainer);
        container.appendChild(groupDiv);
    });
}

// Pixel-art style icons for gastown agent types
function getGastownAgentType(slug) {
    const s = (slug || '').toLowerCase();

    // Supervisors have simple names
    if (s === 'rig') return { type: 'rig', icon: '⛏', label: 'Rig', css: 'gt-rig' };
    if (s === 'witness') return { type: 'witness', icon: '◉', label: 'Witness', css: 'gt-witness' };
    if (s === 'refinery') return { type: 'refinery', icon: '⚙', label: 'Refinery', css: 'gt-refinery' };
    if (s === 'deacon' || s.includes('deacon')) return { type: 'deacon', icon: '✟', label: 'Deacon', css: 'gt-deacon' };
    if (s === 'mayor') return { type: 'mayor', icon: '♔', label: 'Mayor', css: 'gt-mayor' };
    if (s === 'spa' || s === 'bff') return { type: 'service', icon: '◈', label: s.toUpperCase(), css: 'gt-service' };
    if (s === 'gastown' || s === 'gt') return { type: 'gastown', icon: '🏭', label: 'Gas Town', css: 'gt-hq' };

    // Polecats have adjective-verb-noun names (3 parts with hyphens)
    const parts = s.split('-');
    if (parts.length >= 3) {
        // Generate a consistent "pixel creature" based on name hash
        const hash = s.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const creatures = ['▣', '◆', '●', '■', '▲', '★', '◐', '◧'];
        const creature = creatures[hash % creatures.length];
        return { type: 'polecat', icon: creature, label: 'Polecat', css: 'gt-polecat' };
    }

    // Unknown
    return { type: 'unknown', icon: '?', label: 'Agent', css: 'gt-unknown' };
}

function groupGastownByRepo(sessions) {
    const groups = {};

    // Gas Town HQ-level agents (not working on a specific rig/repo)
    const GT_HQ_AGENTS = ['deacon', 'mayor'];

    for (const session of sessions) {
        const cwd = session.cwd || '';

        // Extract repo name from path
        // Pattern: /Users/nathan.norman/toast-analytics/... → toast-analytics
        // Gas Town: /Users/nathan.norman/gt/<rig-name>/... → rig-name is the repo
        // Gas Town HQ: /Users/nathan.norman/gt/deacon/... → "Gas Town HQ" (supervisor)
        const parts = cwd.split('/').filter(Boolean);
        let repoName = 'Unknown';

        // Find the repo: skip Users, username, then take the next part
        if (parts.length >= 3 && parts[0] === 'Users') {
            repoName = parts[2]; // /Users/username/REPO/...

            // Special case: if in 'gt' (gastown) directory
            if (repoName === 'gt') {
                if (parts.length >= 4) {
                    const rigOrHq = parts[3];
                    // Check if it's an HQ-level agent (deacon, mayor) vs a rig
                    if (GT_HQ_AGENTS.includes(rigOrHq)) {
                        repoName = 'Gas Town HQ';
                    } else {
                        repoName = rigOrHq; // It's a rig name = actual repo
                    }
                } else if (GT_HQ_AGENTS.includes(session.gastownRole)) {
                    // Agent in /gt root with HQ role (e.g., mayor)
                    repoName = 'Gas Town HQ';
                }
            }
        } else if (parts.length >= 3 && parts[0] === 'home') {
            repoName = parts[2]; // /home/username/REPO/...
            if (repoName === 'gt') {
                if (parts.length >= 4) {
                    const rigOrHq = parts[3];
                    if (GT_HQ_AGENTS.includes(rigOrHq)) {
                        repoName = 'Gas Town HQ';
                    } else {
                        repoName = rigOrHq;
                    }
                } else if (GT_HQ_AGENTS.includes(session.gastownRole)) {
                    repoName = 'Gas Town HQ';
                }
            }
        } else if (parts.length > 0) {
            // Fallback: use first non-hidden directory
            repoName = parts.find(p => !p.startsWith('.')) || parts[0];
        }

        if (!groups[repoName]) {
            groups[repoName] = {
                repoName: repoName,
                repoPath: repoName,
                sessions: [],
                activeCount: 0
            };
        }
        groups[repoName].sessions.push(session);
        if (session.state === 'active') {
            groups[repoName].activeCount++;
        }
    }

    // Sort: active groups first, then by session count, then by name
    // But always put "Gas Town HQ" last
    return Object.values(groups).sort((a, b) => {
        if (a.repoName === 'Gas Town HQ') return 1;
        if (b.repoName === 'Gas Town HQ') return -1;
        if (a.activeCount > 0 && b.activeCount === 0) return -1;
        if (b.activeCount > 0 && a.activeCount === 0) return 1;
        if (b.sessions.length !== a.sessions.length) return b.sessions.length - a.sessions.length;
        return a.repoName.localeCompare(b.repoName);
    });
}

function groupGastownByRig(sessions) {
    const groups = {};

    for (const session of sessions) {
        // Extract rig name from cwd path (e.g., /polecats/myrig/... -> myrig)
        let rigName = 'Unknown';
        const cwd = session.cwd || '';

        // Match patterns like /polecats/rigname/ or /rig/rigname/
        const rigMatch = cwd.match(/\/(?:polecats|rig)\/([^/]+)/);
        if (rigMatch) {
            rigName = rigMatch[1];
        } else {
            // Fallback to last directory component
            rigName = cwd.split('/').filter(Boolean).pop() || session.slug || 'Unknown';
        }

        if (!groups[rigName]) {
            groups[rigName] = {
                name: rigName,
                sessions: [],
                activeCount: 0
            };
        }
        groups[rigName].sessions.push(session);
        if (session.state === 'active') {
            groups[rigName].activeCount++;
        }
    }

    // Sort by name, active groups first
    return Object.values(groups).sort((a, b) => {
        if (a.activeCount > 0 && b.activeCount === 0) return -1;
        if (b.activeCount > 0 && a.activeCount === 0) return 1;
        return a.name.localeCompare(b.name);
    });
}

function renderCurrentSessions(sessions = null, forceFullRender = false) {
    if (!sessions) {
        sessions = Array.from(previousSessions.values());
    }
    const filtered = filterSessions(sessions);

    // Separate main sessions from gastown sessions
    const mainSessions = filtered.filter(s => !s.isGastown);
    const gastown = filtered.filter(s => s.isGastown);

    const mainCount = mainSessions.length;

    // Update count display (gastown has its own tab badge)
    const activeCount = mainSessions.filter(s => s.state === 'active').length;
    let countText = activeCount > 0
        ? `${activeCount} active, ${mainCount - activeCount} waiting`
        : `${mainCount} session${mainCount !== 1 ? 's' : ''}`;
    document.getElementById('session-count').textContent = countText;

    const container = document.getElementById('sessions-container');

    // Always update gastown view (separate tab)
    renderGastownView(gastown);

    // Empty state for main sessions only
    if (mainSessions.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h2>No Claude sessions</h2>
                <p>Start a Claude Code session to see it here</p>
                ${gastown.length > 0 ? '<p class="hint">Gastown agents are in the 🏭 Gastown tab</p>' : ''}
            </div>`;
        allVisibleSessions = [];
        renderedSessionIds.clear();
        initialRenderComplete = false;
        return;
    }

    // First render or forced full render - build everything
    if (!initialRenderComplete || forceFullRender || container.children.length === 0) {
        // Render main sessions only (gastown is in separate tab)
        const mainGroups = groupSessionsByProject(mainSessions);
        renderGroups(mainGroups);

        renderedSessionIds = new Set(mainSessions.map(s => s.sessionId));
        initialRenderComplete = true;
    } else {
        // Incremental update - update main session cards only
        updateSessionsInPlace(mainSessions);
    }

    if (selectedIndex >= allVisibleSessions.length) {
        clearSelection();
    }
}

// Update sessions without full DOM rebuild
function updateSessionsInPlace(sessions) {
    const container = document.getElementById('sessions-container');
    const currentIds = new Set(sessions.map(s => s.sessionId));

    // Update existing cards and track what needs to be added/removed
    const sessionsToAdd = [];

    for (const session of sessions) {
        const card = container.querySelector(`[data-session-id="${session.sessionId}"]`);
        if (card) {
            // Update existing card
            updateCard(card, session);
        } else {
            // New session - will need to add
            sessionsToAdd.push(session);
        }
    }

    // Remove cards for sessions that no longer exist
    const cardsToRemove = [];
    container.querySelectorAll('[data-session-id]').forEach(card => {
        const sessionId = card.dataset.sessionId;
        if (!currentIds.has(sessionId)) {
            cardsToRemove.push(card);
        }
    });
    cardsToRemove.forEach(card => {
        // Clean up any StickyScroll instances to prevent memory leaks
        card.querySelectorAll('[data-sticky-scroll-id]').forEach(el => StickyScroll.cleanup(el));
        card.remove();
    });

    // Add new sessions - append to appropriate group or create group
    if (sessionsToAdd.length > 0) {
        for (const session of sessionsToAdd) {
            appendNewSession(container, session);
        }
    }

    // Update group stats without rebuilding
    updateGroupStats(sessions);

    // Update allVisibleSessions for keyboard navigation
    allVisibleSessions = sessions;
    renderedSessionIds = currentIds;
}

// Append a new session card to the appropriate group (session-row structure)
function appendNewSession(container, session) {
    const projectName = session.cwd?.split('/').pop() || session.slug || 'Unknown';

    // Find existing row (session-row structure from renderGroups)
    let rowDiv = null;
    let cardsDiv = null;

    container.querySelectorAll('.session-row').forEach(row => {
        const rowNameEl = row.querySelector('.row-name');
        if (rowNameEl && rowNameEl.textContent === projectName) {
            rowDiv = row;
            cardsDiv = row.querySelector('.session-row-cards');
        }
    });

    // If no row exists, create one (matching renderGroups structure)
    if (!rowDiv) {
        rowDiv = document.createElement('div');
        rowDiv.className = 'session-row';

        const labelDiv = document.createElement('div');
        labelDiv.className = 'session-row-label';
        labelDiv.innerHTML = `
            <span class="row-name">${escapeHtml(projectName)}</span>
            <span class="row-stats">1 <span class="row-active">(1 active)</span></span>
        `;
        rowDiv.appendChild(labelDiv);

        cardsDiv = document.createElement('div');
        cardsDiv.className = 'session-row-cards';
        cardsDiv.dataset.cardCount = '1';
        rowDiv.appendChild(cardsDiv);

        container.appendChild(rowDiv);
    }

    // Add the card to the row (respect compact mode)
    const cardIndex = container.querySelectorAll('[data-session-id]').length;
    const createCardFn = cardDisplayMode === 'compact' ? createCompactCard : createCard;
    const card = createCardFn(session, cardIndex);
    cardsDiv.appendChild(card);

    // Update card count for CSS sizing
    const cardCount = cardsDiv.querySelectorAll('.session-card').length;
    cardsDiv.dataset.cardCount = Math.min(cardCount, 4);
}

// Update group statistics without rebuilding
function updateGroupStats(sessions) {
    const container = document.getElementById('sessions-container');
    const groupStats = {};

    // Calculate stats per group
    for (const session of sessions) {
        const projectName = session.cwd?.split('/').pop() || session.slug || 'Unknown';
        if (!groupStats[projectName]) {
            groupStats[projectName] = { total: 0, active: 0 };
        }
        groupStats[projectName].total++;
        if (session.state === 'active') {
            groupStats[projectName].active++;
        }
    }

    // Update each row's stats display (session-row structure)
    container.querySelectorAll('.session-row').forEach(row => {
        const rowNameEl = row.querySelector('.row-name');
        const statsEl = row.querySelector('.row-stats');
        if (rowNameEl && statsEl) {
            const name = rowNameEl.textContent;
            const stats = groupStats[name];
            if (stats) {
                statsEl.innerHTML = `
                    ${stats.total}${stats.active > 0 ? ` <span class="row-active">(${stats.active} active)</span>` : ''}
                `;
            }
        }

        // Update card count for CSS sizing
        const cardsDiv = row.querySelector('.session-row-cards');
        if (cardsDiv) {
            const cardCount = cardsDiv.querySelectorAll('.session-card').length;
            cardsDiv.dataset.cardCount = Math.min(cardCount, 4);
        }
    });
}

// ============================================================================
// Feature 07: Desktop Notifications Implementation
// ============================================================================

function initializeNotifications() {
    const toggleButton = document.getElementById('notification-toggle');
    updateNotificationToggleUI();

    // Left-click: Toggle notifications on/off
    toggleButton.addEventListener('click', async (e) => {
        // If shift key held, show settings instead
        if (e.shiftKey) {
            showNotificationSettings();
            return;
        }

        if (!notificationSettings.enabled) {
            const granted = await enableNotifications();
            if (granted) {
                notificationSettings.enabled = true;
                saveNotificationSettings();
                updateNotificationToggleUI();
                showToast('Notifications enabled');
            } else {
                showToast('Notification permission denied', 'error');
            }
        } else {
            notificationSettings.enabled = false;
            saveNotificationSettings();
            updateNotificationToggleUI();
            showToast('Notifications disabled');
        }
    });

    // Right-click: Show notification settings
    toggleButton.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showNotificationSettings();
    });
}

function updateNotificationToggleUI() {
    const toggleButton = document.getElementById('notification-toggle');
    if (notificationSettings.enabled && Notification.permission === 'granted') {
        toggleButton.classList.add('notifications-enabled');
        toggleButton.title = 'Notifications ON (click to disable, right-click for settings)';
    } else {
        toggleButton.classList.remove('notifications-enabled');
        toggleButton.title = 'Notifications OFF (click to enable, right-click for settings)';
    }
}

function showNotificationSettings() {
    const permissionStatus = Notification.permission;
    const permissionHtml = permissionStatus === 'granted'
        ? '<span class="permission-granted">✓ Permission granted</span>'
        : permissionStatus === 'denied'
            ? '<span class="permission-denied">✗ Permission denied (check browser settings)</span>'
            : '<span class="permission-pending">⚠ Permission not requested yet</span>';

    showModal(`
        <div class="notification-settings">
            <div class="settings-header">
                <h2>🔔 Notification Settings</h2>
                <button onclick="closeModal()" class="modal-close">Close</button>
            </div>

            <div class="setting-group">
                <label>Browser Permission</label>
                <div class="permission-status">${permissionHtml}</div>
                ${permissionStatus !== 'granted' ? `
                    <button class="btn-secondary" onclick="requestNotificationPermission()">
                        Request Permission
                    </button>
                ` : ''}
            </div>

            <div class="setting-group">
                <label class="setting-toggle">
                    <input type="checkbox" id="notify-enabled"
                           ${notificationSettings.enabled ? 'checked' : ''}
                           onchange="toggleNotificationSetting('enabled', this)">
                    <span>Enable desktop notifications</span>
                </label>
            </div>

            <div class="setting-group">
                <h3>Notification Types</h3>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-active"
                               ${notificationSettings.onActive ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onActive', this)">
                        <span>🟢 Session became active</span>
                    </label>
                    <p class="setting-desc">Notify when a waiting session starts working</p>
                </div>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-waiting"
                               ${notificationSettings.onWaiting ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onWaiting', this)">
                        <span>🔵 Session needs input</span>
                    </label>
                    <p class="setting-desc">Notify when an active session becomes idle (can be noisy)</p>
                </div>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-warning"
                               ${notificationSettings.onWarning ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onWarning', this)">
                        <span>⚠️ Context warning (80%)</span>
                    </label>
                    <p class="setting-desc">Notify when a session reaches 80% context capacity</p>
                </div>
            </div>

            <div class="setting-group">
                <button class="btn-secondary" onclick="testNotification()">
                    Send Test Notification
                </button>
            </div>
        </div>
    `);
}

function toggleNotificationSetting(setting, checkbox) {
    notificationSettings[setting] = checkbox.checked;
    saveNotificationSettings();
    updateNotificationToggleUI();
}

async function requestNotificationPermission() {
    const granted = await enableNotifications();
    if (granted) {
        showToast('Permission granted!');
        closeModal();
        showNotificationSettings(); // Refresh the modal
    } else {
        showToast('Permission denied', 'error');
    }
}

function testNotification() {
    if (Notification.permission !== 'granted') {
        showToast('Grant notification permission first', 'error');
        return;
    }

    const notification = new Notification('🔔 Test Notification', {
        body: 'Notifications are working correctly!',
        icon: '/favicon.ico',
        tag: 'test-notification'
    });

    notification.onclick = () => {
        window.focus();
        notification.close();
    };

    setTimeout(() => notification.close(), 5000);
    showToast('Test notification sent');
}

async function enableNotifications() {
    if (!('Notification' in window)) {
        alert('This browser does not support notifications');
        return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        return permission === 'granted';
    }
    return false;
}

function sendNotification(title, body, options = {}) {
    // Notification sending disabled - kept as no-op for API compatibility
}

function checkStateChanges(oldSessions, newSessions) {
    // State change detection disabled - kept as no-op for API compatibility
}

// Initialize UX enhancements
function initializeUXEnhancements() {
    // Apply saved focus mode state
    if (focusMode) {
        document.body.classList.add('focus-mode');
    }
    // Update button UIs
    updateViewModeButton();
    updateFocusModeButton();
}

// Initialize all features
document.addEventListener('DOMContentLoaded', () => {
    initializeFilters();
    initializeNotifications();
    initializeUXEnhancements();

    // Initialize sliding tab indicator position
    const activeTab = document.querySelector('.tab-button.active');
    if (activeTab) {
        updateTabIndicator(activeTab);
    }

    // Update indicator on window resize
    window.addEventListener('resize', () => {
        const currentActiveTab = document.querySelector('.tab-button.active');
        if (currentActiveTab) {
            updateTabIndicator(currentActiveTab);
        }
    });
});

// ============================================================================
// Feature 05: Session Timeline Implementation
// ============================================================================

let timelineHours = parseInt(localStorage.getItem('timelineHours') || '8', 10); // Show last 8 hours (configurable)
let timelineData = new Map(); // sessionId -> activityPeriods
let timelineViewActive = false;

function changeTimelineRange(hours) {
    timelineHours = parseInt(hours, 10);
    localStorage.setItem('timelineHours', timelineHours);
    refreshTimeline();
}

function syncTimelineRangeSelect() {
    const select = document.getElementById('timeline-range-select');
    if (select) {
        select.value = timelineHours.toString();
    }
}

async function fetchSessionTimeline(sessionId) {
    try {
        const response = await fetch(`/api/session/${sessionId}/timeline?bucket_minutes=5`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.activityPeriods || [];
    } catch (error) {
        console.error(`Failed to fetch timeline for ${sessionId}:`, error);
        return null;
    }
}

async function refreshTimeline() {
    if (!timelineViewActive) return;

    const container = document.getElementById('timeline-container');
    container.innerHTML = '<div class="timeline-loading">Loading timeline data...</div>';

    try {
        // Fetch all sessions with activity in the time window (including closed ones)
        const response = await fetch(`/api/timeline/sessions?hours=${timelineHours}`);
        if (!response.ok) throw new Error('Failed to fetch timeline sessions');

        const data = await response.json();
        const sessions = data.sessions || [];

        if (sessions.length === 0) {
            container.innerHTML = `
                <div class="timeline-empty">
                    <p>No sessions with activity in the last ${timelineHours} hours.</p>
                    <p>Start a Claude Code session to see activity here.</p>
                </div>
            `;
            return;
        }

        // Fetch timeline data for all sessions in parallel
        const timelinePromises = sessions.map(async (session) => {
            const periods = await fetchSessionTimeline(session.sessionId);
            return { session, periods };
        });

        const results = await Promise.all(timelinePromises);

        // Calculate visible time window
        const now = Date.now();
        const windowStart = now - (timelineHours * 60 * 60 * 1000);

        // Store timeline data and filter to sessions with activity IN THE VISIBLE WINDOW
        const sessionsWithActivity = [];
        results.forEach(({ session, periods }) => {
            if (!periods || periods.length === 0) return;

            // Check if any period overlaps with the visible time window
            const hasVisibleActivity = periods.some(period => {
                const periodStart = new Date(period.start).getTime();
                const periodEnd = new Date(period.end).getTime();
                // Period overlaps if it ends after window start AND starts before now
                return periodEnd >= windowStart && periodStart <= now;
            });

            if (hasVisibleActivity) {
                timelineData.set(session.sessionId, periods);
                sessionsWithActivity.push(session);
            }
        });

        if (sessionsWithActivity.length === 0) {
            container.innerHTML = `
                <div class="timeline-empty">
                    <p>No activity found in the last ${timelineHours} hours.</p>
                </div>
            `;
            return;
        }

        // Render the timeline
        renderTimeline(sessionsWithActivity);

    } catch (error) {
        console.error('Failed to load timeline:', error);
        container.innerHTML = `<div class="timeline-empty"><p>Failed to load timeline: ${error.message}</p></div>`;
    }
}

function renderTimeline(sessions) {
    const container = document.getElementById('timeline-container');
    const now = Date.now();
    const hoursBack = timelineHours;
    const startTime = now - (hoursBack * 60 * 60 * 1000);

    // Group sessions by repo (cwd)
    const sessionsByRepo = new Map();
    const gastownSessions = [];

    for (const session of sessions) {
        if (session.isGastown) {
            gastownSessions.push(session);
        } else {
            const cwd = session.cwd || 'Unknown';
            const repoName = cwd.split('/').filter(Boolean).pop() || 'Unknown';
            if (!sessionsByRepo.has(repoName)) {
                sessionsByRepo.set(repoName, { cwd, sessions: [] });
            }
            sessionsByRepo.get(repoName).sessions.push(session);
        }
    }

    // Sort repos by most recent activity
    const sortedRepos = [...sessionsByRepo.entries()].sort((a, b) => {
        const aLatest = Math.max(...a[1].sessions.map(s => new Date(s.lastActivity || 0).getTime()));
        const bLatest = Math.max(...b[1].sessions.map(s => new Date(s.lastActivity || 0).getTime()));
        return bLatest - aLatest;
    });

    // Generate time axis
    const timeAxisHtml = generateTimeAxis(startTime, now, hoursBack);

    // Generate timeline sections for each repo
    const repoSectionsHtml = sortedRepos.map(([repoName, { cwd, sessions: repoSessions }]) => {
        const rowsHtml = repoSessions.map(session => {
            const periods = timelineData.get(session.sessionId) || [];
            return renderTimelineRow(session, periods, startTime, now);
        }).join('');

        return `
            <div class="timeline-section">
                <div class="timeline-section-header" title="${escapeHtml(cwd)}">
                    📁 ${escapeHtml(repoName)}
                    <span class="timeline-section-count">${repoSessions.length}</span>
                </div>
                <div class="timeline-rows">${rowsHtml}</div>
            </div>
        `;
    }).join('');

    // Group gastown sessions by repo (HQ, rigs, etc.)
    const gastownGroups = groupGastownByRepo(gastownSessions);
    const gastownSectionsHtml = gastownGroups.map(group => {
        const rowsHtml = group.sessions.map(session => {
            const periods = timelineData.get(session.sessionId) || [];
            return renderTimelineRow(session, periods, startTime, now);
        }).join('');

        return `
            <div class="timeline-subsection">
                <div class="timeline-subsection-header">${escapeHtml(group.repoName)}</div>
                <div class="timeline-rows">${rowsHtml}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="timeline-axis">${timeAxisHtml}</div>
        ${repoSectionsHtml}
        ${gastownSessions.length > 0 ? `
            <div class="timeline-section gastown-section">
                <div class="timeline-section-header">🏭 Gas Town</div>
                ${gastownSectionsHtml}
            </div>
        ` : ''}
        ${sessions.length === 0 ? `
            <div class="timeline-empty">
                <p>No active sessions to show on timeline.</p>
                <p>Start a Claude Code session to see activity here.</p>
            </div>
        ` : ''}
    `;
}

function generateTimeAxis(startTime, endTime, hoursBack) {
    const markers = [];
    const hourMs = 60 * 60 * 1000;

    // Generate markers at each hour
    for (let i = 0; i <= hoursBack; i++) {
        const markerTime = startTime + (i * hourMs);
        const left = (i / hoursBack) * 100;
        const date = new Date(markerTime);
        const label = date.toLocaleTimeString([], { hour: 'numeric', hour12: true });

        markers.push(`
            <div class="axis-marker" style="left: ${left}%">
                <span class="axis-label">${label}</span>
                <span class="axis-line"></span>
            </div>
        `);
    }

    // Add "NOW" marker
    markers.push(`
        <div class="axis-marker now" style="left: 100%">
            <span class="axis-label">NOW</span>
            <span class="axis-line"></span>
        </div>
    `);

    return markers.join('');
}

function renderTimelineRow(session, periods, startTime, endTime) {
    const duration = endTime - startTime;

    // Determine session status for styling (closed = historical session no longer running)
    const statusClass = session.state === 'closed' ? 'closed' :
                        session.state === 'active' ? 'active' : 'waiting';

    // Calculate last activity time
    const lastActivityTime = getLastActivityTime(periods);
    const lastActiveAgo = lastActivityTime ? formatTimeAgo(lastActivityTime) : 'N/A';
    const isZombie = lastActivityTime && (Date.now() - lastActivityTime) > (60 * 60 * 1000); // 1 hour

    // Generate bars for activity periods
    const barsHtml = periods.map((period, idx) => {
        const periodStart = new Date(period.start).getTime();
        const periodEnd = new Date(period.end).getTime();

        // Skip periods outside our time range
        if (periodEnd < startTime || periodStart > endTime) return '';

        // Clamp to visible range
        const visibleStart = Math.max(periodStart, startTime);
        const visibleEnd = Math.min(periodEnd, endTime);

        const left = ((visibleStart - startTime) / duration) * 100;
        const width = ((visibleEnd - visibleStart) / duration) * 100;

        // Encode period data for hover popover
        const periodData = encodeURIComponent(JSON.stringify({
            start: period.start,
            end: period.end,
            state: period.state,
            activities: period.activities || [],
            tools: period.tools || {}
        }));

        return `<div class="timeline-bar ${period.state}"
                     style="left: ${left}%; width: ${Math.max(width, 0.5)}%"
                     data-period="${periodData}"></div>`;
    }).join('');

    return `
        <div class="timeline-row ${isZombie ? 'zombie' : ''} ${session.isGastown ? 'gastown-row' : ''}" data-session-id="${session.sessionId}">
            <div class="timeline-label" onclick="focusWarpTab(previousSessions.get('${session.sessionId}'))">
                <span class="session-slug">${session.isGastown ? '🤖 ' : ''}${escapeHtml(session.slug)}</span>
                <span class="session-status ${statusClass}">${session.state}</span>
                <span class="last-active ${isZombie ? 'zombie-warning' : ''}">
                    ${isZombie ? '⚠️ ' : ''}${lastActiveAgo}
                </span>
            </div>
            <div class="timeline-track">
                ${barsHtml || '<span class="no-activity">No activity in last ' + timelineHours + ' hours</span>'}
            </div>
        </div>
    `;
}

function getLastActivityTime(periods) {
    if (!periods || periods.length === 0) return null;

    // Find the most recent period end time
    let latest = 0;
    for (const period of periods) {
        const endTime = new Date(period.end).getTime();
        if (endTime > latest) {
            latest = endTime;
        }
    }
    return latest || null;
}

function formatTimeAgo(timestamp) {
    const diffMs = Date.now() - timestamp;
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
}

// Timeline popover management
let timelinePopover = null;
let popoverHideTimeout = null;

function showTimelinePopover(event, element) {
    // Clear any pending hide
    if (popoverHideTimeout) {
        clearTimeout(popoverHideTimeout);
        popoverHideTimeout = null;
    }

    // Remove existing popover
    if (timelinePopover) {
        timelinePopover.remove();
    }

    // Parse period data
    let period;
    try {
        period = JSON.parse(decodeURIComponent(element.dataset.period));
    } catch (e) {
        return;
    }

    const start = new Date(period.start);
    const end = new Date(period.end);
    const startStr = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endStr = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const duration = Math.round((end - start) / 60000); // minutes

    // Build tool summary
    let toolSummary = '';
    if (period.tools && Object.keys(period.tools).length > 0) {
        const toolItems = Object.entries(period.tools)
            .sort((a, b) => b[1] - a[1]) // Sort by count descending
            .map(([tool, count]) => {
                const emoji = ACTIVITY_EMOJIS[tool] || '⚙️';
                return `<span class="tool-count">${emoji} ${escapeHtml(tool)} ×${count}</span>`;
            })
            .join('');
        toolSummary = `<div class="popover-tools">${toolItems}</div>`;
    }

    // Build activities list
    let activitiesList = '';
    if (period.activities && period.activities.length > 0) {
        const activityItems = period.activities
            .map(act => `<div class="popover-activity">${escapeHtml(act)}</div>`)
            .join('');
        activitiesList = `<div class="popover-activities">${activityItems}</div>`;
    }

    // Create popover
    timelinePopover = document.createElement('div');
    timelinePopover.className = 'timeline-popover';
    timelinePopover.innerHTML = `
        <div class="popover-header">
            <span class="popover-time">${startStr} - ${endStr}</span>
            <span class="popover-duration">(${duration}m)</span>
        </div>
        ${toolSummary}
        ${activitiesList || '<div class="popover-empty">No detailed activity</div>'}
    `;

    document.body.appendChild(timelinePopover);

    // Position below the bar
    const rect = element.getBoundingClientRect();
    const popoverRect = timelinePopover.getBoundingClientRect();

    // Prefer below, but flip above if not enough space
    let top = rect.bottom + window.scrollY + 8;
    if (top + popoverRect.height > window.innerHeight + window.scrollY - 20) {
        top = rect.top + window.scrollY - popoverRect.height - 8;
    }

    // Keep within horizontal bounds
    let left = rect.left + window.scrollX;
    if (left + popoverRect.width > window.innerWidth - 20) {
        left = window.innerWidth - popoverRect.width - 20;
    }
    if (left < 10) left = 10;

    timelinePopover.style.left = `${left}px`;
    timelinePopover.style.top = `${top}px`;

    // Allow hovering over the popover itself
    timelinePopover.addEventListener('mouseenter', () => {
        if (popoverHideTimeout) {
            clearTimeout(popoverHideTimeout);
            popoverHideTimeout = null;
        }
    });
    timelinePopover.addEventListener('mouseleave', hideTimelinePopover);
}

function hideTimelinePopover() {
    // Delay hiding to allow moving to popover
    popoverHideTimeout = setTimeout(() => {
        if (timelinePopover) {
            timelinePopover.remove();
            timelinePopover = null;
        }
    }, 150);
}

// Update tab indicator position
function updateTabIndicator(activeButton) {
    const indicator = document.querySelector('.tab-indicator');
    if (!indicator || !activeButton) return;

    const tabsContainer = document.querySelector('.view-tabs');
    const containerRect = tabsContainer.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();

    indicator.style.left = (buttonRect.left - containerRect.left) + 'px';
    indicator.style.width = buttonRect.width + 'px';
}

// View switching
function switchView(viewName) {
    // Track view in MissionControlManager
    missionControl.setView(viewName);

    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Update sliding indicator position
    const activeButton = document.querySelector(`.tab-button[data-view="${viewName}"]`);
    updateTabIndicator(activeButton);

    // Update view visibility
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });

    const targetView = document.getElementById(`${viewName}-view`);
    if (targetView) {
        targetView.classList.add('active');
    }

    // Track timeline view state
    timelineViewActive = (viewName === 'timeline');

    // Refresh timeline when switching to it
    if (viewName === 'timeline') {
        syncTimelineRangeSelect();
        refreshTimeline();
    }

    // Refresh gastown view when switching to it
    if (viewName === 'gastown') {
        const sessions = Array.from(previousSessions.values());
        const gastown = sessions.filter(s => s.isGastown);
        renderGastownView(gastown);
    }

    // Load analytics if switching to analytics view
    if (viewName === 'analytics' && typeof loadAnalytics === 'function') {
        loadAnalytics();
    }

    // Refresh Mission Control when switching to it
    if (viewName === 'mission-control') {
        refreshMissionControl();
    }

    // Refresh Graveyard when switching to it
    if (viewName === 'graveyard') {
        refreshGraveyard();
    }
}

function toggleAnalytics() {
    const currentView = document.querySelector('.tab-button.active')?.dataset.view;
    if (currentView === 'analytics') {
        switchView('sessions');
    } else {
        switchView('analytics');
    }
}

// Initial fetch - uses dirty-check polling for sub-second updates
// fetchSessions() will call scheduleNextPoll() which uses dirty-check when enabled
fetchSessions();

// Auto-refresh timeline when on that view
setInterval(() => {
    if (timelineViewActive) {
        refreshTimeline();
    }
}, 30000); // Refresh every 30 seconds when viewing timeline

// Periodic cleanup of orphaned StickyScroll instances to prevent memory leaks
setInterval(() => {
    StickyScroll.cleanupAll();
}, 60000); // Every 60 seconds

// Timeline bar hover event delegation
document.addEventListener('mouseover', (e) => {
    const bar = e.target.closest('.timeline-bar');
    if (bar && bar.dataset.period) {
        showTimelinePopover(e, bar);
    }
});

document.addEventListener('mouseout', (e) => {
    const bar = e.target.closest('.timeline-bar');
    if (bar) {
        hideTimelinePopover();
    }
});

// ============================================================================
// Feature 19: Historical Analytics Implementation
// ============================================================================

let currentAnalyticsPeriod = 'week';
let currentHistoryPage = 1;
let totalHistoryPages = 1;

async function loadAnalytics(period = currentAnalyticsPeriod) {
    currentAnalyticsPeriod = period;

    // Update period button states
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });

    const container = document.getElementById('analytics-container');
    container.innerHTML = '<div class="loading">Loading analytics...</div>';

    try {
        const response = await fetch(`/api/analytics?period=${period}`);
        if (!response.ok) throw new Error('Failed to fetch analytics');
        const data = await response.json();

        renderAnalytics(data);
    } catch (error) {
        console.error('Analytics error:', error);
        container.innerHTML = `
            <div class="empty-state">
                <h2>Unable to load analytics</h2>
                <p>${error.message}</p>
            </div>
        `;
    }
}

function renderAnalytics(data) {
    const container = document.getElementById('analytics-container');

    // Format active time
    const activeHours = data.active_time_hours || 0;
    let activeTimeDisplay;
    if (activeHours >= 1) {
        activeTimeDisplay = `${activeHours.toFixed(1)}h`;
    } else {
        activeTimeDisplay = `${Math.round(activeHours * 60)}m`;
    }

    // Format tokens
    const totalTokens = data.total_tokens || 0;
    let tokensDisplay;
    if (totalTokens >= 1000000) {
        tokensDisplay = `${(totalTokens / 1000000).toFixed(1)}M`;
    } else if (totalTokens >= 1000) {
        tokensDisplay = `${Math.round(totalTokens / 1000)}k`;
    } else {
        tokensDisplay = totalTokens.toString();
    }

    // Build change badges
    const formatChange = (value) => {
        if (value === 0) return '';
        const sign = value > 0 ? '↑' : '↓';
        const className = value > 0 ? 'positive' : 'negative';
        return `<span class="change ${className}">${sign} ${Math.abs(value)}%</span>`;
    };

    container.innerHTML = `
        <!-- Overview Stats -->
        <div class="overview-stats">
            <div class="stat-card">
                <div class="stat-value">${data.total_sessions}</div>
                <div class="stat-label">sessions this ${data.period}</div>
                ${formatChange(data.total_sessions_change)}
            </div>
            <div class="stat-card">
                <div class="stat-value">${activeTimeDisplay}</div>
                <div class="stat-label">active time</div>
                ${formatChange(data.active_time_change)}
            </div>
            <div class="stat-card">
                <div class="stat-value">~$${data.estimated_cost}</div>
                <div class="stat-label">estimated cost</div>
                ${formatChange(data.estimated_cost_change)}
            </div>
            <div class="stat-card">
                <div class="stat-value">${tokensDisplay}</div>
                <div class="stat-label">tokens used</div>
                ${formatChange(data.total_tokens_change)}
            </div>
        </div>

        <!-- Sessions Over Time Chart -->
        <div class="chart-section">
            <h3>Sessions Over Time</h3>
            <div class="bar-chart" id="sessions-chart">
                ${renderBarChart(data.time_breakdown)}
            </div>
        </div>

        <!-- Two column layout -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
            <!-- Activity by Hour -->
            <div class="chart-section">
                <h3>Activity by Hour</h3>
                <div class="heatmap-legend">
                    <span>Less</span>
                    <div class="legend-gradient"></div>
                    <span>More</span>
                </div>
                <div class="heatmap" id="activity-heatmap">
                    ${renderHeatmap(data.activity_by_hour)}
                </div>
                <div class="peak-info">Peak activity: ${formatHour(data.peak_hour)}</div>
            </div>

            <!-- Top Repositories -->
            <div class="chart-section">
                <h3>Top Repositories</h3>
                <div class="repos-list" id="repos-list">
                    ${renderTopRepos(data.top_repos)}
                </div>
            </div>
        </div>

        <!-- Duration Distribution -->
        <div class="chart-section">
            <h3>Session Duration Distribution</h3>
            <div class="duration-bars" id="duration-chart">
                ${renderDurationDistribution(data.duration_distribution)}
            </div>
        </div>

        <!-- Session History -->
        <div class="chart-section">
            <h3>Session History</h3>
            <div id="history-container">
                <div class="loading">Loading history...</div>
            </div>
        </div>
    `;

    // Load session history
    loadSessionHistory(1);
}

function renderBarChart(timeBreakdown) {
    if (!timeBreakdown || timeBreakdown.length === 0) {
        return '<div class="empty-state">No data for this period</div>';
    }

    const maxCount = Math.max(...timeBreakdown.map(d => d.count), 1);

    return timeBreakdown.map(d => {
        const height = Math.max((d.count / maxCount) * 100, 5);
        const label = d.label.includes('-') ? d.label.split('-').slice(1).join('-') : d.label;
        return `
            <div class="bar-wrapper">
                <div class="bar" style="height: ${height}%" title="${d.count} sessions on ${d.label}">
                    ${d.count > 0 ? `<span class="bar-value">${d.count}</span>` : ''}
                </div>
                <span class="bar-label">${formatBarLabel(label)}</span>
            </div>
        `;
    }).join('');
}

function formatBarLabel(label) {
    // For date labels like "2026-01-15", extract day
    if (label.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const date = new Date(label);
        return date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
    }
    // For hour labels like "09:00"
    if (label.match(/^\d{2}:00$/)) {
        const hour = parseInt(label.split(':')[0]);
        return hour === 0 ? '12am' : hour < 12 ? `${hour}am` : hour === 12 ? '12pm' : `${hour - 12}pm`;
    }
    return label;
}

function renderHeatmap(activityByHour) {
    if (!activityByHour) {
        return '<div class="empty-state">No activity data</div>';
    }

    const maxActivity = Math.max(...Object.values(activityByHour), 1);

    return Array.from({length: 24}, (_, hour) => {
        const count = activityByHour[hour] || 0;
        const intensity = Math.min(4, Math.ceil((count / maxActivity) * 4));
        const hourLabel = hour === 0 ? '12a' : hour < 12 ? `${hour}a` : hour === 12 ? '12p' : `${hour - 12}p`;

        return `
            <div class="heatmap-cell intensity-${intensity}" title="${count} active snapshots at ${hourLabel}">
                <span class="hour-label">${hour % 6 === 0 ? hourLabel : ''}</span>
            </div>
        `;
    }).join('');
}

function formatHour(hour) {
    if (hour === undefined || hour === null) return '--';
    if (hour === 0) return '12:00 AM';
    if (hour < 12) return `${hour}:00 AM`;
    if (hour === 12) return '12:00 PM';
    return `${hour - 12}:00 PM`;
}

function renderTopRepos(topRepos) {
    if (!topRepos || topRepos.length === 0) {
        return '<div class="empty-state" style="padding: 20px;">No repository data yet</div>';
    }

    const maxCount = Math.max(...topRepos.map(r => r.count), 1);

    return topRepos.map((repo, index) => `
        <div class="repo-item">
            <div class="repo-rank">${index + 1}</div>
            <div class="repo-info">
                <div class="repo-name">${escapeHtml(repo.name)}</div>
                <div class="repo-path">${escapeHtml(repo.path || '')}</div>
            </div>
            <div class="repo-stats">
                <span class="repo-count">${repo.count}</span>
                <div class="repo-bar">
                    <div class="repo-bar-fill" style="width: ${(repo.count / maxCount) * 100}%"></div>
                </div>
                <span class="repo-percentage">${repo.percentage || 0}%</span>
            </div>
        </div>
    `).join('');
}

function renderDurationDistribution(durationDist) {
    if (!durationDist || durationDist.total === 0) {
        return '<div class="empty-state" style="padding: 20px;">No duration data yet</div>';
    }

    const durations = [
        { label: '<5m', count: durationDist['<5m'], pct: durationDist['<5m_pct'] },
        { label: '5-30m', count: durationDist['5-30m'], pct: durationDist['5-30m_pct'] },
        { label: '30m-1h', count: durationDist['30m-1h'], pct: durationDist['30m-1h_pct'] },
        { label: '1-2h', count: durationDist['1-2h'], pct: durationDist['1-2h_pct'] },
        { label: '>2h', count: durationDist['>2h'], pct: durationDist['>2h_pct'] }
    ];

    return durations.map(d => `
        <div class="duration-item">
            <span class="duration-label">${d.label}</span>
            <div class="duration-bar-container">
                <div class="duration-bar" style="width: ${d.pct || 0}%"></div>
                <span class="duration-value">${d.count || 0} (${d.pct || 0}%)</span>
            </div>
        </div>
    `).join('');
}

async function loadSessionHistory(page = 1) {
    currentHistoryPage = page;
    const historyContainer = document.getElementById('history-container');

    if (!historyContainer) return;

    try {
        const response = await fetch(`/api/history?page=${page}&per_page=10`);
        if (!response.ok) throw new Error('Failed to fetch history');
        const data = await response.json();

        totalHistoryPages = data.total_pages;
        renderSessionHistory(data);
    } catch (error) {
        console.error('History error:', error);
        historyContainer.innerHTML = `<div class="empty-state">Unable to load history: ${error.message}</div>`;
    }
}

function renderSessionHistory(data) {
    const container = document.getElementById('history-container');

    if (!data.sessions || data.sessions.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding: 40px;">
                <p>No session history yet. Sessions will be recorded as you use Claude Code.</p>
            </div>
        `;
        return;
    }

    const rows = data.sessions.map(s => `
        <tr>
            <td class="date-col">
                <div>${s.date_display}</div>
                <div class="time-sub">${s.time_display}</div>
            </td>
            <td class="slug-col">${escapeHtml(s.slug || '--')}</td>
            <td class="repo-col">${escapeHtml(s.repo_name || '--')}</td>
            <td class="branch-col">${escapeHtml(s.git_branch || '--')}</td>
            <td class="duration-col">${s.duration_display || '--'}</td>
            <td class="tokens-col">${s.token_count ? s.token_count.toLocaleString() : '--'}</td>
        </tr>
    `).join('');

    container.innerHTML = `
        <table class="history-table">
            <thead>
                <tr>
                    <th class="date-col">Date</th>
                    <th>Slug</th>
                    <th>Repository</th>
                    <th>Branch</th>
                    <th class="duration-col">Duration</th>
                    <th class="tokens-col">Tokens</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
        <div class="pagination">
            <button onclick="loadSessionHistory(${currentHistoryPage - 1})" ${currentHistoryPage <= 1 ? 'disabled' : ''}>
                ← Previous
            </button>
            <span class="page-info">Page ${data.page} of ${data.total_pages}</span>
            <button onclick="loadSessionHistory(${currentHistoryPage + 1})" ${currentHistoryPage >= totalHistoryPages ? 'disabled' : ''}>
                Next →
            </button>
        </div>
    `;
}

// Initialize period selector buttons
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            loadAnalytics(btn.dataset.period);
        });
    });
});

// ============================================================================
// Feature 17: Multi-Machine Support Implementation
// ============================================================================

async function fetchMachines() {
    try {
        const response = await fetch('/api/machines');
        if (!response.ok) throw new Error('Failed to fetch machines');
        return await response.json();
    } catch (error) {
        console.error('Failed to fetch machines:', error);
        return { machines: [] };
    }
}

async function addMachine(name, host, sshKey = null) {
    try {
        const response = await fetch('/api/machines', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                host,
                ssh_key: sshKey,
                auto_reconnect: true
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to add machine');
        }

        return await response.json();
    } catch (error) {
        throw error;
    }
}

async function removeMachine(name) {
    try {
        const response = await fetch(`/api/machines/${encodeURIComponent(name)}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to remove machine');
        }

        return await response.json();
    } catch (error) {
        throw error;
    }
}

async function reconnectMachine(name) {
    try {
        const response = await fetch(`/api/machines/${encodeURIComponent(name)}/reconnect`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to reconnect');
        }

        return await response.json();
    } catch (error) {
        throw error;
    }
}

async function testMachineConnection(host, sshKey = null) {
    try {
        const params = new URLSearchParams({ host });
        if (sshKey) params.append('ssh_key', sshKey);

        const response = await fetch(`/api/machines/test?${params}`, {
            method: 'POST'
        });

        return await response.json();
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

function toggleMultiMachineMode() {
    multiMachineMode = !multiMachineMode;
    localStorage.setItem('multiMachineMode', JSON.stringify(multiMachineMode));
    updateMultiMachineUI();
    fetchSessions();
    showToast(multiMachineMode ? 'Multi-machine mode enabled' : 'Multi-machine mode disabled');
}

function updateMultiMachineUI() {
    const machinesBtn = document.getElementById('machines-button');
    const machineCount = document.getElementById('machine-count');

    if (machinesBtn) {
        machinesBtn.classList.toggle('active', multiMachineMode);
    }

    // Update machine count badge
    if (machineCount && machinesData.remote) {
        const connectedCount = Object.values(machinesData.remote)
            .filter(r => !r.error).length;
        if (multiMachineMode && connectedCount > 0) {
            machineCount.textContent = `+${connectedCount}`;
            machineCount.classList.remove('hidden');
        } else {
            machineCount.classList.add('hidden');
        }
    }
}

async function showMachinesModal() {
    const machines = await fetchMachines();

    const machineListHtml = machines.machines.length === 0 ? `
        <div class="empty-state" style="padding: 20px;">
            <p>No remote machines configured.</p>
            <p>Add a machine running the remote agent to monitor sessions across multiple computers.</p>
        </div>
    ` : machines.machines.map(m => `
        <div class="machine-item ${m.connected ? 'connected' : 'disconnected'}">
            <div class="machine-info">
                <span class="machine-name">${escapeHtml(m.name)}</span>
                <span class="machine-host">${escapeHtml(m.host)}</span>
            </div>
            <div class="machine-status">
                <span class="status-dot ${m.connected ? 'connected' : 'disconnected'}"></span>
                ${m.connected ? 'Connected' : 'Disconnected'}
                ${m.last_error ? `<span class="machine-error" title="${escapeHtml(m.last_error)}">⚠️</span>` : ''}
            </div>
            <div class="machine-actions">
                ${!m.connected ? `
                    <button onclick="handleReconnect('${escapeHtml(m.name)}')" class="btn-small">Reconnect</button>
                ` : ''}
                <button onclick="handleRemoveMachine('${escapeHtml(m.name)}')" class="btn-small danger">Remove</button>
            </div>
        </div>
    `).join('');

    showModal(`
        <div class="machines-modal">
            <div class="modal-header">
                <h2>🖥️ Multi-Machine Management</h2>
                <button onclick="closeModal()" class="modal-close">Close</button>
            </div>

            <div class="setting-group">
                <label class="setting-toggle">
                    <input type="checkbox" ${multiMachineMode ? 'checked' : ''}
                           onchange="toggleMultiMachineMode()">
                    <span>Enable multi-machine mode</span>
                </label>
                <p class="setting-desc">Aggregate sessions from all connected remote machines.</p>
            </div>

            <div class="machines-section">
                <h3>Remote Machines</h3>
                <div class="machines-list">
                    ${machineListHtml}
                </div>
            </div>

            <div class="add-machine-section">
                <h3>Add New Machine</h3>
                <div class="add-machine-form">
                    <div class="form-row">
                        <label for="machine-name">Display Name</label>
                        <input type="text" id="machine-name" placeholder="e.g., Work Laptop">
                    </div>
                    <div class="form-row">
                        <label for="machine-host">SSH Host</label>
                        <input type="text" id="machine-host" placeholder="user@hostname or hostname">
                    </div>
                    <div class="form-row">
                        <label for="machine-key">SSH Key (optional)</label>
                        <input type="text" id="machine-key" placeholder="~/.ssh/id_rsa">
                    </div>
                    <div class="form-actions">
                        <button onclick="testConnection()" class="btn-secondary">Test Connection</button>
                        <button onclick="handleAddMachine()" class="btn-primary">Add Machine</button>
                    </div>
                    <div id="connection-status" class="connection-status hidden"></div>
                </div>
            </div>

            <div class="help-section">
                <h4>Setup Guide</h4>
                <ol>
                    <li>Copy <code>remote_agent.py</code> to the remote machine</li>
                    <li>Run <code>python3 remote_agent.py</code> on the remote machine</li>
                    <li>Ensure SSH access is configured</li>
                    <li>Add the machine above using its SSH hostname</li>
                </ol>
            </div>
        </div>
    `);
}

async function testConnection() {
    const host = document.getElementById('machine-host').value.trim();
    const sshKey = document.getElementById('machine-key').value.trim() || null;
    const statusEl = document.getElementById('connection-status');

    if (!host) {
        statusEl.textContent = 'Please enter a host';
        statusEl.className = 'connection-status error';
        statusEl.classList.remove('hidden');
        return;
    }

    statusEl.textContent = 'Testing connection...';
    statusEl.className = 'connection-status';
    statusEl.classList.remove('hidden');

    const result = await testMachineConnection(host, sshKey);

    if (result.status === 'success') {
        statusEl.textContent = '✓ Connection successful';
        statusEl.className = 'connection-status success';
    } else {
        statusEl.textContent = `✗ ${result.message}`;
        statusEl.className = 'connection-status error';
    }
}

async function handleAddMachine() {
    const name = document.getElementById('machine-name').value.trim();
    const host = document.getElementById('machine-host').value.trim();
    const sshKey = document.getElementById('machine-key').value.trim() || null;
    const statusEl = document.getElementById('connection-status');

    if (!name || !host) {
        statusEl.textContent = 'Please enter both name and host';
        statusEl.className = 'connection-status error';
        statusEl.classList.remove('hidden');
        return;
    }

    statusEl.textContent = 'Adding machine...';
    statusEl.className = 'connection-status';
    statusEl.classList.remove('hidden');

    try {
        await addMachine(name, host, sshKey);
        showToast(`Added machine: ${name}`);
        closeModal();
        showMachinesModal(); // Refresh the modal
    } catch (error) {
        statusEl.textContent = `✗ ${error.message}`;
        statusEl.className = 'connection-status error';
    }
}

async function handleRemoveMachine(name) {
    if (!confirm(`Remove machine "${name}"?`)) return;

    try {
        await removeMachine(name);
        showToast(`Removed machine: ${name}`);
        closeModal();
        showMachinesModal(); // Refresh
    } catch (error) {
        showToast(`Failed to remove: ${error.message}`, 'error');
    }
}

async function handleReconnect(name) {
    try {
        showToast(`Reconnecting to ${name}...`);
        await reconnectMachine(name);
        showToast(`Connected to ${name}`);
        closeModal();
        showMachinesModal(); // Refresh
    } catch (error) {
        showToast(`Failed to reconnect: ${error.message}`, 'error');
    }
}

// Update fetchSessions to support multi-machine mode
const originalFetchSessions = fetchSessions;
fetchSessions = async function() {
    try {
        // Feature 15: Periodically fetch AI summaries
        const now = Date.now();
        const includeSummaries = (now - lastSummaryRefresh) > summaryRefreshInterval;

        let url, data;

        if (multiMachineMode) {
            // Fetch from all machines
            url = includeSummaries ? `${API_URL_ALL}?include_summaries=true` : API_URL_ALL;
            const response = await fetch(url);
            if (!response.ok) throw new Error('API error');
            data = await response.json();

            // Store machine data for UI
            machinesData = {
                local: data.local,
                remote: data.remote
            };

            // Flatten sessions from all machines
            const allSessions = [
                ...(data.local?.sessions || []),
                ...Object.values(data.remote || {})
                    .filter(r => !r.error)
                    .flatMap(r => r.sessions || [])
            ];

            if (includeSummaries) {
                lastSummaryRefresh = now;
            }

            // Feature 07: Check for state changes and send notifications
            checkStateChanges(previousSessionsForNotifications, allSessions);
            previousSessionsForNotifications = [...allSessions];

            // Clean up sessions that no longer exist in API response
            const currentSessionIds = new Set(allSessions.map(s => s.sessionId));
            for (const sessionId of previousSessions.keys()) {
                if (!currentSessionIds.has(sessionId)) {
                    previousSessions.delete(sessionId);
                }
            }

            // Store all sessions
            allSessions.forEach(s => previousSessions.set(s.sessionId, { ...s }));

            // Render with filters and grouping
            renderCurrentSessions(allSessions);

            // Update status with machine info
            const activeCount = allSessions.filter(s => s.state === 'active').length;
            const localActive = (data.local?.totals?.active || 0);
            const remoteConnected = Object.values(data.remote || {}).filter(r => !r.error).length;

            let label = `${activeCount} active, ${allSessions.length - activeCount} waiting`;
            if (remoteConnected > 0) {
                label += ` (${data.machineCount} machines)`;
            }
            document.getElementById('session-count').textContent = label;
            try {
                document.getElementById('last-update').textContent = `Updated: ${new Date(data.timestamp).toLocaleTimeString()}`;
            } catch {}

        } else {
            // Original single-machine mode
            url = includeSummaries ? `${API_URL}?include_summaries=true` : API_URL;
            const response = await fetch(url);
            if (!response.ok) throw new Error('API error');
            data = await response.json();

            if (includeSummaries) {
                lastSummaryRefresh = now;
            }

            // Feature 07: Check for state changes and send notifications
            checkStateChanges(previousSessionsForNotifications, data.sessions);
            previousSessionsForNotifications = [...data.sessions];

            // Clean up sessions that no longer exist in API response
            const currentSessionIds = new Set(data.sessions.map(s => s.sessionId));
            for (const sessionId of previousSessions.keys()) {
                if (!currentSessionIds.has(sessionId)) {
                    previousSessions.delete(sessionId);
                }
            }

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
        }

        // Update multi-machine UI
        updateMultiMachineUI();

        // Schedule next poll with adaptive interval
        const activeCount = multiMachineMode
            ? [...(data.local?.sessions || []), ...Object.values(data.remote || {}).filter(r => !r.error).flatMap(r => r.sessions || [])].filter(s => s.state === 'active').length
            : data.sessions.filter(s => s.state === 'active').length;
        scheduleNextPoll(activeCount > 0);

    } catch (error) {
        console.error('Failed to fetch sessions:', error);
        // On error, still schedule next poll
        scheduleNextPoll(false);
    }
};

// Override groupSessionsByProject to support machine grouping in multi-machine mode
const originalGroupSessionsByProject = groupSessionsByProject;
groupSessionsByProject = function(sessions) {
    if (multiMachineMode) {
        // Group by machine first, then by project
        const machineGroups = {};

        for (const session of sessions) {
            const machine = session.machine || 'local';
            const machineHostname = session.machineHostname || machine;

            if (!machineGroups[machine]) {
                machineGroups[machine] = {
                    name: machineHostname,
                    machineKey: machine,
                    sessions: [],
                    activeCount: 0,
                    collapsed: groupCollapsedState[`machine:${machine}`] || false
                };
            }
            machineGroups[machine].sessions.push(session);
            if (session.state === 'active') {
                machineGroups[machine].activeCount++;
            }
        }

        // Convert to array and sort (local first, then alphabetically for stability)
        return Object.values(machineGroups).sort((a, b) => {
            if (a.machineKey === 'local') return -1;
            if (b.machineKey === 'local') return 1;
            return a.name.localeCompare(b.name);
        });
    }

    // Original project-based grouping
    return originalGroupSessionsByProject(sessions);
};

// Override renderGroups to handle machine groups (horizontal layout)
const originalRenderGroups = renderGroups;
renderGroups = function(groups) {
    const container = document.getElementById('sessions-container');
    container.innerHTML = '';
    let cardIndex = 0;

    const createCardFn = cardDisplayMode === 'compact' ? createCompactCard : createCard;

    groups.forEach(group => {
        const isMachineGroup = multiMachineMode && group.machineKey;
        const icon = isMachineGroup
            ? (group.machineKey === 'local' ? '💻 ' : '🖥️ ')
            : '';

        const groupDiv = document.createElement('div');
        groupDiv.className = 'session-row';

        // Left side: repo/machine name
        const labelDiv = document.createElement('div');
        labelDiv.className = 'session-row-label';
        labelDiv.innerHTML = `
            <span class="row-name">${icon}${escapeHtml(group.name)}</span>
            <span class="row-stats">
                ${group.sessions.length}${group.activeCount > 0 ? ` <span class="row-active">(${group.activeCount} active)</span>` : ''}
            </span>
        `;
        groupDiv.appendChild(labelDiv);

        // Right side: horizontal cards
        const sessionsDiv = document.createElement('div');
        sessionsDiv.className = 'session-row-cards';
        sessionsDiv.dataset.cardCount = Math.min(group.sessions.length, 4);

        group.sessions.forEach(session => {
            const card = createCardFn(session, cardIndex++);
            sessionsDiv.appendChild(card);
        });

        groupDiv.appendChild(sessionsDiv);
        container.appendChild(groupDiv);
    });

    allVisibleSessions = groups.flatMap(g => g.sessions);
};

// Initialize multi-machine UI on load
document.addEventListener('DOMContentLoaded', () => {
    updateMultiMachineUI();
});

// ============================================================================
// Feature: Mission Control - Live Session Monitoring
// ============================================================================

// Mission Control state
let mcSelectedSessionId = null;
let mcConversationCache = new Map();
let mcStickyScroll = null;  // StickyScroll instance for Mission Control
let mcLastMessageCount = 0;

/**
 * Initialize Mission Control event listeners
 */
function initMissionControl() {
    // Refresh button
    const refreshBtn = document.getElementById('mc-refresh');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
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

    // Handle input for syntax highlighting
    inputEl.addEventListener('input', () => {
        highlightMCInput(inputEl);
    });

    // Handle Cmd+Enter to send
    inputEl.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            sendMCMessage();
        }
    });

    // Handle paste - strip formatting
    inputEl.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
    });

    // Send button click
    sendBtn.addEventListener('click', () => {
        sendMCMessage();
    });
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
    const message = inputEl.innerText.trim();
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

        // Success - clear input
        inputEl.innerHTML = '';
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
        const sessionStillExists = sessions.some(s => s.sessionId === mcSelectedSessionId);
        if (sessionStillExists) {
            loadConversationHistory(mcSelectedSessionId, true);
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

    // Separate gastown from regular sessions
    const regularSessions = sessions.filter(s => !s.isGastown);
    const gastownSessions = sessions.filter(s => s.isGastown);

    // Group regular sessions by repo
    const groups = groupSessionsByRepo(regularSessions);

    // Group gastown sessions
    const gastownGroups = groupGastownByRepo(gastownSessions);

    // Differential update: update existing items in place, only add/remove as needed
    const existingItems = new Map();
    container.querySelectorAll('.mc-session-item').forEach(el => {
        existingItems.set(el.dataset.sessionId, el);
    });

    // Track which sessions we've seen (to detect removals)
    const seenSessionIds = new Set();

    // Build new HTML only if structure changed significantly
    const allSessions = [...regularSessions, ...gastownSessions];
    const currentSessionIds = allSessions.map(s => s.sessionId).join(',');
    const previousSessionIds = container.dataset.sessionIds || '';

    // If session list structure changed (add/remove), do full rebuild
    if (currentSessionIds !== previousSessionIds) {
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

        // Gastown section (if any)
        if (gastownSessions.length > 0) {
            html += `<div class="mc-gastown-section">`;
            html += `<div class="mc-section-header">🏭 Gas Town</div>`;

            for (const group of gastownGroups) {
                html += `
                    <div class="mc-repo-group mc-gastown-group">
                        <div class="mc-repo-header">${escapeHtml(group.repoName)}</div>
                        <div class="mc-repo-sessions">
                            ${group.sessions.map(session => renderMCSessionItem(session, true)).join('')}
                        </div>
                    </div>
                `;
            }
            html += `</div>`;
        }

        container.innerHTML = html;
        container.dataset.sessionIds = currentSessionIds;

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
                const isGastown = session.isGastown;
                const newHtml = renderMCSessionItem(session, isGastown);
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

function renderMCSessionItem(session, isGastown = false) {
    const isSelected = session.sessionId === mcSelectedSessionId;
    const displayName = session.cwd ? session.cwd.split('/').pop() : session.sessionId.slice(0, 8);
    const duration = formatAgentDuration(session.startTimestamp) || '0m';
    const contextPct = Math.round(session.tokenPercentage || 0);

    // Determine state emoji based on activity status
    // Green = active, Orange = stale (1-60 min idle), Yellow = idle (>1hr)
    const activityStatus = getActivityStatus(session.lastActivity);
    let stateEmoji = '🟢';  // active
    if (session.state !== 'active') {
        stateEmoji = activityStatus.isStale ? '🟠' : '🟡';  // orange for stale, yellow for idle
    }

    // Show activity status - always use activityStatus for consistent display
    const activityHtml = activityStatus.text
        ? `<span class="${activityStatus.class}">${activityStatus.text}</span>`
        : '<span class="idle-indicator">idle</span>';

    // For gastown, show role icon
    let roleIcon = '';
    if (isGastown && session.gastownRole) {
        const agentType = getGastownAgentType(session.gastownRole);
        roleIcon = `<span class="gt-icon ${agentType.css}" title="${agentType.label}">${agentType.icon}</span> `;
    }

    return `
        <div class="mc-session-item ${session.state === 'active' ? 'active' : ''} ${isSelected ? 'selected' : ''}"
             data-session-id="${session.sessionId}">
            <div class="mc-session-name">${stateEmoji} ${roleIcon}${escapeHtml(displayName)}</div>
            <div class="mc-session-meta">
                <span>${duration}</span>
                <span>${contextPct}% ctx</span>
                ${activityHtml}
            </div>
        </div>
    `;
}

/**
 * Select a session in Mission Control
 */
function selectMissionControlSession(sessionId) {
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

    // Show/hide message input based on session state
    if (session && (session.state === 'active' || session.state === 'waiting')) {
        showMCInput();
    } else {
        hideMCInput();
    }

    // Load conversation
    loadConversationHistory(sessionId);
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
        const hasTools = msg.tools && msg.tools.length > 0;
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
    // Build all message HTML
    const html = filteredMessages.map((msg, idx) => {
        const role = msg.role || 'unknown';
        const roleClass = role === 'user' ? 'human' : role === 'system' ? 'system' : 'assistant';
        const roleLabel = role === 'user' ? '👤 You' : role === 'system' ? '📋 System' : '🤖 Assistant';
        const timestamp = msg.timestamp ? formatTimeAgo(new Date(msg.timestamp)) : '';

        // Handle continuation markers specially
        if (msg.isContinuation) {
            const continuationId = msg.continuationId || '';
            const shortId = continuationId.slice(0, 8);
            return `
                <div class="mc-continuation-marker" data-idx="${idx}" data-continuation-id="${continuationId}">
                    <div class="mc-continuation-line"></div>
                    <div class="mc-continuation-content">
                        <span class="mc-continuation-icon">⬇️</span>
                        <span class="mc-continuation-text">Conversation continued...</span>
                        ${shortId ? `<span class="mc-continuation-id">${shortId}</span>` : ''}
                    </div>
                    <div class="mc-continuation-line"></div>
                </div>
            `;
        }

        let displayContent = '';
        if (msg.content && msg.content.trim()) {
            if (msg.isCompaction) {
                displayContent = `<div class="mc-compaction">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div>`;
            } else {
                const content = escapeHtml(msg.content).slice(0, 500);
                const truncated = msg.content.length > 500 ? '...' : '';
                displayContent = content + truncated;
            }
        } else if (msg.tools && msg.tools.length > 0) {
            displayContent = `<span class="mc-tools">🔧 ${msg.tools.join(', ')}</span>`;
        }

        return `
            <div class="mc-message ${roleClass}" data-idx="${idx}">
                <div class="mc-message-header">
                    <span class="mc-message-role">${roleLabel}</span>
                    <span class="mc-message-time">${timestamp}</span>
                </div>
                <div class="mc-message-content">${displayContent}</div>
            </div>
        `;
    }).join('');

    streamEl.innerHTML = html;

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
 * Format time ago helper
 */
function formatTimeAgo(date) {
    // Handle both Date objects and timestamps
    const dateObj = date instanceof Date ? date : new Date(date);
    if (isNaN(dateObj.getTime())) return 'N/A';

    const now = new Date();
    const diffMs = now - dateObj;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return dateObj.toLocaleDateString();
}

// Initialize Mission Control on DOM ready
document.addEventListener('DOMContentLoaded', initMissionControl);

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

        listEl.innerHTML = directories.map(dir => `
            <div class="spawn-recent-item" onclick="selectSpawnDirectory('${escapeHtml(dir.path)}')">
                <span class="dir-icon">📁</span>
                <div class="dir-info">
                    <div class="dir-name">${escapeHtml(dir.name)}</div>
                    <div class="dir-path">${escapeHtml(dir.path)}</div>
                </div>
            </div>
        `).join('');
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

        // Track the managed process
        managedProcesses.set(processId, {
            id: processId,
            cwd: data.cwd,
            state: data.state,
            ws: null
        });

        hideSpawnModal();
        showToast(`Spawned session in ${data.cwd}`, 'success');

        // Connect to process output stream
        connectToProcess(processId);

        // Refresh the session list
        refreshMissionControl();
        refreshManagedProcessList();

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
    const process = managedProcesses.get(processId);
    if (!process) return;

    switch (msg.type) {
        case 'output':
            appendTerminalOutput(processId, msg.data);
            break;

        case 'history':
            // Received buffered history on connect
            if (Array.isArray(msg.lines)) {
                const content = msg.lines.join('');
                setTerminalOutput(processId, content);
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
    }
}

/**
 * Set terminal output content (replacing existing)
 */
function setTerminalOutput(processId, content) {
    if (selectedProcessId !== processId) return;

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
 * Append content to terminal output
 */
function appendTerminalOutput(processId, content) {
    if (selectedProcessId !== processId) return;

    const terminalEl = document.getElementById('mc-terminal-output');
    const contentEl = terminalEl?.querySelector('.mc-terminal-content');

    if (contentEl) {
        contentEl.innerHTML += parseAnsiToHtml(content);
        processOutputStickyScroll?.scrollToBottom();
    }
}

/**
 * Parse ANSI escape codes to HTML
 */
function parseAnsiToHtml(text) {
    if (!text) return '';

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
    let i = 0;

    // Escape HTML first
    text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Parse ANSI sequences
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

/**
 * Update UI for a managed process
 */
function updateProcessUI(processId) {
    refreshManagedProcessList();

    // Update kill button visibility
    if (selectedProcessId === processId) {
        const killBtn = document.getElementById('mc-kill-btn');
        const process = managedProcesses.get(processId);
        if (killBtn && process) {
            killBtn.classList.toggle('hidden', process.state === 'stopped');
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
                    ws: null
                });
            } else {
                const existing = managedProcesses.get(p.id);
                existing.state = p.state;
                existing.exitCode = p.exit_code;
            }
        }

        // Clean up stopped processes not in the list
        const activeIds = new Set(processes.map(p => p.id));
        for (const [id, process] of managedProcesses) {
            if (!activeIds.has(id) && process.state === 'stopped') {
                managedProcesses.delete(id);
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
        titleEl.textContent = 'Terminal Output';
    }

    if (killBtn) {
        killBtn.classList.toggle('hidden', process.state === 'stopped');
    }

    // Show terminal output, hide conversation stream
    const streamEl = document.getElementById('mc-conversation-stream');
    const terminalEl = document.getElementById('mc-terminal-output');

    if (streamEl) streamEl.classList.add('hidden');
    if (terminalEl) {
        terminalEl.classList.remove('hidden');
        // Clear and reconnect
        const contentEl = terminalEl.querySelector('.mc-terminal-content');
        if (contentEl) contentEl.innerHTML = '';
    }

    // Show input for managed processes
    showMCInput();

    // Connect to WebSocket if not already
    if (!process.ws || process.ws.readyState !== WebSocket.OPEN) {
        connectToProcess(processId);
    }
}

/**
 * Send input to a managed process
 */
async function sendProcessInput() {
    if (!selectedProcessId) return;

    const inputEl = document.getElementById('mc-input');
    const statusEl = document.getElementById('mc-input-status');
    const text = inputEl?.innerText?.trim();

    if (!text) return;

    try {
        const response = await fetch(`/api/process/${selectedProcessId}/stdin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, newline: true })
        });

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

/**
 * Kill the currently selected managed process
 */
async function killSelectedProcess() {
    if (!selectedProcessId) return;

    const process = managedProcesses.get(selectedProcessId);
    if (!process || process.state === 'stopped') return;

    if (!confirm(`Stop process in ${process.cwd}?`)) return;

    try {
        const response = await fetch(`/api/process/${selectedProcessId}/kill`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        showToast('Process stopped', 'success');
        refreshManagedProcessList();

    } catch (error) {
        console.error('Failed to kill process:', error);
        showToast(`Failed to stop: ${error.message}`, 'error');
    }
}

/**
 * Override sendMCMessage to handle both detected and managed sessions
 */
const originalSendMCMessage = sendMCMessage;
sendMCMessage = async function() {
    if (selectedProcessId) {
        // Send to managed process
        await sendProcessInput();
    } else if (mcSelectedSessionId) {
        // Send to detected session (original behavior)
        await originalSendMCMessage();
    }
};

/**
 * Override selectMissionControlSession to handle session type switching
 */
const originalSelectMissionControlSession = selectMissionControlSession;
selectMissionControlSession = function(sessionId) {
    // Deselect managed process
    selectedProcessId = null;

    // Update type badge to detected
    const typeEl = document.getElementById('mc-session-type');
    const titleEl = document.getElementById('mc-panel-title');
    const killBtn = document.getElementById('mc-kill-btn');

    if (typeEl) {
        typeEl.textContent = 'Detected';
        typeEl.className = 'mc-session-type-badge detected';
    }

    if (titleEl) {
        titleEl.textContent = 'Live Conversation';
    }

    if (killBtn) {
        killBtn.classList.add('hidden');
    }

    // Show conversation stream, hide terminal output
    const streamEl = document.getElementById('mc-conversation-stream');
    const terminalEl = document.getElementById('mc-terminal-output');

    if (streamEl) streamEl.classList.remove('hidden');
    if (terminalEl) terminalEl.classList.add('hidden');

    // Call original function
    originalSelectMissionControlSession(sessionId);
};

/**
 * Render managed processes in the session list
 */
function renderManagedProcessesInList(container) {
    if (managedProcesses.size === 0) return '';

    let html = '<div class="mc-managed-section">';
    html += '<div class="mc-section-header">🖥️ Managed Sessions</div>';

    for (const [id, process] of managedProcesses) {
        const stateEmoji = process.state === 'running' ? '🟢' :
                          process.state === 'stopped' ? '⚫' : '🟡';
        const dirName = process.cwd.split('/').pop() || process.cwd;
        const isSelected = selectedProcessId === id;

        html += `
            <div class="mc-session-item managed ${isSelected ? 'selected' : ''}"
                 data-process-id="${id}"
                 onclick="selectManagedProcess('${id}')">
                <div class="mc-session-name">${stateEmoji} ${escapeHtml(dirName)}<span class="managed-badge">MC</span></div>
                <div class="mc-session-meta">${escapeHtml(process.cwd)}</div>
            </div>
        `;
    }

    html += '</div>';
    return html;
}

// Patch renderMissionControlSessions to include managed processes
const originalRenderMissionControlSessions = renderMissionControlSessions;
renderMissionControlSessions = function(sessions) {
    // Call original to render detected sessions
    originalRenderMissionControlSessions(sessions);

    // Add managed processes section
    const container = document.getElementById('mc-sessions-list');
    if (container && managedProcesses.size > 0) {
        // Insert managed processes at the top
        const managedHtml = renderManagedProcessesInList(container);
        container.insertAdjacentHTML('afterbegin', managedHtml);

        // Add click handlers for managed process items
        container.querySelectorAll('.mc-session-item[data-process-id]').forEach(el => {
            el.onclick = () => selectManagedProcess(el.dataset.processId);
        });
    }

    // Update count to include managed processes
    const countEl = document.getElementById('mc-active-count');
    if (countEl) {
        const runningManaged = Array.from(managedProcesses.values()).filter(p => p.state === 'running').length;
        const total = sessions.length + runningManaged;
        countEl.textContent = total;
    }
};

// ============================================================================
// Session Graveyard - View dead/ended sessions
// ============================================================================

let graveyardData = { gastown: [], regular: [] };
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
        html += '<div class="graveyard-section-header">📁 Regular Sessions</div>';

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

    // Gastown section
    if (data.gastown.length > 0) {
        const gastownGroups = groupGraveyardByRepo(data.gastown);
        html += '<div class="graveyard-section graveyard-gastown">';
        html += '<div class="graveyard-section-header">🏭 Gas Town</div>';

        for (const group of gastownGroups) {
            html += `
                <div class="graveyard-group">
                    <div class="graveyard-group-header">${escapeHtml(group.name)}</div>
                    <div class="graveyard-group-sessions">
                        ${group.sessions.map(s => renderGraveyardCard(s, true)).join('')}
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
function renderGraveyardCard(session, isGastown = false) {
    const displayName = session.cwd ? session.cwd.split('/').pop() : session.slug || session.sessionId.slice(0, 8);
    const contextPct = Math.round(session.tokenPercentage || 0);
    const duration = formatAgentDuration(session.startTimestamp) || '?';

    // Format ended time
    const endedAgo = formatRecency(session.recency);

    // Gastown role icon
    let roleIcon = '';
    if (isGastown && session.gastownRole) {
        const agentType = getGastownAgentType(session.gastownRole);
        roleIcon = `<span class="gt-icon ${agentType.css}">${agentType.icon}</span> `;
    }

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
                <div class="match-types">📍 Found in: ${escapeHtml(matchTypes)}</div>
                ${snippetHtml}
            </div>
        `;
    } else if (session.summary) {
        previewContent = `<div class="graveyard-summary">${escapeHtml(session.summary.substring(0, 100))}${session.summary.length > 100 ? '...' : ''}</div>`;
    }

    // Activity log section (if available)
    let activityLogContent = '';
    if (session.hasActivityLog && session.activityLog && session.activityLog.length > 0) {
        // Filter to only PostToolUse events (more informative)
        const postEvents = session.activityLog.filter(a => a.event === 'PostToolUse');
        const recentActivities = postEvents.slice(-15); // Last 15 activities
        const activityHtml = recentActivities
            .map(a => {
                const emoji = getToolEmoji(a.tool || 'unknown');
                const desc = a.description || a.tool || 'Activity';
                return `<span class="activity-item" title="${escapeHtml(desc)}">${emoji}</span>`;
            })
            .join('');
        activityLogContent = `
            <div class="graveyard-activity-log">
                <div class="activity-trail">${activityHtml}</div>
                <span class="activity-count">${postEvents.length} tools</span>
            </div>
        `;
    }

    return `
        <div class="graveyard-card${session.matchSnippets ? ' search-match' : ''}${session.hasActivityLog ? ' has-activity' : ''}" data-session-id="${session.sessionId}">
            <div class="graveyard-card-header">
                <span class="graveyard-name">💀 ${roleIcon}${escapeHtml(displayName)}</span>
                <span class="graveyard-ended">${endedAgo}</span>
            </div>
            <div class="graveyard-card-meta">
                <span>${duration}</span>
                <span>${contextPct}% ctx</span>
            </div>
            ${previewContent}
            ${activityLogContent}
            <div class="graveyard-card-actions">
                <button class="graveyard-btn" onclick="event.stopPropagation(); resumeSession('${session.sessionId}')" title="Resume this session">
                    ▶️ Resume
                </button>
                <button class="graveyard-btn" onclick="event.stopPropagation(); copyResumeCmd('${session.sessionId}')" title="Copy resume command">
                    📋 Copy
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
    const session = [...graveyardData.regular, ...graveyardData.gastown].find(s => s.sessionId === sessionId);
    if (!session) return;

    const displayName = session.cwd ? session.cwd.split('/').pop() : session.slug;
    const endedAgo = formatRecency(session.recency);

    showModal(`
        <div class="graveyard-details">
            <h2>💀 ${escapeHtml(displayName)}</h2>
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
                <button class="btn-primary" onclick="resumeSession('${session.sessionId}'); closeModal();">
                    ▶️ Resume Session
                </button>
                <button class="btn-secondary" onclick="copyResumeCmd('${session.sessionId}')">
                    📋 Copy Resume Command
                </button>
                <button class="btn-secondary" onclick="openJsonl('${session.sessionId}')">
                    📂 Open JSONL File
                </button>
            </div>
        </div>
    `);
}

/**
 * Resume a dead session in a new terminal
 */
function resumeSession(sessionId) {
    const cmd = `claude --resume ${sessionId}`;

    // Try to copy to clipboard
    navigator.clipboard.writeText(cmd).then(() => {
        showToast(`Resume command copied! Paste in terminal to resume.`);
    }).catch(() => {
        showToast(`Resume: ${cmd}`, 'info');
    });
}

console.log('Claude Session Visualizer loaded - All features active (including Feature 17: Multi-Machine Support)');

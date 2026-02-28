// Dirty-check polling intervals (fast lightweight checks)
const DIRTY_CHECK_INTERVAL = 200;     // 200ms dirty-check frequency (reduced from 500ms)
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

// WebSocket session updates state - when active, reduces polling overhead
let wsSessionUpdatesActive = false;
let lastWsUpdateTime = 0;
const WS_UPDATE_TIMEOUT = 10000;  // Fall back to polling if no WS update for 10s

const API_URL = '/api/sessions';
const API_URL_CHANGED = '/api/sessions/changed';
const API_URL_ALL = '/api/sessions/all';
let previousSessions = new Map();

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

// SDK Mode state - whether to use claude-agent-sdk or PTY
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
                    <button class="indicator-resume" onclick="StickyScroll.resumeById('${escapeJsString(this.id)}')">Resume</button>
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
            button.innerHTML = this.enabled ? icon('volume-2', {size:16}) : icon('volume-x', {size:16});
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

// ============================================================================
// Logger - Structured logging utility for debugging
// ============================================================================

class Logger {
    static LEVELS = {
        DEBUG: 0,
        INFO: 1,
        WARN: 2,
        ERROR: 3,
        OFF: 4
    };

    static _instance = null;
    static buffer = [];
    static BUFFER_SIZE = 500;
    static serverLogsEnabled = false;
    static showTimestamps = true;
    static level = Logger.LEVELS.INFO;
    static enabledNamespaces = new Set(); // Empty = all enabled
    static debugPanelVisible = false;

    static init() {
        // Load config from localStorage
        const config = Logger._loadConfig();
        Logger.level = config.level ?? Logger.LEVELS.INFO;
        Logger.serverLogsEnabled = config.serverLogs ?? false;
        Logger.showTimestamps = config.timestamps ?? true;
        Logger.enabledNamespaces = new Set(config.namespaces ?? []);

        // Check URL for debug mode
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('debug') === 'true') {
            Logger.level = Logger.LEVELS.DEBUG;
            Logger.debugPanelVisible = true;
        }
    }

    static _loadConfig() {
        try {
            const saved = localStorage.getItem('csv_debug_config');
            return saved ? JSON.parse(saved) : {};
        } catch (e) {
            return {};
        }
    }

    static _saveConfig() {
        try {
            localStorage.setItem('csv_debug_config', JSON.stringify({
                level: Logger.level,
                serverLogs: Logger.serverLogsEnabled,
                timestamps: Logger.showTimestamps,
                namespaces: Array.from(Logger.enabledNamespaces)
            }));
        } catch (e) {
            // Ignore storage errors
        }
    }

    static _formatTimestamp() {
        const now = new Date();
        return now.toISOString().split('T')[1].slice(0, 12);
    }

    static _log(level, namespace, message, data = null) {
        if (level < Logger.level) return;

        const levelName = Object.keys(Logger.LEVELS).find(k => Logger.LEVELS[k] === level);
        const timestamp = Logger._formatTimestamp();

        // Add to buffer
        const entry = {
            timestamp,
            level: levelName,
            namespace,
            message,
            data,
            source: 'client'
        };
        Logger.buffer.push(entry);
        if (Logger.buffer.length > Logger.BUFFER_SIZE) {
            Logger.buffer.shift();
        }

        // Console output
        const prefix = Logger.showTimestamps ? `[${timestamp}]` : '';
        const fullMessage = `${prefix}[${namespace}] ${message}`;

        switch (level) {
            case Logger.LEVELS.DEBUG:
                data ? console.debug(fullMessage, data) : console.debug(fullMessage);
                break;
            case Logger.LEVELS.INFO:
                data ? console.info(fullMessage, data) : console.info(fullMessage);
                break;
            case Logger.LEVELS.WARN:
                data ? console.warn(fullMessage, data) : console.warn(fullMessage);
                break;
            case Logger.LEVELS.ERROR:
                data ? console.error(fullMessage, data) : console.error(fullMessage);
                break;
        }

        // Update debug panel if visible
        if (Logger.debugPanelVisible) {
            Logger._appendToDebugPanel(entry);
        }
    }

    static debug(namespace, message, data = null) { Logger._log(Logger.LEVELS.DEBUG, namespace, message, data); }
    static info(namespace, message, data = null) { Logger._log(Logger.LEVELS.INFO, namespace, message, data); }
    static warn(namespace, message, data = null) { Logger._log(Logger.LEVELS.WARN, namespace, message, data); }
    static error(namespace, message, data = null) { Logger._log(Logger.LEVELS.ERROR, namespace, message, data); }

    static handleServerLog(logData) {
        if (!Logger.serverLogsEnabled) return;

        const entry = {
            timestamp: logData.timestamp?.split('T')[1]?.slice(0, 12) || Logger._formatTimestamp(),
            level: logData.level || 'INFO',
            namespace: logData.namespace || 'server',
            message: logData.message,
            data: null,
            source: 'server'
        };

        // Check namespace filter
        if (Logger.enabledNamespaces.size > 0 && !Logger.enabledNamespaces.has(entry.namespace)) {
            return;
        }

        Logger.buffer.push(entry);
        if (Logger.buffer.length > Logger.BUFFER_SIZE) {
            Logger.buffer.shift();
        }

        if (Logger.debugPanelVisible) {
            Logger._appendToDebugPanel(entry);
        }
    }

    static handleLogHistory(logs) {
        for (const log of logs) {
            Logger.handleServerLog(log);
        }
    }

    static _appendToDebugPanel(entry) {
        const container = document.getElementById('debug-log-container');
        if (!container) return;

        const line = document.createElement('div');
        line.className = `debug-log-line debug-log-${entry.level.toLowerCase()} debug-log-${entry.source}`;

        const timestamp = Logger.showTimestamps ? `<span class="debug-timestamp">${entry.timestamp}</span>` : '';
        const namespace = `<span class="debug-namespace">[${entry.namespace}]</span>`;
        const level = `<span class="debug-level">${entry.level}</span>`;

        line.innerHTML = `${timestamp}${level}${namespace} ${escapeHtml(entry.message)}`;
        container.appendChild(line);

        // Auto-scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    static setLevel(level) {
        if (typeof level === 'string') {
            Logger.level = Logger.LEVELS[level.toUpperCase()] ?? Logger.LEVELS.INFO;
        } else {
            Logger.level = level;
        }
        Logger._saveConfig();
    }

    static setServerLogs(enabled) {
        Logger.serverLogsEnabled = enabled;
        Logger._saveConfig();
    }

    static setTimestamps(show) {
        Logger.showTimestamps = show;
        Logger._saveConfig();
    }

    static setNamespaceFilter(namespaces) {
        Logger.enabledNamespaces = new Set(namespaces);
        Logger._saveConfig();
    }

    static clearBuffer() {
        Logger.buffer = [];
        const container = document.getElementById('debug-log-container');
        if (container) container.innerHTML = '';
    }

    static exportLogs() {
        const content = Logger.buffer.map(e => {
            const ts = e.timestamp || '';
            const src = e.source === 'server' ? '[S]' : '[C]';
            return `${ts} ${src} [${e.level}] [${e.namespace}] ${e.message}`;
        }).join('\n');

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `csv-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
        a.click();
        URL.revokeObjectURL(url);
    }

    static togglePanel() {
        Logger.debugPanelVisible = !Logger.debugPanelVisible;
        const panel = document.getElementById('debug-panel');
        if (panel) {
            panel.classList.toggle('hidden', !Logger.debugPanelVisible);
            if (Logger.debugPanelVisible) {
                Logger._refreshDebugPanel();
            }
        }
    }

    static _refreshDebugPanel() {
        const container = document.getElementById('debug-log-container');
        if (!container) return;
        container.innerHTML = '';
        for (const entry of Logger.buffer) {
            Logger._appendToDebugPanel(entry);
        }
    }

    // Namespace-specific loggers
    static ws = {
        debug: (msg, data) => Logger._log(Logger.LEVELS.DEBUG, 'ws', msg, data),
        info: (msg, data) => Logger._log(Logger.LEVELS.INFO, 'ws', msg, data),
        warn: (msg, data) => Logger._log(Logger.LEVELS.WARN, 'ws', msg, data),
        error: (msg, data) => Logger._log(Logger.LEVELS.ERROR, 'ws', msg, data),
    };

    static mc = {
        debug: (msg, data) => Logger._log(Logger.LEVELS.DEBUG, 'mc', msg, data),
        info: (msg, data) => Logger._log(Logger.LEVELS.INFO, 'mc', msg, data),
        warn: (msg, data) => Logger._log(Logger.LEVELS.WARN, 'mc', msg, data),
        error: (msg, data) => Logger._log(Logger.LEVELS.ERROR, 'mc', msg, data),
    };

    static sessions = {
        debug: (msg, data) => Logger._log(Logger.LEVELS.DEBUG, 'sessions', msg, data),
        info: (msg, data) => Logger._log(Logger.LEVELS.INFO, 'sessions', msg, data),
        warn: (msg, data) => Logger._log(Logger.LEVELS.WARN, 'sessions', msg, data),
        error: (msg, data) => Logger._log(Logger.LEVELS.ERROR, 'sessions', msg, data),
    };

    static timeline = {
        debug: (msg, data) => Logger._log(Logger.LEVELS.DEBUG, 'timeline', msg, data),
        info: (msg, data) => Logger._log(Logger.LEVELS.INFO, 'timeline', msg, data),
        warn: (msg, data) => Logger._log(Logger.LEVELS.WARN, 'timeline', msg, data),
        error: (msg, data) => Logger._log(Logger.LEVELS.ERROR, 'timeline', msg, data),
    };

    static analytics = {
        debug: (msg, data) => Logger._log(Logger.LEVELS.DEBUG, 'analytics', msg, data),
        info: (msg, data) => Logger._log(Logger.LEVELS.INFO, 'analytics', msg, data),
        warn: (msg, data) => Logger._log(Logger.LEVELS.WARN, 'analytics', msg, data),
        error: (msg, data) => Logger._log(Logger.LEVELS.ERROR, 'analytics', msg, data),
    };

    static app = {
        debug: (msg, data) => Logger._log(Logger.LEVELS.DEBUG, 'app', msg, data),
        info: (msg, data) => Logger._log(Logger.LEVELS.INFO, 'app', msg, data),
        warn: (msg, data) => Logger._log(Logger.LEVELS.WARN, 'app', msg, data),
        error: (msg, data) => Logger._log(Logger.LEVELS.ERROR, 'app', msg, data),
    };
}

// Initialize Logger on load
Logger.init();

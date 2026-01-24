/**
 * Main entry point for the Claude Session Visualizer.
 *
 * This module:
 * - Initializes the application
 * - Sets up event listeners
 * - Starts the polling/WebSocket connection
 * - Coordinates between modules
 *
 * Usage:
 * Include in index.html as: <script type="module" src="js/main.js"></script>
 */

import { state, setState, toggleCardMode, toggleGroupByProject } from './state.js';
import { fetchSessions, checkSessionsChanged, connectWebSocket, disconnectWebSocket } from './api.js';
import { escapeHtml, formatTime, formatTokens, formatCost, formatDuration, getActivityStatus, showToast, debounce } from './utils.js';
import { createCard, createCompactCard, formatTokenBar, renderEmojiTrail } from './sessions.js';

// Constants
const DIRTY_CHECK_INTERVAL = 500;
const FULL_POLL_FALLBACK = 30000;

// Module state
let dirtyCheckTimeoutId = null;
let pollTimeoutId = null;
let wsConnected = false;

/**
 * Initialize the application.
 */
export async function init() {
    console.log('[Main] Initializing Claude Session Visualizer...');

    // Set up view switching
    setupViewSwitching();

    // Set up keyboard shortcuts
    setupKeyboardShortcuts();

    // Set up search/filter
    setupFilters();

    // Connect WebSocket for real-time updates
    setupWebSocket();

    // Start dirty-check polling
    startDirtyCheckPolling();

    // Initial fetch
    await fetchAndRenderSessions();

    console.log('[Main] Initialization complete');
}

/**
 * Fetch sessions and render them.
 */
async function fetchAndRenderSessions() {
    try {
        const data = await fetchSessions(true);
        const sessions = data.sessions || [];

        // Update state
        state.allVisibleSessions = sessions;
        sessions.forEach(s => state.previousSessions.set(s.sessionId, s));

        // Render
        renderSessions(sessions);

        // Update activity timestamp
        if (data.timestamp) {
            state.lastActivityTimestamp = data.timestamp;
        }
    } catch (error) {
        console.error('[Main] Failed to fetch sessions:', error);
    }
}

/**
 * Render sessions to the DOM.
 * @param {Array} sessions - Sessions to render
 */
function renderSessions(sessions) {
    const container = document.getElementById('sessions-container');
    if (!container) return;

    // Clear container
    container.innerHTML = '';

    // Filter sessions
    const filtered = filterSessions(sessions);

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No sessions found</div>';
        return;
    }

    // Group by project if enabled
    if (state.groupByProject) {
        renderGroupedSessions(container, filtered);
    } else {
        renderFlatSessions(container, filtered);
    }

    state.initialRenderComplete = true;
}

/**
 * Filter sessions based on current filter state.
 * @param {Array} sessions - All sessions
 * @returns {Array} Filtered sessions
 */
function filterSessions(sessions) {
    return sessions.filter(session => {
        // Status filter
        if (state.filters.status !== 'all' && session.state !== state.filters.status) {
            return false;
        }

        // Search filter
        if (state.filters.search) {
            const query = state.filters.search.toLowerCase();
            const searchable = [
                session.slug,
                session.cwd,
                session.summary || '',
                session.gitBranch || ''
            ].join(' ').toLowerCase();

            if (!searchable.includes(query)) {
                return false;
            }
        }

        return true;
    });
}

/**
 * Render sessions in a flat list.
 * @param {HTMLElement} container - Container element
 * @param {Array} sessions - Sessions to render
 */
function renderFlatSessions(container, sessions) {
    sessions.forEach((session, index) => {
        const card = state.cardDisplayMode === 'compact'
            ? createCompactCard(session, index)
            : createCard(session, index);
        container.appendChild(card);
    });
}

/**
 * Render sessions grouped by project.
 * @param {HTMLElement} container - Container element
 * @param {Array} sessions - Sessions to render
 */
function renderGroupedSessions(container, sessions) {
    // Group by cwd
    const groups = new Map();
    sessions.forEach(session => {
        const key = session.cwd || 'Unknown';
        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key).push(session);
    });

    // Render each group
    let globalIndex = 0;
    groups.forEach((groupSessions, cwd) => {
        const group = document.createElement('div');
        group.className = 'session-group';

        const projectName = cwd.split('/').pop() || cwd;
        const activeCount = groupSessions.filter(s => s.state === 'active').length;

        group.innerHTML = `
            <div class="group-header">
                <span class="group-name">${escapeHtml(projectName)}</span>
                <span class="group-count">${groupSessions.length} sessions${activeCount > 0 ? ` (${activeCount} active)` : ''}</span>
            </div>
            <div class="group-sessions"></div>
        `;

        const sessionsContainer = group.querySelector('.group-sessions');
        groupSessions.forEach((session) => {
            const card = state.cardDisplayMode === 'compact'
                ? createCompactCard(session, globalIndex)
                : createCard(session, globalIndex);
            sessionsContainer.appendChild(card);
            globalIndex++;
        });

        container.appendChild(group);
    });
}

/**
 * Set up view switching between Sessions, Timeline, Analytics, etc.
 */
function setupViewSwitching() {
    document.querySelectorAll('.view-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const view = tab.dataset.view;
            switchView(view);
        });
    });
}

/**
 * Switch to a different view.
 * @param {string} view - View name
 */
function switchView(view) {
    // Update tab active state
    document.querySelectorAll('.view-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === view);
    });

    // Hide all views
    document.querySelectorAll('.view-content').forEach(v => {
        v.classList.add('hidden');
    });

    // Show selected view
    const viewElement = document.getElementById(`${view}-view`);
    if (viewElement) {
        viewElement.classList.remove('hidden');
    }

    state.currentView = view;
}

/**
 * Set up keyboard shortcuts.
 */
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ignore if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        switch (e.key) {
            case 'r':
                if (!e.ctrlKey && !e.metaKey) {
                    fetchAndRenderSessions();
                    showToast('Refreshed');
                }
                break;
            case 'c':
                if (!e.ctrlKey && !e.metaKey) {
                    toggleCardMode();
                }
                break;
            case 'g':
                if (!e.ctrlKey && !e.metaKey) {
                    toggleGroupByProject();
                    renderSessions(state.allVisibleSessions);
                }
                break;
            case '/':
                e.preventDefault();
                document.getElementById('search-input')?.focus();
                break;
            case 'Escape':
                document.getElementById('search-input')?.blur();
                break;
        }
    });
}

/**
 * Set up search and filter controls.
 */
function setupFilters() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.addEventListener('input', debounce((e) => {
            state.filters.search = e.target.value;
            renderSessions(state.allVisibleSessions);
        }, 200));
    }

    const statusFilter = document.getElementById('status-filter');
    if (statusFilter) {
        statusFilter.addEventListener('change', (e) => {
            state.filters.status = e.target.value;
            renderSessions(state.allVisibleSessions);
        });
    }
}

/**
 * Set up WebSocket connection.
 */
function setupWebSocket() {
    connectWebSocket(
        // onMessage
        (data) => {
            if (data.type === 'sessions_update') {
                const sessions = data.sessions || [];
                state.allVisibleSessions = sessions;
                sessions.forEach(s => state.previousSessions.set(s.sessionId, s));
                renderSessions(sessions);
            }
        },
        // onConnect
        () => {
            wsConnected = true;
            console.log('[Main] WebSocket connected');
        },
        // onDisconnect
        () => {
            wsConnected = false;
            console.log('[Main] WebSocket disconnected');
        }
    );
}

/**
 * Start dirty-check polling for efficient updates.
 */
function startDirtyCheckPolling() {
    const poll = async () => {
        try {
            const result = await checkSessionsChanged(state.lastActivityTimestamp);
            if (result.changed) {
                await fetchAndRenderSessions();
            }
        } catch (error) {
            console.error('[Main] Dirty check failed:', error);
        }

        // Schedule next poll
        dirtyCheckTimeoutId = setTimeout(poll, DIRTY_CHECK_INTERVAL);
    };

    poll();
}

/**
 * Stop polling and cleanup.
 */
export function cleanup() {
    if (dirtyCheckTimeoutId) {
        clearTimeout(dirtyCheckTimeoutId);
    }
    if (pollTimeoutId) {
        clearTimeout(pollTimeoutId);
    }
    disconnectWebSocket();
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for external use
export {
    fetchAndRenderSessions,
    renderSessions,
    switchView
};

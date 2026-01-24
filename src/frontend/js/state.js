/**
 * Centralized state management for the Claude Session Visualizer.
 *
 * This module manages all application state including:
 * - Session data and caching
 * - UI state (selections, filters, view modes)
 * - WebSocket connection state
 */

// Session state
export const state = {
    // Session data
    previousSessions: new Map(),
    allVisibleSessions: [],
    renderedSessionIds: new Set(),
    initialRenderComplete: false,

    // UI state
    selectedIndex: -1,
    cardDisplayMode: localStorage.getItem('cardDisplayMode') || 'detailed',
    groupByProject: localStorage.getItem('groupByProject') !== 'false',

    // Filter state
    filters: {
        search: '',
        status: 'all'
    },

    // View state
    currentView: 'sessions',
    timelineViewActive: false,
    graveyardViewActive: false,
    missionControlActive: false,

    // Notification state
    notificationsEnabled: localStorage.getItem('notificationsEnabled') === 'true',
    audioEnabled: false,

    // Polling state
    lastActivityTimestamp: 0,
    dirtyCheckEnabled: true,

    // WebSocket state
    wsConnected: false,
    wsReconnectAttempts: 0,
};

// Constants
export const MAX_CONTEXT_TOKENS = 200000;
export const DIRTY_CHECK_INTERVAL = 500;
export const FULL_REFRESH_INTERVAL = 30000;

/**
 * Update a state property and optionally trigger callbacks.
 * @param {string} key - State property name
 * @param {*} value - New value
 */
export function setState(key, value) {
    if (key in state) {
        state[key] = value;
    }
}

/**
 * Get current state value.
 * @param {string} key - State property name
 * @returns {*} State value
 */
export function getState(key) {
    return state[key];
}

/**
 * Reset filters to defaults.
 */
export function resetFilters() {
    state.filters.search = '';
    state.filters.status = 'all';
}

/**
 * Toggle card display mode between compact and detailed.
 * @returns {string} New display mode
 */
export function toggleCardMode() {
    state.cardDisplayMode = state.cardDisplayMode === 'compact' ? 'detailed' : 'compact';
    localStorage.setItem('cardDisplayMode', state.cardDisplayMode);
    return state.cardDisplayMode;
}

/**
 * Toggle project grouping.
 * @returns {boolean} New grouping state
 */
export function toggleGroupByProject() {
    state.groupByProject = !state.groupByProject;
    localStorage.setItem('groupByProject', state.groupByProject);
    return state.groupByProject;
}

/**
 * Clear selection.
 */
export function clearSelection() {
    state.selectedIndex = -1;
}

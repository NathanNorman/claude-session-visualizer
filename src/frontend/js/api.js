/**
 * API client and WebSocket handling for the Claude Session Visualizer.
 *
 * This module provides:
 * - REST API calls to the backend
 * - WebSocket connection management
 * - Dirty-check polling for efficient updates
 */

// API base URL (relative to current host)
const API_BASE = '/api';

/**
 * Fetch sessions from the API.
 * @param {boolean} includeSummaries - Include AI summaries
 * @returns {Promise<Object>} Sessions response
 */
export async function fetchSessions(includeSummaries = false) {
    const url = includeSummaries
        ? `${API_BASE}/sessions?include_summaries=true`
        : `${API_BASE}/sessions`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.status}`);
    }
    return response.json();
}

/**
 * Check if sessions have changed since last poll.
 * @param {number} since - Last known activity timestamp
 * @returns {Promise<Object>} {changed: boolean, timestamp: number}
 */
export async function checkSessionsChanged(since = 0) {
    const response = await fetch(`${API_BASE}/sessions/changed?since=${since}`);
    if (!response.ok) {
        throw new Error(`Dirty check failed: ${response.status}`);
    }
    return response.json();
}

/**
 * Get all sessions including remote machines.
 * @param {boolean} includeSummaries - Include AI summaries
 * @returns {Promise<Object>} Multi-machine sessions response
 */
export async function fetchAllSessions(includeSummaries = false) {
    const url = includeSummaries
        ? `${API_BASE}/sessions/all?include_summaries=true`
        : `${API_BASE}/sessions/all`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch all sessions: ${response.status}`);
    }
    return response.json();
}

/**
 * Get dead sessions for graveyard view.
 * @param {number} hours - Hours to look back
 * @returns {Promise<Object>} Dead sessions response
 */
export async function fetchGraveyardSessions(hours = 24) {
    const response = await fetch(`${API_BASE}/sessions/graveyard?hours=${hours}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch graveyard: ${response.status}`);
    }
    return response.json();
}

/**
 * Search dead sessions.
 * @param {string} query - Search query
 * @param {number} hours - Hours to look back
 * @param {boolean} searchContent - Search conversation content
 * @returns {Promise<Object>} Search results
 */
export async function searchGraveyardSessions(query, hours = 168, searchContent = false) {
    const params = new URLSearchParams({
        q: query,
        hours: hours.toString(),
        content: searchContent.toString()
    });
    const response = await fetch(`${API_BASE}/sessions/graveyard/search?${params}`);
    if (!response.ok) {
        throw new Error(`Search failed: ${response.status}`);
    }
    return response.json();
}

/**
 * Get session timeline.
 * @param {string} sessionId - Session UUID
 * @param {number} bucketMinutes - Activity bucket size
 * @returns {Promise<Object>} Timeline data
 */
export async function fetchSessionTimeline(sessionId, bucketMinutes = 5) {
    const response = await fetch(
        `${API_BASE}/session/${sessionId}/timeline?bucket_minutes=${bucketMinutes}`
    );
    if (!response.ok) {
        throw new Error(`Failed to fetch timeline: ${response.status}`);
    }
    return response.json();
}

/**
 * Get session conversation.
 * @param {string} sessionId - Session UUID
 * @param {number} limit - Max messages (0 for all)
 * @returns {Promise<Object>} Conversation data
 */
export async function fetchConversation(sessionId, limit = 0) {
    const response = await fetch(
        `${API_BASE}/session/${sessionId}/conversation?limit=${limit}`
    );
    if (!response.ok) {
        throw new Error(`Failed to fetch conversation: ${response.status}`);
    }
    return response.json();
}

/**
 * Get session metrics.
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>} Metrics data
 */
export async function fetchMetrics(sessionId) {
    const response = await fetch(`${API_BASE}/session/${sessionId}/metrics`);
    if (!response.ok) {
        throw new Error(`Failed to fetch metrics: ${response.status}`);
    }
    return response.json();
}

/**
 * Get session git info.
 * @param {string} sessionId - Session UUID
 * @returns {Promise<Object>} Git status data
 */
export async function fetchGitInfo(sessionId) {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}/git`);
    if (!response.ok) {
        throw new Error(`Failed to fetch git info: ${response.status}`);
    }
    return response.json();
}

/**
 * Focus iTerm tab by TTY.
 * @param {string} tty - TTY identifier
 * @returns {Promise<Object>} Focus result
 */
export async function focusByTty(tty) {
    const response = await fetch(`${API_BASE}/focus-tty`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tty })
    });
    if (!response.ok) {
        throw new Error(`Failed to focus tab: ${response.status}`);
    }
    return response.json();
}

/**
 * Kill a session by PID.
 * @param {number} pid - Process ID
 * @returns {Promise<Object>} Kill result
 */
export async function killSession(pid) {
    const response = await fetch(`${API_BASE}/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid })
    });
    if (!response.ok) {
        throw new Error(`Failed to kill session: ${response.status}`);
    }
    return response.json();
}

/**
 * Get analytics data.
 * @param {string} period - One of: day, week, month, year
 * @returns {Promise<Object>} Analytics data
 */
export async function fetchAnalytics(period = 'week') {
    const response = await fetch(`${API_BASE}/analytics?period=${period}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch analytics: ${response.status}`);
    }
    return response.json();
}

/**
 * Get session history.
 * @param {number} page - Page number
 * @param {number} perPage - Items per page
 * @param {string} repo - Optional repo filter
 * @returns {Promise<Object>} History data
 */
export async function fetchHistory(page = 1, perPage = 20, repo = null) {
    const params = new URLSearchParams({
        page: page.toString(),
        per_page: perPage.toString()
    });
    if (repo) {
        params.append('repo', repo);
    }
    const response = await fetch(`${API_BASE}/history?${params}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch history: ${response.status}`);
    }
    return response.json();
}

// WebSocket management
let ws = null;
let wsReconnectTimeout = null;

/**
 * Connect to WebSocket for real-time updates.
 * @param {function} onMessage - Message handler callback
 * @param {function} onConnect - Connection handler callback
 * @param {function} onDisconnect - Disconnection handler callback
 * @returns {WebSocket} WebSocket instance
 */
export function connectWebSocket(onMessage, onConnect, onDisconnect) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/sessions`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('[WS] Connected');
        if (onConnect) onConnect();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (onMessage) onMessage(data);
        } catch (e) {
            console.error('[WS] Failed to parse message:', e);
        }
    };

    ws.onclose = () => {
        console.log('[WS] Disconnected');
        if (onDisconnect) onDisconnect();

        // Auto-reconnect after 3 seconds
        wsReconnectTimeout = setTimeout(() => {
            connectWebSocket(onMessage, onConnect, onDisconnect);
        }, 3000);
    };

    ws.onerror = (error) => {
        console.error('[WS] Error:', error);
    };

    return ws;
}

/**
 * Send a message via WebSocket.
 * @param {Object} message - Message to send
 */
export function sendWsMessage(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

/**
 * Request a session refresh via WebSocket.
 */
export function requestWsRefresh() {
    sendWsMessage({ type: 'refresh' });
}

/**
 * Disconnect WebSocket and cleanup.
 */
export function disconnectWebSocket() {
    if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout);
    }
    if (ws) {
        ws.close();
        ws = null;
    }
}

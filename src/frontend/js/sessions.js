/**
 * Session card rendering for the Claude Session Visualizer.
 *
 * This module provides:
 * - Session card creation (detailed and compact views)
 * - Token bar rendering
 * - Activity status display
 * - Agent tree rendering
 * - Background shell display
 */

import { escapeHtml, formatDuration, getActivityStatus, getGastownAgentType, formatTokens } from './utils.js';
import { state, MAX_CONTEXT_TOKENS } from './state.js';
import { focusByTty } from './api.js';

// Polecat avatar images for Gastown agents
const POLECAT_IMAGES = [
    'assets/polecats/polecat-rider.png',
    'assets/polecats/polecat-scout.png',
    'assets/polecats/polecat-pyro.png',
    'assets/polecats/polecat-bandit.png',
    'assets/polecats/polecat-sniper.png',
    'assets/polecats/polecat-mechanic.png'
];

/**
 * Get consistent polecat image based on session/slug hash.
 * @param {string} identifier - Session ID or slug
 * @returns {string} Path to polecat image
 */
export function getPolecatImage(identifier) {
    const hash = (identifier || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return POLECAT_IMAGES[hash % POLECAT_IMAGES.length];
}

/**
 * Format token bar with percentage indicator.
 * @param {number} tokens - Current token count
 * @returns {string} HTML for token bar
 */
export function formatTokenBar(tokens) {
    const percentage = tokens ? Math.min(100, (tokens / MAX_CONTEXT_TOKENS) * 100) : 0;
    const tokenClass = percentage > 80 ? 'critical' : percentage > 50 ? 'warning' : 'ok';

    return `
        <div class="token-bar-container" title="${formatTokens(tokens)} tokens (${percentage.toFixed(1)}%)">
            <div class="token-bar ${tokenClass}" style="width: ${percentage}%"></div>
            <span class="token-label">${formatTokens(tokens)}</span>
        </div>
    `;
}

/**
 * Get emoji for a tool or event type.
 * @param {string} activity - Activity description
 * @returns {string} Emoji representing the activity
 */
export function getActivityEmoji(activity) {
    if (!activity) return '💭';

    const lower = activity.toLowerCase();

    // File operations
    if (lower.includes('read')) return '📖';
    if (lower.includes('writ')) return '✍️';
    if (lower.includes('edit')) return '✏️';

    // Search operations
    if (lower.includes('grep') || lower.includes('search')) return '🔍';
    if (lower.includes('glob') || lower.includes('find')) return '📁';

    // Execution
    if (lower.includes('bash') || lower.includes('run')) return '⚙️';
    if (lower.includes('test')) return '🧪';

    // Planning
    if (lower.includes('todo') || lower.includes('task')) return '📋';
    if (lower.includes('plan')) return '🗺️';

    // Communication
    if (lower.includes('ask')) return '❓';
    if (lower.includes('user')) return '👤';

    // Agent operations
    if (lower.includes('spawn') || lower.includes('agent')) return '🤖';
    if (lower.includes('skill')) return '🎯';

    // Web
    if (lower.includes('fetch') || lower.includes('web')) return '🌐';

    // MCP
    if (lower.includes('mcp')) return '🔌';

    return '💭';
}

/**
 * Render emoji trail from activity log.
 * @param {Array} activityLog - Array of activity entries
 * @param {boolean} isActive - Whether session is active
 * @returns {string} HTML for emoji trail
 */
export function renderEmojiTrail(activityLog, isActive = false) {
    if (!activityLog || activityLog.length === 0) {
        return '';
    }

    // Get last 10 unique activities
    const emojis = [];
    const seen = new Set();

    for (let i = activityLog.length - 1; i >= 0 && emojis.length < 10; i--) {
        const entry = activityLog[i];
        const activity = entry.activity || entry.tool || '';
        const emoji = getActivityEmoji(activity);

        // Dedupe consecutive same emojis
        if (!seen.has(emoji) || emojis.length === 0 || emojis[emojis.length - 1] !== emoji) {
            emojis.unshift(emoji);
            seen.add(emoji);
        }
    }

    const emojiHtml = emojis.map((emoji, i) => {
        const entry = activityLog[activityLog.length - emojis.length + i];
        const title = entry ? (entry.activity || entry.tool || '') : '';
        return `<span class="trail-emoji" title="${escapeHtml(title)}">${emoji}</span>`;
    }).join('');

    return `
        <div class="emoji-trail ${isActive ? 'active' : ''}">
            ${emojiHtml}
        </div>
    `;
}

/**
 * Render agent tree (spawned agents).
 * @param {Array} agents - Array of spawned agent objects
 * @returns {string} HTML for agent tree
 */
export function renderAgentTree(agents) {
    if (!agents || agents.length === 0) {
        return '';
    }

    const agentItems = agents.map(agent => {
        const status = agent.status || 'running';
        const statusIcon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🔄';
        const agentType = agent.subagent_type || agent.type || 'agent';

        return `
            <div class="agent-item ${status}">
                <span class="agent-icon">${statusIcon}</span>
                <span class="agent-type">${escapeHtml(agentType)}</span>
                <span class="agent-desc">${escapeHtml(agent.description || '')}</span>
            </div>
        `;
    }).join('');

    return `
        <div class="agent-tree">
            <div class="agent-tree-header" onclick="toggleAgentTree(this)">
                🤖 Spawned Agents (${agents.length})
            </div>
            <div class="agent-tree-items">${agentItems}</div>
        </div>
    `;
}

/**
 * Format shell duration in human readable format.
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration
 */
function formatShellDuration(seconds) {
    if (!seconds || seconds < 0) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const remainingMins = mins % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
}

/**
 * Render background shells.
 * @param {Array} shells - Array of background shell objects
 * @returns {string} HTML for background shells
 */
export function renderBackgroundShells(shells) {
    if (!shells || shells.length === 0) {
        return '';
    }

    const shellItems = shells.map(shell => {
        const status = shell.computed_status || shell.status || 'unknown';
        const statusIcon = status === 'running' ? '⏳' : status === 'completed' ? '✅' : '❓';
        const cmd = shell.command || '';
        const duration = formatShellDuration(shell.duration_seconds);

        return `
            <div class="shell-item ${status}">
                <span class="shell-icon">${statusIcon}</span>
                <span class="shell-cmd">${escapeHtml(cmd.substring(0, 40))}${cmd.length > 40 ? '...' : ''}</span>
                <span class="shell-duration">${duration}</span>
            </div>
        `;
    }).join('');

    return `
        <div class="background-shells">
            <div class="shells-header">
                ⚙️ Background Shells (${shells.length})
            </div>
            <div class="shells-items">${shellItems}</div>
        </div>
    `;
}

/**
 * Render activity summary log.
 * @param {Array} entries - Activity summary entries
 * @returns {string} HTML for activity summary log
 */
export function renderActivitySummaryLog(entries) {
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
    }).join('');

    return `<div class="activity-summary-log">${items}</div>`;
}

/**
 * Format timestamp to relative time.
 * @param {string} isoTimestamp - ISO timestamp
 * @returns {string} Relative time string
 */
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

/**
 * Format agent duration from start timestamp.
 * @param {string} startTimestamp - ISO timestamp
 * @returns {string} Duration string
 */
export function formatAgentDuration(startTimestamp) {
    return formatDuration(startTimestamp);
}

/**
 * Create a detailed session card.
 * @param {Object} session - Session data
 * @param {number} index - Card index for numbering
 * @returns {HTMLElement} Card element
 */
export function createCard(session, index = 0) {
    const card = document.createElement('div');
    card.className = `session-card ${session.state}`;
    card.dataset.sessionId = session.sessionId;

    const summaryHtml = session.summary
        ? `<div class="summary">${escapeHtml(session.summary)}</div>`
        : '';

    // Activity status
    const activityStatus = getActivityStatus(session.lastActivity);
    let stateEmoji = '🟢';
    if (session.state !== 'active') {
        stateEmoji = activityStatus.isStale ? '🟠' : '🟡';
    }

    // Activity badge
    let activityBadgeHtml = '';
    if (session.state === 'active') {
        activityBadgeHtml = '<span class="active-indicator">just now</span>';
    } else if (activityStatus.text) {
        activityBadgeHtml = `<span class="${activityStatus.class}">${activityStatus.text}</span>`;
    } else {
        activityBadgeHtml = '<span class="idle-indicator">idle</span>';
    }

    const duration = formatAgentDuration(session.startTimestamp) || '0m';

    // Git status
    const gitHtml = session.git ? `
        <div class="git-status" onclick="event.stopPropagation(); showGitDetails('${session.sessionId}')">
            <span class="git-branch">🌿 ${escapeHtml(session.git.branch)}</span>
            ${session.git.uncommitted ? `
                <span class="git-uncommitted">⚠️ ${session.git.modified_count} uncommitted</span>
            ` : '<span class="git-clean">✓ clean</span>'}
            ${session.git.ahead > 0 ? `<span class="git-ahead">↑${session.git.ahead}</span>` : ''}
        </div>
    ` : '';

    // Activity components
    const activitySummaryLogHtml = renderActivitySummaryLog(session.activitySummaries);
    const agentTreeHtml = renderAgentTree(session.spawnedAgents);
    const backgroundShellsHtml = renderBackgroundShells(session.backgroundShells);
    const activityTrailHtml = renderEmojiTrail(session.activityLog, session.state === 'active');

    // Gastown avatar
    const agentType = session.isGastown ? getGastownAgentType(session.gastownRole || session.slug) : null;
    const polecatAvatarHtml = (agentType?.type === 'polecat')
        ? `<img class="polecat-avatar" src="${getPolecatImage(session.slug)}" alt="Polecat" />`
        : '';

    // State source indicator
    const stateIcon = session.stateSource === 'hooks' ? '<span class="state-source-indicator" title="Real-time hooks detection">⚡</span>' : '';

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

    // Make card clickable
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => {
        if (session.tty) {
            focusByTty(session.tty).catch(err => console.error('Focus failed:', err));
        }
    });

    return card;
}

/**
 * Create a compact session card.
 * @param {Object} session - Session data
 * @param {number} index - Card index for numbering
 * @returns {HTMLElement} Card element
 */
export function createCompactCard(session, index = 0) {
    const card = document.createElement('div');
    card.className = `session-card compact ${session.state}`;
    card.dataset.sessionId = session.sessionId;

    const tokenPct = session.contextTokens
        ? Math.min(100, (session.contextTokens / MAX_CONTEXT_TOKENS) * 100)
        : 0;

    const duration = formatAgentDuration(session.startTimestamp) || '0m';

    const activityStatus = getActivityStatus(session.lastActivity);
    let activityHtml = '';
    if (session.state === 'active') {
        activityHtml = '<span class="active-indicator">just now</span>';
    } else if (activityStatus.text) {
        activityHtml = `<span class="${activityStatus.class}">${activityStatus.text}</span>`;
    } else {
        activityHtml = '<span class="idle-indicator">idle</span>';
    }

    let stateEmoji = '🟢';
    if (session.state !== 'active') {
        stateEmoji = activityStatus.isStale ? '🟠' : '🟡';
    }

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
    card.addEventListener('click', () => {
        if (session.tty) {
            focusByTty(session.tty).catch(err => console.error('Focus failed:', err));
        }
    });

    return card;
}

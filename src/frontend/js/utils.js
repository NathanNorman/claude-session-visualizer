/**
 * Utility functions for the Claude Session Visualizer.
 *
 * This module provides:
 * - Time formatting helpers
 * - Token formatting helpers
 * - HTML escaping
 * - Activity status helpers
 */

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format a timestamp as relative time (e.g., "5m ago").
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted relative time
 */
export function formatTime(isoString) {
    if (!isoString) return '--';
    try {
        const diffSec = Math.floor((new Date() - new Date(isoString)) / 1000);
        if (diffSec < 0) return 'just now';
        if (diffSec < 60) return `${diffSec}s ago`;
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        return `${Math.floor(diffSec / 3600)}h ago`;
    } catch {
        return '--';
    }
}

/**
 * Format token count with K/M suffixes.
 * @param {number} tokens - Token count
 * @returns {string} Formatted token string
 */
export function formatTokens(tokens) {
    if (!tokens || tokens === 0) return '--';
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return `${tokens}`;
}

/**
 * Format cost in dollars.
 * @param {number} cost - Cost in dollars
 * @returns {string} Formatted cost string
 */
export function formatCost(cost) {
    if (!cost || cost === 0) return '$0.00';
    if (cost < 0.01) return '<$0.01';
    return `$${cost.toFixed(2)}`;
}

/**
 * Format duration in human-readable form.
 * @param {string} startTimestamp - ISO 8601 start timestamp
 * @returns {string} Duration string (e.g., "2h 15m")
 */
export function formatDuration(startTimestamp) {
    if (!startTimestamp) return '0m';
    try {
        const start = new Date(startTimestamp);
        const now = new Date();
        const diffMs = now - start;
        const diffMin = Math.floor(diffMs / 60000);

        if (diffMin < 60) return `${diffMin}m`;
        const hours = Math.floor(diffMin / 60);
        const mins = diffMin % 60;
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    } catch {
        return '0m';
    }
}

/**
 * Get activity status object from lastActivity timestamp.
 * @param {string} lastActivity - ISO 8601 timestamp
 * @returns {Object} {text, class, isActive, isStale}
 */
export function getActivityStatus(lastActivity) {
    if (!lastActivity) {
        return { text: '', class: '', isActive: false, isStale: false };
    }

    try {
        const diffSec = Math.floor((new Date() - new Date(lastActivity)) / 1000);

        if (diffSec < 30) {
            return { text: 'just now', class: 'active-indicator', isActive: true, isStale: false };
        }
        if (diffSec < 60) {
            return { text: `${diffSec}s`, class: 'idle-indicator', isActive: false, isStale: false };
        }
        if (diffSec < 3600) {
            const mins = Math.floor(diffSec / 60);
            const isStale = mins >= 10;
            return {
                text: `${mins}m`,
                class: isStale ? 'stale-indicator' : 'idle-indicator',
                isActive: false,
                isStale
            };
        }

        const hours = Math.floor(diffSec / 3600);
        return { text: `${hours}h`, class: 'stale-indicator', isActive: false, isStale: true };
    } catch {
        return { text: '', class: '', isActive: false, isStale: false };
    }
}

/**
 * Show a toast notification.
 * @param {string} message - Message to display
 * @param {number} duration - Duration in ms (default 2000)
 */
export function showToast(message, duration = 2000) {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // Auto-remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * Copy text to clipboard.
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Success status
 */
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        return success;
    }
}

/**
 * Debounce a function.
 * @param {function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {function} Debounced function
 */
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

/**
 * Throttle a function.
 * @param {function} func - Function to throttle
 * @param {number} limit - Time limit in ms
 * @returns {function} Throttled function
 */
export function throttle(func, limit) {
    let inThrottle;
    return function executedFunction(...args) {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => { inThrottle = false; }, limit);
        }
    };
}

/**
 * Get Gastown agent type info from role/slug.
 * @param {string} roleOrSlug - Role name or slug
 * @returns {Object} {icon, label, css}
 */
export function getGastownAgentType(roleOrSlug) {
    const role = (roleOrSlug || '').toLowerCase();

    if (role.includes('coord') || role.includes('queen')) {
        return { icon: '👑', label: 'Coordinator', css: 'gt-coord' };
    }
    if (role.includes('code') || role.includes('impl')) {
        return { icon: '💻', label: 'Coder', css: 'gt-coder' };
    }
    if (role.includes('test') || role.includes('qa')) {
        return { icon: '🧪', label: 'Tester', css: 'gt-tester' };
    }
    if (role.includes('review')) {
        return { icon: '👁️', label: 'Reviewer', css: 'gt-reviewer' };
    }
    if (role.includes('doc')) {
        return { icon: '📝', label: 'Documenter', css: 'gt-doc' };
    }
    if (role.includes('research') || role.includes('explore')) {
        return { icon: '🔍', label: 'Researcher', css: 'gt-research' };
    }

    return { icon: '🤖', label: 'Agent', css: 'gt-agent' };
}

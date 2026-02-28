// ============================================================================
// Feature 05: Session Timeline Implementation
// ============================================================================

let timelineHours = parseInt(localStorage.getItem('timelineHours') || '8', 10); // Show last 8 hours (configurable)
let timelineData = new Map(); // sessionId -> { periods, eventMarkers }
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
        return {
            periods: data.activityPeriods || [],
            eventMarkers: data.eventMarkers || []
        };
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
            const timelineResult = await fetchSessionTimeline(session.sessionId);
            return { session, timelineResult };
        });

        const results = await Promise.all(timelinePromises);

        // Calculate visible time window
        const now = Date.now();
        const windowStart = now - (timelineHours * 60 * 60 * 1000);

        // Store timeline data and filter to sessions with activity IN THE VISIBLE WINDOW
        const sessionsWithActivity = [];
        results.forEach(({ session, timelineResult }) => {
            if (!timelineResult || !timelineResult.periods || timelineResult.periods.length === 0) return;

            const periods = timelineResult.periods;

            // Check if any period overlaps with the visible time window
            const hasVisibleActivity = periods.some(period => {
                const periodStart = new Date(period.start).getTime();
                const periodEnd = new Date(period.end).getTime();
                // Period overlaps if it ends after window start AND starts before now
                return periodEnd >= windowStart && periodStart <= now;
            });

            if (hasVisibleActivity) {
                timelineData.set(session.sessionId, {
                    periods: periods,
                    eventMarkers: timelineResult.eventMarkers || []
                });
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

    for (const session of sessions) {
        const cwd = session.cwd || 'Unknown';
        const repoName = cwd.split('/').filter(Boolean).pop() || 'Unknown';
        if (!sessionsByRepo.has(repoName)) {
            sessionsByRepo.set(repoName, { cwd, sessions: [] });
        }
        sessionsByRepo.get(repoName).sessions.push(session);
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
            const sessionData = timelineData.get(session.sessionId) || { periods: [], eventMarkers: [] };
            return renderTimelineRow(session, sessionData.periods, sessionData.eventMarkers, startTime, now);
        }).join('');

        return `
            <div class="timeline-section">
                <div class="timeline-section-header" title="${escapeHtml(cwd)}">
                    ${icon('folder', {size:14})} ${escapeHtml(repoName)}
                    <span class="timeline-section-count">${repoSessions.length}</span>
                </div>
                <div class="timeline-rows">${rowsHtml}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="timeline-axis">${timeAxisHtml}</div>
        ${repoSectionsHtml}
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

function renderTimelineRow(session, periods, eventMarkers, startTime, endTime) {
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

    // Generate event markers (discrete point icons above the timeline track)
    const markersHtml = (eventMarkers || []).map(marker => {
        const ts = new Date(marker.timestamp).getTime();
        // Skip markers outside visible range
        if (ts < startTime || ts > endTime) return '';

        const left = ((ts - startTime) / duration) * 100;
        const tooltipText = `${marker.label} - ${formatTimeShort(marker.timestamp)}`;

        return `<div class="timeline-marker ${marker.type}"
                     style="left: ${left}%"
                     title="${escapeHtml(tooltipText)}"
                     data-marker-type="${marker.type}"
                     data-timestamp="${marker.timestamp}">${marker.icon}</div>`;
    }).join('');

    return `
        <div class="timeline-row ${isZombie ? 'zombie' : ''}" data-session-id="${session.sessionId}">
            <div class="timeline-label" onclick="focusWarpTab(previousSessions.get('${escapeJsString(session.sessionId)}'))">
                <span class="session-slug">${escapeHtml(session.slug)}</span>
                <span class="session-status ${statusClass}">${session.state}</span>
                <span class="last-active ${isZombie ? 'zombie-warning' : ''}">
                    ${isZombie ? icon('alert-triangle', {size:14}) + ' ' : ''}${lastActiveAgo}
                </span>
            </div>
            <div class="timeline-track">
                ${barsHtml || '<span class="no-activity">No activity in last ' + timelineHours + ' hours</span>'}
                ${markersHtml}
            </div>
        </div>
    `;
}

function formatTimeShort(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
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
                return `<span class="tool-count">${toolIcon(tool, 14)} ${escapeHtml(tool)} ×${count}</span>`;
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

    // Load analytics if switching to analytics view
    if (viewName === 'analytics' && typeof loadAnalytics === 'function') {
        loadAnalytics();
    }

    // Refresh Mission Control when switching to it
    if (viewName === 'mission-control') {
        // Fetch managed processes first, then render
        refreshManagedProcessList().then(() => refreshMissionControl());
    } else {
        // Clean up MC process WebSocket when leaving Mission Control view
        if (typeof disconnectMissionControlProcess === 'function') {
            disconnectMissionControlProcess();
        }
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


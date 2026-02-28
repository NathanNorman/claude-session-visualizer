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
                <span class="git-branch">${icon('git-branch', {size:14})} ${escapeHtml(git.branch)}</span>
                ${git.uncommitted ? `<span class="git-uncommitted">${icon('alert-triangle', {size:14})} ${git.modified_count} uncommitted</span>` : `<span class="git-clean">${icon('check', {size:12})} clean</span>`}
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

function renderCurrentSessions(sessions = null, forceFullRender = false) {
    if (!sessions) {
        sessions = Array.from(previousSessions.values());
    }
    const filtered = filterSessions(sessions);

    const sessionCount = filtered.length;

    // Update count display
    const activeCount = filtered.filter(s => s.state === 'active').length;
    let countText = activeCount > 0
        ? `${activeCount} active, ${sessionCount - activeCount} waiting`
        : `${sessionCount} session${sessionCount !== 1 ? 's' : ''}`;
    document.getElementById('session-count').textContent = countText;

    const container = document.getElementById('sessions-container');

    // Empty state
    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h2>No Claude sessions</h2>
                <p>Start a Claude Code session to see it here</p>
            </div>`;
        allVisibleSessions = [];
        renderedSessionIds.clear();
        initialRenderComplete = false;
        return;
    }

    // First render or forced full render - build everything
    if (!initialRenderComplete || forceFullRender || container.children.length === 0) {
        const groups = groupSessionsByProject(filtered);
        renderGroups(groups);

        renderedSessionIds = new Set(filtered.map(s => s.sessionId));
        initialRenderComplete = true;
    } else {
        // Incremental update - update session cards only
        updateSessionsInPlace(filtered);
    }

    if (selectedIndex >= allVisibleSessions.length) {
        clearSelection();
    }
}

// Update sessions without full DOM rebuild
function updateSessionsInPlace(sessions) {
    const container = document.getElementById('sessions-container');
    const currentIds = new Set(sessions.map(s => s.sessionId));

    // Build element map ONCE for O(1) lookups (instead of O(n) querySelector per session)
    const elementMap = new Map();
    container.querySelectorAll('[data-session-id]').forEach(card => {
        elementMap.set(card.dataset.sessionId, card);
    });

    // Update existing cards and track what needs to be added/removed
    const sessionsToAdd = [];

    for (const session of sessions) {
        const card = elementMap.get(session.sessionId);  // O(1) lookup
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
    for (const [sessionId, card] of elementMap) {
        if (!currentIds.has(sessionId)) {
            cardsToRemove.push(card);
        }
    }
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
        ? `<span class="permission-granted">${icon('check', {size:12})} Permission granted</span>`
        : permissionStatus === 'denied'
            ? `<span class="permission-denied">${icon('x', {size:12})} Permission denied (check browser settings)</span>`
            : `<span class="permission-pending">${icon('alert-triangle', {size:12})} Permission not requested yet</span>`;

    showModal(`
        <div class="notification-settings">
            <div class="settings-header">
                <h2>${icon('bell', {size:18})} Notification Settings</h2>
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
                        <span>${statusDot('active')} Session became active</span>
                    </label>
                    <p class="setting-desc">Notify when a waiting session starts working</p>
                </div>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-waiting"
                               ${notificationSettings.onWaiting ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onWaiting', this)">
                        <span>${icon('info', {size:14})} Session needs input</span>
                    </label>
                    <p class="setting-desc">Notify when an active session becomes idle (can be noisy)</p>
                </div>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-warning"
                               ${notificationSettings.onWarning ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onWarning', this)">
                        <span>${icon('alert-triangle', {size:14})} Context warning (80%)</span>
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

    const notification = new Notification('Test Notification', {
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


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
                ${m.last_error ? `<span class="machine-error" title="${escapeHtml(m.last_error)}">${icon('alert-triangle', {size:14})}</span>` : ''}
            </div>
            <div class="machine-actions">
                ${!m.connected ? `
                    <button onclick="handleReconnect('${escapeJsString(m.name)}')" class="btn-small">Reconnect</button>
                ` : ''}
                <button onclick="handleRemoveMachine('${escapeJsString(m.name)}')" class="btn-small danger">Remove</button>
            </div>
        </div>
    `).join('');

    showModal(`
        <div class="machines-modal">
            <div class="modal-header">
                <h2>${icon('monitor', {size:18})} Multi-Machine Management</h2>
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
        statusEl.innerHTML = `${icon('check', {size:12})} Connection successful`;
        statusEl.className = 'connection-status success';
    } else {
        statusEl.innerHTML = `${icon('x', {size:12})} ${escapeHtml(result.message)}`;
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
        statusEl.innerHTML = `${icon('x', {size:12})} ${escapeHtml(error.message)}`;
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
            ? (group.machineKey === 'local' ? icon('laptop', {size:14}) + ' ' : icon('monitor', {size:14}) + ' ')
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


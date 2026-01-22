// Adaptive polling intervals
const POLL_INTERVAL_ACTIVE = 3000;    // 3s when sessions are active
const POLL_INTERVAL_IDLE = 10000;     // 10s when all sessions idle
let currentPollInterval = POLL_INTERVAL_ACTIVE;
let pollTimeoutId = null;

const API_URL = '/api/sessions';
const API_URL_ALL = '/api/sessions/all';
let previousSessions = new Map();
const NOTES_KEY = 'session-notes';

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

// Feature 13: Keyboard shortcuts state
let selectedIndex = -1;
let keyboardMode = false;
let allVisibleSessions = [];

// Feature 15: AI Summary state
let summaryRefreshInterval = 300000; // 5 minutes
let lastSummaryRefresh = 0;

// UX Enhancement: Compact card mode and focus mode
let cardDisplayMode = localStorage.getItem('cardDisplayMode') || 'compact'; // 'compact' or 'detailed'
let focusMode = JSON.parse(localStorage.getItem('focusMode') || 'false');

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
        if (!this.enabled) return;
        if (!this.userHasInteracted) return; // No sound until user clicks/types
        if (!this.settings[soundName]?.enabled) return;

        this.initAudioContext();

        // Different tones for different events
        switch (soundName) {
            case 'active':
                // Positive ascending tone (session became active)
                this.playTone(523.25, 0.1, 'sine'); // C5
                setTimeout(() => this.playTone(659.25, 0.1, 'sine'), 100); // E5
                break;
            case 'waiting':
                // Neutral soft tone (session became waiting)
                this.playTone(440, 0.15, 'sine'); // A4
                break;
            case 'highContext':
                // Warning tone (high context usage)
                this.playTone(587.33, 0.1, 'square'); // D5
                setTimeout(() => this.playTone(587.33, 0.1, 'square'), 150);
                setTimeout(() => this.playTone(587.33, 0.1, 'square'), 300);
                break;
            case 'error':
                // Alert tone (error/failure)
                this.playTone(392, 0.2, 'sawtooth'); // G4
                break;
        }
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

// Feature 12: Session Notes - localStorage management
function getNotes() {
    const stored = localStorage.getItem(NOTES_KEY);
    return stored ? JSON.parse(stored) : {};
}

function getNote(sessionId) {
    return getNotes()[sessionId] || null;
}

function setNote(sessionId, note) {
    const notes = getNotes();
    notes[sessionId] = {
        text: note.text,
        tags: note.tags || [],
        updated: new Date().toISOString()
    };
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

function deleteNote(sessionId) {
    const notes = getNotes();
    delete notes[sessionId];
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
}

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

        // Schedule next poll with adaptive interval
        scheduleNextPoll(activeCount > 0);
    } catch (error) {
        console.error('Failed to fetch sessions:', error);
        // On error, still schedule next poll
        scheduleNextPoll(false);
    }
}

// Adaptive polling: faster when active, slower when idle
function scheduleNextPoll(hasActiveSessions) {
    if (pollTimeoutId) {
        clearTimeout(pollTimeoutId);
    }

    currentPollInterval = hasActiveSessions ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE;

    pollTimeoutId = setTimeout(() => {
        fetchSessions();
    }, currentPollInterval);
}

// Old renderSessions removed - replaced by renderCurrentSessions with grouping support

function renderNote(session) {
    const note = getNote(session.sessionId);
    if (!note) {
        return `
            <div class="session-note empty" onclick="event.stopPropagation(); editNote('${session.sessionId}')">
                <span class="add-note">+ Add note</span>
            </div>
        `;
    }

    return `
        <div class="session-note" onclick="event.stopPropagation(); editNote('${session.sessionId}')">
            <span class="note-icon">📝</span>
            <span class="note-text">"${escapeHtml(note.text)}"</span>
            ${note.tags?.length ? `
                <div class="note-tags">
                    ${note.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
                </div>
            ` : ''}
        </div>
    `;
}

function editNote(sessionId) {
    const existing = getNote(sessionId);

    showModal(`
        <div class="note-editor">
            <h3>Session Note</h3>
            <textarea id="note-text" placeholder="What is this session for?">${existing?.text || ''}</textarea>

            <div class="tag-input">
                <label>Tags:</label>
                <div class="tags-container" id="note-tags">
                    ${(existing?.tags || []).map(t =>
                        `<span class="tag">${escapeHtml(t)} <button onclick="removeTag(this)">×</button></span>`
                    ).join('')}
                    <input type="text" id="new-tag" placeholder="Add tag..."
                           onkeydown="if(event.key==='Enter') addTag()">
                </div>
            </div>

            <div class="modal-actions">
                ${existing ? `<button class="danger" onclick="deleteNoteAndClose('${sessionId}')">Delete</button>` : ''}
                <button onclick="closeModal()">Cancel</button>
                <button class="primary" onclick="saveNoteAndClose('${sessionId}')">Save</button>
            </div>
        </div>
    `);
}

function saveNoteAndClose(sessionId) {
    const text = document.getElementById('note-text').value.trim();
    const tagEls = document.querySelectorAll('#note-tags .tag');
    const tags = Array.from(tagEls).map(el => el.textContent.replace('×', '').trim());

    if (text) {
        setNote(sessionId, { text, tags });
    } else {
        deleteNote(sessionId);
    }

    closeModal();

    // Immediately update the note display on the card
    updateNoteDisplay(sessionId);
}

function deleteNoteAndClose(sessionId) {
    deleteNote(sessionId);
    closeModal();

    // Immediately update the note display on the card
    updateNoteDisplay(sessionId);
}

function updateNoteDisplay(sessionId) {
    const card = document.querySelector(`[data-session-id="${sessionId}"]`);
    if (!card) return;

    const noteEl = card.querySelector('.session-note');
    if (!noteEl) return;

    const session = previousSessions.get(sessionId) || { sessionId };
    const noteHtml = renderNote(session);
    const temp = document.createElement('div');
    temp.innerHTML = noteHtml;
    noteEl.replaceWith(temp.firstElementChild);
}

function addTag() {
    const input = document.getElementById('new-tag');
    const tag = input.value.trim();
    if (!tag) return;

    const container = document.getElementById('note-tags');
    const tagEl = document.createElement('span');
    tagEl.className = 'tag';
    tagEl.innerHTML = `${escapeHtml(tag)} <button onclick="removeTag(this)">×</button>`;
    container.insertBefore(tagEl, input);
    input.value = '';
}

function removeTag(btn) {
    btn.parentElement.remove();
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

    const activityLogHtml = formatActivityLog(session.recentActivity || []);
    const noteHtml = renderNote(session);

    // State source indicator (hooks = real-time, polling = heuristic)
    const stateIcon = session.stateSource === 'hooks' ? '<span class="state-source-indicator" title="Real-time hooks detection">⚡</span>' : '';

    // Current activity display (only when hooks-based and active)
    let currentActivityHtml = '';
    if (session.currentActivity && session.state === 'active') {
        let activityText = session.currentActivity.description || session.currentActivity.tool_name || '';
        if (activityText.length > 35) {
            activityText = activityText.substring(0, 32) + '...';
        }
        if (activityText) {
            const animatedIcon = renderAnimatedActivity(session.sessionId, session.currentActivity);
            currentActivityHtml = `<div class="current-activity ${session.currentActivity.type === 'tool_use' ? 'tool-running' : ''}" title="What Claude is doing right now">${animatedIcon} Running: ${escapeHtml(activityText)}</div>`;
            // Start animation loop if not running
            setTimeout(startAnimationLoop, 0);
        }
    }

    // Agent tree display (spawned agents)
    const agentTreeHtml = renderAgentTree(session.spawnedAgents);

    // Background shells display
    const backgroundShellsHtml = renderBackgroundShells(session.backgroundShells);

    // Emoji activity trail (hieroglyphic history)
    const activityTrailHtml = renderEmojiTrail(session.activityLog, session.state === 'active');

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="card-header">
            <span class="status-badge ${session.state}">
                <span class="status-indicator"></span>
                ${session.state}${stateIcon}
            </span>
            <div class="card-actions">
                <button class="action-menu-btn" onclick="event.stopPropagation(); toggleActionMenu('${session.sessionId}')">⋮</button>
                <div class="action-menu hidden" id="menu-${session.sessionId}">
                    <button onclick="event.stopPropagation(); copySessionId('${session.sessionId}')">📋 Copy Session ID</button>
                    <button onclick="event.stopPropagation(); openJsonl('${session.sessionId}')">📂 Open JSONL File</button>
                    <button onclick="event.stopPropagation(); copyResumeCmd('${session.sessionId}')">🔗 Copy Resume Command</button>
                    <hr class="menu-divider">
                    <button onclick="event.stopPropagation(); showGitDetails('${session.sessionId}')">🌿 Git Details</button>
                    <button onclick="event.stopPropagation(); showMetricsModal('${session.sessionId}')">📊 Performance Metrics</button>
                    <button onclick="event.stopPropagation(); refreshSummary('${session.sessionId}')">🤖 Generate AI Summary</button>
                    <button onclick="event.stopPropagation(); shareSession('${session.sessionId}')">📤 Share Session</button>
                    <button onclick="event.stopPropagation(); exportSession('${session.sessionId}')">📄 Export Markdown</button>
                    <button onclick="event.stopPropagation(); saveAsTemplate({sessionId: '${session.sessionId}', cwd: '${escapeHtml(session.cwd)}', slug: '${escapeHtml(session.slug)}'})">💾 Save as Template</button>
                    <button onclick="event.stopPropagation(); editNote('${session.sessionId}')">📝 Edit Note</button>
                    <hr class="menu-divider">
                    <button class="danger" onclick="event.stopPropagation(); killSession(${session.pid}, '${escapeHtml(session.slug)}')">⚠️ Kill Session</button>
                </div>
            </div>
        </div>
        <div class="slug">${session.isGastown ? `<span class="gt-icon ${getGastownAgentType(session.slug).css}" title="${getGastownAgentType(session.slug).label}">${getGastownAgentType(session.slug).icon}</span> ` : ''}${escapeHtml(session.slug)}</div>
        ${summaryHtml}
        ${noteHtml}
        ${gitHtml}
        ${formatTokenBar(session.contextTokens)}
        ${currentActivityHtml}
        ${activityTrailHtml}
        ${agentTreeHtml}
        ${backgroundShellsHtml}
        <div class="activity-log">${activityLogHtml}</div>
        ${renderConversationPeek(session)}
        <div class="card-footer">
            <div class="meta">
                <span>PID: ${session.pid || '--'}</span>
                <span>CPU: ${formatCpu(session.cpuPercent)}%</span>
                <span>${formatTime(session.lastActivity)}</span>
            </div>
            <button class="metrics-btn" onclick="event.stopPropagation(); showMetricsModal('${session.sessionId}')" title="View Metrics">📊</button>
        </div>`;

    // No fade-in animation - cards appear instantly for visual stability

    // Auto-scroll activity log to bottom, but respect manual scroll
    const logEl = card.querySelector('.activity-log');
    if (logEl) {
        // Defer scroll until after DOM is fully rendered
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                logEl.scrollTop = logEl.scrollHeight;
            });
        });
        // Track if user manually scrolls
        logEl.dataset.userScrolled = 'false';
        logEl.addEventListener('scroll', () => {
            const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
            logEl.dataset.userScrolled = atBottom ? 'false' : 'true';
        });
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

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="compact-row">
            <span class="status-dot ${session.state}"></span>
            <span class="compact-slug">${session.isGastown ? `<span class="gt-icon ${getGastownAgentType(session.slug).css}">${getGastownAgentType(session.slug).icon}</span> ` : ''}${escapeHtml(session.slug)}</span>
            <span class="compact-tokens ${tokenClass}">${Math.round(tokenPct)}%</span>
            <button class="compact-expand" onclick="event.stopPropagation(); expandCard('${session.sessionId}')" title="Show details">▼</button>
        </div>
        <div class="compact-activity">${escapeHtml(latestActivity)}</div>
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

// Feature 15: AI Summary refresh
async function refreshSummary(sessionId) {
    closeAllMenus();
    showToast('Generating AI summary...');

    try {
        const response = await fetch(`/api/sessions/${sessionId}/summary?force_refresh=true`, {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.json();
            showToast(`Failed: ${error.detail || 'Unknown error'}`, 'error');
            return;
        }

        const data = await response.json();
        const card = document.querySelector(`[data-session-id="${sessionId}"]`);

        // Save AI summary to notes
        const existingNote = getNote(sessionId);
        const timestamp = new Date().toLocaleTimeString();
        const newEntry = `[${timestamp}] AI: ${data.summary}`;
        const combinedText = existingNote?.text
            ? `${existingNote.text}\n\n${newEntry}`
            : newEntry;
        const combinedTags = existingNote?.tags || [];
        if (!combinedTags.includes('ai-generated')) {
            combinedTags.push('ai-generated');
        }
        setNote(sessionId, { text: combinedText, tags: combinedTags });

        // Directly update the note display on the card
        if (card) {
            const noteEl = card.querySelector('.session-note');
            const displayText = combinedText.length > 100
                ? combinedText.substring(0, 100) + '...'
                : combinedText;
            const tagsHtml = combinedTags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
            if (noteEl) {
                noteEl.outerHTML = `
                    <div class="session-note" onclick="event.stopPropagation(); editNote('${sessionId}')">
                        <span class="note-icon">📝</span>
                        <span class="note-text">"${escapeHtml(displayText)}"</span>
                        <div class="note-tags">${tagsHtml}</div>
                    </div>
                `;
            }
        }

        showToast('AI summary added to notes!');
    } catch (e) {
        console.error('Failed to refresh summary:', e);
        showToast('Failed to refresh summary', 'error');
    }
}

// Refresh all AI summaries for non-gastown sessions with new activity
async function refreshAllSummaries() {
    const btn = document.getElementById('refresh-all-summaries');
    if (btn) btn.disabled = true;

    showToast('Refreshing AI summaries...');

    try {
        const response = await fetch('/api/sessions/refresh-all-summaries', {
            method: 'POST'
        });

        if (!response.ok) {
            const error = await response.json();
            showToast(`Failed: ${error.detail || 'Unknown error'}`, 'error');
            return;
        }

        const data = await response.json();

        // Save summaries to notes and update cards
        for (const item of data.details.refreshed) {
            const sessionId = item.sessionId;
            const summary = item.summary;

            // Save to notes (persisted to localStorage)
            const existingNote = getNote(sessionId);
            const timestamp = new Date().toLocaleTimeString();
            const newEntry = `[${timestamp}] AI: ${summary}`;
            const combinedText = existingNote?.text
                ? `${existingNote.text}\n\n${newEntry}`
                : newEntry;
            const combinedTags = existingNote?.tags || [];
            if (!combinedTags.includes('ai-generated')) {
                combinedTags.push('ai-generated');
            }
            setNote(sessionId, { text: combinedText, tags: combinedTags });

            // Update note display on card
            const card = document.querySelector(`[data-session-id="${sessionId}"]`);
            if (card) {
                const noteEl = card.querySelector('.session-note');
                if (noteEl) {
                    const displayText = combinedText.length > 100
                        ? combinedText.substring(0, 100) + '...'
                        : combinedText;
                    const tagsHtml = combinedTags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
                    noteEl.outerHTML = `
                        <div class="session-note" onclick="event.stopPropagation(); editNote('${sessionId}')">
                            <span class="note-icon">📝</span>
                            <span class="note-text">"${escapeHtml(displayText)}"</span>
                            <div class="note-tags">${tagsHtml}</div>
                        </div>
                    `;
                }
            }
        }

        const skippedNoActivity = data.details.skipped.filter(s => s.reason === 'no_new_activity').length;
        const skippedGastown = data.details.skipped.filter(s => s.reason === 'gastown').length;

        let message = `Updated ${data.refreshed} summaries`;
        if (skippedNoActivity > 0) {
            message += `, ${skippedNoActivity} unchanged`;
        }
        showToast(message);

    } catch (e) {
        console.error('Failed to refresh all summaries:', e);
        showToast('Failed to refresh summaries', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
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

    if (!prev || prev.state !== session.state) {
        card.classList.remove('active', 'waiting');
        card.classList.add(session.state);
        const badge = card.querySelector('.status-badge');
        badge.className = `status-badge ${session.state}`;
        badge.innerHTML = `<span class="status-indicator"></span>${session.state}`;

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

    // Update activity log
    const logEl = card.querySelector('.activity-log');
    if (logEl) {
        const newActivity = session.recentActivity || [];
        const prevActivity = prev?.recentActivity || [];

        // Check if activity changed
        if (JSON.stringify(newActivity) !== JSON.stringify(prevActivity)) {
            logEl.innerHTML = formatActivityLog(newActivity);
            // Only auto-scroll if user hasn't manually scrolled up
            if (logEl.dataset.userScrolled !== 'true') {
                requestAnimationFrame(() => {
                    logEl.scrollTop = logEl.scrollHeight;
                });
            }
        }
    }

    // Update current activity display (hooks-based real-time activity)
    updateCurrentActivity(card, session, prev);

    // Update note display (notes are stored in localStorage, not server)
    const noteEl = card.querySelector('.session-note');
    if (noteEl) {
        const noteHtml = renderNote(session);
        const temp = document.createElement('div');
        temp.innerHTML = noteHtml;
        noteEl.replaceWith(temp.firstElementChild);
    }

    card.querySelector('.meta').innerHTML = `
        <span>PID: ${session.pid || '--'}</span>
        <span>CPU: ${formatCpu(session.cpuPercent)}%</span>
        <span>${formatTime(session.lastActivity)}</span>`;
}

// Update current activity element (hooks-based real-time activity)
function updateCurrentActivity(card, session, prev) {
    // Only update if activity has changed
    if (prev && !hasActivityChanged(prev, session)) return;

    const currentActivityEl = card.querySelector('.current-activity');
    const activityLog = card.querySelector('.activity-log');

    // Check if we should show current activity
    if (session.currentActivity && session.state === 'active') {
        let activityText = session.currentActivity.description || session.currentActivity.tool_name || '';
        if (activityText.length > 35) {
            activityText = activityText.substring(0, 32) + '...';
        }

        if (activityText) {
            const animatedIcon = renderAnimatedActivity(session.sessionId, session.currentActivity);
            const isToolRunning = session.currentActivity.type === 'tool_use';

            if (currentActivityEl) {
                // Update existing element
                currentActivityEl.className = `current-activity ${isToolRunning ? 'tool-running' : ''}`;
                currentActivityEl.title = 'What Claude is doing right now';
                currentActivityEl.innerHTML = `${animatedIcon} Running: ${escapeHtml(activityText)}`;
            } else if (activityLog) {
                // Create new element and insert before activity log
                const newActivityEl = document.createElement('div');
                newActivityEl.className = `current-activity ${isToolRunning ? 'tool-running' : ''}`;
                newActivityEl.title = 'What Claude is doing right now';
                newActivityEl.innerHTML = `${animatedIcon} Running: ${escapeHtml(activityText)}`;
                activityLog.parentNode.insertBefore(newActivityEl, activityLog);
            }
            // Start animation loop
            setTimeout(startAnimationLoop, 0);
        } else if (currentActivityEl) {
            currentActivityEl.remove();
        }
    } else if (currentActivityEl) {
        // Remove element if session is not active or has no current activity
        currentActivityEl.remove();
    }
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

function formatActivityLog(activities) {
    if (!activities || activities.length === 0) {
        return '<div class="activity-item empty">No recent activity</div>';
    }
    return activities.map(a =>
        `<div class="activity-item">${escapeHtml(a)}</div>`
    ).join('');
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
function buildEmojiTrail(activityLog, maxLength = 12) {
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
        return '';
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

        // Encode data for the popover
        const dataAttrs = `data-tool="${escapeHtml(item.tool)}" data-desc="${escapeHtml(item.description)}" data-time="${escapeHtml(item.timestamp || '')}"`;

        return `<span class="${classes}" ${dataAttrs} onclick="showActivityPopover(event, this)">${item.emoji}</span>`;
    }).join('');

    return `
        <div class="activity-trail">
            <span class="trail-label">Activity:</span>
            <div class="trail-emojis">${emojisHtml}</div>
        </div>
    `;
}

// Show popover with activity details
function showActivityPopover(event, element) {
    event.stopPropagation();

    // Remove any existing popover
    const existing = document.querySelector('.activity-popover');
    if (existing) existing.remove();

    const tool = element.dataset.tool;
    const desc = element.dataset.desc;
    const time = element.dataset.time;
    const formattedTime = formatActivityTime(time);

    // Create popover
    const popover = document.createElement('div');
    popover.className = 'activity-popover';
    popover.innerHTML = `
        <div class="popover-header">${element.textContent} ${escapeHtml(tool)}</div>
        <div class="popover-desc">${escapeHtml(desc)}</div>
        ${formattedTime ? `<div class="popover-time">${formattedTime}</div>` : ''}
    `;

    // Position popover near the clicked element
    document.body.appendChild(popover);
    const rect = element.getBoundingClientRect();
    popover.style.left = `${rect.left + window.scrollX}px`;
    popover.style.top = `${rect.bottom + window.scrollY + 8}px`;

    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', function closePopover() {
            popover.remove();
            document.removeEventListener('click', closePopover);
        }, { once: true });
    }, 10);
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
    // Stable sort: alphabetically by name, NOT by active count
    // This prevents groups from jumping around when session states change
    return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
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

        // Left side: repo name
        const labelDiv = document.createElement('div');
        labelDiv.className = 'session-row-label';
        labelDiv.innerHTML = `
            <span class="row-name">${escapeHtml(group.name)}</span>
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
            if (repoName === 'gt' && parts.length >= 4) {
                const rigOrHq = parts[3];
                // Check if it's an HQ-level agent (deacon, mayor) vs a rig
                if (GT_HQ_AGENTS.includes(rigOrHq)) {
                    repoName = 'Gas Town HQ';
                } else {
                    repoName = rigOrHq; // It's a rig name = actual repo
                }
            }
        } else if (parts.length >= 3 && parts[0] === 'home') {
            repoName = parts[2]; // /home/username/REPO/...
            if (repoName === 'gt' && parts.length >= 4) {
                const rigOrHq = parts[3];
                if (GT_HQ_AGENTS.includes(rigOrHq)) {
                    repoName = 'Gas Town HQ';
                } else {
                    repoName = rigOrHq;
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
    cardsToRemove.forEach(card => card.remove());

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
                           onchange="toggleNotificationSetting('enabled')">
                    <span>Enable desktop notifications</span>
                </label>
            </div>

            <div class="setting-group">
                <h3>Notification Types</h3>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-active"
                               ${notificationSettings.onActive ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onActive')">
                        <span>🟢 Session became active</span>
                    </label>
                    <p class="setting-desc">Notify when a waiting session starts working</p>
                </div>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-waiting"
                               ${notificationSettings.onWaiting ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onWaiting')">
                        <span>🔵 Session needs input</span>
                    </label>
                    <p class="setting-desc">Notify when an active session becomes idle (can be noisy)</p>
                </div>
                <div class="notification-event">
                    <label class="setting-toggle">
                        <input type="checkbox" id="notify-warning"
                               ${notificationSettings.onWarning ? 'checked' : ''}
                               onchange="toggleNotificationSetting('onWarning')">
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

function toggleNotificationSetting(setting) {
    notificationSettings[setting] = !notificationSettings[setting];
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
    if (!notificationSettings.enabled) return;
    if (Notification.permission !== 'granted') return;
    const notification = new Notification(title, {
        body,
        icon: '/favicon.ico',
        tag: options.sessionId,
        ...options
    });
    notification.onclick = () => {
        window.focus();
        if (options.sessionId) {
            const card = document.querySelector(`[data-session-id="${options.sessionId}"]`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('keyboard-selected');
                setTimeout(() => card.classList.remove('keyboard-selected'), 2000);
            }
        }
        notification.close();
    };
    setTimeout(() => notification.close(), 5000);
}

function checkStateChanges(oldSessions, newSessions) {
    const oldMap = new Map(oldSessions.map(s => [s.sessionId, s]));
    for (const session of newSessions) {
        const old = oldMap.get(session.sessionId);
        if (!old) continue;
        // Skip notifications for gastown sessions
        if (session.isGastown) continue;
        if (old.state === 'waiting' && session.state === 'active') {
            if (notificationSettings.onActive) {
                sendNotification('🟢 Session Active', `${session.slug} is working`,
                    { sessionId: session.sessionId, type: 'active' });
                soundManager.play('active');
            }
        }
        if (old.state === 'active' && session.state === 'waiting') {
            if (notificationSettings.onWaiting) {
                sendNotification('🔵 Session Waiting', `${session.slug} needs input`,
                    { sessionId: session.sessionId, type: 'waiting' });
                soundManager.play('waiting');
            }
        }
        if (old.contextTokens < 160000 && session.contextTokens >= 160000) {
            if (notificationSettings.onWarning) {
                sendNotification('⚠️ Context Warning',
                    `${session.slug} is at ${Math.round(session.contextTokens/2000)}% capacity`,
                    { sessionId: session.sessionId, type: 'warning' });
                soundManager.play('highContext');
            }
        }
    }
}

// ============================================================================
// Feature 13: Keyboard Shortcuts Implementation
// ============================================================================

function initializeKeyboardShortcuts() {
    const helpButton = document.getElementById('help-button');
    helpButton.addEventListener('click', showShortcutsHelp);
    document.addEventListener('keydown', handleKeyPress);
    document.addEventListener('keydown', () => {
        document.body.classList.add('keyboard-mode');
    });
    document.addEventListener('mousedown', () => {
        document.body.classList.remove('keyboard-mode');
        clearSelection();
    });
}

function handleKeyPress(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') {
            e.target.blur();
            clearSelection();
        }
        return;
    }
    const modalOpen = !document.getElementById('modal-overlay').classList.contains('hidden');
    if (modalOpen) {
        if (e.key === 'Escape' || e.key === '?') {
            closeModal();
            e.preventDefault();
        }
        return;
    }
    const shortcuts = {
        'ArrowUp': () => selectSession(selectedIndex - 1),
        'ArrowDown': () => selectSession(selectedIndex + 1),
        'k': () => selectSession(selectedIndex - 1),
        'j': () => selectSession(selectedIndex + 1),
        '1': () => selectSession(0),
        '2': () => selectSession(1),
        '3': () => selectSession(2),
        '4': () => selectSession(3),
        '5': () => selectSession(4),
        '6': () => selectSession(5),
        '7': () => selectSession(6),
        '8': () => selectSession(7),
        '9': () => selectSession(8),
        'Enter': () => focusSelectedTerminal(),
        'c': () => copySelectedSessionId(),
        '/': () => focusSearch(),
        'r': () => fetchSessions(),
        'n': () => showNotificationSettings(),
        'm': () => { soundManager.toggle(); soundManager.updateMuteIndicator(); showToast(soundManager.enabled ? 'Sound enabled' : 'Sound muted'); },
        'v': () => toggleCardMode(),
        'f': () => toggleFocusMode(),
        '?': () => showShortcutsHelp(),
        'Escape': () => clearSelection()
    };
    const handler = shortcuts[e.key];
    if (handler) {
        e.preventDefault();
        keyboardMode = true;
        handler();
    }
}

function selectSession(index) {
    if (allVisibleSessions.length === 0) return;
    const maxIndex = allVisibleSessions.length - 1;
    if (index < 0) index = maxIndex;
    if (index > maxIndex) index = 0;
    selectedIndex = index;
    const cards = document.querySelectorAll('.session-card');
    cards.forEach((card, i) => {
        card.classList.toggle('keyboard-selected', i === selectedIndex);
    });
    cards[selectedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearSelection() {
    selectedIndex = -1;
    keyboardMode = false;
    document.querySelectorAll('.keyboard-selected').forEach(el => {
        el.classList.remove('keyboard-selected');
    });
}

function getSelectedSession() {
    if (selectedIndex < 0 || selectedIndex >= allVisibleSessions.length) return null;
    return allVisibleSessions[selectedIndex];
}

function focusSelectedTerminal() {
    const session = getSelectedSession();
    if (session) focusWarpTab(session);
}

function copySelectedSessionId() {
    const session = getSelectedSession();
    if (session) {
        navigator.clipboard.writeText(session.sessionId);
        showToast('Session ID copied');
    }
}

function focusSearch() {
    const searchInput = document.getElementById('search');
    if (searchInput) searchInput.focus();
}

function showShortcutsHelp() {
    showModal(`
        <h2>Keyboard Shortcuts</h2>
        <div class="shortcuts-grid">
            <div class="shortcut-section">
                <h4>Navigation</h4>
                <dl>
                    <dt>↑/↓</dt><dd>Select session</dd>
                    <dt>j/k</dt><dd>Select session (vim)</dd>
                    <dt>1-9</dt><dd>Jump to session</dd>
                    <dt>/</dt><dd>Focus search</dd>
                    <dt>Esc</dt><dd>Clear selection</dd>
                </dl>
            </div>
            <div class="shortcut-section">
                <h4>Actions</h4>
                <dl>
                    <dt>Enter</dt><dd>Focus terminal</dd>
                    <dt>c</dt><dd>Copy session ID</dd>
                    <dt>r</dt><dd>Refresh</dd>
                </dl>
            </div>
            <div class="shortcut-section">
                <h4>Settings</h4>
                <dl>
                    <dt>n</dt><dd>Notification settings</dd>
                    <dt>m</dt><dd>Toggle sound</dd>
                    <dt>?</dt><dd>Show this help</dd>
                </dl>
            </div>
        </div>
    `);
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
    initializeKeyboardShortcuts();
    initializeUXEnhancements();
});

// ============================================================================
// Feature 05: Session Timeline Implementation
// ============================================================================

const TIMELINE_HOURS = 8; // Show last 8 hours
let timelineData = new Map(); // sessionId -> activityPeriods
let timelineViewActive = false;

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
    const sessions = Array.from(previousSessions.values());

    if (sessions.length === 0) {
        container.innerHTML = `
            <div class="timeline-empty">
                <p>No active sessions to show on timeline.</p>
                <p>Start a Claude Code session to see activity here.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = '<div class="timeline-loading">Loading timeline data...</div>';

    // Fetch timeline data for all sessions in parallel
    const timelinePromises = sessions.map(async (session) => {
        const periods = await fetchSessionTimeline(session.sessionId);
        return { session, periods };
    });

    const results = await Promise.all(timelinePromises);

    // Store timeline data
    results.forEach(({ session, periods }) => {
        if (periods) {
            timelineData.set(session.sessionId, periods);
        }
    });

    // Render the timeline
    renderTimeline(sessions);
}

function renderTimeline(sessions) {
    const container = document.getElementById('timeline-container');
    const now = Date.now();
    const hoursBack = TIMELINE_HOURS;
    const startTime = now - (hoursBack * 60 * 60 * 1000);

    // Separate normal and gastown sessions
    const normalSessions = sessions.filter(s => !s.isGastown);
    const gastownSessions = sessions.filter(s => s.isGastown);

    // Generate time axis
    const timeAxisHtml = generateTimeAxis(startTime, now, hoursBack);

    // Generate timeline rows for normal sessions
    const normalRowsHtml = normalSessions.map(session => {
        const periods = timelineData.get(session.sessionId) || [];
        return renderTimelineRow(session, periods, startTime, now);
    }).join('');

    // Generate timeline rows for gastown sessions
    const gastownRowsHtml = gastownSessions.map(session => {
        const periods = timelineData.get(session.sessionId) || [];
        return renderTimelineRow(session, periods, startTime, now);
    }).join('');

    container.innerHTML = `
        <div class="timeline-axis">${timeAxisHtml}</div>
        ${normalSessions.length > 0 ? `
            <div class="timeline-section">
                <div class="timeline-section-header">Sessions</div>
                <div class="timeline-rows">${normalRowsHtml}</div>
            </div>
        ` : ''}
        ${gastownSessions.length > 0 ? `
            <div class="timeline-section gastown-section">
                <div class="timeline-section-header">🏭 Gastown Agents</div>
                <div class="timeline-rows">${gastownRowsHtml}</div>
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

    // Determine session status for styling
    const statusClass = session.state === 'active' ? 'active' : 'waiting';

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
                ${barsHtml || '<span class="no-activity">No activity in last ' + TIMELINE_HOURS + ' hours</span>'}
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

// View switching
function switchView(viewName) {
    // Update tab buttons
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });

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
}

function toggleAnalytics() {
    const currentView = document.querySelector('.tab-button.active')?.dataset.view;
    if (currentView === 'analytics') {
        switchView('sessions');
    } else {
        switchView('analytics');
    }
}

// Initial fetch - scheduleNextPoll() is called inside fetchSessions()
fetchSessions();

// Auto-refresh timeline when on that view
setInterval(() => {
    if (timelineViewActive) {
        refreshTimeline();
    }
}, 30000); // Refresh every 30 seconds when viewing timeline

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
// Feature 09: Conversation Peek Implementation
// ============================================================================

// Cache for conversation data to avoid repeated API calls
const conversationCache = new Map();
const CONVERSATION_CACHE_TTL = 30000; // 30 seconds

async function loadConversation(sessionId, limit = 20) {
    // Check cache first
    const cached = conversationCache.get(sessionId);
    if (cached && Date.now() - cached.timestamp < CONVERSATION_CACHE_TTL) {
        return cached.messages;
    }

    try {
        const resp = await fetch(`/api/session/${sessionId}/conversation?limit=${limit}`);
        if (!resp.ok) return [];
        const data = await resp.json();
        const messages = data.messages || [];

        // Cache the result
        conversationCache.set(sessionId, {
            messages,
            timestamp: Date.now()
        });

        return messages;
    } catch (e) {
        console.warn('Failed to load conversation:', e);
        return [];
    }
}

function truncateText(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
}

function renderConversationPeek(session) {
    // Show a placeholder that loads conversation on demand
    return `
        <div class="conversation-peek" id="conv-peek-${session.sessionId}" onclick="event.stopPropagation();">
            <div class="peek-loading" onclick="loadConversationPeek('${session.sessionId}')">
                💬 View last exchange
            </div>
        </div>
    `;
}

async function loadConversationPeek(sessionId) {
    const peekEl = document.getElementById(`conv-peek-${sessionId}`);
    if (!peekEl) return;

    peekEl.innerHTML = '<div class="peek-loading">Loading...</div>';

    const messages = await loadConversation(sessionId, 10);

    if (messages.length < 2) {
        peekEl.innerHTML = '<div class="peek-empty">No conversation yet</div>';
        return;
    }

    // Get last human and assistant messages
    const lastHuman = [...messages].reverse().find(m => m.role === 'human');
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

    if (!lastHuman && !lastAssistant) {
        peekEl.innerHTML = '<div class="peek-empty">No conversation yet</div>';
        return;
    }

    const humanText = lastHuman ? truncateText(lastHuman.content, 80) : '';
    const assistantText = lastAssistant ? truncateText(lastAssistant.content, 120) : '';

    peekEl.innerHTML = `
        <div class="peek-exchange">
            ${humanText ? `
                <div class="peek-human">
                    <span class="peek-role">👤 You:</span>
                    <span class="peek-text">"${escapeHtml(humanText)}"</span>
                </div>
            ` : ''}
            ${assistantText ? `
                <div class="peek-assistant">
                    <span class="peek-role">🤖 Claude:</span>
                    <span class="peek-text">"${escapeHtml(assistantText)}"</span>
                </div>
            ` : ''}
        </div>
        <button class="peek-more" onclick="event.stopPropagation(); openConversationModal('${sessionId}')">
            View full conversation →
        </button>
    `;
}

async function openConversationModal(sessionId) {
    closeAllMenus();
    const session = previousSessions.get(sessionId);
    const sessionName = session?.slug || sessionId;

    showModal(`
        <div class="conversation-modal">
            <div class="conversation-modal-header">
                <h3>💬 Conversation History</h3>
                <span class="modal-session-name">${escapeHtml(sessionName)}</span>
                <button onclick="closeModal()" class="modal-close">Close</button>
            </div>
            <div class="conversation-modal-body" id="conversation-messages">
                <div class="loading">Loading conversation...</div>
            </div>
            <div class="conversation-modal-footer">
                <button onclick="loadMoreConversation('${sessionId}')" id="load-more-btn" class="btn-secondary">
                    Load more
                </button>
            </div>
        </div>
    `);

    // Load initial conversation
    const messages = await loadConversation(sessionId, 20);
    renderConversationModal(messages);
}

let currentConversationLimit = 20;

async function loadMoreConversation(sessionId) {
    currentConversationLimit += 20;
    const btn = document.getElementById('load-more-btn');
    if (btn) btn.textContent = 'Loading...';

    // Clear cache to fetch fresh data
    conversationCache.delete(sessionId);

    const messages = await loadConversation(sessionId, currentConversationLimit);
    renderConversationModal(messages);

    if (btn) btn.textContent = 'Load more';
}

function renderConversationModal(messages) {
    const container = document.getElementById('conversation-messages');
    if (!container) return;

    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="conversation-empty">
                <p>No conversation history found.</p>
                <p>Start chatting with Claude to see messages here.</p>
            </div>
        `;
        return;
    }

    // Render messages in chronological order (oldest first)
    const messagesHtml = messages.map(msg => renderConversationMessage(msg)).join('');

    container.innerHTML = messagesHtml;

    // Scroll to bottom to show most recent
    requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
    });
}

function renderConversationMessage(msg) {
    const icon = msg.role === 'human' ? '👤' : '🤖';
    const roleLabel = msg.role === 'human' ? 'You' : 'Claude';
    const roleClass = msg.role === 'human' ? 'human' : 'assistant';

    // Format timestamp
    let timeStr = '';
    if (msg.timestamp) {
        try {
            const date = new Date(msg.timestamp);
            timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            timeStr = '';
        }
    }

    // Render tool badges if present
    const toolsHtml = msg.tools?.length ? `
        <div class="message-tools">
            ${msg.tools.map(t => `<span class="tool-badge">${escapeHtml(t)}</span>`).join('')}
        </div>
    ` : '';

    // Format content - handle code blocks and newlines
    const formattedContent = formatMessageContent(msg.content || '');

    return `
        <div class="conversation-message ${roleClass}">
            <div class="message-header">
                <span class="message-icon">${icon}</span>
                <span class="message-role">${roleLabel}</span>
                <span class="message-time">${timeStr}</span>
            </div>
            <div class="message-content">${formattedContent}</div>
            ${toolsHtml}
        </div>
    `;
}

function formatMessageContent(content) {
    if (!content) return '';

    // Escape HTML first
    let escaped = escapeHtml(content);

    // Convert code blocks (```...```)
    escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="code-block"><code>${code.trim()}</code></pre>`;
    });

    // Convert inline code (`...`)
    escaped = escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Convert newlines to <br>
    escaped = escaped.replace(/\n/g, '<br>');

    return escaped;
}

console.log('Claude Session Visualizer loaded - All features active (including Feature 09: Conversation Peek)');

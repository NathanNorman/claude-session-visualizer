const POLL_INTERVAL = 1500;
const API_URL = '/api/sessions';
let previousSessions = new Map();
const NOTES_KEY = 'session-notes';

// Feature 01: Search/Filter state
let searchQuery = '';
let statusFilter = 'all';
let searchDebounceTimer = null;

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

// Feature 08: Session Comparison state
let comparedSessions = [null, null];
let compareViewActive = false;

// Sound Manager - Feature 14
class SoundManager {
    constructor() {
        this.audioContext = null;
        this.enabled = true;
        this.volume = 0.7;
        this.settings = this.loadSettings();
        this.initAudioContext();
    }

    initAudioContext() {
        // Lazy init on first interaction to avoid autoplay restrictions
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
        if (!this.enabled || !this.audioContext) return;

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

        // Refresh compare view if active
        if (compareViewActive) {
            renderCompareView();
        }

        const activeCount = data.sessions.filter(s => s.state === 'active').length;
        updateStatus(activeCount, data.sessions.length, data.timestamp);
    } catch (error) {
        console.error('Failed to fetch sessions:', error);
    }
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
    fetchSessions();
}

function deleteNoteAndClose(sessionId) {
    deleteNote(sessionId);
    closeModal();
    fetchSessions();
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

    // Feature 15: AI Summary display
    const aiSummaryHtml = session.aiSummary
        ? `<div class="ai-summary">${escapeHtml(session.aiSummary)}</div>`
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

    const activityHtml = formatActivityLog(session.recentActivity || []);
    const noteHtml = renderNote(session);

    card.innerHTML = `
        <span class="card-number">${index + 1}</span>
        <div class="card-header">
            <span class="status-badge ${session.state}">
                <span class="status-indicator"></span>
                ${session.state}
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
                    <button onclick="event.stopPropagation(); refreshSummary('${session.sessionId}')">🤖 Refresh AI Summary</button>
                    <button onclick="event.stopPropagation(); shareSession('${session.sessionId}')">📤 Share Session</button>
                    <button onclick="event.stopPropagation(); exportSession('${session.sessionId}')">📄 Export Markdown</button>
                    <button onclick="event.stopPropagation(); saveAsTemplate({sessionId: '${session.sessionId}', cwd: '${escapeHtml(session.cwd)}', slug: '${escapeHtml(session.slug)}'})">💾 Save as Template</button>
                    <button onclick="event.stopPropagation(); editNote('${session.sessionId}')">📝 Edit Note</button>
                    <hr class="menu-divider">
                    <button class="danger" onclick="event.stopPropagation(); killSession(${session.pid}, '${escapeHtml(session.slug)}')">⚠️ Kill Session</button>
                </div>
            </div>
            <span class="context-size">${formatTokens(session.contextTokens)}</span>
        </div>
        <div class="slug">${escapeHtml(session.slug)}</div>
        ${summaryHtml}
        ${aiSummaryHtml}
        ${noteHtml}
        <div class="cwd">${escapeHtml(session.cwd || 'Unknown')}${branchHtml}</div>
        ${gitHtml}
        ${formatTokenBar(session.contextTokens)}
        <div class="activity-log">${activityHtml}</div>
        <div class="metrics-preview" onclick="event.stopPropagation(); showMetricsModal('${session.sessionId}')">
            <span class="metrics-icon">📊</span>
            <span class="metrics-label">View Metrics</span>
        </div>
        <div class="meta">
            <span>PID: ${session.pid || '--'}</span>
            <span>CPU: ${formatCpu(session.cpuPercent)}%</span>
            <span>${formatTime(session.lastActivity)}</span>
        </div>`;

    card.style.opacity = '0';
    requestAnimationFrame(() => {
        card.style.transition = 'opacity 0.3s ease';
        card.style.opacity = '1';
    });

    // Auto-scroll activity log to bottom, but respect manual scroll
    const logEl = card.querySelector('.activity-log');
    if (logEl) {
        logEl.scrollTop = logEl.scrollHeight;
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

        // Update the card's AI summary display
        const card = document.querySelector(`[data-session-id="${sessionId}"]`);
        if (card) {
            let summaryEl = card.querySelector('.ai-summary');
            if (summaryEl) {
                summaryEl.textContent = data.summary;
            } else {
                // Insert AI summary after slug if it doesn't exist
                const slugEl = card.querySelector('.slug');
                if (slugEl) {
                    const newSummaryEl = document.createElement('div');
                    newSummaryEl.className = 'ai-summary';
                    newSummaryEl.textContent = data.summary;
                    slugEl.insertAdjacentElement('afterend', newSummaryEl);
                }
            }
        }

        // Update cache in previousSessions
        const session = previousSessions.get(sessionId);
        if (session) {
            session.aiSummary = data.summary;
            previousSessions.set(sessionId, session);
        }

        showToast('AI summary updated!');
    } catch (e) {
        console.error('Failed to refresh summary:', e);
        showToast('Failed to refresh summary', 'error');
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
                logEl.scrollTop = logEl.scrollHeight;
            }
        }
    }

    card.querySelector('.meta').innerHTML = `
        <span>PID: ${session.pid || '--'}</span>
        <span>CPU: ${formatCpu(session.cpuPercent)}%</span>
        <span>${formatTime(session.lastActivity)}</span>`;
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
            renderCurrentSessions();
        }, 150);
    });

    statusSelect.addEventListener('change', (e) => {
        statusFilter = e.target.value;
        renderCurrentSessions();
    });

    clearButton.addEventListener('click', () => {
        searchInput.value = '';
        statusSelect.value = 'all';
        searchQuery = '';
        statusFilter = 'all';
        renderCurrentSessions();
    });
}

function filterSessions(sessions) {
    return sessions.filter(s => {
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
        const project = session.cwd?.split('/').pop() || 'Unknown';
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
    return Object.values(groups).sort((a, b) =>
        b.activeCount - a.activeCount || a.name.localeCompare(b.name)
    );
}

function toggleGroup(projectName) {
    groupCollapsedState[projectName] = !groupCollapsedState[projectName];
    localStorage.setItem('groupCollapsedState', JSON.stringify(groupCollapsedState));
    renderCurrentSessions();
}

function renderGroups(groups) {
    const container = document.getElementById('sessions-container');
    container.innerHTML = '';
    let cardIndex = 0;
    groups.forEach(group => {
        const groupDiv = document.createElement('div');
        groupDiv.className = `session-group ${group.collapsed ? 'collapsed' : ''}`;
        const header = document.createElement('div');
        header.className = 'group-header';
        header.onclick = () => toggleGroup(group.name);
        header.innerHTML = `
            <span class="collapse-icon">${group.collapsed ? '▶' : '▼'}</span>
            <span class="group-name">${escapeHtml(group.name)}</span>
            <span class="group-stats">
                ${group.sessions.length} session${group.sessions.length !== 1 ? 's' : ''}
                ${group.activeCount > 0 ? `(${group.activeCount} active)` : ''}
            </span>
        `;
        groupDiv.appendChild(header);
        const sessionsDiv = document.createElement('div');
        sessionsDiv.className = 'group-sessions';
        group.sessions.forEach(session => {
            const card = createCard(session, cardIndex++);
            sessionsDiv.appendChild(card);
        });
        groupDiv.appendChild(sessionsDiv);
        container.appendChild(groupDiv);
    });
    allVisibleSessions = groups.flatMap(g => g.sessions);
}

function renderCurrentSessions(sessions = null) {
    if (!sessions) {
        sessions = Array.from(previousSessions.values());
    }
    const filtered = filterSessions(sessions);
    const totalCount = sessions.length;
    const filteredCount = filtered.length;
    if (filteredCount !== totalCount) {
        document.getElementById('session-count').textContent = `${filteredCount} of ${totalCount} sessions`;
    }
    const container = document.getElementById('sessions-container');
    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h2>${totalCount === 0 ? 'No Claude sessions' : 'No matching sessions'}</h2>
                <p>${totalCount === 0 ? 'Start a Claude Code session to see it here' : 'Try adjusting your filters'}</p>
            </div>`;
        allVisibleSessions = [];
        return;
    }
    const groups = groupSessionsByProject(filtered);
    renderGroups(groups);
    if (selectedIndex >= allVisibleSessions.length) {
        clearSelection();
    }
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

// Initialize all features
document.addEventListener('DOMContentLoaded', () => {
    initializeFilters();
    initializeNotifications();
    initializeKeyboardShortcuts();
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

    // Generate time axis
    const timeAxisHtml = generateTimeAxis(startTime, now, hoursBack);

    // Generate timeline rows
    const rowsHtml = sessions.map(session => {
        const periods = timelineData.get(session.sessionId) || [];
        return renderTimelineRow(session, periods, startTime, now);
    }).join('');

    container.innerHTML = `
        <div class="timeline-axis">${timeAxisHtml}</div>
        <div class="timeline-rows">${rowsHtml}</div>
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
    const barsHtml = periods.map(period => {
        const periodStart = new Date(period.start).getTime();
        const periodEnd = new Date(period.end).getTime();

        // Skip periods outside our time range
        if (periodEnd < startTime || periodStart > endTime) return '';

        // Clamp to visible range
        const visibleStart = Math.max(periodStart, startTime);
        const visibleEnd = Math.min(periodEnd, endTime);

        const left = ((visibleStart - startTime) / duration) * 100;
        const width = ((visibleEnd - visibleStart) / duration) * 100;

        return `<div class="timeline-bar ${period.state}"
                     style="left: ${left}%; width: ${Math.max(width, 0.5)}%"
                     title="${formatPeriodTooltip(period)}"></div>`;
    }).join('');

    return `
        <div class="timeline-row ${isZombie ? 'zombie' : ''}" data-session-id="${session.sessionId}">
            <div class="timeline-label" onclick="focusWarpTab(previousSessions.get('${session.sessionId}'))">
                <span class="session-slug">${escapeHtml(session.slug)}</span>
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

function formatPeriodTooltip(period) {
    const start = new Date(period.start);
    const end = new Date(period.end);
    const startStr = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const endStr = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${period.state}: ${startStr} - ${endStr}`;
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

    // Track compare view state
    compareViewActive = (viewName === 'compare');

    // Refresh timeline when switching to it
    if (viewName === 'timeline') {
        refreshTimeline();
    }

    // Render compare view when switching to it
    if (viewName === 'compare') {
        renderCompareView();
    }

    // Load analytics if switching to analytics view
    if (viewName === 'analytics' && typeof loadAnalytics === 'function') {
        loadAnalytics();
    }
}

// ============================================================================
// Feature 08: Session Comparison Implementation
// ============================================================================

function getSessionById(sessionId) {
    return previousSessions.get(sessionId) || null;
}

function selectForComparison(sessionId, slot) {
    const session = getSessionById(sessionId);
    comparedSessions[slot] = session;

    // Save to localStorage for persistence
    const savedComparison = comparedSessions.map(s => s?.sessionId || null);
    localStorage.setItem('comparedSessions', JSON.stringify(savedComparison));

    renderCompareView();
}

function clearComparison(slot) {
    comparedSessions[slot] = null;
    const savedComparison = comparedSessions.map(s => s?.sessionId || null);
    localStorage.setItem('comparedSessions', JSON.stringify(savedComparison));
    renderCompareView();
}

function swapComparison() {
    comparedSessions = [comparedSessions[1], comparedSessions[0]];
    const savedComparison = comparedSessions.map(s => s?.sessionId || null);
    localStorage.setItem('comparedSessions', JSON.stringify(savedComparison));
    renderCompareView();
}

function loadSavedComparison() {
    try {
        const saved = localStorage.getItem('comparedSessions');
        if (saved) {
            const sessionIds = JSON.parse(saved);
            comparedSessions = sessionIds.map(id => id ? getSessionById(id) : null);
        }
    } catch (e) {
        console.warn('Failed to load saved comparison:', e);
    }
}

function renderCompareView() {
    const container = document.getElementById('compare-container');
    if (!container) return;

    const allSessions = Array.from(previousSessions.values());

    // Restore saved comparison if sessions exist
    if (comparedSessions[0] === null && comparedSessions[1] === null) {
        loadSavedComparison();
    }

    // Update session data if sessions are still running
    comparedSessions = comparedSessions.map(s => {
        if (s && previousSessions.has(s.sessionId)) {
            return previousSessions.get(s.sessionId);
        }
        return s;
    });

    container.innerHTML = `
        <div class="comparison-panels">
            ${renderComparisonPanel(comparedSessions[0], 0, allSessions)}
            <div class="comparison-divider">
                <button class="swap-btn" onclick="swapComparison()" title="Swap sessions">
                    ⇄
                </button>
            </div>
            ${renderComparisonPanel(comparedSessions[1], 1, allSessions)}
        </div>
    `;
}

function renderComparisonPanel(session, slot, allSessions) {
    const otherSlot = slot === 0 ? 1 : 0;
    const otherSessionId = comparedSessions[otherSlot]?.sessionId;

    // Filter out the session in the other slot from options
    const availableSessions = allSessions.filter(s => s.sessionId !== otherSessionId);

    if (!session) {
        return `
            <div class="comparison-panel empty">
                <div class="empty-panel-content">
                    <span class="empty-icon">📊</span>
                    <p>Select a session to compare</p>
                    <select class="session-select" onchange="selectForComparison(this.value, ${slot})">
                        <option value="">Choose session...</option>
                        ${availableSessions.map(s => `
                            <option value="${s.sessionId}">${escapeHtml(s.slug)}</option>
                        `).join('')}
                    </select>
                </div>
            </div>
        `;
    }

    const activityHtml = (session.recentActivity || []).slice(0, 10).map(a =>
        `<li>${escapeHtml(a)}</li>`
    ).join('') || '<li class="no-activity">No recent activity</li>';

    const tokenPercentage = session.contextTokens
        ? Math.min(100, (session.contextTokens / MAX_CONTEXT_TOKENS) * 100)
        : 0;

    let tokenColorClass = 'token-green';
    if (tokenPercentage > 80) tokenColorClass = 'token-red';
    else if (tokenPercentage > 50) tokenColorClass = 'token-yellow';

    return `
        <div class="comparison-panel">
            <div class="panel-header">
                <span class="status-badge ${session.state}">
                    <span class="status-indicator"></span>
                    ${session.state}
                </span>
                <div class="panel-actions">
                    <select class="session-select small" onchange="selectForComparison(this.value, ${slot})">
                        <option value="${session.sessionId}">${escapeHtml(session.slug)}</option>
                        ${availableSessions.filter(s => s.sessionId !== session.sessionId).map(s => `
                            <option value="${s.sessionId}">${escapeHtml(s.slug)}</option>
                        `).join('')}
                    </select>
                    <button class="clear-btn" onclick="clearComparison(${slot})" title="Clear selection">×</button>
                </div>
            </div>

            <h3 class="panel-slug" onclick="focusWarpTab(previousSessions.get('${session.sessionId}'))">${escapeHtml(session.slug)}</h3>
            <p class="panel-cwd">${escapeHtml(session.cwd || 'Unknown')}</p>

            <div class="panel-tokens">
                <div class="token-usage-compare" title="${(session.contextTokens || 0).toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()} tokens">
                    <span class="token-label">Context:</span>
                    <div class="token-bar-container">
                        <div class="token-bar ${tokenColorClass}" style="width: ${tokenPercentage}%"></div>
                    </div>
                    <span class="token-value">${formatTokens(session.contextTokens)}</span>
                </div>
            </div>

            <div class="panel-section">
                <h4>Recent Activity</h4>
                <ul class="activity-list">
                    ${activityHtml}
                </ul>
            </div>

            <div class="panel-section">
                <h4>Metrics</h4>
                <dl class="metrics-list">
                    <dt>PID</dt><dd>${session.pid || '--'}</dd>
                    <dt>CPU</dt><dd>${formatCpu(session.cpuPercent)}%</dd>
                    <dt>Tokens</dt><dd>${(session.contextTokens || 0).toLocaleString()}</dd>
                    <dt>Last Active</dt><dd>${formatTime(session.lastActivity)}</dd>
                </dl>
            </div>

            <div class="panel-actions-footer">
                <button class="action-btn" onclick="focusWarpTab(previousSessions.get('${session.sessionId}'))">
                    🖥️ Focus Terminal
                </button>
                <button class="action-btn" onclick="showMetricsModal('${session.sessionId}')">
                    📊 Full Metrics
                </button>
            </div>
        </div>
    `;
}

function toggleAnalytics() {
    const currentView = document.querySelector('.tab-button.active')?.dataset.view;
    if (currentView === 'analytics') {
        switchView('sessions');
    } else {
        switchView('analytics');
    }
}

fetchSessions();
setInterval(fetchSessions, POLL_INTERVAL);

// Auto-refresh timeline when on that view
setInterval(() => {
    if (timelineViewActive) {
        refreshTimeline();
    }
}, 30000); // Refresh every 30 seconds when viewing timeline

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

console.log('Claude Session Visualizer loaded - All features active');

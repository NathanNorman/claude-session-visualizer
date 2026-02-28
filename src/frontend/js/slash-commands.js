// ============================================================================
// Slash Command System for SDK Sessions
// ============================================================================

/**
 * Built-in slash commands available in SDK sessions
 */
const BUILTIN_COMMANDS = {
    help: {
        description: 'Show available commands',
        handler: showCommandHelp
    },
    clear: {
        description: 'Clear the terminal output',
        handler: clearTerminal
    },
    stop: {
        description: 'Stop the current operation',
        handler: stopCurrentOperation
    },
    history: {
        description: 'Show command history',
        handler: showCommandHistory
    },
    skills: {
        description: 'List available skills or invoke one',
        handler: handleSkillsCommand
    },
    skill: {
        description: 'Invoke a skill (e.g., /skill commit)',
        handler: handleSkillsCommand
    },
    sessions: {
        description: 'Show saved sessions you can resume',
        handler: showSavedSessions
    }
};

/**
 * Command history for up-arrow recall
 */
let commandHistory = [];
let historyIndex = -1;

/**
 * Parse a slash command from input text
 * @param {string} text - Input text to parse
 * @returns {object|null} - Parsed command {name, args} or null if not a command
 */
function parseSlashCommand(text) {
    if (!text.startsWith('/')) return null;

    const parts = text.slice(1).split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    return { name, args, raw: text };
}

/**
 * Handle a slash command
 * @param {string} processId - The process ID
 * @param {object} command - Parsed command {name, args}
 * @returns {boolean} - True if command was handled locally, false if should be sent to Claude
 */
async function handleSlashCommand(processId, command) {
    const { name, args } = command;

    // Check for built-in commands first
    if (BUILTIN_COMMANDS[name]) {
        await BUILTIN_COMMANDS[name].handler(processId, args);
        return true;
    }

    // Not a built-in command - could be a skill or should be sent to Claude
    // For now, return false to let it go to Claude with the slash prefix
    return false;
}

/**
 * Autocomplete state
 */
let autocompleteSelectedIndex = -1;

/**
 * Handle slash command autocomplete
 * Shows dropdown when user types / followed by characters
 */
async function handleSlashAutocomplete(inputEl) {
    const text = inputEl.innerText || '';
    const autocomplete = document.getElementById('mc-autocomplete');

    if (!autocomplete) return;

    // Only show autocomplete if text starts with / and has no spaces yet
    if (!text.startsWith('/') || text.includes(' ') || text.length > 20) {
        hideAutocomplete();
        return;
    }

    // Get the partial command (everything after /)
    const partial = text.slice(1).toLowerCase();

    // Filter matching commands (async)
    const matches = await getMatchingCommands(partial);

    if (matches.length === 0) {
        hideAutocomplete();
        return;
    }

    // Render autocomplete dropdown
    renderAutocomplete(matches, partial);
}

/**
 * Get commands matching the partial input
 */
async function getMatchingCommands(partial) {
    const results = [];

    // Built-in commands
    for (const [name, cmd] of Object.entries(BUILTIN_COMMANDS)) {
        if (name.startsWith(partial) || partial === '') {
            results.push({
                name: `/${name}`,
                description: cmd.description,
                type: 'builtin'
            });
        }
    }

    // Fetch skills from API (uses cache)
    const skills = await fetchSkills();

    for (const skill of skills) {
        const skillName = skill.name.toLowerCase();
        if ((skillName.startsWith(partial) || partial === '') && !BUILTIN_COMMANDS[skillName]) {
            results.push({
                name: `/${skill.name}`,
                description: skill.description,
                type: 'skill',
                source: skill.source
            });
        }
    }

    return results;
}

/**
 * Render autocomplete dropdown
 */
function renderAutocomplete(matches, partial) {
    const autocomplete = document.getElementById('mc-autocomplete');
    if (!autocomplete) return;

    // Group by type
    const builtins = matches.filter(m => m.type === 'builtin');
    const skills = matches.filter(m => m.type === 'skill');

    let html = '';

    if (builtins.length > 0) {
        html += '<div class="mc-autocomplete-header">Built-in Commands</div>';
        builtins.forEach((match, i) => {
            const isSelected = i === 0 && autocompleteSelectedIndex === -1;
            html += `
                <div class="mc-autocomplete-item${isSelected ? ' selected' : ''}"
                     data-command="${escapeHtml(match.name)}"
                     onclick="selectAutocompleteItem(this)">
                    <span class="mc-autocomplete-cmd">${highlightMatch(match.name, partial)}</span>
                    <span class="mc-autocomplete-desc">${escapeHtml(match.description)}</span>
                </div>
            `;
        });
    }

    if (skills.length > 0) {
        html += '<div class="mc-autocomplete-header">Skills</div>';
        skills.forEach((match) => {
            html += `
                <div class="mc-autocomplete-item"
                     data-command="${escapeHtml(match.name)}"
                     onclick="selectAutocompleteItem(this)">
                    <span class="mc-autocomplete-cmd">${highlightMatch(match.name, partial)}</span>
                    <span class="mc-autocomplete-desc">${escapeHtml(match.description)}</span>
                </div>
            `;
        });
    }

    autocomplete.innerHTML = html;
    autocomplete.classList.remove('hidden');

    // Select first item by default
    if (autocompleteSelectedIndex === -1) {
        const firstItem = autocomplete.querySelector('.mc-autocomplete-item');
        if (firstItem) {
            firstItem.classList.add('selected');
            autocompleteSelectedIndex = 0;
        }
    }
}

/**
 * Highlight matching portion of command
 */
function highlightMatch(text, partial) {
    if (!partial) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(partial.toLowerCase());
    if (idx === -1) return escapeHtml(text);

    const before = text.slice(0, idx);
    const match = text.slice(idx, idx + partial.length);
    const after = text.slice(idx + partial.length);

    return `${escapeHtml(before)}<strong>${escapeHtml(match)}</strong>${escapeHtml(after)}`;
}

/**
 * Navigate autocomplete with arrow keys
 */
function navigateAutocomplete(direction) {
    const autocomplete = document.getElementById('mc-autocomplete');
    if (!autocomplete) return;

    const items = autocomplete.querySelectorAll('.mc-autocomplete-item');
    if (items.length === 0) return;

    // Remove current selection
    items.forEach(item => item.classList.remove('selected'));

    // Calculate new index
    autocompleteSelectedIndex += direction;
    if (autocompleteSelectedIndex < 0) {
        autocompleteSelectedIndex = items.length - 1;
    } else if (autocompleteSelectedIndex >= items.length) {
        autocompleteSelectedIndex = 0;
    }

    // Select new item
    items[autocompleteSelectedIndex].classList.add('selected');

    // Scroll into view if needed
    items[autocompleteSelectedIndex].scrollIntoView({ block: 'nearest' });
}

/**
 * Select an autocomplete item
 */
function selectAutocompleteItem(item) {
    const command = item.dataset.command;
    const inputEl = document.getElementById('mc-input');

    if (inputEl && command) {
        // Set the command text with a trailing space
        inputEl.innerText = command + ' ';

        // Move cursor to end
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);

        // Focus the input
        inputEl.focus();
    }

    hideAutocomplete();
}

/**
 * Hide autocomplete dropdown
 */
function hideAutocomplete() {
    const autocomplete = document.getElementById('mc-autocomplete');
    if (autocomplete) {
        autocomplete.classList.add('hidden');
        autocomplete.innerHTML = '';
    }
    autocompleteSelectedIndex = -1;
}

/**
 * Default skills data (fallback if API unavailable)
 */
const DEFAULT_SKILLS = [
    { name: 'commit', description: 'Create a git commit with AI-generated message', category: 'Git', source: 'default' },
    { name: 'pr', description: 'Create or manage pull requests', category: 'Git', source: 'default' },
    { name: 'review', description: 'Review code changes for issues and improvements', category: 'Code', source: 'default' },
    { name: 'debug', description: 'Start systematic debugging process', category: 'Code', source: 'default' },
    { name: 'test', description: 'Run tests or generate test cases', category: 'Code', source: 'default' },
    { name: 'refactor', description: 'Refactor selected code for better quality', category: 'Code', source: 'default' },
    { name: 'explain', description: 'Explain code, concepts, or errors', category: 'Learning', source: 'default' },
    { name: 'docs', description: 'Generate or update documentation', category: 'Docs', source: 'default' },
    { name: 'init', description: 'Initialize project configuration', category: 'Setup', source: 'default' },
    { name: 'migrate', description: 'Help with code migrations and upgrades', category: 'Code', source: 'default' },
    { name: 'optimize', description: 'Optimize code for performance', category: 'Code', source: 'default' },
    { name: 'security', description: 'Scan for security vulnerabilities', category: 'Code', source: 'default' },
    { name: 'api', description: 'Generate or consume API endpoints', category: 'Code', source: 'default' },
    { name: 'db', description: 'Database queries and schema management', category: 'Data', source: 'default' },
    { name: 'deploy', description: 'Deployment and CI/CD assistance', category: 'DevOps', source: 'default' }
];

/**
 * Cached skills data from API
 */
let cachedSkills = null;
let skillsCacheTimestamp = 0;
const SKILLS_CACHE_TTL = 30000; // 30 seconds

/**
 * Fetch skills from the API and merge with defaults
 * @returns {Promise<Array>} Array of skill objects
 */
async function fetchSkills() {
    const now = Date.now();

    // Return cached data if still valid
    if (cachedSkills && (now - skillsCacheTimestamp) < SKILLS_CACHE_TTL) {
        return cachedSkills;
    }

    try {
        const response = await fetch('/api/skills');
        if (!response.ok) {
            console.warn('Failed to fetch skills from API, using defaults');
            return DEFAULT_SKILLS;
        }

        const data = await response.json();
        const customSkills = data.skills || [];

        // Create a set of custom skill names to avoid duplicates
        const customNames = new Set(customSkills.map(s => s.name.toLowerCase()));

        // Merge: custom skills first, then defaults that aren't overridden
        const merged = [
            ...customSkills,
            ...DEFAULT_SKILLS.filter(s => !customNames.has(s.name.toLowerCase()))
        ];

        // Sort by category then name
        merged.sort((a, b) => {
            if (a.category !== b.category) return a.category.localeCompare(b.category);
            return a.name.localeCompare(b.name);
        });

        cachedSkills = merged;
        skillsCacheTimestamp = now;

        return merged;
    } catch (error) {
        console.warn('Error fetching skills:', error);
        return DEFAULT_SKILLS;
    }
}

/**
 * Invalidate skills cache (call when skills might have changed)
 */
function invalidateSkillsCache() {
    cachedSkills = null;
    skillsCacheTimestamp = 0;
}

/**
 * Toggle unified slash picker visibility
 */
function toggleSlashPicker() {
    const picker = document.getElementById('mc-slash-picker');
    const btn = document.getElementById('mc-slash-btn');

    if (picker.classList.contains('hidden')) {
        showSlashPicker();
        btn.classList.add('active');
    } else {
        hideSlashPicker();
    }
}

/**
 * Show unified slash picker
 */
async function showSlashPicker() {
    const picker = document.getElementById('mc-slash-picker');
    const list = document.getElementById('mc-slash-list');
    const searchInput = document.getElementById('mc-slash-search');

    if (!picker || !list) return;

    // Show loading state
    list.innerHTML = '<div class="mc-picker-empty">Loading...</div>';
    picker.classList.remove('hidden');

    // Fetch and render unified list
    const skills = await fetchSkills();
    renderSlashList(list, '', skills);

    // Focus search input
    if (searchInput) {
        searchInput.value = '';
        setTimeout(() => searchInput.focus(), 50);
    }
}

/**
 * Hide unified slash picker
 */
function hideSlashPicker() {
    const picker = document.getElementById('mc-slash-picker');
    const btn = document.getElementById('mc-slash-btn');

    if (picker) picker.classList.add('hidden');
    if (btn) btn.classList.remove('active');
}

/**
 * Filter unified slash picker
 */
async function filterSlashPicker(query) {
    const list = document.getElementById('mc-slash-list');
    if (list) {
        const skills = await fetchSkills();
        renderSlashList(list, query.toLowerCase(), skills);
    }
}

/**
 * Render unified slash list with built-in commands at top, then skills grouped by source
 * @param {HTMLElement} container - Container element
 * @param {string} filter - Filter query
 * @param {Array} skills - Array of skill objects
 */
function renderSlashList(container, filter, skills = DEFAULT_SKILLS) {
    // Get built-in commands
    const builtinCommands = Object.entries(BUILTIN_COMMANDS)
        .filter(([name, cmd]) => !filter || name.includes(filter) || cmd.description.toLowerCase().includes(filter))
        .map(([name, cmd]) => ({
            name,
            description: cmd.description,
            type: 'builtin'
        }));

    // Filter skills
    const filteredSkills = skills.filter(skill =>
        !filter || skill.name.toLowerCase().includes(filter) || skill.description.toLowerCase().includes(filter)
    );

    if (builtinCommands.length === 0 && filteredSkills.length === 0) {
        container.innerHTML = '<div class="mc-picker-empty">No commands or skills found</div>';
        return;
    }

    let html = '';

    // Built-in commands section
    if (builtinCommands.length > 0) {
        html += '<div class="mc-picker-category">Built-in Commands</div>';
        html += builtinCommands.map(cmd => `
            <div class="mc-picker-item" onclick="selectSlashItem('/${escapeHtml(cmd.name)}')">
                <div class="mc-picker-item-icon command">/</div>
                <div class="mc-picker-item-content">
                    <div class="mc-picker-item-name">/${escapeHtml(cmd.name)}</div>
                    <div class="mc-picker-item-desc">${escapeHtml(cmd.description)}</div>
                </div>
            </div>
        `).join('');
    }

    // Group skills by source (personal, project, default)
    if (filteredSkills.length > 0) {
        const personalSkills = filteredSkills.filter(s => s.source === 'personal');
        const projectSkills = filteredSkills.filter(s => s.source && s.source.startsWith('project:'));
        const defaultSkills = filteredSkills.filter(s => s.source === 'default' || !s.source);

        // Helper to render a skill item
        const renderSkillItem = (skill) => `
            <div class="mc-picker-item"
                 onclick="selectSlashItem('/${escapeHtml(skill.name)}')"
                 onmouseenter="showSkillPreview('${escapeHtml(skill.name)}', this)"
                 onmouseleave="hideSkillPreview()">
                <div class="mc-picker-item-icon skill">${icon('zap', {size:14})}</div>
                <div class="mc-picker-item-content">
                    <div class="mc-picker-item-name">/${escapeHtml(skill.name)}</div>
                    <div class="mc-picker-item-desc">${escapeHtml(skill.description || '')}</div>
                </div>
            </div>
        `;

        // Personal skills (from ~/.claude/skills)
        if (personalSkills.length > 0) {
            html += `<div class="mc-picker-category">Personal Skills <span class="mc-picker-category-count">${personalSkills.length}</span></div>`;
            html += personalSkills.sort((a, b) => a.name.localeCompare(b.name)).map(renderSkillItem).join('');
        }

        // Project skills
        if (projectSkills.length > 0) {
            html += `<div class="mc-picker-category">Project Skills <span class="mc-picker-category-count">${projectSkills.length}</span></div>`;
            html += projectSkills.sort((a, b) => a.name.localeCompare(b.name)).map(renderSkillItem).join('');
        }

        // Default/suggested skills
        if (defaultSkills.length > 0) {
            html += `<div class="mc-picker-category">Common Skills <span class="mc-picker-category-count">${defaultSkills.length}</span></div>`;
            html += defaultSkills.sort((a, b) => a.name.localeCompare(b.name)).map(renderSkillItem).join('');
        }
    }

    container.innerHTML = html;
}

/**
 * Get a human-readable label for skill source
 */
function getSourceLabel(source) {
    if (!source || source === 'default') return '';
    if (source === 'personal') return 'personal';
    if (source.startsWith('project:')) return source.replace('project:', '');
    return source;
}

/**
 * Select an item from the unified slash picker
 */
function selectSlashItem(command) {
    insertCommandIntoInput(command);
    hideSlashPicker();
}

/**
 * Skill preview popup state
 */
let skillPreviewTimeout = null;
let skillPreviewCache = {};

/**
 * Show skill preview popup on hover
 */
async function showSkillPreview(skillName, element) {
    // Clear any pending hide timeout
    if (skillPreviewTimeout) {
        clearTimeout(skillPreviewTimeout);
        skillPreviewTimeout = null;
    }

    // Delay showing preview to avoid flicker
    skillPreviewTimeout = setTimeout(async () => {
        let popup = document.getElementById('skill-preview-popup');

        // Create popup if it doesn't exist
        if (!popup) {
            popup = document.createElement('div');
            popup.id = 'skill-preview-popup';
            popup.className = 'skill-preview-popup';
            document.body.appendChild(popup);
        }

        // Show loading state
        popup.innerHTML = '<div class="skill-preview-loading">Loading...</div>';
        popup.classList.add('visible');

        // Position popup to the right of the picker
        const picker = document.getElementById('mc-slash-picker');
        if (picker) {
            const pickerRect = picker.getBoundingClientRect();
            popup.style.left = `${pickerRect.right + 10}px`;
            popup.style.bottom = `${window.innerHeight - pickerRect.bottom}px`;
        }

        // Fetch skill details (use cache if available)
        let skillData = skillPreviewCache[skillName];
        if (!skillData) {
            try {
                const response = await fetch(`/api/skills/${encodeURIComponent(skillName)}`);
                if (response.ok) {
                    skillData = await response.json();
                    skillPreviewCache[skillName] = skillData;
                }
            } catch (error) {
                console.warn('Error fetching skill details:', error);
            }
        }

        if (skillData && !skillData.error) {
            // Render skill content
            const content = skillData.content || '';
            const truncatedContent = content.length > 2000 ? content.slice(0, 2000) + '\n\n... (truncated)' : content;

            popup.innerHTML = `
                <div class="skill-preview-header">
                    <span class="skill-preview-name">/${escapeHtml(skillData.name)}</span>
                    <span class="skill-preview-source">${escapeHtml(skillData.source || '')}</span>
                </div>
                <div class="skill-preview-desc">${escapeHtml(skillData.description || '')}</div>
                <div class="skill-preview-content">${escapeHtml(truncatedContent)}</div>
            `;
        } else {
            popup.innerHTML = '<div class="skill-preview-error">Could not load skill details</div>';
        }
    }, 300);
}

/**
 * Hide skill preview popup
 */
function hideSkillPreview() {
    if (skillPreviewTimeout) {
        clearTimeout(skillPreviewTimeout);
        skillPreviewTimeout = null;
    }

    // Delay hiding to allow moving to popup
    skillPreviewTimeout = setTimeout(() => {
        const popup = document.getElementById('skill-preview-popup');
        if (popup) {
            popup.classList.remove('visible');
        }
    }, 200);
}

/**
 * Insert command into input field
 */
function insertCommandIntoInput(command) {
    const inputEl = document.getElementById('mc-input');
    if (!inputEl) return;

    // Set the command with trailing space
    inputEl.innerText = command + ' ';

    // Move cursor to end
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(inputEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    // Focus the input
    inputEl.focus();
}

/**
 * Current permission mode state
 */
let currentPermissionMode = 'normal';

/**
 * Update context usage indicator
 * @param {number} usedTokens - Tokens used in current conversation
 * @param {number} maxTokens - Maximum tokens in context window
 */
function updateContextIndicator(usedTokens, maxTokens = 200000) {
    const fill = document.getElementById('mc-context-fill');
    const label = document.getElementById('mc-context-label');
    const tokensEl = document.getElementById('mc-context-tokens');
    const indicator = document.querySelector('.mc-context-indicator');

    if (!fill || !label || !indicator) return;

    const percentage = Math.min(100, Math.round((usedTokens / maxTokens) * 100));

    fill.style.width = `${percentage}%`;
    label.textContent = `${percentage}%`;

    // Update token count display
    if (tokensEl) {
        tokensEl.textContent = formatTokenCount(usedTokens);
    }

    // Update warning/danger states
    indicator.classList.remove('warning', 'danger');
    if (percentage >= 90) {
        indicator.classList.add('danger');
    } else if (percentage >= 70) {
        indicator.classList.add('warning');
    }
}

/**
 * Set permission mode for SDK session
 */
function setPermissionMode(mode) {
    currentPermissionMode = mode;
    console.log('[MC] Permission mode set to:', mode);

    // Update backend if we have a selected managed SDK process
    if (selectedProcessId) {
        fetch(`/api/process/${selectedProcessId}/permission-mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        }).then(res => {
            if (res.ok) {
                showToast(`Mode changed to: ${getModeDisplayName(mode)}`);
            } else {
                console.error('[MC] Failed to set permission mode');
                showToast('Failed to change mode', 'error');
            }
        }).catch(err => {
            console.error('[MC] Error setting permission mode:', err);
            showToast('Failed to change mode', 'error');
        });
    } else if (mcSelectedSessionId) {
        // Detected session - can't control permission mode
        showToast('Permission mode only works for managed SDK sessions', 'warning');
    } else {
        showToast(`Mode: ${getModeDisplayName(mode)} (for next spawned session)`);
    }
}

/**
 * Get display name for permission mode
 */
function getModeDisplayName(mode) {
    const names = {
        'normal': 'Normal',
        'acceptEdits': 'Accept Edits',
        'bypassPermissions': 'Bypass Permissions',
        'planMode': 'Plan Mode'
    };
    return names[mode] || mode;
}

/**
 * Toggle compact input visibility
 */
function toggleCompactInput() {
    const input = document.getElementById('mc-compact-input');
    const btn = document.getElementById('mc-compact-btn');
    const instructionsInput = document.getElementById('mc-compact-instructions');

    if (!input || !btn) return;

    if (input.classList.contains('hidden')) {
        input.classList.remove('hidden');
        btn.classList.add('active');
        if (instructionsInput) {
            instructionsInput.value = '';
            setTimeout(() => instructionsInput.focus(), 50);
        }
    } else {
        hideCompactInput();
    }
}

/**
 * Hide compact input
 */
function hideCompactInput() {
    const input = document.getElementById('mc-compact-input');
    const btn = document.getElementById('mc-compact-btn');

    if (input) input.classList.add('hidden');
    if (btn) btn.classList.remove('active');
}

/**
 * Execute compact command
 */
async function executeCompact() {
    const instructionsInput = document.getElementById('mc-compact-instructions');
    const instructions = instructionsInput ? instructionsInput.value.trim() : '';

    if (!selectedProcessId) {
        showToast('No session selected');
        hideCompactInput();
        return;
    }

    showToast('Compacting conversation...');
    hideCompactInput();

    try {
        const response = await fetch(`/api/process/${selectedProcessId}/compact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructions })
        });

        if (response.ok) {
            const result = await response.json();
            showToast(`Compacted: ${result.tokens_saved || 0} tokens saved`);
            // Update context indicator if we get new stats
            if (result.new_usage) {
                updateContextIndicator(result.new_usage.total_tokens);
            }
        } else {
            showToast('Compact failed');
        }
    } catch (err) {
        console.error('[MC] Compact error:', err);
        showToast('Compact error');
    }
}

/**
 * Show help for available commands
 */
function showCommandHelp(processId) {
    const helpLines = [
        '<div class="sdk-system-message">',
        `<div class="sdk-system-header">${icon('clipboard-list', {size:14})} Available Commands</div>`,
        '<div class="sdk-help-content">',
        '<table class="sdk-help-table">',
        '<tr><th>Command</th><th>Description</th></tr>'
    ];

    for (const [name, cmd] of Object.entries(BUILTIN_COMMANDS)) {
        helpLines.push(`<tr><td><code>/${name}</code></td><td>${cmd.description}</td></tr>`);
    }

    helpLines.push(
        '</table>',
        '<div class="sdk-help-note">',
        '<strong>Tip:</strong> You can also use skill commands like <code>/commit</code>, <code>/debug</code>, etc.',
        '</div>',
        '</div>',
        '</div>'
    );

    const html = helpLines.join('\n');

    // Add to process buffer and display
    const process = managedProcesses.get(processId);
    if (process) {
        process.outputBuffer = (process.outputBuffer || '') + html;
    }
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }
}

/**
 * Clear the terminal output
 */
function clearTerminal(processId) {
    const process = managedProcesses.get(processId);
    if (process) {
        // Keep the welcome banner if present
        const bannerMatch = process.outputBuffer?.match(/<div class="sdk-welcome-banner">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
        process.outputBuffer = bannerMatch ? bannerMatch[0] : '';
    }

    if (selectedProcessId === processId) {
        const terminalEl = document.getElementById('mc-terminal-output');
        const contentEl = terminalEl?.querySelector('.mc-terminal-content');
        if (contentEl) {
            contentEl.innerHTML = process?.outputBuffer || '';
        }
    }

    showToast('Terminal cleared', 'info');
}

/**
 * Stop the current operation
 */
async function stopCurrentOperation(processId) {
    const process = managedProcesses.get(processId);
    if (!process) return;

    // For SDK sessions, we can try to send a cancel signal
    // For now, show a message - actual implementation depends on SDK support
    const html = `<div class="sdk-system-message"><span class="sdk-system-icon">${icon('circle-stop', {size: 14})}</span> Stop requested. If Claude is mid-response, the operation may complete.</div>`;

    if (process) {
        process.outputBuffer = (process.outputBuffer || '') + html;
    }
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }

    showToast('Stop signal sent', 'info');
}

/**
 * Show command history
 */
function showCommandHistory(processId) {
    if (commandHistory.length === 0) {
        const html = `<div class="sdk-system-message"><span class="sdk-system-icon">${icon('scroll', {size:14})}</span> No command history yet.</div>`;
        appendTerminalHtml(html);
        return;
    }

    const historyHtml = [
        '<div class="sdk-system-message">',
        `<div class="sdk-system-header">${icon('scroll', {size:14})} Command History</div>`,
        '<div class="sdk-history-list">'
    ];

    commandHistory.slice(-20).forEach((cmd, i) => {
        historyHtml.push(`<div class="sdk-history-item"><span class="sdk-history-num">${i + 1}.</span> ${escapeHtml(cmd)}</div>`);
    });

    historyHtml.push('</div></div>');

    const html = historyHtml.join('\n');
    const process = managedProcesses.get(processId);
    if (process) {
        process.outputBuffer = (process.outputBuffer || '') + html;
    }
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }
}

/**
 * Display a local system message in the terminal (not from Claude)
 */
function showLocalSystemMessage(processId, icon, message) {
    const html = `<div class="sdk-system-message"><span class="sdk-system-icon">${icon}</span> ${message}</div>`;

    const process = managedProcesses.get(processId);
    if (process) {
        process.outputBuffer = (process.outputBuffer || '') + html;
    }
    if (selectedProcessId === processId) {
        appendTerminalHtml(html);
    }
}

/**
 * Send input to a managed process.
 * Uses /message endpoint for SDK sessions, /stdin for PTY sessions.
 * Handles slash commands for SDK sessions.
 */
async function sendProcessInput() {
    if (!selectedProcessId) return;

    const inputEl = document.getElementById('mc-input');
    const statusEl = document.getElementById('mc-input-status');
    const text = inputEl?.innerText?.trim();

    if (!text) return;

    Logger.debug('mc', 'sendProcessInput:', { processId: selectedProcessId, text: text.substring(0, 50) });

    const process = managedProcesses.get(selectedProcessId);
    const isSDKSession = process?.isSDK || window.mcSDKMode;

    // Add to command history (for up-arrow recall)
    if (text && !commandHistory.includes(text)) {
        commandHistory.push(text);
        if (commandHistory.length > 100) commandHistory.shift(); // Limit history size
    }
    historyIndex = commandHistory.length; // Reset history navigation

    // Check for slash commands in SDK sessions
    if (isSDKSession) {
        const command = parseSlashCommand(text);
        if (command) {
            Logger.debug('mc', 'Detected slash command:', command);

            // Try to handle as built-in command
            const handled = await handleSlashCommand(selectedProcessId, command);

            if (handled) {
                // Built-in command was handled locally - clear input and return
                if (inputEl) inputEl.innerHTML = '';
                return;
            }

            // Not a built-in command - send to Claude as-is (it may be a skill invocation)
            // The SDK/Claude will handle skill commands like /commit, /debug, etc.
        }
    }

    try {
        let response;

        if (isSDKSession) {
            // SDK mode: use /message endpoint
            response = await fetch(`/api/process/${selectedProcessId}/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
        } else {
            // PTY mode: use /stdin endpoint
            response = await fetch(`/api/process/${selectedProcessId}/stdin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, newline: true })
            });
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Clear input on success
        if (inputEl) inputEl.innerHTML = '';
        if (statusEl) {
            statusEl.textContent = 'Sent!';
            setTimeout(() => { statusEl.textContent = ''; }, 1000);
        }

    } catch (error) {
        console.error('Failed to send process input:', error);
        if (statusEl) {
            statusEl.textContent = error.message;
            statusEl.className = 'error';
            setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
        }
    }
}

/**
 * Kill the currently selected managed process
 */
async function killSelectedProcess() {
    if (!selectedProcessId) return;

    const process = managedProcesses.get(selectedProcessId);
    if (!process) return;

    // If already stopped, just remove from tracking
    if (process.state === 'stopped') {
        cleanupProcess(selectedProcessId);
        return;
    }

    if (!confirm(`Stop process in ${process.cwd}?`)) return;

    try {
        const response = await fetch(`/api/process/${selectedProcessId}/kill`, {
            method: 'POST'
        });

        if (response.ok) {
            showToast('Process stopped', 'success');
        } else if (response.status === 404) {
            // Process already gone from server, clean up locally
            console.log(`[MC] Process ${selectedProcessId} not found on server, cleaning up locally`);
            showToast('Process already stopped', 'info');
        } else {
            const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
            throw new Error(error.detail || `HTTP ${response.status}`);
        }

        // Always clean up after kill attempt
        cleanupProcess(selectedProcessId);
        refreshManagedProcessList();

    } catch (error) {
        console.error('Failed to kill process:', error);
        showToast(`Failed to stop: ${error.message}`, 'error');
    }
}

/**
 * Clean up a process from local tracking
 */
function cleanupProcess(processId) {
    const process = managedProcesses.get(processId);
    if (process) {
        if (process.ws && process.ws.readyState === WebSocket.OPEN) {
            process.ws.close();
        }
        managedProcesses.delete(processId);
    }

    // If this was the selected process, deselect
    if (selectedProcessId === processId) {
        selectedProcessId = null;
        // Clear terminal
        const terminalEl = document.getElementById('mc-terminal-output');
        const contentEl = terminalEl?.querySelector('.mc-terminal-content');
        if (contentEl) contentEl.innerHTML = '';
    }

    // Re-render the session list
    if (typeof renderMissionControlSessions === 'function' && window.mcSessions) {
        renderMissionControlSessions(window.mcSessions);
    }
}

/**
 * Override sendMCMessage to handle both detected and managed sessions
 */
const originalSendMCMessage = sendMCMessage;
sendMCMessage = async function() {
    if (selectedProcessId) {
        // Send to managed process
        await sendProcessInput();
    } else if (mcSelectedSessionId) {
        // Send to detected session (original behavior)
        await originalSendMCMessage();
    }
};

/**
 * Override selectMissionControlSession to handle session type switching
 */
const originalSelectMissionControlSession = selectMissionControlSession;
selectMissionControlSession = function(sessionId) {
    // Deselect managed process
    selectedProcessId = null;

    // Update type badge to detected
    const typeEl = document.getElementById('mc-session-type');
    const titleEl = document.getElementById('mc-panel-title');
    const killBtn = document.getElementById('mc-kill-btn');

    if (typeEl) {
        typeEl.textContent = 'Detected';
        typeEl.className = 'mc-session-type-badge detected';
    }

    if (titleEl) {
        titleEl.textContent = 'Live Conversation';
    }

    if (killBtn) {
        killBtn.classList.add('hidden');
    }

    // Show conversation stream, hide terminal output
    const streamEl = document.getElementById('mc-conversation-stream');
    const terminalEl = document.getElementById('mc-terminal-output');

    if (streamEl) streamEl.classList.remove('hidden');
    if (terminalEl) terminalEl.classList.add('hidden');

    // Call original function
    originalSelectMissionControlSession(sessionId);
};

/**
 * Render managed processes in the session list (matches terminal session format)
 */
function renderManagedProcessesInList(container) {
    if (managedProcesses.size === 0) return '';

    let html = '<div class="mc-managed-section">';
    html += `<div class="mc-section-header">${icon('monitor', {size:14})}  Managed Sessions</div>`;

    for (const [id, process] of managedProcesses) {
        const dirName = process.cwd.split('/').pop() || process.cwd;
        const isSelected = selectedProcessId === id;
        const isActive = process.state === 'running' || process.state === 'waiting';

        // Calculate duration like terminal sessions
        let duration = '--';
        if (process.startedAt) {
            const startTime = new Date(process.startedAt).getTime();
            const elapsed = Date.now() - startTime;
            const minutes = Math.floor(elapsed / 60000);
            const hours = Math.floor(minutes / 60);
            if (hours > 0) {
                duration = `${hours}h ${minutes % 60}m`;
            } else {
                duration = `${minutes}m`;
            }
        }

        // Calculate token-based context % (similar to terminal sessions)
        // Assuming 200k context window
        const totalTokens = (process.inputTokens || 0) + (process.outputTokens || 0);
        const contextPct = Math.min(100, Math.round((totalTokens / 200000) * 100));

        // State indicator similar to terminal sessions
        const stateClass = isActive ? 'active' : '';

        html += `
            <div class="mc-session-item managed ${stateClass} ${isSelected ? 'selected' : ''}"
                 data-process-id="${escapeHtml(id)}"
                 onclick="selectManagedProcess('${escapeJsString(id)}')">
                <div class="mc-session-name">${escapeHtml(dirName)}<span class="managed-badge">SDK</span></div>
                <div class="mc-session-meta">
                    <span>${duration}</span>
                    <span>${contextPct}% ctx</span>
                </div>
            </div>
        `;
    }

    html += '</div>';
    return html;
}

// Patch renderMissionControlSessions to include managed processes
const originalRenderMissionControlSessions = renderMissionControlSessions;
renderMissionControlSessions = function(sessions) {
    // Call original to render detected sessions
    originalRenderMissionControlSessions(sessions);

    // Add managed processes section
    const container = document.getElementById('mc-sessions-list');
    if (container) {
        // Remove any existing managed sections first to prevent duplicates
        container.querySelectorAll('.mc-managed-section').forEach(el => el.remove());

        if (managedProcesses.size > 0) {
            // Insert managed processes at the top
            const managedHtml = renderManagedProcessesInList(container);
            container.insertAdjacentHTML('afterbegin', managedHtml);

            // Add click handlers for managed process items
            container.querySelectorAll('.mc-session-item[data-process-id]').forEach(el => {
                el.onclick = () => selectManagedProcess(el.dataset.processId);
            });
        }
    }

    // Update count to include managed processes
    const countEl = document.getElementById('mc-active-count');
    if (countEl) {
        const runningManaged = Array.from(managedProcesses.values()).filter(p => p.state === 'running').length;
        const total = sessions.length + runningManaged;
        countEl.textContent = total;
    }
};


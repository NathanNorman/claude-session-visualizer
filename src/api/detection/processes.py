"""Process detection and management for Claude sessions.

This module provides functions for:
- Detecting running Claude CLI processes
- Getting process metadata (cwd, start time, etc.)
- Caching process lists for performance
"""

import re
import subprocess
import time
from pathlib import Path

# Process list cache: (timestamp, processes_list)
_process_cache: tuple[float, list] | None = None
PROCESS_CACHE_TTL = 2  # Cache processes for 2 seconds


def get_process_cwd(pid: int) -> str | None:
    """Get the current working directory of a process using lsof."""
    try:
        result = subprocess.run(
            ['lsof', '-a', '-d', 'cwd', '-p', str(pid)],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.split('\n'):
            if str(pid) in line and '/' in line:
                # Last field is the path
                parts = line.split()
                if parts:
                    return parts[-1]
    except Exception:
        pass
    return None


def get_process_start_time(pid: int) -> float | None:
    """Get process start time as Unix timestamp."""
    try:
        # Get elapsed time in seconds
        result = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'etimes='],
            capture_output=True, text=True, timeout=5
        )
        elapsed = int(result.stdout.strip())
        return time.time() - elapsed
    except Exception:
        pass
    return None


def get_claude_processes() -> list[dict]:
    """Get all running claude CLI processes with metadata."""
    result = subprocess.run(["ps", "aux"], capture_output=True, text=True)
    processes = []

    for line in result.stdout.split('\n'):
        # Skip non-claude lines
        if 'claude' not in line.lower():
            continue
        # Skip non-CLI processes
        if any(skip in line for skip in ['/bin/zsh', 'grep', 'Claude.app', 'node_modules', 'chrome-', '@claude-flow']):
            continue

        parts = line.split()
        if len(parts) < 11:
            continue

        # Only consider processes where command is claude CLI
        cmd_start = parts[10]
        if not (cmd_start == 'claude' or cmd_start.endswith('/claude')):
            continue

        try:
            pid = int(parts[1])
            cpu = float(parts[2])
            tty = parts[6]
            state = parts[7]
            cmd = ' '.join(parts[10:])
        except (ValueError, IndexError):
            continue

        # Skip processes with no controlling terminal (orphaned after terminal close)
        # TTY of '?' or '??' indicates no controlling terminal
        if tty in ('?', '??'):
            continue

        # Skip zombie processes
        if state.startswith('Z'):
            continue

        # Verify TTY device still exists (terminal window not closed)
        # ps aux returns TTY like 's000', 's007' which maps to /dev/ttys000, /dev/ttys007
        if tty.startswith('s') and tty[1:].isdigit():
            tty_path = Path(f"/dev/tty{tty}")
            if not tty_path.exists():
                continue

        # Get actual working directory and start time of the process
        cwd = get_process_cwd(pid)

        # Detect gastown agent sessions (multi-agent orchestration)
        # Check command line markers
        is_gastown_cmd = (
            '[GAS TOWN]' in cmd or      # gastown prompt marker
            'gt boot' in cmd or          # gastown boot command
            'GT_ROLE=' in line           # gastown env var (tmux-spawned agents)
        )
        # Check cwd for gastown directory patterns
        is_gastown_cwd = cwd and any(pattern in cwd for pattern in [
            '/deacon',      # deacon service
            '/witness',     # witness monitor
            '/mayor',       # mayor orchestrator
            '/polecats/',   # polecat workers
            '/refinery/',   # rig refineries
            '/rig',         # rig directories
            '/gt/',         # general gastown directory
        ])
        is_gastown = is_gastown_cmd or is_gastown_cwd

        # Extract gastown role from command/env/cwd
        gastown_role = None
        if is_gastown:
            # Try GT_ROLE env var first (e.g., "GT_ROLE=mayor")
            role_match = re.search(r'GT_ROLE=(\w+)', line)
            if role_match:
                gastown_role = role_match.group(1)
            # Try [GAS TOWN] prompt format (e.g., "[GAS TOWN] mayor <- human")
            elif '[GAS TOWN]' in cmd:
                prompt_match = re.search(r'\[GAS TOWN\]\s+(\w+)', cmd)
                if prompt_match:
                    gastown_role = prompt_match.group(1)
            # Fallback: extract role from cwd path
            if not gastown_role and cwd:
                if cwd.endswith('/rig'):
                    gastown_role = 'rig'
                elif '/deacon' in cwd:
                    gastown_role = 'deacon'
                elif '/mayor' in cwd:
                    gastown_role = 'mayor'
                elif '/witness' in cwd:
                    gastown_role = 'witness'
                elif '/refinery' in cwd and '/rig' not in cwd:
                    gastown_role = 'refinery'
                elif '/polecats/' in cwd:
                    gastown_role = 'polecat'

        # Extract session ID from --resume flag if present
        session_id = None
        if '--resume' in cmd:
            match = re.search(r'--resume\s+([a-f0-9-]{36})', cmd)
            if match:
                session_id = match.group(1)

        # Get process start time (cwd already fetched above for gastown check)
        start_time = get_process_start_time(pid)

        processes.append({
            'pid': pid,
            'cpu': cpu,
            'tty': tty,
            'state': state,
            'cmd': cmd,
            'session_id': session_id,
            'cwd': cwd,
            'start_time': start_time,
            'is_gastown': is_gastown,
            'gastown_role': gastown_role,
        })

    return processes


def get_claude_processes_cached() -> list[dict]:
    """Get claude processes with caching to avoid frequent subprocess calls.

    Caches process list for PROCESS_CACHE_TTL seconds.
    """
    global _process_cache
    now = time.time()

    if _process_cache and (now - _process_cache[0]) < PROCESS_CACHE_TTL:
        return _process_cache[1]

    processes = get_claude_processes()
    _process_cache = (now, processes)
    return processes

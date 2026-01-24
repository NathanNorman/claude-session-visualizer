"""Git operations for tracking session changes."""

import subprocess
import json
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional


@dataclass
class GitStatus:
    """Git status information for a repository."""
    branch: str
    modified: list[str]
    added: list[str]
    deleted: list[str]
    untracked: list[str]
    ahead: int
    behind: int
    has_uncommitted: bool


@dataclass
class GitCommit:
    """Git commit information."""
    sha: str
    short_sha: str
    message: str
    author: str
    timestamp: str
    files_changed: int


def run_git(cwd: str, *args) -> tuple[str, bool]:
    """Run a git command and return (output, success).

    Args:
        cwd: Working directory for the git command
        *args: Git command arguments

    Returns:
        Tuple of (stdout output, success boolean)
    """
    try:
        result = subprocess.run(
            ['git', *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.stdout.strip(), result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
        return str(e), False


def get_git_status(cwd: str) -> Optional[GitStatus]:
    """Get git status for a directory.

    Args:
        cwd: Working directory path

    Returns:
        GitStatus object or None if not a git repository
    """
    if not Path(cwd).exists():
        return None

    # Check if git repo
    _, is_repo = run_git(cwd, 'rev-parse', '--git-dir')
    if not is_repo:
        return None

    # Get branch
    branch, _ = run_git(cwd, 'branch', '--show-current')
    if not branch:
        # Detached HEAD state
        branch, _ = run_git(cwd, 'rev-parse', '--short', 'HEAD')
        branch = f"detached:{branch}"

    # Get status
    status_output, _ = run_git(cwd, 'status', '--porcelain')

    modified = []
    added = []
    deleted = []
    untracked = []

    for line in status_output.split('\n'):
        if not line:
            continue
        status = line[:2]
        filename = line[3:]

        if 'M' in status:
            modified.append(filename)
        if 'A' in status:
            added.append(filename)
        if 'D' in status:
            deleted.append(filename)
        if '?' in status:
            untracked.append(filename)

    # Get ahead/behind
    ahead_behind, success = run_git(
        cwd, 'rev-list', '--left-right', '--count',
        f'{branch}...origin/{branch}'
    )
    ahead, behind = 0, 0
    if success:
        try:
            parts = ahead_behind.split()
            ahead = int(parts[0]) if parts else 0
            behind = int(parts[1]) if len(parts) > 1 else 0
        except (ValueError, IndexError):
            pass

    return GitStatus(
        branch=branch,
        modified=modified,
        added=added,
        deleted=deleted,
        untracked=untracked,
        ahead=ahead,
        behind=behind,
        has_uncommitted=bool(modified or added or deleted)
    )


def get_recent_commits(cwd: str, limit: int = 5) -> list[GitCommit]:
    """Get recent commits.

    Args:
        cwd: Working directory path
        limit: Maximum number of commits to retrieve

    Returns:
        List of GitCommit objects
    """
    format_str = '%H|%h|%s|%an|%ar|'
    output, success = run_git(cwd, 'log', f'-{limit}', f'--format={format_str}')

    if not success:
        return []

    commits = []
    for line in output.split('\n'):
        if not line or '|' not in line:
            continue
        parts = line.split('|')
        if len(parts) >= 5:
            # Get files changed count
            files_output, _ = run_git(
                cwd, 'diff-tree', '--no-commit-id', '--name-only', '-r', parts[0]
            )
            files_changed = len([f for f in files_output.split('\n') if f])

            commits.append(GitCommit(
                sha=parts[0],
                short_sha=parts[1],
                message=parts[2],
                author=parts[3],
                timestamp=parts[4],
                files_changed=files_changed
            ))

    return commits


def get_diff_stats(cwd: str) -> dict:
    """Get diff statistics for uncommitted changes.

    Args:
        cwd: Working directory path

    Returns:
        Dictionary with 'files' list and 'summary' string
    """
    output, _ = run_git(cwd, 'diff', '--stat')
    if not output:
        return {'files': [], 'summary': ''}

    lines = output.strip().split('\n')

    files = []
    for line in lines[:-1]:  # Skip summary line
        if '|' in line:
            parts = line.split('|')
            filename = parts[0].strip()
            changes = parts[1].strip() if len(parts) > 1 else ''
            files.append({'file': filename, 'changes': changes})

    # Parse summary (e.g., "3 files changed, 45 insertions(+), 12 deletions(-)")
    summary = lines[-1] if lines else ''

    return {'files': files, 'summary': summary}


def find_related_pr(cwd: str, branch: str) -> Optional[dict]:
    """Find PR related to current branch using gh CLI.

    Args:
        cwd: Working directory path
        branch: Current branch name

    Returns:
        Dictionary with PR info or None if not found
    """
    try:
        result = subprocess.run(
            ['gh', 'pr', 'view', '--json', 'number,title,state,url'],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
            env={'GH_HOST': 'github.toasttab.com'}  # Support GitHub Enterprise
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError, Exception):
        pass
    return None


# Cache for git status to avoid frequent subprocess calls
_git_status_cache: dict[str, tuple[float, Optional[GitStatus]]] = {}
_cache_ttl = 60.0  # Cache for 60 seconds (optimized for dirty-check pattern)


def get_cached_git_status(cwd: str) -> Optional[GitStatus]:
    """Get cached git status or fetch if stale.

    Args:
        cwd: Working directory path

    Returns:
        GitStatus object or None
    """
    import time
    now = time.time()

    if cwd in _git_status_cache:
        timestamp, status = _git_status_cache[cwd]
        if now - timestamp < _cache_ttl:
            return status

    # Fetch fresh status
    status = get_git_status(cwd)
    _git_status_cache[cwd] = (now, status)
    return status

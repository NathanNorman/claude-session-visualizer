"""Type definitions for the Claude Session Visualizer.

This module provides TypedDict definitions for better type safety and
documentation of the data structures used throughout the application.
"""

from typing import TypedDict
from typing_extensions import NotRequired


class TokenUsage(TypedDict):
    """Token usage metrics from Claude API responses."""
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: NotRequired[int]
    cache_creation_input_tokens: NotRequired[int]


class ProcessInfo(TypedDict):
    """Information about a running Claude CLI process."""
    pid: int
    cpu: float
    tty: str
    state: str
    cmd: str
    session_id: str | None
    cwd: str | None
    start_time: float | None
    is_gastown: bool
    gastown_role: str | None


class SessionMetadata(TypedDict):
    """Metadata extracted from a Claude session JSONL file."""
    sessionId: str
    slug: str
    cwd: str
    gitBranch: NotRequired[str]
    summary: NotRequired[str | None]
    contextTokens: int
    timestamp: str
    startTimestamp: str
    file_mtime: float
    recentActivity: list[str]
    tokenPercentage: NotRequired[float]
    estimatedCost: NotRequired[float]
    cumulativeUsage: NotRequired[TokenUsage]
    isGastown: NotRequired[bool]
    gastownRole: NotRequired[str | None]


class SessionInfo(TypedDict):
    """Full session information returned by get_sessions()."""
    sessionId: str
    slug: str
    cwd: str
    gitBranch: NotRequired[str]
    summary: NotRequired[str | None]
    contextTokens: int
    state: str  # 'active', 'waiting', 'paused', 'dead'
    stateSource: str  # 'hooks', 'cpu', 'recent'
    pid: NotRequired[int]
    tty: NotRequired[str]
    cpuPercent: NotRequired[float]
    timestamp: str
    startTimestamp: str
    lastActivity: NotRequired[str]
    recentActivity: list[str]
    tokenPercentage: NotRequired[float]
    estimatedCost: NotRequired[float]
    isGastown: NotRequired[bool]
    gastownRole: NotRequired[str | None]
    backgroundShells: NotRequired[list[dict]]
    currentActivity: NotRequired[dict]


class ActivityPeriod(TypedDict):
    """An activity period in a session timeline."""
    start: str  # ISO timestamp
    end: str  # ISO timestamp
    state: str  # 'active' or 'idle'
    activities: NotRequired[list[str]]
    tools: NotRequired[dict[str, int]]


class TimelineEvent(TypedDict):
    """A single event in a session timeline."""
    timestamp: str
    type: str
    active: bool
    tool: NotRequired[str]
    activity: NotRequired[str]


class ConversationMessage(TypedDict):
    """A message in a session conversation."""
    type: str  # 'user', 'assistant', 'system'
    timestamp: str
    text: NotRequired[str]
    tools: NotRequired[list[str]]


class GitCommit(TypedDict):
    """Information about a git commit."""
    sha: str
    message: str
    author: str
    date: str


class DiffStats(TypedDict):
    """Statistics about uncommitted changes."""
    files_changed: int
    insertions: int
    deletions: int


class SessionAnalytics(TypedDict):
    """Analytics data for a time period."""
    period: str
    total_sessions: int
    total_sessions_change: float
    total_tokens: int
    total_tokens_change: float
    estimated_cost: float
    estimated_cost_change: float
    active_time_hours: float
    active_time_change: float
    time_breakdown: list[dict]
    top_repos: list[dict]
    activity_by_hour: dict[int, int]
    peak_hour: int
    duration_distribution: dict

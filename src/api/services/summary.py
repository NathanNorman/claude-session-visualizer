"""AI summary generation services using Bedrock Proxy."""

import hashlib
import json
import os
import time
from pathlib import Path

import httpx

from ..logging_config import get_logger

# Create Bedrock logger
logger = get_logger(__name__, namespace='bedrock')

from ..analytics import (
    get_last_activity_hash,
    save_activity_summary,
    get_activity_summaries as db_get_activity_summaries,
    get_focus_summary_state,
    save_focus_summary as db_save_focus_summary,
    update_focus_summary_state,
)

# Bedrock configuration
BEDROCK_PROXY_URL = os.getenv("BEDROCK_PROXY_URL", "https://bedrock-runtime.us-east-1.amazonaws.com")
BEDROCK_TOKEN_FILE = Path(os.getenv("BEDROCK_TOKEN_FILE", str(Path.home() / ".config" / "bedrock-proxy" / "token")))
HAIKU_MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"

# Summary cache
_summary_cache: dict[str, dict] = {}  # sessionId -> {summary, timestamp}
SUMMARY_TTL = 300  # 5 minutes

# Activity summary configuration
MIN_ACTIVITIES_FOR_SUMMARY = 3
GENERIC_ACTIVITY_PATTERNS = [
    'Using Skill',
    'Running skill',
    'Using ',
    'Updating task list',
    'Asking user question',
]


def get_bedrock_token() -> str | None:
    """Read JWT token from bedrock proxy config."""
    try:
        if BEDROCK_TOKEN_FILE.exists():
            token_data = json.loads(BEDROCK_TOKEN_FILE.read_text())
            return token_data.get("access_token")
    except Exception as e:
        logger.warning(f"Failed to read bedrock token: {e}")
    return None


def compute_activity_hash(activities: list[str]) -> str:
    """Hash last 5 activities for change detection."""
    key = '|'.join(activities[-5:]) if activities else ''
    return hashlib.md5(key.encode()).hexdigest()[:8]


def is_meaningful_activity(activity: str) -> bool:
    """Check if an activity provides enough context for summarization."""
    if not activity:
        return False
    for pattern in GENERIC_ACTIVITY_PATTERNS:
        if activity == pattern or (pattern.endswith(' ') and activity.startswith(pattern) and len(activity) < len(pattern) + 10):
            return False
    return True


async def generate_session_summary(session_id: str, activities: list[str], cwd: str) -> str:
    """Generate a human-readable summary of session activity."""
    # Check cache
    cached = _summary_cache.get(session_id)
    if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
        return cached['summary']

    token = get_bedrock_token()
    if not token:
        return "AI summaries not available (run toastApiKeyHelper to refresh token)"

    activity_text = "\n".join(f"- {a}" for a in activities[-20:]) if activities else "- No recent activity"
    prompt = f"""Based on this Claude Code session activity, write a ONE sentence summary of what the user is working on. Be specific and actionable.

Working directory: {cwd}

Recent activity:
{activity_text}

Summary (one sentence, no quotes):"""

    try:
        response = httpx.post(
            f"{BEDROCK_PROXY_URL}/model/{HAIKU_MODEL_ID}/invoke",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 100,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=30.0
        )
        response.raise_for_status()
        data = response.json()
        summary = data["content"][0]["text"].strip()

        _summary_cache[session_id] = {
            'summary': summary,
            'timestamp': time.time()
        }

        return summary
    except Exception as e:
        return f"Summary unavailable: {str(e)}"


async def generate_activity_summary(session_id: str, activities: list[str], cwd: str) -> str | None:
    """Generate action->context summary when activity changes or on first encounter."""
    if not activities:
        return None

    meaningful = [a for a in activities if is_meaningful_activity(a)]
    if len(meaningful) < MIN_ACTIVITIES_FOR_SUMMARY:
        return None

    current_hash = compute_activity_hash(activities)
    last_hash = get_last_activity_hash(session_id)
    existing_entries = db_get_activity_summaries(session_id)

    needs_summary = (
        last_hash != current_hash or
        (len(existing_entries) == 0 and len(activities) > 0)
    )

    if not needs_summary:
        return None

    token = get_bedrock_token()
    if not token:
        return None

    activity_text = "\n".join(f"- {a}" for a in meaningful[-5:])

    prompt = f"""Based on these Claude Code actions, write a SHORT summary (8-15 words max) in this exact format:
"[Action verb]ing [file/thing] -> [what for]"

Examples:
- "Editing server.py -> adding authentication middleware"
- "Reading tests -> understanding validation logic"
- "Running npm test -> checking for regressions"

Working directory: {cwd}
Recent actions:
{activity_text}

Summary (format: "[verb]ing X -> Y", no quotes):"""

    try:
        response = httpx.post(
            f"{BEDROCK_PROXY_URL}/model/{HAIKU_MODEL_ID}/invoke",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 50,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=15.0
        )
        response.raise_for_status()
        data = response.json()
        summary = data["content"][0]["text"].strip()

        save_activity_summary(session_id, summary, current_hash)

        return summary
    except Exception as e:
        logger.warning(f"Activity summary generation failed for {session_id}: {e}")
        return None


def get_summary_cache() -> dict[str, dict]:
    """Get the summary cache (for use by routes)."""
    return _summary_cache


# ============================================================================
# Focus Summary Generation (5-word session focus)
# ============================================================================

# Trigger thresholds for focus summary updates
FOCUS_MESSAGE_THRESHOLD = 10  # Update after +10 messages
FOCUS_CONTEXT_THRESHOLDS = [25, 50, 75]  # Update when crossing these percentages
FOCUS_IDLE_THRESHOLD_SECONDS = 300  # 5 minutes idle before activity = trigger


def should_update_focus_summary(
    session_id: str,
    message_count: int,
    context_pct: int,
    last_activity_at: str | None,
    has_existing: bool
) -> tuple[bool, str]:
    """Check if focus summary needs update based on triggers.

    Returns:
        Tuple of (should_update: bool, reason: str)
        Reasons: 'initial', 'message_threshold', 'context_threshold', 'resumed_idle', 'none'
    """
    state = get_focus_summary_state(session_id)

    # Initial: no existing summary
    if not has_existing and not (state and state.get('focus_summary')):
        return True, 'initial'

    if not state:
        return False, 'none'

    prev_msg_count = state.get('message_count', 0)
    prev_context_pct = state.get('context_pct', 0)
    prev_activity_at = state.get('last_activity_at')

    # Message threshold: +10 messages since last update
    if message_count - prev_msg_count >= FOCUS_MESSAGE_THRESHOLD:
        return True, 'message_threshold'

    # Context threshold: crossed 25%, 50%, or 75%
    for threshold in FOCUS_CONTEXT_THRESHOLDS:
        if prev_context_pct < threshold <= context_pct:
            return True, 'context_threshold'

    # Resumed after idle: >5 min gap in activity
    if last_activity_at and prev_activity_at:
        try:
            from datetime import datetime
            prev_time = datetime.fromisoformat(prev_activity_at.replace('Z', '+00:00'))
            curr_time = datetime.fromisoformat(last_activity_at.replace('Z', '+00:00'))
            idle_seconds = (curr_time - prev_time).total_seconds()
            if idle_seconds > FOCUS_IDLE_THRESHOLD_SECONDS:
                return True, 'resumed_idle'
        except (ValueError, AttributeError):
            pass

    return False, 'none'


async def generate_focus_summary(
    session_id: str,
    first_user_message: str | None = None,
    previous_summary: str | None = None,
    recent_messages: list[dict] | None = None
) -> str | None:
    """Generate 5-word focus summary using Haiku.

    Two modes:
    - Initial: Summarize first_user_message into 5-word focus
    - Update: Feed previous_summary + recent_messages, return new summary or None if unchanged

    Args:
        session_id: Session ID for logging
        first_user_message: First user message (for initial summary)
        previous_summary: Existing focus summary (for updates)
        recent_messages: Last 5 messages (for updates)

    Returns:
        5-word focus summary, or None if unchanged or failed
    """
    token = get_bedrock_token()
    if not token:
        logger.debug(f"Focus summary skipped for {session_id}: no bedrock token")
        return None

    # Build prompt based on mode
    if first_user_message and not previous_summary:
        # Initial summary mode
        prompt = f"""Based on this user request, write a 5-word-max summary of their focus.
User request: {first_user_message[:500]}

Rules:
- Start with action verb (e.g., Debugging, Implementing, Fixing, Adding)
- Be specific about what they're working on
- No punctuation at the end
- Exactly 3-5 words

Example outputs:
- Debugging lambda deployment failure
- Implementing user authentication flow
- Fixing database connection timeout
- Adding search to dashboard

Summary (3-5 words, no quotes):"""
    elif previous_summary and recent_messages:
        # Update mode
        activity_text = "\n".join(
            f"- {msg.get('role', 'unknown')}: {msg.get('content', '')[:100]}"
            for msg in recent_messages[-5:]
        )
        prompt = f"""Current focus: "{previous_summary}"
Recent conversation:
{activity_text}

Has the user's focus changed? If yes, write a NEW 3-5 word summary.
If the focus is still the same, respond with exactly: UNCHANGED

Rules for new summary:
- Start with action verb
- Be specific
- No punctuation
- 3-5 words only

Response (new summary OR "UNCHANGED"):"""
    else:
        logger.debug(f"Focus summary skipped for {session_id}: insufficient input")
        return None

    try:
        response = httpx.post(
            f"{BEDROCK_PROXY_URL}/model/{HAIKU_MODEL_ID}/invoke",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 30,
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=15.0
        )
        response.raise_for_status()
        data = response.json()
        result = data["content"][0]["text"].strip()

        # Handle UNCHANGED response for updates
        if result.upper() == "UNCHANGED":
            logger.debug(f"Focus unchanged for {session_id}")
            return None

        # Clean up result (remove quotes, punctuation)
        result = result.strip('"\'').rstrip('.!?')

        # Validate length (should be 3-5 words)
        word_count = len(result.split())
        if word_count < 2 or word_count > 7:
            logger.warning(f"Focus summary invalid length ({word_count} words): {result}")
            # Try to truncate if too long
            if word_count > 7:
                result = ' '.join(result.split()[:5])

        logger.info(f"Generated focus summary for {session_id}: {result}")
        return result

    except Exception as e:
        logger.warning(f"Focus summary generation failed for {session_id}: {e}")
        return None


async def update_session_focus_summary(
    session_id: str,
    message_count: int,
    context_pct: int,
    last_activity_at: str | None,
    first_user_message: str | None = None,
    recent_messages: list[dict] | None = None,
    current_summary: str | None = None
) -> str | None:
    """Check triggers and update focus summary if needed.

    This is the main entry point for the background loop.

    Returns:
        New focus summary if generated, None otherwise
    """
    should_update, reason = should_update_focus_summary(
        session_id, message_count, context_pct, last_activity_at,
        has_existing=bool(current_summary)
    )

    new_summary = None

    if should_update:
        logger.debug(f"Focus summary trigger: {reason} for {session_id}")

        if reason == 'initial' and first_user_message:
            new_summary = await generate_focus_summary(
                session_id,
                first_user_message=first_user_message
            )
        elif reason in ('message_threshold', 'context_threshold', 'resumed_idle'):
            new_summary = await generate_focus_summary(
                session_id,
                previous_summary=current_summary,
                recent_messages=recent_messages
            )

        if new_summary:
            db_save_focus_summary(session_id, new_summary)

    # Always update state tracking (even if no new summary)
    update_focus_summary_state(
        session_id,
        message_count=message_count,
        context_pct=context_pct,
        last_activity_at=last_activity_at
    )

    return new_summary

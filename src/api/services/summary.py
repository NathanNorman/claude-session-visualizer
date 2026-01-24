"""AI summary generation services using Toast Bedrock Proxy."""

import hashlib
import json
import time
from pathlib import Path

import httpx

from ..analytics import (
    get_last_activity_hash,
    save_activity_summary,
    get_activity_summaries as db_get_activity_summaries,
)

# Bedrock configuration
BEDROCK_PROXY_URL = "https://llm-proxy.build.eng.toasttab.com/bedrock"
BEDROCK_TOKEN_FILE = Path.home() / ".config" / "toast-bedrock-proxy" / "token"
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
    """Read JWT token from toast-bedrock-proxy config."""
    try:
        if BEDROCK_TOKEN_FILE.exists():
            token_data = json.loads(BEDROCK_TOKEN_FILE.read_text())
            return token_data.get("access_token")
    except Exception as e:
        print(f"Failed to read bedrock token: {e}")
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
        print(f"Activity summary generation failed for {session_id}: {e}")
        return None


def get_summary_cache() -> dict[str, dict]:
    """Get the summary cache (for use by routes)."""
    return _summary_cache

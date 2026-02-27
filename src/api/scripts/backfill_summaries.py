#!/usr/bin/env python3
"""Backfill focus summaries for historical Claude sessions.

This script generates focus summaries for all Claude sessions from the last
month that don't have summaries in the database.

Usage:
    # Dry run - see what would be processed
    python -m src.api.scripts.backfill_summaries --dry-run

    # Test with 10 sessions
    python -m src.api.scripts.backfill_summaries --limit 10 --verbose

    # Full backfill
    python -m src.api.scripts.backfill_summaries --verbose

    # Single session test
    python -m src.api.scripts.backfill_summaries --session-id abc123
"""

import argparse
import asyncio
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from src.api.config import CLAUDE_PROJECTS_DIR
from src.api.analytics import get_focus_summary, save_focus_summary, init_database
from src.api.session_detector import extract_first_user_message
from src.api.services.summary import (
    BEDROCK_PROXY_URL,
    BEDROCK_TOKEN_FILE,
    HAIKU_MODEL_ID,
    get_bedrock_token,
)


@dataclass
class SessionInfo:
    """Information about a discovered session."""
    session_id: str
    jsonl_path: Path
    mtime: float
    project_slug: str


class RateLimiter:
    """Token bucket rate limiter for API calls."""

    def __init__(self, requests_per_minute: int = 30):
        self.rate = requests_per_minute / 60.0  # tokens per second
        self.max_tokens = requests_per_minute
        self.tokens = float(requests_per_minute)
        self.last_update = time.time()

    async def acquire(self):
        """Wait until a token is available."""
        while True:
            now = time.time()
            # Add tokens based on elapsed time
            elapsed = now - self.last_update
            self.tokens = min(self.max_tokens, self.tokens + elapsed * self.rate)
            self.last_update = now

            if self.tokens >= 1:
                self.tokens -= 1
                return

            # Wait for tokens to accumulate
            wait_time = (1 - self.tokens) / self.rate
            await asyncio.sleep(wait_time)


class BackfillStats:
    """Track backfill progress and statistics."""

    def __init__(self):
        self.processed = 0
        self.succeeded = 0
        self.failed = 0
        self.skipped_no_message = 0
        self.skipped_has_summary = 0
        self.start_time = time.time()

    @property
    def duration_str(self) -> str:
        """Format duration as human-readable string."""
        elapsed = time.time() - self.start_time
        hours = int(elapsed // 3600)
        minutes = int((elapsed % 3600) // 60)
        if hours > 0:
            return f"{hours}h {minutes}m"
        return f"{minutes}m"


def discover_sessions(max_age_days: int = 30) -> list[SessionInfo]:
    """Discover all JSONL session files within the max age.

    Args:
        max_age_days: Maximum age of sessions to include

    Returns:
        List of SessionInfo objects, sorted by mtime (oldest first)
    """
    sessions = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    cutoff_timestamp = cutoff.timestamp()

    if not CLAUDE_PROJECTS_DIR.exists():
        print(f"Error: Claude projects directory not found: {CLAUDE_PROJECTS_DIR}")
        return sessions

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        # Skip .claude-work and similar hidden directories
        if project_dir.name.startswith('.'):
            continue

        project_slug = project_dir.name

        for jsonl_file in project_dir.glob("*.jsonl"):
            # Skip agent files (subagent sessions)
            if jsonl_file.stem.startswith('agent-'):
                continue

            try:
                mtime = jsonl_file.stat().st_mtime
                if mtime >= cutoff_timestamp:
                    sessions.append(SessionInfo(
                        session_id=jsonl_file.stem,
                        jsonl_path=jsonl_file,
                        mtime=mtime,
                        project_slug=project_slug,
                    ))
            except OSError:
                continue

    # Sort by mtime (oldest first for consistent processing)
    sessions.sort(key=lambda s: s.mtime)
    return sessions


async def generate_focus_summary_via_bedrock(first_user_message: str) -> str | None:
    """Generate a 3-5 word focus summary using Bedrock Haiku.

    Args:
        first_user_message: The first user message from the session

    Returns:
        Focus summary string, or None on failure
    """
    token = get_bedrock_token()
    if not token:
        return None

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

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
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
                timeout=30.0
            )
            response.raise_for_status()
            data = response.json()
            result = data["content"][0]["text"].strip()

            # Clean up result (remove quotes, punctuation)
            result = result.strip('"\'').rstrip('.!?')

            # Validate length (should be 3-5 words)
            word_count = len(result.split())
            if word_count > 7:
                result = ' '.join(result.split()[:5])

            return result

    except httpx.HTTPStatusError as e:
        if e.response.status_code == 429:
            # Rate limited - let the rate limiter handle backoff
            return None
        raise
    except Exception:
        return None


def print_progress_bar(current: int, total: int, eta_minutes: int, width: int = 50):
    """Print a progress bar to stdout."""
    if total == 0:
        return

    pct = current / total
    filled = int(width * pct)
    bar = '=' * filled + '>' + ' ' * (width - filled - 1)

    if eta_minutes > 60:
        eta_str = f"{eta_minutes // 60}h {eta_minutes % 60}m"
    else:
        eta_str = f"{eta_minutes}m"

    print(f"\r[{bar}] {pct*100:4.0f}% ({current}/{total}) | ETA: {eta_str}  ", end='', flush=True)


async def backfill_summaries(
    dry_run: bool = False,
    max_age_days: int = 30,
    limit: int | None = None,
    rate_limit: int = 30,
    verbose: bool = False,
    session_id: str | None = None,
) -> BackfillStats:
    """Main backfill function.

    Args:
        dry_run: If True, only preview what would be processed
        max_age_days: Maximum age of sessions to process
        limit: Maximum number of sessions to process
        rate_limit: Requests per minute
        verbose: Print each summary generated
        session_id: Process only this specific session

    Returns:
        BackfillStats with processing results
    """
    stats = BackfillStats()

    # Ensure database exists
    init_database()

    # Discover sessions
    print("\nBackfill Focus Summaries")
    print("=" * 40)

    if session_id:
        # Find specific session
        all_sessions = discover_sessions(max_age_days=365)  # Look further back for specific ID
        sessions = [s for s in all_sessions if s.session_id == session_id]
        if not sessions:
            print(f"Error: Session {session_id} not found")
            return stats
    else:
        sessions = discover_sessions(max_age_days=max_age_days)

    print(f"Sessions discovered: {len(sessions):,}")

    # Filter to sessions without existing summaries
    sessions_to_process = []
    for session in sessions:
        existing = get_focus_summary(session.session_id)
        if existing:
            stats.skipped_has_summary += 1
        else:
            sessions_to_process.append(session)

    print(f"Sessions needing summaries: {len(sessions_to_process):,}")
    print(f"Sessions already have summaries: {stats.skipped_has_summary:,}")

    if limit:
        sessions_to_process = sessions_to_process[:limit]
        print(f"Limited to: {len(sessions_to_process):,}")

    if not sessions_to_process:
        print("\nNo sessions to process!")
        return stats

    print(f"Rate limit: {rate_limit} req/min")

    # Estimate time
    est_minutes = len(sessions_to_process) * 60 // rate_limit
    if est_minutes > 60:
        print(f"Estimated time: ~{est_minutes // 60}h {est_minutes % 60}m")
    else:
        print(f"Estimated time: ~{est_minutes}m")

    if dry_run:
        print("\n[DRY RUN - No changes will be made]\n")
        print("Sessions that would be processed:")
        for i, session in enumerate(sessions_to_process[:20]):
            mtime_str = datetime.fromtimestamp(session.mtime).strftime('%Y-%m-%d %H:%M')
            print(f"  {session.session_id[:8]}... | {mtime_str} | {session.project_slug[:30]}")
        if len(sessions_to_process) > 20:
            print(f"  ... and {len(sessions_to_process) - 20} more")
        return stats

    print()  # Blank line before progress

    # Process sessions with rate limiting
    rate_limiter = RateLimiter(requests_per_minute=rate_limit)
    retry_delays = [1, 2, 4, 8, 16]  # Exponential backoff

    for i, session in enumerate(sessions_to_process):
        stats.processed += 1

        # Update progress bar
        remaining = len(sessions_to_process) - i
        eta_minutes = remaining * 60 // rate_limit
        print_progress_bar(i, len(sessions_to_process), eta_minutes)

        # Extract first user message
        first_msg = extract_first_user_message(session.jsonl_path)
        if not first_msg:
            stats.skipped_no_message += 1
            if verbose:
                print(f"\n  {session.session_id[:8]}: [skipped - no user message]")
            continue

        # Generate summary with rate limiting and retries
        summary = None
        for retry, delay in enumerate(retry_delays):
            await rate_limiter.acquire()
            try:
                summary = await generate_focus_summary_via_bedrock(first_msg)
                if summary:
                    break
            except Exception as e:
                if retry < len(retry_delays) - 1:
                    if verbose:
                        print(f"\n  Retry {retry + 1} after error: {e}")
                    await asyncio.sleep(delay)
                continue

        if summary:
            save_focus_summary(session.session_id, summary)
            stats.succeeded += 1
            if verbose:
                print(f"\n  {session.session_id[:8]}: \"{summary}\"")
        else:
            stats.failed += 1
            if verbose:
                print(f"\n  {session.session_id[:8]}: [failed]")

    # Final progress
    print_progress_bar(len(sessions_to_process), len(sessions_to_process), 0)

    # Print summary
    print("\n\nComplete!")
    print("-" * 20)
    print(f"Processed: {stats.processed:,}")
    print(f"Succeeded: {stats.succeeded:,}")
    print(f"Failed: {stats.failed:,}")
    print(f"Skipped (no user message): {stats.skipped_no_message:,}")
    print(f"Skipped (has summary): {stats.skipped_has_summary:,}")
    print(f"Duration: {stats.duration_str}")

    return stats


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Backfill focus summaries for historical Claude sessions",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Preview what would be processed without making changes'
    )
    parser.add_argument(
        '--max-age-days',
        type=int,
        default=30,
        metavar='N',
        help='Process sessions from last N days (default: 30)'
    )
    parser.add_argument(
        '--limit',
        type=int,
        metavar='N',
        help='Process at most N sessions'
    )
    parser.add_argument(
        '--rate-limit',
        type=int,
        default=30,
        metavar='N',
        help='Requests per minute (default: 30)'
    )
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Show each summary generated'
    )
    parser.add_argument(
        '--session-id',
        metavar='ID',
        help='Process only this specific session'
    )
    parser.add_argument(
        '--recent',
        action='store_true',
        help='Quick mode: last 48 hours, rate limit 30/min'
    )

    args = parser.parse_args()

    # --recent is a shortcut for --max-age-days 2 --rate-limit 30
    if args.recent:
        args.max_age_days = 2
        args.rate_limit = 30

    # Check for Bedrock token
    if not args.dry_run:
        token = get_bedrock_token()
        if not token:
            print(f"Error: No Bedrock token found at {BEDROCK_TOKEN_FILE}")
            print("Run 'toastApiKeyHelper' to refresh your token")
            sys.exit(1)

    # Run backfill
    stats = asyncio.run(backfill_summaries(
        dry_run=args.dry_run,
        max_age_days=args.max_age_days,
        limit=args.limit,
        rate_limit=args.rate_limit,
        verbose=args.verbose,
        session_id=args.session_id,
    ))

    # Exit with error code if significant failures
    if stats.failed > stats.succeeded and stats.succeeded > 0:
        sys.exit(1)


if __name__ == '__main__':
    main()

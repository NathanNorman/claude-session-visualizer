import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

DB_PATH = Path.home() / ".claude" / "session_history.db"


def init_database():
    """Initialize the session history database with schema."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()

        # Main sessions table
        c.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                slug TEXT,
                cwd TEXT,
                git_branch TEXT,
                start_time TEXT NOT NULL,
                end_time TEXT,
                duration_seconds INTEGER,
                token_count INTEGER DEFAULT 0,
                estimated_cost REAL DEFAULT 0,
                state TEXT
            )
        ''')

        # Snapshots for tracking session activity over time
        c.execute('''
            CREATE TABLE IF NOT EXISTS session_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                state TEXT,
                cpu_percent REAL,
                token_count INTEGER,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        ''')

        # Indexes for query performance
        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_sessions_start_time
            ON sessions(start_time)
        ''')

        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_sessions_cwd
            ON sessions(cwd)
        ''')

        # Composite index for common analytics queries
        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_sessions_cwd_start_time
            ON sessions(cwd, start_time)
        ''')

        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp
            ON session_snapshots(timestamp)
        ''')

        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_snapshots_session
            ON session_snapshots(session_id)
        ''')

        # Activity summaries table (AI-generated summaries of session activity)
        c.execute('''
            CREATE TABLE IF NOT EXISTS activity_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                summary TEXT NOT NULL,
                activity_hash TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        ''')

        c.execute('''
            CREATE INDEX IF NOT EXISTS idx_activity_summaries_session
            ON activity_summaries(session_id)
        ''')

        # Track last activity hash per session to avoid duplicate summaries
        c.execute('''
            CREATE TABLE IF NOT EXISTS activity_summary_state (
                session_id TEXT PRIMARY KEY,
                last_hash TEXT NOT NULL
            )
        ''')

        conn.commit()


def get_last_activity_hash(session_id: str) -> str | None:
    """Get the last activity hash for a session."""
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute('SELECT last_hash FROM activity_summary_state WHERE session_id = ?', (session_id,))
        row = c.fetchone()
        return row[0] if row else None


def save_activity_summary(session_id: str, summary: str, activity_hash: str) -> None:
    """Save an activity summary to the database."""
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()

        # Insert the summary
        c.execute('''
            INSERT INTO activity_summaries (session_id, timestamp, summary, activity_hash)
            VALUES (?, ?, ?, ?)
        ''', (session_id, now, summary, activity_hash))

        # Update the last hash state
        c.execute('''
            INSERT OR REPLACE INTO activity_summary_state (session_id, last_hash)
            VALUES (?, ?)
        ''', (session_id, activity_hash))

        conn.commit()


def get_activity_summaries(session_id: str) -> list[dict]:
    """Get all activity summaries for a session."""
    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()
        c.execute('''
            SELECT timestamp, summary, activity_hash
            FROM activity_summaries
            WHERE session_id = ?
            ORDER BY timestamp ASC
        ''', (session_id,))
        rows = c.fetchall()
        return [{'timestamp': r[0], 'summary': r[1], 'hash': r[2]} for r in rows]


def record_session_snapshot(session: dict):
    """Record a point-in-time snapshot of session state.

    Args:
        session: Dictionary containing session data from session_detector
    """
    init_database()  # Ensure DB exists

    session_id = session.get('sessionId')
    if not session_id:
        return

    now = datetime.now(timezone.utc).isoformat()

    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()

        # Upsert session record
        c.execute('''
            INSERT INTO sessions (id, slug, cwd, git_branch, start_time, state, token_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                state = excluded.state,
                token_count = excluded.token_count,
                git_branch = excluded.git_branch
        ''', (
            session_id,
            session.get('slug', ''),
            session.get('cwd', ''),
            session.get('gitBranch', ''),
            now,
            session.get('state', 'unknown'),
            session.get('contextTokens', 0)
        ))

        # Record snapshot for activity tracking
        c.execute('''
            INSERT INTO session_snapshots (session_id, timestamp, state, cpu_percent, token_count)
            VALUES (?, ?, ?, ?, ?)
        ''', (
            session_id,
            now,
            session.get('state', 'unknown'),
            session.get('cpuPercent', 0),
            session.get('contextTokens', 0)
        ))

        conn.commit()


def get_analytics(period: str = 'week') -> dict:
    """Get analytics for the specified time period.

    Args:
        period: One of 'day', 'week', 'month', 'year'

    Returns:
        Dictionary with analytics data including totals, trends, and breakdowns
    """
    init_database()

    # Calculate date range
    now = datetime.now(timezone.utc)
    if period == 'day':
        start_date = now.replace(hour=0, minute=0, second=0, microsecond=0)
        prev_start = start_date - timedelta(days=1)
    elif period == 'week':
        start_date = now - timedelta(days=7)
        prev_start = start_date - timedelta(days=7)
    elif period == 'month':
        start_date = now - timedelta(days=30)
        prev_start = start_date - timedelta(days=30)
    else:  # year
        start_date = now - timedelta(days=365)
        prev_start = start_date - timedelta(days=365)

    start_str = start_date.isoformat()
    prev_start_str = prev_start.isoformat()

    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()

        # Total sessions (current period)
        c.execute('''
            SELECT COUNT(DISTINCT id) FROM sessions
            WHERE start_time >= ?
        ''', (start_str,))
        total_sessions = c.fetchone()[0] or 0

        # Previous period sessions (for comparison)
        c.execute('''
            SELECT COUNT(DISTINCT id) FROM sessions
            WHERE start_time >= ? AND start_time < ?
        ''', (prev_start_str, start_str))
        prev_sessions = c.fetchone()[0] or 0

        # Total tokens (current period)
        c.execute('''
            SELECT SUM(token_count) FROM sessions
            WHERE start_time >= ?
        ''', (start_str,))
        total_tokens = c.fetchone()[0] or 0

        # Previous period tokens
        c.execute('''
            SELECT SUM(token_count) FROM sessions
            WHERE start_time >= ? AND start_time < ?
        ''', (prev_start_str, start_str))
        prev_tokens = c.fetchone()[0] or 0

        # Estimate active time (sum of active snapshots * 60 seconds between polls)
        c.execute('''
            SELECT COUNT(*) FROM session_snapshots
            WHERE timestamp >= ? AND state = 'active'
        ''', (start_str,))
        active_snapshots = c.fetchone()[0] or 0
        active_time_seconds = active_snapshots * 60  # Assuming 60-second polling

        # Previous period active time
        c.execute('''
            SELECT COUNT(*) FROM session_snapshots
            WHERE timestamp >= ? AND timestamp < ? AND state = 'active'
        ''', (prev_start_str, start_str))
        prev_active_snapshots = c.fetchone()[0] or 0
        prev_active_time = prev_active_snapshots * 60

        # Sessions by day (for chart)
        if period == 'day':
            # Hourly breakdown for today
            c.execute('''
                SELECT strftime('%H', start_time) as hour, COUNT(*) as count
                FROM sessions
                WHERE start_time >= ?
                GROUP BY hour
                ORDER BY hour
            ''', (start_str,))
            time_breakdown = [{'label': f"{row[0]}:00", 'count': row[1]} for row in c.fetchall()]
        else:
            # Daily breakdown for week/month/year
            c.execute('''
                SELECT DATE(start_time) as day, COUNT(*) as count
                FROM sessions
                WHERE start_time >= ?
                GROUP BY day
                ORDER BY day
            ''', (start_str,))
            time_breakdown = [{'label': row[0], 'count': row[1]} for row in c.fetchall()]

        # Top repositories
        c.execute('''
            SELECT cwd, COUNT(*) as count
            FROM sessions
            WHERE start_time >= ? AND cwd IS NOT NULL AND cwd != ''
            GROUP BY cwd
            ORDER BY count DESC
            LIMIT 5
        ''', (start_str,))
        top_repos = []
        for row in c.fetchall():
            cwd = row[0]
            count = row[1]
            # Extract repo name from path
            repo_name = cwd.rstrip('/').split('/')[-1] if cwd else 'Unknown'
            top_repos.append({'name': repo_name, 'count': count, 'path': cwd})

        # Calculate percentages for top repos
        if total_sessions > 0:
            for repo in top_repos:
                repo['percentage'] = round((repo['count'] / total_sessions) * 100, 1)
        else:
            for repo in top_repos:
                repo['percentage'] = 0

        # Activity by hour (0-23) for heatmap
        c.execute('''
            SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
            FROM session_snapshots
            WHERE timestamp >= ? AND state = 'active'
            GROUP BY hour
            ORDER BY hour
        ''', (start_str,))
        activity_by_hour_list = c.fetchall()

        # Convert to dictionary with all hours (0-23)
        activity_by_hour = {hour: 0 for hour in range(24)}
        for row in activity_by_hour_list:
            activity_by_hour[row[0]] = row[1]

        # Find peak hour
        peak_hour = max(activity_by_hour.items(), key=lambda x: x[1])[0] if activity_by_hour else 0

        # Session duration distribution
        c.execute('''
            SELECT
                SUM(CASE WHEN duration_seconds < 300 THEN 1 ELSE 0 END) as under_5m,
                SUM(CASE WHEN duration_seconds >= 300 AND duration_seconds < 1800 THEN 1 ELSE 0 END) as m5_30,
                SUM(CASE WHEN duration_seconds >= 1800 AND duration_seconds < 3600 THEN 1 ELSE 0 END) as m30_1h,
                SUM(CASE WHEN duration_seconds >= 3600 AND duration_seconds < 7200 THEN 1 ELSE 0 END) as h1_2,
                SUM(CASE WHEN duration_seconds >= 7200 THEN 1 ELSE 0 END) as over_2h,
                COUNT(*) as total
            FROM sessions
            WHERE start_time >= ? AND duration_seconds IS NOT NULL
        ''', (start_str,))

        duration_row = c.fetchone()
        duration_dist = {
            '<5m': duration_row[0] or 0,
            '5-30m': duration_row[1] or 0,
            '30m-1h': duration_row[2] or 0,
            '1-2h': duration_row[3] or 0,
            '>2h': duration_row[4] or 0,
            'total': duration_row[5] or 0
        }

        # Calculate percentages
        if duration_dist['total'] > 0:
            for key in ['<5m', '5-30m', '30m-1h', '1-2h', '>2h']:
                count = duration_dist[key]
                duration_dist[f'{key}_pct'] = round((count / duration_dist['total']) * 100, 1)

    # Estimate cost (~$3 per 1M tokens for Claude Sonnet)
    estimated_cost = (total_tokens / 1_000_000) * 3
    prev_cost = (prev_tokens / 1_000_000) * 3

    # Calculate percentage changes
    def calc_change(current, previous):
        if previous == 0:
            return 0 if current == 0 else 100
        return round(((current - previous) / previous) * 100, 1)

    return {
        'period': period,
        'total_sessions': total_sessions,
        'total_sessions_change': calc_change(total_sessions, prev_sessions),
        'total_tokens': total_tokens,
        'total_tokens_change': calc_change(total_tokens, prev_tokens),
        'estimated_cost': round(estimated_cost, 2),
        'estimated_cost_change': calc_change(estimated_cost, prev_cost),
        'active_time_hours': round(active_time_seconds / 3600, 1),
        'active_time_change': calc_change(active_time_seconds, prev_active_time),
        'time_breakdown': time_breakdown,
        'top_repos': top_repos,
        'activity_by_hour': activity_by_hour,
        'peak_hour': peak_hour,
        'duration_distribution': duration_dist
    }


def get_session_history(page: int = 1, per_page: int = 20, repo: str | None = None) -> dict:
    """Get paginated session history.

    Args:
        page: Page number (1-indexed)
        per_page: Number of sessions per page
        repo: Optional repository filter (partial match on cwd)

    Returns:
        Dictionary with sessions list, pagination info
    """
    init_database()

    # Build query
    where_clause = ""
    params: list = []

    if repo:
        where_clause = "WHERE cwd LIKE ?"
        params.append(f"%{repo}%")

    with sqlite3.connect(DB_PATH) as conn:
        c = conn.cursor()

        # Get total count
        count_query = f"SELECT COUNT(*) FROM sessions {where_clause}"
        c.execute(count_query, params)
        total = c.fetchone()[0]

        # Get paginated sessions
        query = f"""
            SELECT id, slug, cwd, git_branch, start_time, end_time,
                   duration_seconds, token_count, estimated_cost, state
            FROM sessions
            {where_clause}
            ORDER BY start_time DESC
            LIMIT ? OFFSET ?
        """
        params.extend([per_page, (page - 1) * per_page])

        c.execute(query, params)
        sessions = []

        for row in c.fetchall():
            session = {
                'id': row[0],
                'slug': row[1],
                'cwd': row[2],
                'git_branch': row[3],
                'start_time': row[4],
                'end_time': row[5],
                'duration_seconds': row[6],
                'token_count': row[7],
                'estimated_cost': row[8],
                'state': row[9]
            }

            # Format duration
            if session['duration_seconds']:
                hours = session['duration_seconds'] // 3600
                minutes = (session['duration_seconds'] % 3600) // 60
                if hours > 0:
                    session['duration_display'] = f"{hours}h {minutes}m"
                else:
                    session['duration_display'] = f"{minutes}m"
            else:
                session['duration_display'] = '--'

            # Extract repo name from cwd
            if session['cwd']:
                session['repo_name'] = session['cwd'].rstrip('/').split('/')[-1]
            else:
                session['repo_name'] = 'Unknown'

            # Format date
            try:
                start_time = session['start_time']
                if start_time:
                    dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                    session['date_display'] = dt.strftime('%b %d')
                    session['time_display'] = dt.strftime('%I:%M %p')
                else:
                    session['date_display'] = '--'
                    session['time_display'] = '--'
            except (ValueError, AttributeError):
                session['date_display'] = '--'
                session['time_display'] = '--'

            sessions.append(session)

    total_pages = (total + per_page - 1) // per_page if total > 0 else 1

    return {
        'sessions': sessions,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': total_pages
    }

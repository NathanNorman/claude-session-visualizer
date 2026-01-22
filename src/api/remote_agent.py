#!/usr/bin/env python3
"""
Remote Agent for Claude Session Visualizer.

Lightweight agent that runs on remote machines to expose session data
via HTTP on localhost. Used with SSH tunneling for multi-machine support.

Usage:
    python3 remote_agent.py                  # Default port 8081
    python3 remote_agent.py --port 8082      # Custom port
    python3 remote_agent.py --host 0.0.0.0   # Allow external connections (LAN only)
"""
import subprocess
import json
import re
import socket
import argparse
from pathlib import Path
from datetime import datetime, timezone
import time
from collections import Counter
from statistics import mean, median


# Configuration
CLAUDE_PROJECTS_DIR = Path.home() / ".claude" / "projects"
ACTIVE_CPU_THRESHOLD = 0.5
ACTIVE_RECENCY_SECONDS = 30
MAX_SESSION_AGE_HOURS = 24
MAX_CONTEXT_TOKENS = 200000

# Pricing for cost estimation (Claude 3.5 Sonnet)
PRICING = {
    'input_per_mtok': 3.00,
    'output_per_mtok': 15.00,
    'cache_read_per_mtok': 0.30,
    'cache_write_per_mtok': 3.75
}


def get_token_percentage(tokens: int) -> float:
    """Calculate token usage percentage of max context window."""
    return min(100, (tokens / MAX_CONTEXT_TOKENS) * 100)


def calculate_cost(usage: dict) -> float:
    """Calculate estimated cost from token usage."""
    input_tokens = usage.get('input_tokens', 0)
    output_tokens = usage.get('output_tokens', 0)
    cache_read = usage.get('cache_read_input_tokens', 0)
    cache_write = usage.get('cache_creation_input_tokens', 0)

    cost = (
        (input_tokens / 1_000_000) * PRICING['input_per_mtok'] +
        (output_tokens / 1_000_000) * PRICING['output_per_mtok'] +
        (cache_read / 1_000_000) * PRICING['cache_read_per_mtok'] +
        (cache_write / 1_000_000) * PRICING['cache_write_per_mtok']
    )

    return round(cost, 2)


def get_claude_processes() -> list[dict]:
    """Get all running claude CLI processes with metadata."""
    result = subprocess.run(["ps", "aux"], capture_output=True, text=True)
    processes = []

    for line in result.stdout.split('\n'):
        if 'claude' not in line.lower():
            continue
        if any(skip in line for skip in ['/bin/zsh', 'grep', 'Claude.app', 'node_modules', 'chrome-', '@claude-flow']):
            continue

        parts = line.split()
        if len(parts) < 11:
            continue

        cmd_start = parts[10]
        if cmd_start != 'claude':
            continue

        try:
            pid = int(parts[1])
            cpu = float(parts[2])
            tty = parts[6]
            state = parts[7]
            cmd = ' '.join(parts[10:])
        except (ValueError, IndexError):
            continue

        session_id = None
        if '--resume' in cmd:
            match = re.search(r'--resume\s+([a-f0-9-]{36})', cmd)
            if match:
                session_id = match.group(1)

        processes.append({
            'pid': pid,
            'cpu': cpu,
            'tty': tty,
            'state': state,
            'cmd': cmd,
            'session_id': session_id,
        })

    return processes


def extract_activity(content_item: dict) -> str | None:
    """Extract a one-sentence activity description from a content item."""
    item_type = content_item.get('type')

    if item_type == 'tool_use':
        tool_name = content_item.get('name', '')
        tool_input = content_item.get('input', {})

        if tool_name == 'Read':
            path = tool_input.get('file_path', '')
            filename = path.split('/')[-1] if path else 'file'
            return f"Reading {filename}"

        elif tool_name == 'Write':
            path = tool_input.get('file_path', '')
            filename = path.split('/')[-1] if path else 'file'
            return f"Writing {filename}"

        elif tool_name == 'Edit':
            path = tool_input.get('file_path', '')
            filename = path.split('/')[-1] if path else 'file'
            return f"Editing {filename}"

        elif tool_name == 'Bash':
            cmd = tool_input.get('command', '')[:50]
            desc = tool_input.get('description', '')
            if desc:
                return desc[:60]
            elif cmd:
                return f"Running: {cmd}"

        elif tool_name == 'Grep':
            pattern = tool_input.get('pattern', '')[:30]
            return f"Searching for '{pattern}'"

        elif tool_name == 'Glob':
            pattern = tool_input.get('pattern', '')[:30]
            return f"Finding files: {pattern}"

        elif tool_name == 'Task':
            desc = tool_input.get('description', '')[:50]
            return f"Spawning agent: {desc}" if desc else "Spawning agent"

        elif tool_name == 'TodoWrite':
            return "Updating task list"

        elif tool_name == 'WebFetch':
            url = tool_input.get('url', '')[:40]
            return f"Fetching {url}"

        elif tool_name:
            return f"Using {tool_name}"

    elif item_type == 'text':
        text = content_item.get('text', '').strip()
        if text:
            first_line = text.split('\n')[0][:100]
            if '. ' in first_line:
                return first_line.split('. ')[0] + '.'
            elif len(first_line) > 60:
                return first_line[:60] + '...'
            elif first_line:
                return first_line

    return None


def extract_jsonl_metadata(jsonl_file: Path) -> dict:
    """Extract metadata from a JSONL file."""
    metadata = {
        'sessionId': jsonl_file.stem,
        'slug': jsonl_file.stem,
        'cwd': '',
        'gitBranch': '',
        'summary': None,
        'contextTokens': 0,
        'timestamp': '',
        'startTimestamp': '',
        'file_mtime': jsonl_file.stat().st_mtime,
        'recentActivity': [],
    }

    cumulative_usage = {
        'input_tokens': 0,
        'output_tokens': 0,
        'cache_read_input_tokens': 0,
        'cache_creation_input_tokens': 0
    }

    try:
        file_size = jsonl_file.stat().st_size
        read_size = min(file_size, 100000)

        activities = []

        with open(jsonl_file, 'r') as f:
            for _ in range(20):
                line = f.readline()
                if not line:
                    break
                try:
                    data = json.loads(line.strip())
                    if data.get('timestamp'):
                        metadata['startTimestamp'] = data['timestamp']
                        break
                except (json.JSONDecodeError, ValueError):
                    continue

        with open(jsonl_file, 'rb') as f:
            if file_size > read_size:
                f.seek(file_size - read_size)
                f.readline()

            for line in f:
                try:
                    data = json.loads(line.decode('utf-8').strip())

                    if 'sessionId' in data:
                        metadata['sessionId'] = data['sessionId']
                    if 'slug' in data and data['slug']:
                        metadata['slug'] = data['slug']
                    if data.get('cwd'):
                        metadata['cwd'] = data['cwd']
                    if data.get('gitBranch'):
                        metadata['gitBranch'] = data['gitBranch']
                    if data.get('timestamp'):
                        metadata['timestamp'] = data['timestamp']

                    if data.get('type') == 'summary' and data.get('summary'):
                        metadata['summary'] = data['summary']

                    if data.get('type') == 'assistant' and isinstance(data.get('message'), dict):
                        msg = data['message']
                        usage = msg.get('usage', {})
                        if usage:
                            metadata['contextTokens'] = (
                                usage.get('cache_read_input_tokens', 0) +
                                usage.get('input_tokens', 0)
                            )

                            cumulative_usage['input_tokens'] += usage.get('input_tokens', 0)
                            cumulative_usage['output_tokens'] += usage.get('output_tokens', 0)
                            cumulative_usage['cache_read_input_tokens'] += usage.get('cache_read_input_tokens', 0)
                            cumulative_usage['cache_creation_input_tokens'] += usage.get('cache_creation_input_tokens', 0)

                        content = msg.get('content', [])
                        msg_timestamp = data.get('timestamp', '')
                        for item in content:
                            activity = extract_activity(item)
                            if activity:
                                activities.append({
                                    'text': activity,
                                    'timestamp': msg_timestamp
                                })

                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue

        metadata['recentActivity'] = activities[-10:] if activities else []
        metadata['tokenPercentage'] = get_token_percentage(metadata['contextTokens'])
        metadata['estimatedCost'] = calculate_cost(cumulative_usage)
        metadata['cumulativeUsage'] = cumulative_usage

    except Exception:
        pass

    return metadata


def get_session_metadata(session_id: str) -> dict | None:
    """Get metadata for a specific session ID from its JSONL file."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return None

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        jsonl_file = project_dir / f"{session_id}.jsonl"
        if jsonl_file.exists():
            return extract_jsonl_metadata(jsonl_file)

    return None


def get_all_sessions(max_age_hours: int = 24) -> list[dict]:
    """Get all sessions modified within max_age_hours."""
    if not CLAUDE_PROJECTS_DIR.exists():
        return []

    now = time.time()
    cutoff = now - (max_age_hours * 3600)
    results = []

    for project_dir in CLAUDE_PROJECTS_DIR.iterdir():
        if not project_dir.is_dir():
            continue

        for jsonl_file in project_dir.glob("*.jsonl"):
            if jsonl_file.stem.startswith('agent-'):
                continue

            try:
                mtime = jsonl_file.stat().st_mtime
                if mtime > cutoff:
                    metadata = extract_jsonl_metadata(jsonl_file)
                    metadata['recency'] = now - mtime
                    results.append(metadata)
            except:
                continue

    results.sort(key=lambda x: x['recency'])
    return results


def get_sessions() -> list[dict]:
    """Get all running Claude sessions with metadata and activity state."""
    processes = get_claude_processes()
    result = []
    now = time.time()

    all_sessions = get_all_sessions(max_age_hours=24)

    processes.sort(key=lambda x: x['tty'])
    all_sessions.sort(key=lambda x: x['sessionId'])

    used_session_ids = set()
    session_by_id = {s['sessionId']: s for s in all_sessions}

    for proc in processes:
        metadata = None

        # Method 1: Use --resume session ID if available
        if proc['session_id']:
            metadata = get_session_metadata(proc['session_id'])
            if metadata:
                used_session_ids.add(metadata['sessionId'])

        # Method 2: Stable heuristic - match in order
        if not metadata:
            for session in all_sessions:
                if session['sessionId'] not in used_session_ids:
                    metadata = session
                    used_session_ids.add(session['sessionId'])
                    break

        if not metadata:
            continue

        recency = metadata.get('recency', now - metadata.get('file_mtime', 0))
        file_recently_modified = recency < ACTIVE_RECENCY_SECONDS
        high_cpu = proc['cpu'] > ACTIVE_CPU_THRESHOLD
        state = 'active' if (file_recently_modified or high_cpu) else 'waiting'

        result.append({
            'sessionId': metadata['sessionId'],
            'slug': metadata['slug'],
            'cwd': metadata['cwd'],
            'gitBranch': metadata.get('gitBranch', ''),
            'summary': metadata.get('summary'),
            'contextTokens': metadata.get('contextTokens', 0),
            'recentActivity': metadata.get('recentActivity', []),
            'pid': proc['pid'],
            'tty': proc['tty'],
            'cpuPercent': proc['cpu'],
            'lastActivity': metadata.get('timestamp', ''),
            'state': state,
            'tokenPercentage': metadata.get('tokenPercentage', 0),
            'estimatedCost': metadata.get('estimatedCost', 0),
            'cumulativeUsage': metadata.get('cumulativeUsage', {}),
        })

    result.sort(key=lambda x: (-1 if x['state'] == 'active' else 0, -x['cpuPercent']))
    return result


# FastAPI app
try:
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn

    app = FastAPI(title="Claude Session Remote Agent")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/sessions")
    def api_get_sessions():
        """Get all running Claude sessions on this machine."""
        sessions = get_sessions()
        return {
            "sessions": sessions,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "hostname": socket.gethostname()
        }

    @app.get("/health")
    def health():
        """Health check endpoint."""
        return {
            "status": "ok",
            "hostname": socket.gethostname(),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }

    def main():
        parser = argparse.ArgumentParser(description="Claude Session Remote Agent")
        parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
        parser.add_argument('--port', type=int, default=8081, help='Port to bind to')
        args = parser.parse_args()

        print(f"Starting Claude Session Remote Agent on {args.host}:{args.port}")
        print(f"Hostname: {socket.gethostname()}")
        uvicorn.run(app, host=args.host, port=args.port)

except ImportError:
    # Fallback for machines without FastAPI - use simple HTTP server
    from http.server import HTTPServer, BaseHTTPRequestHandler

    class SimpleHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/sessions':
                sessions = get_sessions()
                response = json.dumps({
                    "sessions": sessions,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "hostname": socket.gethostname()
                })
            elif self.path == '/health':
                response = json.dumps({
                    "status": "ok",
                    "hostname": socket.gethostname(),
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
            else:
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(response.encode())

        def log_message(self, format, *args):
            # Quiet logging
            pass

    def main():
        parser = argparse.ArgumentParser(description="Claude Session Remote Agent")
        parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
        parser.add_argument('--port', type=int, default=8081, help='Port to bind to')
        args = parser.parse_args()

        server = HTTPServer((args.host, args.port), SimpleHandler)
        print(f"Starting Claude Session Remote Agent on {args.host}:{args.port}")
        print(f"Hostname: {socket.gethostname()}")
        server.serve_forever()


if __name__ == "__main__":
    main()

# claude-session-visualizer

A real-time web dashboard for monitoring and managing Claude Code sessions. See what your AI agents are doing, watch tool calls as they happen, and interact with sessions through a browser-based UI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)

## What It Does

When you run Claude Code sessions — especially multiple agents working in parallel — it's hard to track what's happening across all of them. This dashboard gives you:

- **Real-time session detection** — Automatically discovers running Claude Code sessions on your machine
- **Live activity streaming** — Watch tool calls, file edits, and conversation turns as they happen via WebSocket
- **Session management** — Start, stop, and interact with sessions from the browser
- **SDK integration** — Launch and manage sessions programmatically via the Claude Agent SDK
- **Analytics** — Track session metrics, tool usage patterns, and activity over time

## Quick Start

```bash
# Clone and install
git clone https://github.com/NathanNorman/claude-session-visualizer.git
cd claude-session-visualizer
pip install -e .

# Start the dashboard
uvicorn src.api.server:app --reload
```

Visit `http://localhost:8000` to see the dashboard.

## Architecture

```
claude-session-visualizer/
├── src/
│   ├── api/                  # FastAPI backend
│   │   ├── server.py         # Main application server
│   │   ├── session_detector.py  # Discovers running Claude Code sessions
│   │   ├── process_manager.py   # Session lifecycle management
│   │   ├── sdk_session_manager.py  # Claude Agent SDK integration
│   │   ├── websocket.py      # Real-time streaming to frontend
│   │   ├── analytics.py      # Session metrics and tracking
│   │   ├── routes/            # API endpoint modules
│   │   └── services/          # Business logic layer
│   └── frontend/             # Browser-based dashboard
│       ├── index.html        # Main dashboard page
│       ├── app.js            # Frontend application logic
│       └── styles.css        # Dashboard styling
├── tests/                    # pytest test suite
├── pyproject.toml            # Python project configuration
├── vitest.config.js          # Frontend unit test config
└── playwright.config.js      # E2E test config
```

**Backend:** Python with FastAPI, serving both the REST API and WebSocket connections. Session detection works by scanning for active Claude Code processes and their associated JSONL transcript files.

**Frontend:** Vanilla JavaScript with a custom terminal-style UI. Connects to the backend via WebSocket for real-time updates. No build step required.

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Run the server in development mode
uvicorn src.api.server:app --reload

# Run backend tests
pytest

# Run frontend tests
npm test

# Run E2E tests
npm run test:e2e

# Lint and type check
ruff check src/
mypy src/
```

## Tech Stack

- **Backend:** Python 3.10+, FastAPI, uvicorn
- **Frontend:** Vanilla JS, WebSocket API
- **SDK:** [Claude Agent SDK](https://github.com/anthropics/claude-code-sdk-python) for programmatic session management
- **Testing:** pytest (backend), vitest (frontend unit), Playwright (E2E)
- **Linting:** ruff, mypy

## License

MIT

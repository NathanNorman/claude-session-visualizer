#!/usr/bin/env python3
"""Simple WebSocket test client for the session visualizer.

Usage:
    python ws_test_client.py [--url URL]

Connects to the WebSocket endpoint and displays session updates in real-time.
"""

import asyncio
import json
import sys
from datetime import datetime

try:
    import websockets
except ImportError:
    print("Please install websockets: pip install websockets")
    sys.exit(1)


async def test_client(url: str = "ws://localhost:8765/ws/sessions"):
    """Connect to WebSocket and display updates."""
    print(f"Connecting to {url}...")

    try:
        async with websockets.connect(url) as ws:
            print("Connected! Waiting for updates...\n")

            # Send a ping to test bidirectional communication
            await ws.send(json.dumps({"type": "ping"}))

            while True:
                try:
                    message = await ws.recv()
                    data = json.loads(message)

                    msg_type = data.get('type', 'unknown')
                    timestamp = data.get('timestamp', datetime.now().isoformat())

                    if msg_type == 'pong':
                        print(f"[{timestamp[:19]}] Pong received")

                    elif msg_type == 'sessions_update':
                        sessions = data.get('sessions', [])
                        print(f"\n[{timestamp[:19]}] Sessions Update ({len(sessions)} sessions)")
                        print("-" * 60)

                        for s in sessions:
                            state_icon = "🟢" if s.get('state') == 'active' else "🟡"
                            activity = s.get('currentActivity') or (s.get('recentActivity', [''])[-1] if s.get('recentActivity') else '')
                            activity = activity[:50] if activity else 'No recent activity'

                            print(f"  {state_icon} {s.get('slug', 'unknown')[:20]:20} | {s.get('contextTokens', 0):,} tokens")
                            print(f"     └─ {activity}")

                        print("-" * 60)

                    else:
                        print(f"[{timestamp[:19]}] Unknown message type: {msg_type}")

                except websockets.ConnectionClosed:
                    print("\nConnection closed by server")
                    break

    except ConnectionRefusedError:
        print(f"Error: Could not connect to {url}")
        print("Make sure the server is running: uvicorn server:app --port 8765")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


def main():
    url = "ws://localhost:8765/ws/sessions"

    # Parse command line args
    if len(sys.argv) > 1:
        if sys.argv[1] == "--url" and len(sys.argv) > 2:
            url = sys.argv[2]
        elif sys.argv[1] in ["-h", "--help"]:
            print(__doc__)
            sys.exit(0)
        else:
            url = sys.argv[1]

    print("WebSocket Test Client")
    print("=" * 60)
    print(f"Target: {url}")
    print("Press Ctrl+C to exit\n")

    try:
        asyncio.run(test_client(url))
    except KeyboardInterrupt:
        print("\n\nDisconnected.")


if __name__ == "__main__":
    main()

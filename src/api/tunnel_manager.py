"""
SSH Tunnel Manager for Multi-Machine Support.

Manages SSH tunnels to remote machines running the Claude Session Remote Agent.
Handles connection lifecycle, auto-reconnection, and session aggregation.
"""
import subprocess
import threading
import time
import socket
import json
from dataclasses import dataclass, field
from typing import Optional
from pathlib import Path
from datetime import datetime, timezone
import requests

from .logging_config import get_logger

# Create tunnel logger
logger = get_logger(__name__, namespace='tunnel')


# Configuration file for persisting machine connections
CONFIG_DIR = Path.home() / ".claude" / "visualizer"
MACHINES_CONFIG = CONFIG_DIR / "machines.json"


@dataclass
class SSHTunnel:
    """Manages a single SSH tunnel to a remote machine."""
    name: str
    host: str
    local_port: int
    remote_port: int = 8081
    ssh_key: Optional[str] = None
    auto_reconnect: bool = True

    process: Optional[subprocess.Popen] = field(default=None, repr=False)
    connected: bool = False
    last_error: Optional[str] = None
    last_health_check: Optional[datetime] = None

    def connect(self) -> bool:
        """Establish SSH tunnel.

        Returns:
            True if connection succeeded, False otherwise.
        """
        if self.is_connected():
            return True

        # Build SSH command
        cmd = [
            'ssh', '-N', '-L',
            f'{self.local_port}:localhost:{self.remote_port}',
            '-o', 'ServerAliveInterval=30',  # Keep alive every 30s
            '-o', 'ServerAliveCountMax=3',   # Disconnect after 3 missed keepalives
            '-o', 'ExitOnForwardFailure=yes',
            '-o', 'StrictHostKeyChecking=accept-new',
            self.host
        ]

        if self.ssh_key:
            cmd.extend(['-i', self.ssh_key])

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )

            # Wait for connection or failure
            time.sleep(2)

            if self.process.poll() is None:
                # Process still running - tunnel established
                self.connected = True
                self.last_error = None
                return True
            else:
                # Process exited - connection failed
                _, stderr = self.process.communicate()
                self.last_error = stderr.decode().strip()
                self.connected = False
                return False

        except Exception as e:
            self.last_error = str(e)
            self.connected = False
            return False

    def disconnect(self):
        """Close SSH tunnel."""
        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except:
                self.process.kill()
            self.process = None
        self.connected = False

    def is_connected(self) -> bool:
        """Check if tunnel is still active."""
        if self.process and self.process.poll() is None:
            return True
        self.connected = False
        return False

    def get_sessions(self, timeout: float = 5.0) -> dict:
        """Fetch sessions from the remote agent.

        Args:
            timeout: Request timeout in seconds.

        Returns:
            Dict with 'sessions' list or 'error' string.
        """
        if not self.is_connected():
            return {'error': 'Disconnected'}

        try:
            response = requests.get(
                f'http://localhost:{self.local_port}/sessions',
                timeout=timeout
            )
            response.raise_for_status()
            data = response.json()
            self.last_health_check = datetime.now(timezone.utc)
            return data
        except requests.exceptions.Timeout:
            return {'error': 'Timeout fetching sessions'}
        except requests.exceptions.ConnectionError:
            return {'error': 'Connection refused'}
        except Exception as e:
            return {'error': str(e)}

    def health_check(self, timeout: float = 2.0) -> bool:
        """Check if the remote agent is responding.

        Returns:
            True if healthy, False otherwise.
        """
        if not self.is_connected():
            return False

        try:
            response = requests.get(
                f'http://localhost:{self.local_port}/health',
                timeout=timeout
            )
            response.raise_for_status()
            self.last_health_check = datetime.now(timezone.utc)
            return True
        except:
            return False

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            'name': self.name,
            'host': self.host,
            'local_port': self.local_port,
            'remote_port': self.remote_port,
            'ssh_key': self.ssh_key,
            'auto_reconnect': self.auto_reconnect,
            'connected': self.is_connected(),
            'last_error': self.last_error,
            'last_health_check': self.last_health_check.isoformat() if self.last_health_check else None
        }


class TunnelManager:
    """Manages multiple SSH tunnels to remote machines."""

    def __init__(self):
        self.tunnels: dict[str, SSHTunnel] = {}
        self.next_port = 8100
        self._lock = threading.Lock()
        self._monitor_thread: Optional[threading.Thread] = None
        self._running = False

        # Load saved machines
        self._load_config()

    def _load_config(self):
        """Load saved machine configurations."""
        if not MACHINES_CONFIG.exists():
            return

        try:
            with open(MACHINES_CONFIG) as f:
                config = json.load(f)

            for machine in config.get('machines', []):
                # Restore tunnel without connecting
                tunnel = SSHTunnel(
                    name=machine['name'],
                    host=machine['host'],
                    local_port=machine.get('local_port', self._get_next_port()),
                    remote_port=machine.get('remote_port', 8081),
                    ssh_key=machine.get('ssh_key'),
                    auto_reconnect=machine.get('auto_reconnect', True)
                )
                self.tunnels[machine['name']] = tunnel

                # Update next_port to avoid conflicts
                if tunnel.local_port >= self.next_port:
                    self.next_port = tunnel.local_port + 1

        except Exception as e:
            logger.error(f"Error loading tunnel config: {e}")

    def _save_config(self):
        """Save machine configurations."""
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)

        config = {
            'machines': [
                {
                    'name': t.name,
                    'host': t.host,
                    'local_port': t.local_port,
                    'remote_port': t.remote_port,
                    'ssh_key': t.ssh_key,
                    'auto_reconnect': t.auto_reconnect
                }
                for t in self.tunnels.values()
            ]
        }

        try:
            with open(MACHINES_CONFIG, 'w') as f:
                json.dump(config, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving tunnel config: {e}")

    def _get_next_port(self) -> int:
        """Get next available local port."""
        port = self.next_port
        self.next_port += 1
        return port

    def add_machine(self, name: str, host: str, ssh_key: str = None,
                    auto_reconnect: bool = True) -> dict:
        """Add and connect to a remote machine.

        Args:
            name: Display name for the machine.
            host: SSH host (user@host or just host).
            ssh_key: Optional path to SSH key.
            auto_reconnect: Whether to auto-reconnect on disconnect.

        Returns:
            Dict with status and tunnel info.
        """
        with self._lock:
            if name in self.tunnels:
                return {'error': f'Machine "{name}" already exists'}

            local_port = self._get_next_port()
            tunnel = SSHTunnel(
                name=name,
                host=host,
                local_port=local_port,
                ssh_key=ssh_key,
                auto_reconnect=auto_reconnect
            )

            if tunnel.connect():
                self.tunnels[name] = tunnel
                self._save_config()
                return {
                    'status': 'connected',
                    'name': name,
                    'port': local_port
                }
            else:
                return {
                    'error': f'Failed to connect: {tunnel.last_error}',
                    'name': name
                }

    def remove_machine(self, name: str) -> dict:
        """Disconnect and remove a machine.

        Args:
            name: Machine name to remove.

        Returns:
            Dict with status.
        """
        with self._lock:
            if name not in self.tunnels:
                return {'error': f'Machine "{name}" not found'}

            self.tunnels[name].disconnect()
            del self.tunnels[name]
            self._save_config()

            return {'status': 'removed', 'name': name}

    def reconnect_machine(self, name: str) -> dict:
        """Reconnect to a machine.

        Args:
            name: Machine name to reconnect.

        Returns:
            Dict with status.
        """
        with self._lock:
            if name not in self.tunnels:
                return {'error': f'Machine "{name}" not found'}

            tunnel = self.tunnels[name]
            tunnel.disconnect()

            if tunnel.connect():
                return {'status': 'connected', 'name': name}
            else:
                return {'error': f'Failed to reconnect: {tunnel.last_error}'}

    def list_machines(self) -> list[dict]:
        """List all machines with their status.

        Returns:
            List of machine info dicts.
        """
        with self._lock:
            return [tunnel.to_dict() for tunnel in self.tunnels.values()]

    def get_all_sessions(self) -> dict:
        """Fetch sessions from all connected machines.

        Returns:
            Dict mapping machine name to session data or error.
        """
        results = {}

        with self._lock:
            for name, tunnel in self.tunnels.items():
                if tunnel.is_connected():
                    data = tunnel.get_sessions()
                    if 'error' not in data:
                        # Add machine name to each session
                        for session in data.get('sessions', []):
                            session['machine'] = name
                            session['machineHostname'] = data.get('hostname', name)
                    results[name] = data
                else:
                    results[name] = {'error': 'Disconnected'}

        return results

    def connect_all(self):
        """Connect to all configured machines."""
        with self._lock:
            for name, tunnel in self.tunnels.items():
                if not tunnel.is_connected():
                    tunnel.connect()

    def disconnect_all(self):
        """Disconnect from all machines."""
        with self._lock:
            for tunnel in self.tunnels.values():
                tunnel.disconnect()

    def start_monitor(self, interval: int = 30):
        """Start background thread to monitor and reconnect tunnels.

        Args:
            interval: Check interval in seconds.
        """
        if self._running:
            return

        self._running = True

        def monitor_loop():
            while self._running:
                time.sleep(interval)
                with self._lock:
                    for name, tunnel in self.tunnels.items():
                        if tunnel.auto_reconnect and not tunnel.is_connected():
                            logger.info(f"Reconnecting to {name}...")
                            tunnel.connect()

        self._monitor_thread = threading.Thread(target=monitor_loop, daemon=True)
        self._monitor_thread.start()

    def stop_monitor(self):
        """Stop the background monitor thread."""
        self._running = False
        if self._monitor_thread:
            self._monitor_thread.join(timeout=5)
            self._monitor_thread = None

    def test_connection(self, host: str, ssh_key: str = None, timeout: int = 10) -> dict:
        """Test SSH connection without persisting.

        Args:
            host: SSH host to test.
            ssh_key: Optional SSH key path.
            timeout: Connection timeout in seconds.

        Returns:
            Dict with test results.
        """
        # Test SSH connectivity
        cmd = ['ssh', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes']
        if ssh_key:
            cmd.extend(['-i', ssh_key])
        cmd.extend([host, 'echo', 'ok'])

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode == 0:
                return {
                    'status': 'success',
                    'message': 'SSH connection successful',
                    'host': host
                }
            else:
                return {
                    'status': 'error',
                    'message': result.stderr.strip() or 'SSH connection failed',
                    'host': host
                }
        except subprocess.TimeoutExpired:
            return {
                'status': 'error',
                'message': 'Connection timed out',
                'host': host
            }
        except Exception as e:
            return {
                'status': 'error',
                'message': str(e),
                'host': host
            }


# Singleton instance
_tunnel_manager: Optional[TunnelManager] = None


def get_tunnel_manager() -> TunnelManager:
    """Get the singleton TunnelManager instance."""
    global _tunnel_manager
    if _tunnel_manager is None:
        _tunnel_manager = TunnelManager()
    return _tunnel_manager

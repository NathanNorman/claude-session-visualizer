"""Multi-machine management routes."""

import time
import socket
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..session_detector import get_sessions
from ..tunnel_manager import get_tunnel_manager

router = APIRouter(prefix="/api", tags=["machines"])


class MachineRequest(BaseModel):
    name: str
    host: str
    ssh_key: Optional[str] = None
    auto_reconnect: bool = True


@router.get("/machines")
def list_machines():
    """List all configured remote machines with their connection status."""
    manager = get_tunnel_manager()
    return {
        "machines": manager.list_machines(),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@router.post("/machines")
def add_machine(request: MachineRequest):
    """Add and connect to a remote machine."""
    manager = get_tunnel_manager()
    result = manager.add_machine(
        name=request.name,
        host=request.host,
        ssh_key=request.ssh_key,
        auto_reconnect=request.auto_reconnect
    )

    if 'error' in result:
        raise HTTPException(400, result['error'])

    return result


@router.delete("/machines/{name}")
def remove_machine(name: str):
    """Disconnect and remove a remote machine."""
    manager = get_tunnel_manager()
    result = manager.remove_machine(name)

    if 'error' in result:
        raise HTTPException(404, result['error'])

    return result


@router.post("/machines/{name}/reconnect")
def reconnect_machine(name: str):
    """Reconnect to a remote machine."""
    manager = get_tunnel_manager()
    result = manager.reconnect_machine(name)

    if 'error' in result:
        raise HTTPException(400, result['error'])

    return result


@router.post("/machines/test")
def test_machine_connection(host: str, ssh_key: Optional[str] = None):
    """Test SSH connection to a host without persisting."""
    manager = get_tunnel_manager()
    return manager.test_connection(host, ssh_key)


@router.get("/sessions/all")
def get_all_sessions_multi_machine(include_summaries: bool = False):
    """Get sessions from all machines (local + remote)."""
    # Import here to avoid circular imports
    from ..server import _summary_cache, SUMMARY_TTL, BEDROCK_TOKEN_FILE

    local_sessions = get_sessions()

    if include_summaries and BEDROCK_TOKEN_FILE.exists():
        for session in local_sessions:
            cached = _summary_cache.get(session['sessionId'])
            if cached and (time.time() - cached['timestamp']) < SUMMARY_TTL:
                session['aiSummary'] = cached['summary']

    local_hostname = socket.gethostname()
    for session in local_sessions:
        session['machine'] = 'local'
        session['machineHostname'] = local_hostname

    manager = get_tunnel_manager()
    remote_sessions = manager.get_all_sessions()

    local_active = sum(1 for s in local_sessions if s.get('state') == 'active')
    local_waiting = len(local_sessions) - local_active

    remote_totals = {}
    for name, data in remote_sessions.items():
        if 'error' not in data:
            sessions = data.get('sessions', [])
            active = sum(1 for s in sessions if s.get('state') == 'active')
            remote_totals[name] = {'active': active, 'waiting': len(sessions) - active}
        else:
            remote_totals[name] = {'error': data['error']}

    return {
        "local": {
            "sessions": local_sessions,
            "hostname": local_hostname,
            "totals": {"active": local_active, "waiting": local_waiting}
        },
        "remote": remote_sessions,
        "remoteTotals": remote_totals,
        "machineCount": 1 + len([r for r in remote_sessions.values() if 'error' not in r]),
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

"""Template management routes."""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api", tags=["templates"])

# Templates directory
TEMPLATES_DIR = Path.home() / ".claude" / "templates"
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)


class Template(BaseModel):
    name: str
    description: str
    icon: str = ""
    config: dict


@router.get("/templates")
def list_templates():
    """List all saved templates."""
    templates = []
    for f in TEMPLATES_DIR.glob("*.json"):
        try:
            with open(f) as fp:
                templates.append(json.load(fp))
        except Exception as e:
            print(f"Error loading template {f}: {e}")
    return {"templates": templates}


@router.post("/templates")
def create_template(template: Template):
    """Create a new template."""
    template_id = str(uuid.uuid4())
    template_data = {
        "id": template_id,
        "name": template.name,
        "description": template.description,
        "icon": template.icon,
        "config": template.config,
        "created": datetime.now(timezone.utc).isoformat(),
        "updated": datetime.now(timezone.utc).isoformat()
    }

    with open(TEMPLATES_DIR / f"{template_id}.json", "w") as f:
        json.dump(template_data, f, indent=2)

    return template_data


@router.delete("/templates/{template_id}")
def delete_template(template_id: str):
    """Delete a template."""
    path = TEMPLATES_DIR / f"{template_id}.json"
    if path.exists():
        path.unlink()
        return {"deleted": True}
    raise HTTPException(404, "Template not found")


@router.post("/templates/{template_id}/use")
def use_template(template_id: str, request: dict):
    """Start a new session from a template."""
    path = TEMPLATES_DIR / f"{template_id}.json"
    if not path.exists():
        raise HTTPException(404, "Template not found")

    with open(path) as f:
        template = json.load(f)

    return {
        "template": template,
        "config": template.get("config", {})
    }

"""Route module for discovering Claude Code skills and commands."""

import re
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/api/skills", tags=["skills"])


def parse_frontmatter(content: str) -> dict:
    """Parse YAML frontmatter from a SKILL.md or command file."""
    frontmatter = {}

    # Check for YAML frontmatter between --- markers
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if match:
        yaml_content = match.group(1)
        lines = yaml_content.split('\n')
        current_key = None
        current_value_lines = []

        for line in lines:
            # Check if this is a new key (not indented, has colon)
            if line and not line[0].isspace() and ':' in line:
                # Save previous key if exists
                if current_key is not None:
                    value = ' '.join(current_value_lines).strip()
                    value = value.strip('"').strip("'")
                    if value.lower() == 'true':
                        value = True
                    elif value.lower() == 'false':
                        value = False
                    elif value in ('>', '|', '>-', '|-'):
                        value = ''  # Multi-line indicator, value comes next
                    frontmatter[current_key] = value

                # Start new key
                key, _, value = line.partition(':')
                current_key = key.strip()
                value = value.strip()
                # Handle multi-line indicators
                if value in ('>', '|', '>-', '|-'):
                    current_value_lines = []
                else:
                    current_value_lines = [value] if value else []
            elif current_key is not None:
                # Continuation line for multi-line value
                current_value_lines.append(line.strip())

        # Don't forget the last key
        if current_key is not None:
            value = ' '.join(current_value_lines).strip()
            value = value.strip('"').strip("'")
            if value.lower() == 'true':
                value = True
            elif value.lower() == 'false':
                value = False
            frontmatter[current_key] = value

    return frontmatter


def extract_description_from_content(content: str) -> str:
    """Extract first paragraph as description if no frontmatter description."""
    # Remove frontmatter
    content = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, flags=re.DOTALL)

    # Get first non-empty paragraph
    paragraphs = content.strip().split('\n\n')
    for p in paragraphs:
        p = p.strip()
        # Skip headers
        if p and not p.startswith('#'):
            # Clean up and truncate
            p = re.sub(r'\s+', ' ', p)
            return p[:200] + '...' if len(p) > 200 else p

    return ''


def scan_skills_directory(base_path: Path, source: str) -> list[dict]:
    """Scan a skills directory for SKILL.md files."""
    skills = []

    if not base_path.exists():
        return skills

    for skill_dir in base_path.iterdir():
        if not skill_dir.is_dir():
            continue

        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue

        try:
            content = skill_file.read_text(encoding='utf-8')
            frontmatter = parse_frontmatter(content)

            name = frontmatter.get('name', skill_dir.name)
            description = frontmatter.get('description', '')

            if not description:
                description = extract_description_from_content(content)

            skill = {
                'name': name,
                'description': description,
                'source': source,
                'path': str(skill_file),
                'category': categorize_skill(name, description),
                'userInvocable': frontmatter.get('user-invocable', True),
                'disableModelInvocation': frontmatter.get('disable-model-invocation', False),
            }

            # Include optional fields if present
            if 'argument-hint' in frontmatter:
                skill['argumentHint'] = frontmatter['argument-hint']
            if 'context' in frontmatter:
                skill['context'] = frontmatter['context']
            if 'agent' in frontmatter:
                skill['agent'] = frontmatter['agent']

            skills.append(skill)

        except Exception:
            # Skip files that can't be read
            continue

    return skills


def scan_commands_directory(base_path: Path, source: str) -> list[dict]:
    """Scan a commands directory for .md files (legacy format)."""
    commands = []

    if not base_path.exists():
        return commands

    for cmd_file in base_path.glob("*.md"):
        try:
            content = cmd_file.read_text(encoding='utf-8')
            frontmatter = parse_frontmatter(content)

            name = frontmatter.get('name', cmd_file.stem)
            description = frontmatter.get('description', '')

            if not description:
                description = extract_description_from_content(content)

            command = {
                'name': name,
                'description': description,
                'source': source,
                'path': str(cmd_file),
                'category': categorize_skill(name, description),
                'isLegacyCommand': True,
                'userInvocable': frontmatter.get('user-invocable', True),
                'disableModelInvocation': frontmatter.get('disable-model-invocation', False),
            }

            commands.append(command)

        except Exception:
            continue

    return commands


def categorize_skill(name: str, description: str) -> str:
    """Attempt to categorize a skill based on name and description."""
    name_lower = name.lower()
    desc_lower = description.lower()

    # Git-related
    if any(kw in name_lower or kw in desc_lower for kw in ['git', 'commit', 'pr', 'pull request', 'branch', 'merge']):
        return 'Git'

    # Code-related
    if any(kw in name_lower or kw in desc_lower for kw in ['code', 'review', 'refactor', 'debug', 'test', 'lint', 'format']):
        return 'Code'

    # Documentation
    if any(kw in name_lower or kw in desc_lower for kw in ['doc', 'readme', 'markdown', 'comment']):
        return 'Docs'

    # DevOps
    if any(kw in name_lower or kw in desc_lower for kw in ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'aws', 'cloud']):
        return 'DevOps'

    # Data
    if any(kw in name_lower or kw in desc_lower for kw in ['data', 'database', 'db', 'sql', 'query', 'analytics']):
        return 'Data'

    # Learning
    if any(kw in name_lower or kw in desc_lower for kw in ['explain', 'learn', 'teach', 'understand', 'tutorial']):
        return 'Learning'

    # Setup
    if any(kw in name_lower or kw in desc_lower for kw in ['init', 'setup', 'config', 'install']):
        return 'Setup'

    return 'Custom'


@router.get("")
def get_all_skills(include_hidden: bool = False):
    """
    Get all available skills and commands.

    Scans:
    - ~/.claude/skills/ (personal skills)
    - .claude/skills/ (project skills, relative to common project roots)
    - ~/.claude/commands/ (legacy personal commands)
    - .claude/commands/ (legacy project commands)

    Args:
        include_hidden: If True, include skills with user-invocable: false
    """
    home = Path.home()
    all_skills = []
    seen_names = set()

    # Scan personal skills (highest priority after enterprise)
    personal_skills_dir = home / ".claude" / "skills"
    for skill in scan_skills_directory(personal_skills_dir, "personal"):
        if skill['userInvocable'] or include_hidden:
            all_skills.append(skill)
            seen_names.add(skill['name'])

    # Scan personal commands (legacy)
    personal_commands_dir = home / ".claude" / "commands"
    for cmd in scan_commands_directory(personal_commands_dir, "personal"):
        if cmd['name'] not in seen_names and (cmd['userInvocable'] or include_hidden):
            all_skills.append(cmd)
            seen_names.add(cmd['name'])

    # Scan project skills from common locations
    # Check current working directory and common project roots
    project_roots = [
        Path.cwd(),
        home / "Projects",
        home / "Developer",
        home / "Code",
    ]

    for root in project_roots:
        if not root.exists():
            continue

        # Direct .claude in root
        project_skills_dir = root / ".claude" / "skills"
        for skill in scan_skills_directory(project_skills_dir, f"project:{root.name}"):
            if skill['name'] not in seen_names and (skill['userInvocable'] or include_hidden):
                all_skills.append(skill)
                seen_names.add(skill['name'])

        project_commands_dir = root / ".claude" / "commands"
        for cmd in scan_commands_directory(project_commands_dir, f"project:{root.name}"):
            if cmd['name'] not in seen_names and (cmd['userInvocable'] or include_hidden):
                all_skills.append(cmd)
                seen_names.add(cmd['name'])

    # Sort by category then name
    all_skills.sort(key=lambda s: (s['category'], s['name']))

    # Group by category for easier frontend consumption
    by_category = {}
    for skill in all_skills:
        cat = skill['category']
        if cat not in by_category:
            by_category[cat] = []
        by_category[cat].append(skill)

    return {
        "skills": all_skills,
        "byCategory": by_category,
        "count": len(all_skills),
        "sources": {
            "personal": str(personal_skills_dir),
            "personalCommands": str(personal_commands_dir),
        }
    }


@router.get("/{skill_name}")
def get_skill_details(skill_name: str):
    """Get detailed information about a specific skill."""
    home = Path.home()

    # Search order: personal skills, personal commands, project skills
    search_paths = [
        (home / ".claude" / "skills" / skill_name / "SKILL.md", "personal"),
        (home / ".claude" / "commands" / f"{skill_name}.md", "personal"),
    ]

    for skill_path, source in search_paths:
        if skill_path.exists():
            try:
                content = skill_path.read_text(encoding='utf-8')
                frontmatter = parse_frontmatter(content)

                # Remove frontmatter from content for display
                body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, flags=re.DOTALL)

                return {
                    "name": frontmatter.get('name', skill_name),
                    "description": frontmatter.get('description', extract_description_from_content(content)),
                    "source": source,
                    "path": str(skill_path),
                    "frontmatter": frontmatter,
                    "content": body.strip(),
                }
            except Exception as e:
                return {"error": f"Failed to read skill: {e}"}

    return {"error": f"Skill '{skill_name}' not found"}

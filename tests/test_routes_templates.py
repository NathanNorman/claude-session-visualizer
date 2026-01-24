"""Tests for template management routes."""

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.api.server import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def temp_templates_dir(tmp_path):
    """Create a temporary templates directory."""
    templates_dir = tmp_path / "templates"
    templates_dir.mkdir()
    return templates_dir


class TestListTemplates:
    """Tests for GET /api/templates endpoint."""

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_returns_empty_list(self, mock_dir, client, tmp_path):
        """Test returns empty list when no templates."""
        mock_dir.glob.return_value = []

        response = client.get('/api/templates')

        assert response.status_code == 200
        assert response.json()['templates'] == []

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_returns_templates(self, mock_dir, client, tmp_path):
        """Test returns list of templates."""
        # Create temp template files
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()

        template1 = templates_dir / "t1.json"
        template1.write_text(json.dumps({
            'id': 't1', 'name': 'Template 1', 'description': 'Desc 1'
        }))

        template2 = templates_dir / "t2.json"
        template2.write_text(json.dumps({
            'id': 't2', 'name': 'Template 2', 'description': 'Desc 2'
        }))

        mock_dir.glob.return_value = [template1, template2]

        response = client.get('/api/templates')

        assert response.status_code == 200
        templates = response.json()['templates']
        assert len(templates) == 2

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_skips_invalid_json(self, mock_dir, client, tmp_path):
        """Test skips files with invalid JSON."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()

        valid = templates_dir / "valid.json"
        valid.write_text(json.dumps({'id': 'valid', 'name': 'Valid'}))

        invalid = templates_dir / "invalid.json"
        invalid.write_text("not valid json")

        mock_dir.glob.return_value = [valid, invalid]

        response = client.get('/api/templates')

        # Should return only the valid template
        assert response.status_code == 200
        templates = response.json()['templates']
        assert len(templates) == 1
        assert templates[0]['id'] == 'valid'


class TestCreateTemplate:
    """Tests for POST /api/templates endpoint."""

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_creates_template(self, mock_dir, client, tmp_path):
        """Test creates a new template."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()
        mock_dir.__truediv__ = lambda self, x: templates_dir / x

        response = client.post('/api/templates', json={
            'name': 'New Template',
            'description': 'A new template',
            'icon': '🚀',
            'config': {'key': 'value'}
        })

        assert response.status_code == 200
        data = response.json()
        assert data['name'] == 'New Template'
        assert data['description'] == 'A new template'
        assert data['icon'] == '🚀'
        assert data['config'] == {'key': 'value'}
        assert 'id' in data
        assert 'created' in data

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_creates_template_with_defaults(self, mock_dir, client, tmp_path):
        """Test creates template with default values."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()
        mock_dir.__truediv__ = lambda self, x: templates_dir / x

        response = client.post('/api/templates', json={
            'name': 'Minimal',
            'description': 'Minimal template',
            'config': {}
        })

        assert response.status_code == 200
        data = response.json()
        assert data['icon'] == ''  # Default empty icon


class TestDeleteTemplate:
    """Tests for DELETE /api/templates/{template_id} endpoint."""

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_deletes_template(self, mock_dir, client, tmp_path):
        """Test deletes an existing template."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()

        template_file = templates_dir / "test-id.json"
        template_file.write_text(json.dumps({'id': 'test-id'}))

        mock_dir.__truediv__ = lambda self, x: templates_dir / x

        response = client.delete('/api/templates/test-id')

        assert response.status_code == 200
        assert response.json()['deleted'] is True
        assert not template_file.exists()

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_delete_not_found(self, mock_dir, client, tmp_path):
        """Test 404 when template doesn't exist."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()
        mock_dir.__truediv__ = lambda self, x: templates_dir / x

        response = client.delete('/api/templates/nonexistent')

        assert response.status_code == 404


class TestUseTemplate:
    """Tests for POST /api/templates/{template_id}/use endpoint."""

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_use_template(self, mock_dir, client, tmp_path):
        """Test using a template."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()

        template_file = templates_dir / "test-id.json"
        template_data = {
            'id': 'test-id',
            'name': 'Test',
            'config': {'setting': 'value'}
        }
        template_file.write_text(json.dumps(template_data))

        mock_dir.__truediv__ = lambda self, x: templates_dir / x

        response = client.post('/api/templates/test-id/use', json={})

        assert response.status_code == 200
        data = response.json()
        assert data['template']['id'] == 'test-id'
        assert data['config'] == {'setting': 'value'}

    @patch('src.api.routes.templates.TEMPLATES_DIR')
    def test_use_template_not_found(self, mock_dir, client, tmp_path):
        """Test 404 when template doesn't exist."""
        templates_dir = tmp_path / "templates"
        templates_dir.mkdir()
        mock_dir.__truediv__ = lambda self, x: templates_dir / x

        response = client.post('/api/templates/nonexistent/use', json={})

        assert response.status_code == 404

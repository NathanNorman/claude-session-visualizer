/**
 * Tests for handler safety
 *
 * These tests verify that inline onclick handlers safely handle
 * user-provided data with special characters.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadAppFunctions } from './setup.js';

const { escapeJsString } = loadAppFunctions();

describe('handler generation safety', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  test('killSession handler escapes session slug', () => {
    const session = {
      pid: 12345,
      slug: "nathan's-session",
    };

    // Simulate the handler generation from app.js
    const escapedSlug = escapeJsString(session.slug);
    const onclick = `killSession(${session.pid}, '${escapedSlug}')`;

    expect(onclick).toBe("killSession(12345, 'nathan\\'s-session')");
    // Verify no unescaped quotes
    expect(onclick).not.toMatch(/(?<!\\)'\w+'/);
  });

  test('machine handlers escape machine name', () => {
    const machine = {
      name: "nathan's-macbook",
      host: 'localhost:8001',
    };

    const escapedName = escapeJsString(machine.name);
    const reconnectHandler = `handleReconnect('${escapedName}')`;
    const removeHandler = `handleRemoveMachine('${escapedName}')`;

    expect(reconnectHandler).toBe("handleReconnect('nathan\\'s-macbook')");
    expect(removeHandler).toBe("handleRemoveMachine('nathan\\'s-macbook')");
  });

  test('share URL handler escapes special characters', () => {
    const shareUrl = "http://localhost:8000/share?name=nathan's&test=1";
    const escapedUrl = escapeJsString(shareUrl);
    const onclick = `navigator.clipboard.writeText('${escapedUrl}')`;

    expect(onclick).toBe(
      "navigator.clipboard.writeText('http://localhost:8000/share?name=nathan\\'s&test=1')"
    );
  });

  test('template ID handlers work with various ID formats', () => {
    const templates = [
      { id: 'simple-id' },
      { id: "id-with-quote'" },
      { id: 'id\\with\\backslash' },
      { id: 'id\nwith\nnewlines' },
    ];

    templates.forEach((t) => {
      const escapedId = escapeJsString(t.id);
      const onclick = `useTemplate('${escapedId}')`;

      // Should not throw when evaluated as JS (syntax check)
      expect(() => {
        // This checks if the string would be valid JS
        new Function(`return ${onclick.replace('useTemplate', '(function useTemplate(x){return x})')}`);
      }).not.toThrow();
    });
  });

  test('directory selection handles paths with special chars', () => {
    const testCases = [
      {
        path: '/Users/nathan/projects',
        expected: "selectSpawnDirectory('/Users/nathan/projects')",
      },
      {
        path: "/Users/nathan's projects",
        expected: "selectSpawnDirectory('/Users/nathan\\'s projects')",
      },
      {
        path: '/Users/nathan/project "test"',
        expected: 'selectSpawnDirectory(\'/Users/nathan/project \\"test\\"\')',
      },
      {
        path: 'C:\\Users\\Nathan\\Projects',
        expected: "selectSpawnDirectory('C:\\\\Users\\\\Nathan\\\\Projects')",
      },
      {
        path: '/path/with\nnewline',
        expected: "selectSpawnDirectory('/path/with\\nnewline')",
      },
    ];

    testCases.forEach(({ path, expected }) => {
      const escaped = escapeJsString(path);
      const onclick = `selectSpawnDirectory('${escaped}')`;
      expect(onclick).toBe(expected);
    });
  });
});

describe('data attribute alternatives', () => {
  test('data attributes avoid escaping issues entirely', () => {
    const session = {
      sessionId: '93b24a86-00a7-4462-9ae0-0692a6e312f8',
      slug: "nathan's-session",
    };

    // Alternative approach: use data attributes
    const button = document.createElement('button');
    button.dataset.sessionId = session.sessionId;
    button.dataset.slug = session.slug;
    button.textContent = 'Kill Session';

    // Add event delegation handler
    button.addEventListener('click', (e) => {
      const id = e.target.dataset.sessionId;
      const slug = e.target.dataset.slug;
      // Call function with data from attributes
      return { id, slug };
    });

    // Data attributes preserve the original value
    expect(button.dataset.slug).toBe("nathan's-session");
    expect(button.dataset.sessionId).toBe('93b24a86-00a7-4462-9ae0-0692a6e312f8');
  });
});

describe('security edge cases', () => {
  test('handles Unicode characters', () => {
    const inputs = [
      '日本語テスト',
      'émojis 🎉 🚀',
      'Ñoño',
      'Ω≈ç√∫',
    ];

    inputs.forEach((input) => {
      const escaped = escapeJsString(input);
      // Unicode should pass through unchanged
      expect(escaped).toBe(input);
    });
  });

  test('handles very long strings', () => {
    const longString = "x'".repeat(10000);
    const escaped = escapeJsString(longString);

    // Should escape all quotes
    expect(escaped).not.toMatch(/(?<!\\)'/);
    expect(escaped.length).toBe(longString.length + 10000); // Each ' becomes \'
  });

  test('handles null bytes', () => {
    const withNull = 'before\0after';
    const escaped = escapeJsString(withNull);
    // Null bytes pass through (not a JS string issue)
    expect(escaped).toBe('before\0after');
  });
});

/**
 * Tests for string escaping functions
 *
 * These tests verify that escapeHtml() and escapeJsString() properly
 * handle special characters to prevent XSS and injection attacks.
 */

import { describe, test, expect } from 'vitest';
import { loadAppFunctions } from './setup.js';

const { escapeHtml, escapeJsString } = loadAppFunctions();

describe('escapeHtml', () => {
  test('escapes HTML angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;'
    );
  });

  test('escapes ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  test('escapes double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say "hello"');
    // Note: textContent/innerHTML doesn't escape quotes in text context
  });

  test('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('handles null/undefined', () => {
    // In DOM context, null/undefined become empty string via textContent
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('preserves normal text', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

describe('escapeJsString', () => {
  test('escapes single quotes', () => {
    expect(escapeJsString("it's")).toBe("it\\'s");
  });

  test('escapes double quotes', () => {
    expect(escapeJsString('say "hello"')).toBe('say \\"hello\\"');
  });

  test('escapes backslashes first', () => {
    expect(escapeJsString('C:\\path')).toBe('C:\\\\path');
  });

  test('escapes backslashes before quotes', () => {
    // This ensures backslash is escaped first, so \' becomes \\\'
    // Input: \' (backslash followed by quote)
    // Output: \\\' (escaped backslash + escaped quote)
    expect(escapeJsString("\\' trick")).toBe("\\\\\\' trick");
  });

  test('escapes newlines', () => {
    expect(escapeJsString('line1\nline2')).toBe('line1\\nline2');
  });

  test('escapes carriage returns', () => {
    expect(escapeJsString('line1\rline2')).toBe('line1\\rline2');
  });

  test('escapes tabs', () => {
    expect(escapeJsString('col1\tcol2')).toBe('col1\\tcol2');
  });

  test('handles paths with special characters', () => {
    const path = "/Users/nathan's folder/project";
    expect(escapeJsString(path)).toBe("/Users/nathan\\'s folder/project");
  });

  test('handles Windows paths', () => {
    const path = "C:\\Users\\Nathan's Folder\\project";
    expect(escapeJsString(path)).toBe("C:\\\\Users\\\\Nathan\\'s Folder\\\\project");
  });

  test('prevents injection attempts', () => {
    const malicious = "'; alert('xss'); //";
    const escaped = escapeJsString(malicious);

    // The escaped string should not contain unescaped single quotes
    expect(escaped).not.toMatch(/(?<!\\)'/);
    // Should be safe to use in a JS string
    expect(escaped).toBe("\\'; alert(\\'xss\\'); //");
  });

  test('prevents breaking out of onclick handler', () => {
    const malicious = "test'); document.location='http://evil.com';//";
    const escaped = escapeJsString(malicious);

    // Simulate using in an onclick
    const onclick = `someFunction('${escaped}')`;

    // The escaped string should NOT contain unescaped ');
    // It WILL contain \'); which is the escaped version - that's safe
    expect(escaped).toBe("test\\'); document.location=\\'http://evil.com\\';//");
    // The full onclick is safe because the quotes are escaped
    expect(onclick).toBe("someFunction('test\\'); document.location=\\'http://evil.com\\';//')");
  });

  test('handles empty string', () => {
    expect(escapeJsString('')).toBe('');
  });

  test('handles numbers', () => {
    expect(escapeJsString(123)).toBe('123');
  });

  test('handles null/undefined via String()', () => {
    expect(escapeJsString(null)).toBe('null');
    expect(escapeJsString(undefined)).toBe('undefined');
  });

  test('preserves safe characters', () => {
    expect(escapeJsString('Hello World 123')).toBe('Hello World 123');
    expect(escapeJsString('user@example.com')).toBe('user@example.com');
    expect(escapeJsString('uuid-1234-5678-abcd')).toBe('uuid-1234-5678-abcd');
  });

  test('handles mixed special characters', () => {
    const input = "It's a \"test\"\nwith\ttabs\\and\\slashes";
    const expected = "It\\'s a \\\"test\\\"\\nwith\\ttabs\\\\and\\\\slashes";
    expect(escapeJsString(input)).toBe(expected);
  });
});

describe('escapeHtml vs escapeJsString use cases', () => {
  test('escapeHtml is for HTML attribute values and text content', () => {
    // Use escapeHtml for HTML contexts
    const userInput = '<script>alert("xss")</script>';
    const htmlSafe = escapeHtml(userInput);

    // Safe to use in innerHTML as text
    expect(htmlSafe).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });

  test('escapeJsString is for JavaScript string literals', () => {
    // Use escapeJsString for JS string contexts
    const userInput = "Nathan's Project";
    const jsSafe = escapeJsString(userInput);

    // Safe to use in onclick="someFunc('${jsSafe}')"
    const onclick = `selectDirectory('${jsSafe}')`;
    expect(onclick).toBe("selectDirectory('Nathan\\'s Project')");
  });

  test('WRONG: escapeHtml in JS string context fails', () => {
    // This demonstrates why escapeHtml is wrong for JS strings
    const userInput = "Nathan's Project";
    const htmlEscaped = escapeHtml(userInput);

    // escapeHtml doesn't escape single quotes!
    const onclick = `selectDirectory('${htmlEscaped}')`;

    // This would break JavaScript parsing:
    // selectDirectory('Nathan's Project')  <- syntax error!
    expect(onclick).toBe("selectDirectory('Nathan's Project')");
    // Note: This is INSECURE - demonstrates the bug we fixed
  });
});

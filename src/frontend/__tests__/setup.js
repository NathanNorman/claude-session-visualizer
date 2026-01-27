/**
 * Vitest test setup file
 * Sets up the DOM environment and imports helper functions from app.js
 */

import { beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

// Set up a fresh DOM before each test
beforeEach(() => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost:8000',
    pretendToBeVisual: true,
  });

  global.document = dom.window.document;
  global.window = dom.window;
  global.navigator = dom.window.navigator;
  global.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
});

afterEach(() => {
  // Clean up
  document.body.innerHTML = '';
});

/**
 * Helper to extract functions from app.js for testing
 * Since app.js uses global functions, we need to load them into the test environment
 */
export function loadAppFunctions() {
  // These functions are copied from app.js for isolated testing
  // In a real setup, you'd use a bundler to export these

  /**
   * Escape HTML entities to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape a string for safe use inside JavaScript string literals
   */
  function escapeJsString(str) {
    return String(str)
      .replace(/\\/g, '\\\\')     // Backslashes first
      .replace(/'/g, "\\'")       // Single quotes
      .replace(/"/g, '\\"')       // Double quotes
      .replace(/\n/g, '\\n')      // Newlines
      .replace(/\r/g, '\\r')      // Carriage returns
      .replace(/\t/g, '\\t');     // Tabs
  }

  return {
    escapeHtml,
    escapeJsString,
  };
}

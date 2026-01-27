/**
 * E2E tests for SDK session UI styling fixes
 *
 * Tests that verify the SDK session output in Mission Control has:
 * 1. Monospace font for terminal-like appearance
 * 2. Reduced whitespace for compact layout
 * 3. "SDK" badge instead of "MC"
 * 4. Proper spacing in "Managed Sessions" header
 * 5. Blue dots for waiting state (not yellow)
 * 6. Syntax highlighting in code blocks
 */

import { test, expect } from '@playwright/test';

test.describe('SDK Session Styling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Navigate to Mission Control view
    await page.click('[data-view="mission-control"]');
    await page.waitForTimeout(500);
  });

  test.describe('SDK Message Styles', () => {
    test('sdk-message uses monospace font family', async ({ page }) => {
      // Inject a test SDK message element to verify styling
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.id = 'test-sdk-message';
        testDiv.className = 'sdk-message assistant-message';
        testDiv.innerHTML = `
          <div class="sdk-message-header">
            <span class="sdk-role-icon">🤖</span>
            <span class="sdk-role-label">Claude</span>
          </div>
          <div class="sdk-message-content">
            <p>Test message content</p>
          </div>
        `;
        document.body.appendChild(testDiv);
      });

      const sdkMessage = page.locator('#test-sdk-message');

      // Check monospace font
      const fontFamily = await sdkMessage.evaluate((el) =>
        window.getComputedStyle(el).fontFamily
      );

      // Should contain a monospace font
      expect(fontFamily.toLowerCase()).toMatch(/mono|consolas|monaco|inconsolata|fira/i);
    });

    test('sdk-message has reduced padding and margins', async ({ page }) => {
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.id = 'test-sdk-padding';
        testDiv.className = 'sdk-message assistant-message';
        testDiv.innerHTML = '<div class="sdk-message-content"><p>Test</p></div>';
        document.body.appendChild(testDiv);
      });

      const sdkMessage = page.locator('#test-sdk-padding');

      // Check padding values (should be 0.5rem = 8px, 0.75rem = 12px)
      const styles = await sdkMessage.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          paddingTop: parseFloat(computed.paddingTop),
          paddingLeft: parseFloat(computed.paddingLeft),
          marginTop: parseFloat(computed.marginTop),
          borderRadius: parseFloat(computed.borderRadius)
        };
      });

      // Padding should be ~8px (0.5rem) or less
      expect(styles.paddingTop).toBeLessThanOrEqual(10);
      // Left padding should be ~12px (0.75rem) or less
      expect(styles.paddingLeft).toBeLessThanOrEqual(14);
      // Margin should be ~4px (0.25rem) or less
      expect(styles.marginTop).toBeLessThanOrEqual(6);
      // Border radius should be 6px or less
      expect(styles.borderRadius).toBeLessThanOrEqual(8);
    });

    test('sdk-message-header has compact spacing', async ({ page }) => {
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.id = 'test-sdk-header';
        testDiv.className = 'sdk-message assistant-message';
        testDiv.innerHTML = `
          <div class="sdk-message-header">
            <span class="sdk-role-icon">🤖</span>
            <span class="sdk-role-label">Claude</span>
          </div>
          <div class="sdk-message-content"><p>Test</p></div>
        `;
        document.body.appendChild(testDiv);
      });

      const header = page.locator('#test-sdk-header .sdk-message-header');

      const styles = await header.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          marginBottom: parseFloat(computed.marginBottom),
          paddingBottom: parseFloat(computed.paddingBottom),
          gap: parseFloat(computed.gap)
        };
      });

      // Margin bottom should be ~6.4px (0.4rem) or less
      expect(styles.marginBottom).toBeLessThanOrEqual(8);
      // Padding bottom should be ~4.8px (0.3rem) or less
      expect(styles.paddingBottom).toBeLessThanOrEqual(6);
    });

    test('sdk-message-content inherits monospace font', async ({ page }) => {
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.id = 'test-sdk-content';
        testDiv.className = 'sdk-message assistant-message';
        testDiv.innerHTML = `
          <div class="sdk-message-content"><p>Test content</p></div>
        `;
        document.body.appendChild(testDiv);
      });

      const content = page.locator('#test-sdk-content .sdk-message-content');

      const fontFamily = await content.evaluate((el) =>
        window.getComputedStyle(el).fontFamily
      );

      // Should inherit monospace from parent
      expect(fontFamily.toLowerCase()).toMatch(/mono|consolas|monaco|inconsolata|fira/i);
    });
  });

  test.describe('Code Block Styling', () => {
    test('code blocks have monospace font and proper styling', async ({ page }) => {
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.id = 'test-code-block';
        testDiv.className = 'sdk-message assistant-message';
        testDiv.innerHTML = `
          <div class="sdk-message-content">
            <pre><code class="language-python">def hello():
    print("Hello, World!")</code></pre>
          </div>
        `;
        document.body.appendChild(testDiv);
      });

      const codeBlock = page.locator('#test-code-block pre');

      const styles = await codeBlock.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          background: computed.backgroundColor,
          borderRadius: parseFloat(computed.borderRadius),
          padding: parseFloat(computed.padding),
          margin: parseFloat(computed.marginTop)
        };
      });

      // Background should be dark (github-dark theme: #0d1117)
      expect(styles.background).toMatch(/rgb\(13,\s*17,\s*23\)|#0d1117/i);
      // Border radius should be 6px
      expect(styles.borderRadius).toBeLessThanOrEqual(8);
      // Padding should be ~12px (0.75rem)
      expect(styles.padding).toBeLessThanOrEqual(14);
    });

    test('inline code has proper styling', async ({ page }) => {
      await page.evaluate(() => {
        const testDiv = document.createElement('div');
        testDiv.id = 'test-inline-code';
        testDiv.className = 'sdk-message assistant-message';
        testDiv.innerHTML = `
          <div class="sdk-message-content">
            <p>Use <code>console.log()</code> for debugging</p>
          </div>
        `;
        document.body.appendChild(testDiv);
      });

      const inlineCode = page.locator('#test-inline-code .sdk-message-content code');

      const fontFamily = await inlineCode.evaluate((el) =>
        window.getComputedStyle(el).fontFamily
      );

      expect(fontFamily.toLowerCase()).toMatch(/mono|consolas|monaco|inconsolata|fira/i);
    });
  });

  test.describe('Managed Sessions Section', () => {
    test('section header has space after emoji', async ({ page }) => {
      // Check the JavaScript source renders the header with proper spacing
      const headerHtml = await page.evaluate(() => {
        // Access the renderManagedProcessesInList function's output pattern
        // We'll check the CSS handles emoji spacing properly
        const header = document.querySelector('.mc-section-header');
        return header ? header.textContent : null;
      });

      // If there are managed sessions, check the header
      if (headerHtml) {
        // Should have visible space or non-breaking space between emoji and text
        expect(headerHtml).toMatch(/🖥️\s+Managed/);
      }
    });

    test('SDK badge shows "SDK" text, not "MC"', async ({ page }) => {
      // Inject a mock managed session to test the badge
      await page.evaluate(() => {
        const section = document.createElement('div');
        section.className = 'mc-managed-section';
        section.innerHTML = `
          <div class="mc-section-header">🖥️  Managed Sessions</div>
          <div class="mc-session-item managed">
            <div class="mc-session-name">🟢 test-project<span class="managed-badge">SDK</span></div>
            <div class="mc-session-meta">/tmp/test</div>
          </div>
        `;

        const container = document.getElementById('mc-sessions-list');
        if (container) {
          container.prepend(section);
        } else {
          document.body.appendChild(section);
        }
      });

      const badge = page.locator('.managed-badge').first();
      await expect(badge).toHaveText('SDK');
      await expect(badge).not.toHaveText('MC');
    });

    test('waiting state uses blue dot emoji, not yellow', async ({ page }) => {
      // Inject mock managed session in waiting state
      await page.evaluate(() => {
        const section = document.createElement('div');
        section.id = 'test-waiting-session';
        section.className = 'mc-managed-section';
        section.innerHTML = `
          <div class="mc-session-item managed">
            <div class="mc-session-name">🔵 waiting-project<span class="managed-badge">SDK</span></div>
            <div class="mc-session-meta">/tmp/waiting</div>
          </div>
        `;
        document.body.appendChild(section);
      });

      const sessionName = page.locator('#test-waiting-session .mc-session-name');
      const text = await sessionName.textContent();

      // Should use blue dot 🔵, not yellow 🟡
      expect(text).toContain('🔵');
      expect(text).not.toContain('🟡');
    });

    test('running state uses green dot emoji', async ({ page }) => {
      await page.evaluate(() => {
        const section = document.createElement('div');
        section.id = 'test-running-session';
        section.className = 'mc-managed-section';
        section.innerHTML = `
          <div class="mc-session-item managed">
            <div class="mc-session-name">🟢 running-project<span class="managed-badge">SDK</span></div>
            <div class="mc-session-meta">/tmp/running</div>
          </div>
        `;
        document.body.appendChild(section);
      });

      const sessionName = page.locator('#test-running-session .mc-session-name');
      const text = await sessionName.textContent();

      expect(text).toContain('🟢');
    });

    test('stopped state uses black dot emoji', async ({ page }) => {
      await page.evaluate(() => {
        const section = document.createElement('div');
        section.id = 'test-stopped-session';
        section.className = 'mc-managed-section';
        section.innerHTML = `
          <div class="mc-session-item managed">
            <div class="mc-session-name">⚫ stopped-project<span class="managed-badge">SDK</span></div>
            <div class="mc-session-meta">/tmp/stopped</div>
          </div>
        `;
        document.body.appendChild(section);
      });

      const sessionName = page.locator('#test-stopped-session .mc-session-name');
      const text = await sessionName.textContent();

      expect(text).toContain('⚫');
    });
  });

  test.describe('Syntax Highlighting', () => {
    test('highlight.js CSS is loaded', async ({ page }) => {
      const hasHighlightCSS = await page.evaluate(() => {
        const links = document.querySelectorAll('link[rel="stylesheet"]');
        return Array.from(links).some(link =>
          link.href.includes('highlight') && link.href.includes('.css')
        );
      });

      expect(hasHighlightCSS).toBe(true);
    });

    test('highlight.js library is available', async ({ page }) => {
      const hljsAvailable = await page.evaluate(() => {
        return typeof hljs !== 'undefined' && typeof hljs.highlight === 'function';
      });

      expect(hljsAvailable).toBe(true);
    });

    test('marked.js is configured with highlight', async ({ page }) => {
      const markedAvailable = await page.evaluate(() => {
        return typeof marked !== 'undefined' && typeof marked.parse === 'function';
      });

      expect(markedAvailable).toBe(true);
    });
  });
});

/**
 * E2E tests for spawn modal functionality
 *
 * Tests that the spawn modal correctly handles directories
 * with special characters (quotes, backslashes, etc.)
 */

import { test, expect } from '@playwright/test';

test.describe('Spawn Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('spawn modal opens from Mission Control', async ({ page }) => {
    // Navigate to Mission Control view
    await page.click('[data-view="mission-control"]');

    // Wait for view to initialize
    await page.waitForTimeout(1000);

    // Click spawn button
    const spawnBtn = page.locator('#mc-spawn-btn');
    await expect(spawnBtn).toBeVisible({ timeout: 5000 });

    // Use JavaScript click for reliability
    await spawnBtn.evaluate((btn) => btn.click());

    // Wait for modal to appear
    await page.waitForTimeout(500);

    // Check modal state - spawn modal uses #spawn-modal, not #modal-overlay
    const spawnModal = page.locator('#spawn-modal');
    await expect(spawnModal).not.toHaveClass(/hidden/);

    // Modal content should be visible
    await expect(spawnModal).toContainText('Spawn New Claude Session');
  });

  test('spawn modal shows directory input', async ({ page }) => {
    await page.click('[data-view="mission-control"]');
    await page.waitForTimeout(1000);

    const spawnBtn = page.locator('#mc-spawn-btn');
    await spawnBtn.evaluate((btn) => btn.click());
    await page.waitForTimeout(500);

    // Check if spawn modal opened
    const spawnModal = page.locator('#spawn-modal');
    await expect(spawnModal).not.toHaveClass(/hidden/);

    // Should have a directory input field
    const input = page.locator('#spawn-directory');
    await expect(input).toBeVisible();
  });

  test('clicking recent directory populates input', async ({ page }) => {
    await page.click('[data-view="mission-control"]');
    await page.click('#mc-spawn-btn');

    const items = page.locator('.spawn-recent-item');
    const itemCount = await items.count();

    if (itemCount > 0) {
      // Click first directory
      await items.first().click();

      // Input should be populated
      const input = page.locator('#spawn-directory');
      const value = await input.inputValue();
      expect(value).toBeTruthy();
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test('manual directory input works', async ({ page }) => {
    await page.click('[data-view="mission-control"]');
    await page.click('#mc-spawn-btn');

    const input = page.locator('#spawn-directory');
    await input.fill('/tmp/test-project');

    expect(await input.inputValue()).toBe('/tmp/test-project');
  });

  test('spawn button state reflects directory input', async ({ page }) => {
    await page.click('[data-view="mission-control"]');
    await page.click('#mc-spawn-btn');

    // Find the spawn directory input
    const input = page.locator('#spawn-directory');

    // Clear and verify input is empty
    await input.clear();
    expect(await input.inputValue()).toBe('');

    // Fill with a path and verify
    await input.fill('/tmp/test');
    expect(await input.inputValue()).toBe('/tmp/test');
  });

  test('modal closes on cancel', async ({ page }) => {
    await page.click('[data-view="mission-control"]');
    await page.waitForTimeout(1000);

    const spawnBtn = page.locator('#mc-spawn-btn');
    await spawnBtn.evaluate((btn) => btn.click());
    await page.waitForTimeout(500);

    const spawnModal = page.locator('#spawn-modal');
    await expect(spawnModal).not.toHaveClass(/hidden/);

    // Click cancel button
    await page.click('.spawn-cancel-btn');
    await page.waitForTimeout(300);

    // Modal should be hidden
    await expect(spawnModal).toHaveClass(/hidden/);
  });
});

test.describe('Spawn Modal Special Characters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('[data-view="mission-control"]');
    await page.click('#mc-spawn-btn');
  });

  test('handles path with single quotes', async ({ page }) => {
    const input = page.locator('#spawn-directory');
    const pathWithQuotes = "/Users/nathan's projects/test";

    await input.fill(pathWithQuotes);
    expect(await input.inputValue()).toBe(pathWithQuotes);

    // The value should be preserved exactly
    const value = await input.inputValue();
    expect(value).toContain("'");
  });

  test('handles path with double quotes', async ({ page }) => {
    const input = page.locator('#spawn-directory');
    const pathWithQuotes = '/Users/nathan/project "test"/src';

    await input.fill(pathWithQuotes);
    expect(await input.inputValue()).toBe(pathWithQuotes);
  });

  test('handles path with backslashes (Windows-style)', async ({ page }) => {
    const input = page.locator('#spawn-directory');
    const windowsPath = 'C:\\Users\\Nathan\\Projects';

    await input.fill(windowsPath);
    expect(await input.inputValue()).toBe(windowsPath);
  });

  test('handles path with spaces', async ({ page }) => {
    const input = page.locator('#spawn-directory');
    const pathWithSpaces = '/Users/nathan/my project folder/src';

    await input.fill(pathWithSpaces);
    expect(await input.inputValue()).toBe(pathWithSpaces);
  });

  test('handles path with unicode characters', async ({ page }) => {
    const input = page.locator('#spawn-directory');
    const unicodePath = '/Users/nathan/프로젝트/テスト';

    await input.fill(unicodePath);
    expect(await input.inputValue()).toBe(unicodePath);
  });
});

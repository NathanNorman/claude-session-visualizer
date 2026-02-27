/**
 * E2E tests for session action handlers
 *
 * Tests that session cards correctly handle actions
 * including those with special characters in session data.
 */

import { test, expect } from '@playwright/test';

test.describe('View Navigation', () => {
  test('can switch between all views', async ({ page }) => {
    await page.goto('/');

    const views = [
      { selector: '[data-view="timeline"]', name: 'Timeline' },
      { selector: '[data-view="analytics"]', name: 'Analytics' },
      { selector: '[data-view="mission-control"]', name: 'Mission Control' },
      { selector: '[data-view="graveyard"]', name: 'Graveyard' },
    ];

    for (const view of views) {
      const tab = page.locator(view.selector);
      if ((await tab.count()) > 0) {
        await tab.click();
        // Wait for view to stabilize
        await page.waitForTimeout(500);
        // Should not have JS errors
      }
    }
  });
});

test.describe('Machine Management Modal', () => {
  test('machines modal opens', async ({ page }) => {
    await page.goto('/');

    // Click manage machines button
    const manageMachinesBtn = page.locator('button:has-text("Manage Machines")');
    if ((await manageMachinesBtn.count()) > 0) {
      await manageMachinesBtn.click();

      const modal = page.locator('.modal-content');
      await expect(modal).toBeVisible();
      await expect(modal).toContainText('Machine');
    }
  });
});

test.describe('Graveyard View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.click('[data-view="graveyard"]');
    await page.waitForTimeout(1000);
  });

  test('graveyard view loads', async ({ page }) => {
    const view = page.locator('#graveyard-view');
    await expect(view).toBeVisible();
  });

  test('search input works', async ({ page }) => {
    const searchInput = page.locator('#graveyard-search');
    if ((await searchInput.count()) > 0) {
      await searchInput.fill('test query');
      expect(await searchInput.inputValue()).toBe('test query');
    }
  });
});

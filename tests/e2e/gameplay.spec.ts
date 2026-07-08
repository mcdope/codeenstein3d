import { test, expect } from '@playwright/test';

test.describe('Gameplay E2E & Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
  });

  test('should load github repo mcdope/pam_usb and display the game HUD', async ({ page }) => {
    // Switch to GitHub tab
    await page.locator('#tab-github').click();

    // Wait for the "GitHub Repo" input to appear
    const repoInput = page.locator('input#github-repo-input');
    await expect(repoInput).toBeVisible({ timeout: 10000 });

    // Enter the repository name
    await repoInput.fill('mcdope/pam_usb');
    await page.locator('#load-github-repo').click();

    // It should load and show the level HUD on canvas
    const canvas = page.locator('#viewport canvas');
    await expect(canvas).toBeVisible({ timeout: 15000 });

    // Focus canvas to ensure it receives keyboard events
    await canvas.focus();

    // Take a screenshot of the initial viewport (the game)
    await expect(page.locator('#viewport')).toHaveScreenshot('game-viewport.png', { maxDiffPixelRatio: 0.1 });

    // 1. Move around (W, A, S, D)
    await page.keyboard.down('W');
    await page.waitForTimeout(200);
    await page.keyboard.up('W');
    
    await page.keyboard.down('D');
    await page.waitForTimeout(200);
    await page.keyboard.up('D');

    await expect(page.locator('#viewport')).toHaveScreenshot('game-after-move.png', { maxDiffPixelRatio: 0.1 });

    // 2. Shoot (Space)
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    // Verify ammo changes or muzzle flash
    await expect(page.locator('#viewport')).toHaveScreenshot('game-after-shoot.png', { maxDiffPixelRatio: 0.1 });

    // 3. Cycle weapons (numbers 1, 2)
    await page.keyboard.press('2');
    await page.waitForTimeout(200);
    await expect(page.locator('#viewport')).toHaveScreenshot('game-weapon-2.png', { maxDiffPixelRatio: 0.1 });

    await page.keyboard.press('1');
    await page.waitForTimeout(200);

    // 4. Read lore terminals (R)
    await page.keyboard.press('R');
    await page.waitForTimeout(300);
    // A lore terminal overlay should appear if near one, or just no-op if none nearby. 
    // We'll take a screenshot either way to verify the state.
    await expect(page.locator('#viewport')).toHaveScreenshot('game-lore-terminal.png', { maxDiffPixelRatio: 0.1 });
    // Close terminal (press R again)
    await page.keyboard.press('R');
    await page.waitForTimeout(200);

    // 5. Pause (Esc)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    // Paused overlay should be visible
    await expect(page.locator('#viewport')).toHaveScreenshot('game-paused.png', { maxDiffPixelRatio: 0.1 });
    
    // Unpause
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // Open settings sidebar
    const settingsToggle = page.locator('#sidebar-toggle');
    if (await settingsToggle.isVisible()) {
      await settingsToggle.click();
      const sidebar = page.locator('#sidebar');
      await expect(sidebar).toBeVisible();
      // Take visual screenshot of the settings UI
      await expect(sidebar).toHaveScreenshot('settings-sidebar.png', { maxDiffPixelRatio: 0.1 });
    }
  });
});

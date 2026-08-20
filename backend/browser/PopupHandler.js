// PopupHandler.js — Generic popup, cookie banner, location modal, and overlay auto-dismissal

const { CLOSE_SELECTORS, MODAL_KEYWORDS } = require('../utils/constants');
const logger = require('../utils/logger');

function getActivePage(providedPage = null) {
    if (providedPage) return providedPage;
    try {
        const { getPage } = require('./BrowserManager');
        return getPage();
    } catch {
        return null;
    }
}

/**
 * Tries dismissing modal via Escape key.
 */
async function tryEscapeKey(page) {
    try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        return true;
    } catch {
        return false;
    }
}

/**
 * Tries dismissing modal by clicking outside / top-left backdrop.
 */
async function tryClickOutside(page) {
    try {
        await page.mouse.click(10, 10);
        await page.waitForTimeout(300);
        return true;
    } catch {
        return false;
    }
}

/**
 * Handles Zepto, Blinkit, and quick-commerce location selection modals automatically.
 */
async function handleLocationModalIfPresent(customPage = null) {
    const page = getActivePage(customPage);
    if (!page || page.isClosed()) return false;

    try {
        // Step A: Check for direct "Use current location" or "Confirm" buttons
        const confirmSelectors = [
            'button:has-text("Use current location")',
            'button:has-text("Detect location")',
            'button:has-text("Select location")',
            'button:has-text("Confirm location")',
            'button:has-text("Confirm & Continue")',
            'button:has-text("Confirm")',
            '[data-testid*="location-btn" i]',
            '[data-testid*="use-current-location" i]',
            '[data-testid*="confirm-location" i]',
            'div[role="button"]:has-text("Use Current Location")',
            'div[role="button"]:has-text("Select Location")',
            'button:has-text("Skip")',
            'button:has-text("Later")',
        ];

        for (const sel of confirmSelectors) {
            const btn = await page.$(sel);
            if (btn) {
                const isVisible = await btn.isVisible().catch(() => false);
                if (isVisible) {
                    logger.info(`📍 Auto-handling location modal button: "${sel}"`);
                    await btn.click({ timeout: 2000 }).catch(() => {});
                    await page.waitForTimeout(1000);
                    return true;
                }
            }
        }

        // Step B: Check for location search input on modal (e.g. Zepto/Blinkit search location)
        const locationInput = await page.$('input[placeholder*="area" i], input[placeholder*="street" i], input[placeholder*="location" i], input[placeholder*="pincode" i]');
        if (locationInput) {
            const isVisible = await locationInput.isVisible().catch(() => false);
            if (isVisible) {
                logger.info('📍 Auto-entering location "Delhi" into location modal...');
                await locationInput.fill('Delhi');
                await page.waitForTimeout(1000);
                await page.keyboard.press('Enter');

                // Click first suggestion if dropdown appears
                const suggestion = await page.$('div[class*="suggestion" i], div[class*="address" i], li[role="option"]');
                if (suggestion) {
                    await suggestion.click().catch(() => {});
                    await page.waitForTimeout(1000);
                }
                return true;
            }
        }
    } catch (e) {
        logger.debug(`Location modal handler error: ${e.message}`);
    }

    return false;
}

/**
 * Detects whether a high-priority modal/dialog is currently covering the screen.
 */
async function detectModalPresence(customPage = null) {
    const page = getActivePage(customPage);
    if (!page || page.isClosed()) return false;

    try {
        return await page.evaluate((keywords) => {
            const modalSelectors = [
                '[role="dialog"]',
                '[role="alertdialog"]',
                '[class*="modal" i]',
                '[class*="overlay" i]',
                '[class*="popup" i]',
                '[class*="cookie" i]',
                '[class*="consent" i]',
                '[id*="modal" i]',
                '[id*="popup" i]',
                '[data-testid*="modal" i]',
            ];

            for (const sel of modalSelectors) {
                const elements = document.querySelectorAll(sel);
                for (const el of elements) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    if (
                        rect.width > 80 &&
                        rect.height > 80 &&
                        style.display !== 'none' &&
                        style.visibility !== 'hidden' &&
                        style.opacity !== '0'
                    ) {
                        const text = (el.innerText || '').toLowerCase();
                        if (keywords.some((kw) => text.includes(kw))) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }, MODAL_KEYWORDS);
    } catch {
        return false;
    }
}

/**
 * Checks for and dismisses any blocking popup, cookie banner, or location modal.
 */
async function closePopupIfExists(customPage = null) {
    const page = getActivePage(customPage);
    if (!page || page.isClosed()) return false;

    // First handle location modals
    await handleLocationModalIfPresent(page);

    let closed = false;

    // Additional modal close selectors
    const allCloseSelectors = [
        '[data-testid*="close" i]',
        '[aria-label*="close" i]',
        'svg[class*="close" i]',
        'button._2KpZ6l._2doB4z',
        ...CLOSE_SELECTORS,
    ];

    // Step 1: Check known close / accept / dismiss selectors
    for (const selector of allCloseSelectors) {
        try {
            const el = await page.$(selector);
            if (el) {
                const isVisible = await el.isVisible().catch(() => false);
                if (isVisible) {
                    await el.click({ timeout: 1500 }).catch(() => {});
                    logger.debug(`Popup dismissed using selector: ${selector}`);
                    closed = true;
                    await page.waitForTimeout(300);
                    break;
                }
            }
        } catch {
            continue;
        }
    }

    // Step 2: If modal is still present, try Escape key
    if (!closed) {
        const hasModal = await detectModalPresence(page);
        if (hasModal) {
            await tryEscapeKey(page);
            const stillThere = await detectModalPresence(page);
            if (!stillThere) {
                logger.debug('Popup dismissed using Escape key');
                closed = true;
            }
        }
    }

    // Step 3: If still present, try outside backdrop click
    if (!closed) {
        const hasModal = await detectModalPresence(page);
        if (hasModal) {
            await tryClickOutside(page);
            const stillThere = await detectModalPresence(page);
            if (!stillThere) {
                logger.debug('Popup dismissed using backdrop click');
                closed = true;
            }
        }
    }

    return closed;
}

module.exports = {
    closePopupIfExists,
    handleLocationModalIfPresent,
    detectModalPresence,
};

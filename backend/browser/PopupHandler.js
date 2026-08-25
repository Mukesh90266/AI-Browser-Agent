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

    const locationQuery = process.env.DEFAULT_DELIVERY_LOCATION || 'Connaught Place, Delhi';

    async function chooseFirstLocationSuggestion() {
        const suggestionSelectors = [
            '[data-testid*="address" i]',
            '[data-testid*="suggestion" i]',
            '[class*="suggestion" i]',
            '[class*="address" i]',
            '[role="option"]',
            'li',
            'button',
            'div[role="button"]',
        ];

        for (const selector of suggestionSelectors) {
            const candidates = await page.$$(selector).catch(() => []);
            for (const candidate of candidates) {
                const visible = await candidate.isVisible().catch(() => false);
                if (!visible) continue;
                const text = (await candidate.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
                if (!text || text.length < 3 || text.length > 220) continue;
                if (/select location|detect location|use current|your location/i.test(text)) continue;
                if (/(delhi|connaught|new delhi|pincode|110001|sector|road|street|area)/i.test(text)) {
                    logger.info(`📍 Selecting location suggestion: "${text.slice(0, 80)}"`);
                    await candidate.click({ timeout: 2000 }).catch(() => {});
                    await page.waitForTimeout(1000);
                    return true;
                }
            }
        }
        return false;
    }

    async function enterLocationIntoInput() {
        const inputSelectors = [
            'input[placeholder*="area" i]',
            'input[placeholder*="street" i]',
            'input[placeholder*="location" i]',
            'input[placeholder*="pincode" i]',
            'input[placeholder*="search" i]',
            'input[type="search"]',
            'input[type="text"]',
        ].join(', ');

        const inputs = await page.$$(inputSelectors).catch(() => []);
        for (const locationInput of inputs) {
            const isVisible = await locationInput.isVisible().catch(() => false);
            if (!isVisible) continue;

            logger.info(`📍 Auto-entering location "${locationQuery}" into location modal...`);
            await locationInput.click({ timeout: 1500 }).catch(() => {});
            await locationInput.fill('').catch(() => {});
            await locationInput.fill(locationQuery).catch(async () => {
                await page.keyboard.type(locationQuery, { delay: 20 }).catch(() => {});
            });
            await page.waitForTimeout(1500);
            await page.keyboard.press('ArrowDown').catch(() => {});
            await page.keyboard.press('Enter').catch(() => {});
            await page.waitForTimeout(1200);

            if (await chooseFirstLocationSuggestion()) return true;
            return true;
        }
        return false;
    }

    async function clickConfirmIfVisible() {
        const selectors = [
            'button:has-text("Confirm location")',
            'button:has-text("Confirm & Continue")',
            'button:has-text("Confirm and Continue")',
            'button:has-text("Confirm")',
            'button:has-text("Continue")',
            'button:has-text("Apply")',
            '[data-testid*="confirm-location" i]',
        ];
        for (const sel of selectors) {
            const btn = await page.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
                logger.info(`📍 Confirming selected location: "${sel}"`);
                await btn.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(1200);
                return true;
            }
        }
        return false;
    }

    try {
        // Step A: If the modal already shows a search box, fill it first. This
        // avoids clicking "Select location" repeatedly on Zepto without ever
        // entering an address.
        if (await enterLocationIntoInput()) {
            await clickConfirmIfVisible();
            return true;
        }

        // Step B: Prefer current-location/detect buttons, then open the manual
        // location picker. Do not immediately return after "Select location";
        // it usually just reveals the input.
        const confirmSelectors = [
            'button:has-text("Use current location")',
            'button:has-text("Use Current Location")',
            'button:has-text("Detect location")',
            'button:has-text("Detect my location")',
            '[data-testid*="use-current-location" i]',
            'div[role="button"]:has-text("Use Current Location")',
            'button:has-text("Select location")',
            'button:has-text("Select Location")',
            'div[role="button"]:has-text("Select Location")',
            '[data-testid*="location-btn" i]',
            'button:has-text("Skip")',
            'button:has-text("Later")',
        ];

        for (const sel of confirmSelectors) {
            const btn = await page.$(sel).catch(() => null);
            if (btn && await btn.isVisible().catch(() => false)) {
                logger.info(`📍 Auto-handling location modal button: "${sel}"`);
                await btn.click({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(1200);

                if (/select location/i.test(sel) || /location-btn/i.test(sel)) {
                    if (await enterLocationIntoInput()) {
                        await clickConfirmIfVisible();
                    }
                } else {
                    await clickConfirmIfVisible();
                }
                return true;
            }
        }

        // Step C: Some apps render only text/cards after the input has already
        // been filled. Pick an address-looking suggestion if visible.
        if (await chooseFirstLocationSuggestion()) {
            await clickConfirmIfVisible();
            return true;
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

// PopupHandler.js — Generic popup, cookie banner, and overlay auto-dismissal

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
 * Detects whether a high-priority modal/dialog is currently covering the screen.
 */
async function detectModalPresence(customPage = null) {
    const page = getActivePage(customPage);
    if (!page) return false;

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
 * Checks for and dismisses any blocking popup, cookie banner, or modal.
 */
async function closePopupIfExists(customPage = null) {
    const page = getActivePage(customPage);
    if (!page) return false;

    let closed = false;

    // Step 1: Check known close / accept / dismiss selectors
    for (const selector of CLOSE_SELECTORS) {
        try {
            const el = await page.$(selector);
            if (el) {
                const isVisible = await el.isVisible().catch(() => false);
                if (isVisible) {
                    await el.click({ timeout: 1500 });
                    logger.debug(`Popup dismissed using selector: ${selector}`);
                    closed = true;
                    await page.waitForTimeout(400);
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
    detectModalPresence,
};

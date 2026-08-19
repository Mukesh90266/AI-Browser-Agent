// ActionExecutor.js — Generic browser action execution based on data-agent-id and Playwright

const { getPage, navigateTo, goBack } = require('./BrowserManager');
const { closePopupIfExists } = require('./PopupHandler');
const { ACTION_TYPES, DEFAULT_CONFIG } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Clicks an interactive element identified by its data-agent-id.
 */
async function clickElement(elementId) {
    const page = getPage();
    if (!page) throw new Error('Browser page is not initialized');

    const selector = `[data-agent-id="${elementId}"]`;
    const target = await page.$(selector);

    if (!target) {
        throw new Error(`Element #${elementId} not found on current page (data-agent-id="${elementId}" missing)`);
    }

    const isVisible = await target.isVisible().catch(() => false);
    if (!isVisible) {
        logger.warn(`Element #${elementId} is not directly visible — attempting to scroll into view`);
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);

    // Fast click timeout (4 seconds)
    await target.click({ timeout: DEFAULT_CONFIG.ACTION_TIMEOUT_MS }).catch(async (clickErr) => {
        logger.warn(`Direct click failed on #${elementId}, trying forced click: ${clickErr.message}`);
        await target.click({ force: true, timeout: 2000 });
    });

    logger.success(`Clicked Element #${elementId}`);

    // Allow navigation / DOM updates to settle
    await page.waitForTimeout(1000);

    // Auto-dismiss any popups that opened as a result of the click
    await closePopupIfExists().catch(() => {});
}

/**
 * Types text into an input or textarea identified by its data-agent-id.
 */
async function typeText(elementId, text, options = {}) {
    const page = getPage();
    if (!page) throw new Error('Browser page is not initialized');

    const selector = `[data-agent-id="${elementId}"]`;
    const target = await page.$(selector);

    if (!target) {
        throw new Error(`Input Element #${elementId} not found (data-agent-id="${elementId}" missing)`);
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100);

    // Fill the text directly into the target input element with short 2.5s timeout
    let fillSucceeded = false;
    try {
        await target.fill('', { timeout: 2000 }).catch(() => {});
        await target.fill(text, { timeout: 2500 });
        logger.success(`Typed "${text}" into Element #${elementId}`);
        fillSucceeded = true;
    } catch (fillErr) {
        // Fallback to keyboard typing if element is not standard editable input
        logger.warn(`target.fill failed, falling back to keyboard type: ${fillErr.message}`);
    }

    if (!fillSucceeded) {
        await page.keyboard.type(text, { delay: 25 });
        logger.success(`Typed "${text}" via keyboard into Element #${elementId}`);
    }

    if (options.pressEnter || options.press_enter) {
        await page.keyboard.press('Enter');
        logger.success(`Pressed Enter after typing into Element #${elementId}`);
        await page.waitForTimeout(1500);
    } else {
        await page.waitForTimeout(400);
    }
}

/**
 * Selects an option in a <select> dropdown element.
 */
async function selectOption(elementId, value) {
    const page = getPage();
    if (!page) throw new Error('Browser page is not initialized');

    const selector = `[data-agent-id="${elementId}"]`;
    const target = await page.$(selector);

    if (!target) {
        throw new Error(`Select Element #${elementId} not found`);
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.selectOption({ label: value }, { timeout: 2500 }).catch(async () => {
        await target.selectOption({ value: value }, { timeout: 2500 });
    });

    logger.success(`Selected option "${value}" in Element #${elementId}`);
    await page.waitForTimeout(500);
}

/**
 * Scrolls the active page up or down.
 */
async function scrollPage(direction = 'down', amount = 600) {
    const page = getPage();
    if (!page) throw new Error('Browser page is not initialized');

    const scrollAmount = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
    await page.evaluate((amt) => window.scrollBy(0, amt), scrollAmount);
    logger.success(`Scrolled ${direction} by ${Math.abs(scrollAmount)}px`);
    await page.waitForTimeout(800);
}

/**
 * Presses the Enter key on the active element / keyboard.
 */
async function pressEnter() {
    const page = getPage();
    if (!page) throw new Error('Browser page is not initialized');

    await page.keyboard.press('Enter');
    logger.success('Pressed Enter key');
    await page.waitForTimeout(1500);
}

/**
 * Generic unified action dispatcher.
 * Executes any validated action object and returns a structured execution report.
 */
async function executeAction(action) {
    if (!action || !action.action) {
        throw new Error('Invalid action object provided to executeAction');
    }

    logger.action(action);

    try {
        switch (action.action) {
            case ACTION_TYPES.CLICK:
                await clickElement(action.element_id);
                return { success: true, action: action.action, message: `Clicked element #${action.element_id}` };

            case ACTION_TYPES.TYPE:
                await typeText(action.element_id, action.text, { pressEnter: action.press_enter || false });
                return { success: true, action: action.action, message: `Typed "${action.text}" into #${action.element_id}` };

            case ACTION_TYPES.SELECT:
                await selectOption(action.element_id, action.value);
                return { success: true, action: action.action, message: `Selected "${action.value}" on #${action.element_id}` };

            case ACTION_TYPES.ENTER:
                await pressEnter();
                return { success: true, action: action.action, message: 'Pressed Enter' };

            case ACTION_TYPES.SCROLL:
                await scrollPage(action.direction || 'down', action.amount || 600);
                return { success: true, action: action.action, message: `Scrolled ${action.direction || 'down'}` };

            case ACTION_TYPES.NAVIGATE:
                await navigateTo(action.url);
                return { success: true, action: action.action, message: `Navigated to ${action.url}` };

            case ACTION_TYPES.GO_BACK:
                await goBack();
                return { success: true, action: action.action, message: 'Navigated back' };

            case ACTION_TYPES.WAIT: {
                const page = getPage();
                const waitMs = (action.seconds || 2) * 1000;
                if (page) await page.waitForTimeout(waitMs);
                return { success: true, action: action.action, message: `Waited ${action.seconds || 2}s` };
            }

            case ACTION_TYPES.NEXT_CHUNK:
                return { success: true, action: action.action, message: 'Requested next element chunk' };

            case ACTION_TYPES.DONE:
                return {
                    success: true,
                    action: action.action,
                    isDone: true,
                    goalSuccess: action.success !== false,
                    result: action.result || 'Task completed',
                };

            default:
                throw new Error(`Unsupported action type: "${action.action}"`);
        }
    } catch (err) {
        logger.error(`Execution failed for action [${action.action}]: ${err.message}`);
        return {
            success: false,
            action: action.action,
            error: err.message,
        };
    }
}

module.exports = {
    clickElement,
    typeText,
    selectOption,
    scrollPage,
    pressEnter,
    executeAction,
};

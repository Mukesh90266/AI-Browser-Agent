// ActionExecutor.js — Generic browser action execution with Live Visual Cursor, element inspection, and multi-tab link navigation

const { getPage, navigateTo, goBack } = require('./BrowserManager');
const { closePopupIfExists } = require('./PopupHandler');
const { ACTION_TYPES, DEFAULT_CONFIG } = require('../utils/constants');
const logger = require('../utils/logger');

/**
 * Helper to get element description for human-readable logging.
 */
function describeElement(elementId, elementsList = []) {
    const el = elementsList.find(e => e.id === elementId);
    if (!el) return `[Element #${elementId}]`;
    const label = (el.text || el.placeholder || el.name || el.href || '').slice(0, 60);
    return `[${el.type}${el.inputType ? `:${el.inputType}` : ''}] "${label}"`;
}

/**
 * Injects and animates a visible glowing red cursor and click ripple on the browser screen.
 */
async function showVisualCursor(page, elementId, actionType = 'click') {
    if (!page || page.isClosed()) return;
    try {
        await page.evaluate(({ id, type }) => {
            let cursor = document.getElementById('agent-visual-cursor');
            if (!cursor) {
                cursor = document.createElement('div');
                cursor.id = 'agent-visual-cursor';
                cursor.style.cssText = `
                    position: fixed;
                    width: 22px;
                    height: 22px;
                    background: radial-gradient(circle, #ff2222 45%, rgba(255, 34, 34, 0.4) 80%);
                    border: 2px solid #ffffff;
                    border-radius: 50%;
                    box-shadow: 0 0 12px #ff0000, 0 0 24px rgba(255, 80, 80, 0.8);
                    pointer-events: none;
                    z-index: 2147483647;
                    transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.4, 1.1);
                    transform: translate(-50%, -50%);
                    display: none;
                `;
                document.body.appendChild(cursor);
            }

            const target = document.querySelector(`[data-agent-id="${id}"]`) || document.querySelector('input#twotabsearchtextbox, input[name="q"], input[type="search"]');
            if (target) {
                const rect = target.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;

                cursor.style.display = 'block';
                cursor.style.left = `${x}px`;
                cursor.style.top = `${y}px`;

                const prevOutline = target.style.outline;
                const prevShadow = target.style.boxShadow;
                target.style.outline = '3px solid #ff2222';
                target.style.boxShadow = '0 0 15px rgba(255, 34, 34, 0.9)';

                if (type === 'click') {
                    const ripple = document.createElement('div');
                    ripple.style.cssText = `
                        position: fixed;
                        left: ${x}px;
                        top: ${y}px;
                        width: 14px;
                        height: 14px;
                        border: 3px solid #ff0000;
                        border-radius: 50%;
                        pointer-events: none;
                        z-index: 2147483646;
                        transform: translate(-50%, -50%) scale(1);
                        opacity: 1;
                        transition: transform 0.5s ease-out, opacity 0.5s ease-out;
                    `;
                    document.body.appendChild(ripple);

                    requestAnimationFrame(() => {
                        ripple.style.transform = 'translate(-50%, -50%) scale(5.5)';
                        ripple.style.opacity = '0';
                    });

                    setTimeout(() => ripple.remove(), 550);
                }

                setTimeout(() => {
                    target.style.outline = prevOutline;
                    target.style.boxShadow = prevShadow;
                }, 700);
            }
        }, { id: elementId, type: actionType }).catch(() => {});
    } catch (e) {}
}

/**
 * Clicks an interactive element identified by its data-agent-id with robust new-tab & link handling.
 */
async function clickElement(elementId, elementDesc = '', elementsList = []) {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Browser page is not initialized');

    const matchedEl = elementsList.find(e => e.id === elementId);
    let selector = `[data-agent-id="${elementId}"]`;
    let target = await page.$(selector);

    // If data-agent-id was lost due to React re-render, fallback to text/class selector
    if (!target && matchedEl) {
        if (matchedEl.text && (matchedEl.text.toLowerCase().includes('add to cart') || matchedEl.text.toLowerCase() === 'add')) {
            target = await page.$('button:has-text("Add to cart"), div:has-text("Add to cart"), [data-testid*="add" i], button:has-text("ADD"), div:has-text("ADD"), #add-to-cart-button, input#add-to-cart-button');
        } else if (matchedEl.href) {
            target = await page.$(`a[href*="${matchedEl.href.slice(0, 30)}"]`);
        }
    }

    if (!target && matchedEl && matchedEl.href) {
        logger.info(`Element #${elementId} not found in DOM, navigating directly to href: ${matchedEl.href}`);
        await page.goto(matchedEl.href, { waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS });
        await page.waitForTimeout(1000);
        return;
    }

    if (!target) {
        throw new Error(`Element #${elementId} not found on current page`);
    }

    const urlBefore = page.url();

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);

    // Show visible glowing cursor on screen
    await showVisualCursor(page, elementId, 'click');
    await page.waitForTimeout(200);

    // Try standard click, with JS DOM click fallback
    try {
        await target.click({ timeout: DEFAULT_CONFIG.ACTION_TIMEOUT_MS });
    } catch (clickErr) {
        logger.warn(`Standard click failed on #${elementId}, trying direct DOM dispatch: ${clickErr.message}`);
        const clickedViaDOM = await page.evaluate((id) => {
            const el = document.querySelector(`[data-agent-id="${id}"]`);
            if (el) {
                el.scrollIntoView({ block: 'center' });
                el.click();
                if (el.tagName.toLowerCase() === 'a' && el.href && !el.href.startsWith('javascript')) {
                    window.location.href = el.href;
                }
                return true;
            }
            return false;
        }, elementId).catch(() => false);

        if (!clickedViaDOM) {
            await target.click({ force: true, timeout: 2000 }).catch(() => {});
        }
    }

    await page.waitForTimeout(1200);

    const activePage = getPage();
    const urlAfter = activePage.url();

    // If link click did not navigate, navigate directly
    if (matchedEl && matchedEl.type === 'a' && matchedEl.href && !matchedEl.href.startsWith('javascript') && urlAfter === urlBefore) {
        logger.info(`Link click did not navigate, navigating directly to: ${matchedEl.href}`);
        await activePage.goto(matchedEl.href, { waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await activePage.waitForTimeout(1000);
    }

    logger.success(`Clicked Element #${elementId} ${elementDesc ? `(${elementDesc})` : ''}`);
    await closePopupIfExists().catch(() => {});
}

/**
 * Types text into an input or textarea with resilient DOM fallback & search URL fallback.
 */
async function typeText(elementId, text, options = {}, elementDesc = '') {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Browser page is not initialized');

    const selector = `[data-agent-id="${elementId}"]`;
    let target = await page.$(selector);

    // Fallback: If element is not found or detached, find visible search input on the page
    if (!target) {
        target = await page.$('input#twotabsearchtextbox, input[name="field-keywords"], input[name="q"], input[type="search"], input[placeholder*="search" i]:visible, input[type="text"]:visible');
    }

    if (!target) {
        throw new Error(`Input Element #${elementId} not found`);
    }

    let actualInput = target;
    const isStandardInput = await target.evaluate(el => {
        const tag = el.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || el.getAttribute('contenteditable') === 'true';
    }).catch(() => false);

    if (!isStandardInput) {
        const inner = await target.$('input:not([type="hidden"]), textarea, [contenteditable="true"]');
        if (inner) {
            actualInput = inner;
        }
    }

    await actualInput.scrollIntoViewIfNeeded().catch(() => {});
    await actualInput.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100);

    // Show visual cursor on input
    await showVisualCursor(page, elementId, 'type');

    let fillSucceeded = false;
    try {
        await actualInput.fill('', { timeout: 2000 }).catch(() => {});
        await actualInput.fill(text, { timeout: 2500 });
        logger.success(`Typed "${text}" into Element #${elementId} ${elementDesc ? `(${elementDesc})` : ''}`);
        fillSucceeded = true;
    } catch (fillErr) {
        logger.warn(`target.fill failed, falling back to keyboard type: ${fillErr.message}`);
    }

    if (!fillSucceeded) {
        await page.keyboard.type(text, { delay: 25 });
        logger.success(`Typed "${text}" via keyboard into Element #${elementId}`);
    }

    if (options.pressEnter || options.press_enter) {
        const urlBefore = page.url();

        // Submit search natively
        await actualInput.press('Enter').catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(1500);

        const currentUrl = page.url();

        // Fallback: If on Amazon/Flipkart and search didn't navigate to results page, navigate directly to search URL
        if (currentUrl.includes('amazon.in') && (!currentUrl.includes('/s?') && !currentUrl.includes('k='))) {
            logger.info(`Directing to Amazon search URL for "${text}"...`);
            await page.goto(`https://www.amazon.in/s?k=${encodeURIComponent(text)}`, { waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS });
            await page.waitForTimeout(1200);
        } else if (currentUrl.includes('flipkart.com') && (!currentUrl.includes('/search?') && !currentUrl.includes('q='))) {
            logger.info(`Directing to Flipkart search URL for "${text}"...`);
            await page.goto(`https://www.flipkart.com/search?q=${encodeURIComponent(text)}`, { waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS });
            await page.waitForTimeout(1200);
        }

        logger.success(`Submitted search for "${text}"`);
    } else {
        await page.waitForTimeout(400);
    }
}

/**
 * Selects an option in a <select> dropdown element.
 */
async function selectOption(elementId, value, elementDesc = '') {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Browser page is not initialized');

    const selector = `[data-agent-id="${elementId}"]`;
    const target = await page.$(selector);

    if (!target) {
        throw new Error(`Select Element #${elementId} not found`);
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.selectOption({ label: value }, { timeout: 2500 }).catch(async () => {
        await target.selectOption({ value: value }, { timeout: 2500 });
    });

    logger.success(`Selected option "${value}" in Element #${elementId} ${elementDesc ? `(${elementDesc})` : ''}`);
    await page.waitForTimeout(500);
}

/**
 * Scrolls the active page up or down.
 */
async function scrollPage(direction = 'down', amount = 600) {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Browser page is not initialized');

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
    if (!page || page.isClosed()) throw new Error('Browser page is not initialized');

    await page.keyboard.press('Enter');
    logger.success('Pressed Enter key');
    await page.waitForTimeout(1500);
}

/**
 * Generic unified action dispatcher with element target inspection.
 */
async function executeAction(action, elementsList = []) {
    if (!action || !action.action) {
        throw new Error('Invalid action object provided to executeAction');
    }

    const elementDesc = action.element_id ? describeElement(action.element_id, elementsList) : '';

    if (action.action === ACTION_TYPES.CLICK) {
        logger.elementTarget('click', action.element_id, elementDesc);
    } else if (action.action === ACTION_TYPES.TYPE) {
        logger.elementTarget('type', action.element_id, elementDesc, `"${action.text}"`);
    } else {
        logger.action(action);
    }

    try {
        switch (action.action) {
            case ACTION_TYPES.CLICK:
                await clickElement(action.element_id, elementDesc, elementsList);
                return { success: true, action: action.action, message: `Clicked ${elementDesc}` };

            case ACTION_TYPES.TYPE:
                await typeText(action.element_id, action.text, { pressEnter: action.press_enter || false }, elementDesc);
                return { success: true, action: action.action, message: `Typed "${action.text}" into ${elementDesc}` };

            case ACTION_TYPES.SELECT:
                await selectOption(action.element_id, action.value, elementDesc);
                return { success: true, action: action.action, message: `Selected "${action.value}" on ${elementDesc}` };

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
                if (page && !page.isClosed()) await page.waitForTimeout(waitMs);
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

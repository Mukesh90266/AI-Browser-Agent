// ActionExecutor.js — Generic browser action execution with Live Visual Cursor, element inspection, and multi-tab link navigation

const { getPage, navigateTo, goBack } = require('./BrowserManager');
const { closePopupIfExists } = require('./PopupHandler');
const { ACTION_TYPES, DEFAULT_CONFIG } = require('../utils/constants');
const { inspectCartState, didCartStateAdvance } = require('./CartInspector');
const logger = require('../utils/logger');

/**
 * Helper to get element description for human-readable logging.
 */
function describeElement(elementId, elementsList = []) {
    const el = elementsList.find(e => e.id === elementId);
    if (!el) return `[Element #${elementId}]`;
    const label = (el.text || el.placeholder || el.name || el.href || '').slice(0, 60);
    const context = el.context ? ` for "${el.context.slice(0, 80)}"` : '';
    return `[${el.type}${el.inputType ? `:${el.inputType}` : ''}] "${label}"${context}`;
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

            const target = document.querySelector(`[data-agent-id="${id}"]`) || document.querySelector('#add-to-cart-button, span#submit\\.add-to-cart, input#twotabsearchtextbox, input[name="q"]');
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
 * Marks the selected product/card before clicking so React state transitions can
 * be verified even when the original ADD node is replaced.
 */
async function captureCartTargetScope(page, elementId) {
    const token = `cart-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return await page.evaluate(({ id, scopeToken }) => {
        const target = document.querySelector(`[data-agent-id="${id}"]`);
        if (!target) return { found: false, token: scopeToken };

        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const scope = target.closest([
            '[data-testid*="product" i]',
            '[data-testid*="item" i]',
            '[class*="product-card" i]',
            '[class*="ProductCard" i]',
            '[role="listitem"]',
            'article',
            'li',
        ].join(', ')) || target.parentElement || target;

        scope.setAttribute('data-agent-cart-scope', scopeToken);
        target.setAttribute('data-agent-cart-control', scopeToken);
        const scopeText = normalize(scope.innerText || scope.textContent).slice(0, 300);
        const targetText = normalize(target.innerText || target.value || target.textContent);
        const hadQuantity = /(?:^|\s)[−-]\s*\d+\s*\+(?:\s|$)/.test(scopeText) ||
            !!scope.querySelector([
                '[aria-label*="decrease" i]',
                '[data-testid*="decrement" i]',
                '[data-testid*="decrease" i]',
                '[class*="quantity" i]',
                '[class*="counter" i]',
            ].join(', '));

        return {
            found: true,
            token: scopeToken,
            targetText,
            scopeText,
            hadQuantity,
        };
    }, { id: elementId, scopeToken: token }).catch(() => ({ found: false, token }));
}

async function inspectCartTargetScope(page, targetScope) {
    if (!targetScope?.found) return { advanced: false, hasQuantity: false };

    return await page.evaluate(({ token, previousTargetText, hadQuantity }) => {
        const scope = document.querySelector(`[data-agent-cart-scope="${token}"]`);
        if (!scope) return { advanced: false, hasQuantity: false, scopeMissing: true };

        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const scopeText = normalize(scope.innerText || scope.textContent).slice(0, 300);
        const quantityBySelector = !!scope.querySelector([
            '[aria-label*="decrease" i]',
            '[aria-label*="decrement" i]',
            '[data-testid*="decrement" i]',
            '[data-testid*="decrease" i]',
            '[class*="quantity" i]',
            '[class*="counter" i]',
        ].join(', '));
        const quantityByText = /(?:^|\s)[−-]\s*\d+\s*\+(?:\s|$)/.test(scopeText);
        const hasQuantity = quantityBySelector || quantityByText;

        const markedTarget = scope.querySelector(`[data-agent-cart-control="${token}"]`);
        const currentTargetText = normalize(
            markedTarget?.innerText || markedTarget?.value || markedTarget?.textContent,
        );
        const addPattern = /^(?:(?:\+\s*)?add(?:\s*\+)?|add item|add to (?:cart|bag|basket))$/i;
        const wasAddControl = addPattern.test(previousTargetText || '');
        const targetChanged = wasAddControl && currentTargetText && !addPattern.test(currentTargetText);

        return {
            advanced: (!hadQuantity && hasQuantity) || targetChanged || /\badded\b/i.test(scopeText),
            hasQuantity,
            scopeText,
        };
    }, {
        token: targetScope.token,
        previousTargetText: targetScope.targetText,
        hadQuantity: targetScope.hadQuantity,
    }).catch(() => ({ advanced: false, hasQuantity: false }));
}

/**
 * Some food sites show a customization dialog after ADD. Confirm only an
 * explicit add-to-order action inside a visible dialog.
 */
async function confirmCartCustomizationIfPresent(page) {
    // Select one available option from each required radio group before confirming.
    await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i]'));
        const dialog = dialogs.find((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (!dialog) return;

        const radioGroups = new Map();
        dialog.querySelectorAll('input[type="radio"]').forEach((radio) => {
            const key = radio.name || radio.closest('fieldset, [role="radiogroup"]') || 'default';
            if (!radioGroups.has(key)) radioGroups.set(key, []);
            radioGroups.get(key).push(radio);
        });
        radioGroups.forEach((radios) => {
            if (!radios.some(radio => radio.checked)) {
                const available = radios.find(radio => !radio.disabled && radio.getAttribute('aria-disabled') !== 'true');
                available?.click();
            }
        });

        dialog.querySelectorAll('[role="radiogroup"]').forEach((group) => {
            if (!group.querySelector('[role="radio"][aria-checked="true"]')) {
                const available = group.querySelector('[role="radio"]:not([aria-disabled="true"])');
                available?.click();
            }
        });
    }).catch(() => {});

    const selectors = [
        '[role="dialog"] button:has-text("Repeat Last")',
        '[role="dialog"] button:has-text("Add Item")',
        '[role="dialog"] button:has-text("Add to Cart")',
        '[role="dialog"] button:has-text("Add to cart")',
        '[role="dialog"] button:has-text("Add to Bag")',
        '[role="dialog"] button:has-text("Add to Basket")',
        '[role="dialog"] [role="button"]:has-text("Add Item")',
        '[class*="modal" i] button:has-text("Add Item")',
    ];

    for (const selector of selectors) {
        const control = await page.$(selector).catch(() => null);
        if (control && await control.isVisible().catch(() => false)) {
            await control.click({ timeout: 2500 }).catch(() => {});
            logger.info('Confirmed item customization dialog');
            await page.waitForTimeout(800);
            return true;
        }
    }

    return false;
}

/**
 * Selects the first available size when a product page requires one before cart addition.
 */
async function selectRequiredSizeIfPresent(page) {
    const url = page.url().toLowerCase();
    if (!url.includes('flipkart.') && !url.includes('myntra.')) return false;

    const selected = await page.evaluate(() => {
        const selectors = [
            'div._2OTVHc a',
            'div._3V2wfe a',
            'ul._1q8KgP a',
            'li._3V2wfe a',
            '[class*="size-buttons-size-button" i]',
            '[class*="size" i] button',
        ].join(', ');
        const candidates = Array.from(document.querySelectorAll(selectors));
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden';
        };
        const isUnavailable = (element) => {
            const marker = `${element.className || ''} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
            return element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' ||
                /disabled|strike|unavailable|out.of.stock/.test(marker);
        };
        const alreadySelected = candidates.some((element) => {
            const marker = `${element.className || ''} ${element.getAttribute('aria-pressed') || ''}`.toLowerCase();
            return visible(element) && /\b(selected|active|checked|true)\b/.test(marker);
        });
        if (alreadySelected) return false;

        const available = candidates.find(element => visible(element) && !isUnavailable(element));
        if (!available) return false;
        available.scrollIntoView({ block: 'center', inline: 'center' });
        available.click();
        return true;
    }).catch(() => false);

    if (selected) {
        logger.info('Selected the first available product size before adding to cart');
        await page.waitForTimeout(1000);
    }
    return selected;
}

/**
 * Universal Add to Cart executor for native buttons and React div/span controls.
 * It clicks exactly once (unless the first click throws) and verifies a cart-state transition.
 */
async function performAddToCart(page, elementId, matchedElement = null) {
    if (!page || page.isClosed()) {
        return { success: false, clicked: false, error: 'Browser page is not initialized' };
    }

    await selectRequiredSizeIfPresent(page);
    const beforeCart = await inspectCartState(page);
    const targetScope = await captureCartTargetScope(page, elementId);
    let target = await page.$(`[data-agent-id="${elementId}"]`);

    // If React replaced the node between extraction and execution, recover by exact visible text.
    if (!target && (matchedElement?.actionText || matchedElement?.text)) {
        const exactText = (matchedElement.actionText || matchedElement.text).trim();
        target = await page.getByText(exactText, { exact: true })
            .first()
            .elementHandle()
            .catch(() => null);
    }

    // Last-resort selectors cover product-detail pages where the extracted node detached.
    if (!target) {
        const fallbackSelectors = [
            '#add-to-cart-button',
            'input[name="submit.add-to-cart"]',
            '#submit\\.add-to-cart',
            'button:has-text("Add to Cart")',
            'button:has-text("ADD TO CART")',
            'button:has-text("Add to Bag")',
            'button:has-text("Add to Basket")',
            '[role="button"]:has-text("Add to Cart")',
            '[data-testid*="add-to-cart" i]',
            '[data-testid*="add-btn" i]',
        ];
        for (const selector of fallbackSelectors) {
            const candidate = await page.$(selector).catch(() => null);
            if (candidate && await candidate.isVisible().catch(() => false)) {
                target = candidate;
                break;
            }
        }
    }

    if (!target) {
        return { success: false, clicked: false, error: `Add control #${elementId} was not found` };
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);

    let clicked = false;
    try {
        await target.click({ timeout: 3000, noWaitAfter: true });
        clicked = true;
    } catch (standardClickError) {
        logger.warn(`Standard cart click failed; trying one force-click: ${standardClickError.message}`);
        try {
            await target.click({ force: true, timeout: 2500, noWaitAfter: true });
            clicked = true;
        } catch (forceClickError) {
            return {
                success: false,
                clicked: false,
                error: `Add control could not be clicked: ${forceClickError.message}`,
            };
        }
    }

    // Wait for React/network state, checking both global cart signals and the selected card.
    let afterCart = beforeCart;
    let scopeState = { advanced: false, hasQuantity: false };
    for (let attempt = 0; attempt < 3; attempt++) {
        await page.waitForTimeout(700);
        afterCart = await inspectCartState(page);
        scopeState = await inspectCartTargetScope(page, targetScope);
        if (didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced) break;
    }

    if (!didCartStateAdvance(beforeCart, afterCart) && !scopeState.advanced) {
        const confirmedCustomization = await confirmCartCustomizationIfPresent(page);
        if (confirmedCustomization) {
            for (let attempt = 0; attempt < 2; attempt++) {
                await page.waitForTimeout(700);
                afterCart = await inspectCartState(page);
                scopeState = await inspectCartTargetScope(page, targetScope);
                if (didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced) break;
            }
        }
    }

    const verified = didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced;
    if (!verified) {
        return {
            success: false,
            clicked,
            cartVerified: false,
            cartState: afterCart,
            error: 'Add control was clicked once, but no cart count, cart summary, or quantity-control change was detected. Inspect the page before retrying.',
        };
    }

    const evidence = afterCart.evidence?.join('; ') ||
        (scopeState.hasQuantity ? 'selected ADD control changed into quantity controls' : 'selected product state changed');

    return {
        success: true,
        clicked,
        cartVerified: true,
        cartState: afterCart,
        message: `Item added to cart and verified (${evidence})`,
    };
}

/**
 * Clicks an interactive element identified by its data-agent-id with robust new-tab & link handling.
 */
async function clickElement(elementId, elementDesc = '', elementsList = []) {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Browser page is not initialized');

    const matchedEl = elementsList.find(e => e.id === elementId);
    const selector = `[data-agent-id="${elementId}"]`;
    let target = await page.$(selector);
    const liveTargetText = target
        ? await target.evaluate(el => (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim()).catch(() => '')
        : '';
    const cartActionPattern = /^(?:(?:\+\s*)?add(?:\s*\+)?|add item|add to (?:cart|bag|basket))$/i;
    const isCartAction = matchedEl?.isCartAction === true ||
        cartActionPattern.test((matchedEl?.actionText || matchedEl?.text || liveTargetText).trim()) ||
        /"(?:add|add item|add to cart|add to bag|add to basket)"/i.test(elementDesc);
    const isSizeAction = matchedEl && (matchedEl.type === 'size option' || matchedEl.isSize);

    // Cart actions use one selected target and must prove that cart state changed.
    if (isCartAction) {
        await showVisualCursor(page, elementId, 'click');
        const cartResult = await performAddToCart(page, elementId, matchedEl);
        if (!cartResult.success) {
            throw new Error(cartResult.error || 'Add to cart could not be verified');
        }

        logger.success(cartResult.message);
        await closePopupIfExists().catch(() => {});
        return cartResult;
    }

    // If size option target was lost, fallback to size button
    if (!target && isSizeAction) {
        target = await page.$('div._2OTVHc a, div._3V2wfe a, ul._1q8KgP a, [class*="size" i] a');
    }

    if (!target && matchedEl && matchedEl.type === 'a' && matchedEl.href && !isCartAction && !isSizeAction && matchedEl.href.length > 5) {
        logger.info(`Element #${elementId} not found in DOM, navigating directly to href: ${matchedEl.href}`);
        await page.goto(matchedEl.href, { waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS });
        await page.waitForTimeout(1000);
        return;
    }

    if (!target) {
        throw new Error(`Element #${elementId} not found on current page`);
    }

    const urlBefore = page.url();

    // Scroll element into center of viewport before clicking!
    await page.evaluate((id) => {
        const el = document.querySelector(`[data-agent-id="${id}"]`) || document.getElementById('add-to-cart-button');
        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
    }, elementId).catch(() => {});

    await page.waitForTimeout(200);

    // Show visible glowing cursor on screen
    await showVisualCursor(page, elementId, 'click');
    await page.waitForTimeout(200);

    // Click target with force fallback
    try {
        await target.click({ force: true, timeout: 3000 });
    } catch (clickErr) {
        logger.warn(`Standard click failed on #${elementId}, trying direct dispatch: ${clickErr.message}`);
        await page.evaluate(({ id, isAction, isSize }) => {
            const el = document.querySelector(`[data-agent-id="${id}"]`) || document.getElementById('add-to-cart-button');
            if (el) {
                el.scrollIntoView({ block: 'center' });
                el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                if (isAction && window.location.hostname.includes('amazon') && el.form && el.form.id === 'addToCart') {
                    const event = new Event('submit', { bubbles: true, cancelable: true });
                    el.form.dispatchEvent(event);
                }
                if (!isAction && !isSize && el.tagName.toLowerCase() === 'a' && el.href && !el.href.startsWith('javascript') && el.href.length > 5) {
                    window.location.href = el.href;
                }
                return true;
            }
            return false;
        }, { id: elementId, isAction: isCartAction, isSize: isSizeAction }).catch(() => false);
    }

    await page.waitForTimeout(1200);

    const activePage = getPage();
    const urlAfter = activePage.url();

    // If it is a real navigation link (NOT an Add to Cart button or Size option) and URL didn't change, navigate directly
    if (!isCartAction && !isSizeAction && matchedEl && matchedEl.type === 'a' && matchedEl.href && !matchedEl.href.startsWith('javascript') && matchedEl.href.length > 8 && urlAfter === urlBefore) {
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
            case ACTION_TYPES.CLICK: {
                const clickResult = await clickElement(action.element_id, elementDesc, elementsList);
                return {
                    success: true,
                    action: action.action,
                    message: clickResult?.message || `Clicked ${elementDesc}`,
                    cartVerified: clickResult?.cartVerified || false,
                    cartState: clickResult?.cartState,
                };
            }

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
    performAddToCart,
    typeText,
    selectOption,
    scrollPage,
    pressEnter,
    executeAction,
};

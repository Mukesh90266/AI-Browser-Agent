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
        const targetRect = target.getBoundingClientRect();
        const rect = {
            left: targetRect.left,
            right: targetRect.right,
            top: targetRect.top,
            bottom: targetRect.bottom,
            width: targetRect.width,
            height: targetRect.height,
            centerX: targetRect.left + targetRect.width / 2,
            centerY: targetRect.top + targetRect.height / 2,
        };

        // Mark several ancestors. React storefronts often replace the immediate
        // ADD wrapper with a counter, while a slightly higher ancestor survives.
        const markedScopes = [];
        let ancestor = target.parentElement || target;
        for (let depth = 0; ancestor && depth < 8; depth++) {
            if (ancestor === document.body || ancestor === document.documentElement) break;
            ancestor.setAttribute('data-agent-cart-scope', scopeToken);
            ancestor.setAttribute('data-agent-cart-scope-depth', String(depth));
            markedScopes.push(ancestor);
            ancestor = ancestor.parentElement;
        }
        target.setAttribute('data-agent-cart-control', scopeToken);

        const contextScope = markedScopes.find((scope) => {
            const text = normalize(scope.innerText || scope.textContent);
            return text.length > normalize(target.innerText || target.textContent).length && text.length <= 500;
        }) || markedScopes[0] || target;
        const scopeText = normalize(contextScope.innerText || contextScope.textContent).slice(0, 300);
        const targetText = normalize(target.innerText || target.value || target.textContent);
        const hadQuantity = /(?:^|\s)[−–—-]\s*\d+\s*\+(?:\s|$)/.test(scopeText) ||
            !!contextScope.querySelector([
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
            rect,
        };
    }, { id: elementId, scopeToken: token }).catch(() => ({ found: false, token }));
}

async function inspectCartTargetScope(page, targetScope) {
    if (!targetScope?.found) return { advanced: false, hasQuantity: false, quantity: 0 };

    return await page.evaluate(({ token, previousTargetText, hadQuantity, anchorRect }) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const nearAnchor = (element, paddingX = 180, paddingY = 100) => {
            if (!anchorRect || !visible(element)) return false;
            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX >= anchorRect.left - paddingX && centerX <= anchorRect.right + paddingX &&
                centerY >= anchorRect.top - paddingY && centerY <= anchorRect.bottom + paddingY;
        };
        const numericText = (element) => normalize(
            element?.value || element?.getAttribute?.('aria-valuenow') ||
            element?.innerText || element?.textContent,
        );
        const findSiblingCounter = (numberNode, boundary) => {
            let branch = numberNode;
            for (let depth = 0; branch?.parentElement && depth < 5; depth++) {
                const parent = branch.parentElement;
                if (boundary !== document && !boundary.contains(parent)) break;
                const children = Array.from(parent.children).filter(visible);
                const index = children.findIndex((child) => child === branch || child.contains(branch));
                if (index > 0 && index < children.length - 1) {
                    const left = children[index - 1].getBoundingClientRect();
                    const number = numberNode.getBoundingClientRect();
                    const right = children[index + 1].getBoundingClientRect();
                    if (left.right <= number.right && right.left >= number.left && nearAnchor(parent)) {
                        return { container: parent, increment: children[index + 1] };
                    }
                }
                branch = parent;
            }
            return null;
        };
        const readCounter = (root) => {
            if (!root) return null;
            const nodes = [root, ...root.querySelectorAll('input, [aria-valuenow], div, span, p')];

            // Text-rendered counters, including custom React div/span controls.
            for (const element of nodes) {
                if (!nearAnchor(element) || element.children.length > 8) continue;
                const text = numericText(element);
                const match = text.match(/^[−–—-]\s*(\d{1,2})\s*(?:\+|＋)$/);
                if (match) return { quantity: Number(match[1]), container: element };
            }

            // Semantic quantity values or a numeric node between left/right controls.
            const numberNodes = nodes.filter((element) => {
                if (!nearAnchor(element)) return false;
                const text = numericText(element);
                if (!/^\d{1,2}$/.test(text)) return false;
                const childHasSameNumber = Array.from(element.children || [])
                    .some((child) => numericText(child) === text);
                return !childHasSameNumber;
            }).sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                const ad = Math.abs((ar.left + ar.width / 2) - anchorRect.centerX) +
                    Math.abs((ar.top + ar.height / 2) - anchorRect.centerY);
                const bd = Math.abs((br.left + br.width / 2) - anchorRect.centerX) +
                    Math.abs((br.top + br.height / 2) - anchorRect.centerY);
                return ad - bd;
            });

            for (const numberNode of numberNodes) {
                const value = Number(numericText(numberNode));
                if (value < 1 || value > 20) continue;
                const semantic = numberNode.matches('[aria-valuenow], input[name*="quantity" i], input[aria-label*="quantity" i], [data-testid*="quantity" i]');
                const siblingCounter = findSiblingCounter(numberNode, root);
                if (semantic || siblingCounter) {
                    return {
                        quantity: value,
                        container: siblingCounter?.container || numberNode.parentElement || numberNode,
                    };
                }
            }
            return null;
        };

        const scopes = Array.from(document.querySelectorAll(`[data-agent-cart-scope="${token}"]`))
            .filter(visible)
            .sort((a, b) => Number(a.getAttribute('data-agent-cart-scope-depth') || 99) -
                Number(b.getAttribute('data-agent-cart-scope-depth') || 99));

        let counter = null;
        for (const scope of scopes) {
            counter = readCounter(scope);
            if (counter) break;
        }
        // If React replaced all marked wrappers, reacquire only at the original
        // ADD coordinates. This is selected-product recovery, not a page-wide guess.
        if (!counter) counter = readCounter(document);

        const markedTarget = document.querySelector(`[data-agent-cart-control="${token}"]`);
        const currentTargetText = normalize(
            markedTarget?.innerText || markedTarget?.value || markedTarget?.textContent,
        );
        const addPattern = /^(?:(?:\+\s*)?add(?:\s*\+)?|add item|add to (?:cart|bag|basket))$/i;
        const postAddPattern = /^(?:added|in (?:cart|bag|basket)|go to (?:cart|bag|basket)|view (?:cart|bag|basket))$/i;
        const wasAddControl = addPattern.test(previousTargetText || '');
        const targetChanged = wasAddControl && postAddPattern.test(currentTargetText);

        const actionNodes = Array.from(document.querySelectorAll([
            '#add-to-cart-button',
            'input[name="submit.add-to-cart"]',
            'button',
            '[role="button"]',
            'a',
            'div',
            'span',
        ].join(', '))).filter((element) => nearAnchor(element, 120, 80));
        const selectedAddPresent = actionNodes.some((element) => addPattern.test(normalize(
            element.innerText || element.value || element.textContent || element.getAttribute('aria-label'),
        )));
        const postAddControl = actionNodes.find((element) => postAddPattern.test(normalize(
            element.innerText || element.value || element.textContent || element.getAttribute('aria-label'),
        )));
        const postAddState = !!postAddControl;
        const scopeText = normalize(
            counter?.container?.innerText || counter?.container?.textContent ||
            postAddControl?.innerText || postAddControl?.textContent || '',
        ).slice(0, 300);
        const hasQuantity = !!counter;

        return {
            advanced: (!hadQuantity && hasQuantity) || targetChanged || postAddState || /\badded\b/i.test(scopeText),
            hasQuantity,
            quantity: counter?.quantity || 0,
            scopeText,
            selectedAddPresent,
            postAddState,
            addControlDisappeared: wasAddControl && !selectedAddPresent,
            transitionEvidence: postAddState
                ? normalize(postAddControl.innerText || postAddControl.textContent || 'post-add cart control')
                : '',
            recoveredByPosition: hasQuantity && !scopes.some((scope) => scope.contains(counter.container)),
        };
    }, {
        token: targetScope.token,
        previousTargetText: targetScope.targetText,
        hadQuantity: targetScope.hadQuantity,
        anchorRect: targetScope.rect,
    }).catch(() => ({ advanced: false, hasQuantity: false, quantity: 0 }));
}

/**
 * Finds the + control belonging to the product that was just added.
 */
async function findIncrementControl(page, targetScope, productHint = '') {
    const token = `quantity-plus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await page.evaluate(({ scopeToken, marker, hint, anchorRect }) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                style.opacity !== '0';
        };
        const nearAnchor = (element, paddingX = 180, paddingY = 100) => {
            if (!anchorRect || !visible(element)) return false;
            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX >= anchorRect.left - paddingX && centerX <= anchorRect.right + paddingX &&
                centerY >= anchorRect.top - paddingY && centerY <= anchorRect.bottom + paddingY;
        };
        const numericText = (element) => normalize(
            element?.value || element?.getAttribute?.('aria-valuenow') ||
            element?.innerText || element?.textContent,
        );
        const clickableTarget = (element, boundary) => {
            if (!element) return null;
            const semantic = element.closest('button, [role="button"], [onclick]');
            if (semantic && semantic !== boundary &&
                (boundary === document || boundary.contains(semantic)) && visible(semantic)) return semantic;

            let current = element;
            for (let depth = 0; current && depth < 3; depth++) {
                if ((boundary === document || boundary.contains(current)) && visible(current) &&
                    window.getComputedStyle(current).pointerEvents !== 'none') {
                    return current;
                }
                current = current.parentElement;
            }
            return element;
        };
        const siblingIncrement = (numberNode, boundary) => {
            let branch = numberNode;
            for (let depth = 0; branch?.parentElement && depth < 5; depth++) {
                const parent = branch.parentElement;
                if (boundary !== document && !boundary.contains(parent)) break;
                const children = Array.from(parent.children).filter(visible);
                const index = children.findIndex((child) => child === branch || child.contains(branch));
                if (index > 0 && index < children.length - 1) {
                    const left = children[index - 1].getBoundingClientRect();
                    const number = numberNode.getBoundingClientRect();
                    const right = children[index + 1].getBoundingClientRect();
                    if (left.right <= number.right && right.left >= number.left && nearAnchor(parent)) {
                        return {
                            container: parent,
                            increment: clickableTarget(children[index + 1], parent),
                        };
                    }
                }
                branch = parent;
            }
            return null;
        };
        const candidateDistance = (element) => {
            const rect = element.getBoundingClientRect();
            return Math.abs((rect.left + rect.width / 2) - anchorRect.centerX) +
                Math.abs((rect.top + rect.height / 2) - anchorRect.centerY);
        };
        const findInRoot = (root) => {
            if (!root) return null;
            const selectors = [
                'button[aria-label*="increase" i]',
                'button[aria-label*="increment" i]',
                '[role="button"][aria-label*="increase" i]',
                '[role="button"][aria-label*="increment" i]',
                '[aria-label*="add one" i]',
                '[data-testid*="increment" i]',
                '[data-testid*="increase" i]',
                '[class*="increment" i]',
                '[class*="plus" i]',
                'button',
                '[role="button"]',
                '[onclick]',
                'div',
                'span',
            ].join(', ');
            const exactCandidates = Array.from(root.querySelectorAll(selectors)).filter((element) => {
                if (!nearAnchor(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
                const text = normalize(element.innerText || element.textContent || element.value);
                const metadata = normalize([
                    element.getAttribute('aria-label'),
                    element.getAttribute('title'),
                    element.getAttribute('data-testid'),
                    element.className && typeof element.className === 'string' ? element.className : '',
                ].filter(Boolean).join(' '));
                return /increase|increment|add one|plus/i.test(metadata) || /^(?:\+|＋)$/.test(text);
            }).sort((a, b) => candidateDistance(a) - candidateDistance(b));
            if (exactCandidates.length > 0) {
                return { increment: clickableTarget(exactCandidates[0], root), container: exactCandidates[0].parentElement };
            }

            // Icon-only counters (including Blinkit) may expose neither text nor
            // ARIA. Identify the number between left/right controls and click its
            // right sibling, which is the selected counter's increment control.
            const numberNodes = Array.from(root.querySelectorAll('input, [aria-valuenow], div, span, p'))
                .filter((element) => {
                    if (!nearAnchor(element)) return false;
                    const text = numericText(element);
                    if (!/^\d{1,2}$/.test(text)) return false;
                    return !Array.from(element.children || []).some((child) => numericText(child) === text);
                })
                .sort((a, b) => candidateDistance(a) - candidateDistance(b));

            for (const numberNode of numberNodes) {
                const quantity = Number(numericText(numberNode));
                if (quantity < 1 || quantity > 20) continue;
                const counter = siblingIncrement(numberNode, root);
                if (counter?.increment) return counter;
            }
            return null;
        };

        const scopes = Array.from(document.querySelectorAll(`[data-agent-cart-scope="${scopeToken}"]`))
            .filter(visible)
            .sort((a, b) => Number(a.getAttribute('data-agent-cart-scope-depth') || 99) -
                Number(b.getAttribute('data-agent-cart-scope-depth') || 99));
        let selected = null;
        for (const scope of scopes) {
            selected = findInRoot(scope);
            if (selected) break;
        }
        // Safe recovery after a React replacement: candidates still must form a
        // counter at the original selected ADD coordinates.
        if (!selected) selected = findInRoot(document);
        if (!selected?.increment) return false;

        selected.increment.setAttribute('data-agent-quantity-increment', marker);
        if (selected.container && selected.container !== document.body) {
            selected.container.setAttribute('data-agent-cart-scope', scopeToken);
            selected.container.setAttribute('data-agent-cart-scope-depth', '0');
        }
        return true;
    }, {
        scopeToken: targetScope?.token || null,
        marker: token,
        hint: productHint,
        anchorRect: targetScope?.rect || null,
    }).catch(() => false);

    if (!found) return null;
    return await page.$(`[data-agent-quantity-increment="${token}"]`).catch(() => null);
}

async function ensureCartQuantity(page, targetScope, requestedQuantity, initialScopeState, initialCartState, productHint = '') {
    const desired = Math.min(Math.max(Number(requestedQuantity) || 1, 1), 20);
    let scopeState = initialScopeState || { quantity: 0 };
    let cartState = initialCartState || await inspectCartState(page);
    let currentQuantity = scopeState.quantity || 1;

    if (currentQuantity === desired) {
        return { success: true, quantity: currentQuantity, scopeState, cartState };
    }
    if (currentQuantity > desired) {
        return {
            success: false,
            quantity: currentQuantity,
            scopeState,
            cartState,
            error: `Selected product quantity is ${currentQuantity}, not the requested quantity ${desired}`,
        };
    }

    while (currentQuantity < desired) {
        const incrementControl = await findIncrementControl(page, targetScope, productHint);
        if (!incrementControl) {
            return {
                success: false,
                quantity: currentQuantity,
                scopeState,
                cartState,
                error: `Item was added, but the + quantity control was not found (requested quantity: ${desired})`,
            };
        }

        let clicked = false;
        try {
            await incrementControl.click({ timeout: 2500, noWaitAfter: true });
            clicked = true;
        } catch {
            await incrementControl.click({ force: true, timeout: 2000, noWaitAfter: true }).then(() => {
                clicked = true;
            }).catch(() => {});
        }
        if (!clicked) {
            return {
                success: false,
                quantity: currentQuantity,
                scopeState,
                cartState,
                error: `Could not click the + quantity control for requested quantity ${desired}`,
            };
        }

        let detectedQuantity = currentQuantity;
        for (let attempt = 0; attempt < 3; attempt++) {
            await page.waitForTimeout(500);
            scopeState = await inspectCartTargetScope(page, targetScope);
            cartState = await inspectCartState(page);
            // A global cart count can include other products, so only the
            // selected product counter can prove its requested quantity.
            detectedQuantity = Math.max(detectedQuantity, scopeState.quantity || 0);
            if (detectedQuantity > currentQuantity) break;
        }

        if (detectedQuantity <= currentQuantity) {
            return {
                success: false,
                quantity: currentQuantity,
                scopeState,
                cartState,
                error: `Clicked + once, but quantity did not increase beyond ${currentQuantity}`,
            };
        }
        currentQuantity = detectedQuantity;
    }

    if (currentQuantity !== desired) {
        return {
            success: false,
            quantity: currentQuantity,
            scopeState,
            cartState,
            error: `Selected product quantity is ${currentQuantity}, not the requested quantity ${desired}`,
        };
    }
    return { success: true, quantity: currentQuantity, scopeState, cartState };
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
async function selectRequiredSizeIfPresent(page, requestedSize = null) {
    const url = page.url().toLowerCase();
    if (!url.includes('flipkart.') && !url.includes('myntra.')) return false;

    const selected = await page.evaluate((preferredSize) => {
        const selectors = [
            'div._2OTVHc a',
            'div._3V2wfe a',
            'ul._1q8KgP a',
            'li._3V2wfe a',
            '[class*="size-buttons-size-button" i]',
            '[class*="size" i] button',
        ].join(', ');
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden';
        };

        const candidates = Array.from(document.querySelectorAll(selectors));
        const sizePattern = /^(?:UK\s*)?(?:[3-9]|1[0-3])(?:\.5)?$|^(?:XS|S|M|L|XL|XXL)$/i;
        Array.from(document.querySelectorAll('button, a, [role="button"], li, div, span')).forEach((element) => {
            if (candidates.includes(element) || !visible(element)) return;
            const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
            if (!sizePattern.test(text)) return;

            let contextNode = element.parentElement;
            let contextText = '';
            for (let depth = 0; contextNode && depth < 4; depth++) {
                contextText += ` ${(contextNode.innerText || '').slice(0, 250)}`;
                contextNode = contextNode.parentElement;
            }
            if (/select\s+size|size\s*[-:]|uk\s*\/\s*india|\bsize\b/i.test(contextText)) {
                candidates.push(element);
            }
        });

        const isUnavailable = (element) => {
            const marker = `${element.className || ''} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
            const style = window.getComputedStyle(element);
            return element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true' ||
                style.pointerEvents === 'none' || style.textDecorationLine.includes('line-through') ||
                Number(style.opacity) < 0.35 || /disabled|strike|unavailable|out.of.stock/.test(marker);
        };
        const selectedElement = candidates.find((element) => {
            const marker = `${element.className || ''} ${element.getAttribute('aria-pressed') || ''}`.toLowerCase();
            return visible(element) && /\b(selected|active|checked|true)\b/.test(marker);
        });
        const normalizedPreferred = (preferredSize || '').toString().replace(/^UK\s*/i, '').trim().toLowerCase();
        const selectedText = (selectedElement?.innerText || selectedElement?.textContent || '')
            .replace(/^UK\s*/i, '').trim().toLowerCase();
        if (selectedElement && (!normalizedPreferred || selectedText === normalizedPreferred)) return false;

        const selectable = candidates.filter(element => visible(element) && !isUnavailable(element));
        const preferred = normalizedPreferred
            ? selectable.find((element) => {
                const text = (element.innerText || element.textContent || '').replace(/^UK\s*/i, '').trim().toLowerCase();
                return text === normalizedPreferred;
            })
            : null;
        const available = preferred || selectable[0];
        if (!available) return false;
        available.scrollIntoView({ block: 'center', inline: 'center' });
        available.click();
        return true;
    }, requestedSize).catch(() => false);

    if (selected) {
        logger.info('Selected the first available product size before adding to cart');
        await page.waitForTimeout(1000);
    }
    return selected;
}

/**
 * Finds the most likely live add control when the DOM extractor did not expose one.
 * This is intentionally text/semantics based instead of website-class based.
 */
async function findLiveAddToCartControl(page) {
    const token = `direct-cart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await page.evaluate((marker) => {
        const addPattern = /^(?:(?:\+\s*)?add(?:\s*\+)?|add item|add to (?:cart|bag|basket))$/i;
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                style.opacity !== '0' && style.pointerEvents !== 'none';
        };

        const candidates = Array.from(document.querySelectorAll([
            '#add-to-cart-button',
            'input[name="submit.add-to-cart"]',
            '[data-testid*="add-to-cart" i]',
            '[data-testid*="add-btn" i]',
            'button',
            '[role="button"]',
            'div',
            'span',
        ].join(', '))).filter((element) => {
            if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
            const text = normalize(
                element.innerText || element.value || element.textContent || element.getAttribute('aria-label'),
            );
            return addPattern.test(text);
        });

        if (candidates.length === 0) return false;

        const scored = candidates.map((element) => {
            const text = normalize(element.innerText || element.value || element.textContent || element.getAttribute('aria-label'));
            const rect = element.getBoundingClientRect();
            let score = 0;
            if (element.id === 'add-to-cart-button' || element.name === 'submit.add-to-cart') score += 1000;
            if (/^add to (?:cart|bag|basket)$/i.test(text)) score += 500;
            if (element.tagName === 'BUTTON' || element.tagName === 'INPUT' || element.getAttribute('role') === 'button') score += 150;
            score += Math.min(rect.width, 500) / 10;
            score += Math.min(rect.height, 100) / 10;
            return { element, score };
        }).sort((a, b) => b.score - a.score);

        scored[0].element.setAttribute('data-agent-direct-cart', marker);
        return true;
    }, token).catch(() => false);

    if (!found) return null;
    return await page.$(`[data-agent-direct-cart="${token}"]`).catch(() => null);
}

/**
 * Reacquires only the selected product's ADD control for a bounded retry. The
 * original screen position and marked ancestors prevent clicking another card.
 */
async function findSelectedAddControl(page, targetScope) {
    if (!targetScope?.found || !targetScope.rect) return null;
    const marker = `cart-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const found = await page.evaluate(({ token, anchorRect, retryMarker }) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const addPattern = /^(?:(?:\+\s*)?add(?:\s*\+)?|add item|add to (?:cart|bag|basket))$/i;
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                style.opacity !== '0' && style.pointerEvents !== 'none';
        };
        const distance = (element) => {
            const rect = element.getBoundingClientRect();
            return Math.abs((rect.left + rect.width / 2) - anchorRect.centerX) +
                Math.abs((rect.top + rect.height / 2) - anchorRect.centerY);
        };
        const nearAnchor = (element) => {
            if (!visible(element)) return false;
            const rect = element.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            return centerX >= anchorRect.left - 120 && centerX <= anchorRect.right + 120 &&
                centerY >= anchorRect.top - 80 && centerY <= anchorRect.bottom + 80;
        };
        const candidates = Array.from(document.querySelectorAll([
            `[data-agent-cart-control="${token}"]`,
            `[data-agent-cart-scope="${token}"] button`,
            `[data-agent-cart-scope="${token}"] [role="button"]`,
            `[data-agent-cart-scope="${token}"] div`,
            `[data-agent-cart-scope="${token}"] span`,
            'button',
            '[role="button"]',
            'div',
            'span',
        ].join(', '))).filter((element) => {
            if (!nearAnchor(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
            return addPattern.test(normalize(
                element.innerText || element.value || element.textContent || element.getAttribute('aria-label'),
            ));
        }).sort((a, b) => distance(a) - distance(b));

        if (candidates.length === 0) return false;
        candidates[0].setAttribute('data-agent-cart-retry', retryMarker);
        candidates[0].setAttribute('data-agent-cart-control', token);
        return true;
    }, {
        token: targetScope.token,
        anchorRect: targetScope.rect,
        retryMarker: marker,
    }).catch(() => false);

    if (!found) return null;
    return await page.$(`[data-agent-cart-retry="${marker}"]`).catch(() => null);
}

/**
 * Universal Add to Cart executor for native buttons and React div/span controls.
 * It retries only the selected control up to three times and stops immediately
 * when a verified cart or selected-control transition appears.
 */
async function performAddToCart(page, elementId = null, matchedElement = null, options = {}) {
    if (!page || page.isClosed()) {
        return { success: false, clicked: false, error: 'Browser page is not initialized' };
    }

    await selectRequiredSizeIfPresent(page, options.requestedSize || null);
    const beforeCart = await inspectCartState(page);
    let effectiveElementId = elementId;
    let target = effectiveElementId !== null && effectiveElementId !== undefined
        ? await page.$(`[data-agent-id="${effectiveElementId}"]`)
        : null;

    // If React replaced the node between extraction and execution, recover by exact visible text.
    if (!target && (matchedElement?.actionText || matchedElement?.text)) {
        const exactText = (matchedElement.actionText || matchedElement.text).trim();
        target = await page.getByText(exactText, { exact: true })
            .first()
            .elementHandle()
            .catch(() => null);
    }

    // Product-page fast path: scan semantic/text controls when no extracted ID exists.
    if (!target) {
        target = await findLiveAddToCartControl(page);
    }

    if (!target) {
        return { success: false, clicked: false, error: 'No visible Add to Cart/Add to Bag/ADD control was found on the product page' };
    }

    if (effectiveElementId === null || effectiveElementId === undefined) {
        effectiveElementId = `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    await target.evaluate((element, id) => element.setAttribute('data-agent-id', id), effectiveElementId).catch(() => {});

    const targetScope = await captureCartTargetScope(page, effectiveElementId);
    const maxAddAttempts = Math.min(Math.max(Math.floor(Number(options.maxAddAttempts) || 3), 1), 3);
    let currentTarget = target;
    let clicked = false;
    let clickAttempts = 0;
    let afterCart = beforeCart;
    let scopeState = { advanced: false, hasQuantity: false };
    let verified = false;
    let transitionEvidence = '';
    let lastClickError = null;

    while (clickAttempts < maxAddAttempts && !verified) {
        if (!currentTarget) {
            currentTarget = await findSelectedAddControl(page, targetScope);
        }
        if (!currentTarget) {
            // A stable disappearance after a dispatched click is itself a
            // selected-product transition (Flipkart commonly removes ADD).
            if (clicked) {
                await page.waitForTimeout(500);
                scopeState = await inspectCartTargetScope(page, targetScope);
                afterCart = await inspectCartState(page);
                if (scopeState.addControlDisappeared && !scopeState.selectedAddPresent) {
                    verified = true;
                    transitionEvidence = 'selected ADD control disappeared after cart update';
                }
            }
            break;
        }

        clickAttempts += 1;
        await currentTarget.evaluate((element, id) => element.setAttribute('data-agent-id', id), effectiveElementId).catch(() => {});
        await showVisualCursor(page, effectiveElementId, 'click');
        await currentTarget.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(200);

        let dispatched = false;
        try {
            await currentTarget.click({ timeout: 3000, noWaitAfter: true });
            dispatched = true;
        } catch (standardClickError) {
            lastClickError = standardClickError;
            logger.warn(`Cart click attempt ${clickAttempts} failed normally; trying force-click once: ${standardClickError.message}`);
            try {
                await currentTarget.click({ force: true, timeout: 2500, noWaitAfter: true });
                dispatched = true;
            } catch (forceClickError) {
                lastClickError = forceClickError;
            }
        }
        clicked = clicked || dispatched;

        if (dispatched && clickAttempts > 1) {
            logger.info(`Retried the selected Add control (${clickAttempts}/${maxAddAttempts})`);
        }

        // Wait for React/network state, checking global signals and the selected
        // product after each bounded click attempt.
        if (dispatched) {
            for (let check = 0; check < 3; check++) {
                await page.waitForTimeout(700);
                afterCart = await inspectCartState(page);
                scopeState = await inspectCartTargetScope(page, targetScope);
                if (didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced) break;
            }

            if (!didCartStateAdvance(beforeCart, afterCart) && !scopeState.advanced) {
                const confirmedCustomization = await confirmCartCustomizationIfPresent(page);
                if (confirmedCustomization) {
                    for (let check = 0; check < 2; check++) {
                        await page.waitForTimeout(700);
                        afterCart = await inspectCartState(page);
                        scopeState = await inspectCartTargetScope(page, targetScope);
                        if (didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced) break;
                    }
                }
            }

            verified = didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced;
            if (scopeState.postAddState) {
                transitionEvidence = scopeState.transitionEvidence || 'selected control changed to a cart state';
            }

            // Confirm disappearance twice so a short loading animation is not
            // mistaken for success. This catches Flipkart's ADD removal even
            // when its header exposes no numeric cart badge.
            if (!verified && scopeState.addControlDisappeared && !scopeState.selectedAddPresent) {
                await page.waitForTimeout(500);
                const confirmedScopeState = await inspectCartTargetScope(page, targetScope);
                afterCart = await inspectCartState(page);
                if (confirmedScopeState.addControlDisappeared && !confirmedScopeState.selectedAddPresent) {
                    scopeState = confirmedScopeState;
                    verified = true;
                    transitionEvidence = 'selected ADD control disappeared after cart update';
                }
            }
        }

        if (verified) break;
        currentTarget = await findSelectedAddControl(page, targetScope);
        if (currentTarget && clickAttempts < maxAddAttempts) {
            logger.warn(`No cart transition detected after attempt ${clickAttempts}; retrying the same selected Add control`);
        }
    }

    if (!verified) {
        const clickDetail = lastClickError && !clicked
            ? ` Last click error: ${lastClickError.message}`
            : '';
        return {
            success: false,
            clicked,
            clickAttempts,
            cartVerified: false,
            cartRetryExhausted: clickAttempts >= maxAddAttempts,
            cartState: afterCart,
            error: `Add to cart was not verified after ${clickAttempts}/${maxAddAttempts} attempts.${clickDetail}`,
        };
    }

    const requestedQuantity = Math.min(Math.max(Number(options.requestedQuantity) || 1, 1), 20);
    let finalQuantity = scopeState.quantity || 1;
    if (requestedQuantity > 1) {
        logger.info(`Increasing selected product quantity to ${requestedQuantity}...`);
        const quantityResult = await ensureCartQuantity(
            page,
            targetScope,
            requestedQuantity,
            scopeState,
            afterCart,
            matchedElement?.context || matchedElement?.text || targetScope?.scopeText || '',
        );
        if (!quantityResult.success) {
            return {
                success: false,
                clicked,
                cartVerified: true,
                quantityVerified: false,
                quantity: quantityResult.quantity,
                cartState: quantityResult.cartState,
                error: quantityResult.error,
            };
        }
        finalQuantity = quantityResult.quantity;
        scopeState = quantityResult.scopeState;
        afterCart = quantityResult.cartState;
        logger.success(`Quantity verified at ${finalQuantity}`);
    }

    const evidence = afterCart.evidence?.join('; ') || transitionEvidence ||
        (scopeState.hasQuantity ? 'selected ADD control changed into quantity controls' : 'selected product state changed');

    return {
        success: true,
        clicked,
        clickAttempts,
        cartVerified: true,
        quantityVerified: finalQuantity === requestedQuantity,
        quantity: finalQuantity,
        requestedQuantity,
        cartState: afterCart,
        message: requestedQuantity > 1
            ? `Added quantity ${finalQuantity} to cart and verified (${evidence})`
            : `Item added to cart and verified (${evidence})`,
    };
}

/**
 * Clicks an interactive element identified by its data-agent-id with robust new-tab & link handling.
 */
async function clickElement(elementId, elementDesc = '', elementsList = [], options = {}) {
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
        const cartResult = await performAddToCart(page, elementId, matchedEl, {
            requestedQuantity: options.requestedQuantity,
            requestedSize: options.requestedSize,
        });
        if (!cartResult.success) {
            const error = new Error(cartResult.error || 'Add to cart could not be verified');
            error.cartResult = cartResult;
            throw error;
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
                const clickResult = await clickElement(action.element_id, elementDesc, elementsList, {
                    requestedQuantity: action.quantity,
                    requestedSize: action.size,
                });
                return {
                    success: true,
                    action: action.action,
                    message: clickResult?.message || `Clicked ${elementDesc}`,
                    cartVerified: clickResult?.cartVerified || false,
                    clickAttempts: clickResult?.clickAttempts,
                    quantityVerified: clickResult?.quantityVerified,
                    quantity: clickResult?.quantity,
                    cartState: clickResult?.cartState,
                };
            }

            case ACTION_TYPES.ADD_TO_CART: {
                const page = getPage();
                const matchedElement = action.element_id !== undefined
                    ? elementsList.find(element => element.id === action.element_id)
                    : null;
                const cartResult = await performAddToCart(
                    page,
                    action.element_id ?? null,
                    matchedElement,
                    {
                        requestedSize: action.size || null,
                        requestedQuantity: action.quantity,
                    },
                );
                if (!cartResult.success) {
                    const error = new Error(cartResult.error || 'Add to cart could not be verified');
                    error.cartResult = cartResult;
                    throw error;
                }
                logger.success(cartResult.message);
                return {
                    success: true,
                    action: action.action,
                    message: cartResult.message,
                    cartVerified: true,
                    clickAttempts: cartResult.clickAttempts,
                    quantityVerified: cartResult.quantityVerified,
                    quantity: cartResult.quantity,
                    cartState: cartResult.cartState,
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
            cartVerified: err.cartResult?.cartVerified || false,
            cartRetryExhausted: err.cartResult?.cartRetryExhausted || false,
            clickAttempts: err.cartResult?.clickAttempts,
            quantityVerified: err.cartResult?.quantityVerified,
            quantity: err.cartResult?.quantity,
            cartState: err.cartResult?.cartState,
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

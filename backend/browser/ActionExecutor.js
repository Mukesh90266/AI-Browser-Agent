// ActionExecutor.js — Generic browser action execution with Live Visual Cursor, element inspection, and multi-tab link navigation

const { getPage, navigateTo, goBack } = require('./BrowserManager');
const { closePopupIfExists } = require('./PopupHandler');
const { ACTION_TYPES, DEFAULT_CONFIG } = require('../utils/constants');
const { inspectCartState, didCartStateAdvance, verifyCartAddition } = require('./CartInspector');
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
            // Blinkit sometimes renders SVG +/- icons as odd text around the
            // numeric value (for example "U 1 5" instead of "- 1 +"), so also
            // accept compact counter-shaped containers with exactly one small
            // number and multiple visible children.
            for (const element of nodes) {
                if (!nearAnchor(element) || element.children.length > 8) continue;
                const text = numericText(element);
                const match = text.match(/^[−–—-]\s*(\d{1,2})\s*(?:\+|＋)$/);
                if (match) return { quantity: Number(match[1]), container: element };

                const numbers = text.match(/\b\d{1,2}\b/g) || [];
                const visibleChildren = Array.from(element.children || []).filter(visible);
                const counterLikeText = /[−–—+＋]|\b(?:qty|quantity)\b/i.test(text);
                if (text.length <= 40 && numbers.length === 1 && (counterLikeText || visibleChildren.length >= 3)) {
                    const value = Number(numbers[0]);
                    if (value >= 1 && value <= 20) {
                        return { quantity: value, container: element };
                    }
                }
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

            // Fallback for icon-only Blinkit counters where the number is not a
            // clean standalone node and the parent text can look like "U 1 5".
            // Pick the right-side visible child in a compact counter container.
            const counterContainers = Array.from(root.querySelectorAll('div, span')).filter((element) => {
                if (!nearAnchor(element) || !visible(element) || element.children.length > 8) return false;
                const text = numericText(element);
                const numbers = text.match(/\b\d{1,2}\b/g) || [];
                if (text.length > 40 || numbers.length !== 1) return false;
                const visibleChildren = Array.from(element.children || []).filter(visible);
                return visibleChildren.length >= 3;
            }).sort((a, b) => candidateDistance(a) - candidateDistance(b));

            for (const container of counterContainers) {
                const children = Array.from(container.children || []).filter(visible)
                    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                const numberChild = children.find((child) => /^\d{1,2}$/.test(numericText(child)));
                const rightCandidates = numberChild
                    ? children.filter((child) => child.getBoundingClientRect().left > numberChild.getBoundingClientRect().left)
                    : children.slice(Math.ceil(children.length / 2));
                const increment = rightCandidates[rightCandidates.length - 1] || children[children.length - 1];
                if (increment && increment !== numberChild) {
                    return { container, increment: clickableTarget(increment, container) };
                }
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
        for (let attempt = 0; attempt < 8; attempt++) {
            await page.waitForTimeout(650);
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



function buildCartPageUrlForQuantity(currentUrl) {
    try {
        const parsed = new URL(currentUrl || '');
        const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
        const origin = parsed.origin;
        if (/flipkart\./i.test(host)) return `${origin}/viewcart`;
        if (/amazon\./i.test(host)) return `${origin}/gp/cart/view.html`;
        if (/myntra\./i.test(host)) return `${origin}/checkout/cart`;
        if (/ajio\./i.test(host)) return `${origin}/cart`;
        if (/meesho\./i.test(host)) return `${origin}/cart`;
        if (/zepto\./i.test(host)) return `${origin}/cart`;
        if (/blinkit\./i.test(host)) return `${origin}/cart`;
        return `${origin}/cart`;
    } catch (_) {
        return null;
    }
}

function isCartPageUrlForQuantity(currentUrl) {
    return /(?:\/viewcart\b|\/gp\/cart\/view\.html\b|\/checkout\/cart\b|\/cart\b|\/bag\b|\/basket\b)/i.test(currentUrl || '');
}


async function waitForCartPageContent(page, timeoutMs = 10000) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
        const ready = await page.evaluate(() => {
            const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            const hasCartLine = /\b(?:qty|quantity|remove|save for later|place order|subtotal|seller|delivery|shopping cart|my cart)\b/i.test(text);
            const empty = /(?:cart|bag|basket)\s+is\s+empty|no items? in (?:your\s+)?(?:cart|bag|basket)/i.test(text);
            const hasInteractiveQty = !!document.querySelector('select, input[type="number"], input[inputmode="numeric"], [aria-label*="qty" i], [aria-label*="quantity" i]');
            return { ready: hasCartLine || empty || hasInteractiveQty, text: text.slice(0, 300) };
        }).catch(() => ({ ready: false, text: '' }));
        if (ready.ready) return ready;
        await page.waitForTimeout(600).catch(() => {});
    }
    return await page.evaluate(() => ({
        ready: false,
        text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    })).catch(() => ({ ready: false, text: '' }));
}

async function openCartPageForQuantity(page) {
    if (!page || page.isClosed()) return { success: false, error: 'Browser page is not initialized' };
    page = activePageRef(page);
    const beforeUrl = typeof page.url === 'function' ? page.url() : '';
    if (isCartPageUrlForQuantity(beforeUrl)) {
        await waitForCartPageContent(page, 8000);
        return { success: true, url: beforeUrl, method: 'already on cart page' };
    }

    // Give the site a moment after the ADD toast. Some stores show the toast
    // before their cart state has fully committed; navigating instantly can load
    // a footer-only/empty cart shell.
    await page.waitForTimeout(1800).catch(() => {});

    const clickSelectors = [
        'a:has-text("GO TO CART")',
        'button:has-text("GO TO CART")',
        '[role="button"]:has-text("GO TO CART")',
        'a:has-text("Go to Cart")',
        'button:has-text("Go to Cart")',
        '[role="button"]:has-text("Go to Cart")',
        'a[href*="viewcart" i]',
        'a[href*="/cart" i]',
        'button[aria-label*="cart" i]',
        'a[aria-label*="cart" i]',
    ];

    if (typeof page.locator === 'function') for (const selector of clickSelectors) {
        const loc = page.locator(selector).first();
        const visible = await loc.isVisible({ timeout: 500 }).catch(() => false);
        if (!visible) continue;
        logger.info(`Opening cart page via visible cart control: ${selector}`);
        const navigation = page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => null);
        await loc.click({ timeout: 3000, noWaitAfter: true }).catch(async () => {
            await loc.click({ force: true, timeout: 2000, noWaitAfter: true }).catch(() => {});
        });
        await navigation;
        await page.waitForTimeout(1500).catch(() => {});
        page = activePageRef(page);
        const clickedUrl = typeof page.url === 'function' ? page.url() : '';
        if (isCartPageUrlForQuantity(clickedUrl)) {
            await waitForCartPageContent(page, 10000);
            return { success: true, url: clickedUrl, method: selector };
        }
    }

    const cartUrl = buildCartPageUrlForQuantity(beforeUrl);
    if (!cartUrl) return { success: false, error: 'Could not build cart page URL' };
    logger.info(`Opening cart page to update quantity: ${cartUrl}`);
    await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    await page.waitForLoadState?.('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500).catch(() => {});
    let content = await waitForCartPageContent(page, 10000);
    if (!content.ready && !/\b(?:qty|quantity|remove|save for later|place order|subtotal)\b/i.test(content.text || '')) {
        // One reload helps Flipkart/noVNC sessions where /viewcart initially
        // paints only the common footer after a very recent ADD request.
        logger.warn('Cart page content was not ready after navigation; reloading once before quantity scan');
        if (typeof page.reload === 'function') {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
        }
        await page.waitForTimeout(2500).catch(() => {});
        content = await waitForCartPageContent(page, 8000);
    }
    return { success: true, url: typeof page.url === 'function' ? page.url() : cartUrl, method: 'direct cart url', contentReady: content.ready };
}

async function ensureCartPageQuantity(page, requestedQuantity) {
    if (!page || page.isClosed()) {
        return { success: false, quantity: 0, error: 'Browser page is not initialized' };
    }

    const desired = Math.min(Math.max(Number(requestedQuantity) || 1, 1), 20);
    if (desired <= 1) return { success: true, quantity: 1, message: 'Quantity 1 requested' };

    const findControl = async () => {
        const marker = `cart-page-qty-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const result = await page.evaluate((mk) => {
            const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
            const visible = (element) => {
                if (!element) return false;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.opacity !== '0';
            };
            const readNumber = (value) => {
                const match = normalize(value).match(/\b([1-9]|1[0-9]|20)\b/);
                return match ? Number(match[1]) : 0;
            };
            const distanceToCartContent = (element) => {
                const rect = element.getBoundingClientRect();
                const text = normalize(element.closest('li, article, [data-itemid], [class*="item" i], [class*="cart" i], div')?.innerText || '');
                let score = rect.top;
                if (/save for later|remove|delivery|subtotal|price|qty|quantity/i.test(text)) score -= 500;
                return score;
            };

            const selects = Array.from(document.querySelectorAll('select')).filter((select) => {
                if (!visible(select) || select.disabled) return false;
                const options = Array.from(select.options || []).map(option => normalize(option.text || option.value));
                return options.some(option => /^(?:qty\s*)?([1-9]|1[0-9]|20)$|quantity/i.test(option));
            }).sort((a, b) => distanceToCartContent(a) - distanceToCartContent(b));
            if (selects.length) {
                const select = selects[0];
                select.setAttribute('data-agent-cart-page-qty', mk);
                const current = readNumber(select.options?.[select.selectedIndex]?.text || select.value) || 1;
                return { found: true, type: 'select', current };
            }

            const numericInputs = Array.from(document.querySelectorAll('input[type="number"], input[inputmode="numeric"], input[aria-label*="qty" i], input[aria-label*="quantity" i]')).filter((input) => {
                if (!visible(input) || input.disabled || input.readOnly) return false;
                const meta = normalize([
                    input.getAttribute('aria-label'),
                    input.getAttribute('placeholder'),
                    input.getAttribute('name'),
                    input.getAttribute('id'),
                    input.closest('li, article, [data-itemid], [class*="item" i], [class*="cart" i], div')?.innerText,
                ].filter(Boolean).join(' '));
                return /qty|quantity|cart|item|save for later|remove/i.test(meta);
            }).sort((a, b) => distanceToCartContent(a) - distanceToCartContent(b));
            if (numericInputs.length) {
                const input = numericInputs[0];
                input.setAttribute('data-agent-cart-page-qty', mk);
                return { found: true, type: 'input', current: readNumber(input.value) || 1 };
            }

            // Flipkart and several marketplaces render quantity as a custom
            // dropdown like "Qty: 1" instead of a native select or + button.
            const dropdowns = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], div, span, a')).filter((element) => {
                if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
                const text = normalize(element.innerText || element.textContent || element.value);
                const meta = normalize([
                    element.getAttribute('aria-label'),
                    element.getAttribute('title'),
                    element.getAttribute('data-testid'),
                    typeof element.className === 'string' ? element.className : '',
                ].filter(Boolean).join(' '));
                const ownText = text.length <= 40 ? text : '';
                const looksLikeQty = /\b(?:qty|quantity)\b\s*:?\s*([1-9]|1[0-9]|20)\b/i.test(`${ownText} ${meta}`) ||
                    (/^([1-9]|1[0-9]|20)$/.test(ownText) && /qty|quantity/i.test(meta));
                if (!looksLikeQty) return false;
                const containerText = normalize(element.closest('li, article, [data-itemid], [class*="item" i], [class*="cart" i], div')?.innerText || '');
                return /cart|save for later|remove|delivery|seller|price|subtotal|qty|quantity/i.test(containerText + ' ' + meta);
            }).sort((a, b) => distanceToCartContent(a) - distanceToCartContent(b));
            if (dropdowns.length) {
                const dropdown = dropdowns[0];
                dropdown.setAttribute('data-agent-cart-page-qty', mk);
                const current = readNumber(dropdown.innerText || dropdown.textContent || dropdown.getAttribute('aria-label')) || 1;
                return { found: true, type: 'dropdown', current };
            }

            const candidates = Array.from(document.querySelectorAll([
                'button[aria-label*="increase" i]',
                'button[aria-label*="increment" i]',
                'button[aria-label*="add one" i]',
                '[role="button"][aria-label*="increase" i]',
                '[role="button"][aria-label*="increment" i]',
                '[data-testid*="increment" i]',
                '[data-testid*="increase" i]',
                '[class*="increment" i]',
                '[class*="plus" i]',
                'button',
                '[role="button"]',
                'div',
                'span',
            ].join(', '))).filter((element) => {
                if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
                const text = normalize(element.innerText || element.textContent || element.value);
                const meta = normalize([
                    element.getAttribute('aria-label'),
                    element.getAttribute('title'),
                    element.getAttribute('data-testid'),
                    typeof element.className === 'string' ? element.className : '',
                ].filter(Boolean).join(' '));
                return /increase|increment|add one|plus/i.test(meta) || /^(?:\+|＋)$/.test(text);
            }).sort((a, b) => distanceToCartContent(a) - distanceToCartContent(b));

            if (candidates.length) {
                const plus = candidates[0];
                plus.setAttribute('data-agent-cart-page-qty', mk);
                const container = plus.closest('li, article, [data-itemid], [class*="item" i], [class*="cart" i], div') || plus.parentElement;
                const current = readNumber(container?.innerText || '') || 1;
                return { found: true, type: 'plus', current };
            }

            const textCounters = Array.from(document.querySelectorAll('div, span, p')).filter((element) => {
                if (!visible(element) || element.children.length > 8) return false;
                return /(?:^|\s)[−–—-]\s*\d{1,2}\s*(?:\+|＋)(?:\s|$)/.test(normalize(element.innerText || element.textContent));
            }).sort((a, b) => distanceToCartContent(a) - distanceToCartContent(b));
            if (textCounters.length) {
                const counter = textCounters[0];
                const plusChild = Array.from(counter.querySelectorAll('button, [role="button"], div, span')).find((child) => {
                    if (!visible(child)) return false;
                    return /^(?:\+|＋)$/.test(normalize(child.innerText || child.textContent));
                });
                const control = plusChild || counter;
                control.setAttribute('data-agent-cart-page-qty', mk);
                return { found: true, type: 'plus', current: readNumber(counter.innerText || counter.textContent) || 1 };
            }

            return { found: false };
        }, marker).catch((err) => ({ found: false, error: err.message }));
        return { ...result, marker };
    };

    await page.waitForLoadState?.('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500).catch(() => {});

    let control = await findControl();
    if (!control.found) {
        // Cart pages often lazy-render the line item below the fold. Scroll in
        // small deterministic steps and re-scan before deciding no quantity
        // control exists.
        for (const scrollY of [0, 450, 900, 1400]) {
            await page.evaluate((y) => window.scrollTo(0, y), scrollY).catch(() => {});
            await page.waitForTimeout(900).catch(() => {});
            control = await findControl();
            if (control.found) break;
        }
    }
    if (!control.found) {
        const debugText = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => '');
        return {
            success: false,
            quantity: 0,
            error: `No cart-page quantity control was found${debugText ? ` (page text: ${debugText})` : ''}`,
        };
    }

    const handle = await page.$(`[data-agent-cart-page-qty="${control.marker}"]`).catch(() => null);
    if (!handle) {
        return { success: false, quantity: control.current || 0, error: 'Cart-page quantity control disappeared' };
    }

    const verifyCartPageQuantityValue = async () => await page.evaluate((desiredValue) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const desiredText = String(desiredValue);
        const qtyPattern = new RegExp(`(?:^|\\b)(?:qty|quantity)\\s*:?\\s*${desiredText}(?:\\b|$)|(?:^|\\b)${desiredText}\\s*(?:qty|quantity|items?)(?:\\b|$)`, 'i');
        const controls = Array.from(document.querySelectorAll('select, input, button, [role="button"], [aria-haspopup], div, span, p')).filter(visible);
        return controls.some((element) => {
            if (element.tagName === 'SELECT') {
                const selected = element.options?.[element.selectedIndex];
                const text = normalize(`${element.value || ''} ${selected?.text || ''}`);
                return new RegExp(`(?:^|\\D)${desiredText}(?:\\D|$)`).test(text);
            }
            if (element.tagName === 'INPUT') {
                const meta = normalize(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('placeholder') || ''}`);
                return /qty|quantity/i.test(meta) && normalize(element.value) === desiredText;
            }
            const text = normalize(element.innerText || element.textContent || element.getAttribute('aria-label'));
            if (!text || text.length > 80) return false;
            if (qtyPattern.test(text)) return true;
            const meta = normalize(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${typeof element.className === 'string' ? element.className : ''}`);
            return /^\d{1,2}$/.test(text) && text === desiredText && /qty|quantity/i.test(meta);
        });
    }, desired).catch(() => false);

    if (control.type === 'select') {
        const desiredText = String(desired);
        let selected = false;
        await handle.selectOption({ value: desiredText }, { timeout: 2500 }).then(() => { selected = true; }).catch(() => {});
        if (!selected) await handle.selectOption({ label: desiredText }, { timeout: 2500 }).then(() => { selected = true; }).catch(() => {});
        if (!selected) {
            await handle.evaluate((select, value) => {
                const option = Array.from(select.options || []).find((opt) =>
                    (opt.value || '').trim() === value || (opt.text || '').trim().match(new RegExp(`(?:^|\\D)${value}(?:\\D|$)`))
                );
                if (option) {
                    select.value = option.value;
                    select.dispatchEvent(new Event('input', { bubbles: true }));
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, desiredText).catch(() => {});
        }
        await page.waitForTimeout(1500).catch(() => {});
        logger.success(`Cart page quantity set to ${desired}`);
        return { success: true, quantity: desired, message: `Cart page quantity set to ${desired}` };
    }

    if (control.type === 'input') {
        await handle.fill(String(desired), { timeout: 2500 }).catch(async () => {
            await handle.evaluate((input, value) => {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }, String(desired)).catch(() => {});
        });
        await page.keyboard?.press('Enter').catch(() => {});
        await page.waitForTimeout(1500).catch(() => {});
        logger.success(`Cart page quantity input set to ${desired}`);
        return { success: true, quantity: desired, message: `Cart page quantity input set to ${desired}` };
    }

    if (control.type === 'dropdown') {
        await handle.scrollIntoViewIfNeeded?.().catch(() => {});
        await handle.click({ timeout: 2500, noWaitAfter: true }).catch(async () => {
            await handle.click({ force: true, timeout: 2000, noWaitAfter: true }).catch(() => {});
        });
        await page.waitForTimeout(900).catch(() => {});

        const optionMarker = `cart-page-qty-option-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const optionSearch = await page.evaluate(({ marker, desiredValue, currentValue }) => {
            const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
            const visible = (element) => {
                if (!element) return false;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            };
            const desiredText = String(desiredValue);
            const isPriceLike = (text) => /[₹$€£]|\b(?:rs\.?|inr)\b/i.test(text);
            const matchesDesired = (text) => {
                const normalized = normalize(text);
                if (!normalized || normalized.length > 120 || isPriceLike(normalized)) return false;
                const escaped = desiredText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const patterns = [
                    new RegExp(`^${escaped}$`, 'i'),
                    new RegExp(`^(?:Qty|Quantity)\\s*:?\\s*${escaped}$`, 'i'),
                    new RegExp(`^${escaped}\\s*(?:Qty|Quantity|items?)$`, 'i'),
                    new RegExp(`(?:^|\\n|\\s)(?:Qty|Quantity)\\s*:?\\s*${escaped}(?:\\s|\\n|$)`, 'i'),
                    new RegExp(`(?:^|\\n|\\s)${escaped}(?:\\s|\\n|$)`, 'i'),
                ];
                return patterns.some((pattern) => pattern.test(normalized));
            };
            const scoreOption = (element) => {
                const rect = element.getBoundingClientRect();
                const text = normalize(element.innerText || element.textContent || element.value || element.getAttribute('aria-label'));
                let score = 0;
                if (element.matches('li, [role="option"], [role="menuitem"]')) score += 500;
                if (element.matches('button, [role="button"], a')) score += 250;
                if (/^(?:Qty|Quantity)\s*:?/i.test(text)) score += 120;
                if (text === desiredText) score += 180;
                if (text.length <= 12) score += 120;
                if (text.includes(String(currentValue)) && String(currentValue) !== desiredText) score -= 80;
                // Prefer dropdown overlays/options visible near the viewport top;
                // do not reject below-fold overlays because Flipkart sometimes
                // renders quantity menus offset from the clicked control.
                score -= Math.max(0, rect.top) / 100;
                score -= Math.max(0, text.length - 20);
                return score;
            };
            const optionSelectors = 'li, [role="option"], [role="menuitem"], button, [role="button"], div, span, a';
            const visibleOptions = Array.from(document.querySelectorAll(optionSelectors)).filter((element) => {
                if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
                const text = normalize(element.innerText || element.textContent || element.value || element.getAttribute('aria-label'));
                if (!text || text.length > 120 || isPriceLike(text)) return false;
                // Keep a short debug sample of quantity-looking choices.
                return /qty|quantity|^\d{1,2}$|\b\d{1,2}\b/i.test(text);
            });
            const options = visibleOptions
                .filter((element) => matchesDesired(element.innerText || element.textContent || element.value || element.getAttribute('aria-label')))
                .map((element) => ({ element, score: scoreOption(element) }))
                .sort((a, b) => b.score - a.score ||
                    (a.element.getBoundingClientRect().height * a.element.getBoundingClientRect().width) -
                    (b.element.getBoundingClientRect().height * b.element.getBoundingClientRect().width));
            const option = options[0]?.element;
            const optionTexts = visibleOptions
                .map((element) => normalize(element.innerText || element.textContent || element.value || element.getAttribute('aria-label')))
                .filter(Boolean)
                .slice(0, 12);
            if (!option) return { found: false, optionTexts };
            option.setAttribute('data-agent-cart-page-qty-option', marker);
            return { found: true, optionTexts };
        }, { marker: optionMarker, desiredValue: desired, currentValue: control.current || 1 }).catch((err) => ({ found: false, optionTexts: [], error: err.message }));

        if (optionSearch.found) {
            const optionHandle = await page.$(`[data-agent-cart-page-qty-option="${optionMarker}"]`).catch(() => null);
            if (optionHandle) {
                await optionHandle.click({ timeout: 2500, noWaitAfter: true }).catch(async () => {
                    await optionHandle.click({ force: true, timeout: 2000, noWaitAfter: true }).catch(() => {});
                });
                await page.waitForTimeout(1800).catch(() => {});
                logger.success(`Cart page quantity dropdown set to ${desired}`);
                return { success: true, quantity: desired, message: `Cart page quantity dropdown set to ${desired}` };
            }
        }

        // Keyboard fallback for custom dropdowns whose options are rendered in a
        // portal/shadow-like layer that our DOM scan cannot safely mark. When
        // current quantity is 1 and desired is 2, one ArrowDown + Enter mirrors a
        // normal user selection.
        const steps = Math.max(0, Math.min(10, desired - Math.max(control.current || 1, 1)));
        if (steps > 0 && page.keyboard) {
            for (let i = 0; i < steps; i += 1) {
                await page.keyboard.press('ArrowDown').catch(() => {});
                await page.waitForTimeout(120).catch(() => {});
            }
            await page.keyboard.press('Enter').catch(() => {});
            await page.waitForTimeout(1800).catch(() => {});
            if (await verifyCartPageQuantityValue()) {
                logger.success(`Cart page quantity dropdown set to ${desired} via keyboard`);
                return { success: true, quantity: desired, message: `Cart page quantity dropdown set to ${desired}` };
            }
        }

        const seen = Array.isArray(optionSearch.optionTexts) && optionSearch.optionTexts.length
            ? ` Visible quantity options/text: ${optionSearch.optionTexts.join(' | ').slice(0, 240)}`
            : '';
        return { success: false, quantity: control.current || 1, error: `Cart quantity dropdown opened but option ${desired} was not found.${seen}` };
    }

    let current = Math.max(control.current || 1, 1);
    let clicked = 0;
    while (current < desired && clicked < desired + 2) {
        await handle.click({ timeout: 2500, noWaitAfter: true }).catch(async () => {
            await handle.click({ force: true, timeout: 2000, noWaitAfter: true }).catch(() => {});
        });
        clicked += 1;
        await page.waitForTimeout(900).catch(() => {});
        current += 1;
    }

    if (current >= desired) {
        logger.success(`Cart page quantity increased to ${desired}`);
        return { success: true, quantity: desired, message: `Cart page quantity increased to ${desired}` };
    }

    return { success: false, quantity: current, error: `Could not increase cart page quantity to ${desired}` };
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
 * Selects an available size on the PRODUCT PAGE before adding to cart.
 * Generic across Flipkart/Myntra/Ajio etc.: finds any visible clickable element
 * whose text is a size token (numeric shoe sizes, XS..XXL, Free Size, UK 8,
 * 8 UK), located inside a size section, and clicks the user-requested size or
 * the first in-stock option. The size widget can mount a moment after the
 * price/title, so this polls for up to ~5 seconds before giving up.
 */
// URL patterns that indicate an actual product details page (where a size
// selector legitimately lives). Shared with DOMExtractor.isProductDetailsPage.
const PDP_URL_RE = /\/dp\/|\/p\/|\/products?(?:\/|$)|\/pn\/|\/prid\/|\/itm/i;

function isProductPage(page) {
    try {
        return !!page && !page.isClosed() && PDP_URL_RE.test(page.url() || '');
    } catch {
        return false;
    }
}

async function selectRequiredSizeIfPresent(page, requestedSize = null) {
    if (!page || page.isClosed()) return false;
    // Only scan for a size widget on an actual product details page. On search
    // listings / cart / homepages this used to misread review counts, prices and
    // filter numbers as size tokens (e.g. selecting size "0") and click random
    // controls, which navigated away from the listing.
    if (!isProductPage(page)) {
        logger.debug(`Page-level size selection skipped (not a product page): ${page.url()}`);
        return false;
    }

    const marker = `pdp-size-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let result = null;

    // Poll for size controls to appear (Flipkart mounts them after the price).
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (page.isClosed && page.isClosed()) return false;

        result = await page.evaluate(({ preferredSize, mk }) => {
            const visible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = window.getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            };
            const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
            // Size tokens after stripping UK/IND/US/EU/SIZE labels: 6, 7.5, 10, XS..4XL, Free.
            const sizeKeyValue = (raw) => (raw || '').toUpperCase()
                .replace(/\b(UK|IND|INDIA|US|EU|SIZE)\b/g, '')
                .replace(/SIZE/g, '')
                .replace(/[^A-Z0-9.]/g, '')
                .trim().toLowerCase();
            const isSizeToken = (raw) => {
                const v = sizeKeyValue(raw);
                // Reject 0 / 00 (review counts, zero prices) and out-of-range sizes.
                if (/^\d/.test(v) && !/^([3-9]|1[0-9])(\.[05])?$/.test(v)) return false;
                return /^(\d{1,2}(\.\d)?|xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl|free)$/i.test(v);
            };

            // Leaf-ish elements only (size labels are small nodes); this keeps
            // the scan fast even on a large PDP.
            const all = Array.from(document.querySelectorAll(
                'button, a, li, [role="button"], [role="option"], [tabindex], div, span',
            )).filter((el) => el.querySelectorAll('*').length <= 2);

            const inSizeContext = (el) => {
                if (el.closest && el.closest(
                    '[class*="size" i], [data-testid*="size" i], [id*="size" i], [aria-label*="size" i], [name*="size" i]',
                )) return true;
                let node = el;
                for (let depth = 0; node && depth < 8; depth++) {
                    const ctx = normalize(node.innerText || node.textContent || '').toLowerCase();
                    if (/select\s+size|choose\s+size|pick\s+size|size\s*chart|size\s*guide|\bsize\b|\buk\b|\bindia?\b|\beu\b|\bus\b/.test(ctx)) {
                        return true;
                    }
                    node = node.parentElement;
                }
                return false;
            };

            // Map a leaf size label up to its actual clickable control (the
            // <button>/<a>/[role=button] wrapping it), falling back to the node
            // itself for plain li/div/span React controls.
            const clickableOf = (el) => {
                let node = el;
                for (let depth = 0; node && depth < 3; depth++) {
                    const tag = node.tagName;
                    if (tag === 'BUTTON' || tag === 'A' ||
                        node.getAttribute('role') === 'button' ||
                        node.getAttribute('role') === 'option' ||
                        node.getAttribute('tabindex') === '0') {
                        return node;
                    }
                    node = node.parentElement;
                }
                return el;
            };
            const tagPath = (el) => {
                const parts = [];
                let n = el;
                for (let d = 0; n && d < 3; d++) { parts.unshift(n.tagName); n = n.parentElement; }
                return parts.join('>');
            };

            const seen = new Set();
            const controls = [];
            for (const el of all) {
                if (!visible(el)) continue;
                const text = normalize(el.innerText || el.textContent);
                if (text.length === 0 || text.length > 12) continue;
                if (!isSizeToken(text)) continue;
                if (!inSizeContext(el)) continue;
                const control = clickableOf(el);
                if (!visible(control)) continue;
                const r = control.getBoundingClientRect();
                const key = `${text}|${Math.round(r.left)}|${Math.round(r.top)}|${tagPath(control)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                controls.push({ control, text, key });
            }

            if (controls.length === 0) return { found: false, reason: 'no size controls' };

            const isUnavailable = (el) => {
                const ancestorMeta = [el, el.parentElement, el.parentElement?.parentElement]
                    .filter(Boolean)
                    .map((node) => `${node.className || ''} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('aria-disabled') || ''} ${node.getAttribute?.('data-testid') || ''}`)
                    .join(' ')
                    .toLowerCase();
                const ownText = normalize(el.innerText || el.textContent).toLowerCase();
                const s = window.getComputedStyle(el);
                return el.disabled || el.getAttribute('aria-disabled') === 'true' ||
                    s.pointerEvents === 'none' || s.textDecorationLine.includes('line-through') ||
                    Number(s.opacity) < 0.35 ||
                    /disabled|strike|unavailable|out.of.stock|notify\s*me|sold\s*out/.test(ancestorMeta) ||
                    /notify me|out of stock|sold out|unavailable/i.test(ownText);
            };
            const isSelected = (el) => {
                const m = `${el.className || ''} ${el.getAttribute('aria-pressed') || ''} ${el.getAttribute('aria-checked') || ''} ${el.getAttribute('aria-current') || ''}`.toLowerCase();
                return /\b(selected|active|checked|true)\b/.test(m);
            };

            const selectable = controls
                .map((c) => ({ ...c, unavailable: isUnavailable(c.control), selected: isSelected(c.control) }))
                .filter((c) => visible(c.control) && !c.unavailable);
            if (selectable.length === 0) return { found: false, reason: 'all sizes unavailable', total: controls.length };

            const pref = sizeKeyValue(preferredSize || '');
            const preferred = pref ? selectable.find((c) => sizeKeyValue(c.text) === pref) : null;
            // Always click a size (even if one appears pre-selected) so the
            // variant state is activated before ADD. Preference > first.
            const target = preferred || selectable[0];
            target.control.setAttribute('data-agent-pdp-size', mk);
            return {
                found: true,
                size: target.text,
                wasSelected: target.selected,
                totalOptions: controls.length,
            };
        }, {
            preferredSize: requestedSize == null ? '' : String(requestedSize),
            mk: marker,
        }).catch((err) => ({ found: false, error: err.message }));

        if (result?.found) break;
        if (result?.error) logger.debug(`Page-level size scan error: ${result.error}`);
        await page.waitForTimeout(500).catch(() => {});
    }

    if (!result?.found) {
        logger.info(`Page-level size selection: no size controls found after ${maxAttempts} tries (${result?.reason || 'none present'})`);
        return false;
    }

    const handle = await page.$(`[data-agent-pdp-size="${marker}"]`).catch(() => null);
    if (!handle) {
        logger.info(`Page-level size selection: target size "${result.size}" vanished before click`);
        return false;
    }

    try {
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        await handle.click({ timeout: 2500, noWaitAfter: true });
    } catch (err) {
        logger.warn(`Page-level size click failed normally, retrying force: ${err.message}`);
        try {
            await handle.click({ force: true, timeout: 2000, noWaitAfter: true });
        } catch (err2) {
            logger.warn(`Page-level size click failed: ${err2.message}`);
            return false;
        }
    }

    logger.info(`Selected product size "${result.size}" before adding to cart${result.wasSelected ? ' (re-confirmed)' : ''} (${result.totalOptions} size options found)`);
    await page.waitForTimeout(900).catch(() => {});
    return true;
}

/**
 * Finds the most likely live add control when the DOM extractor did not expose one.
 * This is intentionally text/semantics based instead of website-class based.
 */
async function selectSizeVariantLinkIfPresent(page, requestedSize = null) {
    if (!page || page.isClosed() || !isProductPage(page)) return false;

    const marker = `size-link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = await page.evaluate(({ preferredSize, mk }) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const sizeKeyValue = (raw) => (raw || '').toUpperCase()
            .replace(/\b(UK|IND|INDIA|US|EU|SIZE)\b/g, '')
            .replace(/SIZE/g, '')
            .replace(/[^A-Z0-9.]/g, '')
            .trim().toLowerCase();
        const isSizeToken = (raw) => {
            const key = sizeKeyValue(raw);
            if (/^\d/.test(key) && !/^([3-9]|1[0-9])(\.[05])?$/.test(key)) return false;
            return /^(\d{1,2}(\.\d)?|xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl|free)$/i.test(key);
        };
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const unavailable = (element) => {
            const style = window.getComputedStyle(element);
            const meta = [element, element.parentElement, element.parentElement?.parentElement]
                .filter(Boolean)
                .map((node) => `${node.className || ''} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('aria-disabled') || ''} ${node.getAttribute?.('data-testid') || ''}`)
                .join(' ')
                .toLowerCase();
            const ownText = normalize(element.innerText || element.textContent).toLowerCase();
            return element.disabled || element.getAttribute('aria-disabled') === 'true' ||
                style.pointerEvents === 'none' || Number(style.opacity) < 0.25 ||
                /disabled|unavailable|out.of.stock|sold\s*out|notify\s*me/.test(meta) ||
                /notify me|out of stock|sold out|unavailable/i.test(ownText);
        };
        const preferred = sizeKeyValue(preferredSize || '');
        const candidates = Array.from(document.querySelectorAll('a[href]')).filter((anchor) => {
            if (!visible(anchor) || unavailable(anchor)) return false;
            const text = normalize(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label'));
            const href = anchor.href || '';
            if (!isSizeToken(text)) return false;
            return /swatchAttr=size|[?&]size=|\/size\b|size/i.test(href) ||
                /select\s+size|choose\s+size|size\s*chart|\bsize\b/i.test(normalize(anchor.closest('div, section, ul')?.innerText || ''));
        }).map((anchor) => {
            const text = normalize(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label'));
            let score = 0;
            if (preferred && sizeKeyValue(text) === preferred) score += 1000;
            if (/swatchAttr=size/i.test(anchor.href || '')) score += 500;
            const rect = anchor.getBoundingClientRect();
            score += Math.max(0, 500 - rect.top) / 10;
            return { anchor, text, href: anchor.href, score };
        }).sort((a, b) => b.score - a.score);

        if (!candidates.length) return { found: false };
        candidates[0].anchor.setAttribute('data-agent-size-link', mk);
        return { found: true, size: candidates[0].text, href: candidates[0].href };
    }, {
        preferredSize: requestedSize == null ? '' : String(requestedSize),
        mk: marker,
    }).catch((err) => ({ found: false, error: err.message }));

    if (!result?.found) return false;
    const handle = await page.$(`[data-agent-size-link="${marker}"]`).catch(() => null);
    const beforeUrl = page.url();
    let clicked = false;
    if (handle) {
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        await handle.click({ timeout: 2500, noWaitAfter: true }).then(() => { clicked = true; }).catch(async () => {
            await handle.click({ force: true, timeout: 2000, noWaitAfter: true }).then(() => { clicked = true; }).catch(() => {});
        });
        await page.waitForTimeout(900).catch(() => {});
    }

    if (result.href && (!clicked || page.url() === beforeUrl)) {
        await page.goto(result.href, { waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS }).catch(() => {});
        await page.waitForTimeout(1200).catch(() => {});
    }

    logger.info(`Opened product size variant "${result.size}" before adding to cart`);
    return true;
}

async function selectAnyVisibleSizeOption(page, requestedSize = null, contextLabel = 'visible size selector') {
    if (!page || page.isClosed()) return false;

    const marker = `any-size-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const result = await page.evaluate(({ preferredSize, mk }) => {
        const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const sizeKeyValue = (raw) => (raw || '').toUpperCase()
            .replace(/\b(UK|IND|INDIA|US|EU|SIZE)\b/g, '')
            .replace(/SIZE/g, '')
            .replace(/[^A-Z0-9.]/g, '')
            .trim().toLowerCase();
        const isSizeToken = (raw) => {
            const key = sizeKeyValue(raw);
            if (/^\d/.test(key) && !/^([3-9]|1[0-9])(\.[05])?$/.test(key)) return false;
            return /^(\d{1,2}(\.\d)?|xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl|free)$/i.test(key);
        };
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                style.opacity !== '0';
        };
        const clickableOf = (element) => {
            let node = element;
            for (let depth = 0; node && depth < 5; depth++) {
                const tag = node.tagName;
                const role = node.getAttribute?.('role');
                const tabIndex = node.getAttribute?.('tabindex');
                if (tag === 'BUTTON' || tag === 'A' || role === 'button' || role === 'option' || tabIndex === '0' || node.onclick) {
                    return node;
                }
                node = node.parentElement;
            }
            return element;
        };
        const fixedOverlayAncestor = (element) => {
            let node = element;
            for (let depth = 0; node && depth < 10; depth++) {
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                const text = normalize(node.innerText || node.textContent).toLowerCase();
                if ((style.position === 'fixed' || style.position === 'absolute') && rect.width > 160 && rect.height > 100 &&
                    (parseInt(style.zIndex, 10) >= 10 || /select\s+size|choose\s+size|\bsize\b/.test(text))) {
                    return true;
                }
                node = node.parentElement;
            }
            return false;
        };
        const inSizeContext = (element) => {
            if (element.closest?.('[class*="size" i], [data-testid*="size" i], [id*="size" i], [aria-label*="size" i], [name*="size" i]')) return true;
            if (fixedOverlayAncestor(element)) return true;
            let node = element;
            for (let depth = 0; node && depth < 8; depth++) {
                const text = normalize(node.innerText || node.textContent).toLowerCase();
                if (/select\s+size|choose\s+size|pick\s+size|size\s*chart|size\s*guide|\bsize\b|\buk\b|\bindia?\b|\beu\b|\bus\b/.test(text)) return true;
                node = node.parentElement;
            }
            return false;
        };
        const unavailable = (element) => {
            const style = window.getComputedStyle(element);
            const meta = [element, element.parentElement, element.parentElement?.parentElement]
                .filter(Boolean)
                .map((node) => `${node.className || ''} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('aria-disabled') || ''} ${node.getAttribute?.('data-testid') || ''}`)
                .join(' ')
                .toLowerCase();
            const ownText = normalize(element.innerText || element.textContent).toLowerCase();
            return element.disabled || element.getAttribute('aria-disabled') === 'true' ||
                style.pointerEvents === 'none' || style.textDecorationLine.includes('line-through') || Number(style.opacity) < 0.30 ||
                /disabled|unavailable|out.of.stock|sold\s*out|notify\s*me/.test(meta) ||
                /notify me|out of stock|sold out|unavailable/i.test(ownText);
        };

        const nodes = Array.from(document.querySelectorAll('button, a, li, [role="button"], [role="option"], [tabindex], div, span'))
            .filter((element) => element.querySelectorAll('*').length <= 6 && visible(element));
        const seen = new Set();
        const candidates = [];
        for (const node of nodes) {
            const text = normalize(node.innerText || node.textContent);
            if (!text || text.length > 14 || !isSizeToken(text) || !inSizeContext(node)) continue;
            const control = clickableOf(node);
            if (!visible(control) || unavailable(control)) continue;
            const rect = control.getBoundingClientRect();
            const key = `${sizeKeyValue(text)}|${Math.round(rect.left)}|${Math.round(rect.top)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            let score = 0;
            const preferred = sizeKeyValue(preferredSize || '');
            if (preferred && sizeKeyValue(text) === preferred) score += 1000;
            if (fixedOverlayAncestor(control)) score += 500;
            if (control.tagName === 'BUTTON' || control.getAttribute('role') === 'button') score += 150;
            score += Math.max(0, 400 - rect.top) / 10;
            candidates.push({ control, text, score });
        }
        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) return { found: false };
        candidates[0].control.setAttribute('data-agent-any-size', mk);
        return { found: true, size: candidates[0].text, totalOptions: candidates.length };
    }, {
        preferredSize: requestedSize == null ? '' : String(requestedSize),
        mk: marker,
    }).catch((err) => ({ found: false, error: err.message }));

    if (!result?.found) return false;
    const handle = await page.$(`[data-agent-any-size="${marker}"]`).catch(() => null);
    if (!handle) return false;

    try {
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        await handle.click({ timeout: 2500, noWaitAfter: true });
    } catch (err) {
        try {
            await handle.click({ force: true, timeout: 2500, noWaitAfter: true });
        } catch {
            const box = await handle.boundingBox().catch(() => null);
            if (!box || !page.mouse) return false;
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
        }
    }

    logger.info(`Selected product size "${result.size}" from ${contextLabel} (${result.totalOptions} size options found)`);
    await page.waitForTimeout(900).catch(() => {});
    return true;
}

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
 * Handles the size/variant MODAL that some storefronts (Flipkart shoes/apparel)
 * open AFTER the initial ADD click. Detects the overlay generically (it may not
 * have role="dialog" or a meaningful class) by looking for a high z-index fixed
 * container that covers most of the viewport and contains size-like buttons,
 * then selects an available size and presses Continue/Add to Cart.
 */
async function handleVariantModalIfPresent(page, requestedSize = null) {
    if (!page || page.isClosed()) return false;

    // Safe wait: never throw "Target page... has been closed" fatally. If the
    // page closes mid-wait, return false so the caller can reacquire a page.
    const safeWait = async (ms) => {
        try {
            if (page.isClosed && page.isClosed()) return false;
            await page.waitForTimeout(ms);
            return !(page.isClosed && page.isClosed());
        } catch {
            return false;
        }
    };
    const pageAlive = () => !(page.isClosed && page.isClosed());

    try {
        let modal = null;
        // Wait for the modal to animate in.
        for (let attempt = 0; attempt < 8; attempt++) {
            if (!(await safeWait(300))) return false;

            const found = await page.evaluateHandle(() => {
                const visible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    const s = window.getComputedStyle(el);
                    return r.width > 0 && r.height > 0 &&
                        s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
                };
                const normalize = (v) => (v || '').replace(/\s+/g, ' ').trim();
                // Accept "8", "UK 8", "8 UK", "7.5", "XS".."4XL", "Free"/"Free Size".
                const sizeKeyValue = (raw) => (raw || '').toUpperCase()
                    .replace(/\b(UK|IND|INDIA|US|EU|SIZE)\b/g, '')
                    .replace(/SIZE/g, '')
                    .replace(/[^A-Z0-9.]/g, '')
                    .trim();
                const isSizeText = (t) => {
                    const v = normalize(t);
                    if (v.length === 0 || v.length > 12) return false;
                    return /^(\d{1,2}(\.\d)?|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|4XL|FREE)$/i.test(sizeKeyValue(v));
                };

                // Candidate containers: semantic dialogs first...
                const semantic = Array.from(document.querySelectorAll(
                    '[role="dialog"], [role="alertdialog"], [class*="modal" i], [class*="Modal" i], [class*="drawer" i], [class*="sheet" i], [class*="overlay" i], [class*="popover" i]',
                )).filter(visible);

                // ...then any fixed/absolute high z-index overlay covering ≥25% of
                // the viewport (Flipkart's hashed-class size sheet/backdrop).
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const overlays = [];
                document.querySelectorAll('body *').forEach((el) => {
                    if (!visible(el)) return;
                    const s = window.getComputedStyle(el);
                    if (s.position !== 'fixed' && s.position !== 'absolute') return;
                    const z = parseInt(s.zIndex, 10);
                    if (!Number.isFinite(z) || z < 50) return;
                    const r = el.getBoundingClientRect();
                    const covers = (r.width * r.height) / (vw * vh);
                    const text = normalize(el.innerText || el.textContent).toLowerCase();
                    const looksLikeVariantSheet = /select\s+size|choose\s+size|size\s*chart|size\s*guide|\bsize\b/.test(text);
                    if (r.width > 180 && r.height > 120 && (covers >= 0.10 || looksLikeVariantSheet)) overlays.push(el);
                });

                const candidates = [...semantic, ...overlays];
                // Prefer the smallest container that actually holds size buttons.
                // Match leaf-ish nodes (Flipkart renders sizes as plain <div>/<span>
                // inside the sheet, not always <button>).
                const withSizes = candidates.map((el) => {
                    const all = Array.from(el.querySelectorAll(
                        'button, [role="button"], li, a, div, span',
                    )).filter((b) => b.querySelectorAll('*').length <= 2 && visible(b));
                    const btns = all.filter((b) => isSizeText(b.innerText || b.textContent));
                    return { el, sizeButtons: btns.length };
                }).filter((c) => c.sizeButtons > 0)
                  .sort((a, b) => a.sizeButtons - b.sizeButtons);

                return withSizes[0]?.el || null;
            }).catch(() => null);

            if (found) {
                const asEl = found.asElement();
                if (asEl && await asEl.isVisible().catch(() => false)) {
                    modal = asEl;
                    break;
                }
            }
            if (!pageAlive()) return false;
        }

        if (!modal) return false;
        logger.info('Variant/size modal detected after ADD click; selecting an option');

        // Tag every size option inside the detected modal (leaf nodes only).
        const marker = `variant-modal-${Date.now()}`;
        await modal.evaluate((root, mk) => {
            const sizeKeyValue = (raw) => (raw || '').toUpperCase()
                .replace(/\b(UK|IND|INDIA|US|EU|SIZE)\b/g, '')
                .replace(/SIZE/g, '')
                .replace(/[^A-Z0-9.]/g, '')
                .trim();
            const nodes = Array.from(root.querySelectorAll(
                'button, [role="button"], li, a, div, span',
            )).filter((el) => el.querySelectorAll('*').length <= 2);
            let id = 1;
            nodes.forEach((el) => {
                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                if (text.length === 0 || text.length > 12) return;
                const key = sizeKeyValue(text);
                if (!/^(\d{1,2}(\.\d)?|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|4XL|FREE)$/i.test(key)) return;
                // Prefer the nearest interactive ancestor so a real click lands.
                let clickable = el;
                for (let depth = 0; clickable && depth < 3; depth++) {
                    const tag = clickable.tagName;
                    if (tag === 'BUTTON' || tag === 'A' ||
                        clickable.getAttribute('role') === 'button' ||
                        clickable.getAttribute('role') === 'option' ||
                        clickable.getAttribute('tabindex') === '0') break;
                    clickable = clickable.parentElement;
                }
                clickable = clickable || el;
                if (clickable.hasAttribute('data-agent-variant-option')) return;
                clickable.setAttribute('data-agent-variant-option', mk);
                clickable.setAttribute('data-agent-variant-id', String(id++));
                clickable.setAttribute('data-agent-variant-text', text);
            });
        }, marker).catch(() => {});

        const optionHandles = await modal.$$(`[data-agent-variant-option="${marker}"]`);
        if (optionHandles.length === 0) {
            logger.warn('Variant modal detected but no size options found');
            return false;
        }

        const requestedNormalized = requestedSize != null
            ? String(requestedSize).replace(/^UK\s*/i, '').trim().toLowerCase()
            : '';

        const options = [];
        for (const handle of optionHandles) {
            const info = await handle.evaluate((el) => {
                const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                const style = window.getComputedStyle(el);
                const ownText = (el.innerText || el.textContent || '').slice(0, 80);
                const ancestorMeta = [el, el.parentElement, el.parentElement?.parentElement]
                    .filter(Boolean)
                    .map((node) => `${node.className || ''} ${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('aria-disabled') || ''} ${node.getAttribute?.('data-testid') || ''}`)
                    .join(' ')
                    .toLowerCase();
                const disabled = el.disabled ||
                    el.getAttribute('aria-disabled') === 'true' ||
                    /disabled|strike|unavailable|out.of.stock|notify\s*me|sold\s*out/.test(ancestorMeta) ||
                    style.pointerEvents === 'none' ||
                    Number(style.opacity) < 0.4 ||
                    style.textDecorationLine.includes('line-through') ||
                    /notify me|out of stock|sold out|unavailable/i.test(ownText);
                const selected = /\b(selected|active|checked)\b/i.test(
                    `${el.className || ''} ${el.getAttribute('aria-pressed') || ''} ${el.getAttribute('aria-checked') || ''}`,
                );
                return { text, disabled, selected };
            }).catch(() => null);
            if (info) options.push({ handle, ...info });
        }

        const available = options.filter((o) => !o.disabled);
        if (available.length === 0) {
            logger.warn('Variant modal open but every size appears unavailable');
            return false;
        }

        const target = available.find((o) => o.text.toLowerCase() === requestedNormalized) ||
                       available.find((o) => !o.selected) ||
                       available[0];

        try {
            await target.handle.scrollIntoViewIfNeeded().catch(() => {});
            await target.handle.click({ force: true, timeout: 2500, noWaitAfter: true });
            logger.info(`Variant modal: selected size "${target.text}"`);
        } catch (err) {
            logger.warn(`Variant modal: could not click size "${target.text}": ${err.message}`);
            return false;
        }

        if (!(await safeWait(600))) return false;

        // Find an enabled confirmation button. Prefer exact labels; fall back to
        // any large enabled button at the bottom of the modal.
        const confirmLabels = [
            'Continue', 'Add to Cart', 'Add to cart', 'ADD TO CART',
            'Add to Bag', 'Add to bag', 'ADD TO BAG',
            'Done', 'Confirm', 'OK', 'Proceed', 'Apply',
        ];
        for (const label of confirmLabels) {
            const btn = modal.locator(
                `button:has-text("${label}"), [role="button"]:has-text("${label}"), a:has-text("${label}")`,
            ).first();
            if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
                const isEnabled = await btn.evaluate((el) => {
                    const s = window.getComputedStyle(el);
                    return !el.disabled && el.getAttribute('aria-disabled') !== 'true' &&
                        s.pointerEvents !== 'none' && Number(s.opacity) > 0.4;
                }).catch(() => true);
                if (isEnabled) {
                    await btn.click({ force: true, timeout: 3000, noWaitAfter: true }).catch(() => {});
                    logger.info(`Variant modal: confirmed with "${label}"`);
                    await safeWait(1200);
                    return true;
                }
            }
        }

        // Fallback: the widest enabled button at the bottom of the modal.
        const fallbackClicked = await modal.evaluate((root) => {
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            };
            const modalRect = root.getBoundingClientRect();
            const buttons = Array.from(root.querySelectorAll('button, [role="button"], a')).filter((b) => {
                if (!visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                const r = b.getBoundingClientRect();
                const s = window.getComputedStyle(b);
                if (s.pointerEvents === 'none' || Number(s.opacity) < 0.4) return false;
                return r.top >= modalRect.top + modalRect.height * 0.5 && r.width > 80;
            });
            if (buttons.length === 0) return false;
            buttons.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
            buttons[0].click();
            return true;
        }).catch(() => false);

        if (fallbackClicked) {
            logger.info('Variant modal: confirmed via the primary bottom button');
            await safeWait(1200);
            return true;
        }

        logger.info('Variant modal: size selected but no confirm button found; assuming confirmed');
        await safeWait(800);
        return true;
    } catch (err) {
        logger.warn(`Variant modal handler error: ${err.message}`);
        return false;
    }
}

/**
 * Dismisses a non-size blocking overlay (pincode/login/promotional sheet) that
 * sits over the ADD control by pressing Escape and clicking any visible close
 * control. Returns true when something was dismissed.
 */
async function dismissBlockingOverlay(page) {
    if (!page || page.isClosed()) return false;

    const hasBlockingOverlay = await page.evaluate(() => {
        const visible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 200) return false;
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const sizeKeyValue = (raw) => (raw || '').toUpperCase()
            .replace(/\b(UK|IND|INDIA|US|EU|SIZE)\b/g, '')
            .replace(/SIZE/g, '')
            .replace(/[^A-Z0-9.]/g, '').trim();
        const isSizeLike = (t) => /^(\d{1,2}(\.\d)?|XXS|XS|S|M|L|XL|XXL|XXXL|3XL|4XL|FREE)$/i.test(sizeKeyValue(t));

        // If a large fixed/absolute overlay exists and contains a handful of
        // size-like leaves, it is the variant sheet — DO NOT dismiss it.
        const candidates = Array.from(document.querySelectorAll('body *')).filter((el) => {
            if (!visible(el)) return false;
            const s = window.getComputedStyle(el);
            if (s.position !== 'fixed' && s.position !== 'absolute') return false;
            const z = parseInt(s.zIndex, 10);
            if (!Number.isFinite(z) || z < 50) return false;
            const r = el.getBoundingClientRect();
            return (r.width * r.height) / (vw * vh) >= 0.25;
        });
        for (const el of candidates) {
            const leaves = Array.from(el.querySelectorAll('button, [role="button"], li, a, div, span'))
                .filter((n) => n.querySelectorAll('*').length <= 2 && visible(n));
            const sizeLike = leaves.filter((n) => {
                const t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
                return t.length > 0 && t.length <= 12 && isSizeLike(t);
            });
            if (sizeLike.length >= 2) return false; // variant sheet — leave it for the modal handler
        }
        return candidates.length > 0;
    }).catch(() => false);

    if (!hasBlockingOverlay) return false;

    logger.info('Dismissing a non-size overlay blocking the Add to Cart control');
    // First try any explicit close button.
    const closeClicked = await page.evaluate(() => {
        const controls = Array.from(document.querySelectorAll(
            'button[aria-label*="close" i], button[title*="close" i], [role="button"][aria-label*="close" i], [data-testid*="close" i], ._3K4tT, button',
        ));
        const closeBtn = controls.find((el) => {
            const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.innerText || ''} ${el.className || ''}`.toLowerCase();
            return /\bclose\b|dismiss|✕|×|skip\b|not\s*now|maybe\s*later/.test(label);
        });
        if (closeBtn) {
            const s = window.getComputedStyle(closeBtn);
            if (s.pointerEvents !== 'none' && Number(s.opacity) > 0.1 && s.visibility !== 'hidden') {
                closeBtn.click();
                return true;
            }
        }
        return false;
    }).catch(() => false);

    if (closeClicked) {
        await page.waitForTimeout(400).catch(() => {});
        return true;
    }

    // Fallback: Escape closes most Flipkart sheets.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400).catch(() => {});
    return true;
}

/**
 * Returns the currently active page, refreshing a possibly-stale handle after a
 * Flipkart ov_redirect tab swap. Falls back to the incoming page on any error.
 */
function activePageRef(page) {
    try {
        const fresh = getPage();
        if (fresh && !fresh.isClosed()) return fresh;
    } catch {}
    return page;
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

    // The PDP often opens in a swapped active tab; operate on the live page.
    page = activePageRef(page);

    // Guard: add_to_cart only makes sense on a product details page. If the LLM
    // fires it on a search listing / cart / homepage, don't click random things
    // (this previously misfired size "0" and navigated to the cart). Return a
    // clear error so the controller opens a product first.
    if (!isProductPage(page)) {
        return {
            success: false,
            clicked: false,
            error: `Add to cart requires a product page (current page is ${page.url()}). Click a product to open its details page first.`,
        };
    }

    // 1. Select the first available size on the product page BEFORE adding.
    // Flipkart often exposes sizes as swatch links first; opening one mounts the
    // real selectable size state, so try that before the generic scanner.
    const variantLinkOpened = await selectSizeVariantLinkIfPresent(page, options.requestedSize || null).catch(() => false);
    if (variantLinkOpened) {
        page = activePageRef(page);
        await selectAnyVisibleSizeOption(page, options.requestedSize || null, 'size variant page').catch(() => false);
    }
    const sizeSelectedBeforeAdd = variantLinkOpened || await selectRequiredSizeIfPresent(page, options.requestedSize || null);
    if (!sizeSelectedBeforeAdd) {
        await selectAnyVisibleSizeOption(page, options.requestedSize || null, 'product page fallback').catch(() => false);
    }

    // 2. If a size/variant sheet is already open (some Flipkart flows open it
    //    on PDP load), handle it so it does not intercept the ADD click.
    try {
        await handleVariantModalIfPresent(page, options.requestedSize || null);
    } catch (modalErr) {
        logger.warn(`Pre-ADD variant modal handler skipped: ${modalErr.message}`);
    }

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
        // Refresh the live page at every attempt (Flipkart tab swaps).
        page = activePageRef(page);
        if (page.isClosed && page.isClosed()) {
            lastClickError = lastClickError || new Error('Page closed before add-to-cart attempt');
            break;
        }

        // Clear any non-size overlay that would intercept the ADD click.
        await dismissBlockingOverlay(page).catch(() => {});

        if (!currentTarget) {
            currentTarget = await findSelectedAddControl(page, targetScope);
        }
        if (!currentTarget) {
            // A stable disappearance after a dispatched click is itself a
            // selected-product transition (Flipkart commonly removes ADD).
            if (clicked) {
                await page.waitForTimeout(500).catch(() => {});
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
        await page.waitForTimeout(200).catch(() => {});

        let dispatched = false;
        try {
            await currentTarget.click({ timeout: 3000, noWaitAfter: true });
            dispatched = true;
        } catch (standardClickError) {
            lastClickError = standardClickError;
            const intercepted = /intercepts pointer events|element is not clickable|receives pointer events/i.test(standardClickError.message || '');
            if (intercepted) {
                page = activePageRef(page);
                await handleVariantModalIfPresent(page, options.requestedSize || null).catch(() => false);
                await selectAnyVisibleSizeOption(page, options.requestedSize || null, 'blocking size overlay').catch(() => false);
                await page.waitForTimeout(500).catch(() => {});
                try {
                    await currentTarget.click({ timeout: 3000, noWaitAfter: true });
                    dispatched = true;
                } catch (retryAfterSizeError) {
                    lastClickError = retryAfterSizeError;
                }
            }
            if (!dispatched) {
                logger.warn(`Cart click attempt ${clickAttempts} failed normally; trying force-click once: ${(lastClickError || standardClickError).message}`);
                try {
                    await currentTarget.click({ force: true, timeout: 2500, noWaitAfter: true });
                    dispatched = true;
                } catch (forceClickError) {
                    lastClickError = forceClickError;
                }
            }
        }
        clicked = clicked || dispatched;

        if (dispatched && clickAttempts > 1) {
            logger.info(`Retried the selected Add control (${clickAttempts}/${maxAddAttempts})`);
        }

        // Wait for React/network state, checking global signals and the selected
        // product after each bounded click attempt.
        if (dispatched) {
            // The click may have opened a new tab or navigated (Flipkart often
            // does this). Switch to whichever page is now active.
            page = activePageRef(page);
            if (page.isClosed && page.isClosed()) {
                lastClickError = lastClickError || new Error('Page closed/navigated during add-to-cart');
                break;
            }

            // Some storefronts (Flipkart shoes/apparel) open a "Select variant"
            // size modal AFTER the initial ADD click. Handle it before verifying.
            try {
                await handleVariantModalIfPresent(page, options.requestedSize || null);
            } catch (modalErr) {
                logger.warn(`Variant modal handler skipped: ${modalErr.message}`);
            }

            // The strong Playwright-based verifier races four independent signals:
            // URL redirect to /cart, a "Added to cart" toast, an increased cart
            // badge count, and the ADD control turning into "GO TO CART"/"ADDED".
            const strongVerify = await verifyCartAddition(page, {
                timeoutMs: 5000,
                badgeBefore: beforeCart.itemCount || 0,
            });
            afterCart = await inspectCartState(page);
            scopeState = await inspectCartTargetScope(page, targetScope);

            if (strongVerify.verified) {
                verified = true;
                transitionEvidence = `${strongVerify.method}: ${strongVerify.detail}`;
            }

            if (!verified && !didCartStateAdvance(beforeCart, afterCart) && !scopeState.advanced) {
                const confirmedCustomization = await confirmCartCustomizationIfPresent(page);
                if (confirmedCustomization) {
                    const reVerify = await verifyCartAddition(page, {
                        timeoutMs: 3000,
                        badgeBefore: beforeCart.itemCount || 0,
                    });
                    afterCart = await inspectCartState(page);
                    scopeState = await inspectCartTargetScope(page, targetScope);
                    if (reVerify.verified) {
                        verified = true;
                        transitionEvidence = `${reVerify.method}: ${reVerify.detail}`;
                    }
                }
            }

            if (!verified) {
                verified = didCartStateAdvance(beforeCart, afterCart) || scopeState.advanced;
            }
            if (scopeState.postAddState && !transitionEvidence) {
                transitionEvidence = scopeState.transitionEvidence || 'selected control changed to a cart state';
            }

            // Confirm disappearance twice so a short loading animation is not
            // mistaken for success. This catches Flipkart's ADD removal even
            // when its header exposes no numeric cart badge.
            if (!verified && scopeState.addControlDisappeared && !scopeState.selectedAddPresent) {
                await page.waitForTimeout(500).catch(() => {});
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
        // Reacquire the ADD control for the next attempt on the (possibly
        // swapped) active page.
        page = activePageRef(page);
        currentTarget = page.isClosed && page.isClosed()
            ? null
            : await findSelectedAddControl(page, targetScope);
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
        if (!quantityResult.success && options.allowCartPageQuantity) {
            page = activePageRef(page);
            const cartOpenResult = await openCartPageForQuantity(page);
            if (!cartOpenResult.success) {
                quantityResult.error = `${quantityResult.error || 'Inline quantity control was not available'}; cart page could not be opened: ${cartOpenResult.error}`;
            }
            page = activePageRef(page);
            const cartPageQuantity = cartOpenResult.success
                ? await ensureCartPageQuantity(page, requestedQuantity)
                : { success: false, error: cartOpenResult.error, quantity: quantityResult.quantity || 0 };
            if (cartPageQuantity.success) {
                quantityResult.success = true;
                quantityResult.quantity = cartPageQuantity.quantity;
                quantityResult.scopeState = scopeState;
                quantityResult.cartState = await inspectCartState(page);
            } else {
                quantityResult.error = `${quantityResult.error || 'Inline quantity control was not available'}; cart page quantity update also failed: ${cartPageQuantity.error}`;
            }
        }
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
        scopeState = quantityResult.scopeState || scopeState;
        afterCart = quantityResult.cartState || afterCart;
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
            allowCartPageQuantity: options.allowCartPageQuantity,
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
                        allowCartPageQuantity: action.allow_cart_page_quantity,
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

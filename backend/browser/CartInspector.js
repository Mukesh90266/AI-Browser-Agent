// CartInspector.js — Detects cart count, cart summaries, and quantity-control transitions across websites

function emptyCartState() {
    return {
        hasItems: false,
        itemCount: 0,
        quantityControlCount: 0,
        cartSummary: '',
        cartPageWithItems: false,
        evidence: [],
    };
}

/**
 * Inspects common cart signals without relying on one website's CSS classes.
 */
async function inspectCartState(page) {
    if (!page || page.isClosed()) return emptyCartState();

    try {
        return await page.evaluate(() => {
            const isVisible = (element) => {
                if (!element) return false;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    style.opacity !== '0';
            };

            const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
            const evidence = [];
            let itemCount = 0;
            let cartSummary = '';

            // Method 1: numeric badges/counts associated with a cart element.
            const countSelectors = [
                '[data-testid*="cart-count" i]',
                '[data-testid*="cart-badge" i]',
                '[id*="cart-count" i]',
                '[class*="cart-count" i]',
                '[class*="cartCount" i]',
                '[aria-label*="cart" i] [class*="badge" i]',
                'a[href*="/cart" i] [class*="badge" i]',
                'button[aria-label*="cart" i]',
                'a[aria-label*="cart" i]',
            ].join(', ');

            document.querySelectorAll(countSelectors).forEach((element) => {
                if (!isVisible(element)) return;
                const text = normalize(
                    element.innerText ||
                    element.textContent ||
                    element.getAttribute('aria-label') ||
                    element.getAttribute('title'),
                );
                const explicitItems = text.match(/\b(\d{1,3})\s*items?\b/i);
                const plainCount = text.match(/^\s*(\d{1,3})\s*$/);
                const cartCount = text.match(/cart[^\d]{0,15}(\d{1,3})/i);
                const match = explicitItems || plainCount || cartCount;
                const count = match ? Number(match[1]) : 0;
                if (count > itemCount) itemCount = count;
            });

            // Flipkart uses /viewcart (not /cart), so its badge is missed by the
            // generic selectors above. Explicitly read a numeric badge inside any
            // cart/viewcart anchor or its aria-label.
            document.querySelectorAll('a[href*="viewcart" i], a[href*="/cart" i], button[aria-label*="cart" i]').forEach((link) => {
                if (!isVisible(link)) return;
                const numericChild = Array.from(link.querySelectorAll('span, div, em, b, small')).find((el) => {
                    if (!isVisible(el)) return false;
                    const t = normalize(el.innerText || el.textContent);
                    return /^\d{1,3}$/.test(t);
                });
                if (numericChild) {
                    const count = Number(normalize(numericChild.innerText || numericChild.textContent));
                    if (count > itemCount) itemCount = count;
                }
                const aria = `${link.getAttribute('aria-label') || ''} ${link.getAttribute('title') || ''}`;
                if (/cart/i.test(aria)) {
                    const ariaMatch = aria.match(/(\d{1,3})\s*(?:items?|products?)?/i);
                    if (ariaMatch) {
                        const count = Number(ariaMatch[1]);
                        if (count > itemCount) itemCount = count;
                    }
                }
            });

            if (itemCount > 0) evidence.push(`cart badge/count: ${itemCount}`);

            // Method 2: quick-commerce cart bars such as "1 item ₹250".
            const cartContainers = document.querySelectorAll([
                '[data-testid*="cart" i]',
                '[class*="cart" i]',
                '[id*="cart" i]',
                'a[href*="/cart" i]',
                'a[href*="viewcart" i]',
                'button[aria-label*="cart" i]',
            ].join(', '));

            for (const element of cartContainers) {
                if (!isVisible(element)) continue;
                const text = normalize(element.innerText || element.textContent || element.getAttribute('aria-label'));
                if (!text || text.length > 250) continue;

                const itemMatch = text.match(/\b(\d{1,3})\s*items?\b/i);
                const hasCartLanguage = /\b(cart|bag|basket|view cart)\b/i.test(text);
                const hasPrice = /[₹$€£]\s*[\d,.]+|\b(?:rs\.?|inr)\s*[\d,.]+/i.test(text);

                if (itemMatch && (hasCartLanguage || hasPrice)) {
                    const count = Number(itemMatch[1]);
                    if (count > itemCount) itemCount = count;
                    if (!cartSummary || text.length < cartSummary.length) cartSummary = text;
                }
            }

            if (cartSummary) evidence.push(`cart summary: ${cartSummary}`);

            // Method 3: ADD changed into a decrement / quantity / increment control.
            const quantityGroups = new Set();
            const decrementControls = document.querySelectorAll([
                'button[aria-label*="decrease" i]',
                'button[aria-label*="decrement" i]',
                '[role="button"][aria-label*="decrease" i]',
                '[data-testid*="decrement" i]',
                '[data-testid*="decrease" i]',
            ].join(', '));

            decrementControls.forEach((control) => {
                if (!isVisible(control)) return;
                const parent = control.parentElement;
                if (!parent || !isVisible(parent)) return;
                const parentText = normalize(parent.innerText || parent.textContent);
                const hasIncrement = !!parent.querySelector([
                    'button[aria-label*="increase" i]',
                    'button[aria-label*="increment" i]',
                    '[role="button"][aria-label*="increase" i]',
                    '[data-testid*="increment" i]',
                    '[data-testid*="increase" i]',
                ].join(', '));
                if (hasIncrement || /(?:^|\s)[−-]\s*\d+\s*\+(?:\s|$)/.test(parentText)) {
                    quantityGroups.add(parent);
                }
            });

            // Text-only React counters often have no useful classes or ARIA labels.
            document.querySelectorAll('div, span').forEach((element) => {
                if (!isVisible(element) || element.children.length > 8) return;
                const text = normalize(element.innerText || element.textContent);
                if (text.length <= 20 && /^(?:[−-]\s*)?\d+\s*\+$/.test(text)) {
                    quantityGroups.add(element);
                }
            });

            const quantityControlCount = quantityGroups.size;
            if (quantityControlCount > 0) {
                evidence.push(`quantity controls: ${quantityControlCount}`);
            }

            // Some product pages navigate directly to a full cart page after ADD.
            const bodyText = normalize(document.body?.innerText || '');
            const isCartUrl = /\/(?:viewcart|cart|basket)(?:[/?#]|$)/i.test(window.location.pathname);
            const cartIsEmpty = /(?:your\s+)?(?:cart|bag|basket)\s+is\s+empty|no items? in (?:your\s+)?(?:cart|bag|basket)/i.test(bodyText);
            const hasCartPageActions = /\b(place order|proceed to (?:buy|checkout)|save for later|remove)\b/i.test(bodyText);
            const cartPageWithItems = isCartUrl && !cartIsEmpty && hasCartPageActions;
            if (cartPageWithItems) evidence.push('navigated to a non-empty cart page');

            return {
                hasItems: itemCount > 0 || quantityControlCount > 0 || !!cartSummary || cartPageWithItems,
                itemCount,
                quantityControlCount,
                cartSummary,
                cartPageWithItems,
                evidence,
            };
        });
    } catch {
        return emptyCartState();
    }
}

/**
 * Strong, Playwright-based cart-add verification. Races four independent signals
 * (URL redirect to cart, toast/snackbar message, cart badge count increase, and
 * ADD control changing into "GO TO CART"/"ADDED") and returns as soon as any one
 * confirms the item was added. Works across Flipkart, Amazon, Blinkit, Zepto, etc.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  Total time to wait for a signal.
 * @param {number} [options.badgeBefore] Optional baseline cart count; badge must
 *                                        exceed it to count as success.
 * @returns {Promise<{verified: boolean, method: string, detail: string}>}
 */
async function verifyCartAddition(page, options = {}) {
    if (!page || page.isClosed()) {
        return { verified: false, method: 'none', detail: 'page closed' };
    }

    const timeoutMs = Math.max(1500, Number(options.timeoutMs) || 6000);
    const deadline = Date.now() + timeoutMs;
    const logger = (() => {
        try { return require('../utils/logger'); } catch { return { info() {}, warn() {}, debug() {} }; }
    })();

    // Signal 1: navigation to a cart / checkout / added-confirmation URL.
    const urlSignal = (async () => {
        try {
            await page.waitForURL(
                (url) => /\/(viewcart|cart|basket|checkout|add-to-cart)(?:[/?#]|$)/i.test(url.pathname + url.search),
                { timeout: timeoutMs, waitUntil: 'domcontentloaded' },
            );
            return { method: 'url', detail: `navigated to ${page.url()}` };
        } catch { return null; }
    })();

    // Signal 2: toast / snackbar / inline "Added to cart" message.
    const toastSelectors = [
        'text=/added to (cart|bag|basket)/i',
        'text=/item added/i',
        'text=/added successfully/i',
        '[class*="toast" i]',
        '[class*="snackbar" i]',
        '[class*="Toast" i]',
        '[class*="notification" i]',
        '[role="status"]',
        '[role="alert"]',
        '._30XB9F',     // common Flipkart toast class
        '.qKBrNq',      // common Flipkart toast class
        '.ZAtlA-',      // Flipkart snackbar
    ];

    const toastSignal = (async () => {
        while (Date.now() < deadline) {
            for (const sel of toastSelectors) {
                try {
                    const loc = page.locator(sel).first();
                    if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
                        const text = (await loc.textContent({ timeout: 300 }).catch(() => '')) || '';
                        if (/added|cart|bag|basket|item/i.test(text) || /toast|snack|notification/i.test(sel)) {
                            return { method: 'toast', detail: `${sel} → ${text.trim().slice(0, 80)}` };
                        }
                    }
                } catch {}
            }
            await page.waitForTimeout(250);
        }
        return null;
    })();

    // Signal 3: cart badge count is positive (or exceeds baseline).
    const badgeSelectors = [
        '[data-testid*="cart-count" i]',
        '[data-testid*="cart-badge" i]',
        '[id*="cart-count" i]',
        '[class*="cart-count" i]',
        '[class*="cartCount" i]',
        'a[href*="viewcart" i] [class*="badge" i]',
        'a[href*="/cart" i] [class*="badge" i]',
        'a[href*="viewcart" i] span',
        'a[href*="viewcart" i] div',
        'a[aria-label*="cart" i]',
    ];

    const readBadgeNumber = async () => {
        for (const sel of badgeSelectors) {
            try {
                const loc = page.locator(sel).first();
                if (!await loc.isVisible({ timeout: 100 }).catch(() => false)) continue;
                const raw = (await loc.textContent({ timeout: 200 }).catch(() => '')) || '';
                const m = raw.match(/(\d{1,3})/);
                if (m) return Number(m[1]);
            } catch {}
        }
        return 0;
    };

    const badgeSignal = (async () => {
        const baseline = Number.isInteger(options.badgeBefore) ? options.badgeBefore : (await readBadgeNumber());
        while (Date.now() < deadline) {
            const count = await readBadgeNumber();
            if (count > 0 && count > baseline) {
                return { method: 'badge', detail: `cart badge count is now ${count} (was ${baseline})` };
            }
            // If no baseline was known, a positive count still confirms.
            if (!Number.isInteger(options.badgeBefore) && count > 0) {
                return { method: 'badge', detail: `cart badge count is ${count}` };
            }
            await page.waitForTimeout(250);
        }
        return null;
    })();

    // Signal 4: ADD control replaced by "GO TO CART" / "ADDED" / quantity counter.
    const buttonSignal = (async () => {
        const postAddSelectors = [
            'button:has-text("GO TO CART")',
            'button:has-text("Go to Cart")',
            'button:has-text("ADDED")',
            'button:has-text("Added")',
            '[role="button"]:has-text("GO TO CART")',
            '[role="button"]:has-text("Go to Cart")',
            'a:has-text("GO TO CART")',
            'a:has-text("Go to Cart")',
            'div:has-text("GO TO CART")',
            'div:has-text("Go to Cart")',
            'span:has-text("GO TO CART")',
        ];
        while (Date.now() < deadline) {
            for (const sel of postAddSelectors) {
                try {
                    const loc = page.locator(sel).first();
                    if (await loc.isVisible({ timeout: 150 }).catch(() => false)) {
                        const text = (await loc.textContent({ timeout: 300 }).catch(() => '')) || '';
                        return { method: 'button', detail: `${sel} → ${text.trim().slice(0, 60)}` };
                    }
                } catch {}
            }
            // A − N + quantity counter also proves the item was added.
            try {
                const counter = page.locator('div, span').filter({ hasText: /^[−–—-]\s*\d{1,2}\s*(\+|＋)$/ }).first();
                if (await counter.isVisible({ timeout: 100 }).catch(() => false)) {
                    const text = (await counter.textContent({ timeout: 200 }).catch(() => '')) || '';
                    return { method: 'button', detail: `quantity control appeared: ${text.trim()}` };
                }
            } catch {}
            await page.waitForTimeout(250);
        }
        return null;
    })();

    const winner = await Promise.race([
        urlSignal, toastSignal, badgeSignal, buttonSignal,
    ]);

    if (winner) {
        logger.info(`Cart addition verified via ${winner.method}: ${winner.detail}`);
        return { verified: true, ...winner };
    }

    logger.warn(`No cart verification signal detected within ${timeoutMs}ms`);
    return { verified: false, method: 'none', detail: 'no url/toast/badge/button signal' };
}

/**
 * Returns true only when a post-click cart signal is stronger than its baseline.
 */
function didCartStateAdvance(before = emptyCartState(), after = emptyCartState()) {
    if ((after.itemCount || 0) > (before.itemCount || 0)) return true;
    if ((after.quantityControlCount || 0) > (before.quantityControlCount || 0)) return true;
    if (!before.cartPageWithItems && after.cartPageWithItems) return true;
    if (!before.hasItems && after.hasItems) return true;
    if (after.cartSummary && after.cartSummary !== before.cartSummary) return true;
    return false;
}

module.exports = {
    inspectCartState,
    didCartStateAdvance,
    verifyCartAddition,
    emptyCartState,
};

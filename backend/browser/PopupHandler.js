// PopupHandler.js — Kisi bhi site pe login/signup popup auto-close karna

const { getPage } = require('./BrowserManager');

// Common close button patterns — har website mein yeh milte hain
const CLOSE_SELECTORS = [
    // Generic close buttons
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '[aria-label="Close dialog"]',
    'button[title="Close"]',

    // Icon based close (×  ✕  X)
    'button:has-text("×")',
    'button:has-text("✕")',
    'span:has-text("×")',

    // Class name patterns (common frameworks)
    '[class*="close" i]:visible',
    '[class*="modal-close" i]',
    '[class*="popup-close" i]',
    '[class*="dialog-close" i]',

    // Flipkart specific
    'button._2KpZ6l._2doB4z',

    // Generic X icon svg wrapped in button
    'button:has(svg):near(:text("Login"))',
];

// Login/Signup text patterns — inhe dhoondke unke paas ka close button click karo
const MODAL_KEYWORDS = ['login', 'sign in', 'sign up', 'signup', 'create account', 'log in'];

// Escape key try karo — bahut modals isse band ho jaate hain
async function tryEscapeKey() {
    const page = getPage();
    try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        return true;
    } catch (e) {
        return false;
    }
}

// Overlay/backdrop pe click karo — bahut modals bahar click karne se band hote hain
async function tryClickOutside() {
    const page = getPage();
    try {
        // Body ke corner pe click karo — modal ke bahar
        await page.mouse.click(5, 5);
        await page.waitForTimeout(500);
        return true;
    } catch (e) {
        return false;
    }
}

// Main function — popup detect karke close karo
async function closePopupIfExists() {
    const page = getPage();
    let closed = false;

    console.log('🔍 Popup check kar raha hai...');

    // Step 1: Close button selectors try karo
    for (const selector of CLOSE_SELECTORS) {
        try {
            const el = await page.$(selector);
            if (el) {
                const visible = await el.isVisible();
                if (visible) {
                    await el.click({ timeout: 2000 });
                    console.log(`✅ Popup closed with: ${selector}`);
                    closed = true;
                    break;
                }
            }
        } catch (e) {
            continue;
        }
    }

    // Step 2: Agar close button nahi mila — Escape key try karo
    if (!closed) {
        const hasModal = await detectModalPresence();
        if (hasModal) {
            console.log('⌨️  Close button nahi mila — Escape key try kar raha hai');
            await tryEscapeKey();
            const stillThere = await detectModalPresence();
            closed = !stillThere;
            if (closed) console.log('✅ Popup Escape key se band hua');
        }
    }

    // Step 3: Phir bhi nahi gaya — outside click try karo
    if (!closed) {
        const hasModal = await detectModalPresence();
        if (hasModal) {
            console.log('🖱️  Outside click try kar raha hai');
            await tryClickOutside();
            const stillThere = await detectModalPresence();
            closed = !stillThere;
            if (closed) console.log('✅ Popup outside-click se band hua');
        }
    }

    if (!closed) {
        console.log('ℹ️  No popup found (ya close nahi ho saka)');
    }

    await page.waitForTimeout(500);
    return closed;
}

// Check karo modal/overlay screen pe hai ya nahi
async function detectModalPresence() {
    const page = getPage();
    try {
        const hasOverlay = await page.evaluate((keywords) => {
            // Common modal/overlay classes dhundo
            const modalSelectors = [
                '[class*="modal" i]',
                '[class*="overlay" i]',
                '[class*="popup" i]',
                '[role="dialog"]',
            ];

            for (const sel of modalSelectors) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    // Visible aur reasonably sized hai
                    if (rect.width > 100 && rect.height > 100 &&
                        style.display !== 'none' && style.visibility !== 'hidden') {
                        const text = el.innerText?.toLowerCase() || '';
                        if (keywords.some(kw => text.includes(kw))) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }, MODAL_KEYWORDS);

        return hasOverlay;
    } catch (e) {
        return false;
    }
}

module.exports = { closePopupIfExists, detectModalPresence };
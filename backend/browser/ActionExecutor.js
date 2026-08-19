// ActionExecutor.js — Click, type, scroll actions perform karna

const { getPage } = require('./BrowserManager');

// Kisi element pe click karo (element_id se) — data-agent-id se exact match
async function clickElement(elementId) {
    const page = getPage();

    // ✅ FIX: index nahi, attribute value se match karo
    const target = await page.$(`[data-agent-id="${elementId}"]`);

    if (!target) throw new Error(`Element #${elementId} not found (data-agent-id="${elementId}" missing on page)`);

    const isVisible = await target.isVisible();
    if (!isVisible) {
        console.log(`⚠️  Element #${elementId} not visible — scrolling into view`);
    }

    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300); // scroll settle hone do

    await target.click({ timeout: 10000 });
    console.log(`✅ Clicked element #${elementId}`);

    await page.waitForTimeout(1000);
}

// Kisi input mein text type karo
async function typeText(elementId, text) {
    const page = getPage();

    // Stable selectors — common search inputs pehle try karo
    const stableSelectors = [
        'input[name="q"]',
        'input[class*="search"]',
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
        'input[type="text"][placeholder]',
        `[data-agent-id="${elementId}"]`,   // exact ID last mein
    ];

    let typed = false;

    for (const selector of stableSelectors) {
        try {
            const el = await page.$(selector);
            if (!el) continue;

            const visible = await el.isVisible();
            if (!visible) continue;

            await el.click();
            await page.waitForTimeout(200);
            await el.fill(text);

            console.log(`✅ Typed "${text}" using selector: ${selector}`);
            typed = true;
            break;
        } catch (e) {
            continue;
        }
    }

    // Kuch kaam nahi aaya — keyboard fallback
    if (!typed) {
        console.log('⚠️  Selectors failed — keyboard fallback use ho raha hai');
        await page.keyboard.type(text, { delay: 50 });
        console.log(`✅ Typed "${text}" via keyboard`);
    }

    await page.waitForTimeout(500);
}

// Page scroll karo
async function scrollPage(direction = 'down') {
    const page = getPage();
    const amount = direction === 'down' ? 600 : -600;
    await page.evaluate((amt) => window.scrollBy(0, amt), amount);
    console.log(`✅ Scrolled ${direction}`);
    await page.waitForTimeout(800); // DOM settle hone do after scroll
}

// Enter key press karo (form submit ke liye)
async function pressEnter() {
    const page = getPage();
    await page.keyboard.press('Enter');
    console.log(`✅ Pressed Enter`);
    await page.waitForTimeout(1500); // page load hone do
}

module.exports = { clickElement, typeText, scrollPage, pressEnter };
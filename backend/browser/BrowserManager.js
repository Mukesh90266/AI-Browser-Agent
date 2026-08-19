// BrowserManager.js — Manages Playwright browser instances, contexts, and pages

const { chromium } = require("playwright");

let browser = null;
let page = null;

async function launchBrowser() {
    browser = await chromium.launch({
        headless: false,
        slowMo: 100,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--lang=en-US',
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
    });

    // Automation flags remove karo
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    page = await context.newPage();

    // ✅ Yahan lagao — page banne KE BAAD
    page.on('dialog', async dialog => {
        await dialog.dismiss();
    });

    console.log('Browser launched successfully');
    return page;
}

async function navigateTo(url) {
    if (!page) throw new Error("Browser is not initialized");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.log(`✅ Navigated to: ${url}`);

    // Page settle hone do
    await page.waitForTimeout(1500);

    // Popup auto-close karo
    const { closePopupIfExists } = require('./PopupHandler');
    await closePopupIfExists();
}

async function closeBrowser() {
    if (browser) {
        await browser.close();
        browser = null;
        page = null;
        console.log('✅ Browser closed');
    }
}

function getPage() {
    return page;
}

module.exports = { launchBrowser, navigateTo, closeBrowser, getPage };
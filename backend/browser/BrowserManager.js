// BrowserManager.js — Manages Playwright browser instances, contexts, and pages

const { chromium } = require('playwright');
const { closePopupIfExists } = require('./PopupHandler');
const { DEFAULT_CONFIG } = require('../utils/constants');
const logger = require('../utils/logger');

let browser = null;
let context = null;
let page = null;

async function launchBrowser(options = {}) {
    if (browser && page) {
        return page;
    }

    const isHeadless = options.headless !== undefined
        ? options.headless
        : (process.env.HEADLESS === 'true');

    logger.info(`Launching Chromium (headless: ${isHeadless})...`);

    browser = await chromium.launch({
        headless: isHeadless,
        slowMo: options.slowMo ?? (isHeadless ? 0 : 80),
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--lang=en-US',
        ],
    });

    context = await browser.newContext({
        userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: options.viewport || { width: 1280, height: 720 },
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
    });

    // Remove automation detection flags
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    });

    page = await context.newPage();

    // Auto-dismiss unexpected alert/confirm dialogs
    page.on('dialog', async (dialog) => {
        try {
            logger.info(`Dialog popped up: [${dialog.type()}] "${dialog.message()}" — dismissing`);
            await dialog.dismiss();
        } catch (e) {
            // Ignore error if dialog already handled
        }
    });

    logger.success('Browser launched successfully');
    return page;
}

async function navigateTo(url, options = {}) {
    if (!page) {
        await launchBrowser();
    }

    const timeout = options.timeout || DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS;
    logger.info(`Navigating to: ${url}`);

    try {
        await page.goto(url, {
            waitUntil: options.waitUntil || 'domcontentloaded',
            timeout,
        });
    } catch (navErr) {
        logger.warn(`Navigation warning for ${url}: ${navErr.message}`);
    }

    // Give dynamic JS elements time to settle
    await page.waitForTimeout(options.settleTime || 1200);

    // Auto-close popups/cookie banners if any appear
    await closePopupIfExists(page);

    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    logger.success(`Loaded: "${title}" (${currentUrl})`);

    return { url: currentUrl, title };
}

async function goBack() {
    if (!page) throw new Error('Browser is not initialized');
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1000);
    await closePopupIfExists(page);
}

async function closeBrowser() {
    if (browser) {
        try {
            await browser.close();
        } catch (e) {
            // Ignore error during shutdown
        }
        browser = null;
        context = null;
        page = null;
        logger.success('Browser closed');
    }
}

function getPage() {
    return page;
}

function getBrowser() {
    return browser;
}

function isBrowserOpen() {
    return browser !== null && page !== null;
}

async function getCurrentUrl() {
    return page ? page.url() : 'about:blank';
}

async function getPageTitle() {
    return page ? await page.title().catch(() => '') : '';
}

module.exports = {
    launchBrowser,
    navigateTo,
    goBack,
    closeBrowser,
    getPage,
    getBrowser,
    isBrowserOpen,
    getCurrentUrl,
    getPageTitle,
};

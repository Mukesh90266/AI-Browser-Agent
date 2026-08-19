// BrowserManager.js — Manages Playwright browser instances, contexts, and pages with anti-bot fallback, multi-tab safety, and persistent login profiles

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { closePopupIfExists } = require('./PopupHandler');
const { DEFAULT_CONFIG, BOT_BLOCK_INDICATORS } = require('../utils/constants');
const logger = require('../utils/logger');

let browser = null;
let context = null;
let page = null;
let activeUserGoal = '';
let hasSwitchedToBing = false;

function setActiveUserGoal(goal) {
    activeUserGoal = goal || '';
    hasSwitchedToBing = false;
}

function isEncryptedToken(str) {
    if (!str || typeof str !== 'string') return false;
    return str.startsWith('Eg') || (!str.includes(' ') && str.length > 35);
}

function extractCleanSearchQuery(urlStr, fallbackGoal = '') {
    try {
        const parsed = new URL(urlStr);

        // Check continue parameter (Google sorry page)
        const continueParam = parsed.searchParams.get('continue');
        if (continueParam) {
            try {
                const continueParsed = new URL(continueParam);
                const queryInContinue = continueParsed.searchParams.get('q') || continueParsed.searchParams.get('query');
                if (queryInContinue && queryInContinue.length > 1 && !isEncryptedToken(queryInContinue)) {
                    return queryInContinue;
                }
            } catch {}
        }

        const directQ = parsed.searchParams.get('q') || parsed.searchParams.get('query');
        if (directQ && directQ.length > 1 && !isEncryptedToken(directQ)) {
            return directQ;
        }
    } catch {}

    // Fallback: derive clean query from active user goal
    const goalToUse = fallbackGoal || activeUserGoal;
    if (goalToUse) {
        return goalToUse
            .replace(/^(search\s+google\s+for|search\s+bing\s+for|search\s+for|search|find|lookup|look up|get|check|tell me|show me)\s+(the\s+)?/i, '')
            .replace(/["']/g, '')
            .replace(/\s+(and\s+tell\s+me.*|and\s+show\s+me.*)$/i, '')
            .trim();
    }

    return '';
}

/**
 * Detects if Google or any site presented a bot block / Captcha and falls back to Bing.
 */
async function checkAndHandleBotBlock(targetPage = null, customGoal = null) {
    const p = getPage(targetPage);
    if (!p || p.isClosed()) return false;

    try {
        const url = p.url().toLowerCase();

        // If we are already on Bing and not on a genuine captcha page, do not trigger fallback!
        if (url.includes('bing.com') && !url.includes('captcha')) {
            return false;
        }

        // 1. Check URL indicators (Google sorry, px/captcha, recaptcha, turnstile, etc.)
        const isBlockedUrl = url.includes('google.com/sorry') ||
                             url.includes('px/captcha') ||
                             url.includes('captcha-delivery') ||
                             url.includes('challenges.cloudflare.com');

        // 2. Check DOM / page content indicators strictly on Google or blocked domains
        let isBlockedContent = false;
        if (!isBlockedUrl && (url.includes('google.com') || url.includes('skyscanner'))) {
            isBlockedContent = await p.evaluate(() => {
                const text = (document.body?.innerText || '').toLowerCase();
                const hasBlockedText = text.includes('unusual traffic from your computer') ||
                                       text.includes('please show you\'re not a robot') ||
                                       text.includes('verify you are human');

                const hasCaptchaIframe = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, #recaptcha');

                return hasBlockedText || (hasCaptchaIframe && text.length < 400);
            }).catch(() => false);
        }

        if (isBlockedUrl || isBlockedContent) {
            const blockedOnUrl = p.url();
            const cleanQuery = extractCleanSearchQuery(blockedOnUrl, customGoal || activeUserGoal);

            logger.warn(`Bot detection / Captcha detected on ${blockedOnUrl.slice(0, 75)}...`);
            logger.info(`Auto-switching to Bing fallback with query: "${cleanQuery}"`);

            hasSwitchedToBing = true;
            const fallbackUrl = cleanQuery
                ? `https://www.bing.com/search?q=${encodeURIComponent(cleanQuery)}`
                : DEFAULT_CONFIG.FALLBACK_SEARCH_ENGINE;

            await p.goto(fallbackUrl, {
                waitUntil: 'domcontentloaded',
                timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS,
            });

            await p.waitForTimeout(1200);
            await closePopupIfExists(p);
            return true;
        }

        return false;
    } catch (err) {
        logger.debug(`Bot check error: ${err.message}`);
        return false;
    }
}

async function launchBrowser(options = {}) {
    if (browser && page && !page.isClosed()) {
        return page;
    }

    const isHeadless = options.headless !== undefined
        ? options.headless
        : (process.env.HEADLESS === 'true');

    const usePersistentProfile = process.env.PERSISTENT_PROFILE === 'true' || !!process.env.USER_DATA_DIR;
    const useRealChrome = process.env.USE_REAL_CHROME === 'true';

    const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--lang=en-US',
    ];

    const contextConfig = {
        userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: options.viewport || { width: 1280, height: 720 },
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
    };

    if (usePersistentProfile) {
        // Persistent Profile: retains logins, Google account sessions & cookies across runs
        const userDataDir = process.env.USER_DATA_DIR
            ? path.resolve(process.env.USER_DATA_DIR)
            : path.join(process.cwd(), 'user_data');

        if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
        }

        logger.info(`Launching with Persistent Profile from: ${userDataDir} (Real Chrome: ${useRealChrome})`);

        context = await chromium.launchPersistentContext(userDataDir, {
            headless: isHeadless,
            slowMo: options.slowMo ?? (isHeadless ? 0 : 80),
            channel: useRealChrome ? 'chrome' : undefined,
            args: launchArgs,
            ...contextConfig,
        });

        // Anti-bot stealth init
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        const pages = context.pages().filter(p => !p.isClosed());
        page = pages.length > 0 ? pages[0] : await context.newPage();

    } else {
        // Standard ephemeral profile
        logger.info(`Launching Chromium (headless: ${isHeadless})...`);

        browser = await chromium.launch({
            headless: isHeadless,
            slowMo: options.slowMo ?? (isHeadless ? 0 : 80),
            channel: useRealChrome ? 'chrome' : undefined,
            args: launchArgs,
        });

        context = await browser.newContext(contextConfig);

        // Anti-bot stealth init
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        });

        page = await context.newPage();
    }

    // Auto-detect newly opened tabs (target="_blank" clicks)
    context.on('page', async (newPage) => {
        try {
            await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            page = newPage;
            logger.info(`📄 [Switched active tab]: ${newPage.url()}`);
        } catch (e) {}
    });

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
    let p = getPage();
    if (!p || p.isClosed()) {
        p = await launchBrowser();
    }

    const timeout = options.timeout || DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS;
    logger.info(`Navigating to: ${url}`);

    try {
        await p.goto(url, {
            waitUntil: options.waitUntil || 'domcontentloaded',
            timeout,
        });
    } catch (navErr) {
        logger.warn(`Navigation warning for ${url}: ${navErr.message}`);
    }

    await p.waitForTimeout(options.settleTime || 1200);
    await closePopupIfExists(p);
    await checkAndHandleBotBlock(p, activeUserGoal);

    const currentUrl = p.url();
    const title = await p.title().catch(() => '');
    logger.success(`Loaded: "${title}" (${currentUrl})`);

    return { url: currentUrl, title };
}

async function goBack() {
    const p = getPage();
    if (!p) throw new Error('Browser is not initialized');
    await p.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1000);
    await closePopupIfExists(p);
}

async function closeBrowser() {
    if (context) {
        try {
            await context.close();
        } catch (e) {}
        context = null;
        page = null;
    }
    if (browser) {
        try {
            await browser.close();
        } catch (e) {}
        browser = null;
        page = null;
    }
    logger.success('Browser closed');
}

function getPage(customPage = null) {
    if (customPage && !customPage.isClosed()) {
        page = customPage;
        return page;
    }

    if (page && !page.isClosed()) {
        return page;
    }

    if (context) {
        const pages = context.pages().filter(p => !p.isClosed());
        if (pages.length > 0) {
            page = pages.find(p => p.url() !== 'about:blank') || pages[pages.length - 1];
            return page;
        }
    }

    return page;
}

function getBrowser() {
    return browser;
}

function isBrowserOpen() {
    return (browser !== null || context !== null) && page !== null && !page.isClosed();
}

async function getCurrentUrl() {
    const p = getPage();
    return p && !p.isClosed() ? p.url() : 'about:blank';
}

async function getPageTitle() {
    const p = getPage();
    return p && !p.isClosed() ? await p.title().catch(() => '') : '';
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
    checkAndHandleBotBlock,
    setActiveUserGoal,
    extractCleanSearchQuery,
};

// BrowserManager.js — Manages Playwright browser instances, contexts, and pages with anti-bot fallback

const { chromium } = require('playwright');
const { closePopupIfExists } = require('./PopupHandler');
const { DEFAULT_CONFIG, BOT_BLOCK_INDICATORS } = require('../utils/constants');
const logger = require('../utils/logger');

let browser = null;
let context = null;
let page = null;
let activeUserGoal = '';

function setActiveUserGoal(goal) {
    activeUserGoal = goal || '';
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
            .replace(/^(find|search for|search|lookup|look up|get|check|tell me|show me)\s+(the\s+)?/i, '')
            .trim();
    }

    return '';
}

/**
 * Detects if Google, Skyscanner, Cloudflare, or any site presented a bot block / Captcha and falls back to Bing.
 */
async function checkAndHandleBotBlock(targetPage = null, customGoal = null) {
    const p = targetPage || page;
    if (!p) return false;

    try {
        const url = p.url().toLowerCase();

        // 1. Check URL indicators (Google sorry, px/captcha, recaptcha, turnstile, etc.)
        const isBlockedUrl = BOT_BLOCK_INDICATORS.some(ind => url.includes(ind.toLowerCase()));

        // 2. Check DOM / page content indicators (checkboxes, iframes, error headers)
        let isBlockedContent = false;
        if (!isBlockedUrl) {
            isBlockedContent = await p.evaluate(() => {
                const text = (document.body?.innerText || '').toLowerCase();
                const suspiciousPhrases = [
                    'unusual traffic from your computer',
                    'please show you\'re not a robot',
                    'verify you are human',
                    'press and hold',
                    'press & hold',
                    'checking your browser',
                    'security check',
                    'robot check',
                    'human verification',
                ];

                const hasBlockedText = suspiciousPhrases.some(phrase => text.includes(phrase));
                const hasCaptchaIframe = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="cloudflare"], .g-recaptcha, #recaptcha, [class*="captcha" i]');

                return hasBlockedText || (hasCaptchaIframe && text.length < 500);
            });
        }

        if (isBlockedUrl || isBlockedContent) {
            const blockedOnUrl = p.url();
            const cleanQuery = extractCleanSearchQuery(blockedOnUrl, customGoal || activeUserGoal);

            logger.warn(`Bot detection / Captcha detected on ${blockedOnUrl.slice(0, 80)}...`);
            logger.info(`Auto-switching to Bing fallback with query: "${cleanQuery}"`);

            const fallbackUrl = cleanQuery
                ? `https://www.bing.com/search?q=${encodeURIComponent(cleanQuery)}`
                : DEFAULT_CONFIG.FALLBACK_SEARCH_ENGINE;

            await p.goto(fallbackUrl, {
                waitUntil: 'domcontentloaded',
                timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS,
            });

            await p.waitForTimeout(1500);
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

    // Check if Google/Cloudflare/PerimeterX bot block appeared and auto-switch to Bing
    await checkAndHandleBotBlock(page, activeUserGoal);

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
    checkAndHandleBotBlock,
    setActiveUserGoal,
    extractCleanSearchQuery,
};

// BrowserManager.js — Manages Playwright browser instances with Stealth Plugin, Geolocation, and multi-tab safety

const path = require('path');
const fs = require('fs');
const { closePopupIfExists, handleLocationModalIfPresent } = require('./PopupHandler');
const { DEFAULT_CONFIG, BOT_BLOCK_INDICATORS } = require('../utils/constants');
const logger = require('../utils/logger');

// Initialize Chromium with Stealth Plugin
let chromium;
try {
    const { chromium: extraChromium } = require('playwright-extra');
    const stealthPlugin = require('puppeteer-extra-plugin-stealth');
    extraChromium.use(stealthPlugin());
    chromium = extraChromium;
    logger.debug('Stealth plugin initialized for anti-bot protection');
} catch (e) {
    const { chromium: standardChromium } = require('playwright');
    chromium = standardChromium;
}

let browser = null;
let context = null;
let page = null;
let connectedOverCdp = false;
let activeUserGoal = '';
let lastNavigationError = null;

function setActiveUserGoal(goal) {
    activeUserGoal = goal || '';
    lastNavigationError = null;
}

function getLastNavigationError() {
    return lastNavigationError;
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
            .replace(/\s+(and\s+tell\s+me.*|and\s+show\s+me.*|and\s+add.*)$/i, '')
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

        // If on target stores, do not trigger search engine fallback!
        if (url.includes('zepto.com') || url.includes('blinkit.com') || url.includes('amazon.') || url.includes('flipkart.com') || url.includes('github.com') || url.includes('react.dev') || url.includes('nodejs.org')) {
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

// Shared stealth + geolocation init script, used by both local launch and the
// CDP/Docker path so anti-bot behavior is identical in every mode.
function initStealthScript(ctx) {
    return ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

        // Mock real Indian Geolocation Coordinates (Mohali/Chandigarh region)
        const mockCoords = {
            latitude: 30.6677,
            longitude: 76.7407,
            accuracy: 10,
            altitude: null,
            altitudeAccuracy: null,
            heading: null,
            speed: null,
        };
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition = function (success) {
                success({ coords: mockCoords, timestamp: Date.now() });
            };
            navigator.geolocation.watchPosition = function (success) {
                success({ coords: mockCoords, timestamp: Date.now() });
                return 1;
            };
        }

        // Pre-seed location in localStorage for Zepto & quick-commerce
        try {
            const defaultAddress = {
                city: 'Mohali',
                pincode: '140308',
                address: 'Sector 82 JLPL Industrial Area, Mohali, Punjab',
                lat: 30.6677,
                lng: 76.7407,
                latitude: 30.6677,
                longitude: 76.7407,
            };
            localStorage.setItem('user_address', JSON.stringify(defaultAddress));
            localStorage.setItem('user_location', JSON.stringify(defaultAddress));
            localStorage.setItem('has_selected_location', 'true');
            localStorage.setItem('location_selected', 'true');
            localStorage.setItem('isLocationSelected', 'true');
        } catch (e) {}
    });
}

function wireContextEvents(ctx) {
    if (!ctx) return;

    // Auto-detect newly opened tabs (target="_blank" clicks)
    ctx.on('page', async (newPage) => {
        try {
            await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            page = newPage;
            // Raise the new tab in the window manager so noVNC shows what the
            // agent is actually controlling (otherwise the old tab stays on top).
            await newPage.bringToFront().catch(() => {});
            logger.info(`📄 [Switched active tab]: ${newPage.url()}`);
        } catch (e) {}
    });

    // Auto-dismiss unexpected alert/confirm dialogs
    const pages = ctx.pages ? ctx.pages() : [];
    pages.forEach((p) => wirePageDialogs(p));
    ctx.on('page', (newPage) => wirePageDialogs(newPage));
}

function wirePageDialogs(p) {
    if (!p || p.__agentDialogsWired) return;
    p.__agentDialogsWired = true;
    p.on('dialog', async (dialog) => {
        try {
            logger.info(`Dialog popped up: [${dialog.type()}] "${dialog.message()}" — dismissing`);
            await dialog.dismiss();
        } catch (e) {}
    });
}

/**
 * Resets the CDP/Docker browser to a single clean about:blank tab so a new task
 * starts on a fresh screen instead of showing the previous task's page. Closes
 * any extra tabs/windows left behind by target="_blank" / ov_redirect / popups
 * across ALL browser contexts and brings the remaining tab to the front (this
 * is what noVNC displays).
 */
async function resetBrowserState() {
    if (!browser) return;
    try {
        const allContexts = (browser.contexts && browser.contexts()) || (context ? [context] : []);
        let keeper = null;
        for (const ctx of allContexts) {
            const pages = (ctx.pages ? ctx.pages() : []).filter(p => !p.isClosed());
            for (const p of pages) {
                if (!keeper) { keeper = p; continue; }
                await p.close().catch(() => {});
            }
        }
        if (!keeper && context) {
            keeper = await context.newPage().catch(() => null);
        }
        if (keeper) {
            await keeper.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
            await keeper.bringToFront().catch(() => {});
            page = keeper;
        }
    } catch (e) {
        logger.debug(`Could not fully reset browser state: ${e.message}`);
    }
}

async function launchBrowser(options = {}) {
    if (browser && page && !page.isClosed()) {
        return page;
    }

    const isHeadless = options.headless !== undefined
        ? options.headless
        : (process.env.HEADLESS === 'true');

    // --- Docker/noVNC mode: attach Playwright to the Chromium running inside
    //     the browser-vnc container over Chrome DevTools Protocol. This path
    //     is ONLY taken when BROWSER_CDP_URL is set; the normal local launch
    //     behavior below is completely unchanged otherwise.
    if (process.env.BROWSER_CDP_URL) {
        logger.info(`Connecting to existing Chromium over CDP: ${process.env.BROWSER_CDP_URL}`);
        try {
            browser = await chromium.connectOverCDP(process.env.BROWSER_CDP_URL);
            connectedOverCdp = true;

            // Reuse the browser's existing default context (the one whose
            // window noVNC displays). Creating a new context here would open a
            // separate window that is not visible in the VNC view.
            context = browser.contexts()[0] || await browser.newContext();
            await initStealthScript(context);
            // Grant geolocation on the shared context.
            try {
                await context.grantPermissions(['geolocation']);
                await context.setGeolocation({ latitude: 30.6677, longitude: 76.7407, accuracy: 10 });
            } catch (e) {
                logger.debug(`Could not set geolocation over CDP: ${e.message}`);
            }

            const pages = context.pages().filter(p => !p.isClosed());
            page = pages.length > 0 ? pages[0] : await context.newPage();
            wireContextEvents(context);
            wirePageDialogs(page);

            // Start every task on a single clean about:blank tab so the
            // previous task's screen does not linger in the noVNC view.
            await resetBrowserState();

            logger.success('Connected to CDP Chromium (visible through noVNC)');
            return page;
        } catch (cdpErr) {
            logger.warn(`CDP connect failed (${cdpErr.message}); falling back to local launch`);
            browser = null;
            context = null;
            connectedOverCdp = false;
        }
    }

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

    // Enable Geolocation for Indian quick-commerce apps
    const contextConfig = {
        userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: options.viewport || { width: 1280, height: 720 },
        locale: 'en-US',
        timezoneId: 'Asia/Kolkata',
        permissions: ['geolocation'],
        geolocation: { latitude: 30.6677, longitude: 76.7407 },
    };

    if (usePersistentProfile) {
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

        await initStealthScript(context);

        const pages = context.pages().filter(p => !p.isClosed());
        page = pages.length > 0 ? pages[0] : await context.newPage();

    } else {
        logger.info(`Launching Chromium with Stealth (headless: ${isHeadless})...`);

        browser = await chromium.launch({
            headless: isHeadless,
            slowMo: options.slowMo ?? (isHeadless ? 0 : 80),
            channel: useRealChrome ? 'chrome' : undefined,
            args: launchArgs,
        });

        context = await browser.newContext(contextConfig);
        await initStealthScript(context);

        page = await context.newPage();
    }

    wireContextEvents(context);
    wirePageDialogs(page);

    logger.success('Browser launched successfully (Stealth + Geolocation Active)');
    return page;
}

async function navigateTo(url, options = {}) {
    let p = getPage();
    if (!p || p.isClosed()) {
        p = await launchBrowser();
    }

    const timeout = options.timeout || DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS;
    logger.info(`Navigating to: ${url}`);
    lastNavigationError = null;

    try {
        await p.goto(url, {
            waitUntil: options.waitUntil || 'domcontentloaded',
            timeout,
        });
    } catch (navErr) {
        lastNavigationError = navErr.message;
        logger.warn(`Navigation error for ${url}: ${navErr.message}`);

        // If domain failed to resolve or load (e.g. https://example.invalid), inject error into page DOM for LLM awareness
        if (p && !p.isClosed()) {
            await p.evaluate(({ failedUrl, errMsg }) => {
                document.title = 'Page Load Failed';
                document.body.innerHTML = `
                    <div style="font-family:sans-serif; padding:40px; text-align:center;">
                        <h1>Page Failed to Load</h1>
                        <p><strong>URL:</strong> ${failedUrl}</p>
                        <p><strong>Error:</strong> ${errMsg}</p>
                    </div>
                `;
            }, { failedUrl: url, errMsg: navErr.message }).catch(() => {});
        }
    }

    await p.waitForTimeout(options.settleTime || 1200);
    await closePopupIfExists(p);
    await checkAndHandleBotBlock(p, activeUserGoal);

    const currentUrl = p.url();
    const title = await p.title().catch(() => '');
    logger.success(`Loaded: "${title}" (${currentUrl})`);

    return { url: currentUrl, title, error: lastNavigationError };
}

async function goBack() {
    const p = getPage();
    if (!p) throw new Error('Browser is not initialized');
    await p.goBack({ waitUntil: 'domcontentloaded', timeout: DEFAULT_CONFIG.NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(1000);
    await closePopupIfExists(p);
}

async function closeBrowser() {
    // When attached to the Docker/noVNC Chromium over CDP we must NOT kill the
    // shared browser — only detach. Reset it to about:blank for the next task.
    if (connectedOverCdp) {
        try {
            // Clear tabs/history for the next task before disconnecting.
            await resetBrowserState();
        } catch (e) {}
        try { await browser?.close(); } catch (e) {} // disconnects CDP, leaves Chrome running
        browser = null;
        context = null;
        page = null;
        connectedOverCdp = false;
        logger.info('Disconnected from CDP Chromium (container browser kept running)');
        return;
    }

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
    getLastNavigationError,
    resetBrowserState,
};

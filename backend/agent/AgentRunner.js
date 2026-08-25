// AgentRunner.js — Core autonomous controller implementing Task 18 (LLM Decision Loop) and Task 19 (Goal Completion & Safety)

const {
    launchBrowser,
    navigateTo,
    closeBrowser,
    getPage,
    getCurrentUrl,
    getPageTitle,
    checkAndHandleBotBlock,
    setActiveUserGoal,
    getLastNavigationError,
} = require('../browser/BrowserManager');

const { extractDOM } = require('../browser/DOMExtractor');
const { executeAction } = require('../browser/ActionExecutor');
const { closePopupIfExists, handleLocationModalIfPresent } = require('../browser/PopupHandler');
const { takeScreenshot } = require('../browser/ScreenshotHelper');
const { inspectCartState } = require('../browser/CartInspector');
const { getNextAction } = require('../llm/LLMClient');
const { parseAction } = require('../llm/ActionParser');
const { validateGoal } = require('../utils/validators');
const { DEFAULT_CONFIG, ACTION_TYPES, AGENT_STATUS } = require('../utils/constants');
const logger = require('../utils/logger');
const StateManager = require('./StateManager');
const LoopDetector = require('./LoopDetector');
const MessageManager = require('./MessageManager');

// Builds a short, human-readable description of an action for the UI log.
function describeAction(action, elements = []) {
    if (!action) return '';
    const el = action.element_id !== undefined
        ? elements.find(e => e.id === action.element_id)
        : null;
    const target = el ? (el.context || el.text || el.placeholder || el.type || 'element').slice(0, 80) : '';
    switch (action.action) {
        case ACTION_TYPES.CLICK:
            return `Clicked ${target ? `"${target}"` : 'an element'}`;
        case ACTION_TYPES.TYPE:
            return `Typed "${action.text || ''}"${target ? ` in "${target}"` : ''}`;
        case ACTION_TYPES.SCROLL:
            return `Scrolled ${action.direction || 'down'}`;
        case ACTION_TYPES.NAVIGATE:
            return `Navigated to ${action.url || ''}`;
        case ACTION_TYPES.ADD_TO_CART:
            return `Adding to cart${target ? `: "${target}"` : ''}`;
        case ACTION_TYPES.SELECT:
            return `Selected "${action.value || ''}"`;
        case ACTION_TYPES.ENTER:
            return 'Pressed Enter';
        case ACTION_TYPES.GO_BACK:
            return 'Navigated back';
        case ACTION_TYPES.WAIT:
            return `Waited ${action.seconds || 2}s`;
        default:
            return `${action.action}${target ? ` on "${target}"` : ''}`;
    }
}

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const QUANTITY_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
};

function parseQuantityToken(token) {
    if (!token) return null;
    const numeric = Number(token);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    return QUANTITY_WORDS[token.toLowerCase()] || null;
}

function getRequestedCartQuantity(goal) {
    if (!goal) return 1;
    const quantityWords = Object.keys(QUANTITY_WORDS).join('|');
    const tokenPattern = `(\\d+|${quantityWords})`;
    const patterns = [
        new RegExp(`\\b(?:quantity|qty)\\s*(?:of|:|=)?\\s*${tokenPattern}\\b`, 'i'),
        new RegExp(`\\badd\\s+${tokenPattern}\\s+(?!different\\b).{1,80}?\\s+(?:to|into|in)\\s+(?:the\\s+)?(?:cart|bag|basket)\\b`, 'i'),
        new RegExp(`\\b${tokenPattern}\\s*[x×]\\b`, 'i'),
    ];

    for (const pattern of patterns) {
        const match = goal.match(pattern);
        const quantity = parseQuantityToken(match?.[1]);
        if (quantity) return Math.min(quantity, 20);
    }
    return 1;
}

function getRequestedCartAdditionCount(goal) {
    if (!goal || !/(?:add(?:ing)?(?:\s+\w+){0,8}\s+(?:to|into|in)\s+(?:the\s+)?(?:cart|bag|basket))|(?:add to cart|add to bag)/i.test(goal)) {
        return 0;
    }

    if (/\b(all|each|multiple|several)\b/i.test(goal)) return Infinity;
    if (/\bboth\b/i.test(goal)) return 2;

    const distinctMatch = goal.match(/\b(\d+|one|two|three|four|five)\s+different\s+(?:items?|products?)\b/i);
    return parseQuantityToken(distinctMatch?.[1]) || 1;
}

function getRequestedDistinctProducts(goal) {
    const requestedCount = getRequestedCartAdditionCount(goal);
    if (!Number.isFinite(requestedCount) || requestedCount < 2) return [];
    if (!/\bdifferent\s+(?:items?|products?)\b/i.test(goal)) return [];

    const storeNames = 'blinkit|zepto|amazon|flipkart|myntra|zomato|swiggy';
    const productSection = (goal || '').match(
        new RegExp(`^\\s*(?:find|search(?:\\s+for)?|get|show\\s+me)\\s+(.+?)\\s+(?:on|from|in)\\s+(?:the\\s+)?(?:${storeNames})\\b`, 'i'),
    )?.[1];
    if (!productSection) return [];

    const products = productSection
        .replace(/\s*,\s*(?:and\s+)?/gi, '|')
        .replace(/\s+and\s+/gi, '|')
        .split('|')
        .map(product => product.replace(/^(?:the|a|an)\s+/i, '').trim())
        .filter(Boolean);

    return products.length >= requestedCount ? products.slice(0, requestedCount) : [];
}

function normalizeProductTokens(value) {
    const stopWords = new Set([
        'a', 'an', 'the', 'for', 'of', 'with', 'and', 'on', 'in', 'to',
        'men', 'mens', 'women', 'womens', 'unisex', 'kids', 'kid',
    ]);

    // Collapse known compound words BEFORE tokenizing so that "t-shirt",
    // "t shirt", "tee" and "tshirt" all normalize to the same token.
    let text = (value || '').toLowerCase().replace(/[’']/g, '');
    text = text.replace(/\bt[\s-]*shirts?\b/g, ' tshirt ');
    text = text.replace(/\btees?\b/g, ' tshirt ');
    text = text.replace(/\bpolo[\s-]*necks?\b/g, ' poloneck ');
    text = text.replace(/\bround[\s-]*necks?\b/g, ' roundneck ');
    text = text.replace(/\bv[\s-]*necks?\b/g, ' vneck ');
    text = text.replace(/\btrack[\s-]*pants?\b/g, ' trackpant ');
    text = text.replace(/\brunning[\s-]*shoes?\b/g, ' runningshoe ');
    text = text.replace(/\bsneakers?\b/g, ' shoe ');
    text = text.replace(/\btrainers?\b/g, ' shoe ');

    const tokens = text
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(token => token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token)
        .filter(token => !stopWords.has(token));

    const normalized = new Set(tokens);
    if (tokens.some(token => token === 'iphone' || token.endsWith('phone'))) normalized.add('phone');
    if (tokens.some(token => token === 'tshirt')) normalized.add('tee');
    if (tokens.some(token => token === 'shoe' || token.endsWith('shoe'))) {
        normalized.add('shoe');
        normalized.add('sneaker');
    }
    return normalized;
}

// Loose substring search used for short category words (shoe, bag, watch...)
// that can appear inside compounds like "runningshoe" in a product title.
function titleContainsTerm(title, term) {
    if (!term || term.length < 3) return false;
    return title.toLowerCase().includes(term.toLowerCase());
}

function matchesRequestedProduct(productTitle, requestedQuery) {
    const requestedTokens = [...normalizeProductTokens(requestedQuery)];
    const productTokens = normalizeProductTokens(productTitle);
    if (requestedTokens.length === 0) return false;
    // Allow singular/plural variance so "shoes" still matches a title using
    // "shoe" and vice versa. Also allow short category terms (e.g. "shoe"
    // inside "runningshoe") to match via substring.
    return requestedTokens.every(token =>
        productTokens.has(token) ||
        (token.length > 3 && token.endsWith('s') && productTokens.has(token.slice(0, -1))) ||
        (token.length > 3 && productTokens.has(token + 's')) ||
        (token.length >= 4 && titleContainsTerm(productTitle, token))
    );
}

function getStoreNameFromGoal(goal) {
    return (goal || '').match(/\b(blinkit|zepto|amazon|flipkart|myntra|zomato|swiggy)\b/i)?.[1]?.toLowerCase() || '';
}

function buildStoreSearchUrl(goal, query) {
    const store = getStoreNameFromGoal(goal);
    const encoded = encodeURIComponent(query || '');
    if (store === 'blinkit') return `https://blinkit.com/s/?q=${encoded}`;
    if (store === 'zepto') return `https://www.zepto.com/search?q=${encoded}`;
    if (store === 'amazon') return `https://www.amazon.in/s?k=${encoded}`;
    if (store === 'flipkart') return `https://www.flipkart.com/search?q=${encoded}`;
    if (store === 'myntra') return `https://www.myntra.com/${(query || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    return `https://www.bing.com/search?q=${encodeURIComponent(`${query} ${store}`.trim())}`;
}

function getProductIdentity(url, title = '') {
    try {
        const parsed = new URL(url || '');
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname;
        const blinkitId = path.match(/\/prid\/(\d+)/i)?.[1];
        if (blinkitId) return `blinkit:${blinkitId}`;
        const flipkartId = parsed.searchParams.get('pid');
        if (flipkartId) return `flipkart:${flipkartId.toLowerCase()}`;
        const amazonId = path.match(/\/(?:dp|gp\/product)\/([a-z0-9]{8,14})/i)?.[1];
        if (amazonId) return `amazon:${amazonId.toLowerCase()}`;
        const myntraId = path.match(/\/(\d{5,})\/buy\/?$/i)?.[1];
        if (myntraId) return `myntra:${myntraId}`;
        if (/\/(?:product|products|p|pn|prn|itm)\//i.test(path)) {
            return `${host}:${path.toLowerCase().replace(/\/$/, '')}`;
        }
    } catch {}

    const normalizedTitle = [...normalizeProductTokens(title)].sort().join('-');
    return normalizedTitle ? `title:${normalizedTitle}` : '';
}

function isCartIntentAction(action, elements = []) {
    if (action?.action === ACTION_TYPES.ADD_TO_CART) return true;
    if (action?.action !== ACTION_TYPES.CLICK) return false;
    return elements.find(element => element.id === action.element_id)?.isCartAction === true;
}

function getCartActionProductInfo(action, elements, productInfo, currentUrl) {
    const matchedElement = elements.find(element => element.id === action?.element_id);
    const context = (matchedElement?.context || '').replace(/\s+/g, ' ').trim();
    const contextPrice = context.match(/(?:₹|\$|€|£|\b(?:INR|Rs\.?)\s*)\s*[\d,]+(?:\.\d{1,2})?/i)?.[0] || '';
    const contextTitle = contextPrice
        ? context.slice(0, Math.max(context.toLowerCase().indexOf(contextPrice.toLowerCase()), 0)).replace(/[—–-]\s*$/, '').trim()
        : context;
    const title = (productInfo?.title || contextTitle || matchedElement?.productTitle || '').trim();
    const price = (productInfo?.price || contextPrice || '').trim();
    return {
        title,
        price,
        identity: getProductIdentity(currentUrl, title),
    };
}

function recordVerifiedDistinctProduct(plan, addedIdentities, verifiedProduct) {
    const pendingProduct = plan.find(product => product.status === 'pending');
    if (!verifiedProduct?.identity) {
        return {
            success: false,
            error: 'The added product identity could not be verified for a different-products goal.',
        };
    }
    if (addedIdentities.has(verifiedProduct.identity)) {
        return {
            success: false,
            error: `The same product (${verifiedProduct.title || 'unknown'}) cannot count twice toward a different-products goal.`,
        };
    }
    if (!pendingProduct || !matchesRequestedProduct(verifiedProduct.title, pendingProduct.query)) {
        return {
            success: false,
            error: `Added product did not exactly match the pending target ${pendingProduct?.query || 'unknown'}.`,
        };
    }

    pendingProduct.status = 'verified';
    pendingProduct.identity = verifiedProduct.identity;
    pendingProduct.title = verifiedProduct.title;
    pendingProduct.price = verifiedProduct.price || '';
    addedIdentities.add(verifiedProduct.identity);
    return {
        success: true,
        verifiedProduct: pendingProduct,
        completed: plan.every(product => product.status === 'verified'),
        nextPendingProduct: plan.find(product => product.status === 'pending') || null,
    };
}

function getRequestedProductSize(goal) {
    const match = (goal || '').match(/\b(?:size|uk size)\s*(?:is|of|:)?\s*(\d+(?:\.5)?|XS|S|M|L|XL|XXL)\b/i);
    return match?.[1] || null;
}

function getProductPageFastAction(goal, domData) {
    if (getRequestedCartAdditionCount(goal) === 0 || !domData?.isProductDetailsPage) return null;

    const elements = Array.isArray(domData) ? domData : (domData.elements || []);
    const cartElement = elements.find(element => element.isCartAction === true);
    const thought = 'Product page detected; use the direct cart flow now instead of spending more LLM calls searching element chunks';

    return {
        thought,
        action: ACTION_TYPES.ADD_TO_CART,
        element_id: cartElement?.id,
        size: getRequestedProductSize(goal),
        quantity: getRequestedCartQuantity(goal),
        fast_path: true,
    };
}

function getExactProductResultAction(requestedQuery, domData) {
    if (!requestedQuery || domData?.isProductDetailsPage) return null;
    const elements = Array.isArray(domData) ? domData : (domData?.elements || []);
    const candidates = elements.filter((element) => {
        if (!Number.isInteger(element.id) || element.isCartAction || element.isSearch || element.isSize) return false;
        const productText = `${element.context || ''} ${element.text || ''}`.replace(/\s+/g, ' ').trim();
        if (!matchesRequestedProduct(productText, requestedQuery)) return false;
        return element.type === 'a' || element.role === 'link' || !!element.href ||
            /(?:₹|\$|€|£|\b(?:rs\.?|inr)\s*)\s*[\d,]+|\badd\b/i.test(productText);
    }).map((element) => {
        const text = `${element.context || ''} ${element.text || ''}`;
        let score = 0;
        if (/(?:₹|\$|€|£|\b(?:rs\.?|inr)\s*)\s*[\d,]+/i.test(text)) score += 300;
        if (/\badd\b/i.test(text)) score += 200;
        if (element.type === 'a' || element.role === 'link' || element.href) score += 100;
        if (element.context) score += 80;
        return { element, score };
    }).sort((a, b) => b.score - a.score || a.element.id - b.element.id);

    if (!candidates.length) return null;
    return {
        thought: `Open the exact standalone-word match for ${requestedQuery}`,
        action: ACTION_TYPES.CLICK,
        element_id: candidates[0].element.id,
        distinct_product_query: requestedQuery,
        exact_product_match: true,
    };
}

/**
 * Extracts clean search query for a store product search.
 */
function extractProductQueryFromGoal(goal) {
    if (!goal) return '';
    return goal
        .replace(/^(find|search for|search|get|check|tell me the price of|tell me price of|show me)\s+(the\s+)?/i, '')
        .replace(/\s+(on|from|in)\s+(blinkit|zepto|amazon|flipkart|zomato|swiggy|myntra|google|bing).*$/i, '')
        .replace(/\s+(and\s+tell\s+me.*|and\s+show\s+me.*|and\s+add.*|and\s+buy.*)$/i, '')
        .replace(/["']/g, '')
        .trim();
}

/**
 * Derives initial starting URL from user goal dynamically.
 */
function resolveInitialUrl(goal, defaultSearchEngine) {
    if (!goal || typeof goal !== 'string') return defaultSearchEngine;
    const g = goal.toLowerCase();

    // 1. Direct explicit URL in goal (e.g. "Open https://example.invalid...")
    const urlMatch = goal.match(/https?:\/\/[^\s"'<>]+/i);
    if (urlMatch) {
        return urlMatch[0];
    }

    const distinctProducts = getRequestedDistinctProducts(goal);
    const query = distinctProducts[0] || extractProductQueryFromGoal(goal);

    // 2. Direct in-store search navigation
    if (g.includes('blinkit')) {
        return query ? `https://blinkit.com/s/?q=${encodeURIComponent(query)}` : 'https://www.blinkit.com';
    }
    if (g.includes('zepto')) {
        return query ? `https://www.zepto.com/search?q=${encodeURIComponent(query)}` : 'https://www.zepto.com';
    }
    if (g.includes('amazon')) {
        return query ? `https://www.amazon.in/s?k=${encodeURIComponent(query)}` : 'https://www.amazon.in';
    }
    if (g.includes('flipkart')) {
        return query ? `https://www.flipkart.com/search?q=${encodeURIComponent(query)}` : 'https://www.flipkart.com';
    }
    if (g.includes('myntra')) {
        return query ? buildStoreSearchUrl(goal, query) : 'https://www.myntra.com';
    }
    if (g.includes('zomato')) {
        return 'https://www.zomato.com';
    }
    if (g.includes('swiggy')) {
        return 'https://www.swiggy.com';
    }
    if (g.includes('github')) return 'https://github.com';
    if (g.includes('wikipedia')) return 'https://en.wikipedia.org';
    if (g.includes('bing')) return 'https://www.bing.com';
    if (g.includes('google')) return 'https://www.google.com';

    return defaultSearchEngine;
}

class AgentRunner {
    constructor(config = {}) {
        this.config = {
            ...config,
            maxSteps: toPositiveInteger(
                config.maxSteps ?? process.env.MAX_STEPS,
                DEFAULT_CONFIG.MAX_STEPS,
            ),
            chunkSize: toPositiveInteger(config.chunkSize, DEFAULT_CONFIG.CHUNK_SIZE),
            maxChunksPerPage: toPositiveInteger(
                config.maxChunksPerPage,
                DEFAULT_CONFIG.MAX_CHUNKS_PER_PAGE,
            ),
            maxElementsPerPrompt: toPositiveInteger(
                config.maxElementsPerPrompt,
                Math.min(DEFAULT_CONFIG.CHUNK_SIZE * 2, 150),
            ),
            maxActionTokens: toPositiveInteger(
                config.maxActionTokens ?? process.env.MAX_ACTION_TOKENS,
                1024,
            ),
            maxScrollAttempts: toPositiveInteger(
                config.maxScrollAttempts ?? process.env.MAX_SCROLL_ATTEMPTS,
                DEFAULT_CONFIG.MAX_SCROLL_ATTEMPTS,
            ),
            maxRepeatedActions: toPositiveInteger(
                config.maxRepeatedActions ?? process.env.MAX_REPEATED_ACTIONS,
                DEFAULT_CONFIG.MAX_REPEATED_ACTIONS,
            ),
            stepDelayMs: Math.max(0, Number(config.stepDelayMs ?? DEFAULT_CONFIG.STEP_DELAY_MS) || 0),
            defaultSearchEngine: config.defaultSearchEngine || DEFAULT_CONFIG.DEFAULT_SEARCH_ENGINE,
            autoClose: config.autoClose !== undefined ? config.autoClose : false,
            completionWaitMs: Math.max(0, Number(config.completionWaitMs ?? 8000) || 0),
        };

        this.stateManager = new StateManager(this.config.maxSteps);
        this.loopDetector = new LoopDetector({
            repeatedActionThreshold: this.config.maxRepeatedActions,
            maxScrollAttempts: this.config.maxScrollAttempts,
        });
        this.messageManager = new MessageManager();
        this.isAborted = false;
        this.lastCartState = null;
        this.verifiedCartAdditions = 0;
        this.currentProductInfo = null;
        this.distinctProductPlan = [];
        this.addedProductIdentities = new Set();
    }

    /**
     * Stops the running agent execution.
     */
    abort() {
        this.isAborted = true;
        this.stateManager.setStopped('Execution manually aborted by user');
        logger.warn('Agent execution aborted');
        if (typeof this._emit === 'function') {
            this._emit('aborted', { message: 'Execution manually aborted by user' });
        }
    }

    /**
     * Records a loop guard as a terminal step so state and step counts stay accurate.
     */
    stopForLoop({ step, loopCheck, currentUrl, pageTitle, attemptedAction = null }) {
        const failMsg = `Stopped to prevent infinite loop: ${loopCheck.reason}`;
        logger.warn(`Loop detection trigger: ${loopCheck.reason}`, step);

        this.stateManager.setFailed(failMsg);
        this.stateManager.recordStep({
            step,
            action: attemptedAction || {
                action: 'safety_stop',
                reason: loopCheck.type || 'navigation_loop',
            },
            executionResult: { success: false, error: failMsg },
            url: currentUrl,
            title: pageTitle,
        });

        logger.error(failMsg, null, step);
    }

    /**
     * Makes at most one LLM request per agent step. Important controls are moved
     * to the front so the model does not need slow, repeated next_chunk calls.
     */
    async decideActionWithLLM({ goal, domData, actionHistory, step, lastError, currentUrl, pageTitle }) {
        const elements = Array.isArray(domData) ? domData : (domData.elements || []);
        const goalWords = new Set(
            goal.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3),
        );

        const prioritizedElements = elements.map((element, index) => {
            const searchableText = `${element.text || ''} ${element.context || ''} ${element.placeholder || ''}`.toLowerCase();
            const goalMatches = [...goalWords].filter(word => searchableText.includes(word)).length;
            let priority = goalMatches * 25;
            if (element.isCartAction) priority += 1000;
            if (element.isSize) priority += 900;
            if (element.isSearch) priority += 800;
            if (element.type === 'search input') priority += 800;
            else if (element.type === 'input' || element.type === 'textarea' || element.type === 'select') priority += 650;
            else if (element.type === 'button' || element.role === 'button') priority += 500;
            else if (element.type === 'a') priority += 200;
            return { element, index, priority };
        }).sort((a, b) => b.priority - a.priority || a.index - b.index)
            .slice(0, this.config.maxElementsPerPrompt)
            .map(item => item.element);

        const chunkInfo = {
            chunkNumber: 1,
            totalChunks: 1,
            start: 1,
            end: prioritizedElements.length,
            total: elements.length,
        };
        const { systemPrompt, userPrompt } = this.messageManager.preparePrompt({
            goal,
            currentUrl,
            pageTitle,
            pageTextSnippets: domData.pageTextSnippets || [],
            elementsChunk: prioritizedElements,
            actionHistory,
            chunkInfo,
            step,
            maxSteps: this.config.maxSteps,
            lastError,
        });

        const rawResponse = await getNextAction(systemPrompt, userPrompt, {
            model: this.config.model,
            max_completion_tokens: this.config.maxActionTokens,
        });
        const parsedAction = parseAction(rawResponse);

        if (parsedAction.action === ACTION_TYPES.NEXT_CHUNK) {
            logger.warn('LLM requested next_chunk even though prioritized controls were supplied; scrolling instead of making another LLM call', step);
            return {
                thought: 'The prioritized controls were already inspected; scroll once to reveal additional page state instead of repeating chunk requests',
                action: ACTION_TYPES.SCROLL,
                direction: 'down',
            };
        }

        return parsedAction;
    }

    /**
     * Main autonomous execution loop (Task 18 + Task 19).
     */
    async run(goal, options = {}) {
        const validatedGoal = validateGoal(goal);
        this.isAborted = false;
        this.stateManager.start(validatedGoal, this.config.maxSteps);
        this.loopDetector.reset();
        this.lastCartState = null;
        this.verifiedCartAdditions = 0;
        this.currentProductInfo = null;
        this.distinctProductPlan = getRequestedDistinctProducts(validatedGoal).map(query => ({
            query,
            status: 'pending',
            identity: '',
            title: '',
            price: '',
        }));
        this.addedProductIdentities = new Set();
        setActiveUserGoal(validatedGoal);

        logger.info(`Starting Agent with Goal: "${validatedGoal}"`);
        logger.info(`Max Steps Safety Limit: ${this.config.maxSteps}`);

        // Optional event sink used by the web UI (server.js). The CLI never
        // passes this, so behavior is otherwise identical.
        const emit = (type, payload = {}) => {
            try {
                if (typeof options.onEvent === 'function') {
                    options.onEvent({ type, ts: Date.now(), ...payload });
                }
            } catch (e) {
                logger.debug(`onEvent handler error: ${e.message}`);
            }
        };
        this._emit = emit;

        emit('run_started', { goal: validatedGoal, maxSteps: this.config.maxSteps });

        let lastError = null;

        try {
            // Step 0: Launch browser
            await launchBrowser({
                headless: options.headless,
                slowMo: options.slowMo,
            });

            const initialUrl = options.initialUrl || resolveInitialUrl(validatedGoal, this.config.defaultSearchEngine);
            logger.info(`Starting execution at URL: ${initialUrl}`);
            await navigateTo(initialUrl);

            await handleLocationModalIfPresent(getPage());
            await closePopupIfExists();
            await checkAndHandleBotBlock(null, validatedGoal);
            this.lastCartState = await inspectCartState(getPage());

            // Main 4-Phase Autonomous Execution Loop
            for (let step = 1; step <= this.config.maxSteps; step++) {
                if (this.isAborted) break;

                // Check for bot detection & fallback to Bing with clean query
                await checkAndHandleBotBlock(null, validatedGoal);

                // Auto-handle location modals or popups on page before observing DOM
                await handleLocationModalIfPresent(getPage());
                await closePopupIfExists(getPage());

                const currentUrl = await getCurrentUrl();
                const pageTitle = await getPageTitle();

                logger.step(step, this.config.maxSteps, `Active URL: ${currentUrl}`);
                emit('step', { step, maxSteps: this.config.maxSteps, url: currentUrl, title: pageTitle });

                // Detect repeated A/B/A/B navigation before spending another LLM call.
                const urlLoopCheck = this.loopDetector.checkUrlLoop(currentUrl);
                if (urlLoopCheck.isLoop) {
                    this.stopForLoop({
                        step,
                        loopCheck: urlLoopCheck,
                        currentUrl,
                        pageTitle,
                    });
                    break;
                }

                // ─── PHASE 1: PERCEPTION (DOM & State Observation) ───
                let domData;
                try {
                    domData = await extractDOM();
                } catch (domErr) {
                    logger.error('DOM extraction error, attempting page recovery', domErr, step);
                    await navigateTo(currentUrl).catch(() => {});
                    domData = await extractDOM();
                }

                // If navigation had a hard failure (e.g. https://example.invalid), add it to text snippets
                const navErr = getLastNavigationError();
                if (navErr && domData.pageTextSnippets) {
                    domData.pageTextSnippets.unshift(`[PAGE ERROR] Navigation failed: ${navErr}`);
                }

                // Show live data extracted from the page to the user
                if (domData.pageTextSnippets && domData.pageTextSnippets.length > 0) {
                    logger.pageData(domData.pageTextSnippets, currentUrl, step);
                }
                if (domData.isProductDetailsPage && (domData.productInfo?.title || domData.productInfo?.price)) {
                    this.currentProductInfo = domData.productInfo;
                } else if (!domData.isProductDetailsPage) {
                    this.currentProductInfo = null;
                }

                // ─── PHASE 2: REASONING & DECISION (Task 18) ─────────
                let nextAction;
                try {
                    const previousStep = this.stateManager.history.at(-1);
                    const fastCartAlreadyFailed = previousStep?.action?.action === ACTION_TYPES.ADD_TO_CART && previousStep.success === false;
                    const activeDistinctTarget = this.distinctProductPlan.find(product => product.status === 'pending');
                    let fastAction = null;

                    if (activeDistinctTarget && domData.isProductDetailsPage && this.currentProductInfo?.title) {
                        const currentIdentity = getProductIdentity(currentUrl, this.currentProductInfo.title);
                        const titleMatches = matchesRequestedProduct(
                            this.currentProductInfo.title,
                            activeDistinctTarget.query,
                        );
                        if (titleMatches && !this.addedProductIdentities.has(currentIdentity) && !fastCartAlreadyFailed) {
                            fastAction = {
                                ...getProductPageFastAction(validatedGoal, domData),
                                quantity: 1,
                                distinct_product_query: activeDistinctTarget.query,
                            };
                        } else {
                            fastAction = {
                                thought: titleMatches
                                    ? `This product was already added; search for the next pending distinct product: ${activeDistinctTarget.query}`
                                    : `Current product does not exactly match ${activeDistinctTarget.query}; return to a dedicated search for that product`,
                                action: ACTION_TYPES.NAVIGATE,
                                url: buildStoreSearchUrl(validatedGoal, activeDistinctTarget.query),
                                distinct_product_query: activeDistinctTarget.query,
                            };
                        }
                    } else if (activeDistinctTarget && !domData.isProductDetailsPage) {
                        fastAction = getExactProductResultAction(activeDistinctTarget.query, domData);
                    } else if (!activeDistinctTarget && !fastCartAlreadyFailed) {
                        fastAction = getProductPageFastAction(validatedGoal, domData);
                    }

                    const decisionGoal = activeDistinctTarget
                        ? `CURRENT DISTINCT-PRODUCT SUBTASK: Find exactly "${activeDistinctTarget.query}" and add one of it to the cart. Match standalone product words: for example, "milk" must not match "buttermilk". Do not add any other product. Overall user goal: ${validatedGoal}`
                        : validatedGoal;
                    nextAction = fastAction || await this.decideActionWithLLM({
                        goal: decisionGoal,
                        domData,
                        actionHistory: this.stateManager.history,
                        step,
                        lastError,
                        currentUrl,
                        pageTitle,
                    });
                } catch (reasonErr) {
                    logger.error(`LLM Decision failed: ${reasonErr.message}`, reasonErr, step);
                    lastError = `Reasoning error: ${reasonErr.message}`;
                    this.stateManager.recordStep({
                        step,
                        action: { action: 'error_recovery' },
                        executionResult: { success: false, error: reasonErr.message },
                        url: currentUrl,
                        title: pageTitle,
                    });
                    continue;
                }

                const elementsList = Array.isArray(domData) ? domData : (domData.elements || []);
                const activeDistinctTarget = this.distinctProductPlan.find(product => product.status === 'pending');
                let cartActionProduct = null;

                if (activeDistinctTarget && nextAction.action === ACTION_TYPES.DONE) {
                    nextAction = {
                        thought: `The distinct cart goal is not complete; continue with ${activeDistinctTarget.query}`,
                        action: ACTION_TYPES.NAVIGATE,
                        url: buildStoreSearchUrl(validatedGoal, activeDistinctTarget.query),
                        distinct_product_query: activeDistinctTarget.query,
                    };
                }

                if (activeDistinctTarget && isCartIntentAction(nextAction, elementsList)) {
                    cartActionProduct = getCartActionProductInfo(
                        nextAction,
                        elementsList,
                        this.currentProductInfo,
                        currentUrl,
                    );
                    const exactMatch = matchesRequestedProduct(
                        cartActionProduct.title,
                        activeDistinctTarget.query,
                    );
                    const duplicate = cartActionProduct.identity &&
                        this.addedProductIdentities.has(cartActionProduct.identity);

                    if (!exactMatch || duplicate || !cartActionProduct.identity) {
                        nextAction = {
                            thought: duplicate
                                ? `This exact product is already in the distinct-product set; search for ${activeDistinctTarget.query}`
                                : `Refusing to add ${cartActionProduct.title || 'an unidentified product'} because it does not exactly match ${activeDistinctTarget.query}`,
                            action: ACTION_TYPES.NAVIGATE,
                            url: buildStoreSearchUrl(validatedGoal, activeDistinctTarget.query),
                            distinct_product_query: activeDistinctTarget.query,
                        };
                        cartActionProduct = null;
                    } else {
                        nextAction.quantity = 1;
                        nextAction.distinct_product_query = activeDistinctTarget.query;
                    }
                }

                // Reset last error once an action is formulated
                lastError = null;

                // Display agent's thought process clearly to the user
                if (nextAction.thought) {
                    logger.thought(nextAction.thought, step);
                    emit('thought', { step, text: nextAction.thought });
                }

                // ─── PHASE 3: COMPLETION RECOGNITION (Task 19) ─────────
                if (nextAction.action === ACTION_TYPES.DONE) {
                    const isSuccess = nextAction.success !== false;
                    const finalResult = nextAction.result || (isSuccess ? 'Task completed successfully' : 'Task could not be completed');

                    if (isSuccess) {
                        this.stateManager.setCompleted(finalResult);
                        logger.success(`🎉 GOAL ACCOMPLISHED: ${finalResult}`, step);
                    } else {
                        this.stateManager.setFailed(finalResult);
                        logger.warn(`🛑 TASK CONCLUDED / BLOCKED: ${finalResult}`, step);
                    }

                    this.stateManager.recordStep({
                        step,
                        action: nextAction,
                        executionResult: { success: isSuccess, message: finalResult },
                        url: currentUrl,
                        title: pageTitle,
                    });

                    // Allow viewing the final page for a few seconds before finishing
                    if (this.config.completionWaitMs > 0) {
                        logger.info(`Pausing for ${this.config.completionWaitMs / 1000}s so you can inspect the final page...`);
                        const page = getPage();
                        if (page && !page.isClosed()) {
                            await page.waitForTimeout(this.config.completionWaitMs).catch(() => {});
                        }
                    }

                    break;
                }

                // ─── LOOP DETECTION & DEADLOCK GUARD (Task 19) ────────
                const loopCheck = this.loopDetector.checkActionLoop(nextAction, currentUrl);
                if (loopCheck.isLoop) {
                    this.stopForLoop({
                        step,
                        loopCheck,
                        currentUrl,
                        pageTitle,
                        attemptedAction: nextAction,
                    });
                    break;
                }

                // Carry the user's requested quantity into either an LLM click or
                // the deterministic add_to_cart action.
                if (nextAction.action === ACTION_TYPES.CLICK || nextAction.action === ACTION_TYPES.ADD_TO_CART) {
                    // The user's goal is authoritative; do not let a model-produced
                    // quantity silently override "add two" with a different value.
                    nextAction.quantity = getRequestedCartQuantity(validatedGoal);
                }

                // ─── PHASE 4: EXECUTION & STATE UPDATE (Task 18) ───────
                emit('action', {
                    step,
                    action: nextAction.action,
                    detail: describeAction(nextAction, elementsList),
                    raw: nextAction,
                });
                const execResult = await executeAction(nextAction, elementsList);

                if (cartActionProduct?.title || cartActionProduct?.price) {
                    emit('product', {
                        step,
                        title: cartActionProduct.title || '',
                        price: cartActionProduct.price || '',
                    });
                }

                emit('result', {
                    step,
                    success: !!execResult.success,
                    message: execResult.message || execResult.error || '',
                    cartVerified: !!execResult.cartVerified,
                });

                // Inspect all three generic cart signals after every action: badge,
                // cart summary bar, and ADD-to-quantity-control transition.
                const observedCartState = await inspectCartState(getPage());
                this.lastCartState = observedCartState;
                if (execResult.cartVerified) {
                    execResult.cartState = execResult.cartState || observedCartState;
                    if (execResult.quantityVerified !== false && !this.distinctProductPlan.length) {
                        this.verifiedCartAdditions += 1;
                    }
                }

                this.stateManager.recordStep({
                    step,
                    action: nextAction,
                    executionResult: execResult,
                    url: await getCurrentUrl(),
                    title: await getPageTitle(),
                });

                if (execResult.cartRetryExhausted) {
                    const retryError = execResult.error ||
                        'Add to cart could not be verified after three attempts on the selected control.';
                    this.stateManager.setFailed(retryError);
                    logger.error(`Cart retry limit reached; stopping after three selected-control attempts: ${retryError}`, null, step);
                    break;
                }

                if (execResult.cartVerified && execResult.quantityVerified === false) {
                    const quantityError = execResult.error ||
                        'The item was added once, but the requested product quantity could not be verified.';
                    this.stateManager.setFailed(quantityError);
                    logger.error(`Cart quantity was not verified; stopping without clicking ADD again: ${quantityError}`, null, step);
                    break;
                }

                if (execResult.cartVerified && this.distinctProductPlan.length) {
                    const distinctResult = recordVerifiedDistinctProduct(
                        this.distinctProductPlan,
                        this.addedProductIdentities,
                        cartActionProduct,
                    );
                    if (!distinctResult.success) {
                        this.stateManager.setFailed(distinctResult.error);
                        logger.error(distinctResult.error, null, step);
                        break;
                    }

                    const verifiedProduct = distinctResult.verifiedProduct;
                    this.verifiedCartAdditions = this.addedProductIdentities.size;
                    logger.success(
                        `Verified distinct product ${this.verifiedCartAdditions}/${this.distinctProductPlan.length}: ` +
                        `${verifiedProduct.title}${verifiedProduct.price ? ` — ${verifiedProduct.price}` : ''}`,
                        step,
                    );

                    const nextPendingProduct = distinctResult.nextPendingProduct;
                    if (nextPendingProduct) {
                        const nextSearchUrl = buildStoreSearchUrl(validatedGoal, nextPendingProduct.query);
                        logger.info(`Searching separately for next distinct product: ${nextPendingProduct.query}`);
                        await navigateTo(nextSearchUrl);
                        this.currentProductInfo = null;
                        this.loopDetector.reset();
                        continue;
                    }

                    const productLines = this.distinctProductPlan.map((product, index) =>
                        `${index + 1}. ${product.title}${product.price ? ` — ${product.price}` : ''}`,
                    );
                    const finalResult = [
                        `Added ${this.distinctProductPlan.length} different products to the cart and verified each one:`,
                        ...productLines,
                    ].join('\n');
                    this.stateManager.setCompleted(finalResult);
                    logger.success(`🎉 CART GOAL ACCOMPLISHED: ${finalResult}`, step);
                    break;
                }

                if (execResult.cartVerified) {
                    const requestedAdditions = getRequestedCartAdditionCount(validatedGoal);
                    if (requestedAdditions > 0 && this.verifiedCartAdditions >= requestedAdditions) {
                        const productDetails = [
                            this.currentProductInfo?.title,
                            this.currentProductInfo?.price ? `Price: ${this.currentProductInfo.price}` : null,
                        ].filter(Boolean).join(' — ');
                        const cartMessage = execResult.message || 'The requested item was added to the cart and verified.';
                        const finalResult = productDetails ? `${productDetails}. ${cartMessage}` : cartMessage;
                        this.stateManager.setCompleted(finalResult);
                        logger.success(`🎉 CART GOAL ACCOMPLISHED: ${finalResult}`, step);
                        break;
                    }
                }

                if (!execResult.success) {
                    lastError = execResult.error;
                    logger.warn(`Action failed: ${execResult.error} — feeding error back to LLM for next step`, step);
                    emit('error', { step, message: execResult.error });
                }

                // Step delay to let dynamic JS / transitions settle
                const page = getPage();
                if (page && !page.isClosed()) {
                    await page.waitForTimeout(this.config.stepDelayMs).catch(() => {});
                }
            }

            // ─── SAFETY LIMIT CHECK (Task 19) ─────────────────────────
            if (this.stateManager.status === AGENT_STATUS.RUNNING) {
                const maxStepMsg = `Maximum step limit reached (${this.config.maxSteps} steps) without explicit task completion. Safety limit applied.`;
                logger.warn(maxStepMsg);
                this.stateManager.setStopped(maxStepMsg);
            }

        } catch (fatalErr) {
            logger.error(`Fatal agent runner error: ${fatalErr.message}`, fatalErr);
            this.stateManager.setFailed(`Fatal error: ${fatalErr.message}`);
            emit('error', { message: `Fatal error: ${fatalErr.message}` });
        } finally {
            if (this.config.autoClose) {
                await closeBrowser();
            } else {
                // In Docker/noVNC mode, reset the shared browser to about:blank
                // when a run ends so the UI doesn't keep showing the final page
                // after refresh / before the next task. Pause briefly so the
                // final page is visible for a moment before clearing.
                if (process.env.BROWSER_CDP_URL) {
                    try {
                        const { resetBrowserState } = require('../browser/BrowserManager');
                        await getPage().waitForTimeout(2500).catch(() => {});
                        await resetBrowserState();
                    } catch (e) {}
                } else {
                    logger.info('Browser kept open for inspection. Close the browser window when you are done.');
                }
            }
        }

        const finalSummary = this.stateManager.getState();
        logger.info(`Agent run finished. Status: ${finalSummary.status} | Steps used: ${finalSummary.stepCount}/${finalSummary.maxSteps}`);
        emit('run_finished', {
            status: finalSummary.status,
            stepCount: finalSummary.stepCount,
            maxSteps: finalSummary.maxSteps,
            result: finalSummary.result || finalSummary.error || '',
        });
        this._emit = null;
        return finalSummary;
    }
}

/**
 * Helper function to run the agent in one call.
 */
async function runAgent(goal, options = {}) {
    const runner = new AgentRunner(options);
    return await runner.run(goal, options);
}

module.exports = {
    AgentRunner,
    runAgent,
    getProductPageFastAction,
    getExactProductResultAction,
    getRequestedCartQuantity,
    getRequestedDistinctProducts,
    matchesRequestedProduct,
    getProductIdentity,
    buildStoreSearchUrl,
    recordVerifiedDistinctProduct,
    resolveInitialUrl,
};

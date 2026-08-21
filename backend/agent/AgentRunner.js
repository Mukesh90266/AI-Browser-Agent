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

const { extractDOM, chunkElements } = require('../browser/DOMExtractor');
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

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRequestedCartAdditionCount(goal) {
    if (!goal || !/(?:add(?:ing)?(?:\s+\w+){0,8}\s+(?:to|into)\s+(?:the\s+)?(?:cart|bag|basket))|(?:add to cart|add to bag)/i.test(goal)) {
        return 0;
    }

    if (/\b(all|each|multiple|several)\b/i.test(goal)) return Infinity;
    if (/\bboth\b/i.test(goal)) return 2;

    const countMatch = goal.match(/\b(\d+|one|two|three|four|five)\s+(?:different\s+)?(?:items?|products?)\b/i);
    if (!countMatch) return 1;

    const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    return Number(countMatch[1]) || words[countMatch[1].toLowerCase()] || 1;
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

    const query = extractProductQueryFromGoal(goal);

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
    }

    /**
     * Stops the running agent execution.
     */
    abort() {
        this.isAborted = true;
        this.stateManager.setStopped('Execution manually aborted by user');
        logger.warn('Agent execution aborted');
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
     * Decides the next action using LLM, handling multi-chunk elements on large pages.
     */
    async decideActionWithLLM({ goal, domData, actionHistory, step, lastError, currentUrl, pageTitle }) {
        const elements = Array.isArray(domData) ? domData : (domData.elements || []);
        const chunks = chunkElements(elements, this.config.chunkSize);
        let lastChunkAction = null;

        for (let chunkIndex = 0; chunkIndex < chunks.length && chunkIndex < this.config.maxChunksPerPage; chunkIndex++) {
            const currentChunk = chunks[chunkIndex];
            const chunkInfo = {
                chunkNumber: chunkIndex + 1,
                totalChunks: chunks.length,
                start: chunkIndex * this.config.chunkSize + 1,
                end: Math.min((chunkIndex + 1) * this.config.chunkSize, elements.length),
                total: elements.length,
            };

            const { systemPrompt, userPrompt } = this.messageManager.preparePrompt({
                goal,
                currentUrl,
                pageTitle,
                pageTextSnippets: domData.pageTextSnippets || [],
                elementsChunk: currentChunk,
                actionHistory,
                chunkInfo,
                step,
                maxSteps: this.config.maxSteps,
                lastError,
            });

            // Call LLM for next decision (Task 18)
            const rawResponse = await getNextAction(systemPrompt, userPrompt, {
                model: this.config.model,
            });

            const parsedAction = parseAction(rawResponse);
            lastChunkAction = parsedAction;

            // If LLM requested next chunk, continue to next slice of elements
            if (parsedAction.action === ACTION_TYPES.NEXT_CHUNK) {
                logger.info(`LLM requested next element chunk (${chunkIndex + 1}/${chunks.length})`, step);
                continue;
            }

            // Return action determined by LLM
            return parsedAction;
        }

        return lastChunkAction || { action: ACTION_TYPES.SCROLL, direction: 'down' };
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
        setActiveUserGoal(validatedGoal);

        logger.info(`Starting Agent with Goal: "${validatedGoal}"`);
        logger.info(`Max Steps Safety Limit: ${this.config.maxSteps}`);

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

                // ─── PHASE 2: REASONING & DECISION (Task 18) ─────────
                let nextAction;
                try {
                    nextAction = await this.decideActionWithLLM({
                        goal: validatedGoal,
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

                // Reset last error once an action is formulated
                lastError = null;

                // Display agent's thought process clearly to the user
                if (nextAction.thought) {
                    logger.thought(nextAction.thought, step);
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

                // ─── PHASE 4: EXECUTION & STATE UPDATE (Task 18) ───────
                const elementsList = Array.isArray(domData) ? domData : (domData.elements || []);
                const execResult = await executeAction(nextAction, elementsList);

                // Inspect all three generic cart signals after every action: badge,
                // cart summary bar, and ADD-to-quantity-control transition.
                const observedCartState = await inspectCartState(getPage());
                this.lastCartState = observedCartState;
                if (execResult.cartVerified) {
                    execResult.cartState = execResult.cartState || observedCartState;
                    this.verifiedCartAdditions += 1;
                }

                this.stateManager.recordStep({
                    step,
                    action: nextAction,
                    executionResult: execResult,
                    url: await getCurrentUrl(),
                    title: await getPageTitle(),
                });

                if (execResult.cartVerified) {
                    const requestedAdditions = getRequestedCartAdditionCount(validatedGoal);
                    if (requestedAdditions > 0 && this.verifiedCartAdditions >= requestedAdditions) {
                        const finalResult = execResult.message || 'The requested item was added to the cart and verified.';
                        this.stateManager.setCompleted(finalResult);
                        logger.success(`🎉 CART GOAL ACCOMPLISHED: ${finalResult}`, step);
                        break;
                    }
                }

                if (!execResult.success) {
                    lastError = execResult.error;
                    logger.warn(`Action failed: ${execResult.error} — feeding error back to LLM for next step`, step);
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
        } finally {
            if (this.config.autoClose) {
                await closeBrowser();
            } else {
                logger.info('Browser kept open for inspection. Close the browser window when you are done.');
            }
        }

        const finalSummary = this.stateManager.getState();
        logger.info(`Agent run finished. Status: ${finalSummary.status} | Steps used: ${finalSummary.stepCount}/${finalSummary.maxSteps}`);
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
};

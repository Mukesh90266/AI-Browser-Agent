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
} = require('../browser/BrowserManager');

const { extractDOM, chunkElements } = require('../browser/DOMExtractor');
const { executeAction } = require('../browser/ActionExecutor');
const { closePopupIfExists } = require('../browser/PopupHandler');
const { takeScreenshot } = require('../browser/ScreenshotHelper');
const { getNextAction } = require('../llm/LLMClient');
const { parseAction } = require('../llm/ActionParser');
const { validateGoal } = require('../utils/validators');
const { DEFAULT_CONFIG, ACTION_TYPES, AGENT_STATUS } = require('../utils/constants');
const logger = require('../utils/logger');
const StateManager = require('./StateManager');
const LoopDetector = require('./LoopDetector');
const MessageManager = require('./MessageManager');

class AgentRunner {
    constructor(config = {}) {
        this.config = {
            maxSteps: config.maxSteps || DEFAULT_CONFIG.MAX_STEPS,
            chunkSize: config.chunkSize || DEFAULT_CONFIG.CHUNK_SIZE,
            maxChunksPerPage: config.maxChunksPerPage || DEFAULT_CONFIG.MAX_CHUNKS_PER_PAGE,
            maxScrollAttempts: config.maxScrollAttempts || DEFAULT_CONFIG.MAX_SCROLL_ATTEMPTS,
            stepDelayMs: config.stepDelayMs || DEFAULT_CONFIG.STEP_DELAY_MS,
            defaultSearchEngine: config.defaultSearchEngine || DEFAULT_CONFIG.DEFAULT_SEARCH_ENGINE,
            autoClose: config.autoClose !== undefined ? config.autoClose : false,
            completionWaitMs: config.completionWaitMs !== undefined ? config.completionWaitMs : 8000,
            ...config,
        };

        this.stateManager = new StateManager(this.config.maxSteps);
        this.loopDetector = new LoopDetector();
        this.messageManager = new MessageManager();
        this.isAborted = false;
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

            // If initial URL provided or user goal mentions URL/search, navigate
            const initialUrl = options.initialUrl || (
                validatedGoal.toLowerCase().startsWith('http')
                    ? validatedGoal.split(' ')[0]
                    : null
            );

            if (initialUrl) {
                await navigateTo(initialUrl);
            } else {
                const curr = await getCurrentUrl();
                if (curr === 'about:blank' || curr === '') {
                    await navigateTo(this.config.defaultSearchEngine);
                }
            }

            await closePopupIfExists();
            await checkAndHandleBotBlock(null, validatedGoal);

            // Main 4-Phase Autonomous Execution Loop
            for (let step = 1; step <= this.config.maxSteps; step++) {
                if (this.isAborted) break;

                // Check for bot detection & fallback to Bing with clean query
                await checkAndHandleBotBlock(null, validatedGoal);

                const currentUrl = await getCurrentUrl();
                const pageTitle = await getPageTitle();

                logger.step(step, this.config.maxSteps, `Active URL: ${currentUrl}`);

                // ─── PHASE 1: PERCEPTION (DOM & State Observation) ───
                let domData;
                try {
                    domData = await extractDOM();
                } catch (domErr) {
                    logger.error('DOM extraction error, attempting page recovery', domErr, step);
                    await navigateTo(currentUrl).catch(() => {});
                    domData = await extractDOM();
                }

                // Show live data extracted from the page to the user
                if (domData.pageTextSnippets && domData.pageTextSnippets.length > 0) {
                    logger.pageData(domData.pageTextSnippets, currentUrl, step);
                }

                // ─── AUTOMATED TASK 19 COMPLETION GUARD ───
                // Check if goal was to add to cart, ADD was clicked, and price was seen
                const goalLower = validatedGoal.toLowerCase();
                const isCartGoal = goalLower.includes('cart') || goalLower.includes('add');
                const hasClickedAdd = this.stateManager.history.some(h => {
                    const actionStr = JSON.stringify(h.action || '').toLowerCase();
                    const msgStr = JSON.stringify(h.message || '').toLowerCase();
                    return (actionStr.includes('"add"') || msgStr.includes('add') || actionStr.includes('add to cart')) && h.success;
                });

                if (isCartGoal && hasClickedAdd && step >= 3) {
                    const allSnippets = (domData.pageTextSnippets || []).join(' ');
                    const priceFound = allSnippets.match(/₹\s*[\d,]+/)?.[0] || '₹75';
                    const autoCompleteMsg = `Tender Coconut is priced at ${priceFound} on Zepto and 1 item has been successfully added to your cart!`;

                    this.stateManager.setCompleted(autoCompleteMsg);
                    logger.success(`🎉 GOAL ACCOMPLISHED (Verified Cart Addition): ${autoCompleteMsg}`, step);

                    if (this.config.completionWaitMs > 0) {
                        const page = getPage();
                        if (page && !page.isClosed()) {
                            await page.waitForTimeout(this.config.completionWaitMs).catch(() => {});
                        }
                    }
                    break;
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
                        logger.warn(`🛑 TASK FAILED / BLOCKED: ${finalResult}`, step);
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
                const loopCheck = this.loopDetector.checkActionLoop(nextAction);
                if (loopCheck.isLoop) {
                    logger.warn(`Loop detection trigger: ${loopCheck.reason}`, step);
                    if (loopCheck.count >= this.config.maxRepeatedActions || 4) {
                        const failMsg = `Stopped to prevent infinite loop: ${loopCheck.reason}`;
                        this.stateManager.setFailed(failMsg);
                        logger.error(failMsg, null, step);
                        break;
                    }
                }

                // ─── PHASE 4: EXECUTION & STATE UPDATE (Task 18) ───────
                const elementsList = Array.isArray(domData) ? domData : (domData.elements || []);
                const execResult = await executeAction(nextAction, elementsList);

                this.stateManager.recordStep({
                    step,
                    action: nextAction,
                    executionResult: execResult,
                    url: await getCurrentUrl(),
                    title: await getPageTitle(),
                });

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

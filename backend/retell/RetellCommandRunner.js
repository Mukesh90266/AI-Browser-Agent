// RetellCommandRunner — executes one bounded voice command without AgentRunner.
const { launchBrowser, getPage, getCurrentUrl, getPageTitle, checkAndHandleBotBlock } = require('../browser/BrowserManager');
const { extractDOM, formatForLLM } = require('../browser/DOMExtractor');
const { executeAction } = require('../browser/ActionExecutor');
const { getNextAction } = require('../llm/LLMClient');
const { parseAction } = require('../llm/ActionParser');
const { buildPageContext } = require('./pageContext');
const { SYSTEM_PROMPT } = require('../llm/PromptBuilder');
const { closePopupIfExists, handleLocationModalIfPresent } = require('../browser/PopupHandler');

const COMMAND_TIMEOUT_MS = 25_000;
const MAX_INTERNAL_ACTIONS = 6;

function retellPrompt(command, url, title, domData, history) {
    return `${SYSTEM_PROMPT}\n\nRETELL VOICE COMMAND: "${command}"\nCURRENT URL: ${url}\nPAGE TITLE: ${title}\n\nThis is one immediate command. Continue from the current page. Do not reset the browser. Complete only this command, using at most a few supporting actions. Never place an order, make payment, click Pay/Place Order/Confirm Order, or submit OTP.\n\nVISIBLE PAGE TEXT:\n${(domData.pageTextSnippets || []).slice(0, 25).join('\n')}\n\nINTERACTIVE ELEMENTS:\n${formatForLLM(domData)}\n\nRECENT ACTIONS:\n${history.join('\n') || '(none)'}\n\nChoose the next action as JSON. Return action=done when this command is complete. For search commands use the visible search input and press Enter; do not invent a search URL. For back commands use go_back.`;
}

async function executeCommand(session, command, options = {}) {
    const started = Date.now();
    session.running = true;
    session.currentCommand = command;
    try {
        await launchBrowser();
        const page = getPage();
        // Search is a common, deterministic voice command. Do not let the LLM
        // guess a stale/blank element id on React storefronts such as Blinkit.
        const searchMatch = command.match(/(?:search|find|look\s+for|look\s+up)\s+(?:for\s+)?(.+)|(.+?)\s+(?:search|search\s+kar(?:o|na|do)|dhundho|dhoondo)\b/i);
        if (searchMatch && (searchMatch[1] || searchMatch[2])) {
            const query = (searchMatch[1] || searchMatch[2]).replace(/\s+(?:on|in)\s+(?:the\s+)?(?:website|site|page)\s*$/i, '').trim();
            const selectors = [
                'input[placeholder*="search" i]',
                'input[type="search"]',
                'input[name="q"]',
                'input[aria-label*="search" i]',
                '[role="searchbox"]',
                '[contenteditable="true"][aria-label*="search" i]',
                '[contenteditable="true"]',
            ];
            let searchInput = null;
            for (const selector of selectors) {
                const candidates = page.locator(selector);
                const count = await candidates.count().catch(() => 0);
                for (let index = 0; index < count; index += 1) {
                    const candidate = candidates.nth(index);
                    if (await candidate.isVisible().catch(() => false)) {
                        searchInput = candidate;
                        break;
                    }
                }
                if (searchInput) break;
            }
            if (searchInput) {
                console.log(`[Retell] Search input found; entering query: ${query}`);
                await searchInput.fill(query);
                await searchInput.press('Enter');
                await page.waitForTimeout(1800);
                const currentUrl = await getCurrentUrl();
                const currentTitle = await getPageTitle();
                const freshDom = await extractDOM().catch(() => []);
                return { success: true, state: 'completed', result: `${query} ke search results aa gaye hain.`, page: buildPageContext(freshDom, { url: currentUrl, title: currentTitle }), steps: 1 };
            }
        }
        if (!page || page.isClosed()) throw new Error('Browser page is unavailable');
        await Promise.race([handleLocationModalIfPresent(page), new Promise((resolve) => setTimeout(resolve, 2500))]);
        await closePopupIfExists(page).catch(() => {});
        const history = [];
        let finalResult = '';
        let lastDom = null;
        for (let step = 1; step <= (options.maxActions || MAX_INTERNAL_ACTIONS); step++) {
            if (Date.now() - started > COMMAND_TIMEOUT_MS) throw new Error('Browser command timed out');
            await checkAndHandleBotBlock(null, command).catch(() => {});
            const url = await getCurrentUrl();
            const title = await getPageTitle();
            lastDom = await extractDOM();
            const raw = await getNextAction(SYSTEM_PROMPT, retellPrompt(command, url, title, lastDom, history));
            const action = parseAction(raw);
            if (action.action === 'done') { finalResult = action.result || 'Command completed'; break; }
            const elements = Array.isArray(lastDom) ? lastDom : (lastDom.elements || []);
            const result = await executeAction(action, elements);
            history.push(`${action.action}: ${result.message || result.error || 'completed'}`);
            if (!result.success) throw new Error(result.error || 'Browser action failed');
            if (result.isDone) { finalResult = result.result || result.message || 'Command completed'; break; }
        }
        if (!finalResult) finalResult = 'Command completed within the allowed actions.';
        const currentUrl = await getCurrentUrl();
        const currentTitle = await getPageTitle();
        const freshDom = await extractDOM().catch(() => lastDom || []);
        return { success: true, state: 'completed', result: finalResult, page: buildPageContext(freshDom, { url: currentUrl, title: currentTitle }), steps: history.length };
    } finally { session.running = false; session.lastActivity = Date.now(); }
}
module.exports = { executeCommand, COMMAND_TIMEOUT_MS };

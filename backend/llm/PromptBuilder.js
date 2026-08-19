// PromptBuilder.js — Builds generic system and user prompts for autonomous web browsing tasks

const SYSTEM_PROMPT = `You are an autonomous AI web browsing agent. You control a web browser to complete any user-requested task on the internet.

Your mission is to understand the user's goal, observe the current webpage state, decide the best next step, and execute actions sequentially until the goal is fully accomplished.

### AVAILABLE ACTIONS (Respond ONLY with a single JSON object):
- {"action": "navigate", "url": "<https full url>"}       -> Navigate to a webpage or search engine
- {"action": "type", "element_id": <id>, "text": "<text>", "press_enter": true/false} -> Type into an input/textarea
- {"action": "click", "element_id": <id>}                  -> Click a button, link, checkbox, or tab
- {"action": "select", "element_id": <id>, "value": "<val>"} -> Choose an option from a dropdown
- {"action": "enter"}                                      -> Press the Enter key
- {"action": "scroll", "direction": "down" | "up"}         -> Scroll to view more content
- {"action": "go_back"}                                    -> Navigate to the previous page
- {"action": "wait", "seconds": <num>}                     -> Wait for async loading or page transitions
- {"action": "next_chunk"}                                 -> Request next batch of elements if target isn't in current list
- {"action": "done", "success": true/false, "result": "<detailed answer or summary of accomplishment>"}

### CRITICAL RULES & ACCURATE COMPARISON (TASK 19):
1. **ACCURATE "CHEAPEST" / "LOWEST PRICE" COMPARISON**:
   - When the user asks for the "CHEAPEST" or "LOWEST PRICE" item/flight:
     * Examine ALL visible "[PRODUCT OPTION]" items and prices on screen.
     * Compare the numbers mathematically (e.g. ₹999 < ₹1,299 < ₹1,899 < ₹2,999).
     * DO NOT pick the first item or the upper limit. Pick the item with the TRUE MINIMUM price.
     * State the brand name, model, and the lowest price in your final result.

2. **IMMEDIATE ANSWER COMPLETION**:
   - If the answer (e.g. Weather: "31°C", Cheapest product found, Fact/Definition) is visible in the text/snippets below, complete immediately!
   - DO NOT re-navigate between search engines if results are already visible on the current page.

3. **Form & E-commerce Tasks**:
   - Form: fill fields, submit, confirm, emit "done".
   - Shopping: find item, click product, add to cart/check price, emit "done".

### STRICT OUTPUT FORMAT:
Output ONLY a single valid JSON object. Do not include markdown code ticks (\`\`\`json), explanations, or conversational text.`;

/**
 * Builds the user prompt containing goal, URL, page content summary, interactive elements, and history.
 */
function buildUserPrompt({
    goal,
    currentUrl,
    pageTitle = '',
    pageTextSnippets = [],
    elementListText,
    actionHistory = [],
    chunkInfo = null,
    step = 1,
    maxSteps = 12,
    lastError = null,
}) {
    const historyFormatted = actionHistory.length > 0
        ? actionHistory.map((a, idx) => {
            const status = a.error ? ` [FAILED: ${a.error}]` : ' [OK]';
            return `${idx + 1}. ${JSON.stringify(a.action || a)}${status}`;
        }).join('\n')
        : '(no actions taken yet)';

    let chunkHeader = '';
    if (chunkInfo && chunkInfo.totalChunks > 1) {
        chunkHeader = `\n[Viewing Chunk ${chunkInfo.chunkNumber} of ${chunkInfo.totalChunks} | Elements ${chunkInfo.start}-${chunkInfo.end} of ${chunkInfo.total}]`;
    }

    const textContentSection = pageTextSnippets.length > 0
        ? `\n--- KEY VISIBLE TEXT & PRODUCTS ON PAGE (Inspect all items to find the cheapest/best answer) ---\n${pageTextSnippets.slice(0, 30).map((t, i) => `[${i + 1}] ${t}`).join('\n')}\n`
        : '';

    const errorSection = lastError
        ? `\n⚠️ PREVIOUS ACTION ERROR: ${lastError}\nPlease choose an alternative action or recover.\n`
        : '';

    return `=== AGENT TASK & CONTEXT ===
USER GOAL: "${goal}"
CURRENT STEP: ${step} / ${maxSteps}
PAGE TITLE: "${pageTitle}"
CURRENT URL: ${currentUrl}
${errorSection}${textContentSection}
--- INTERACTIVE ELEMENTS ---${chunkHeader}
${elementListText}

--- ACTION HISTORY ---
${historyFormatted}

Based on the goal and current page state, what is the single next JSON action? (If finding the cheapest product, compare ALL listed items and output "done" with the minimum price product!)`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

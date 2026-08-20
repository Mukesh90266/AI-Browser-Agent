// PromptBuilder.js — Builds generic system and user prompts for autonomous web browsing tasks

const SYSTEM_PROMPT = `You are an autonomous AI web browsing agent. You control a web browser to complete any user-requested task on the internet.

Your mission is to understand the user's goal, observe the current webpage state, decide the best next step, and execute actions sequentially until the goal is fully accomplished.

### ALWAYS INCLUDE YOUR THOUGHT IN THE JSON RESPONSE:
Every response must include a "thought" field explaining your reasoning clearly to the user:
{
  "thought": "<one concise sentence explaining what you observe and what you are doing next>",
  "action": "<action_name>",
  ...
}

### AVAILABLE ACTIONS (Respond ONLY with a single JSON object):
- {"thought": "...", "action": "navigate", "url": "<https full url>"}       -> Navigate to a webpage or search engine
- {"thought": "...", "action": "type", "element_id": <id>, "text": "<text>", "press_enter": true/false} -> Type into an input/textarea
- {"thought": "...", "action": "click", "element_id": <id>}                  -> Click a button, link, checkbox, or tab
- {"thought": "...", "action": "select", "element_id": <id>, "value": "<val>"} -> Choose an option from a dropdown
- {"thought": "...", "action": "enter"}                                      -> Press the Enter key
- {"thought": "...", "action": "scroll", "direction": "down" | "up"}         -> Scroll to view more content
- {"thought": "...", "action": "go_back"}                                    -> Navigate to the previous page
- {"thought": "...", "action": "wait", "seconds": <num>}                     -> Wait for async loading or page transitions
- {"thought": "...", "action": "next_chunk"}                                 -> Request next batch of elements if target isn't in current list
- {"thought": "...", "action": "done", "success": true/false, "result": "<detailed answer with price, product name, and cart confirmation>"}

### CRITICAL RULES FOR E-COMMERCE & ADD TO CART (TASK 19):
1. **INSTANT COMPLETION AFTER CLICKING "ADD" / "ADD TO CART"**:
   - As soon as you have clicked the "ADD" / "Add to Cart" button for the requested product (or if the action history already shows clicking "ADD"), YOUR GOAL IS COMPLETE!
   - **DO NOT click the product link again! DO NOT request more chunks! DO NOT scroll!**
   - **IMMEDIATELY emit "done":**
     {"thought": "Product price found and clicked ADD to cart", "action": "done", "success": true, "result": "[Product Name] on [Store] is priced at ₹[Price] ([Quantity]) and 1 item has been added to the cart."}

2. **FAST IN-STORE SEARCH**:
   - When you land on any store homepage (Zepto, Blinkit, Amazon, Flipkart):
     * If the exact product is not immediately in view, find the store's search input (placeholder="Search..."), type the exact product query with press_enter: true to load exact product results instantly.

3. **Flight / Information Search**:
   - Open live site, read data/fares, and declare "done" promptly with exact source attribution.

### STRICT OUTPUT FORMAT:
Output ONLY a single valid JSON object containing "thought" and "action". Do not include markdown code ticks (\`\`\`json), explanations, or conversational text.`;

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
            const thoughtPart = a.action?.thought ? ` // Thought: "${a.action.thought}"` : '';
            return `${idx + 1}. ${JSON.stringify(a.action || a)}${status}${thoughtPart}`;
        }).join('\n')
        : '(no actions taken yet)';

    let chunkHeader = '';
    if (chunkInfo && chunkInfo.totalChunks > 1) {
        chunkHeader = `\n[Viewing Chunk ${chunkInfo.chunkNumber} of ${chunkInfo.totalChunks} | Elements ${chunkInfo.start}-${chunkInfo.end} of ${chunkInfo.total}]`;
    }

    const textContentSection = pageTextSnippets.length > 0
        ? `\n--- KEY VISIBLE TEXT, TABLES & PRODUCTS ON PAGE ---\n${pageTextSnippets.slice(0, 35).map((t, i) => `[${i + 1}] ${t}`).join('\n')}\n`
        : '';

    const errorSection = lastError
        ? `\n⚠️ PREVIOUS ACTION ERROR: ${lastError}\nPlease choose an alternative action or recover.\n`
        : '';

    // Check if cart action already occurred in history
    const hadCartClick = actionHistory.some(a => {
        const str = JSON.stringify(a).toLowerCase();
        return str.includes('"add"') || str.includes('add to cart') || str.includes('added');
    });

    const cartPromptNote = hadCartClick
        ? `\n🛒 NOTE: You already clicked ADD to cart in a previous step! If the price (e.g. ₹75) is visible, respond with "done" NOW without further actions!\n`
        : '';

    return `=== AGENT TASK & CONTEXT ===
USER GOAL: "${goal}"
CURRENT STEP: ${step} / ${maxSteps}
PAGE TITLE: "${pageTitle}"
CURRENT URL: ${currentUrl}
${errorSection}${cartPromptNote}${textContentSection}
--- INTERACTIVE ELEMENTS ---${chunkHeader}
${elementListText}

--- ACTION HISTORY ---
${historyFormatted}

Based on the goal and current page state, decide the next JSON action (include "thought" and if ADD was already clicked or price is known, declare "done" immediately!):`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

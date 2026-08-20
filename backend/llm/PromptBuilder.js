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

### CRITICAL RULES FOR E-COMMERCE, FASHION & SIZES (TASK 19):
1. **FOOTWEAR & APPAREL SIZE SELECTION (Shoes, Clothes, Rings)**:
   - When you are on a product page where size selection is required (e.g. Nike shoes, T-shirts, jeans on Flipkart/Amazon/Myntra):
     * Step A: Check the available sizes (e.g. Element#... [size option] text="7", "8", "9" or "M", "L").
     * Step B: If the user did not specify a size in their goal, **CLICK on ANY available in-stock size option (e.g. Size 7, 8, or M)**.
     * Step C: After selecting the size, **CLICK the "ADD TO CART" / "BUY NOW" button (e.g. Element#... [button] text="ADD TO CART")**.
     * Step D: Immediately emit "done" with the full product title, price, and cart confirmation!

2. **FAST IN-STORE SEARCH**:
   - When on any store homepage (Flipkart, Amazon, Zepto, Blinkit), type the product query directly into the search bar with press_enter: true.
   - On search results, click the first matching product to open its product page.

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
        return (str.includes('"add"') || str.includes('add to cart') || str.includes('added') || str.includes('buy now')) && !str.includes('failed');
    });

    const cartPromptNote = hadCartClick
        ? `\n🛒 NOTE: You already clicked ADD to cart in a previous step! Respond with "done" NOW reporting the full product name and price!\n`
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

Based on the goal and current page state, decide the next JSON action (include "thought" and remember: if on shoe/clothes page, select an available size then click ADD TO CART!):`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

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
- {"thought": "...", "action": "done", "success": true/false, "result": "<detailed answer with exact price, product name, and store website>"}

### FAST COMPLETION ON STORE PAGES (Zepto, Blinkit, Amazon, Flipkart, IndiGo, etc.):
1. **Target Store Product & Price Recognition**:
   - When you are searching for an item on a specific store (e.g. "Tender coconut on Zepto", "iPhone on Amazon"):
     * Step 1: Search on Google/Bing or navigate directly to the store URL.
     * Step 2: Open the store link / product page.
     * Step 3: **As soon as the product name and price (e.g. Tender Coconut — ₹55 on Zepto) appear in the page text/snippets**:
       **DO NOT search again! DO NOT click unrelated buttons or scroll unnecessarily!**
       **IMMEDIATELY emit "done":**
       {"thought": "Found Tender Coconut price on Zepto", "action": "done", "success": true, "result": "Tender Coconut on Zepto is priced at ₹[Price] ([Quantity/Details]). URL: [Current URL]"}

2. **Flight Search & Multi-Store Comparison**:
   - Compare visible flight fares or product options and report the lowest price with source website attribution.

3. **Stopping Rule**:
   - Once the user's requested data is on screen, conclude immediately in that step.

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

Based on the goal and current page state, decide the next JSON action (include "thought" and if the product price is on screen, declare "done" immediately!):`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

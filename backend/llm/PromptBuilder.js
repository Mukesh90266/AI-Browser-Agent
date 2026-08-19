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

### TASK PATTERNS & COMPLETION CRITERIA:
1. **Flight Search & Booking Tasks (e.g., "Find cheapest flight...", "Book flight...")**:
   - Step 1: Search the query on Google or Bing.
   - Step 2: Click on a top booking website link (e.g. MakeMyTrip, EaseMyTrip, Yatra, Google Flights, Cleartrip) to open the live flight results.
   - Step 3: On the booking site or flight widget, view the available flights and prices.
   - Step 4: Once you see the flight prices, airline names (e.g. IndiGo, SpiceJet, Air India), and timings, conclude with:
     {"action": "done", "success": true, "result": "Cheapest flight from [Origin] to [Destination] on [Date]: [Airline] at ₹[Price]. Visible on [Website]."}

2. **Shopping / Product Search (e.g., "Find laptop under 50k", "Add earphones to cart")**:
   - Search, click into the e-commerce product page (e.g. Amazon, Flipkart), locate the item and price/cart button, then declare "done".

3. **Information / Fact Lookup (e.g., "What is the capital of...", "Who founded...")**:
   - Search, read the direct answer from the page text snippets or click the top reference link (e.g. Wikipedia), then declare "done".

4. **Form Filling**:
   - Fill required fields sequentially, click submit, verify confirmation, then emit "done".

5. **Stopping Rule**:
   - When the user's goal has been achieved and the final website/prices are on screen, do NOT perform unnecessary extra clicks or endless scrolling. Emit {"action": "done", "success": true, "result": "..."}.

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
        ? `\n--- KEY VISIBLE TEXT ON PAGE ---\n${pageTextSnippets.slice(0, 25).map((t, i) => `[${i + 1}] ${t}`).join('\n')}\n`
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

Based on the goal and current page state, what is the single next JSON action?`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

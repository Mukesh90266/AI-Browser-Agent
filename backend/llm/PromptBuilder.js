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

### CRITICAL RULES & STOPPING CRITERIA (TASK 19):
1. **IMMEDIATE COMPLETION WHEN ANSWER IS FOUND**:
   - As soon as the information, answer, flight prices, search results, or requested goal can be answered from the "KEY VISIBLE TEXT ON PAGE" or interactive elements, DO NOT perform redundant clicks on unrelated inputs or scroll endlessly!
   - IMMEDIATELY emit: {"action": "done", "success": true, "result": "<complete detailed answer with relevant info/prices/dates>"}
2. **Initial Navigation**: If starting from a blank page, navigate to Google ("https://www.google.com") or Bing ("https://www.bing.com") or direct site.
3. **Form Filling**: Fill required fields sequentially, submit, and upon confirmation message emit "done".
4. **Shopping / Actions**: Search, click product, execute action (e.g. Add to Cart), verify, then emit "done".
5. **No Redundant Clicking**: If search results are already on screen, read them and declare "done". Do not click search bars or dates again unless needed.
6. **Failure / Block**: If blocked or info not found after checking, emit {"action": "done", "success": false, "result": "<explanation>"}.

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
        ? `\n--- KEY VISIBLE TEXT ON PAGE (Read this to answer the goal if possible) ---\n${pageTextSnippets.slice(0, 15).map((t, i) => `[${i + 1}] ${t}`).join('\n')}\n`
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

Based on the goal and current page state, what is the single next JSON action? (If the answer is visible above, respond with "done" immediately!)`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

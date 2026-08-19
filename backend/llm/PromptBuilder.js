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

### CORE REASONING & DECISION RULES:
1. **Initial Navigation**: If starting from a blank page or no specific URL was loaded, navigate to the relevant website or a major search engine (e.g. "https://www.google.com" or "https://www.bing.com").
2. **Element Targeting**: Only target elements by their exact numeric Element# ID shown in the current element list.
3. **Information Tasks (Q&A / Fact finding)**: If the goal is to look up information (e.g. flight prices, dates, definitions, weather, top results), inspect the visible page text and headings. Once the answer is found, conclude immediately with "done" (success: true) and state the complete answer in "result".
4. **Form Filling**: Fill required fields one by one with appropriate values matching the goal, then click the submit button.
5. **E-commerce / Shopping**: Search for the requested item, click a matching result, find and click the action button (e.g., "Add to Cart"), then declare "done".
6. **Task Completion & Stopping (Task 19)**:
   - When the user goal has been achieved, do NOT continue clicking or looping. Emit {"action": "done", "success": true, "result": "..."}.
   - If blocked (e.g. captcha, unresolvable error, missing item after exhaustive search), emit {"action": "done", "success": false, "result": "<explanation>"}.
7. **Chunk Pagination**: If a page has many elements and the element you need is not visible in the current chunk, use {"action": "next_chunk"}.
8. **Loop Prevention**: Never repeat the exact same action repeatedly if it has no effect. If an action fails, try an alternative path or scroll.

### STRICT OUTPUT FORMAT:
Output ONLY a single valid JSON object. Do not include markdown ticks (\`\`\`json), explanations, or any conversational text.`;

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
    maxSteps = 15,
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
        if (chunkInfo.chunkNumber >= chunkInfo.totalChunks) {
            chunkHeader += '\n(Note: This is the last chunk of elements for this viewport)';
        }
    }

    const textContentSection = pageTextSnippets.length > 0
        ? `\n--- KEY VISIBLE TEXT ON PAGE ---\n${pageTextSnippets.slice(0, 10).map(t => `• ${t}`).join('\n')}\n`
        : '';

    const errorSection = lastError
        ? `\n⚠️ PREVIOUS ACTION ERROR: ${lastError}\nPlease choose an alternative action or recovery step.\n`
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

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
- {"thought": "...", "action": "done", "success": true/false, "result": "<detailed answer or summary of accomplishment>"}

### SEARCH & INFORMATION EXTRACTION RULES:
1. **Search Results -> Click Link when Direct Answer is Missing**:
   - If you are on a search results page (Google / Bing):
     * If the direct answer (e.g. Temperature "31°C", flight price, or fact) is visible in the text/snippets below -> EMIT "done" IMMEDIATELY.
     * If the direct answer is NOT on the search page -> **DO NOT keep scrolling up and down on the search page! CLICK on the top relevant organic result link (e.g. For weather: AccuWeather/Weather.com/Skymet; For rankings/table: ICC/ESPNcricinfo; For facts: Wikipedia)** to open the actual website and read the answer.
     * Once on the destination website, read the data and emit "done".

2. **Accurate "Cheapest" / "Lowest Price" Comparison**:
   - Compare all visible "[PRODUCT OPTION]" prices mathematically and select the true minimum price item.

3. **Stopping Rule**:
   - Once you have the answer, declare "done" immediately. Never repeat searches or scroll without taking action.

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

Based on the goal and current page state, decide the next JSON action (include "thought" and remember: if direct answer is not in search snippets, click the top relevant website link!):`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

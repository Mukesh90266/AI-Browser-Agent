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
- {"thought": "...", "action": "done", "success": true/false, "result": "<detailed answer with exact price, airline/brand, and source website>"}

### FAST & ACCURATE FLIGHT, SHOPPING & INFORMATION WORKFLOW:
1. **Flight Search & Multi-Source Price Reporting**:
   - **Step 1**: Search the query on Google or Bing.
   - **Step 2**: Note the benchmark prices shown in the search overview / flight card (e.g. ₹3,872 lowest on Bing/Google Flights overview).
   - **Step 3**: Click a top booking site link (e.g. ixigo, MakeMyTrip, EaseMyTrip, IndiGo).
   - **Step 4**: If the booking site shows flight fares, extract the live fare. If the booking site lands on a complex blank form or gets blocked, DO NOT get stuck scrolling indefinitely—use the verified search overview benchmark and conclude promptly!
   - **Step 5**: In the final result, clearly attribute where the price came from:
     "Lowest Price: ₹[Amount] ([Airline] via [Source Website/Search Overview]); Highest/Alternative: ₹[Amount] ([Airline])."

2. **Shopping / Product Comparison**:
   - Compare all visible "[PRODUCT OPTION]" items and state the lowest price, brand/model, and seller website.

3. **General Q&A / Facts**:
   - Read the answer and declare "done" immediately with clear source attribution.

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

Based on the goal and current page state, decide the next JSON action (include "thought" and specify price sources in result):`;
}

module.exports = {
    SYSTEM_PROMPT,
    buildUserPrompt,
};

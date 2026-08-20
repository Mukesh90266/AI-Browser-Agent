// MessageManager.js — Coordinates context preparation, history trimming, and prompt formatting

const { SYSTEM_PROMPT, buildUserPrompt } = require('../llm/PromptBuilder');
const { formatForLLM } = require('../browser/DOMExtractor');

class MessageManager {
    constructor() {
        this.systemPrompt = SYSTEM_PROMPT;
    }

    /**
     * Constructs the full prompt payload for the LLM decision step.
     */
    preparePrompt({
        goal,
        currentUrl,
        pageTitle,
        pageTextSnippets,
        elementsChunk,
        actionHistory,
        chunkInfo,
        step,
        maxSteps,
        lastError,
    }) {
        const elementListText = formatForLLM(elementsChunk);

        // Keep the most recent 10 actions to avoid blowing LLM context window
        const trimmedHistory = actionHistory.slice(-10);

        const userPrompt = buildUserPrompt({
            goal,
            currentUrl,
            pageTitle,
            pageTextSnippets,
            elementListText,
            actionHistory: trimmedHistory,
            chunkInfo,
            step,
            maxSteps,
            lastError,
        });

        return {
            systemPrompt: this.systemPrompt,
            userPrompt,
        };
    }
}

module.exports = MessageManager;

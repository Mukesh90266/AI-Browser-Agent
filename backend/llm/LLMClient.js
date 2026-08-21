// LLMClient.js — Handles LLM API communication via Groq SDK with automatic fallback

const Groq = require('groq-sdk');
require('dotenv').config();
const { DEFAULT_CONFIG, FALLBACK_MODELS } = require('../utils/constants');
const logger = require('../utils/logger');

const DEFAULT_COMPLETION_TOKENS = 1024;
const MIN_COMPLETION_TOKENS = 768;

let groqInstance = null;
let activeWorkingModel = null;

function getGroqClient() {
    if (!groqInstance) {
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            logger.warn('GROQ_API_KEY environment variable is not set. Real LLM calls will fail without API key.');
        }
        groqInstance = new Groq({ apiKey: apiKey || 'dummy-key' });
    }
    return groqInstance;
}

/**
 * Builds a Groq request with enough completion space to finish valid JSON.
 * GPT-OSS uses completion tokens for reasoning too, so a 384-token limit can
 * expire before the final JSON action is emitted.
 */
function buildChatCompletionRequest(model, systemPrompt, userPrompt, options = {}) {
    const requestedTokens = Number(
        options.max_completion_tokens ?? options.max_tokens ?? DEFAULT_COMPLETION_TOKENS,
    );
    const completionTokens = Number.isInteger(requestedTokens) && requestedTokens > 0
        ? Math.max(requestedTokens, MIN_COMPLETION_TOKENS)
        : DEFAULT_COMPLETION_TOKENS;

    const request = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: options.temperature ?? 0.1,
        max_completion_tokens: completionTokens,
        response_format: { type: 'json_object' },
    };

    // GPT-OSS defaults to medium reasoning, which can consume a small output
    // budget before it writes the JSON object. Low reasoning is sufficient for
    // choosing one browser action and is both faster and more reliable.
    if (/^openai\/gpt-oss-/i.test(model)) {
        request.reasoning_effort = options.reasoning_effort || 'low';
    }

    return request;
}

/**
 * Executes chat completion with specified model.
 */
async function callChatCompletion(groq, model, systemPrompt, userPrompt, options = {}) {
    const completion = await groq.chat.completions.create(
        buildChatCompletionRequest(model, systemPrompt, userPrompt, options),
    );

    return completion.choices[0]?.message?.content || '';
}

/**
 * Sends system and user prompts to Groq LLM and returns raw response string.
 * Automatically tries fallback models if the primary model is deprecated or not found (404).
 */
async function getNextAction(systemPrompt, userPrompt, options = {}) {
    const groq = getGroqClient();
    const requestedModel = options.model || activeWorkingModel || process.env.GROQ_MODEL || DEFAULT_CONFIG.DEFAULT_MODEL;

    // Create candidate model queue starting with requested model
    const candidateModels = [
        requestedModel,
        ...FALLBACK_MODELS.filter(m => m !== requestedModel),
    ];

    let lastError = null;

    for (const model of candidateModels) {
        try {
            logger.debug(`Attempting LLM call with model: ${model}`);
            const rawResponse = await callChatCompletion(groq, model, systemPrompt, userPrompt, options);

            // Remember the working model for future calls
            if (activeWorkingModel !== model) {
                activeWorkingModel = model;
                logger.info(`Using active Groq model: ${model}`);
            }

            return rawResponse;
        } catch (err) {
            lastError = err;
            const isModelNotFoundError =
                err.status === 404 ||
                err.code === 'model_not_found' ||
                (err.message && (err.message.includes('does not exist') || err.message.includes('model_not_found') || err.message.includes('deprecated')));

            if (isModelNotFoundError) {
                logger.warn(`Model "${model}" not available on Groq (404/deprecated) — trying next fallback model...`);
                continue;
            }

            // Preserve the one-request-per-step latency guard. JSON failures are
            // made substantially less likely by the safe token budget above; if
            // one still occurs, AgentRunner records it and recovers next step.
            logger.error(`Groq API communication error on model "${model}": ${err.message}`);
            throw err;
        }
    }

    logger.error(`All candidate Groq models failed. Last error: ${lastError?.message}`);
    throw lastError;
}

module.exports = {
    getNextAction,
    callChatCompletion,
    buildChatCompletionRequest,
    DEFAULT_COMPLETION_TOKENS,
    MIN_COMPLETION_TOKENS,
};

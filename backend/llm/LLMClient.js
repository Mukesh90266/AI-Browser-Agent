// LLMClient.js — Handles LLM API communication via Groq SDK

const Groq = require('groq-sdk');
require('dotenv').config();
const { DEFAULT_CONFIG } = require('../utils/constants');
const logger = require('../utils/logger');

let groqInstance = null;

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
 * Sends system and user prompts to Groq LLM and returns raw response string.
 */
async function getNextAction(systemPrompt, userPrompt, options = {}) {
    const groq = getGroqClient();
    const model = options.model || process.env.GROQ_MODEL || DEFAULT_CONFIG.DEFAULT_MODEL;

    logger.debug(`Sending prompt to LLM (model: ${model}, prompt chars: ${userPrompt.length})`);

    try {
        const completion = await groq.chat.completions.create({
            model: model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: options.temperature ?? 0.1, // Low temperature for deterministic action execution
            max_tokens: options.max_tokens ?? 1024,
            response_format: { type: 'json_object' },
        });

        const raw = completion.choices[0]?.message?.content || '';
        logger.debug(`LLM Response: ${raw}`);
        return raw;
    } catch (err) {
        logger.error(`Groq API communication error: ${err.message}`);
        throw err;
    }
}

module.exports = {
    getNextAction,
};

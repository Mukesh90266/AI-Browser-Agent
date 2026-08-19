// ActionParser.js — Parses and validates structured JSON actions returned by LLM

const { validateActionSchema } = require('../utils/validators');

/**
 * Extracts and parses JSON action from raw LLM output text.
 * Strips markdown code blocks and validates schema.
 */
function parseAction(rawResponse) {
    if (!rawResponse || typeof rawResponse !== 'string' || rawResponse.trim() === '') {
        throw new Error('LLM returned an empty or invalid response');
    }

    let cleaned = rawResponse.trim();

    // 1. Remove markdown code blocks like ```json ... ``` or ``` ... ```
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
        cleaned = codeBlockMatch[1].trim();
    }

    // 2. Extract JSON object substring if extra commentary is present
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    // 3. Parse JSON
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (parseErr) {
        throw new Error(`Failed to parse LLM response as JSON: ${rawResponse.slice(0, 200)}`);
    }

    // 4. Validate schema
    const validation = validateActionSchema(parsed);
    if (!validation.valid) {
        throw new Error(`Invalid action format: ${validation.error}`);
    }

    // 5. Ensure numeric types for element_id
    if (parsed.element_id !== undefined && parsed.element_id !== null) {
        parsed.element_id = parseInt(parsed.element_id, 10);
    }

    // 6. Preserve thought
    if (parsed.thought || parsed.reasoning) {
        parsed.thought = (parsed.thought || parsed.reasoning).toString();
    }

    return parsed;
}

module.exports = {
    parseAction,
};

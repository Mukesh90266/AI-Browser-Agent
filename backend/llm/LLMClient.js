// LLMClient.js — Handles API communication with Groq LLM service
// LLMClient.js — Groq API se connect karke agent ke liye next action lena

const Groq = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getNextAction(systemPrompt, userPrompt) {
    try {
        console.log('\n--- DEBUG: FULL PROMPT BEING SENT ---');
        console.log('System prompt length:', systemPrompt.length);
        console.log('User prompt length:', userPrompt.length);
        console.log('User prompt (first 500 chars):', userPrompt.slice(0, 500));
        console.log('--- END DEBUG ---\n');
        const completion = await groq.chat.completions.create({
            model: 'openai/gpt-oss-20b',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,       // low temp — consistent, predictable actions
            max_tokens: 1024,
            // response_format: { type: 'json_object' },  // strict JSON output
        });

        const raw = completion.choices[0]?.message?.content;
        console.log(`🧠 LLM raw response: ${raw}`);

        return raw;
    } catch (err) {
        console.error('❌ Groq API error:', err.message);
        throw err;
    }
}

module.exports = { getNextAction };
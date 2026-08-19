function parseAction(rawResponse) {
    if (!rawResponse || rawResponse.trim() === '') {
        throw new Error('LLM se khali response mila');
    }

    let cleaned = rawResponse.trim();

    // Code block hata do
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        cleaned = codeBlockMatch[1].trim();
    }

    // JSON object extract karo
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (e) {
        throw new Error(`Valid JSON nahi: ${rawResponse.substring(0, 200)}`);
    }

    const validActions = ['click', 'type', 'scroll', 'navigate', 'done', 'next_chunk', 'enter'];

    if (!parsed.action || !validActions.includes(parsed.action)) {
        throw new Error(`Invalid action: "${parsed.action}". Valid: ${validActions.join(', ')}`);
    }

    // Validations
    if (parsed.action === 'click' && typeof parsed.element_id !== 'number') {
        throw new Error('Click mein element_id number hona chahiye');
    }

    if (parsed.action === 'type') {
        if (typeof parsed.element_id !== 'number' || typeof parsed.text !== 'string') {
            throw new Error('Type mein element_id (number) aur text (string) chahiye');
        }
    }

    if (parsed.action === 'navigate' && typeof parsed.url !== 'string') {
        throw new Error('Navigate mein url string honi chahiye');
    }

    if (parsed.action === 'done') {
        // success field default true karo agar missing hai
        if (typeof parsed.success !== 'boolean') {
            parsed.success = true;
        }
        if (!parsed.result || typeof parsed.result !== 'string') {
            parsed.result = parsed.success ? 'Task completed' : 'Task incomplete';
        }
    }

    if (parsed.action === 'scroll') {
        if (!['up', 'down'].includes(parsed.direction)) {
            parsed.direction = 'down'; // default
        }
    }

    return parsed;
}

module.exports = { parseAction };
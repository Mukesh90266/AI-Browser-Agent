// validators.js — Validation functions for user goals, URLs, and action schemas

const { ACTION_TYPES } = require('./constants');

function validateGoal(goal) {
    if (!goal || typeof goal !== 'string' || goal.trim().length === 0) {
        throw new Error('User goal must be a non-empty string');
    }
    return goal.trim();
}

function isValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function validateActionSchema(action) {
    if (!action || typeof action !== 'object') {
        return { valid: false, error: 'Action must be a JSON object' };
    }

    const validActions = Object.values(ACTION_TYPES);
    if (!action.action || !validActions.includes(action.action)) {
        return {
            valid: false,
            error: `Invalid action type: "${action.action}". Allowed: ${validActions.join(', ')}`,
        };
    }

    switch (action.action) {
        case ACTION_TYPES.CLICK:
            if (typeof action.element_id !== 'number') {
                return { valid: false, error: 'click action requires numeric "element_id"' };
            }
            break;

        case ACTION_TYPES.TYPE:
            if (typeof action.element_id !== 'number' || typeof action.text !== 'string') {
                return { valid: false, error: 'type action requires numeric "element_id" and string "text"' };
            }
            break;

        case ACTION_TYPES.SELECT:
            if (typeof action.element_id !== 'number' || typeof action.value !== 'string') {
                return { valid: false, error: 'select action requires numeric "element_id" and string "value"' };
            }
            break;

        case ACTION_TYPES.NAVIGATE:
            if (typeof action.url !== 'string' || !isValidUrl(action.url)) {
                return { valid: false, error: 'navigate action requires a valid http/https "url"' };
            }
            break;

        case ACTION_TYPES.SCROLL:
            if (action.direction && !['up', 'down'].includes(action.direction)) {
                action.direction = 'down';
            }
            break;

        case ACTION_TYPES.WAIT:
            if (action.seconds && typeof action.seconds !== 'number') {
                action.seconds = 2;
            }
            break;

        case ACTION_TYPES.DONE:
            if (typeof action.success !== 'boolean') {
                action.success = true;
            }
            if (typeof action.result !== 'string' || action.result.trim().length === 0) {
                action.result = action.success ? 'Task completed successfully' : 'Task could not be completed';
            }
            break;

        case ACTION_TYPES.ENTER:
        case ACTION_TYPES.GO_BACK:
        case ACTION_TYPES.NEXT_CHUNK:
            break;

        default:
            return { valid: false, error: `Unknown action: ${action.action}` };
    }

    return { valid: true, action };
}

module.exports = {
    validateGoal,
    isValidUrl,
    validateActionSchema,
};

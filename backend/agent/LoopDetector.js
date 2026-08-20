// LoopDetector.js — Detects repetitive actions, deadlocks, and cycling states during agent execution

const { DEFAULT_CONFIG } = require('../utils/constants');

class LoopDetector {
    constructor(threshold = DEFAULT_CONFIG.MAX_REPEATED_ACTIONS) {
        this.threshold = threshold;
        this.actionHistory = [];
        this.urlHistory = [];
    }

    reset() {
        this.actionHistory = [];
        this.urlHistory = [];
    }

    /**
     * Serializes action into comparable signature string.
     */
    getActionSignature(action) {
        if (!action) return '';
        if (action.action === 'click') return `click:${action.element_id}`;
        if (action.action === 'type') return `type:${action.element_id}:${action.text}`;
        if (action.action === 'select') return `select:${action.element_id}:${action.value}`;
        if (action.action === 'navigate') return `navigate:${action.url}`;
        if (action.action === 'scroll') return `scroll:${action.direction}`;
        if (action.action === 'enter') return 'enter';
        if (action.action === 'wait') return 'wait';
        if (action.action === 'next_chunk') return 'next_chunk';
        return JSON.stringify(action);
    }

    /**
     * Checks if newAction creates a repetitive loop.
     */
    checkActionLoop(newAction) {
        const sig = this.getActionSignature(newAction);
        this.actionHistory.push(sig);

        // Check last N consecutive actions
        if (this.actionHistory.length >= this.threshold) {
            const recent = this.actionHistory.slice(-this.threshold);
            const allSame = recent.every(item => item === sig);
            if (allSame) {
                return {
                    isLoop: true,
                    reason: `Repeated the same action "${sig}" ${this.threshold} times consecutively`,
                    count: this.threshold,
                };
            }
        }

        // Check for 3 consecutive next_chunk calls
        if (this.actionHistory.length >= 3) {
            const last3 = this.actionHistory.slice(-3);
            if (last3.every(item => item === 'next_chunk')) {
                return {
                    isLoop: true,
                    reason: 'Repeated next_chunk without progress. You must type in search bar, click a product, or conclude.',
                    count: 3,
                };
            }
        }

        // Check for 4 consecutive scrolls on same page
        if (this.actionHistory.length >= 4) {
            const last4 = this.actionHistory.slice(-4);
            const allScrolls = last4.every(item => item.startsWith('scroll:'));
            if (allScrolls) {
                return {
                    isLoop: true,
                    reason: 'Excessive scrolling detected on the same page. Click a relevant link or conclude with best available data.',
                    count: 4,
                };
            }
        }

        // Check for 2-step ping-pong loop: [A, B, A, B, A, B]
        if (this.actionHistory.length >= 6) {
            const last6 = this.actionHistory.slice(-6);
            if (last6[0] === last6[2] && last6[2] === last6[4] &&
                last6[1] === last6[3] && last6[3] === last6[5] &&
                last6[0] !== last6[1]) {
                return {
                    isLoop: true,
                    reason: `Detected oscillating action pattern between "${last6[0]}" and "${last6[1]}"`,
                    count: 6,
                };
            }
        }

        return { isLoop: false };
    }

    /**
     * Tracks URLs visited to detect infinite redirects or navigation loops.
     */
    checkUrlLoop(url) {
        if (!url) return { isLoop: false };
        this.urlHistory.push(url);

        if (this.urlHistory.length >= 6) {
            const last6 = this.urlHistory.slice(-6);
            if (last6[0] === last6[2] && last6[2] === last6[4] &&
                last6[1] === last6[3] && last6[3] === last6[5] &&
                last6[0] !== last6[1]) {
                return {
                    isLoop: true,
                    reason: `Detected oscillating URL navigation loop between ${last6[0]} and ${last6[1]}`,
                };
            }
        }

        return { isLoop: false };
    }
}

module.exports = LoopDetector;

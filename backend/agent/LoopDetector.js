// LoopDetector.js — Detects repetitive actions, deadlocks, and cycling states during agent execution

const { DEFAULT_CONFIG } = require('../utils/constants');

const DEFAULT_NEXT_CHUNK_THRESHOLD = 3;
const DEFAULT_OSCILLATION_CYCLES = 3;
const MAX_HISTORY_SIZE = 100;

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class LoopDetector {
    constructor(options = {}) {
        // Keep the original numeric constructor API: new LoopDetector(3)
        const normalizedOptions = typeof options === 'number'
            ? { repeatedActionThreshold: options }
            : options;

        this.threshold = toPositiveInteger(
            normalizedOptions.repeatedActionThreshold ?? normalizedOptions.threshold,
            DEFAULT_CONFIG.MAX_REPEATED_ACTIONS,
        );
        this.maxScrollAttempts = toPositiveInteger(
            normalizedOptions.maxScrollAttempts,
            DEFAULT_CONFIG.MAX_SCROLL_ATTEMPTS,
        );
        this.nextChunkThreshold = toPositiveInteger(
            normalizedOptions.nextChunkThreshold,
            DEFAULT_NEXT_CHUNK_THRESHOLD,
        );
        this.oscillationCycles = Math.max(
            2,
            toPositiveInteger(normalizedOptions.oscillationCycles, DEFAULT_OSCILLATION_CYCLES),
        );

        this.reset();
    }

    reset() {
        this.actionHistory = [];
        this.actionUrlHistory = [];
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
        if (action.action === 'scroll') return `scroll:${action.direction || 'down'}`;
        if (action.action === 'enter') return 'enter';
        if (action.action === 'wait') return `wait:${action.seconds || 2}`;
        if (action.action === 'next_chunk') return 'next_chunk';
        return JSON.stringify(action);
    }

    trimHistory(history) {
        if (history.length > MAX_HISTORY_SIZE) {
            history.splice(0, history.length - MAX_HISTORY_SIZE);
        }
    }

    actionsOccurredOnSamePage(count) {
        const recentUrls = this.actionUrlHistory.slice(-count).filter(Boolean);
        // Direct LoopDetector users may omit URLs; preserve action-only detection in that case.
        return recentUrls.length === 0 || (
            recentUrls.length === count && recentUrls.every(url => url === recentUrls[0])
        );
    }

    /**
     * Checks if newAction creates a repetitive loop on the current page.
     */
    checkActionLoop(newAction, currentUrl = null) {
        const sig = this.getActionSignature(newAction);
        this.actionHistory.push(sig);
        this.actionUrlHistory.push(currentUrl || '');
        this.trimHistory(this.actionHistory);
        this.trimHistory(this.actionUrlHistory);

        // Check the configured number of consecutive identical actions on one page.
        if (this.actionHistory.length >= this.threshold) {
            const recent = this.actionHistory.slice(-this.threshold);
            const allSame = recent.every(item => item === sig);
            if (allSame && this.actionsOccurredOnSamePage(this.threshold)) {
                return {
                    isLoop: true,
                    type: 'repeated_action',
                    reason: `Repeated the same action "${sig}" ${this.threshold} times consecutively on the same page`,
                    count: this.threshold,
                };
            }
        }

        // Repeated next_chunk means all configured DOM chunks were exhausted without progress.
        if (this.actionHistory.length >= this.nextChunkThreshold) {
            const recent = this.actionHistory.slice(-this.nextChunkThreshold);
            if (
                recent.every(item => item === 'next_chunk') &&
                this.actionsOccurredOnSamePage(this.nextChunkThreshold)
            ) {
                return {
                    isLoop: true,
                    type: 'next_chunk_loop',
                    reason: `Repeated next_chunk ${this.nextChunkThreshold} times without progress on the same page`,
                    count: this.nextChunkThreshold,
                };
            }
        }

        // Stop excessive consecutive scrolling only when it occurs on the same page.
        if (this.actionHistory.length >= this.maxScrollAttempts) {
            const recent = this.actionHistory.slice(-this.maxScrollAttempts);
            if (
                recent.every(item => item.startsWith('scroll:')) &&
                this.actionsOccurredOnSamePage(this.maxScrollAttempts)
            ) {
                return {
                    isLoop: true,
                    type: 'scroll_loop',
                    reason: `Exceeded ${this.maxScrollAttempts} consecutive scroll attempts without leaving the current page`,
                    count: this.maxScrollAttempts,
                };
            }
        }

        // Check a two-action ping-pong pattern: A, B, A, B, A, B.
        const patternLength = this.oscillationCycles * 2;
        if (this.actionHistory.length >= patternLength) {
            const recent = this.actionHistory.slice(-patternLength);
            const first = recent[0];
            const second = recent[1];
            const alternates = first !== second && recent.every((item, index) => (
                index % 2 === 0 ? item === first : item === second
            ));

            if (alternates && this.actionsOccurredOnSamePage(patternLength)) {
                return {
                    isLoop: true,
                    type: 'action_oscillation',
                    reason: `Detected oscillating action pattern between "${first}" and "${second}"`,
                    count: patternLength,
                };
            }
        }

        return { isLoop: false };
    }

    /**
     * Tracks visited URLs to detect A/B/A/B navigation loops.
     */
    checkUrlLoop(url) {
        if (!url) return { isLoop: false };
        this.urlHistory.push(url);
        this.trimHistory(this.urlHistory);

        const patternLength = this.oscillationCycles * 2;
        if (this.urlHistory.length >= patternLength) {
            const recent = this.urlHistory.slice(-patternLength);
            const first = recent[0];
            const second = recent[1];
            const alternates = first !== second && recent.every((item, index) => (
                index % 2 === 0 ? item === first : item === second
            ));

            if (alternates) {
                return {
                    isLoop: true,
                    type: 'url_oscillation',
                    reason: `Detected oscillating URL navigation loop between ${first} and ${second}`,
                    count: patternLength,
                };
            }
        }

        return { isLoop: false };
    }
}

module.exports = LoopDetector;

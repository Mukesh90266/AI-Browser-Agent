// StateManager.js — Manages execution state, step history, and lifecycle status for the AI agent

const { AGENT_STATUS, DEFAULT_CONFIG } = require('../utils/constants');

class StateManager {
    constructor(maxSteps = DEFAULT_CONFIG.MAX_STEPS) {
        this.maxSteps = maxSteps;
        this.reset();
    }

    reset() {
        this.goal = '';
        this.status = AGENT_STATUS.IDLE;
        this.stepCount = 0;
        this.history = [];
        this.currentUrl = 'about:blank';
        this.pageTitle = '';
        this.result = null;
        this.error = null;
        this.startTime = null;
        this.endTime = null;
    }

    start(goal, maxSteps = null) {
        this.reset();
        this.goal = goal;
        if (maxSteps) this.maxSteps = maxSteps;
        this.status = AGENT_STATUS.RUNNING;
        this.startTime = Date.now();
    }

    recordStep({ step, action, executionResult, url, title }) {
        this.stepCount = step;
        this.currentUrl = url || this.currentUrl;
        this.pageTitle = title || this.pageTitle;

        const record = {
            step,
            action,
            success: executionResult?.success ?? true,
            error: executionResult?.error || null,
            message: executionResult?.message || null,
            url: this.currentUrl,
            timestamp: new Date().toISOString(),
        };

        this.history.push(record);
        return record;
    }

    setCompleted(result) {
        this.status = AGENT_STATUS.COMPLETED;
        this.result = result;
        this.endTime = Date.now();
    }

    setFailed(error) {
        this.status = AGENT_STATUS.FAILED;
        this.error = error;
        this.endTime = Date.now();
    }

    setStopped(reason = 'Execution stopped by user or safety limit') {
        this.status = AGENT_STATUS.STOPPED;
        this.result = reason;
        this.endTime = Date.now();
    }

    getState() {
        return {
            goal: this.goal,
            status: this.status,
            stepCount: this.stepCount,
            maxSteps: this.maxSteps,
            history: this.history,
            currentUrl: this.currentUrl,
            pageTitle: this.pageTitle,
            result: this.result,
            error: this.error,
            durationMs: this.endTime ? (this.endTime - this.startTime) : (this.startTime ? Date.now() - this.startTime : 0),
        };
    }

    getSummary() {
        return {
            status: this.status,
            stepsUsed: this.stepCount,
            maxSteps: this.maxSteps,
            isSuccess: this.status === AGENT_STATUS.COMPLETED,
            result: this.result,
            error: this.error,
            totalActions: this.history.length,
        };
    }
}

module.exports = StateManager;

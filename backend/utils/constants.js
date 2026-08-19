// constants.js — System-wide constants, default configurations, and action types

const ACTION_TYPES = {
    CLICK: 'click',
    TYPE: 'type',
    SELECT: 'select',
    ENTER: 'enter',
    SCROLL: 'scroll',
    NAVIGATE: 'navigate',
    GO_BACK: 'go_back',
    WAIT: 'wait',
    NEXT_CHUNK: 'next_chunk',
    DONE: 'done',
};

const AGENT_STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    STOPPED: 'stopped',
};

const DEFAULT_CONFIG = {
    MAX_STEPS: 15,
    CHUNK_SIZE: 50,
    MAX_CHUNKS_PER_PAGE: 5,
    MAX_SCROLL_ATTEMPTS: 3,
    MAX_REPEATED_ACTIONS: 3,
    ACTION_TIMEOUT_MS: 10000,
    NAVIGATION_TIMEOUT_MS: 30000,
    STEP_DELAY_MS: 1500,
    DEFAULT_SEARCH_ENGINE: 'https://www.google.com',
    DEFAULT_MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
};

const CLOSE_SELECTORS = [
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    '[aria-label="Close dialog"]',
    'button[title="Close"]',
    'button:has-text("✕")',
    'button:has-text("×")',
    'button:has-text("Dismiss")',
    'button:has-text("Accept all")',
    'button:has-text("Accept cookies")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    '[class*="close" i]:visible',
    '[class*="modal-close" i]',
    '[class*="popup-close" i]',
    '[class*="dialog-close" i]',
    'button._2KpZ6l._2doB4z', // Common e-commerce popup close button
];

const MODAL_KEYWORDS = [
    'login',
    'sign in',
    'sign up',
    'signup',
    'create account',
    'cookie',
    'newsletter',
    'subscribe',
    'discount',
];

module.exports = {
    ACTION_TYPES,
    AGENT_STATUS,
    DEFAULT_CONFIG,
    CLOSE_SELECTORS,
    MODAL_KEYWORDS,
};

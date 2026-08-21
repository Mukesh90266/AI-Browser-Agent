// test-task-18-19.js — Verification Suite for Task 18 (LLM Decision Loop) & Task 19 (Goal Completion & Safety)
//
// Tests:
// 1. PromptBuilder generic generation (no hardcoded website bias)
// 2. ActionParser JSON parsing, schema validation & sanitization
// 3. StateManager lifecycle & history tracking
// 4. LoopDetector repetitive action & oscillating navigation detection
// 5. ActionExecutor generic action dispatching
// 6. Task 19 Goal Completion logic (done action handling)
// 7. Task 19 Safety limit logic (max-steps enforcement)
// 8. Task 19 Deadlock / Loop prevention logic

const assert = require('assert');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./llm/PromptBuilder');
const { parseAction } = require('./llm/ActionParser');
const StateManager = require('./agent/StateManager');
const LoopDetector = require('./agent/LoopDetector');
const MessageManager = require('./agent/MessageManager');
const { AgentRunner } = require('./agent/AgentRunner');
const { formatForLLM } = require('./browser/DOMExtractor');
const { performAddToCart } = require('./browser/ActionExecutor');
const { didCartStateAdvance } = require('./browser/CartInspector');
const { ACTION_TYPES, AGENT_STATUS } = require('./utils/constants');
const { validateGoal, validateActionSchema, isValidUrl } = require('./utils/validators');

const results = [];

function test(name, fn) {
    try {
        fn();
        console.log(`✅ PASS: ${name}`);
        results.push({ name, pass: true });
    } catch (err) {
        console.error(`❌ FAIL: ${name}`);
        console.error(`   ${err.message}`);
        results.push({ name, pass: false, error: err.message });
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        console.log(`✅ PASS: ${name}`);
        results.push({ name, pass: true });
    } catch (err) {
        console.error(`❌ FAIL: ${name}`);
        console.error(`   ${err.message}`);
        results.push({ name, pass: false, error: err.message });
    }
}

async function runAllTests() {
    console.log('\n' + '═'.repeat(65));
    console.log('🧪 TASK 18 & TASK 19 COMPREHENSIVE VERIFICATION TEST SUITE');
    console.log('═'.repeat(65) + '\n');

    // ─── TASK 18: PromptBuilder & Genericity ─────────────────────────
    test('Task 18: System Prompt is generic and contains no website-specific bias', () => {
        assert(!SYSTEM_PROMPT.includes('amazon'), 'System prompt should not hardcode Amazon');
        assert(!SYSTEM_PROMPT.includes('flipkart'), 'System prompt should not hardcode Flipkart');
        assert(!SYSTEM_PROMPT.includes('cartStatus'), 'System prompt should not hardcode cart status');
        assert(SYSTEM_PROMPT.includes('autonomous AI web browsing agent'), 'System prompt should define role');
        assert(SYSTEM_PROMPT.includes('done'), 'System prompt should define done action');
    });

    test('Task 18: User Prompt formats arbitrary task goals and page state correctly', () => {
        const prompt = buildUserPrompt({
            goal: 'Find the current weather in Tokyo',
            currentUrl: 'https://weather.com',
            pageTitle: 'Tokyo Weather Forecast',
            pageTextSnippets: ['Current temperature: 22°C', 'Humidity: 65%'],
            elementListText: 'Element#1 [text input] placeholder="Search city"\nElement#2 [button] text="Search"',
            actionHistory: [{ action: 'navigate', url: 'https://weather.com' }],
            step: 2,
            maxSteps: 10,
        });

        assert(prompt.includes('USER GOAL: "Find the current weather in Tokyo"'), 'Prompt must include user goal');
        assert(prompt.includes('PAGE TITLE: "Tokyo Weather Forecast"'), 'Prompt must include page title');
        assert(prompt.includes('CURRENT URL: https://weather.com'), 'Prompt must include URL');
        assert(prompt.includes('Current temperature: 22°C'), 'Prompt must include page content snippet');
        assert(prompt.includes('Element#1 [text input]'), 'Prompt must include interactive elements');
        assert(prompt.includes('CURRENT STEP: 2 / 10'), 'Prompt must include step count');
    });

    test('Task 18: Cart controls include product context in LLM element format', () => {
        const formatted = formatForLLM([{
            id: 7,
            type: 'button',
            text: 'ADD',
            context: 'Fresh Milk 1 L — ₹62',
            isCartAction: true,
        }]);

        assert(formatted.includes('text="ADD"'));
        assert(formatted.includes('product="Fresh Milk 1 L — ₹62"'));
    });

    test('Task 18: Action history exposes verified cart execution result to LLM', () => {
        const prompt = buildUserPrompt({
            goal: 'Add milk to cart',
            currentUrl: 'https://shop.example/products',
            elementListText: 'Element#2 [button] text="ADD" product="Milk"',
            actionHistory: [{
                action: { action: 'click', element_id: 2 },
                success: true,
                message: 'Item added to cart and verified (cart badge/count: 1)',
            }],
        });

        assert(prompt.includes('Execution result: "Item added to cart and verified'));
    });

    // ─── TASK 18: ActionParser & Action Schema ───────────────────────
    test('Task 18: ActionParser handles raw JSON and markdown code blocks', () => {
        const raw1 = '```json\n{"action": "click", "element_id": 5}\n```';
        const parsed1 = parseAction(raw1);
        assert.strictEqual(parsed1.action, 'click');
        assert.strictEqual(parsed1.element_id, 5);

        const raw2 = 'Here is the next action: {"action": "type", "element_id": 3, "text": "Delhi", "press_enter": true}';
        const parsed2 = parseAction(raw2);
        assert.strictEqual(parsed2.action, 'type');
        assert.strictEqual(parsed2.element_id, 3);
        assert.strictEqual(parsed2.text, 'Delhi');
    });

    test('Task 18: ActionParser rejects malformed or invalid actions', () => {
        assert.throws(() => parseAction('{"action": "invalid_action"}'), /Invalid action type/);
        assert.throws(() => parseAction('{"action": "click"}'), /requires numeric "element_id"/);
        assert.throws(() => parseAction('{"action": "type", "element_id": 2}'), /string "text"/);
        assert.throws(() => parseAction('{"action": "navigate", "url": "not-a-url"}'), /valid http\/https/);
    });

    // ─── TASK 19: Goal Completion Recognition ────────────────────────
    test('Task 19: ActionParser correctly parses "done" completion action', () => {
        const doneActionRaw = '{"action": "done", "success": true, "result": "Flight price to Paris is $450"}';
        const parsed = parseAction(doneActionRaw);
        assert.strictEqual(parsed.action, 'done');
        assert.strictEqual(parsed.success, true);
        assert.strictEqual(parsed.result, 'Flight price to Paris is $450');
    });

    test('Task 19: StateManager handles completed, failed, and stopped states', () => {
        const sm = new StateManager(10);
        sm.start('Search flights');
        assert.strictEqual(sm.status, AGENT_STATUS.RUNNING);

        sm.recordStep({
            step: 1,
            action: { action: 'navigate', url: 'https://flights.com' },
            executionResult: { success: true },
            url: 'https://flights.com',
            title: 'Flights',
        });

        assert.strictEqual(sm.history.length, 1);
        assert.strictEqual(sm.stepCount, 1);

        sm.setCompleted('Found cheapest flight: $299');
        assert.strictEqual(sm.status, AGENT_STATUS.COMPLETED);
        assert.strictEqual(sm.result, 'Found cheapest flight: $299');

        const summary = sm.getSummary();
        assert.strictEqual(summary.isSuccess, true);
        assert.strictEqual(summary.stepsUsed, 1);
    });

    test('Task 19: Cart verification recognizes badge, summary, and quantity transitions', () => {
        const empty = { hasItems: false, itemCount: 0, quantityControlCount: 0, cartSummary: '' };
        assert.strictEqual(didCartStateAdvance(empty, { ...empty, hasItems: true, itemCount: 1 }), true);
        assert.strictEqual(didCartStateAdvance(empty, { ...empty, hasItems: true, quantityControlCount: 1 }), true);
        assert.strictEqual(didCartStateAdvance(
            { ...empty, hasItems: true, cartSummary: '1 item ₹50' },
            { ...empty, hasItems: true, cartSummary: '2 items ₹100' },
        ), true);
        assert.strictEqual(didCartStateAdvance(empty, empty), false);
    });

    // ─── TASK 19: Safety Limits & Loop Detection ─────────────────────
    test('Task 19: LoopDetector catches repeated identical consecutive actions', () => {
        const detector = new LoopDetector(3);
        const action = { action: 'click', element_id: 4 };

        assert.strictEqual(detector.checkActionLoop(action).isLoop, false);
        assert.strictEqual(detector.checkActionLoop(action).isLoop, false);
        const check3 = detector.checkActionLoop(action);
        assert.strictEqual(check3.isLoop, true);
        assert(check3.reason.includes('3 times consecutively'));
    });

    test('Task 19: LoopDetector catches oscillating 2-step action ping-pong', () => {
        const detector = new LoopDetector(3);
        const actA = { action: 'click', element_id: 1 };
        const actB = { action: 'click', element_id: 2 };

        detector.checkActionLoop(actA);
        detector.checkActionLoop(actB);
        detector.checkActionLoop(actA);
        detector.checkActionLoop(actB);
        detector.checkActionLoop(actA);
        const check6 = detector.checkActionLoop(actB);

        assert.strictEqual(check6.isLoop, true);
        assert(check6.reason.includes('oscillating action pattern'));
    });

    test('Task 19: Loop thresholds are configurable and scoped to one page', () => {
        const detector = new LoopDetector({
            repeatedActionThreshold: 3,
            maxScrollAttempts: 2,
        });
        const click = { action: 'click', element_id: 1 };

        assert.strictEqual(detector.checkActionLoop(click, 'https://example.com/a').isLoop, false);
        assert.strictEqual(detector.checkActionLoop(click, 'https://example.com/b').isLoop, false);
        assert.strictEqual(detector.checkActionLoop(click, 'https://example.com/c').isLoop, false);

        detector.reset();
        assert.strictEqual(detector.checkActionLoop({ action: 'scroll', direction: 'down' }, 'https://example.com').isLoop, false);
        const scrollLoop = detector.checkActionLoop({ action: 'scroll', direction: 'down' }, 'https://example.com');
        assert.strictEqual(scrollLoop.isLoop, true);
        assert.strictEqual(scrollLoop.type, 'scroll_loop');
    });

    test('Task 19: LoopDetector catches oscillating URL navigation', () => {
        const detector = new LoopDetector();
        const urls = ['a', 'b', 'a', 'b', 'a'];
        urls.forEach(url => assert.strictEqual(detector.checkUrlLoop(url).isLoop, false));

        const urlLoop = detector.checkUrlLoop('b');
        assert.strictEqual(urlLoop.isLoop, true);
        assert.strictEqual(urlLoop.type, 'url_oscillation');
    });

    test('Task 19: AgentRunner wires safety thresholds and records terminal loop step', () => {
        const runner = new AgentRunner({
            maxSteps: 7,
            maxRepeatedActions: 2,
            maxScrollAttempts: 3,
            completionWaitMs: 0,
        });

        assert.strictEqual(runner.config.maxSteps, 7);
        assert.strictEqual(runner.loopDetector.threshold, 2);
        assert.strictEqual(runner.loopDetector.maxScrollAttempts, 3);

        runner.stateManager.start('Test loop protection', runner.config.maxSteps);
        runner.stopForLoop({
            step: 2,
            loopCheck: { type: 'repeated_action', reason: 'test repeated action' },
            currentUrl: 'https://example.com',
            pageTitle: 'Example',
            attemptedAction: { action: 'click', element_id: 1 },
        });

        assert.strictEqual(runner.stateManager.status, AGENT_STATUS.FAILED);
        assert.strictEqual(runner.stateManager.stepCount, 2);
        assert.strictEqual(runner.stateManager.history.length, 1);
        assert(runner.stateManager.error.includes('test repeated action'));
    });

    test('Task 19: Maximum-step values are positive integers with safe fallback', () => {
        const configured = new StateManager(5);
        assert.strictEqual(configured.maxSteps, 5);

        configured.start('Keep existing safety limit', 0);
        assert.strictEqual(configured.maxSteps, 5);

        const invalid = new StateManager(-10);
        assert.strictEqual(invalid.maxSteps > 0, true);
    });

    test('Task 19: Validators accurately check goals and URLs', () => {
        assert.strictEqual(validateGoal('  Search for laptop  '), 'Search for laptop');
        assert.throws(() => validateGoal('   '), /non-empty string/);
        assert.strictEqual(isValidUrl('https://example.com/search?q=test'), true);
        assert.strictEqual(isValidUrl('ftp://invalid'), false);
        assert.strictEqual(isValidUrl('random string'), false);
    });

    await asyncTest('Cart executor clicks selected React ADD control once and verifies transition', async () => {
        const beforeState = {
            hasItems: false,
            itemCount: 0,
            quantityControlCount: 0,
            cartSummary: '',
            evidence: [],
        };
        const afterState = {
            hasItems: true,
            itemCount: 1,
            quantityControlCount: 1,
            cartSummary: '1 item ₹62',
            evidence: ['cart badge/count: 1'],
        };
        let cartState = beforeState;
        let clickCount = 0;

        const target = {
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {
                clickCount += 1;
                cartState = afterState;
            },
        };
        const fakePage = {
            isClosed: () => false,
            url: () => 'https://shop.example/products',
            $: async (selector) => selector.includes('data-agent-id') ? target : null,
            waitForTimeout: async () => {},
            evaluate: async (fn, args) => {
                const source = fn.toString();
                if (source.includes('const countSelectors')) return cartState;
                if (source.includes("scope.setAttribute('data-agent-cart-scope'")) {
                    return {
                        found: true,
                        token: args.scopeToken,
                        targetText: 'ADD',
                        scopeText: 'Fresh Milk 1 L ₹62 ADD',
                        hadQuantity: false,
                    };
                }
                if (source.includes('previousTargetText')) {
                    return { advanced: true, hasQuantity: true, scopeText: 'Fresh Milk 1 L ₹62 − 1 +' };
                }
                throw new Error('Unexpected page.evaluate call in cart executor test');
            },
        };

        const result = await performAddToCart(fakePage, 7, { id: 7, text: 'ADD' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cartVerified, true);
        assert.strictEqual(clickCount, 1, 'ADD must not receive duplicate synthetic clicks');
    });

    // ─── SUMMARY REPORT ──────────────────────────────────────────────
    console.log('\n' + '═'.repeat(65));
    console.log('📊 TEST SUMMARY REPORT');
    console.log('═'.repeat(65));
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    console.log(`TOTAL TESTS: ${total} | PASSED: ${passed} | FAILED: ${total - passed}`);
    console.log(`SUCCESS RATE: ${((passed / total) * 100).toFixed(1)}%`);
    console.log('═'.repeat(65) + '\n');

    if (total !== passed) {
        process.exit(1);
    }
}

runAllTests();

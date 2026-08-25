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
const { buildChatCompletionRequest, callChatCompletion } = require('./llm/LLMClient');
const StateManager = require('./agent/StateManager');
const LoopDetector = require('./agent/LoopDetector');
const MessageManager = require('./agent/MessageManager');
const {
    AgentRunner,
    getProductPageFastAction,
    getExactProductResultAction,
    getProductSearchResultOpenAction,
    getProductPageSizeSelectionAction,
    getRequestedCartQuantity,
    getRequestedDistinctProducts,
    matchesRequestedProduct,
    getProductIdentity,
    buildStoreSearchUrl,
    recordVerifiedDistinctProduct,
    resolveInitialUrl,
} = require('./agent/AgentRunner');
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

    test('Task 18: Product-page cart fast path bypasses repeated LLM chunk requests', () => {
        const elements = [{ id: 14, type: 'button', text: 'Add to cart', isCartAction: true }];
        elements.isProductDetailsPage = true;
        elements.productInfo = { title: 'PUMA Shoes', price: '₹1,999' };

        const action = getProductPageFastAction(
            'Find the puma shoes on flipkart and tell me the price and also add one shoes in cart',
            elements,
        );
        assert.strictEqual(action.action, ACTION_TYPES.ADD_TO_CART);
        assert.strictEqual(action.element_id, 14);
        assert.strictEqual(action.fast_path, true);
    });

    test('Task 18: Cart search result fast path opens product page before ADD', () => {
        const domData = {
            isProductDetailsPage: false,
            elements: [
                { id: 1, type: 'button', text: 'Add to cart', context: 'Nike Court Sneakers — ₹3,695', isCartAction: true },
                { id: 2, type: 'a', text: 'Nike Mens Court Shot Sneakers', href: 'https://www.amazon.in/dp/B0NIKE1234', context: 'Nike Mens Court Shot Sneakers — ₹3,695' },
            ],
        };

        const action = getProductSearchResultOpenAction('Find a nike shoes from amazon and add this in cart', domData);
        assert.strictEqual(action.action, ACTION_TYPES.CLICK);
        assert.strictEqual(action.element_id, 2, 'search/listing flow must open the product link, not click listing ADD');
    });

    test('Task 18: Product opener rejects search query links and clicks product URLs', () => {
        const domData = {
            isProductDetailsPage: false,
            elements: [
                { id: 18, type: 'a', text: 'price of nike shoes', href: 'https://www.flipkart.com/search?q=price+of+nike+shoes&augment=false' },
                { id: 21, type: 'a', text: 'RUN DEFY Running Shoes For Men', href: 'https://www.flipkart.com/run-defy-running-shoes-men/p/itm123?pid=SHOG123' },
            ],
        };

        const action = getProductSearchResultOpenAction('Find the price of nike shoes on flipkart and add this to cart', domData);
        assert.strictEqual(action.action, ACTION_TYPES.CLICK);
        assert.strictEqual(action.element_id, 21, 'must not click the search query/suggestion link');
    });

    test('Task 18: Product page fast path preselects size before Add to Cart', () => {
        const domData = {
            isProductDetailsPage: true,
            url: 'https://www.flipkart.com/puma-shoes/p/item?pid=SHOE123',
            elements: [
                { id: 1, type: 'button', text: 'Add to cart', isCartAction: true },
                { id: 18, type: 'a', text: '10', href: 'https://www.flipkart.com/puma-shoes/p/item?pid=SHOE123&swatchAttr=size' },
            ],
        };

        const action = getProductPageSizeSelectionAction(
            'Find the price of puma shoes on flipkart and add this to cart',
            domData,
            domData.url,
        );
        assert.strictEqual(action.action, ACTION_TYPES.CLICK);
        assert.strictEqual(action.element_id, 18, 'must select size swatch before first add_to_cart attempt');
    });

    test('Task 18: Mixed price plus cart goal must not be treated as read-only', () => {
        const goal = 'open zomato app and find the price of veg Biryani and add this in a cart';
        assert.strictEqual(getProductSearchResultOpenAction(goal, { isProductDetailsPage: false, elements: [] }), null);
        // The important regression is in AgentRunner: visible-answer detection is
        // now gated by getRequestedCartAdditionCount(goal) === 0, so a random
        // visible "₹1,500 for two" cannot prematurely complete this cart goal.
    });

    test('Task 18: Quantity intent is attached to the product-page fast cart action', () => {
        const goal = 'Find the amul milk on blinkit and tell me the price and also add two amul milk in cart';
        const domData = {
            isProductDetailsPage: true,
            elements: [{ id: 22, type: 'button', text: 'ADD', isCartAction: true }],
        };

        assert.strictEqual(getRequestedCartQuantity(goal), 2);
        assert.strictEqual(getRequestedCartQuantity('Add quantity 20 of Amul milk'), 20);
        assert.strictEqual(getRequestedCartQuantity('Add twenty Amul milk to cart'), 20);
        assert.strictEqual(getRequestedCartQuantity('Add two different products to cart'), 1);
        assert.strictEqual(getProductPageFastAction(goal, domData).quantity, 2);
    });

    test('Task 18: Distinct-product goals become separate store searches', () => {
        const twoProductGoal = 'Find Amul milk and Amul butter on Blinkit, tell me both prices, and add two different products to cart';
        const threeProductGoal = 'Find Amul milk, Amul butter, and Amul curd on Blinkit and add three different products to cart';
        const naturalMultiGoal = 'Find the price of kaju katli and amul milk from blinkit and add this product in cart';

        assert.deepStrictEqual(getRequestedDistinctProducts(twoProductGoal), ['Amul milk', 'Amul butter']);
        assert.deepStrictEqual(
            getRequestedDistinctProducts(threeProductGoal),
            ['Amul milk', 'Amul butter', 'Amul curd'],
        );
        assert.deepStrictEqual(
            getRequestedDistinctProducts(naturalMultiGoal),
            ['kaju katli', 'amul milk'],
            'natural multi-item query must become a product queue even without the word different',
        );
        assert.strictEqual(
            resolveInitialUrl(twoProductGoal, 'https://www.google.com'),
            'https://blinkit.com/s/?q=Amul%20milk',
            'the first search must not combine milk and butter into one ambiguous query',
        );
        assert.strictEqual(
            resolveInitialUrl(naturalMultiGoal, 'https://www.google.com'),
            'https://blinkit.com/s/?q=kaju%20katli',
            'the first natural multi-item search must start with the first product only',
        );
        assert.strictEqual(
            buildStoreSearchUrl(twoProductGoal, 'Amul butter'),
            'https://blinkit.com/s/?q=Amul%20butter',
        );
        assert.deepStrictEqual(
            getRequestedDistinctProducts('Find Amul milk on Blinkit and add two Amul milk to cart'),
            [],
            'same-product quantity must not become a distinct-product plan',
        );
    });

    test('Task 18: Standalone product matching rejects milk inside buttermilk', () => {
        assert.strictEqual(matchesRequestedProduct('Amul Unsalted Buttermilk', 'Amul milk'), false);
        assert.strictEqual(matchesRequestedProduct('Amul Gold Full Cream Milk', 'Amul milk'), true);
        assert.strictEqual(matchesRequestedProduct('Amul Pasteurised Butter', 'Amul butter'), true);
        assert.strictEqual(matchesRequestedProduct('Back Cover for Apple iPhone 16 Plus', 'a phone cover'), true);

        const results = [
            { id: 10, type: 'div', text: 'Amul Unsalted Buttermilk 400 ml ₹15 ADD' },
            { id: 11, type: 'div', text: 'Amul Gold Full Cream Milk 1 ltr ₹72 ADD' },
        ];
        results.isProductDetailsPage = false;
        const action = getExactProductResultAction('Amul milk', results);
        assert.strictEqual(action.element_id, 11, 'the deterministic result selector must skip buttermilk');
    });

    test('Task 18: Distinct-product tracking rejects duplicate product identities', () => {
        const plan = ['Amul milk', 'Amul butter'].map(query => ({ query, status: 'pending' }));
        const identities = new Set();
        const milk = {
            identity: getProductIdentity('https://blinkit.com/prn/amul-gold/prid/561268', 'Amul Gold Full Cream Milk'),
            title: 'Amul Gold Full Cream Milk',
            price: '₹72',
        };
        const first = recordVerifiedDistinctProduct(plan, identities, milk);
        assert.strictEqual(first.success, true);
        assert.strictEqual(first.nextPendingProduct.query, 'Amul butter');

        const duplicate = recordVerifiedDistinctProduct(plan, identities, milk);
        assert.strictEqual(duplicate.success, false);
        assert.match(duplicate.error, /same product/i);
        assert.strictEqual(plan[1].status, 'pending');

        const butter = {
            identity: getProductIdentity('https://blinkit.com/prn/amul-butter/prid/123456', 'Amul Pasteurised Butter'),
            title: 'Amul Pasteurised Butter',
            price: '₹58',
        };
        const second = recordVerifiedDistinctProduct(plan, identities, butter);
        assert.strictEqual(second.success, true);
        assert.strictEqual(second.completed, true);
        assert.strictEqual(identities.size, 2);
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

        const cartAction = parseAction('{"thought":"Product page is ready","action":"add_to_cart","size":"8","quantity":2}');
        assert.strictEqual(cartAction.action, ACTION_TYPES.ADD_TO_CART);
        assert.strictEqual(cartAction.size, '8');
        assert.strictEqual(cartAction.quantity, 2);
    });

    test('Task 18: Groq GPT-OSS requests reserve enough tokens for valid JSON', () => {
        const request = buildChatCompletionRequest(
            'openai/gpt-oss-120b',
            'Return one JSON action.',
            'Click the matching product.',
            { max_completion_tokens: 384 },
        );

        assert.strictEqual(request.max_completion_tokens, 768, 'unsafe 384-token requests must be raised to the JSON safety floor');
        assert.strictEqual(request.reasoning_effort, 'low', 'single-action GPT-OSS calls should not spend tokens on medium reasoning');
        assert.deepStrictEqual(request.response_format, { type: 'json_object' });
        assert.strictEqual(Object.hasOwn(request, 'max_tokens'), false, 'use the current max_completion_tokens API field');

        const nonReasoningRequest = buildChatCompletionRequest(
            'llama-3.3-70b-versatile',
            'Return JSON.',
            'Choose one action.',
        );
        assert.strictEqual(nonReasoningRequest.max_completion_tokens, 1024);
        assert.strictEqual(Object.hasOwn(nonReasoningRequest, 'reasoning_effort'), false);
    });

    await asyncTest('Task 18: Groq completion produces one locally parseable action request', async () => {
        let requestCount = 0;
        let capturedRequest = null;
        const fakeGroq = {
            chat: {
                completions: {
                    create: async (request) => {
                        requestCount += 1;
                        capturedRequest = request;
                        return {
                            choices: [{ message: { content: '{"thought":"Open product","action":"click","element_id":7}' } }],
                        };
                    },
                },
            },
        };

        const raw = await callChatCompletion(
            fakeGroq,
            'openai/gpt-oss-120b',
            'Return JSON.',
            'Open the first product.',
            { max_completion_tokens: 1024 },
        );
        const action = parseAction(raw);

        assert.strictEqual(requestCount, 1, 'normal decisions must keep the one-LLM-request latency guard');
        assert.strictEqual(capturedRequest.max_completion_tokens, 1024);
        assert.strictEqual(capturedRequest.reasoning_effort, 'low');
        assert.strictEqual(action.action, ACTION_TYPES.CLICK);
        assert.strictEqual(action.element_id, 7);
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

    await asyncTest('Cart executor finds an unextracted React ADD control, clicks once, and verifies transition', async () => {
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
            evaluate: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {
                clickCount += 1;
                cartState = afterState;
            },
        };
        const fakePage = {
            isClosed: () => false,
            url: () => 'https://shop.example/products',
            $: async (selector) => selector.includes('data-agent-direct-cart') ? target : null,
            waitForTimeout: async () => {},
            evaluate: async (fn, args) => {
                const source = fn.toString();
                if (source.includes('const countSelectors')) return cartState;
                if (source.includes('const scored = candidates.map')) return true;
                if (source.includes("setAttribute('data-agent-cart-scope'") && source.includes('const targetRect')) {
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

        const result = await performAddToCart(fakePage);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cartVerified, true);
        assert.strictEqual(clickCount, 1, 'ADD must not receive duplicate synthetic clicks');
    });

    await asyncTest('Cart executor retries the same selected ADD and recognizes Flipkart-style disappearance', async () => {
        let clickCount = 0;
        let itemAdded = false;
        const emptyCart = {
            hasItems: false,
            itemCount: 0,
            quantityControlCount: 0,
            cartSummary: '',
            evidence: [],
        };
        const addTarget = {
            evaluate: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {
                clickCount += 1;
                if (clickCount === 2) itemAdded = true;
            },
        };
        const fakePage = {
            isClosed: () => false,
            url: () => 'https://www.flipkart.com/phone-cover/p/example',
            $: async (selector) => {
                if (selector.includes('data-agent-direct-cart')) return addTarget;
                if (selector.includes('data-agent-cart-retry')) return addTarget;
                return null;
            },
            waitForTimeout: async () => {},
            evaluate: async (fn, args) => {
                const source = fn.toString();
                if (source.includes('const countSelectors')) return emptyCart;
                if (source.includes('const scored = candidates.map')) return true;
                if (source.includes("setAttribute('data-agent-cart-scope'") && source.includes('const targetRect')) {
                    return {
                        found: true,
                        token: args.scopeToken,
                        targetText: 'Add to cart',
                        scopeText: 'Phone cover ₹444 Add to cart',
                        hadQuantity: false,
                        rect: { left: 100, right: 220, top: 300, bottom: 350, centerX: 160, centerY: 325 },
                    };
                }
                if (source.includes('previousTargetText')) {
                    return {
                        advanced: false,
                        hasQuantity: false,
                        quantity: 0,
                        selectedAddPresent: !itemAdded,
                        addControlDisappeared: itemAdded,
                        postAddState: false,
                        scopeText: '',
                    };
                }
                if (source.includes('data-agent-cart-retry')) return !itemAdded;
                if (source.includes('const dialogs')) return undefined;
                throw new Error('Unexpected page.evaluate call in bounded cart retry test');
            },
        };

        const result = await performAddToCart(fakePage);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.cartVerified, true);
        assert.strictEqual(result.clickAttempts, 2);
        assert.strictEqual(clickCount, 2, 'stop immediately after the second selected click succeeds');
        assert(result.message.includes('selected ADD control disappeared'));
    });

    await asyncTest('Cart executor never exceeds three selected ADD attempts', async () => {
        let clickCount = 0;
        const emptyCart = {
            hasItems: false,
            itemCount: 0,
            quantityControlCount: 0,
            cartSummary: '',
            evidence: [],
        };
        const addTarget = {
            evaluate: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            click: async () => { clickCount += 1; },
        };
        const fakePage = {
            isClosed: () => false,
            url: () => 'https://shop.example/product',
            $: async (selector) => {
                if (selector.includes('data-agent-direct-cart')) return addTarget;
                if (selector.includes('data-agent-cart-retry')) return addTarget;
                return null;
            },
            waitForTimeout: async () => {},
            evaluate: async (fn, args) => {
                const source = fn.toString();
                if (source.includes('const countSelectors')) return emptyCart;
                if (source.includes('const scored = candidates.map')) return true;
                if (source.includes("setAttribute('data-agent-cart-scope'") && source.includes('const targetRect')) {
                    return {
                        found: true,
                        token: args.scopeToken,
                        targetText: 'ADD',
                        scopeText: 'Product ₹100 ADD',
                        hadQuantity: false,
                        rect: { left: 100, right: 220, top: 300, bottom: 350, centerX: 160, centerY: 325 },
                    };
                }
                if (source.includes('previousTargetText')) {
                    return {
                        advanced: false,
                        hasQuantity: false,
                        quantity: 0,
                        selectedAddPresent: true,
                        addControlDisappeared: false,
                        postAddState: false,
                        scopeText: '',
                    };
                }
                if (source.includes('data-agent-cart-retry')) return true;
                if (source.includes('const dialogs')) return undefined;
                throw new Error('Unexpected page.evaluate call in max cart retry test');
            },
        };

        const result = await performAddToCart(fakePage);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.cartRetryExhausted, true);
        assert.strictEqual(result.clickAttempts, 3);
        assert.strictEqual(clickCount, 3, 'never click ADD more than three times');
    });

    await asyncTest('Cart executor increments only the selected product until requested quantity is verified', async () => {
        let quantity = 0;
        let addClickCount = 0;
        let selectedIncrementCount = 0;
        let incrementSearchScope = null;
        const scopeToken = 'selected-milk-scope';

        const cartState = () => ({
            hasItems: quantity > 0,
            itemCount: quantity,
            quantityControlCount: quantity > 0 ? 1 : 0,
            cartSummary: quantity > 0 ? `${quantity} items ₹${quantity * 62}` : '',
            evidence: quantity > 0 ? [`cart badge/count: ${quantity}`] : [],
        });
        const addTarget = {
            evaluate: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {
                addClickCount += 1;
                quantity = 1;
            },
        };
        const selectedIncrement = {
            click: async () => {
                selectedIncrementCount += 1;
                quantity += 1;
            },
        };
        const fakePage = {
            isClosed: () => false,
            url: () => 'https://shop.example/products/amul-milk',
            $: async (selector) => {
                if (selector.includes('data-agent-quantity-increment')) return selectedIncrement;
                if (selector.includes('data-agent-direct-cart')) return addTarget;
                return null;
            },
            waitForTimeout: async () => {},
            evaluate: async (fn, args) => {
                const source = fn.toString();
                if (source.includes('const countSelectors')) return cartState();
                if (source.includes('const scored = candidates.map') && source.includes('addPattern')) return true;
                if (source.includes("setAttribute('data-agent-cart-scope'") && source.includes('const targetRect')) {
                    return {
                        found: true,
                        token: scopeToken,
                        targetText: 'ADD',
                        scopeText: 'Amul Milk 1 L ₹62 ADD',
                        hadQuantity: false,
                    };
                }
                if (source.includes('previousTargetText')) {
                    return {
                        advanced: quantity > 0,
                        hasQuantity: quantity > 0,
                        quantity,
                        scopeText: `Amul Milk 1 L ₹62 − ${quantity} +`,
                    };
                }
                if (source.includes('data-agent-quantity-increment')) {
                    incrementSearchScope = args.scopeToken;
                    return true;
                }
                throw new Error('Unexpected page.evaluate call in quantity cart executor test');
            },
        };

        const result = await performAddToCart(fakePage, null, {
            context: 'Amul Milk 1 L ₹62',
        }, { requestedQuantity: 2 });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.quantityVerified, true);
        assert.strictEqual(result.quantity, 2);
        assert.strictEqual(addClickCount, 1, 'ADD must be clicked exactly once');
        assert.strictEqual(selectedIncrementCount, 1, 'Only one selected-product + click is needed for quantity two');
        assert.strictEqual(incrementSearchScope, scopeToken, 'The + search must remain inside the selected product scope');
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

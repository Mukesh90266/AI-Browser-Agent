// test-llm-agent.js — Fixed version with cart detection + proper chunk handling

const { launchBrowser, navigateTo, closeBrowser, getPage } = require('./browser/BrowserManager');
const { extractDOM, formatForLLM, chunkElements } = require('./browser/DOMExtractor');
const { typeText, clickElement, scrollPage, pressEnter } = require('./browser/ActionExecutor');
const { closePopupIfExists } = require('./browser/PopupHandler');
const { getNextAction } = require('./llm/LLMClient');
const { SYSTEM_PROMPT, buildUserPrompt } = require('./llm/PromptBuilder');
const { parseAction } = require('./llm/ActionParser');

const MAX_STEPS = 15;
const CHUNK_SIZE = 50;
const MAX_CHUNKS_PER_PAGE = 6;   // 4 → 6 kiya (product page pe button deep ho sakta hai)
const MAX_SCROLL_ATTEMPTS = 3;   // scroll karke naya DOM check

// ─── Cart click detect karna ───────────────────────────────────────────────
function wasCartClicked(actionHistory) {
    return actionHistory.some(a => {
        if (a.action !== 'click') return false;
        const txt = (a.elementText || '').toLowerCase();
        return txt.includes('add to cart') ||
            txt.includes('add to bag') ||
            txt.includes('buy now') ||
            txt.includes('cart');
    });
}

// ─── Ek page pe best action dhundho (chunks + scroll) ─────────────────────
async function decideAction(userGoal, actionHistory) {
    const page = getPage();
    let scrollAttempts = 0;

    while (scrollAttempts <= MAX_SCROLL_ATTEMPTS) {
        const allElements = await extractDOM();
        const chunks = chunkElements(allElements, CHUNK_SIZE);
        const currentUrl = page.url();

        console.log(`   📦 Elements: ${allElements.length} → ${chunks.length} chunk(s) | Scroll attempt: ${scrollAttempts}`);
        console.log(`   🌐 URL: ${currentUrl}`);
        console.log(`   🛒 Cart clicked so far: ${wasCartClicked(actionHistory)}`);

        for (let chunkIndex = 0; chunkIndex < chunks.length && chunkIndex < MAX_CHUNKS_PER_PAGE; chunkIndex++) {
            const chunk = chunks[chunkIndex];
            const elementText = formatForLLM(chunk);

            // ✅ FIX: chunkNumber aur totalChunks add kiye (naya PromptBuilder expect karta hai)
            const chunkInfo = {
                chunkNumber: chunkIndex + 1,
                totalChunks: chunks.length,
                start: chunkIndex * CHUNK_SIZE + 1,
                end: Math.min((chunkIndex + 1) * CHUNK_SIZE, allElements.length),
                total: allElements.length,
            };

            console.log(`   🔍 Chunk ${chunkIndex + 1}/${chunks.length}`);

            const userPrompt = buildUserPrompt(userGoal, elementText, actionHistory, chunkInfo, currentUrl);
            const rawResponse = await getNextAction(SYSTEM_PROMPT, userPrompt);
            const action = parseAction(rawResponse);

            console.log(`   🤖 LLM said: ${JSON.stringify(action)}`);

            if (action.action === 'next_chunk') {
                console.log(`   ➡️  Next chunk maanga`);
                continue; // agli chunk pe jaao
            }

            // ✅ FIX: click action ke saath elementText attach karo (cart detection ke liye)
            if (action.action === 'click') {
                await extractDOM();  // data-agent-id re-set ho jaate hain page pe
                // chunk already is iteration ka fresh chunk hai — match theek hai
                const matchedEl = chunk.find(el => el.id === action.element_id);
                action.elementText = matchedEl ? (matchedEl.text || '') : '';
                console.log(`   🖱️  Clicking element: "${action.elementText}"`);
            }
            return { action, currentUrl };
        }

        // Saare chunks check ho gaye — scroll karke dobara try karo
        if (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
            console.log(`   ⬇️  Saare chunks check ho gaye — scroll down karke dobara try (${scrollAttempts + 1}/${MAX_SCROLL_ATTEMPTS})`);
            await page.evaluate(() => window.scrollBy(0, 700));
            await new Promise(r => setTimeout(r, 1200));
        }

        scrollAttempts++;
    }

    throw new Error(`Saare chunks + ${MAX_SCROLL_ATTEMPTS} scrolls ke baad bhi valid action nahi mila`);
}

// ─── Same action repeat detect karna ──────────────────────────────────────
function isSameAsLastAction(actionHistory, newAction) {
    if (actionHistory.length === 0) return false;
    const last = actionHistory[actionHistory.length - 1];
    return last.action === newAction.action &&
        last.element_id === newAction.element_id &&
        last.text === newAction.text;
}

// ─── Main agent loop ───────────────────────────────────────────────────────
async function runAgent(userGoal) {
    console.log(`\n${'━'.repeat(55)}`);
    console.log(`🎯 Goal: "${userGoal}"`);
    console.log(`🔢 MAX_STEPS: ${MAX_STEPS}`);
    console.log('━'.repeat(55));

    const actionHistory = [];
    let repeatCount = 0;
    const MAX_REPEATS = 3;

    try {
        await launchBrowser();
        await navigateTo('https://www.amazon.in');
        await closePopupIfExists();

        for (let step = 1; step <= MAX_STEPS; step++) {
            console.log(`\n${'═'.repeat(55)}`);
            console.log(`  STEP ${step}/${MAX_STEPS}`);
            console.log('═'.repeat(55));

            // ── Action decide karo ──────────────────────────────
            let action, currentUrl;
            try {
                ({ action, currentUrl } = await decideAction(userGoal, actionHistory));
            } catch (err) {
                console.error(`❌ decideAction failed: ${err.message}`);
                console.log('🛑 Agent stopping — could not find valid action');
                break;
            }

            console.log(`\n✅ Action: ${JSON.stringify(action)}`);

            // ── Done check ──────────────────────────────────────
            if (action.action === 'done') {
                const cartOk = wasCartClicked(actionHistory);
                const goalNeedsCart = userGoal.toLowerCase().includes('add to cart') ||
                    userGoal.toLowerCase().includes('buy');

                // LLM ne done bola lekin cart click nahi hua aur goal mein cart tha
                if (goalNeedsCart && !cartOk && action.success !== false) {
                    console.log('⚠️  LLM ne done bola lekin cart click nahi hua — continue karo');
                    actionHistory.push({
                        action: 'skipped_done',
                        reason: 'cart not clicked yet',
                        step
                    });
                    continue;
                }

                console.log(`\n${'🎉'.repeat(5)}`);
                console.log(`TASK ${action.success ? 'COMPLETE ✅' : 'FAILED ❌'}: ${action.result}`);
                console.log(`Total steps used: ${step}`);
                console.log('🎉'.repeat(5));
                break;
            }

            // ── Same action repeat guard ────────────────────────
            if (isSameAsLastAction(actionHistory, action)) {
                repeatCount++;
                console.log(`⚠️  Same action repeat #${repeatCount}`);
                if (repeatCount >= MAX_REPEATS) {
                    console.log('🛑 Loop detected — agent stopping');
                    break;
                }
            } else {
                repeatCount = 0;
            }

            // ── Action execute karo ─────────────────────────────
            try {
                if (action.action === 'click') {
                    await clickElement(action.element_id);
                    await closePopupIfExists(); // click ke baad popup aa sakta hai
                } else if (action.action === 'type') {
                    await typeText(action.element_id, action.text);
                } else if (action.action === 'enter') {
                    await pressEnter();
                } else if (action.action === 'scroll') {
                    await scrollPage(action.direction);
                } else if (action.action === 'navigate') {
                    await navigateTo(action.url);
                    await closePopupIfExists();
                }

                actionHistory.push({ ...action, step });
                console.log(`   📝 History: ${actionHistory.length} action(s)`);

            } catch (execErr) {
                console.error(`⚠️  Execution failed: ${execErr.message}`);
                actionHistory.push({ ...action, error: execErr.message, step });
            }

            // Page settle hone do
            await new Promise(r => setTimeout(r, 2000));
        }

        // MAX_STEPS khatam
        if (actionHistory.filter(a => a.action !== 'skipped_done').length >= MAX_STEPS) {
            console.log(`\n⚠️  MAX_STEPS (${MAX_STEPS}) reached — agent stopped (safety limit)`);
            console.log(`🛒 Cart was clicked: ${wasCartClicked(actionHistory)}`);
        }

        console.log('\n📋 Final Action History:');
        actionHistory.forEach((a, i) => {
            const cartTag = (a.action === 'click' && (a.elementText || '').toLowerCase().includes('cart'))
                ? ' 🛒' : '';
            console.log(`  ${i + 1}. ${JSON.stringify(a)}${cartTag}`);
        });

    } catch (err) {
        console.error('❌ Fatal Error:', err.message);
        console.error(err.stack);
    } finally {
        await closeBrowser();
    }
}

// ─── Run ───────────────────────────────────────────────────────────────────
runAgent('add boat earphones to cart on amazon');
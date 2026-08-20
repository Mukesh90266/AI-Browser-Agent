// test-llm-agent.js — Generic autonomous web agent test runner (Task 18 + Task 19 verification)
//
// Demonstrates generic task execution across any website:
// 1. Information Retrieval / Q&A
// 2. Web Search & Multi-step Navigation
// 3. Flight / Product Search & Booking Site Exploration
// 4. Goal Completion Recognition & Safe Stopping
//
// Run: node test-llm-agent.js [optional goal]

const { runAgent } = require('./agent/AgentRunner');

async function main() {
    const customGoal = process.argv.slice(2).join(' ');
    const goal = customGoal || 'Find the cheapest flight from Delhi to gorakhpur in India on 1 september 2026';

    console.log('\n' + '═'.repeat(60));
    console.log('🤖 AUTONOMOUS AI BROWSER AGENT — TASK 18 & 19 VERIFICATION');
    console.log('═'.repeat(60));
    console.log(`🎯 Goal: "${goal}"\n`);

    const result = await runAgent(goal, {
        maxSteps: 12,
        autoClose: false,          // Browser remains open so you can view the final booking page
        completionWaitMs: 8000,    // 8-second viewing pause upon completion
    });

    console.log('\n' + '═'.repeat(60));
    console.log('📊 EXECUTION RESULT');
    console.log('═'.repeat(60));
    console.log(`Status:       ${result.status.toUpperCase()}`);
    console.log(`Steps Used:   ${result.stepCount} / ${result.maxSteps}`);
    console.log(`Final Result: ${result.result || result.error || 'N/A'}`);
    console.log(`Total Actions Taken: ${result.history.length}`);
    console.log('═'.repeat(60) + '\n');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Fatal execution error:', err);
    });
}

module.exports = { main };

// test-zomato.js — Autonomous AI Agent test runner for Zomato food delivery and restaurant search
//
// Usage:
//   node backend/test-zomato.js [optional goal]
//
// Examples:
//   node backend/test-zomato.js
//   node backend/test-zomato.js "Find top rated Biryani in Connaught Place Delhi on Zomato and tell me restaurant name and rating"
//   node backend/test-zomato.js "Search for Gulati restaurant on Zomato Delhi and find price of Butter Chicken"

const { runAgent } = require('./agent/AgentRunner');

async function runZomatoTest() {
    const customGoal = process.argv.slice(2).join(' ');
    const goal = customGoal || 'Search Zomato for top rated Biryani restaurants in Connaught Place Delhi and tell me the top restaurant name and rating';

    console.log('\n' + '═'.repeat(65));
    console.log('🍕 AUTONOMOUS AI BROWSER AGENT — ZOMATO RESTAURANT / FOOD TEST');
    console.log('═'.repeat(65));
    console.log(`🎯 Goal: "${goal}"\n`);

    const startTime = Date.now();

    const result = await runAgent(goal, {
        maxSteps: 12,
        autoClose: false,          // Keeps browser open so you can view results
        completionWaitMs: 6000,    // 6 seconds pause before final return
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n' + '═'.repeat(65));
    console.log('📊 ZOMATO EXECUTION SUMMARY');
    console.log('═'.repeat(65));
    console.log(`Status:         ${result.status.toUpperCase()}`);
    console.log(`Steps Used:     ${result.stepCount} / ${result.maxSteps}`);
    console.log(`Time Taken:     ${elapsed}s`);
    console.log(`Total Actions:  ${result.history.length}`);
    console.log(`Final Result:   ${result.result || result.error || 'N/A'}`);
    console.log('═'.repeat(65) + '\n');
}

if (require.main === module) {
    runZomatoTest().catch((err) => {
        console.error('❌ Fatal error running Zomato test:', err.message);
    });
}

module.exports = { runZomatoTest };

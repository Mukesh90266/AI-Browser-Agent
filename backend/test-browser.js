// test-popup.js — Popup auto-close feature test karo multiple sites pe

const { launchBrowser, navigateTo, closeBrowser, getPage } = require('./browser/BrowserManager');
const { extractDOM, formatForLLM } = require('./browser/DOMExtractor');
const { closePopupIfExists, detectModalPresence } = require('./browser/PopupHandler');
const { takeScreenshot } = require('./browser/ScreenshotHelper');

// ─── HELPER — Ek site pe popup test karo ──────────────────────────
async function testPopupOnSite(url, siteName) {
    console.log('\n' + '─'.repeat(50));
    console.log(`🌐 Site: ${siteName}`);
    console.log(`📍 URL: ${url}`);
    console.log('─'.repeat(50));

    try {
        // navigateTo khud popup close karega (BrowserManager.js mein add kiya hai)
        await navigateTo(url);

        // Extra wait — kuch sites ka popup thoda late aata hai
        await new Promise(r => setTimeout(r, 1500));

        // Dobara check karo — koi late popup toh nahi aaya
        const stillHasModal = await detectModalPresence();

        if (stillHasModal) {
            console.log('⚠️  Late popup detect hua — dobara close try kar raha hai');
            await closePopupIfExists();
            await new Promise(r => setTimeout(r, 1000));
        }

        // Final check
        const finalCheck = await detectModalPresence();

        // Screenshot lo proof ke liye
        const shot = await takeScreenshot();
        console.log(`📸 Screenshot: ${shot.length} chars`);

        // DOM extract karke confirm karo page usable hai
        const elements = await extractDOM();
        console.log(`✅ Extracted ${elements.length} elements — page interactive hai`);

        if (finalCheck) {
            console.log(`❌ ${siteName} — Popup abhi bhi screen pe hai`);
            return { site: siteName, status: '❌ FAIL', reason: 'Popup still visible' };
        } else {
            console.log(`✅ ${siteName} — Popup successfully handled!`);
            return { site: siteName, status: '✅ PASS' };
        }

    } catch (err) {
        console.error(`❌ ${siteName} — Error: ${err.message}`);
        return { site: siteName, status: '❌ FAIL', reason: err.message };
    }
}

// ─── MAIN TEST ────────────────────────────────────────────────────
async function test() {
    console.log('\n🚀 Popup Auto-Close Test shuru ho raha hai...');
    console.log('Testing sites jo login/signup popup dikhati hain\n');

    const results = [];

    try {
        await launchBrowser();

        // Test 1 — Flipkart (login popup famous hai)
        results.push(await testPopupOnSite('https://www.flipkart.com', 'Flipkart'));
        await new Promise(r => setTimeout(r, 1500));

        // Test 2 — Myntra (signup popup aata hai)
        results.push(await testPopupOnSite('https://www.myntra.com', 'Myntra'));
        await new Promise(r => setTimeout(r, 1500));

        // Test 3 — Amazon (kabhi kabhi location/signin popup)
        results.push(await testPopupOnSite('https://www.amazon.in', 'Amazon.in'));

    } catch (err) {
        console.error('❌ Fatal error:', err.message);
    } finally {
        await closeBrowser();
    }

    // ── FINAL REPORT ────────────────────────────────────────────
    console.log('\n' + '═'.repeat(50));
    console.log('📊 POPUP HANDLER — FINAL REPORT');
    console.log('═'.repeat(50));
    results.forEach(r => {
        console.log(`${r.status}  ${r.site}`);
        if (r.reason) console.log(`   Reason: ${r.reason}`);
    });
    const passed = results.filter(r => r.status.includes('PASS')).length;
    console.log('─'.repeat(50));
    console.log(`Result: ${passed}/${results.length} sites — popup successfully handled`);
    console.log('═'.repeat(50));
}

test();
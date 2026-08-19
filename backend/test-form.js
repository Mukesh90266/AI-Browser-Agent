// test-form.js — Form filling test

const { launchBrowser, navigateTo, closeBrowser, getPage } = require('./browser/BrowserManager');
const { extractDOM, formatForLLM } = require('./browser/DOMExtractor');
const { typeText, clickElement, scrollPage, pressEnter } = require('./browser/ActionExecutor');
const { takeScreenshot } = require('./browser/ScreenshotHelper');

async function fillField(selector, value, label) {
    const page = getPage();
    try {
        await page.fill(selector, value);
        console.log(`✅ ${label}: "${value}"`);
    } catch (e) {
        try {
            await page.click(selector);
            await page.waitForTimeout(200);
            await page.keyboard.type(value, { delay: 50 });
            console.log(`✅ ${label}: "${value}" (keyboard fallback)`);
        } catch (e2) {
            console.log(`⚠️  ${label} skip — field nahi mila`);
        }
    }
    await page.waitForTimeout(400);
}

// ─── TEST 1: Practicetestautomation — Real Practice Form ──────────
async function testPracticeForm() {
    const page = getPage();
    console.log('\n' + '═'.repeat(50));
    console.log('📝 TEST 1: Practice Automation Form');
    console.log('═'.repeat(50));

    // Yeh site specifically automation testing ke liye bani hai
    await navigateTo('https://practicetestautomation.com/practice-test-login/');
    await new Promise(r => setTimeout(r, 2000));

    const elements = await extractDOM();
    console.log(`\n✅ ${elements.length} elements extracted`);
    console.log('\n📋 Form elements:\n');
    console.log(formatForLLM(elements.filter(el =>
        el.type === 'input' || el.type === 'button'
    )));

    console.log('\n⌨️  Login form fill karna shuru...\n');

    // Correct credentials jo site pe diye hain
    await fillField('#username', 'student', 'Username');
    await fillField('#password', 'Password123', 'Password');

    const shot1 = await takeScreenshot();
    console.log(`📸 Before submit: ${shot1.length} chars`);

    // Submit button click karo
    await page.click('#submit');
    await new Promise(r => setTimeout(r, 2000));

    const finalUrl = page.url();
    console.log(`\n🌐 Final URL: ${finalUrl}`);

    const shot2 = await takeScreenshot();
    console.log(`📸 After submit: ${shot2.length} chars`);

    if (finalUrl.includes('logged-in')) {
        console.log('✅ LOGIN SUCCESSFUL! Form submit kaam kiya!');
    } else {
        console.log('⚠️  URL same raha — check karo');
    }

    console.log('\n✅ Test 1 — DONE');
}

// ─── TEST 2: DemoQA Form ──────────────────────────────────────────
async function testDemoQAForm() {
    const page = getPage();
    console.log('\n' + '═'.repeat(50));
    console.log('📝 TEST 2: DemoQA — Full Registration Form');
    console.log('═'.repeat(50));

    await navigateTo('https://demoqa.com/automation-practice-form');
    await new Promise(r => setTimeout(r, 2000));

    const elements = await extractDOM();
    console.log(`\n✅ ${elements.length} elements extracted`);

    const formFields = elements.filter(el =>
        el.type === 'input' || el.type === 'textarea'
    );
    console.log(`\n📋 Form fields (${formFields.length} total):\n`);
    console.log(formatForLLM(formFields.slice(0, 10)));

    console.log('\n⌨️  Form fill karna shuru...\n');

    await fillField('#firstName', 'Mukesh', 'First Name');
    await fillField('#lastName', 'Kumar', 'Last Name');
    await fillField('#userEmail', 'mukesh@test.com', 'Email');
    await fillField('#userNumber', '9876543210', 'Mobile');

    // Address field
    await fillField('#currentAddress', '123 Main Street, Panipat, Haryana', 'Address');

    await scrollPage('down');
    await new Promise(r => setTimeout(r, 1000));

    const shot = await takeScreenshot();
    console.log(`\n📸 Form filled: ${shot.length} chars`);

    // DOM se verify karo ki values fill hui
    const filledElements = await extractDOM();
    const filled = filledElements.filter(el =>
        el.type === 'input' && el.text && el.text.length > 0
    );
    console.log(`\n✅ ${filled.length} fields successfully filled`);
    console.log(formatForLLM(filled.slice(0, 6)));

    console.log('\n✅ Test 2 — DONE (submit nahi kiya — test mode)');
}

// ─── TEST 3: Auto-Detect — Agent Style ───────────────────────────
async function testAutoDetect() {
    const page = getPage();
    console.log('\n' + '═'.repeat(50));
    console.log('📝 TEST 3: Auto-Detect Fields (Agent Style)');
    console.log('═'.repeat(50));

    await navigateTo('https://demoqa.com/automation-practice-form');
    await new Promise(r => setTimeout(r, 2000));

    const elements = await extractDOM();

    // Sirf input fields lo
    const inputs = elements.filter(el =>
        el.type === 'input' &&
        el.inputType !== 'submit' &&
        el.inputType !== 'hidden' &&
        el.inputType !== 'radio' &&
        el.inputType !== 'checkbox'
    );

    console.log(`\n🤖 Agent style — ${inputs.length} fields auto-detect kiye:\n`);

    // Fake data map
    const fakeData = {
        name: 'Mukesh Kumar',
        first: 'Mukesh',
        last: 'Kumar',
        email: 'mukesh@example.com',
        mobile: '9876543210',
        phone: '9876543210',
        number: '9876543210',
        address: '123 Main St, Panipat',
        city: 'Panipat',
        state: 'Haryana',
        zip: '132103',
    };

    for (const field of inputs.slice(0, 8)) {
        const ph = (field.placeholder || '').toLowerCase();
        const id = (field.name || '').toLowerCase();

        let value = null;
        if (ph.includes('first') || id.includes('first')) value = fakeData.first;
        else if (ph.includes('last') || id.includes('last')) value = fakeData.last;
        else if (ph.includes('name') || id.includes('name')) value = fakeData.name;
        else if (ph.includes('email') || id.includes('email')) value = fakeData.email;
        else if (ph.includes('mobile') || ph.includes('phone') ||
            ph.includes('number') || id.includes('number')) value = fakeData.mobile;
        else if (ph.includes('address') || id.includes('address')) value = fakeData.address;
        else if (ph.includes('city') || id.includes('city')) value = fakeData.city;
        else if (ph.includes('zip') || id.includes('zip')) value = fakeData.zip;

        if (value) {
            try {
                const el = await page.$(`[data-agent-id="${field.id}"]`);
                if (el && await el.isVisible()) {
                    await el.fill(value);
                    console.log(`✅ "${field.placeholder}" → "${value}"`);
                }
            } catch (e) {
                console.log(`⚠️  "${field.placeholder}" → skip`);
            }
            await page.waitForTimeout(300);
        } else {
            console.log(`❓ "${field.placeholder}" → unknown field, skip`);
        }
    }

    const shot = await takeScreenshot();
    console.log(`\n📸 Auto-filled: ${shot.length} chars`);
    console.log('\n✅ Test 3 — Auto-Detect DONE');
}

// ─── MAIN ─────────────────────────────────────────────────────────
async function test() {
    console.log('\n🚀 Form Tests shuru ho rahe hain...');
    console.log('Sites: PracticeTestAutomation + DemoQA\n');

    const results = [];

    try {
        await launchBrowser();

        try {
            await testPracticeForm();
            results.push({ test: 'Login Form', status: '✅ PASS' });
        } catch (e) {
            console.error('❌ Test 1 failed:', e.message);
            results.push({ test: 'Login Form', status: '❌ FAIL' });
        }

        await new Promise(r => setTimeout(r, 1500));

        try {
            await testDemoQAForm();
            results.push({ test: 'Registration Form', status: '✅ PASS' });
        } catch (e) {
            console.error('❌ Test 2 failed:', e.message);
            results.push({ test: 'Registration Form', status: '❌ FAIL' });
        }

        await new Promise(r => setTimeout(r, 1500));

        try {
            await testAutoDetect();
            results.push({ test: 'Auto-Detect', status: '✅ PASS' });
        } catch (e) {
            console.error('❌ Test 3 failed:', e.message);
            results.push({ test: 'Auto-Detect', status: '❌ FAIL' });
        }

    } catch (err) {
        console.error('❌ Fatal:', err.message);
    } finally {
        await closeBrowser();
    }

    // Final report
    console.log('\n' + '═'.repeat(50));
    console.log('📊 FINAL REPORT');
    console.log('═'.repeat(50));
    results.forEach(r => console.log(`${r.status}  ${r.test}`));
    const passed = results.filter(r => r.status.includes('PASS')).length;
    console.log('─'.repeat(50));
    console.log(`Result: ${passed}/${results.length} tests passed`);
    console.log('═'.repeat(50));
}

test();
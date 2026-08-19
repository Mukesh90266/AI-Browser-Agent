// test-add-to-cart.js — Manual "Add to Cart" test (href-based navigation)

const { launchBrowser, navigateTo, closeBrowser, getPage } = require('./browser/BrowserManager');
const { extractDOM, formatForLLM } = require('./browser/DOMExtractor');
const { typeText, clickElement, pressEnter } = require('./browser/ActionExecutor');
const { closePopupIfExists } = require('./browser/PopupHandler');
const { takeScreenshot } = require('./browser/ScreenshotHelper');

async function test() {
    console.log('\n🚀 Manual "Add to Cart" Test\n');

    try {
        await launchBrowser();

        await navigateTo('https://www.flipkart.com');
        await closePopupIfExists();

        const elements = await extractDOM();
        const searchEl = elements.find(el =>
            el.type === 'input' && el.placeholder?.toLowerCase().includes('search')
        );

        console.log('⌨️  Searching for "wireless earphones"...');
        await typeText(searchEl.id, 'wireless earphones');
        await pressEnter();
        await new Promise(r => setTimeout(r, 3000));

        // Product link dhundo — price pattern se
        const resultElements = await extractDOM();
        const productLink = resultElements.find(el =>
            el.type === 'a' &&
            el.href &&
            el.href.includes('/p/') &&
            /₹[\d,]+/.test(el.text)
        );

        if (!productLink) {
            console.log('❌ Koi product link nahi mila');
            return;
        }

        console.log(`\n🖱️  Product mila: "${productLink.text}"`);
        console.log(`   Href: ${productLink.href}`);

        // ✅ FIX: Click ki jagah direct href navigate karo
        await navigateTo(productLink.href);
        await new Promise(r => setTimeout(r, 2500));

        const page = getPage();
        console.log(`\n🌐 New URL: ${page.url()}`);

        const productPageElements = await extractDOM();
        console.log(`📊 Product page elements: ${productPageElements.length}`);

        // Add to Cart dhundo
        const addToCartBtn = productPageElements.find(el =>
            (el.type === 'button' || el.type === 'a') &&
            (
                el.text?.toUpperCase().includes('ADD TO CART') ||
                el.text?.toUpperCase().includes('ADD TO BAG') ||
                el.text?.toUpperCase() === 'BUY NOW'
            )
        );

        if (addToCartBtn) {
            console.log(`\n✅ Button mila: Element#${addToCartBtn.id} — "${addToCartBtn.text}"`);

            const shot1 = await takeScreenshot();
            console.log(`📸 Before-click: ${shot1.length} chars`);

            await clickElement(addToCartBtn.id);
            await new Promise(r => setTimeout(r, 2000));

            const shot2 = await takeScreenshot();
            console.log(`📸 After-click: ${shot2.length} chars`);

            console.log('\n✅ TEST PASSED — Add to Cart worked!');
        } else {
            console.log('\n❌ "Add to Cart" button nahi mila');
            console.log('\n📋 All buttons on this page:');
            const buttons = productPageElements.filter(el => el.type === 'button');
            buttons.forEach(el => console.log(`   #${el.id}: "${el.text}"`));

            if (buttons.length === 0) {
                console.log('   (koi button element hi nahi mila — sample links dekho:)');
                productPageElements.filter(el => el.type === 'a').slice(0, 10)
                    .forEach(el => console.log(`   #${el.id}: "${el.text}"`));
            }
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
    } finally {
        await closeBrowser();
    }
}

test();
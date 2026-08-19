// test-google-search.js
//
// Search Engine → Search Query → Top Organic Result → Visit Website
//
// Run:
// node test-google-search.js

const {
    launchBrowser,
    navigateTo,
    closeBrowser,
    getPage
} = require('./browser/BrowserManager');

const {
    extractDOM,
    formatForLLM
} = require('./browser/DOMExtractor');

const {
    typeText,
    scrollPage,
    pressEnter
} = require('./browser/ActionExecutor');

const {
    takeScreenshot
} = require('./browser/ScreenshotHelper');

const {
    closePopupIfExists
} = require('./browser/PopupHandler');


// ================================================================
// TEST TRACKING
// ================================================================

const results = [];

function logPass(name, detail = '') {
    console.log(
        `✅ PASS — ${name}${detail ? `  (${detail})` : ''}`
    );

    results.push({
        name,
        status: 'PASS'
    });
}

function logFail(name, error) {
    console.log(`❌ FAIL — ${name}`);
    console.log(`   Error: ${error}`);

    results.push({
        name,
        status: 'FAIL',
        error
    });
}

function section(title) {
    console.log('\n' + '═'.repeat(70));
    console.log(`  ${title}`);
    console.log('═'.repeat(70));
}


// ================================================================
// HELPER — GET EXTERNAL LINKS DIRECTLY FROM BROWSER DOM
// ================================================================

async function getExternalLinksFromPage() {

    const page = getPage();

    console.log(
        '\n🔍 Inspecting actual browser DOM for links...'
    );

    const links = await page.locator('a[href]').evaluateAll(
        anchors => {

            return anchors.map((anchor, index) => {

                const text =
                    (
                        anchor.innerText ||
                        anchor.textContent ||
                        ''
                    )
                        .replace(/\s+/g, ' ')
                        .trim();

                return {
                    index,
                    text,
                    href: anchor.href,
                    ariaLabel:
                        anchor.getAttribute('aria-label') || '',
                    title:
                        anchor.getAttribute('title') || ''
                };
            });
        }
    );

    return links;
}


// ================================================================
// HELPER — FILTER VALID EXTERNAL LINKS
// ================================================================

function filterExternalLinks(links) {

    return links
        .filter(link => {

            if (!link.href) {
                return false;
            }

            if (!link.href.startsWith('http://') &&
                !link.href.startsWith('https://')) {
                return false;
            }

            const href =
                link.href.toLowerCase();

            // Search engine internal links
            if (
                href.includes('bing.com') ||
                href.includes('google.com') ||
                href.includes('microsoft.com')
            ) {
                return false;
            }

            // Empty title/text
            if (!link.text && !link.title && !link.ariaLabel) {
                return false;
            }

            return true;
        })
        .map((link, index) => ({

            id: `result-${index + 1}`,

            text:
                link.text ||
                link.title ||
                link.ariaLabel ||
                '(no title)',

            href: link.href
        }));
}


// ================================================================
// HELPER — FIND SEARCH INPUT
// ================================================================

function findSearchInput(elements) {

    return elements.find(el => {

        const name =
            el.name?.toLowerCase() || '';

        const placeholder =
            el.placeholder?.toLowerCase() || '';

        const ariaLabel =
            el.ariaLabel?.toLowerCase() || '';

        return (
            name === 'q' ||
            placeholder.includes('search') ||
            ariaLabel.includes('search') ||
            el.inputType === 'search'
        );
    });
}


// ================================================================
// MAIN TEST
// ================================================================

async function testSearchAndVisitTopResult() {

    section(
        'TEST — SEARCH → TOP RESULT → WEBSITE'
    );

    const query =
        'wireless earphones under 2000 rupees';

    console.log(
        `\n🎯 Query: "${query}"`
    );

    console.log(
        '🌐 Search Engine: https://www.bing.com\n'
    );


    try {

        // ============================================================
        // STEP 1 — OPEN BING
        // ============================================================

        console.log(
            '1️⃣ Opening search engine...'
        );

        await navigateTo(
            'https://www.bing.com'
        );

        await new Promise(resolve =>
            setTimeout(resolve, 2000)
        );

        await closePopupIfExists();

        logPass(
            'Search engine page loaded',
            'Bing'
        );


        // ============================================================
        // STEP 2 — EXTRACT DOM
        // ============================================================

        console.log(
            '\n2️⃣ Extracting search page DOM...'
        );

        const elements =
            await extractDOM();

        console.log(
            `📋 Extracted ${elements.length} elements`
        );


        // ============================================================
        // STEP 3 — FIND SEARCH BOX
        // ============================================================

        console.log(
            '\n3️⃣ Looking for search box...'
        );

        const searchEl =
            findSearchInput(elements);


        if (!searchEl) {

            logFail(
                'Search box detected',
                'No search input found'
            );

            return;
        }


        logPass(
            'Search box detected',
            `Element#${searchEl.id}`
        );


        // ============================================================
        // STEP 4 — TYPE SEARCH QUERY
        // ============================================================

        console.log(
            '\n4️⃣ Typing query...'
        );

        await typeText(
            searchEl.id,
            query
        );

        logPass(
            'Search query typed',
            query
        );


        // ============================================================
        // STEP 5 — SCREENSHOT BEFORE SEARCH
        // ============================================================

        const screenshotBefore =
            await takeScreenshot();

        console.log(
            `📸 Before-search screenshot: ${screenshotBefore.length} chars`
        );


        // ============================================================
        // STEP 6 — PRESS ENTER
        // ============================================================

        console.log(
            '\n5️⃣ Submitting search...'
        );

        await pressEnter();

        await new Promise(resolve =>
            setTimeout(resolve, 3000)
        );


        const page =
            getPage();

        const searchResultsUrl =
            page.url();


        console.log(
            `🌐 Results URL: ${searchResultsUrl}`
        );


        if (!searchResultsUrl) {

            logFail(
                'Search results page loaded',
                'URL unavailable'
            );

            return;
        }


        logPass(
            'Search results page loaded',
            searchResultsUrl
        );


        // ============================================================
        // STEP 7 — EXTRACT RESULTS DOM
        // ============================================================

        console.log(
            '\n6️⃣ Extracting search results DOM...'
        );

        const resultElements =
            await extractDOM();

        console.log(
            `📋 Result page elements: ${resultElements.length}`
        );


        // ============================================================
        // STEP 8 — PRINT SAMPLE RESULTS
        // ============================================================

        console.log(
            '\n📋 SEARCH RESULT DOM — SAMPLE'
        );

        console.log(
            '─'.repeat(70)
        );

        console.log(
            formatForLLM(
                resultElements.slice(0, 30)
            )
        );


        // ============================================================
        // STEP 9 — GET ACTUAL ANCHORS
        // ============================================================

        console.log(
            '\n7️⃣ Finding actual result links...'
        );

        const browserLinks =
            await getExternalLinksFromPage();

        console.log(
            `🔗 Total <a href> elements: ${browserLinks.length}`
        );


        // ============================================================
        // STEP 10 — FILTER EXTERNAL LINKS
        // ============================================================

        let resultLinks =
            filterExternalLinks(
                browserLinks
            );


        console.log(
            `🌐 External links found: ${resultLinks.length}`
        );


        if (resultLinks.length === 0) {

            logFail(
                'External search results found',
                'No external links detected'
            );

            return;
        }


        logPass(
            'External search results found',
            `${resultLinks.length} links`
        );


        // ============================================================
        // STEP 11 — DISPLAY TOP RESULTS
        // ============================================================

        console.log(
            '\n📋 TOP SEARCH RESULTS'
        );

        console.log(
            '─'.repeat(70)
        );


        resultLinks
            .slice(0, 10)
            .forEach((link, index) => {

                console.log(
                    `\n#${index + 1}`
                );

                console.log(
                    `   ID: ${link.id}`
                );

                console.log(
                    `   Title: ${link.text}`
                );

                console.log(
                    `   URL: ${link.href}`
                );
            });


        // ============================================================
        // STEP 12 — SELECT TOP RESULT
        // ============================================================

        const topResult =
            resultLinks[0];


        console.log(
            '\n' + '─'.repeat(70)
        );

        console.log(
            '🎯 SELECTED TOP RESULT'
        );

        console.log(
            '─'.repeat(70)
        );

        console.log(
            `Title: ${topResult.text}`
        );

        console.log(
            `URL: ${topResult.href}`
        );


        logPass(
            'Top result selected',
            topResult.href
        );


        // ============================================================
        // STEP 13 — VISIT TOP RESULT
        // ============================================================

        console.log(
            '\n8️⃣ Visiting top result website...'
        );

        await navigateTo(
            topResult.href
        );

        await new Promise(resolve =>
            setTimeout(resolve, 3000)
        );


        const visitedUrl =
            page.url();


        console.log(
            `🌐 Current website URL: ${visitedUrl}`
        );


        if (!visitedUrl) {

            logFail(
                'Top result website opened',
                'URL unavailable'
            );

            return;
        }


        logPass(
            'Top result website opened',
            visitedUrl
        );


        // ============================================================
        // STEP 14 — POPUP CHECK
        // ============================================================

        console.log(
            '\n9️⃣ Checking for popup...'
        );

        try {

            await closePopupIfExists();

            console.log(
                '✓ Popup check completed'
            );

        } catch (popupError) {

            console.log(
                `⚠️ Popup handler warning: ${popupError.message}`
            );
        }


        // ============================================================
        // STEP 15 — EXTRACT VISITED WEBSITE DOM
        // ============================================================

        console.log(
            '\n🔟 Extracting visited website DOM...'
        );

        const websiteElements =
            await extractDOM();


        console.log(
            `📋 Website elements: ${websiteElements.length}`
        );


        if (websiteElements.length > 0) {

            logPass(
                'Visited website DOM extracted',
                `${websiteElements.length} elements`
            );

        } else {

            logFail(
                'Visited website DOM extracted',
                'No elements found'
            );

            return;
        }


        // ============================================================
        // STEP 16 — DISPLAY WEBSITE DOM
        // ============================================================

        console.log(
            '\n📋 VISITED WEBSITE — TOP 20 ELEMENTS'
        );

        console.log(
            '─'.repeat(70)
        );

        console.log(
            formatForLLM(
                websiteElements.slice(0, 20)
            )
        );


        // ============================================================
        // STEP 17 — WEBSITE SCREENSHOT
        // ============================================================

        const screenshotAfter =
            await takeScreenshot();

        console.log(
            `\n📸 Website screenshot: ${screenshotAfter.length} chars`
        );


        // ============================================================
        // STEP 18 — SCROLL WEBSITE
        // ============================================================

        console.log(
            '\n1️⃣1️⃣ Testing website scroll...'
        );

        await scrollPage(
            'down'
        );

        await new Promise(resolve =>
            setTimeout(resolve, 1000)
        );

        logPass(
            'Visited website scroll'
        );


        // ============================================================
        // FINAL FLOW SUCCESS
        // ============================================================

        section(
            '🎉 SEARCH → RESULT → WEBSITE FLOW COMPLETED'
        );


    } catch (err) {

        logFail(
            'Search + website visit flow',
            err.message
        );
    }
}


// ================================================================
// MAIN
// ================================================================

async function test() {

    console.log(
        '\n🚀 SEARCH → WEBSITE VISIT TEST\n'
    );


    try {

        await launchBrowser();

        await testSearchAndVisitTopResult();

    } catch (err) {

        console.error(
            '❌ Fatal:',
            err.message
        );

    } finally {

        await closeBrowser();
    }


    // ============================================================
    // FINAL REPORT
    // ============================================================

    console.log(
        '\n' + '═'.repeat(70)
    );

    console.log(
        '  📊 FINAL TEST REPORT'
    );

    console.log(
        '═'.repeat(70)
    );


    results.forEach(result => {

        const icon =
            result.status === 'PASS'
                ? '✅'
                : '❌';

        console.log(
            `${icon}  ${result.name}`
        );
    });


    const passed =
        results.filter(
            result => result.status === 'PASS'
        ).length;


    const failed =
        results.length - passed;


    console.log(
        '─'.repeat(70)
    );

    console.log(
        `TOTAL: ${results.length}` +
        `  |  PASSED: ${passed}` +
        `  |  FAILED: ${failed}`
    );

    console.log(
        '═'.repeat(70)
    );
}


// ================================================================
// RUN
// ================================================================

test();
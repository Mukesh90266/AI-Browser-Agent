// pageContext.js — Converts DOMExtractor output into concise, safe voice context.
function clean(value, max = 220) {
    return (value || '').toString().replace(/\s+/g, ' ').trim().slice(0, max);
}

function inferPageType({ url = '', isProductDetailsPage = false, productInfo = {}, pageTextSnippets = [] }) {
    const text = pageTextSnippets.join(' ');
    if (/login|sign in|create account/i.test(text) && /password/i.test(text)) return 'login_required';
    if (/(cart|basket|bag|checkout)/i.test(url)) return 'cart';
    if (isProductDetailsPage || /\/(?:dp|product|products|itm|p)\//i.test(url)) return 'product_detail';
    if (/[?&](?:q|query|keyword)=|\/search|\/s\?/i.test(url)) return 'search_results';
    if (productInfo?.title || productInfo?.price) return 'product_detail';
    if (/weather|temperature|forecast|°c|°f/i.test(text)) return 'information';
    return 'general';
}

function extractItems(snippets = []) {
    return snippets
        .map(clean)
        .filter((line) => /^\[(?:PRODUCT|PRODUCT NAME|PRICE|TABLE ROW|HIGHLIGHT \/ ANSWER)\]/i.test(line) || /(?:₹|Rs\.?|INR|\$|€|£)\s*[\d,]+/i.test(line))
        .slice(0, 12)
        .map((line, index) => ({ position: index + 1, text: line }));
}

function buildPageContext(domData = {}, meta = {}) {
    const data = Array.isArray(domData) ? domData : (domData || {});
    const snippets = data.pageTextSnippets || [];
    const productInfo = data.productInfo || {};
    const context = {
        pageType: inferPageType({ ...data, url: meta.url || data.url || '' }),
        url: clean(meta.url || data.url, 500),
        title: clean(meta.title || data.title),
        summary: clean(snippets.slice(0, 4).join(' | '), 500),
        items: extractItems(snippets),
        currentProduct: (productInfo.title || productInfo.price) ? {
            name: clean(productInfo.title),
            price: clean(productInfo.price),
        } : null,
        visibleText: snippets.slice(0, 20).map((item) => clean(item, 300)),
        updatedAt: new Date().toISOString(),
    };
    return context;
}

module.exports = { buildPageContext };

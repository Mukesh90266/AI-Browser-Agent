// DOMExtractor.js — Converts live webpage DOM into clean, structured, LLM-friendly format

const { getPage } = require('./BrowserManager');
const logger = require('../utils/logger');

/**
 * Extracts visible interactive elements, search bars, size selectors, e-commerce products, tables, prices, and page content.
 */
async function extractDOM() {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Cannot extract DOM: browser page is closed');

    const domData = await page.evaluate(() => {
        const results = [];
        let nextId = 1;

        const currentUrl = window.location.href.toLowerCase();
        const isProductDetailsPage = currentUrl.includes('/dp/') || currentUrl.includes('/p/') || currentUrl.includes('/product/') || currentUrl.includes('/pn/') || currentUrl.includes('/prid/') || currentUrl.includes('/itm');

        // 1. Strictly target genuine interactive elements (inputs, links, buttons, selects, size buttons, Flipkart buybox)
        const interactiveSelectors = [
            'input[id="twotabsearchtextbox"]',
            'input[name="q"]',
            'input[placeholder*="search" i]',
            'input[type="search"]',
            'button',
            'button[class*="2KpZ6l"]',
            'button[class*="_2U9uOA"]',
            'div[class*="2KpZ6l"]',
            'input[id="add-to-cart-button"]',
            'input[name="submit.add-to-cart"]',
            'input[name="submit.buy-now"]',
            'input[type="submit"]',
            'input:not([type="hidden"])',
            'a[href]',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[role="searchbox"]',
            '[role="tab"]',
            '[role="menuitem"]',
            '[role="option"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[onclick]',
            'summary',
            '[contenteditable="true"]',
            'li[class*="size" i] a',
            'div[class*="size" i] a',
            'span[class*="size" i]',
        ].join(', ');

        const elements = document.querySelectorAll(interactiveSelectors);

        elements.forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') {
                return;
            }

            // Header & Nav ancestors filter ONLY on product details pages
            if (isProductDetailsPage) {
                const skipAncestor = el.closest('header, nav, [role="navigation"], [role="banner"], #nav-bar, .navbar, #navbar, #nav-belt, ._1kidPb, ._2msBFL, #nav-main');
                if (skipAncestor) return;
            }

            const href = el.href ? (el.href.startsWith('javascript') ? '' : el.href) : '';

            // Ignore third-party sponsored ad tracking redirect links
            if (href && (href.includes('/aclk?') || href.includes('googleadservices') || href.includes('doubleclick') || href.includes('&ntb=1'))) {
                return;
            }

            const tagName = el.tagName.toLowerCase();
            let textContent = (
                el.innerText ||
                el.value ||
                el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.getAttribute('alt') ||
                ''
            ).replace(/\s+/g, ' ').trim().slice(0, 120);

            // Prepend brand name if on an e-commerce product card
            const productCardContainer = el.closest('div[data-id], div._75nlfW, div.tUxRFH, div._1sdMkc, [data-component-type="s-search-result"], .s-result-item');
            if (productCardContainer && (tagName === 'a' || tagName === 'button')) {
                const brandEl = productCardContainer.querySelector('div._2WkVRV, ._2WkVRV, [class*="brand" i]');
                if (brandEl && brandEl.innerText) {
                    const brandText = brandEl.innerText.trim();
                    if (brandText && !textContent.toLowerCase().includes(brandText.toLowerCase())) {
                        textContent = `${brandText} — ${textContent}`;
                    }
                }
            }

            // Special handling for Amazon & e-commerce Add to Cart submit inputs
            if (el.id === 'add-to-cart-button' || el.name === 'submit.add-to-cart') {
                textContent = 'Add to Cart';
            }

            const isCartBtn = el.id === 'add-to-cart-button' || el.name === 'submit.add-to-cart' || (textContent && /add to cart|buy now|add to bag|buy at|\badd\b/i.test(textContent));

            // Useless hrefs filter on product pages (never skip real cart buttons)
            if (isProductDetailsPage && !isCartBtn) {
                const badHref = ['/', '/login', '/account', '/wishlist', '/cart', '/customer-preferences', '/customer-preferences/edit'];
                if (href && badHref.some(h => href === h || href.endsWith(h) || href.split('?')[0].endsWith(h))) {
                    return;
                }
            }

            el.setAttribute('data-agent-id', nextId);

            // Smart label extraction for inputs and search boxes
            let placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '';

            if (!placeholder) {
                const labelledBy = el.getAttribute('aria-labelledby');
                if (labelledBy) {
                    const ids = labelledBy.split(' ');
                    const labelTexts = ids.map(id => document.getElementById(id)?.innerText?.trim()).filter(Boolean);
                    if (labelTexts.length > 0) placeholder = labelTexts.join(' ');
                }
            }

            if (!placeholder) {
                const container = el.closest('[role="listitem"], .Qr7Oae, .geS5n, .freebirdFormviewerViewItemsItemItem, .form-group, fieldset, form');
                if (container) {
                    const heading = container.querySelector('.M7eMe, [role="heading"], label, legend, .exportItemTitle');
                    if (heading) {
                        const headingText = heading.innerText?.replace(/\s+/g, ' ').trim();
                        if (headingText) placeholder = headingText;
                    }
                }
            }

            // Radio/checkbox sibling label detection
            if (!textContent && (el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'checkbox' || el.type === 'radio' || el.type === 'checkbox')) {
                const parentLabel = el.closest('label') || el.parentElement;
                if (parentLabel) {
                    textContent = parentLabel.innerText?.replace(/\s+/g, ' ').trim() || '';
                }
            }

            const name = el.getAttribute('name') || '';
            const role = el.getAttribute('role') || '';
            const inputType = el.getAttribute('type') || (tagName === 'textarea' ? 'textarea' : '');

            let options = [];
            if (tagName === 'select') {
                options = Array.from(el.options || []).map(opt => (opt.text || opt.value).trim()).slice(0, 8);
            }

            const isInput = (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || el.getAttribute('contenteditable') === 'true') && !isCartBtn;

            // Strict Size Option Detection
            const isCategoryBreadcrumb = href && (/mens-footwear|womens-footwear|\/browse\/|sid=osp|\/pr\?/i.test(href));
            const sizeContainer = el.closest('[class*="size" i], [class*="Size" i], div._2OTVHc, ul._1q8KgP, div._3V2wfe, li._3V2wfe, div[class*="UHed57" i]');
            const parentBlockText = (el.parentElement?.innerText || '').toLowerCase();
            const hasSizeContext = parentBlockText.includes('size') || parentBlockText.includes('uk') || parentBlockText.includes('eur');

            const isSizeOption = isProductDetailsPage && !isCategoryBreadcrumb && (sizeContainer !== null || hasSizeContext) && (textContent && /^(UK\s*\d+(\.\d+)?|\d+(\.\d+)?|S|M|L|XL|XXL|Free Size)$/i.test(textContent));

            const hasMeaningfulContent = textContent.length > 0 || placeholder.length > 0 || name.length > 0 || href.length > 0 || isCartBtn;

            if (isInput || hasMeaningfulContent) {
                const isSearch = isInput && (el.id === 'twotabsearchtextbox' || name === 'q' || inputType === 'search' || placeholder.toLowerCase().includes('search') || el.getAttribute('role') === 'searchbox');
                let displayType = tagName;
                if (isCartBtn) displayType = 'button';
                else if (isSearch) displayType = 'search input';
                else if (isSizeOption && (tagName === 'a' || tagName === 'button' || tagName === 'li' || tagName === 'span')) displayType = 'size option';

                results.push({
                    id: nextId,
                    type: displayType,
                    role,
                    text: textContent,
                    placeholder,
                    name,
                    inputType: isInput ? inputType : '',
                    href,
                    options: options.length > 0 ? options : undefined,
                    value: isInput ? (el.value || '') : undefined,
                    isSearch,
                    isActionBtn: isProductDetailsPage && isCartBtn,
                    isSize: isSizeOption,
                });
                nextId++;
            }
        });

        // 2. Extract key page text: Products with prices, tables, weather, flights
        const textSnippets = [];
        const seenTexts = new Set();

        // 2a. E-Commerce Product Cards & Details (Flipkart, Amazon, Zepto, Blinkit, Myntra)
        const productSelectors = [
            'div[data-id]', 'div._75nlfW', 'div.tUxRFH', 'div._1sdMkc', 'div._2kHMtA',
            'span.B_NuCI', 'h1.yhB1nd', 'span.VU-ZEz', 'div._30jeq3._16Jk6d', 'div.Nx9bqj.CxhGGd', 'div._30jeq3',
            '#productTitle', 'span.a-price-whole', '#corePrice_feature_div', '#apex_desktop',
            '[data-component-type="s-search-result"]', '.s-result-item',
            '[data-testid*="product" i]', '[class*="ProductCard" i]', '[class*="product-card" i]',
        ].join(', ');

        const productCards = document.querySelectorAll(productSelectors);
        productCards.forEach((card) => {
            const rect = card.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(card);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            const titleEl = card.querySelector('div.KzDlHZ, a.wjcEIp, a.WKTcLC, ._2WkVRV, .s1Q9rs, [data-testid*="title" i], h1, h2, h3, h4, a[title], span.a-text-normal, [class*="title" i]');
            const priceEl = card.querySelector('div.Nx9bqj, div._30jeq3, [data-testid*="price" i], .br-price, .b_price, span.a-price-whole, .a-price, span.a-offscreen');
            const storeEl = card.querySelector('.br-seller, [class*="merchant" i], [class*="store" i]');

            const title = (titleEl?.innerText || titleEl?.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
            const price = (priceEl?.innerText || '').replace(/\s+/g, ' ').trim();
            const store = (storeEl?.innerText || '').replace(/\s+/g, ' ').trim();

            if (title || price) {
                const itemStr = title && price
                    ? `[PRODUCT] ${title} — Price: ${price}${store ? ` [${store}]` : ''}`
                    : (price ? `[PRICE] ${price}` : `[PRODUCT NAME] ${title}`);
                if (!seenTexts.has(itemStr)) {
                    seenTexts.add(itemStr);
                    textSnippets.push(itemStr);
                }
            }
        });

        // 2b. Structured Tables (Points tables, standings, rankings)
        const tables = document.querySelectorAll('table');
        tables.forEach((table) => {
            const rect = table.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th')).map(th => th.innerText.trim()).filter(Boolean);
            const rows = table.querySelectorAll('tbody tr, tr');
            rows.forEach((row) => {
                const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
                if (cells.length >= 2) {
                    const rowStr = (headers.length === cells.length)
                        ? `[TABLE ROW] ${headers.map((h, i) => `${h}: ${cells[i]}`).join(' | ')}`
                        : `[TABLE ROW] ${cells.join(' | ')}`;
                    if (!seenTexts.has(rowStr) && rowStr.length < 350) {
                        seenTexts.add(rowStr);
                        textSnippets.push(rowStr);
                    }
                }
            });
        });

        // 2c. Priority widgets: Weather cards, knowledge answer boxes, price widgets
        const prioritySelectors = [
            '#wtr_ans', '.wtr_curRprt', '.wtr_temp', '.wtr_cond', '.wtr_preview', '#wtr_forecast',
            '#wob_wc', '#wob_tm', '#wob_dc', '#wob_loc',
            '.b_focusTextLarge', '.b_focusTextExtra', '.b_entityTitle',
            '[class*="flight" i]', '[class*="price" i]', '[class*="fare" i]', '[class*="cal_day" i]',
        ].join(', ');

        const priorityNodes = document.querySelectorAll(prioritySelectors);
        priorityNodes.forEach((node) => {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const text = (node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (text.length >= 2 && text.length < 350 && !seenTexts.has(text)) {
                seenTexts.add(text);
                textSnippets.push(`[HIGHLIGHT / ANSWER] ${text}`);
            }
        });

        // 2d. General organic snippets & search results
        const generalSelectors = [
            'h1', 'h2', 'h3', 'h4',
            '.b_algo', '.b_caption', '.b_snippet', '.b_ans',
            '.g', '.tF2Cxc', '[data-snippet]', '.VwiC3b',
            '[role="alert"]', 'p', 'li',
        ].join(', ');

        const generalNodes = document.querySelectorAll(generalSelectors);
        generalNodes.forEach((node) => {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            const text = (node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            const isRelevant = /[\$₹€£°%]|nike|shoes|coconut|zepto|blinkit|flipkart|amazon|price|rs\.?|inr|weather|temperature|\bfare\b|\bflight\b/i.test(text);

            if (text.length >= 3 && text.length < 400 && !seenTexts.has(text)) {
                if (isRelevant || text.length >= 10) {
                    seenTexts.add(text);
                    textSnippets.push(text);
                }
            }
        });

        return {
            elements: results,
            pageTextSnippets: textSnippets.slice(0, 35),
            title: document.title || '',
            url: window.location.href,
        };
    });

    const elementArray = domData.elements;
    elementArray.elements = domData.elements;
    elementArray.pageTextSnippets = domData.pageTextSnippets;
    elementArray.title = domData.title;
    elementArray.url = domData.url;

    logger.debug(`Extracted ${elementArray.length} interactive elements and ${domData.pageTextSnippets.length} content snippets`);
    return elementArray;
}

/**
 * Converts element objects into clean, LLM-readable text format.
 */
function formatForLLM(elements) {
    const list = Array.isArray(elements) ? elements : (elements?.elements || []);
    if (!list || list.length === 0) {
        return '(No interactive elements found on current view)';
    }

    return list.map((el) => {
        const cleanText = (el.text || '').replace(/\s+/g, ' ').trim();
        const roleAttr = el.role ? ` role="${el.role}"` : '';

        if (el.type === 'input' || el.type === 'textarea' || el.type === 'search input') {
            const typeStr = el.inputType ? `${el.inputType} input` : 'input';
            const labelStr = el.placeholder ? ` placeholder="${el.placeholder}"` : (el.name ? ` name="${el.name}"` : '');
            const valStr = el.value ? ` current_value="${el.value}"` : '';
            return `Element#${el.id} [${typeStr}]${roleAttr}${labelStr}${valStr}`;
        }

        if (el.type === 'select') {
            const optsStr = el.options ? ` options=[${el.options.join(', ')}]` : '';
            const nameStr = el.name ? ` name="${el.name}"` : '';
            return `Element#${el.id} [select dropdown]${nameStr}${optsStr}`;
        }

        if (el.type === 'size option') {
            return `Element#${el.id} [size option] text="${cleanText}"`;
        }

        if (el.type === 'a') {
            const hrefHint = el.href ? ` href="${el.href.slice(0, 60)}"` : '';
            return `Element#${el.id} [link] text="${cleanText}"${hrefHint}`;
        }

        if (el.type === 'button' || el.role === 'button') {
            return `Element#${el.id} [button] text="${cleanText}"`;
        }

        return `Element#${el.id} [${el.type}]${roleAttr} text="${cleanText}"`;
    }).join('\n');
}

/**
 * Splits an array of elements into smaller chunks for LLM token limits.
 */
function chunkElements(elements, chunkSize = 50) {
    const list = Array.isArray(elements) ? elements : (elements?.elements || []);
    const chunks = [];
    for (let i = 0; i < list.length; i += chunkSize) {
        chunks.push(list.slice(i, i + chunkSize));
    }
    return chunks.length > 0 ? chunks : [[]];
}

module.exports = {
    extractDOM,
    formatForLLM,
    chunkElements,
};

// DOMExtractor.js — Converts live webpage DOM into clean, structured, LLM-friendly format

const { getPage } = require('./BrowserManager');
const logger = require('../utils/logger');

/**
 * Extracts visible interactive elements, product listings with prices, weather, and key page content.
 */
async function extractDOM() {
    const page = getPage();
    if (!page || page.isClosed()) throw new Error('Cannot extract DOM: browser page is closed');

    const domData = await page.evaluate(() => {
        const results = [];
        let nextId = 1;

        // 1. Extract interactive elements
        const interactiveSelectors = [
            'a[href]',
            'button',
            'input',
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
        ].join(', ');

        const elements = document.querySelectorAll(interactiveSelectors);

        elements.forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

            el.setAttribute('data-agent-id', nextId);

            const tagName = el.tagName.toLowerCase();
            let textContent = (
                el.innerText ||
                el.value ||
                el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.getAttribute('alt') ||
                ''
            ).replace(/\s+/g, ' ').trim().slice(0, 120);

            // Smart label extraction for Google Forms, complex forms, and inputs
            let placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';

            if (!placeholder) {
                const labelledBy = el.getAttribute('aria-labelledby');
                if (labelledBy) {
                    const ids = labelledBy.split(' ');
                    const labelTexts = ids.map(id => document.getElementById(id)?.innerText?.trim()).filter(Boolean);
                    if (labelTexts.length > 0) placeholder = labelTexts.join(' ');
                }
            }

            // Google Forms question container label detection
            if (!placeholder) {
                const container = el.closest('[role="listitem"], .Qr7Oae, .geS5n, .freebirdFormviewerViewItemsItemItem, .form-group, fieldset');
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
            const href = el.href ? (el.href.startsWith('javascript') ? '' : el.href) : '';

            let options = [];
            if (tagName === 'select') {
                options = Array.from(el.options || []).map(opt => (opt.text || opt.value).trim()).slice(0, 8);
            }

            const isInput = tagName === 'input' || tagName === 'textarea' || tagName === 'select';
            const hasMeaningfulContent = textContent.length > 0 || placeholder.length > 0 || name.length > 0 || href.length > 0;

            if (isInput || hasMeaningfulContent) {
                results.push({
                    id: nextId,
                    type: tagName,
                    role,
                    text: textContent,
                    placeholder,
                    name,
                    inputType,
                    href,
                    options: options.length > 0 ? options : undefined,
                    value: isInput ? (el.value || '') : undefined,
                });
                nextId++;
            }
        });

        // 2. Extract key page text: Products with prices, weather, flights, answers
        const textSnippets = [];
        const seenTexts = new Set();

        // 2a. Structured Product Cards & Shopping Carousel Items (Bing, Google, Amazon, Flipkart)
        const productSelectors = [
            '.br-product-card', '.br-card', '.c_carousel .slide', '.b_richCard',
            '.pla-unit', '.sh-dgr__content', '[data-component-type="s-search-result"]', '.s-result-item',
            'div[data-docid]', '.sh-np__click-target',
        ].join(', ');

        const productCards = document.querySelectorAll(productSelectors);
        productCards.forEach((card) => {
            const rect = card.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(card);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            const titleEl = card.querySelector('.br-title, h2, h3, a[title], .sh-np__product-title, span.a-text-normal, [class*="title" i]');
            const priceEl = card.querySelector('.br-price, .b_price, [class*="price" i], span.a-price-whole, .a-price, [class*="offer" i]');
            const storeEl = card.querySelector('.br-seller, [class*="merchant" i], [class*="store" i], [class*="seller" i]');

            const title = (titleEl?.innerText || titleEl?.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
            const price = (priceEl?.innerText || '').replace(/\s+/g, ' ').trim();
            const store = (storeEl?.innerText || '').replace(/\s+/g, ' ').trim();

            if (title && price) {
                const itemStr = `[PRODUCT OPTION] ${title} | Price: ${price}${store ? ` (from ${store})` : ''}`;
                if (!seenTexts.has(itemStr)) {
                    seenTexts.add(itemStr);
                    textSnippets.push(itemStr);
                }
            }
        });

        // 2b. Priority widgets: Weather cards, knowledge answer boxes, price widgets
        const prioritySelectors = [
            '#wtr_ans', '.wtr_curRprt', '.wtr_temp', '.wtr_cond', '.wtr_preview', '#wtr_forecast', // Weather
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

        // 2c. General organic snippets & search results
        const generalSelectors = [
            'h1', 'h2', 'h3', 'h4',
            '.b_algo', '.b_caption', '.b_snippet', '.b_ans',
            '.g', '.tF2Cxc', '[data-snippet]', '.VwiC3b',
            '[role="alert"]', 'p', 'li', 'td',
        ].join(', ');

        const generalNodes = document.querySelectorAll(generalSelectors);
        generalNodes.forEach((node) => {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            const text = (node.innerText || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            const isRelevant = /[\$₹€£°]|keyboard|wireless|mechanical|price|rs\.?|inr|weather|temperature|\bfare\b|\bflight\b/i.test(text);

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

        if (el.type === 'input' || el.type === 'textarea') {
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

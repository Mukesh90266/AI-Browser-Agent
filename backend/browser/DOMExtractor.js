// DOMExtractor.js — Converts live webpage DOM into clean, structured, LLM-friendly format

const { getPage } = require('./BrowserManager');
const logger = require('../utils/logger');

/**
 * Extracts visible interactive elements and a summary of key page text from the active page.
 * Returns an array of interactive element objects with attached page metadata.
 */
async function extractDOM() {
    const page = getPage();
    if (!page) throw new Error('Cannot extract DOM: browser is not open');

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
            // Ignore hidden/zero-sized elements
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

            // Set temporary agent ID attribute
            el.setAttribute('data-agent-id', nextId);

            const tagName = el.tagName.toLowerCase();
            const textContent = (
                el.innerText ||
                el.value ||
                el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.getAttribute('alt') ||
                ''
            ).replace(/\s+/g, ' ').trim().slice(0, 100);

            const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
            const name = el.getAttribute('name') || '';
            const role = el.getAttribute('role') || '';
            const inputType = el.getAttribute('type') || (tagName === 'textarea' ? 'textarea' : '');
            const href = el.href ? (el.href.startsWith('javascript') ? '' : el.href) : '';

            // Handle select options
            let options = [];
            if (tagName === 'select') {
                options = Array.from(el.options || []).map(opt => (opt.text || opt.value).trim()).slice(0, 8);
            }

            // Only keep elements that have text, label, placeholder, name, href, or are inputs
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

        // 2. Extract key page text / content summary (search results, flight info, prices, headings, answers)
        const textSnippets = [];
        const contentSelectors = [
            'h1', 'h2', 'h3', 'h4',
            '.b_algo', '.b_caption', '.b_snippet', '.b_ans', // Bing search result containers
            '.g', '.tF2Cxc', '[data-snippet]', // Google search result containers
            '[class*="flight" i]', '[class*="price" i]', '[class*="fare" i]', '[class*="result" i]',
            '[role="alert"]', '[class*="message" i]', '[class*="answer" i]', 'p', 'li',
        ].join(', ');

        const contentNodes = document.querySelectorAll(contentSelectors);

        contentNodes.forEach((node) => {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
            if (text.length > 8 && text.length < 350 && !textSnippets.includes(text)) {
                textSnippets.push(text);
            }
        });

        return {
            elements: results,
            pageTextSnippets: textSnippets.slice(0, 20),
            title: document.title || '',
            url: window.location.href,
        };
    });

    // Make the return value behave as an array while holding metadata
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

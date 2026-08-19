// DOMExtractor.js — Page ko LLM-friendly element list mein convert karna

const { getPage } = require('./BrowserManager');

async function extractDOM() {
    const page = getPage();

    const elements = await page.evaluate(() => {
        const results = [];
        let id = 1;

        const selectors = 'a, button, input, textarea, select, [role="button"], [onclick]';
        const nodes = document.querySelectorAll(selectors);

        nodes.forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            if (el.offsetParent === null) return;

            el.setAttribute('data-agent-id', id);

            const info = {
                id: id,
                type: el.tagName.toLowerCase(),
                text: (el.innerText || el.value || el.placeholder || el.ariaLabel || el.title || '').trim().slice(0, 80),
                placeholder: el.placeholder || el.ariaLabel || el.name || '',
                href: el.href || '',
                inputType: el.type || '',
                name: el.name || '',
            };

            const isSearchInput = el.type === 'search' ||
                el.name === 'q' ||
                el.name === 'search' ||
                el.role === 'searchbox';

            if (info.text || info.placeholder || info.href || isSearchInput) {
                results.push(info);
                id++;
            }
        });
        return results;
    });

    console.log(`✅ Extracted ${elements.length} elements from page`);

    if (process.env.SHOW_DOM === 'true') {
        console.log('\n📋 EXTRACTED DOM ELEMENTS:\n');
        elements.forEach(el => {
            console.log(`#${el.id} [${el.type}] text="${el.text}" placeholder="${el.placeholder}"`);
        });

        const fs = require('fs');
        fs.writeFileSync('dom-output.json', JSON.stringify(elements, null, 2));
        console.log(`\n✅ Saved ${elements.length} elements to dom-output.json\n`);
    }

    return elements;
}

// Elements ko readable string mein convert karo (LLM ke liye)
function formatForLLM(elements) {
    return elements.map(el => {
        const cleanText = (el.text || '').replace(/\s+/g, ' ').trim();
        if (el.type === 'input' || el.type === 'textarea') {
            const label = el.placeholder || el.name || 'input';
            return `Element#${el.id} [${el.inputType || 'text'} input] placeholder="${label}"`;
        }
        if (el.type === 'a') {
            return `Element#${el.id} [link] text="${cleanText}"`;
        }
        return `Element#${el.id} [${el.type}] text="${cleanText}"`;
    }).join('\n');
}

// Poore elements ko chote chunks mein todo (chunking ke liye)
function chunkElements(elements, chunkSize = 50) {
    const chunks = [];
    for (let i = 0; i < elements.length; i += chunkSize) {
        chunks.push(elements.slice(i, i + chunkSize));
    }
    return chunks;
}

// ✅ SIRF EK module.exports — sabhi functions ek saath
module.exports = { extractDOM, formatForLLM, chunkElements };
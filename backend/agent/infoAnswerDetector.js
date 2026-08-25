// infoAnswerDetector.js — deterministic safety net for read-only information goals.
// When the user only asked to FIND/TELL/SHOW/COMPARE information (price, cheapest
// fare, best option, time, score, list...), and the page text already contains a
// clear answer value, we return a "done" action instead of letting the model keep
// drilling into View Prices / Book Now / Buy controls.
//
// This is intentionally conservative: it only fires for information-only goals
// (never for add-to-cart/buy/booking goals) and only when a value matching the
// requested entity is actually visible in the extracted text.

const { isInformationGoal } = require('../utils/taskClassifier');

// Extract a money value (₹/Rs/INR) plus optional surrounding label from a snippet.
function extractPrice(line) {
    // e.g. "Rs.4770 - 03 Sep", "₹4,770", "INR 12,999", "Rs. 15865"
    const m = line.match(/(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
    if (!m) return null;
    const value = m[1].replace(/,/g, '');
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return { raw: m[0].trim(), value: num, line: line.trim() };
}

// Looks for a row/line pairing a label with a price on summary panels.
function findLabeledPrice(snippets, labelPattern) {
    for (const raw of snippets) {
        const line = (raw || '').toString();
        if (labelPattern.test(line)) {
            const p = extractPrice(line);
            if (p) return { ...p, label: line.trim() };
        }
    }
    return null;
}

/**
 * Returns a "done"-shaped action object if a clear answer is already visible,
 * otherwise null. Caller uses this to short-circuit the LLM decision.
 */
function detectVisibleAnswer(goal, snippets = []) {
    if (!isInformationGoal(goal)) return null;
    if (!snippets || snippets.length === 0) return null;
    const g = goal.toLowerCase();

    // ── Cheapest / lowest fare / lowest price ──────────────────────────────
    if (/\b(cheapest|lowest|minimum|sasta)\b/.test(g)) {
        const lowest = findLabeledPrice(snippets, /lowest|cheapest|minimum|starting from|fares? @|lowest fare|starting at/i);
        if (lowest) {
            const dateMatch = lowest.label.match(/-\s*([0-9]{1,2}\s*[A-Za-z]{3,})/);
            const dateSuffix = dateMatch ? ` on ${dateMatch[1].trim()}` : '';
            return {
                thought: `The page already shows the lowest fare: ${lowest.raw}${dateSuffix}. Reporting it as the answer.`,
                action: 'done',
                success: true,
                result: `Cheapest option found: ${lowest.raw}${dateSuffix} (from "${lowest.label.slice(0, 120)}").`,
            };
        }
    }

    // ── Generic price/fare question ("price of X", "how much", "fare") ─────
    if (/\b(price|fare|cost|how much|rate)\b/.test(g)) {
        // Prefer an explicit price/fare label; fall back to the first visible price.
        const labeled = findLabeledPrice(snippets, /price|fare|cost|rate|starting from|₹|rs\.?/i);
        if (labeled) {
            return {
                thought: `The page shows a price: ${labeled.raw}. Reporting it.`,
                action: 'done',
                success: true,
                result: `${labeled.raw} (from "${labeled.label.slice(0, 120)}").`,
            };
        }
    }

    return null;
}

module.exports = { detectVisibleAnswer, extractPrice };

// taskClassifier.js — light-weight goal intent detection used to steer prompting.
// Kept deliberately conservative: an information/query goal is one that asks the
// agent to FIND/TELL/SHOW/COMPARE data (price, fare, time, score, list, etc.)
// without any purchase/cart action. Cart/booking/purchase words win and force it
// out of "information only" so shopping flows are never misclassified.

const CART_ACTION_WORDS = [
    'to cart', 'to the cart', 'add cart', 'add to bag', 'add to basket',
    'add it', 'add them', 'add both', 'add one', 'add two', 'add three',
    'buy', 'purchase', 'checkout', 'place order', 'place the order',
    'order it', 'order them', 'book a flight', 'book flight', 'book ticket',
    'book the ticket', 'book my ticket',
];

const INFO_SIGNAL_WORDS = [
    'price', 'prices', 'pricing', 'fare', 'fares', 'cheapest', 'cheap',
    'lowest', 'cheapest flight', 'cost', 'costs', 'rate', 'rates',
    'tell me', 'show me', 'what is', 'what are', 'what was', 'find',
    'search', 'look up', 'lookup', 'list', 'top', 'best', 'compare',
    'cheapest', 'expensive', 'how much', 'how many', 'temperature',
    'weather', 'score', 'scores', 'result', 'results', 'standings',
    'points table', 'rank', 'schedule', 'timing', 'timings', 'time',
    'duration', 'departure', 'arrival', 'flight', 'flights', 'news',
    'who won', 'winner', 'headline', 'headlines',
];

function normalize(goal) {
    return (goal || '').toString().toLowerCase().trim();
}

/**
 * Returns true when the user is asking for information only (find / tell /
 * compare / show a price, fare, list, score, etc.) and is NOT asking to buy,
 * add to cart, or complete a booking. Used by the prompt builder to inject an
 * explicit "answer is already visible -> emit done" hint.
 */
function isInformationGoal(goal) {
    const g = normalize(goal);
    if (!g) return false;
    if (CART_ACTION_WORDS.some((w) => g.includes(w))) return false;
    return INFO_SIGNAL_WORDS.some((w) => g.includes(w));
}

module.exports = {
    isInformationGoal,
    CART_ACTION_WORDS,
    INFO_SIGNAL_WORDS,
};

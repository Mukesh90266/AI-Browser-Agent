// ScreenshotHelper.js — Captures and processes page screenshots for visual verification
// ScreenshotHelper.js — Page ka screenshot lena (fallback + frontend display)

const { getPage } = require('./BrowserManager');

// Base64 screenshot lo (frontend pe bhejne ke liye)
async function takeScreenshot() {
    const page = getPage();
    const buffer = await page.screenshot({
        type: 'jpeg',
        quality: 60,      // size kam rakhne ke liye
        fullPage: false   // sirf visible area
    });
    const base64 = buffer.toString('base64');
    console.log('✅ Screenshot taken');
    return base64;
}

// File mein save karo (debugging ke liye)
async function saveScreenshot(filename = 'debug.jpg') {
    const page = getPage();
    await page.screenshot({ path: `./screenshots/${filename}` });
    console.log(`✅ Screenshot saved: ${filename}`);
}

module.exports = { takeScreenshot, saveScreenshot };
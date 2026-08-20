// ScreenshotHelper.js — Captures and encodes screenshots for frontend display and visual verification

const fs = require('fs');
const path = require('path');
const { getPage } = require('./BrowserManager');
const logger = require('../utils/logger');

/**
 * Captures a Base64-encoded JPEG screenshot of the current browser viewport.
 */
async function takeScreenshot() {
    const page = getPage();
    if (!page) return null;

    try {
        const buffer = await page.screenshot({
            type: 'jpeg',
            quality: 65,
            fullPage: false,
        });
        return buffer.toString('base64');
    } catch (err) {
        logger.warn(`Screenshot capture failed: ${err.message}`);
        return null;
    }
}

/**
 * Saves a screenshot to disk for debugging purposes.
 */
async function saveScreenshot(filename = 'debug.jpg') {
    const page = getPage();
    if (!page) return null;

    try {
        const screenshotsDir = path.join(__dirname, '../screenshots');
        if (!fs.existsSync(screenshotsDir)) {
            fs.mkdirSync(screenshotsDir, { recursive: true });
        }
        const filePath = path.join(screenshotsDir, filename);
        await page.screenshot({ path: filePath, type: 'jpeg', quality: 80 });
        logger.debug(`Saved screenshot to ${filePath}`);
        return filePath;
    } catch (err) {
        logger.warn(`Screenshot save failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    takeScreenshot,
    saveScreenshot,
};

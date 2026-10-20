/**
 * Entry point of the `preset-sorter` SillyTavern / TauriTavern extension.
 *
 * Kept intentionally tiny:
 * - guards browser APIs so the file is harmless when imported under Node.js;
 * - defers all SillyTavern / DOM work to `src/controller.js`, which is imported
 *   lazily so a controller failure can never break the extension host;
 * - never throws into the host page.
 *
 * @module preset-sorter
 */

const LOG_PREFIX = '[preset-sorter]';
const CONTROLLER_MODULE = './src/controller.js';

/**
 * True when the extension is running inside a browser/WebView document.
 *
 * @returns {boolean} Whether DOM APIs are available.
 */
function hasBrowserRuntime() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Runs the bootstrap callback as early as safely possible:
 * immediately when the DOM is already parsed, otherwise after `DOMContentLoaded`.
 *
 * @param {() => void} callback Bootstrap callback.
 * @returns {void}
 */
function whenDocumentReady(callback) {
    if (typeof document === 'undefined') {
        return;
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', callback, { once: true });
        return;
    }
    callback();
}

/**
 * Dynamically imports the controller and starts the extension.
 * Any failure is isolated and only logged, never propagated to the host page.
 *
 * @returns {Promise<void>} Resolves when the bootstrap attempt finishes.
 */
async function bootstrap() {
    try {
        const controller = await import(CONTROLLER_MODULE);
        await controller.initializePresetSorter();
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to initialize the extension.`, error);
    }
}

if (hasBrowserRuntime()) {
    whenDocumentReady(() => {
        void bootstrap();
    });
} else {
    // Imported from Node.js (unit tests / tooling): nothing to do.
    console.debug(`${LOG_PREFIX} No browser runtime detected; extension entry is inactive.`);
}

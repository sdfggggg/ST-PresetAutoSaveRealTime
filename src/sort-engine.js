/**
 * Pure ordering logic for preset dropdown options.
 *
 * The engine never touches the DOM: it receives a snapshot of the current
 * options (`{ name, value }`) plus a stats accessor and returns the desired
 * order as a new array. All comparators are deterministic and stable: ties are
 * broken by the option's original index, so the same input always produces the
 * same output.
 *
 * @module preset-sorter/sort-engine
 */

import { SORT_MODES } from './constants.js';

/**
 * A single preset dropdown option snapshot.
 * @typedef {object} PresetItem
 * @property {string} name Preset logical name (option label).
 * @property {string|number} value Option value (index for non-keyed APIs, name for keyed APIs).
 */

/**
 * Usage/import statistics for one preset, as stored by `stats-store.js`.
 * Any missing field is treated as "unknown".
 * @typedef {object} PresetStats
 * @property {number} [count] Number of times the preset was selected by the user.
 * @property {number|null} [lastUsedAt] Last usage timestamp (ms since epoch).
 * @property {number|null} [importTime] Import/creation timestamp (ms since epoch).
 * @property {string|null} [importSource] Where `importTime` came from.
 * @property {number|null} [firstSeenAt] First time the extension saw this preset (ms since epoch).
 */

/**
 * Normalises a stats timestamp: finite numbers stay, everything else becomes `null`.
 *
 * @param {PresetStats|undefined} stats Stats object.
 * @param {'importTime'|'lastUsedAt'} field Field to read.
 * @returns {number|null} Timestamp in ms, or `null` when unknown.
 */
function readTimestamp(stats, field) {
    const value = stats ? stats[field] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalises a usage counter to a non-negative finite number.
 *
 * @param {PresetStats|undefined} stats Stats object.
 * @returns {number} Usage count (`0` when unknown/invalid).
 */
function readCount(stats) {
    const value = stats ? stats.count : undefined;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** @type {ReadonlySet<string>} */
const VALID_MODES = new Set(Object.values(SORT_MODES));

/**
 * Builds the comparator for one sort mode.
 *
 * Import modes put presets without a known import time last (in both ascending
 * and descending variants), then fall back to the original order.
 *
 * @param {string} mode Sort mode.
 * @returns {((a: {originalIndex: number, stats: PresetStats|undefined}, b: {originalIndex: number, stats: PresetStats|undefined}) => number)|null} Comparator, or `null` for "keep original order".
 */
function createComparator(mode) {
    switch (mode) {
        case SORT_MODES.IMPORT_ASC:
            return (a, b) => {
                const timeA = readTimestamp(a.stats, 'importTime');
                const timeB = readTimestamp(b.stats, 'importTime');
                if (timeA === null && timeB === null) {
                    return a.originalIndex - b.originalIndex;
                }
                if (timeA === null) {
                    return 1;
                }
                if (timeB === null) {
                    return -1;
                }
                return timeA - timeB || a.originalIndex - b.originalIndex;
            };
        case SORT_MODES.IMPORT_DESC:
            return (a, b) => {
                const timeA = readTimestamp(a.stats, 'importTime');
                const timeB = readTimestamp(b.stats, 'importTime');
                if (timeA === null && timeB === null) {
                    return a.originalIndex - b.originalIndex;
                }
                if (timeA === null) {
                    return 1;
                }
                if (timeB === null) {
                    return -1;
                }
                return timeB - timeA || a.originalIndex - b.originalIndex;
            };
        case SORT_MODES.USAGE_DESC:
            return (a, b) => {
                const countDelta = readCount(b.stats) - readCount(a.stats);
                if (countDelta !== 0) {
                    return countDelta;
                }
                const lastUsedA = readTimestamp(a.stats, 'lastUsedAt');
                const lastUsedB = readTimestamp(b.stats, 'lastUsedAt');
                if (lastUsedA !== null && lastUsedB !== null && lastUsedA !== lastUsedB) {
                    return lastUsedB - lastUsedA;
                }
                if (lastUsedA === null && lastUsedB !== null) {
                    return 1;
                }
                if (lastUsedA !== null && lastUsedB === null) {
                    return -1;
                }
                return a.originalIndex - b.originalIndex;
            };
        case SORT_MODES.RECENT_DESC:
            return (a, b) => {
                const lastUsedA = readTimestamp(a.stats, 'lastUsedAt');
                const lastUsedB = readTimestamp(b.stats, 'lastUsedAt');
                if (lastUsedA === null && lastUsedB === null) {
                    return readCount(b.stats) - readCount(a.stats) || a.originalIndex - b.originalIndex;
                }
                if (lastUsedA === null) {
                    return 1;
                }
                if (lastUsedB === null) {
                    return -1;
                }
                if (lastUsedA !== lastUsedB) {
                    return lastUsedB - lastUsedA;
                }
                return readCount(b.stats) - readCount(a.stats) || a.originalIndex - b.originalIndex;
            };
        default:
            return null;
    }
}

/**
 * Computes the desired order for a list of preset options.
 *
 * Supported modes:
 * - `default`: original order (upstream SillyTavern order).
 * - `import-asc` / `import-desc`: by `stats.importTime`; unknown import times are last, ties by original order.
 * - `usage-desc`: by `stats.count` descending, then `lastUsedAt` descending, then original order.
 * - `recent-desc`: by `stats.lastUsedAt` descending, then `count` descending, then original order.
 *
 * Any unknown mode falls back to the original order. The input array and its
 * items are never mutated; a new array is returned.
 *
 * @param {PresetItem[]} items Current options in DOM order.
 * @param {string} mode Sort mode (see {@link SORT_MODES}).
 * @param {(name: string) => PresetStats|undefined} getStats Stats accessor for a preset name.
 * @returns {PresetItem[]} Items in desired order (new array, same item references).
 */
export function computePresetOrder(items, mode, getStats) {
    const list = Array.isArray(items) ? items : [];
    const comparator = VALID_MODES.has(mode) ? createComparator(mode) : null;
    if (!comparator) {
        return list.slice();
    }

    const getStatsForName = typeof getStats === 'function' ? getStats : () => undefined;
    const decorated = list.map((item, originalIndex) => ({
        item,
        originalIndex,
        stats: getStatsForName(item ? item.name : ''),
    }));

    decorated.sort(comparator);
    return decorated.map(entry => entry.item);
}

/**
 * Builds a cheap identity key for an option list (order and values).
 * Useful for equality checks / change detection without comparing arrays.
 *
 * @param {Array<{value: string|number}>} items Option snapshots.
 * @returns {string} Signature string.
 */
export function orderSignature(items) {
    const list = Array.isArray(items) ? items : [];
    const values = new Array(list.length);
    for (let index = 0; index < list.length; index += 1) {
        const value = list[index] ? list[index].value : undefined;
        values[index] = value === undefined || value === null ? '' : String(value);
    }
    return `${list.length}:${values.join('\u001f')}`;
}

/**
 * True when the select's current option values already match the desired order.
 *
 * DOM values are strings while option values may be numbers, so both sides are
 * compared as strings. Length differences are detected as well.
 *
 * @param {ArrayLike<{value?: string|number}>|null|undefined} currentValues Current option elements/values in DOM order.
 * @param {Array<{value: string|number}>|null|undefined} desired Desired option order (usually the output of {@link computePresetOrder}).
 * @returns {boolean} Whether the DOM order already equals the desired order.
 */
export function isOrderCurrent(currentValues, desired) {
    if (!currentValues || !desired) {
        return false;
    }
    if (currentValues.length !== desired.length) {
        return false;
    }
    for (let index = 0; index < desired.length; index += 1) {
        const desiredValue = desired[index] ? desired[index].value : undefined;
        const currentValue = currentValues[index] ? currentValues[index].value : undefined;
        if (String(currentValue) !== String(desiredValue)) {
            return false;
        }
    }
    return true;
}

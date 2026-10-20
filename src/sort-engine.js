/**
 * Pure ordering logic for preset dropdown options.
 *
 * The engine never touches the DOM: it receives a snapshot of the current
 * options (`{ name, value }`) plus a stats accessor and returns the desired
 * order as a new array. All comparators are deterministic and stable: ties are
 * broken by the option's original index, so the same input always produces the
 * same output.
 *
 * v1.1.0 sorts by an explicit **field + direction** pair
 * (`computePresetOrderByField`). The legacy combined mode strings of v1 are still
 * accepted through `computePresetOrder` for backward compatibility.
 *
 * @module preset-sorter/sort-engine
 */

import {
    DEFAULT_DIRECTION,
    DEFAULT_FIELD,
    SORT_DIRECTIONS,
    SORT_FIELDS,
    SORT_MODES,
} from './constants.js';

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
 * A field + direction sort specification.
 * @typedef {object} SortSpec
 * @property {string} field One of `SORT_FIELDS` (`default` | `import` | `usage` | `recent`).
 * @property {string} direction One of `SORT_DIRECTIONS` (`asc` | `desc`).
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

/** Legacy v1 combined mode -> field + direction. @type {Readonly<Record<string, Readonly<SortSpec>>>} */
const LEGACY_MODE_SPECS = Object.freeze({
    [SORT_MODES.DEFAULT]: Object.freeze({ field: SORT_FIELDS.DEFAULT, direction: SORT_DIRECTIONS.DESC }),
    [SORT_MODES.IMPORT_ASC]: Object.freeze({ field: SORT_FIELDS.IMPORT, direction: SORT_DIRECTIONS.ASC }),
    [SORT_MODES.IMPORT_DESC]: Object.freeze({ field: SORT_FIELDS.IMPORT, direction: SORT_DIRECTIONS.DESC }),
    [SORT_MODES.USAGE_ASC]: Object.freeze({ field: SORT_FIELDS.USAGE, direction: SORT_DIRECTIONS.ASC }),
    [SORT_MODES.USAGE_DESC]: Object.freeze({ field: SORT_FIELDS.USAGE, direction: SORT_DIRECTIONS.DESC }),
    [SORT_MODES.RECENT_ASC]: Object.freeze({ field: SORT_FIELDS.RECENT, direction: SORT_DIRECTIONS.ASC }),
    [SORT_MODES.RECENT_DESC]: Object.freeze({ field: SORT_FIELDS.RECENT, direction: SORT_DIRECTIONS.DESC }),
});

/** @type {ReadonlySet<string>} */
const VALID_FIELDS = new Set(Object.values(SORT_FIELDS));

/** @type {ReadonlySet<string>} */
const VALID_DIRECTIONS = new Set(Object.values(SORT_DIRECTIONS));

/**
 * @param {unknown} field Raw sort field.
 * @returns {string} Normalised field (`default` for unknown values).
 */
function normalizeField(field) {
    return typeof field === 'string' && VALID_FIELDS.has(field) ? field : DEFAULT_FIELD;
}

/**
 * @param {unknown} direction Raw sort direction.
 * @returns {string} Normalised direction (`desc` for unknown values).
 */
function normalizeDirection(direction) {
    return typeof direction === 'string' && VALID_DIRECTIONS.has(direction) ? direction : DEFAULT_DIRECTION;
}

/**
 * Converts a legacy combined sort mode to a field + direction spec.
 * Unknown/invalid modes map to the upstream default order.
 *
 * @param {string} mode Legacy sort mode (e.g. `import-asc`).
 * @returns {SortSpec} Normalised sort spec.
 */
export function modeToFieldDirection(mode) {
    const spec = typeof mode === 'string' ? LEGACY_MODE_SPECS[mode] : undefined;
    if (!spec) {
        return { field: DEFAULT_FIELD, direction: DEFAULT_DIRECTION };
    }
    return { field: spec.field, direction: spec.direction };
}

/**
 * Converts a field + direction spec to its legacy combined mode string.
 * Useful for diagnostics/backward-compatible probe payloads.
 *
 * @param {string} field Sort field.
 * @param {string} direction Sort direction.
 * @returns {string} Legacy sort mode string.
 */
export function fieldDirectionToMode(field, direction) {
    const normalizedField = normalizeField(field);
    const normalizedDirection = normalizeDirection(direction);
    if (normalizedField === SORT_FIELDS.DEFAULT) {
        return SORT_MODES.DEFAULT;
    }
    return `${normalizedField}-${normalizedDirection}`;
}

/**
 * Direction multiplier used by the shared comparator.
 *
 * @param {string} direction Normalised direction.
 * @returns {number} `1` for ascending, `-1` for descending.
 */
function directionFactor(direction) {
    return direction === SORT_DIRECTIONS.ASC ? 1 : -1;
}

/**
 * Builds the comparator for a field + direction spec.
 *
 * Semantics:
 * - `import`: primary `importTime`; unknown import times rank **last** in both
 *   directions; ties keep the original order.
 * - `usage`: primary `count`, secondary `lastUsedAt`; direction applies to both
 *   (missing `lastUsedAt` is treated as the oldest possible value `0`).
 * - `recent`: primary `lastUsedAt`, secondary `count`; direction applies to both.
 * - ties always fall back to the original option order.
 *
 * @param {string} field Normalised sort field.
 * @param {string} direction Normalised sort direction.
 * @returns {((a: {originalIndex: number, stats: PresetStats|undefined}, b: {originalIndex: number, stats: PresetStats|undefined}) => number)|null} Comparator, or `null` to keep the original order.
 */
function createComparator(field, direction) {
    const factor = directionFactor(direction);

    switch (field) {
        case SORT_FIELDS.IMPORT:
            return (a, b) => {
                const timeA = readTimestamp(a.stats, 'importTime');
                const timeB = readTimestamp(b.stats, 'importTime');
                if (timeA === null && timeB === null) {
                    return a.originalIndex - b.originalIndex;
                }
                // Unknown import times rank last regardless of direction.
                if (timeA === null) {
                    return 1;
                }
                if (timeB === null) {
                    return -1;
                }
                return factor * (timeA - timeB) || a.originalIndex - b.originalIndex;
            };
        case SORT_FIELDS.USAGE:
            return (a, b) => {
                const countDelta = readCount(a.stats) - readCount(b.stats);
                if (countDelta !== 0) {
                    return factor * countDelta;
                }
                const lastUsedA = readTimestamp(a.stats, 'lastUsedAt') ?? 0;
                const lastUsedB = readTimestamp(b.stats, 'lastUsedAt') ?? 0;
                if (lastUsedA !== lastUsedB) {
                    return factor * (lastUsedA - lastUsedB);
                }
                return a.originalIndex - b.originalIndex;
            };
        case SORT_FIELDS.RECENT:
            return (a, b) => {
                const lastUsedA = readTimestamp(a.stats, 'lastUsedAt') ?? 0;
                const lastUsedB = readTimestamp(b.stats, 'lastUsedAt') ?? 0;
                if (lastUsedA !== lastUsedB) {
                    return factor * (lastUsedA - lastUsedB);
                }
                const countDelta = readCount(a.stats) - readCount(b.stats);
                if (countDelta !== 0) {
                    return factor * countDelta;
                }
                return a.originalIndex - b.originalIndex;
            };
        default:
            return null;
    }
}

/**
 * Computes the desired order for a list of preset options by field + direction.
 *
 * `field === 'default'` (or any unknown field) keeps the upstream input order.
 * The input array and its items are never mutated; a new array is returned.
 *
 * @param {PresetItem[]} items Current options in DOM order.
 * @param {string} field Sort field (`default` | `import` | `usage` | `recent`).
 * @param {string} direction Sort direction (`asc` | `desc`).
 * @param {(name: string) => PresetStats|undefined} getStats Stats accessor for a preset name.
 * @returns {PresetItem[]} Items in desired order (new array, same item references).
 */
export function computePresetOrderByField(items, field, direction, getStats) {
    const list = Array.isArray(items) ? items : [];
    const normalizedField = normalizeField(field);
    const normalizedDirection = normalizeDirection(direction);
    if (normalizedField === SORT_FIELDS.DEFAULT) {
        return list.slice();
    }
    const comparator = createComparator(normalizedField, normalizedDirection);
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
 * Computes the desired order for a list of preset options.
 *
 * Backward-compatible wrapper around {@link computePresetOrderByField} accepting
 * the legacy combined mode strings:
 * - `default`: original order (upstream SillyTavern order).
 * - `import-asc` / `import-desc`: by `stats.importTime`; unknown import times are last.
 * - `usage-asc` / `usage-desc`: by `stats.count`, then `lastUsedAt`.
 * - `recent-asc` / `recent-desc`: by `stats.lastUsedAt`, then `count`.
 *
 * Any unknown mode falls back to the original order.
 *
 * @param {PresetItem[]} items Current options in DOM order.
 * @param {string} mode Legacy sort mode (see {@link SORT_MODES}).
 * @param {(name: string) => PresetStats|undefined} getStats Stats accessor for a preset name.
 * @returns {PresetItem[]} Items in desired order (new array, same item references).
 */
export function computePresetOrder(items, mode, getStats) {
    const spec = modeToFieldDirection(mode);
    return computePresetOrderByField(items, spec.field, spec.direction, getStats);
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
 * @param {Array<{value: string|number}>|null|undefined} desired Desired option order (usually the output of {@link computePresetOrderByField}).
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

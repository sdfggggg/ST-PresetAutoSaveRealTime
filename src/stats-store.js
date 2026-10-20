/**
 * Persistent usage/import statistics for presets.
 *
 * The store owns a JSON-safe plain object that is persisted inside
 * `extension_settings[EXTENSION_NAME]` (see `controller.js`). All mutations go
 * through methods; `snapshot()` returns a detached deep copy suitable for
 * persistence.
 *
 * Persisted shape (version 1):
 * ```js
 * {
 *   version: 1,
 *   seeded: false,
 *   apis: {
 *     [apiId]: {
 *       [presetName]: {
 *         count: 0,              // number of user selections
 *         lastUsedAt: null,      // ms since epoch
 *         importTime: null,      // ms since epoch (host file birth/mtime or first-seen)
 *         importSource: null,    // 'birthtime' | 'mtime' | 'first-seen' | null
 *         firstSeenAt: null,     // ms since epoch, first time the extension saw the preset
 *       },
 *     },
 *   },
 * }
 * ```
 *
 * Pure module: no DOM / SillyTavern / Tauri imports.
 *
 * @module preset-sorter/stats-store
 */

import { MAX_STATS_PER_API, STORAGE_VERSION } from './constants.js';

/**
 * @typedef {object} PresetStatsEntry
 * @property {number} count Number of user selections.
 * @property {number|null} lastUsedAt Last usage timestamp (ms since epoch).
 * @property {number|null} importTime Import timestamp (ms since epoch).
 * @property {string|null} importSource Source of `importTime`.
 * @property {number|null} firstSeenAt First time the extension saw the preset (ms since epoch).
 */

/**
 * @typedef {object} StatsStoreOptions
 * @property {object|null} [data] Previously persisted payload (may be malformed / missing).
 * @property {(() => number)|number} [now] Clock used for implicit timestamps (function or fixed number).
 * @property {object|null} [logger] Optional logger with `warn`/`error` methods.
 */

/**
 * @typedef {object} StatsSummary
 * @property {number} known Number of tracked presets.
 * @property {number} used Number of presets with at least one recorded usage.
 * @property {number} importTimes Number of presets with a known import time.
 * @property {boolean} seeded Whether the initial preset list has been seeded.
 * @property {Record<string, {known: number, used: number, importTimes: number}>} apis Per-API breakdown.
 */

/**
 * Normalises a timestamp to a finite number or `null`.
 *
 * @param {unknown} value Raw value.
 * @returns {number|null} Timestamp in ms, or `null`.
 */
function normalizeTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalises a usage counter to a non-negative integer.
 *
 * @param {unknown} value Raw value.
 * @returns {number} Normalised counter.
 */
function normalizeCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Normalises an import-time source tag.
 *
 * @param {unknown} value Raw value.
 * @returns {string|null} Non-empty string or `null`.
 */
function normalizeImportSource(value) {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Creates an empty stats entry.
 *
 * @param {number|null} firstSeenAt First-seen timestamp.
 * @returns {PresetStatsEntry} New entry.
 */
function createEntry(firstSeenAt = null) {
    return {
        count: 0,
        lastUsedAt: null,
        importTime: null,
        importSource: null,
        firstSeenAt: normalizeTimestamp(firstSeenAt),
    };
}

/**
 * Normalises a persisted entry; returns `null` when the value is unusable.
 *
 * @param {unknown} raw Persisted entry.
 * @returns {PresetStatsEntry|null} Normalised entry.
 */
function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }
    return {
        count: normalizeCount(raw.count),
        lastUsedAt: normalizeTimestamp(raw.lastUsedAt),
        importTime: normalizeTimestamp(raw.importTime),
        importSource: normalizeImportSource(raw.importSource),
        firstSeenAt: normalizeTimestamp(raw.firstSeenAt),
    };
}

/**
 * Shallow-copies a stats entry (entries only contain primitives).
 *
 * @param {PresetStatsEntry} entry Entry to copy.
 * @returns {PresetStatsEntry} Detached copy.
 */
function cloneEntry(entry) {
    return {
        count: entry.count,
        lastUsedAt: entry.lastUsedAt,
        importTime: entry.importTime,
        importSource: entry.importSource,
        firstSeenAt: entry.firstSeenAt,
    };
}

/**
 * Resolves the clock option into a function.
 *
 * @param {(() => number)|number|undefined} now Clock option.
 * @returns {() => number} Clock function.
 */
function resolveClock(now) {
    if (typeof now === 'function') {
        return now;
    }
    if (typeof now === 'number' && Number.isFinite(now)) {
        return () => /** @type {number} */ (now);
    }
    return () => Date.now();
}

/** Import sources that represent real host filesystem metadata (never downgraded to `first-seen`). */
const FILESYSTEM_IMPORT_SOURCES = new Set(['birthtime', 'mtime']);

/**
 * @typedef {object} StatsStore
 * @property {(apiId: string, name: string) => PresetStatsEntry|undefined} get Get a preset entry.
 * @property {(apiId: string, name: string, ts?: number) => boolean} ensureKnown Track a preset without inventing stats.
 * @property {(apiId: string, name: string, ts?: number) => PresetStatsEntry|null} recordUsage Record one user selection.
 * @property {(apiId: string, name: string, time: number, source?: string) => PresetStatsEntry|null} setImportTime Store a preset import time.
 * @property {() => boolean} isSeeded Whether first-run seeding completed.
 * @property {(ts?: number) => boolean} markSeeded Mark first-run seeding completed.
 * @property {(apiId: string, oldName: string, newName: string) => boolean} rename Move stats after a preset rename.
 * @property {(apiId: string, name: string) => boolean} remove Drop stats after a preset deletion.
 * @property {(apiId?: string) => number} resetUsage Reset usage counters.
 * @property {(apiId?: string) => number} clearImportTimes Clear resolved import times.
 * @property {() => {version: number, seeded: boolean, apis: Record<string, Record<string, PresetStatsEntry>>}} snapshot Detached persisted payload.
 * @property {() => number} prune Enforce the per-API entry cap.
 * @property {() => StatsSummary} getSummary Aggregate counters.
 * @property {() => StatsSummary} summary Alias of `getSummary`.
 */

/**
 * Creates a stats store from a previously persisted payload.
 *
 * The input payload is never mutated; normalization happens on fresh objects.
 *
 * @param {StatsStoreOptions} [options] Store options.
 * @returns {StatsStore} Stats store API.
 */
export function createStatsStore({ data = null, now, logger } = {}) {
    const clock = resolveClock(now);
    const report = logger && typeof logger.warn === 'function' ? logger : null;

    /** @type {{version: number, seeded: boolean, apis: Record<string, Record<string, PresetStatsEntry>>}} */
    const state = { version: STORAGE_VERSION, seeded: false, apis: Object.create(null) };

    if (data && typeof data === 'object') {
        // `seeded` only survives from a payload of a known shape; a malformed value
        // is treated as "not seeded" so first-run seeding runs again safely.
        state.seeded = data.seeded === true;

        const apis = data.apis;
        if (apis && typeof apis === 'object' && !Array.isArray(apis)) {
            for (const apiId of Object.keys(apis)) {
                const bucket = apis[apiId];
                if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
                    continue;
                }
                const cleanBucket = Object.create(null);
                for (const name of Object.keys(bucket)) {
                    const entry = normalizeEntry(bucket[name]);
                    if (entry) {
                        cleanBucket[name] = entry;
                    }
                }
                state.apis[apiId] = cleanBucket;
            }
        } else if (report) {
            report.warn('[preset-sorter] persisted stats have no valid `apis` object; starting empty');
        }
    }

    /**
     * Returns the bucket for an API, creating it when needed.
     * Buckets are prototype-less objects so preset names such as `__proto__` stay safe.
     *
     * @param {string} apiId API id.
     * @returns {Record<string, PresetStatsEntry>} Bucket.
     */
    function ensureBucket(apiId) {
        if (!Object.hasOwn(state.apis, apiId)) {
            state.apis[apiId] = Object.create(null);
        }
        return state.apis[apiId];
    }

    /**
     * Creates (or returns) the stats entry for a preset.
     *
     * @param {string} apiId API id.
     * @param {string} name Preset logical name.
     * @param {number} firstSeenAt First-seen fallback timestamp.
     * @returns {PresetStatsEntry} Entry (created when missing).
     */
    function ensureEntry(apiId, name, firstSeenAt) {
        const bucket = ensureBucket(apiId);
        const existing = bucket[name];
        if (existing) {
            return existing;
        }
        const entry = createEntry(firstSeenAt);
        bucket[name] = entry;
        return entry;
    }

    /**
     * Iterates over the entries selected by an optional API filter.
     *
     * @param {string|undefined} apiId API id, or `undefined` for every API.
     * @param {(entry: PresetStatsEntry, apiId: string, name: string) => void} callback Callback.
     * @returns {number} Number of visited entries.
     */
    function forEachEntry(apiId, callback) {
        const apiIds = apiId === undefined ? Object.keys(state.apis) : (hasBucket(apiId) ? [apiId] : []);
        let visited = 0;
        for (const currentApiId of apiIds) {
            const bucket = state.apis[currentApiId];
            if (!bucket) {
                continue;
            }
            for (const name of Object.keys(bucket)) {
                visited += 1;
                callback(bucket[name], currentApiId, name);
            }
        }
        return visited;
    }

    /**
     * @param {string|undefined} apiId API id.
     * @returns {boolean} Whether the API bucket exists.
     */
    function hasBucket(apiId) {
        return typeof apiId === 'string' && Object.hasOwn(state.apis, apiId);
    }

    /**
     * @param {unknown} apiId Raw API id.
     * @param {unknown} name Raw preset name.
     * @returns {boolean} Whether both arguments are usable non-empty strings.
     */
    function areValidKey(apiId, name) {
        return typeof apiId === 'string' && apiId !== '' && typeof name === 'string' && name !== '';
    }

    const api = {
        /**
         * Returns the stats entry for a preset, or `undefined` when untracked.
         * The returned object is the live internal entry (read-only by convention).
         *
         * @param {string} apiId API id.
         * @param {string} name Preset logical name.
         * @returns {PresetStatsEntry|undefined} Stats entry.
         */
        get(apiId, name) {
            if (!areValidKey(apiId, name) || !Object.hasOwn(state.apis, apiId)) {
                return undefined;
            }
            const bucket = state.apis[apiId];
            return Object.hasOwn(bucket, name) ? bucket[name] : undefined;
        },

        /**
         * Tracks a preset without recording any usage or inventing an import time.
         *
         * @param {string} apiId API id.
         * @param {string} name Preset logical name.
         * @param {number} [ts] First-seen timestamp (defaults to the clock).
         * @returns {boolean} `true` when a new entry was created.
         */
        ensureKnown(apiId, name, ts) {
            if (!areValidKey(apiId, name)) {
                return false;
            }
            const bucket = ensureBucket(apiId);
            if (Object.hasOwn(bucket, name)) {
                return false;
            }
            bucket[name] = createEntry(typeof ts === 'number' && Number.isFinite(ts) ? ts : clock());
            return true;
        },

        /**
         * Records that the user selected a preset: increments the counter and
         * updates `lastUsedAt` / `firstSeenAt`.
         *
         * @param {string} apiId API id.
         * @param {string} name Preset logical name.
         * @param {number} [ts] Usage timestamp (defaults to the clock).
         * @returns {PresetStatsEntry|null} Updated entry, or `null` for invalid arguments.
         */
        recordUsage(apiId, name, ts) {
            if (!areValidKey(apiId, name)) {
                return null;
            }
            const timestamp = typeof ts === 'number' && Number.isFinite(ts) ? ts : clock();
            const entry = ensureEntry(apiId, name, timestamp);
            entry.count = normalizeCount(entry.count) + 1;
            entry.lastUsedAt = timestamp;
            if (entry.firstSeenAt === null) {
                entry.firstSeenAt = timestamp;
            }
            return entry;
        },

        /**
         * Stores a preset import time.
         *
         * A `first-seen` fallback never replaces an already known filesystem
         * timestamp (`birthtime`/`mtime`), so a failed metadata refresh cannot
         * degrade previously resolved data.
         *
         * @param {string} apiId API id.
         * @param {string} name Preset logical name.
         * @param {number} time Import timestamp (ms since epoch).
         * @param {string} [source] Source tag (`birthtime`, `mtime`, `first-seen`).
         * @returns {PresetStatsEntry|null} Updated entry, or `null` for invalid arguments.
         */
        setImportTime(apiId, name, time, source) {
            if (!areValidKey(apiId, name) || typeof time !== 'number' || !Number.isFinite(time)) {
                return null;
            }
            const normalizedSource = normalizeImportSource(source);
            const entry = ensureEntry(apiId, name, clock());
            const hasFilesystemTime = entry.importSource !== null
                && FILESYSTEM_IMPORT_SOURCES.has(entry.importSource)
                && entry.importTime !== null;
            if (normalizedSource === 'first-seen' && hasFilesystemTime) {
                return entry;
            }
            entry.importTime = time;
            entry.importSource = normalizedSource;
            return entry;
        },

        /**
         * @returns {boolean} Whether the first-run preset seeding has been completed.
         */
        isSeeded() {
            return state.seeded === true;
        },

        /**
         * Marks the first-run preset seeding as completed.
         *
         * @param {number} [_ts] Seeding timestamp (reserved; kept for symmetry with other setters).
         * @returns {boolean} The new seeded flag.
         */
        markSeeded(_ts) {
            state.seeded = true;
            return state.seeded;
        },

        /**
         * Moves the stats of a renamed preset to its new name.
         * When an entry already exists under the new name, the two entries are merged.
         *
         * @param {string} apiId API id.
         * @param {string} oldName Old preset logical name.
         * @param {string} newName New preset logical name.
         * @returns {boolean} `true` when a rename was applied.
         */
        rename(apiId, oldName, newName) {
            if (!areValidKey(apiId, oldName) || !areValidKey(apiId, newName) || oldName === newName) {
                return false;
            }
            if (!Object.hasOwn(state.apis, apiId)) {
                return false;
            }
            const bucket = state.apis[apiId];
            if (!Object.hasOwn(bucket, oldName)) {
                return false;
            }

            const source = bucket[oldName];
            delete bucket[oldName];

            if (!Object.hasOwn(bucket, newName)) {
                bucket[newName] = source;
                return true;
            }

            const target = bucket[newName];
            target.count = normalizeCount(target.count) + normalizeCount(source.count);
            const knownLastUsed = [target.lastUsedAt, source.lastUsedAt].filter(value => value !== null);
            target.lastUsedAt = knownLastUsed.length > 0 ? Math.max(...knownLastUsed) : null;
            target.firstSeenAt = minNullable(target.firstSeenAt, source.firstSeenAt);
            if (target.importTime === null && source.importTime !== null) {
                target.importTime = source.importTime;
                target.importSource = source.importSource;
            }
            return true;
        },

        /**
         * Drops the stats of a preset (used for preset deletion).
         *
         * @param {string} apiId API id.
         * @param {string} name Preset logical name.
         * @returns {boolean} `true` when an entry was removed.
         */
        remove(apiId, name) {
            if (!areValidKey(apiId, name) || !Object.hasOwn(state.apis, apiId)) {
                return false;
            }
            const bucket = state.apis[apiId];
            if (!Object.hasOwn(bucket, name)) {
                return false;
            }
            delete bucket[name];
            return true;
        },

        /**
         * Resets usage counters and last-used timestamps, keeping import-time data.
         *
         * @param {string} [apiId] API id; omit to reset every API.
         * @returns {number} Number of entries affected.
         */
        resetUsage(apiId) {
            return forEachEntry(apiId, entry => {
                entry.count = 0;
                entry.lastUsedAt = null;
            });
        },

        /**
         * Clears resolved import times, keeping usage data and first-seen timestamps.
         *
         * @param {string} [apiId] API id; omit to clear every API.
         * @returns {number} Number of entries that had import-time data.
         */
        clearImportTimes(apiId) {
            let cleared = 0;
            forEachEntry(apiId, entry => {
                if (entry.importTime !== null || entry.importSource !== null) {
                    cleared += 1;
                }
                entry.importTime = null;
                entry.importSource = null;
            });
            return cleared;
        },

        /**
         * Returns a detached, JSON-safe copy of the persisted payload.
         *
         * @returns {{version: number, seeded: boolean, apis: Record<string, Record<string, PresetStatsEntry>>}} Persisted payload.
         */
        snapshot() {
            /** @type {Record<string, Record<string, PresetStatsEntry>>} */
            const apis = {};
            for (const apiId of Object.keys(state.apis)) {
                const bucket = state.apis[apiId];
                apis[apiId] = Object.fromEntries(
                    Object.keys(bucket).map(name => [name, cloneEntry(bucket[name])]),
                );
            }
            return { version: state.version, seeded: state.seeded, apis };
        },

        /**
         * Enforces the per-API entry cap by dropping the least recently active
         * presets (by `lastUsedAt`, falling back to `firstSeenAt`).
         *
         * @returns {number} Number of entries removed.
         */
        prune() {
            let removed = 0;
            for (const apiId of Object.keys(state.apis)) {
                const bucket = state.apis[apiId];
                const names = Object.keys(bucket);
                if (names.length <= MAX_STATS_PER_API) {
                    continue;
                }
                names.sort((nameA, nameB) => {
                    const entryA = bucket[nameA];
                    const entryB = bucket[nameB];
                    const recencyA = entryA.lastUsedAt ?? entryA.firstSeenAt ?? 0;
                    const recencyB = entryB.lastUsedAt ?? entryB.firstSeenAt ?? 0;
                    return recencyB - recencyA || (nameA < nameB ? -1 : (nameA > nameB ? 1 : 0));
                });
                for (const name of names.slice(MAX_STATS_PER_API)) {
                    delete bucket[name];
                    removed += 1;
                }
            }
            return removed;
        },

        /**
         * Short alias for {@link getSummary}.
         *
         * @returns {StatsSummary} Aggregate stats summary.
         */
        summary() {
            return api.getSummary();
        },

        /**
         * Returns aggregate counters for the settings diagnostics line.
         *
         * @returns {StatsSummary} Aggregate stats summary.
         */
        getSummary() {
            /** @type {StatsSummary} */
            const summary = { known: 0, used: 0, importTimes: 0, seeded: state.seeded === true, apis: {} };
            for (const apiId of Object.keys(state.apis)) {
                const bucket = state.apis[apiId];
                const counts = { known: 0, used: 0, importTimes: 0 };
                for (const name of Object.keys(bucket)) {
                    const entry = bucket[name];
                    counts.known += 1;
                    if (entry.count > 0) {
                        counts.used += 1;
                    }
                    if (entry.importTime !== null) {
                        counts.importTimes += 1;
                    }
                }
                summary.apis[apiId] = counts;
                summary.known += counts.known;
                summary.used += counts.used;
                summary.importTimes += counts.importTimes;
            }
            return summary;
        },
    };

    return api;
}

/**
 * Returns the smaller of two nullable timestamps (`null` counts as unknown).
 *
 * @param {number|null} a First timestamp.
 * @param {number|null} b Second timestamp.
 * @returns {number|null} Smaller timestamp, or the known one.
 */
function minNullable(a, b) {
    if (a === null) {
        return b;
    }
    if (b === null) {
        return a;
    }
    return Math.min(a, b);
}

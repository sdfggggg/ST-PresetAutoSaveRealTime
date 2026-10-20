/**
 * Extension controller: wires the pure core modules to SillyTavern / TauriTavern.
 *
 * Responsibilities:
 * - wait for the host modules and the preset manager `<select>` elements;
 * - merge persisted settings + stats into `extension_settings['preset-sorter']`;
 * - seed first-seen metadata for existing presets (never invent import times);
 * - inject per-manager sort controls and apply the configured order immediately
 *   from cached stats, then resolve real import times from the host filesystem
 *   in a deferred, concurrency-limited idle batch;
 * - count real generations as preset usage (`GENERATION_AFTER_COMMANDS`);
 * - follow rename/delete/import mutations, keep the selected preset and never
 *   mutate SillyTavern's in-memory preset arrays or fire `change` events;
 * - persist debounced and expose `window.__PRESET_SORTER__` diagnostics.
 *
 * All SillyTavern imports are dynamic so this module stays importable under
 * Node.js and fails soft when the host modules are unavailable.
 *
 * @module preset-sorter/controller
 */

import {
    DEFAULT_DIRECTION,
    DEFAULT_FIELD,
    EXTENSION_NAME,
    EXTENSION_VERSION,
    FIELD_ORDER,
    SORT_DIRECTIONS,
    SORT_FIELDS,
} from './constants.js';
import {
    applyOptionOrder,
    discoverPresetManagers,
    injectSortControl,
    isPresetPlaceholder,
    observePresetSelect,
    readOptionEntries,
    readSelectOptions,
    readSelectedOption,
    updateOptionTooltips,
} from './dom-bridge.js';
import { createHostFs } from './host-fs.js';
import { setLocale, t } from './i18n.js';
import { isSupportedPresetApi, normalizePresetApiId } from './preset-file.js';
import { mountSettingsPanel } from './settings-ui.js';
import { computePresetOrderByField, fieldDirectionToMode } from './sort-engine.js';
import { createStatsStore } from './stats-store.js';

const LOG_PREFIX = '[preset-sorter]';
const VERSION = EXTENSION_VERSION;

/** @type {number} */
const USAGE_DEDUPE_MS = 300;
/** @type {number} */
const USAGE_INIT_SUPPRESS_MS = 1000;
/** @type {number} */
const PERSIST_DEBOUNCE_MS = 500;
/** @type {number} */
const MANAGER_POLL_INTERVAL_MS = 200;
/** @type {number} */
const FS_REFRESH_DEBOUNCE_MS = 400;
/** @type {number} */
const FS_IDLE_TIMEOUT_MS = 2500;

/** Pending idle callbacks (fallback timer). @type {number|null} */
let idleFallbackTimer = null;

/**
 * @typedef {object} PresetManagerState
 * @property {string} apiId Canonical API id.
 * @property {HTMLSelectElement|any} select Preset select element.
 * @property {string[]} originalOrder Upstream (pre-sort) option values, including placeholders.
 * @property {{disconnect: () => void, takeRecords: () => MutationRecord[]}|null} observer Option observer.
 * @property {ReturnType<typeof injectSortControl>} control Injected sort-mode control.
 */

/**
 * @typedef {object} ControllerRuntime
 * @property {object} st SillyTavern module bindings.
 * @property {object} settings Live settings object (persisted in `extension_settings`).
 * @property {ReturnType<typeof createStatsStore>} store Stats store.
 * @property {ReturnType<typeof createHostFs>} hostFs Host filesystem bridge.
 * @property {Map<string, PresetManagerState>} managers Attached preset managers by API id.
 * @property {string} usageSignal `generation` | `native-change-fallback`.
 * @property {number} startedAt Initialization timestamp.
 * @property {number} usageSuppressUntil Usage counting suppression deadline.
 * @property {Map<string, number>} usageDedupe Per-preset dedupe timestamps.
 * @property {number|null} persistTimer Pending persistence timer.
 * @property {number|null} fsRefreshTimer Pending refresh timer.
 * @property {Promise<void>|null} fsRefreshPromise In-flight fs refresh.
 * @property {boolean} fsRefreshQueued A refresh was requested while one was running.
 * @property {ReturnType<typeof mountSettingsPanel>|null} settingsPanel Mounted settings panel.
 * @property {boolean} syncScheduled Manager re-sync scheduled.
 * @property {Promise<object>|null} fsInitPromise Host fs initialization promise.
 */

/** @type {ControllerRuntime|null} */
let runtime = null;

/** @type {boolean} */
let initialized = false;

/**
 * Public entry point called by `index.js`.
 *
 * @returns {Promise<void>} Resolves when initialization has been attempted (never rejects).
 */
export async function initializePresetSorter() {
    if (initialized) {
        return;
    }
    initialized = true;
    try {
        await start();
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed to initialize the extension.`, error);
    }
}

/**
 * Boots the extension.
 *
 * @returns {Promise<void>} Resolves when the boot sequence has been scheduled.
 */
async function start() {
    // Bail out early (and quietly) when the host preset UI is not present at all.
    // This keeps the extension inert in plain documents / test harnesses without
    // touching SillyTavern modules and without logging errors.
    const initialManagers = await waitForPresetSelects(1000);
    if (initialManagers.length === 0) {
        console.debug(`${LOG_PREFIX} host preset UI not found; extension stays inactive.`);
        return;
    }

    const st = await loadStModules();
    applyHostLocale(st);

    const settings = loadSettings(st.extension_settings?.[EXTENSION_NAME]);
    const store = createStatsStore({ data: settings.stats, logger: console });
    const hostFs = createHostFs({
        invoke: resolveTauriInvoke(),
        pathApi: resolveTauriPathApi(),
        getCurrentUserHandle: st.getCurrentUserHandle,
        logger: console,
    });

    /** @type {ControllerRuntime} */
    const rt = {
        st,
        settings,
        store,
        hostFs,
        managers: new Map(),
        usageSignal: 'generation',
        startedAt: Date.now(),
        usageSuppressUntil: Date.now() + USAGE_INIT_SUPPRESS_MS,
        usageDedupe: new Map(),
        persistTimer: null,
        fsRefreshTimer: null,
        fsRefreshPromise: null,
        fsRefreshQueued: false,
        settingsPanel: null,
        syncScheduled: false,
        fsInitPromise: null,
    };
    runtime = rt;

    // Resolve host paths in parallel with DOM work; the fs batch is deferred below.
    rt.fsInitPromise = hostFs.initialize().catch(error => {
        console.warn(`${LOG_PREFIX} host filesystem initialization failed.`, error);
        return null;
    });

    const discovered = initialManagers;
    for (const { apiId, select } of discovered) {
        attachManager(apiId, select);
    }

    seedKnownPresets();
    applyAllStates();
    updateAllTooltips();
    // Persist the first-run settings entry (seeded stats + known presets) even if
    // host filesystem metadata is unavailable and no usage has been recorded yet.
    // This keeps `settings.json` diagnostics/verification reliable right after init.
    persistSoon();
    subscribeEvents();
    installDiagnosticsGlobal();
    await mountSettingsUi();
    updateSettingsUi();
    scheduleInitialFsRefresh();

    console.debug(
        `${LOG_PREFIX} initialized: ${runtime.managers.size} preset manager(s), usage signal "${runtime.usageSignal}".`,
    );
}

/* -------------------------------------------------------------------------- */
/* Host module loading                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Dynamically imports the SillyTavern modules used by the extension.
 *
 * Root-absolute URLs are used intentionally: the app serves `/script.js` and
 * `/scripts/*`, and relative depth differs between the extension root entry and
 * files in `src/`. Root-absolute specifiers keep these imports stable.
 *
 * @returns {Promise<object>} Module bindings.
 */
async function loadStModules() {
    const scriptNamespace = await import('/script.js');
    const extensionsNamespace = await import('/scripts/extensions.js');

    /** @type {any} */
    let userNamespace = null;
    try {
        userNamespace = await import('/scripts/user.js');
    } catch (error) {
        console.warn(`${LOG_PREFIX} user.js is unavailable; assuming the default user.`, error);
    }

    /** @type {any} */
    let presetManagerNamespace = null;
    try {
        presetManagerNamespace = await import('/scripts/preset-manager.js');
    } catch (error) {
        console.warn(`${LOG_PREFIX} preset-manager.js is unavailable; falling back to main_api.`, error);
    }

    /** @type {any} */
    let i18nNamespace = null;
    try {
        i18nNamespace = await import('/scripts/i18n.js');
    } catch {
        // Optional: fall back to browser locale detection in our own i18n.
    }

    return {
        script: scriptNamespace,
        extensions: extensionsNamespace,
        eventSource: scriptNamespace.eventSource,
        event_types: scriptNamespace.event_types ?? {},
        saveSettingsDebounced: scriptNamespace.saveSettingsDebounced,
        extension_settings: extensionsNamespace.extension_settings,
        renderExtensionTemplateAsync: extensionsNamespace.renderExtensionTemplateAsync,
        getCurrentUserHandle: typeof userNamespace?.getCurrentUserHandle === 'function'
            ? userNamespace.getCurrentUserHandle
            : (() => 'default-user'),
        getPresetManager: typeof presetManagerNamespace?.getPresetManager === 'function'
            ? presetManagerNamespace.getPresetManager
            : null,
        getCurrentLocale: typeof i18nNamespace?.getCurrentLocale === 'function'
            ? i18nNamespace.getCurrentLocale
            : null,
    };
}

/**
 * Uses SillyTavern's UI locale when available (otherwise our own browser detection).
 *
 * @param {object} st Module bindings.
 * @returns {void}
 */
function applyHostLocale(st) {
    try {
        const locale = st.getCurrentLocale?.();
        if (typeof locale === 'string' && locale !== '') {
            setLocale(locale);
        }
    } catch {
        // Keep browser-detected locale.
    }
}

/**
 * @returns {((command: string, args?: object) => Promise<any>)|null} Tauri invoke wrapper, or `null`.
 */
function resolveTauriInvoke() {
    try {
        const tauri = globalThis.__TAURI__;
        const invoke = tauri?.core?.invoke;
        if (typeof invoke === 'function') {
            return (command, args) => invoke(command, args);
        }
    } catch {
        // Not in TauriTavern.
    }
    return null;
}

/**
 * @returns {{appDataDir?: () => Promise<string>}|null} Tauri path API or `null`.
 */
function resolveTauriPathApi() {
    try {
        const pathApi = globalThis.__TAURI__?.path;
        return pathApi && typeof pathApi === 'object' ? pathApi : null;
    } catch {
        return null;
    }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A field + direction sort specification (v1.1.0 settings shape).
 * @typedef {object} SortSpec
 * @property {string} field Sort field (`default` | `import` | `usage` | `recent`).
 * @property {string} direction Sort direction (`asc` | `desc`).
 */

/**
 * @typedef {object} PresetSorterSettings
 * @property {boolean} enabled Whether sorting is enabled.
 * @property {boolean} applyToAll Whether every manager uses `default`.
 * @property {SortSpec} default Default field + direction.
 * @property {Record<string, SortSpec>} perApi Per-API field + direction (used when `applyToAll` is off).
 * @property {object|null} stats Persisted stats payload.
 */

/** The upstream default: no reordering until the user picks a real field. @type {Readonly<SortSpec>} */
const DEFAULT_SPEC = Object.freeze({ field: DEFAULT_FIELD, direction: DEFAULT_DIRECTION });

/**
 * v1.0.x combined sort mode -> v1.1.0 field + direction (silent migration map).
 * @type {Readonly<Record<string, Readonly<SortSpec>>>}
 */
const LEGACY_MODE_SPECS = Object.freeze({
    default: Object.freeze({ field: SORT_FIELDS.DEFAULT, direction: SORT_DIRECTIONS.DESC }),
    'import-asc': Object.freeze({ field: SORT_FIELDS.IMPORT, direction: SORT_DIRECTIONS.ASC }),
    'import-desc': Object.freeze({ field: SORT_FIELDS.IMPORT, direction: SORT_DIRECTIONS.DESC }),
    'usage-asc': Object.freeze({ field: SORT_FIELDS.USAGE, direction: SORT_DIRECTIONS.ASC }),
    'usage-desc': Object.freeze({ field: SORT_FIELDS.USAGE, direction: SORT_DIRECTIONS.DESC }),
    'recent-asc': Object.freeze({ field: SORT_FIELDS.RECENT, direction: SORT_DIRECTIONS.ASC }),
    'recent-desc': Object.freeze({ field: SORT_FIELDS.RECENT, direction: SORT_DIRECTIONS.DESC }),
});

/** @type {ReadonlySet<string>} */
const VALID_FIELDS = new Set(FIELD_ORDER);

/** @type {ReadonlySet<string>} */
const VALID_DIRECTIONS = new Set(Object.values(SORT_DIRECTIONS));

/**
 * @param {unknown} field Raw sort field.
 * @returns {string} Normalised field.
 */
function normalizeFieldValue(field) {
    return typeof field === 'string' && VALID_FIELDS.has(field) ? field : DEFAULT_FIELD;
}

/**
 * @param {unknown} direction Raw sort direction.
 * @returns {string} Normalised direction.
 */
function normalizeDirectionValue(direction) {
    return typeof direction === 'string' && VALID_DIRECTIONS.has(direction) ? direction : DEFAULT_DIRECTION;
}

/**
 * Normalises a persisted sort spec. Accepts:
 * - v1.1.0 objects `{field, direction}`;
 * - v1.0.x legacy mode strings (`import-asc`, `usage-desc`, ...);
 * - missing/invalid values (falls back to the provided default spec).
 *
 * The function is pure and idempotent, which makes the silent migration
 * lossless: applying it to already-migrated values changes nothing.
 *
 * @param {unknown} raw Persisted spec or legacy mode string.
 * @param {Readonly<SortSpec>} [fallback] Fallback spec.
 * @returns {SortSpec} Normalised spec (new object).
 */
function normalizeSortSpec(raw, fallback = DEFAULT_SPEC) {
    if (typeof raw === 'string') {
        const legacy = LEGACY_MODE_SPECS[raw];
        if (legacy) {
            return { field: legacy.field, direction: legacy.direction };
        }
    } else if (raw && typeof raw === 'object') {
        return {
            field: normalizeFieldValue(raw.field),
            direction: normalizeDirectionValue(raw.direction),
        };
    }
    return { field: fallback.field, direction: fallback.direction };
}

/**
 * Validates/merges the persisted settings payload.
 *
 * v1.0.x payloads (`defaultMode` + per-API mode strings) are silently upgraded to
 * the v1.1.0 field + direction shape on load; the upgraded shape is persisted on
 * the next save. Mixed payloads (v2 `default` + v1 `perApi` strings) are handled
 * per entry.
 *
 * @param {unknown} raw Persisted value.
 * @returns {PresetSorterSettings} Normalized settings.
 */
function loadSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const defaultSpec = normalizeSortSpec(source.default ?? source.defaultMode, DEFAULT_SPEC);
    /** @type {Record<string, SortSpec>} */
    const perApi = {};
    if (source.perApi && typeof source.perApi === 'object' && !Array.isArray(source.perApi)) {
        for (const [rawApiId, rawSpec] of Object.entries(source.perApi)) {
            const apiId = normalizePresetApiId(String(rawApiId));
            if (isSupportedPresetApi(apiId)) {
                perApi[apiId] = normalizeSortSpec(rawSpec, defaultSpec);
            }
        }
    }
    return {
        enabled: source.enabled !== false,
        applyToAll: source.applyToAll !== false,
        default: defaultSpec,
        perApi,
        stats: source.stats && typeof source.stats === 'object' ? source.stats : null,
    };
}

/**
 * @param {string} apiId Canonical API id.
 * @returns {SortSpec} Sort spec selected in the controls (ignores the global enable flag).
 */
function storedSpecFor(apiId) {
    const rt = runtime;
    if (!rt) {
        return { field: DEFAULT_FIELD, direction: DEFAULT_DIRECTION };
    }
    if (rt.settings.applyToAll) {
        return rt.settings.default;
    }
    return rt.settings.perApi[apiId] ?? rt.settings.default;
}

/**
 * @param {string} apiId Canonical API id.
 * @returns {SortSpec} Effective sort spec (disabled sorting always restores upstream order).
 */
function resolveSpec(apiId) {
    const rt = runtime;
    if (!rt || !rt.settings.enabled) {
        return { field: DEFAULT_FIELD, direction: DEFAULT_DIRECTION };
    }
    return storedSpecFor(apiId);
}

/**
 * Pure settings migration/normalisation helper, exported for tests/tooling.
 *
 * Accepts a v1.0.x payload (`defaultMode` + per-API mode strings) or a v1.1.0
 * payload (`default` + per-API `{field, direction}` objects) and returns the
 * normalised v1.1.0 settings shape. The function is idempotent and does not
 * mutate its input.
 *
 * @param {unknown} raw Persisted settings payload (or `undefined`).
 * @returns {PresetSorterSettings} Normalised settings.
 */
export function migratePresetSorterSettings(raw) {
    return loadSettings(raw);
}

/**
 * Persists the current settings + stats snapshot immediately.
 *
 * @returns {void}
 */
function persistNow() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    if (rt.persistTimer !== null) {
        clearTimeout(rt.persistTimer);
        rt.persistTimer = null;
    }
    try {
        rt.store.prune();
        rt.settings.stats = rt.store.snapshot();
        if (rt.st.extension_settings && typeof rt.st.extension_settings === 'object') {
            rt.st.extension_settings[EXTENSION_NAME] = rt.settings;
        }
        if (typeof rt.st.saveSettingsDebounced === 'function') {
            rt.st.saveSettingsDebounced();
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to persist settings.`, error);
    }
}

/**
 * Debounced persistence.
 *
 * @returns {void}
 */
function persistSoon() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    if (rt.persistTimer !== null) {
        clearTimeout(rt.persistTimer);
    }
    rt.persistTimer = setTimeout(() => {
        rt.persistTimer = null;
        persistNow();
    }, PERSIST_DEBOUNCE_MS);
}

/* -------------------------------------------------------------------------- */
/* Manager discovery / attachment                                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits (bounded) until at least one preset manager select exists in the DOM.
 *
 * Options may still be empty at this point (SillyTavern populates them during
 * startup); the per-select MutationObserver reconciles the upstream order as
 * soon as they are added.
 *
 * @param {number} [timeoutMs] Maximum wait.
 * @returns {Promise<Array<{apiId: string, select: any}>>} Discovered managers (possibly empty).
 */
async function waitForPresetSelects(timeoutMs = MANAGER_POLL_INTERVAL_MS) {
    const deadline = Date.now() + timeoutMs;
    let discovered = discoverPresetManagers();
    while (discovered.length === 0 && Date.now() < deadline) {
        await delay(100);
        discovered = discoverPresetManagers();
    }
    return discovered;
}

/**
 * Attaches (or re-attaches) one preset manager: snapshots the upstream order,
 * observes option mutations and injects the sort control.
 *
 * @param {string} apiId API id.
 * @param {HTMLSelectElement|any} select Preset select element.
 * @returns {void}
 */
function attachManager(apiId, select) {
    const rt = runtime;
    if (!rt || !select) {
        return;
    }
    const canonicalApiId = normalizePresetApiId(apiId);
    if (!isSupportedPresetApi(canonicalApiId)) {
        return;
    }

    const existing = rt.managers.get(canonicalApiId);
    if (existing && existing.select === select) {
        const spec = storedSpecFor(canonicalApiId);
        existing.control?.setState(spec.field, spec.direction);
        existing.control?.setHidden(!rt.settings.enabled);
        return;
    }
    existing?.observer?.disconnect();

    /** @type {PresetManagerState} */
    const state = {
        apiId: canonicalApiId,
        select,
        // Snapshot the upstream order before the first sort ever touches the DOM.
        originalOrder: readSelectOptions(select).map(option => option.value),
        observer: null,
        control: null,
    };
    state.observer = observePresetSelect(select, records => onSelectMutated(state, records));
    const spec = storedSpecFor(canonicalApiId);
    state.control = injectSortControl({
        select,
        apiId: canonicalApiId,
        field: spec.field,
        direction: spec.direction,
        onChange: onControlStateChange,
    });
    state.control?.setHidden(!rt.settings.enabled);
    rt.managers.set(canonicalApiId, state);
}

/**
 * Re-discovers managers after host lifecycle events (e.g. a settings reload that
 * replaced the select elements).
 *
 * @returns {void}
 */
function syncManagersSoon() {
    const rt = runtime;
    if (!rt || rt.syncScheduled) {
        return;
    }
    rt.syncScheduled = true;
    queueMicrotask(() => {
        const current = runtime;
        if (!current) {
            return;
        }
        current.syncScheduled = false;
        try {
            for (const { apiId, select } of discoverPresetManagers()) {
                attachManager(apiId, select);
            }
            seedKnownPresets();
            applyAllStates();
            updateAllTooltips();
            updateSettingsUi();
        } catch (error) {
            console.error(`${LOG_PREFIX} failed to refresh preset managers.`, error);
        }
    });
}

/**
 * @param {PresetManagerState} state Manager state.
 * @returns {Array<{name: string, value: string, option: any}>} Options excluding placeholders.
 */
function presetEntriesOf(state) {
    return readOptionEntries(state.select).filter(entry => !isPresetPlaceholder(state.apiId, entry));
}

/* -------------------------------------------------------------------------- */
/* Sorting                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Returns the stats view used by the sort engine. When no host filesystem
 * metadata is available (plain SillyTavern, unreadable file, disabled bridge)
 * the first-seen timestamp acts as the import-time fallback.
 *
 * @param {string} apiId API id.
 * @param {string} name Preset logical name.
 * @returns {import('./stats-store.js').PresetStatsEntry|undefined} Stats for sorting.
 */
function getSortStats(apiId, name) {
    const rt = runtime;
    if (!rt) {
        return undefined;
    }
    const entry = rt.store.get(apiId, name);
    if (!entry) {
        return undefined;
    }
    if (entry.importTime === null && entry.firstSeenAt !== null) {
        return {
            count: entry.count,
            lastUsedAt: entry.lastUsedAt,
            importTime: entry.firstSeenAt,
            importSource: 'first-seen',
            firstSeenAt: entry.firstSeenAt,
        };
    }
    return entry;
}

/**
 * Computes the desired option order for a manager.
 *
 * The "default" field always restores the upstream order tracked in
 * `state.originalOrder` (which survives re-sorting and option repopulation).
 *
 * @param {PresetManagerState} state Manager state.
 * @returns {Array<{name: string, value: string}>} Desired option order (placeholders first).
 */
function desiredItemsForState(state) {
    const entries = readOptionEntries(state.select);
    const placeholders = entries.filter(entry => isPresetPlaceholder(state.apiId, entry));
    const presets = entries.filter(entry => !isPresetPlaceholder(state.apiId, entry));
    const byValue = new Map(presets.map(entry => [entry.value, entry]));

    /** @type {Array<{name: string, value: string}>} */
    const baseItems = [];
    const knownValues = new Set();
    for (const value of state.originalOrder) {
        if (knownValues.has(value)) {
            continue;
        }
        const entry = byValue.get(value);
        if (!entry) {
            continue;
        }
        knownValues.add(value);
        baseItems.push({ name: entry.name, value: entry.value });
    }
    // Safety net: include options that the observer has not reconciled yet.
    for (const entry of presets) {
        if (knownValues.has(entry.value)) {
            continue;
        }
        knownValues.add(entry.value);
        baseItems.push({ name: entry.name, value: entry.value });
    }

    const spec = resolveSpec(state.apiId);
    const ordered = spec.field === SORT_FIELDS.DEFAULT
        ? baseItems.slice()
        : computePresetOrderByField(baseItems, spec.field, spec.direction, name => getSortStats(state.apiId, name));

    return [...placeholders.map(entry => ({ name: entry.name, value: entry.value })), ...ordered];
}

/**
 * Applies the desired order to one manager (no-op when already correct).
 *
 * @param {PresetManagerState} state Manager state.
 * @returns {boolean} Whether the DOM was reordered.
 */
function applyState(state) {
    const changed = applyOptionOrder(state.select, desiredItemsForState(state));
    // Discard mutation records produced by our own reorder.
    state.observer?.takeRecords?.();
    return changed;
}

/**
 * Applies the desired order to every attached manager.
 *
 * @returns {void}
 */
function applyAllStates() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    for (const state of rt.managers.values()) {
        try {
            applyState(state);
        } catch (error) {
            console.error(`${LOG_PREFIX} failed to sort ${state.apiId} presets.`, error);
        }
    }
}

/**
 * Refreshes the tooltip of every tracked manager.
 *
 * @returns {void}
 */
function updateAllTooltips() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    for (const state of rt.managers.values()) {
        try {
            updateOptionTooltips(state.select, name => getSortStats(state.apiId, name));
        } catch (error) {
            console.error(`${LOG_PREFIX} failed to update ${state.apiId} tooltips.`, error);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Mutation handling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} node Candidate DOM node.
 * @returns {boolean} Whether the node looks like an option element.
 */
function isOptionNode(node) {
    if (!node || typeof node !== 'object') {
        return false;
    }
    const tagName = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
    return tagName === 'OPTION' || (tagName === '' && node.value !== undefined);
}

/**
 * Reconciles the tracked upstream order with observed option mutations.
 *
 * New options are appended in the order the host added them (records order),
 * which preserves SillyTavern's "append at the end" semantics even while the
 * DOM is currently sorted by this extension.
 *
 * @param {PresetManagerState} state Manager state.
 * @param {MutationRecord[]|undefined} records Mutation records.
 * @returns {void}
 */
function reconcileOriginalOrder(state, records) {
    const currentValues = readSelectOptions(state.select).map(option => option.value);
    const currentSet = new Set(currentValues);

    /** @type {Set<string>} */
    const removed = new Set();
    /** @type {string[]} */
    const added = [];
    for (const record of records ?? []) {
        if (!record || record.type !== 'childList') {
            continue;
        }
        for (const node of record.removedNodes ?? []) {
            if (isOptionNode(node)) {
                removed.add(String(node.value));
            }
        }
        for (const node of record.addedNodes ?? []) {
            if (isOptionNode(node)) {
                added.push(String(node.value));
            }
        }
    }

    const order = state.originalOrder.filter(value => currentSet.has(value) && !removed.has(value));
    const seen = new Set(order);
    for (const value of added) {
        if (currentSet.has(value) && !seen.has(value)) {
            seen.add(value);
            order.push(value);
        }
    }
    for (const value of currentValues) {
        if (!seen.has(value)) {
            seen.add(value);
            order.push(value);
        }
    }
    state.originalOrder = order;
}

/**
 * Tracks previously unseen presets as "known" (first-seen metadata only).
 *
 * @param {PresetManagerState} [onlyState] Restrict to one manager.
 * @returns {string[]} Newly tracked preset names.
 */
function ensureKnownFromDom(onlyState) {
    const rt = runtime;
    if (!rt) {
        return [];
    }
    const now = Date.now();
    const added = [];
    const states = onlyState ? [onlyState] : [...rt.managers.values()];
    for (const state of states) {
        for (const entry of presetEntriesOf(state)) {
            if (entry.name === '') {
                continue;
            }
            if (rt.store.get(state.apiId, entry.name)) {
                continue;
            }
            if (rt.store.ensureKnown(state.apiId, entry.name, now)) {
                added.push(entry.name);
            }
        }
    }
    if (added.length > 0 && !rt.store.isSeeded()) {
        rt.store.markSeeded(now);
    }
    return added;
}

/**
 * First-run seeding: every currently visible preset becomes known without
 * inventing an import time.
 *
 * @returns {void}
 */
function seedKnownPresets() {
    ensureKnownFromDom();
}

/**
 * Handles option-list mutations for one manager.
 *
 * @param {PresetManagerState} state Manager state.
 * @param {MutationRecord[]} records Mutation records.
 * @returns {void}
 */
function onSelectMutated(state, records) {
    try {
        reconcileOriginalOrder(state, records);
        const added = ensureKnownFromDom(state);
        if (added.length > 0) {
            scheduleFsRefresh({ reason: 'mutation' });
        }
        applyState(state);
        updateOptionTooltips(state.select, name => getSortStats(state.apiId, name));
        persistSoon();
        updateSettingsUi();
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to handle preset list changes.`, error);
    }
}

/* -------------------------------------------------------------------------- */
/* Usage tracking                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Returns the preset currently belonging to the API used for generation.
 *
 * @returns {{apiId: string, name: string, value: string}|null} Active preset, or `null`.
 */
function currentPrimaryPreset() {
    const rt = runtime;
    if (!rt) {
        return null;
    }
    try {
        if (typeof rt.st.getPresetManager === 'function') {
            const manager = rt.st.getPresetManager();
            if (manager) {
                const apiId = normalizePresetApiId(manager.apiId);
                const name = typeof manager.getSelectedPresetName === 'function'
                    ? manager.getSelectedPresetName()
                    : '';
                const state = rt.managers.get(apiId);
                const selected = state ? readSelectedOption(state.select) : null;
                if (selected && isPresetPlaceholder(apiId, selected)) {
                    // Kobold's "GUI KoboldAI Settings" placeholder is not a preset file.
                    return null;
                }
                if (apiId && typeof name === 'string' && name !== '') {
                    return { apiId, name, value: selected ? selected.value : '' };
                }
            }
        }
    } catch (error) {
        console.debug(`${LOG_PREFIX} getPresetManager lookup failed.`, error);
    }

    // Fallback: derive the current API from `main_api` and read our select.
    try {
        const mainApi = normalizePresetApiId(rt.st.script?.main_api ?? '');
        const state = rt.managers.get(mainApi);
        if (state) {
            const selected = readSelectedOption(state.select);
            if (selected && selected.name !== '') {
                return { apiId: state.apiId, name: selected.name, value: selected.value };
            }
        }
    } catch {
        // Ignore.
    }
    return null;
}

/**
 * Records one usage of a preset (with dedupe and startup suppression).
 *
 * @param {string} apiId API id.
 * @param {string} name Preset logical name.
 * @param {number} [ts] Usage timestamp.
 * @returns {boolean} Whether the usage was recorded.
 */
function recordUsage(apiId, name, ts = Date.now()) {
    const rt = runtime;
    if (!rt || !rt.settings.enabled || !isSupportedPresetApi(apiId) || !name) {
        return false;
    }
    if (ts < rt.usageSuppressUntil) {
        return false;
    }
    const key = `${apiId}\u0000${name}`;
    const last = rt.usageDedupe.get(key) ?? 0;
    if (ts - last < USAGE_DEDUPE_MS) {
        return false;
    }
    rt.usageDedupe.set(key, ts);
    rt.store.recordUsage(apiId, name, ts);
    applyAllStates();
    updateAllTooltips();
    persistSoon();
    updateSettingsUi();
    return true;
}

/**
 * `GENERATION_AFTER_COMMANDS` handler: count the active preset of the API that
 * is about to generate. Quiet/dry-run generations are skipped so extension
 * internals do not inflate usage statistics.
 *
 * @param {string} type Generation type.
 * @param {object} _params Generation params.
 * @param {boolean} dryRun Whether the generation is a dry run.
 * @returns {void}
 */
function onGenerationAfterCommands(type, _params, dryRun) {
    if (dryRun) {
        return;
    }
    if (type === 'quiet') {
        return;
    }
    const preset = currentPrimaryPreset();
    if (!preset) {
        return;
    }
    recordUsage(preset.apiId, preset.name, Date.now());
}

/**
 * Fallback for old SillyTavern builds without `GENERATION_AFTER_COMMANDS`:
 * count trusted native `change` events as usage.
 *
 * @returns {void}
 */
function installNativeChangeFallback() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    rt.usageSignal = 'native-change-fallback';
    for (const state of rt.managers.values()) {
        const handler = event => {
            if (event && event.isTrusted === false) {
                return;
            }
            const selected = readSelectedOption(state.select);
            if (!selected || isPresetPlaceholder(state.apiId, selected)) {
                return;
            }
            recordUsage(state.apiId, selected.name, Date.now());
        };
        try {
            state.select.addEventListener?.('change', handler);
        } catch {
            // Ignore.
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Host lifecycle events                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Subscribes to the SillyTavern events relevant to the extension.
 *
 * @returns {void}
 */
function subscribeEvents() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    const { eventSource, event_types: eventTypes } = rt.st;
    const hasEmitter = eventSource && typeof eventSource.on === 'function';

    if (hasEmitter) {
        try {
            if (eventTypes.GENERATION_AFTER_COMMANDS) {
                eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
                rt.usageSignal = 'generation';
            } else {
                installNativeChangeFallback();
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX} usage event subscription failed; using native change fallback.`, error);
            installNativeChangeFallback();
        }

        /**
         * @param {string|undefined} eventName Event name.
         * @param {Function} handler Handler.
         * @returns {void}
         */
        const on = (eventName, handler) => {
            if (!eventName) {
                return;
            }
            try {
                eventSource.on(eventName, handler);
            } catch (error) {
                console.warn(`${LOG_PREFIX} failed to subscribe to ${eventName}.`, error);
            }
        };

        on(eventTypes.PRESET_RENAMED, onPresetRenamed);
        on(eventTypes.PRESET_DELETED, onPresetDeleted);
        on(eventTypes.EXTENSION_SETTINGS_LOADED, onExtensionSettingsLoaded);
        on(eventTypes.APP_READY, syncManagersSoon);
        on(eventTypes.SETTINGS_LOADED, syncManagersSoon);
    } else {
        installNativeChangeFallback();
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', persistNow);
    }
}

/**
 * Transfers stats when a preset is renamed.
 *
 * @param {{apiId?: string, oldName?: string, newName?: string}} payload Event payload.
 * @returns {void}
 */
function onPresetRenamed(payload) {
    const rt = runtime;
    if (!rt || !payload) {
        return;
    }
    const apiId = normalizePresetApiId(payload.apiId);
    const { oldName, newName } = payload;
    if (!isSupportedPresetApi(apiId) || !oldName || !newName || oldName === newName) {
        return;
    }
    try {
        rt.store.rename(apiId, oldName, newName);
        rt.store.ensureKnown(apiId, newName, Date.now());
        rt.usageDedupe.delete(`${apiId}\u0000${oldName}`);
        const state = rt.managers.get(apiId);
        if (state) {
            ensureKnownFromDom(state);
            applyState(state);
            updateOptionTooltips(state.select, name => getSortStats(state.apiId, name));
        }
        persistSoon();
        updateSettingsUi();
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to handle preset rename.`, error);
    }
}

/**
 * Drops stats when a preset is deleted.
 *
 * @param {{apiId?: string, name?: string}} payload Event payload.
 * @returns {void}
 */
function onPresetDeleted(payload) {
    const rt = runtime;
    if (!rt || !payload) {
        return;
    }
    const apiId = normalizePresetApiId(payload.apiId);
    const name = payload.name;
    if (!isSupportedPresetApi(apiId) || !name) {
        return;
    }
    try {
        rt.store.remove(apiId, name);
        rt.usageDedupe.delete(`${apiId}\u0000${name}`);
        const state = rt.managers.get(apiId);
        if (state) {
            applyState(state);
            updateOptionTooltips(state.select, label => getSortStats(state.apiId, label));
        }
        persistSoon();
        updateSettingsUi();
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to handle preset deletion.`, error);
    }
}

/**
 * Re-merges persisted settings when the host finishes loading extension settings
 * (important in plain SillyTavern, where extensions can initialize earlier).
 *
 * @returns {void}
 */
function onExtensionSettingsLoaded() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    try {
        const persisted = rt.st.extension_settings?.[EXTENSION_NAME];
        if (!persisted || typeof persisted !== 'object') {
            return;
        }
        const merged = loadSettings(persisted);
        const storeHasData = rt.store.getSummary().known > 0;
        if (!storeHasData && merged.stats) {
            // The store was created before persisted stats were available.
            rt.store = createStatsStore({ data: merged.stats, logger: console });
        }
        rt.settings.enabled = merged.enabled;
        rt.settings.default = merged.default;
        rt.settings.applyToAll = merged.applyToAll;
        rt.settings.perApi = merged.perApi;
        syncControls();
        applyAllStates();
        updateAllTooltips();
        updateSettingsUi();
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to merge loaded extension settings.`, error);
    }
}

/* -------------------------------------------------------------------------- */
/* Sort control callbacks                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Handles a field + direction change coming from one injected control.
 *
 * When "apply to all preset managers" is on the change updates the shared
 * default spec; otherwise it is stored per API.
 *
 * @param {string} field New sort field.
 * @param {string} direction New sort direction.
 * @param {string} apiId API id whose control changed.
 * @returns {void}
 */
function onControlStateChange(field, direction, apiId) {
    const rt = runtime;
    if (!rt) {
        return;
    }
    const spec = normalizeSortSpec({ field, direction }, DEFAULT_SPEC);
    if (rt.settings.applyToAll) {
        rt.settings.default = spec;
    } else {
        rt.settings.perApi[apiId] = spec;
    }
    syncControls();
    applyAllStates();
    updateSettingsUi();
    persistNow();
}

/**
 * Synchronizes every injected control with the stored settings.
 *
 * @returns {void}
 */
function syncControls() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    for (const state of rt.managers.values()) {
        const spec = storedSpecFor(state.apiId);
        state.control?.setState(spec.field, spec.direction);
        state.control?.setHidden(!rt.settings.enabled);
    }
}

/**
 * Handles a settings panel change (toggles / default field / direction).
 * The panel has already mutated the live settings object.
 *
 * @param {{enabled?: boolean, applyToAll?: boolean, field?: string, direction?: string}} patch Changed fields.
 * @returns {void}
 */
function onSettingsPanelChange(patch) {
    const rt = runtime;
    if (!rt) {
        return;
    }
    syncControls();
    applyAllStates();
    updateSettingsUi();
    persistNow();
    if (patch && patch.enabled === false) {
        showToast('info', t('toast.disabled'));
    }
}

/* -------------------------------------------------------------------------- */
/* Settings UI                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Renders `settings.html` into `#extensions_settings2` and mounts the panel.
 *
 * @returns {Promise<void>} Resolves when mounting was attempted.
 */
async function mountSettingsUi() {
    const rt = runtime;
    if (!rt || typeof document === 'undefined') {
        return;
    }
    try {
        const existing = document.getElementById('preset_sorter_settings');
        if (existing) {
            mountPanel();
            return;
        }
        const container = document.getElementById('extensions_settings2')
            ?? document.getElementById('extensions_settings');
        if (!container) {
            console.debug(`${LOG_PREFIX} no extension settings container found.`);
            return;
        }
        const renderTemplate = rt.st.renderExtensionTemplateAsync;
        if (typeof renderTemplate !== 'function') {
            return;
        }
        const html = await renderTemplate('third-party/preset-sorter', 'settings');
        if (typeof html !== 'string' || html.trim() === '') {
            console.warn(`${LOG_PREFIX} settings template rendered empty.`);
            return;
        }
        container.insertAdjacentHTML('beforeend', html);
        mountPanel();
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to mount the settings panel.`, error);
    }
}

/**
 * Binds the settings panel to the controller.
 *
 * @returns {void}
 */
function mountPanel() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    rt.settingsPanel = mountSettingsPanel({
        settings: rt.settings,
        onChange: onSettingsPanelChange,
        onRefresh: refreshImportTimes,
        onResetUsage: resetUsageStats,
        confirmReset: confirmResetUsage,
        getDiagnostics: buildUiDiagnostics,
    });
}

/**
 * @returns {import('./settings-ui.js').SettingsUiDiagnostics} Diagnostics for the settings panel.
 */
function buildUiDiagnostics() {
    const rt = runtime;
    if (!rt) {
        return { fsAvailable: false, known: 0, used: 0, importTimes: 0 };
    }
    const fs = rt.hostFs.getStatus();
    const summary = rt.store.getSummary();
    return {
        fsAvailable: fs.available && fs.enabled,
        fsInitialized: fs.initialized,
        fsReason: fs.reason,
        dataRoot: fs.dataRoot,
        fsSource: fs.dataRootSource ?? fs.directorySource,
        handle: fs.handle,
        known: summary.known,
        used: summary.used,
        importTimes: summary.importTimes,
    };
}

/**
 * Updates the settings panel from the current state.
 *
 * @returns {void}
 */
function updateSettingsUi() {
    const rt = runtime;
    if (!rt || !rt.settingsPanel) {
        return;
    }
    try {
        rt.settingsPanel.update({
            settings: rt.settings,
            diagnostics: buildUiDiagnostics(),
            busy: rt.fsRefreshPromise !== null,
        });
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to update the settings panel.`, error);
    }
}

/* -------------------------------------------------------------------------- */
/* Import-time refresh                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Schedules the initial import-time batch during an idle period.
 *
 * @returns {void}
 */
function scheduleInitialFsRefresh() {
    const rt = runtime;
    if (!rt || !rt.hostFs.isAvailable()) {
        updateSettingsUi();
        return;
    }
    scheduleIdle(() => {
        void runFsRefresh({ reason: 'init', force: false });
    });
}

/**
 * Runs a callback when the browser is idle (bounded fallback to `setTimeout`).
 *
 * @param {() => void} callback Callback.
 * @returns {void}
 */
function scheduleIdle(callback) {
    if (idleFallbackTimer !== null) {
        clearTimeout(idleFallbackTimer);
        idleFallbackTimer = null;
    }
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => callback(), { timeout: FS_IDLE_TIMEOUT_MS });
        return;
    }
    idleFallbackTimer = setTimeout(() => {
        idleFallbackTimer = null;
        callback();
    }, FS_REFRESH_DEBOUNCE_MS);
}

/**
 * Schedules a deferred import-time batch (debounced).
 *
 * @param {{reason?: string, force?: boolean}} [options] Options.
 * @returns {void}
 */
function scheduleFsRefresh({ reason = 'auto', force = false } = {}) {
    const rt = runtime;
    if (!rt || !rt.hostFs.isAvailable()) {
        return;
    }
    if (rt.fsRefreshTimer !== null) {
        clearTimeout(rt.fsRefreshTimer);
    }
    rt.fsRefreshTimer = setTimeout(() => {
        rt.fsRefreshTimer = null;
        void runFsRefresh({ reason, force });
    }, FS_REFRESH_DEBOUNCE_MS);
}

/**
 * Resolves import times for presets that do not have real filesystem metadata
 * yet (or for all presets when `force` is set), then re-sorts.
 *
 * @param {{reason?: string, force?: boolean}} [options] Options.
 * @returns {Promise<void>} Resolves when the batch finished.
 */
function runFsRefresh(options = {}) {
    const rt = runtime;
    if (!rt) {
        return Promise.resolve();
    }
    if (rt.fsRefreshPromise) {
        rt.fsRefreshQueued = true;
        return rt.fsRefreshPromise;
    }

    const promise = (async () => {
        try {
            await executeFsRefresh(options);
        } catch (error) {
            console.error(`${LOG_PREFIX} import-time refresh failed.`, error);
        } finally {
            if (runtime === rt) {
                rt.fsRefreshPromise = null;
                updateSettingsUi();
            }
        }
    })();
    rt.fsRefreshPromise = promise;
    updateSettingsUi();
    return promise;
}

/**
 * @param {{reason?: string, force?: boolean}} options Refresh options.
 * @returns {Promise<void>} Resolves when done.
 */
async function executeFsRefresh({ reason = 'auto', force = false } = {}) {
    const rt = runtime;
    if (!rt) {
        return;
    }

    await rt.hostFs.initialize();
    if (!rt.hostFs.isEnabled()) {
        updateSettingsUi();
        return;
    }
    if (force) {
        rt.hostFs.clearCache();
    }

    let resolved = 0;
    let requested = 0;
    let foundAny = false;

    for (const state of rt.managers.values()) {
        /** @type {string[]} */
        const targets = [];
        for (const entry of presetEntriesOf(state)) {
            if (entry.name === '') {
                continue;
            }
            const current = rt.store.get(state.apiId, entry.name);
            const needsImportTime = !current
                || current.importTime === null
                || current.importSource === 'first-seen';
            if (force || needsImportTime) {
                targets.push(entry.name);
            }
        }
        if (targets.length === 0) {
            continue;
        }
        requested += targets.length;
        const results = await rt.hostFs.readImportTimesBatch(state.apiId, targets, {});
        for (const [name, info] of results) {
            rt.store.setImportTime(state.apiId, name, info.time, info.source);
            resolved += 1;
            foundAny = true;
        }
    }

    if (foundAny) {
        applyAllStates();
        updateAllTooltips();
        persistSoon();
    }
    if (force) {
        if (resolved > 0) {
            showToast('success', t('toast.refreshed', { count: resolved }));
        } else {
            showToast('warning', t('toast.refreshUnavailable'));
        }
    } else if (reason === 'init') {
        console.debug(`${LOG_PREFIX} resolved import times for ${resolved}/${requested} preset(s).`);
    }
    updateSettingsUi();
}

/**
 * Manual "refresh import times" button handler.
 *
 * @returns {Promise<void>} Resolves when the refresh finished.
 */
async function refreshImportTimes() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    if (!rt.hostFs.isAvailable()) {
        showToast('warning', t('toast.refreshUnavailable'));
        return;
    }
    await runFsRefresh({ reason: 'manual', force: true });
}

/**
 * Manual "reset usage stats" handler.
 *
 * @returns {void}
 */
function resetUsageStats() {
    const rt = runtime;
    if (!rt) {
        return;
    }
    try {
        rt.store.resetUsage();
        rt.usageDedupe.clear();
        applyAllStates();
        updateAllTooltips();
        persistNow();
        updateSettingsUi();
        showToast('success', t('toast.resetUsage'));
    } catch (error) {
        console.error(`${LOG_PREFIX} failed to reset usage stats.`, error);
        showToast('error', t('toast.error', { message: String(error) }));
    }
}

/**
 * Asks the user to confirm the usage reset (SillyTavern popup when available).
 *
 * @returns {Promise<boolean>} Whether the user confirmed.
 */
async function confirmResetUsage() {
    const message = t('confirm.resetUsage');
    try {
        const popupModule = await import('/scripts/popup.js');
        if (typeof popupModule.callGenericPopup === 'function' && popupModule.POPUP_TYPE) {
            const result = await popupModule.callGenericPopup(message, popupModule.POPUP_TYPE.CONFIRM);
            return result === true || result === 1;
        }
    } catch {
        // Fall through to the native confirmation.
    }
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        return window.confirm(message);
    }
    return true;
}

/* -------------------------------------------------------------------------- */
/* Toast + diagnostics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Shows a notification via the global `toastr` when available.
 *
 * @param {'info'|'success'|'warning'|'error'} kind Toast kind.
 * @param {string} message Message.
 * @returns {void}
 */
function showToast(kind, message) {
    try {
        const toastr = globalThis.toastr;
        if (toastr && typeof toastr[kind] === 'function') {
            toastr[kind](message);
            return;
        }
    } catch {
        // Ignore toast failures.
    }
    try {
        console.info(`${LOG_PREFIX} ${message}`);
    } catch {
        // Ignore.
    }
}

/**
 * Builds the cheap status snapshot exposed to the live-test probe extension.
 *
 * @returns {object} Read-only status snapshot.
 */
function buildProbeStatus() {
    const rt = runtime;
    if (!rt) {
        return {
            version: VERSION,
            initialized: false,
        };
    }
    const fs = rt.hostFs.getStatus();
    const summary = rt.store.getSummary();
    const fsState = !fs.available
        ? 'unavailable'
        : (!fs.initialized ? 'initializing' : (fs.enabled ? 'ready' : 'disabled'));
    /** @type {Record<string, {field: string, direction: string}>} */
    const perApiSpecs = {};
    /** @type {Record<string, string>} */
    const perApiModes = {};
    for (const state of rt.managers.values()) {
        const spec = resolveSpec(state.apiId);
        perApiSpecs[state.apiId] = { field: spec.field, direction: spec.direction };
        perApiModes[state.apiId] = fieldDirectionToMode(spec.field, spec.direction);
    }
    const defaultSpec = rt.settings.default;
    const defaultMode = fieldDirectionToMode(defaultSpec.field, defaultSpec.direction);
    return {
        version: VERSION,
        initialized: true,
        enabled: rt.settings.enabled,
        // v1.1.0 field + direction shape.
        default: { field: defaultSpec.field, direction: defaultSpec.direction },
        perApi: perApiSpecs,
        fields: [...FIELD_ORDER],
        // Backward-compatible v1 fields kept for older probes / tooling.
        mode: defaultMode,
        defaultMode,
        applyToAll: rt.settings.applyToAll,
        perApiModes,
        managers: [...rt.managers.keys()],
        usageSignal: rt.usageSignal,
        fsAvailable: fs.available,
        fsEnabled: fs.enabled,
        fsInitialized: fs.initialized,
        fsState,
        fsReason: fs.reason,
        dataRoot: fs.dataRoot,
        dataRootSource: fs.dataRootSource,
        directorySource: fs.directorySource,
        handle: fs.handle,
        known: summary.known,
        used: summary.used,
        importTimes: summary.importTimes,
        lastError: fs.lastError,
        presetDirectories: fs.presetDirectoryCount,
    };
}

/**
 * Installs `window.__PRESET_SORTER__ = { version, getStatus() }` for diagnostics
 * and the isolated live-test probe.
 *
 * @returns {void}
 */
function installDiagnosticsGlobal() {
    if (typeof window === 'undefined') {
        return;
    }
    try {
        window.__PRESET_SORTER__ = Object.freeze({
            version: VERSION,
            getStatus: buildProbeStatus,
        });
    } catch (error) {
        console.warn(`${LOG_PREFIX} could not expose diagnostics global.`, error);
    }
}

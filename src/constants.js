/**
 * Static identifiers, sort modes, per-API preset-manager descriptors and tuning
 * constants for the `preset-sorter` extension.
 *
 * This module is intentionally free of DOM / SillyTavern / Tauri imports so it
 * can be unit-tested under plain Node.js and imported by any other module.
 *
 * @module preset-sorter/constants
 */

/** Extension folder name, i.e. `third-party/<EXTENSION_NAME>` in SillyTavern. @type {string} */
export const EXTENSION_NAME = 'preset-sorter';

/** Sort mode that keeps the upstream (SillyTavern) option order untouched. @type {string} */
export const DEFAULT_MODE = 'default';

/**
 * Canonical identifiers for every supported **legacy combined** sort mode
 * (kept for backward compatibility with persisted v1 settings and tests).
 * v1.1.0 stores a field + direction instead; see {@link SORT_FIELDS} and
 * {@link SORT_DIRECTIONS}.
 *
 * @type {Readonly<{
 *   DEFAULT: 'default',
 *   IMPORT_ASC: 'import-asc',
 *   IMPORT_DESC: 'import-desc',
 *   USAGE_ASC: 'usage-asc',
 *   USAGE_DESC: 'usage-desc',
 *   RECENT_ASC: 'recent-asc',
 *   RECENT_DESC: 'recent-desc',
 * }>}
 */
export const SORT_MODES = Object.freeze({
    DEFAULT: 'default',
    IMPORT_ASC: 'import-asc',
    IMPORT_DESC: 'import-desc',
    USAGE_ASC: 'usage-asc',
    USAGE_DESC: 'usage-desc',
    RECENT_ASC: 'recent-asc',
    RECENT_DESC: 'recent-desc',
});

/** UI display order of the legacy sort modes (v1 compatibility only). @type {ReadonlyArray<string>} */
export const MODE_ORDER = Object.freeze([
    SORT_MODES.DEFAULT,
    SORT_MODES.IMPORT_ASC,
    SORT_MODES.IMPORT_DESC,
    SORT_MODES.USAGE_ASC,
    SORT_MODES.USAGE_DESC,
    SORT_MODES.RECENT_ASC,
    SORT_MODES.RECENT_DESC,
]);

/**
 * Primary sort field identifiers used by the v1.1.0 field + direction UI.
 * @type {Readonly<{
 *   DEFAULT: 'default',
 *   IMPORT: 'import',
 *   USAGE: 'usage',
 *   RECENT: 'recent',
 * }>}
 */
export const SORT_FIELDS = Object.freeze({
    DEFAULT: 'default',
    IMPORT: 'import',
    USAGE: 'usage',
    RECENT: 'recent',
});

/** UI display order of the sort fields. @type {ReadonlyArray<string>} */
export const FIELD_ORDER = Object.freeze([
    SORT_FIELDS.DEFAULT,
    SORT_FIELDS.IMPORT,
    SORT_FIELDS.USAGE,
    SORT_FIELDS.RECENT,
]);

/** Default sort field: keep the upstream SillyTavern order. @type {string} */
export const DEFAULT_FIELD = SORT_FIELDS.DEFAULT;

/**
 * Sort direction identifiers: `asc` = 正序 (ascending), `desc` = 倒序 (descending).
 * @type {Readonly<{ASC: 'asc', DESC: 'desc'}>}
 */
export const SORT_DIRECTIONS = Object.freeze({
    ASC: 'asc',
    DESC: 'desc',
});

/** Valid sort directions. @type {ReadonlyArray<string>} */
export const DIRECTION_ORDER = Object.freeze([SORT_DIRECTIONS.ASC, SORT_DIRECTIONS.DESC]);

/** Default direction (descending), matching the v1 default mode `default`. @type {string} */
export const DEFAULT_DIRECTION = SORT_DIRECTIONS.DESC;

/**
 * Descriptor for one SillyTavern preset manager.
 * @typedef {object} PresetApiDescriptor
 * @property {string} dirName Directory name under the user data root that stores this API's preset JSON files.
 * @property {string} extension File extension (including the dot) of preset files.
 * @property {string} selectId `id` of the DOM `<select>` element without the leading `#`.
 * @property {string} labelKey i18n key for a human readable API/preset-type name.
 */

/**
 * Preset managers supported by the extension, keyed by SillyTavern API id.
 *
 * `koboldhorde` is an accepted alias of `kobold` (same directory and DOM select),
 * see `normalizePresetApiId()` in `preset-file.js`.
 *
 * @type {Readonly<Record<string, Readonly<PresetApiDescriptor>>>}
 */
export const PRESET_APIS = Object.freeze({
    openai: Object.freeze({
        dirName: 'OpenAI Settings',
        extension: '.json',
        selectId: 'settings_preset_openai',
        labelKey: 'api.openai',
    }),
    textgenerationwebui: Object.freeze({
        dirName: 'TextGen Settings',
        extension: '.json',
        selectId: 'settings_preset_textgenerationwebui',
        labelKey: 'api.textgenerationwebui',
    }),
    kobold: Object.freeze({
        dirName: 'KoboldAI Settings',
        extension: '.json',
        selectId: 'settings_preset',
        labelKey: 'api.kobold',
    }),
    novel: Object.freeze({
        dirName: 'NovelAI Settings',
        extension: '.json',
        selectId: 'settings_preset_novel',
        labelKey: 'api.novel',
    }),
    context: Object.freeze({
        dirName: 'context',
        extension: '.json',
        selectId: 'context_presets',
        labelKey: 'api.context',
    }),
    instruct: Object.freeze({
        dirName: 'instruct',
        extension: '.json',
        selectId: 'instruct_presets',
        labelKey: 'api.instruct',
    }),
    sysprompt: Object.freeze({
        dirName: 'sysprompt',
        extension: '.json',
        selectId: 'sysprompt_select',
        labelKey: 'api.sysprompt',
    }),
    reasoning: Object.freeze({
        dirName: 'reasoning',
        extension: '.json',
        selectId: 'reasoning_select',
        labelKey: 'api.reasoning',
    }),
});

/** API ids of every supported preset manager (canonical spelling only). @type {ReadonlyArray<string>} */
export const SUPPORTED_API_IDS = Object.freeze(Object.keys(PRESET_APIS));

/** Selector used by SillyTavern 1.18+ to mark preset-manager selects. @type {string} */
export const PRESET_SELECT_SELECTOR = 'select[data-preset-manager-for]';

/** Maximum number of concurrent host filesystem metadata requests. @type {number} */
export const FS_CONCURRENCY = 4;

/** Per-request timeout (ms) for host filesystem metadata calls. @type {number} */
export const FS_TIMEOUT_MS = 4000;

/** Upper bound of tracked preset-stat entries per API (oldest least-recently-used are pruned). @type {number} */
export const MAX_STATS_PER_API = 600;

/** Version of the persisted extension **stats** payload. @type {number} */
export const STORAGE_VERSION = 1;

/** Version of the persisted extension **settings** payload (field + direction + grouping shape). @type {number} */
export const SETTINGS_VERSION = 2;

/** Extension version, mirrored in `manifest.json`. @type {string} */
export const EXTENSION_VERSION = '1.2.0';

/**
 * Preset grouping modes (v1.2.0 native `<optgroup>` series grouping).
 * - `smart`: version-suffix parsing **plus** a conservative "prefix before the
 *   first digit" heuristic (auto groups need at least 2 members).
 * - `strict`: version-suffix parsing only.
 * @type {Readonly<{SMART: 'smart', STRICT: 'strict'}>}
 */
export const GROUPING_MODES = Object.freeze({
    SMART: 'smart',
    STRICT: 'strict',
});

/** UI display order of the grouping modes. @type {ReadonlyArray<string>} */
export const GROUPING_MODE_ORDER = Object.freeze([
    GROUPING_MODES.SMART,
    GROUPING_MODES.STRICT,
]);

/** Default grouping mode. @type {string} */
export const DEFAULT_GROUPING_MODE = GROUPING_MODES.SMART;

/** Override sentinel that keeps a preset out of every group (flat option). @type {string} */
export const GROUPING_UNGROUPED = '__ungrouped__';

/** Minimum number of members required for an automatic (non-manual) group. @type {number} */
export const MIN_AUTO_GROUP_SIZE = 2;

/** Minimum display length of the "prefix before first digit" smart heuristic. @type {number} */
export const MIN_PREFIX_GROUP_LENGTH = 2;

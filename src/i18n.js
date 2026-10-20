/**
 * Minimal, dependency-free i18n for the `preset-sorter` extension.
 *
 * Locale detection is deliberately independent from SillyTavern's own i18n:
 * the extension ships a small built-in zh/en dictionary and only needs to know
 * whether the UI language is Chinese. Any `zh*` browser locale maps to `zh`,
 * every other locale maps to `en`.
 *
 * Pure module: no DOM / SillyTavern / Tauri imports. Browser APIs are probed
 * defensively so the module imports under Node.js.
 *
 * @module preset-sorter/i18n
 */

import { SORT_DIRECTIONS, SORT_FIELDS, SORT_MODES } from './constants.js';

/** Supported locales. @type {Readonly<{ZH: 'zh', EN: 'en'}>} */
export const LOCALES = Object.freeze({ ZH: 'zh', EN: 'en' });

/** @type {Record<string, string>} */
const ZH = {
    // Sort control
    'sort.label': '排序',
    'sort.title': '预设排序方式（仅改变下拉框显示顺序，不修改预设内容）',
    'mode.default': '默认顺序',
    'mode.import-asc': '导入时间：早 → 晚',
    'mode.import-desc': '导入时间：晚 → 早',
    'mode.usage-desc': '使用次数：多 → 少',
    'mode.recent-desc': '最近使用：近 → 远',
    'mode.usage-asc': '使用次数：少 → 多',
    'mode.recent-asc': '最近使用：远 → 近',
    'mode.unknown': '未知排序方式：{mode}',

    // Sort field + direction (v1.1.0 independent controls)
    'field.label': '排序依据',
    'field.default': '默认排序',
    'field.import': '导入时间',
    'field.usage': '使用次数',
    'field.recent': '最近使用',
    'field.unknown': '未知排序依据：{field}',
    'direction.label': '倒序',
    'direction.asc': '正序',
    'direction.desc': '倒序',
    'direction.title': '勾选为倒序，取消为正序',
    'direction.disabledHint': '选择「默认排序」时不生效',
    'direction.hint': '倒序：新→旧 / 多→少 / 近→远；取消则正序',
    'control.title': '预设排序方式（仅改变下拉框显示顺序，不修改预设内容）',
    'control.groupLabel': '预设排序',
    'mode.effective': '{field} · {direction}',

    // Settings panel
    'panel.title': '预设排序器',
    'panel.enabled': '启用预设排序',
    'panel.enabledHint': '关闭后恢复 SillyTavern 的原始顺序',
    'panel.defaultMode': '默认排序方式',
    'panel.defaultModeHint': '未被单独设置的预设管理器都使用此方式',
    'panel.defaultField': '默认排序依据',
    'panel.defaultFieldHint': '未被单独设置的预设管理器都使用此排序依据',
    'panel.effectiveHint': '当前：{mode}',
    'panel.applyAll': '应用到所有预设管理器',
    'panel.applyAllHint': '统一使用默认排序方式；关闭后各管理器可分别设置',
    'panel.refresh': '刷新导入时间',
    'panel.refreshing': '正在读取导入时间…',
    'panel.refreshHint': '从 Tauri 主机读取预设文件的创建/修改时间；浏览器环境回退到首次出现时间',
    'panel.resetUsage': '重置使用统计',
    'panel.resetUsageHint': '清零使用次数与最近使用时间，保留导入时间',
    'panel.diagnostics': '诊断信息',
    'panel.diagFs': '文件系统时间',
    'panel.diagDataRoot': '数据目录',
    'panel.diagHandle': '当前用户',
    'panel.diagKnown': '已跟踪预设',
    'panel.diagUsed': '使用记录',
    'panel.diagImportTimes': '导入时间',
    'panel.diagAvailable': '可用',
    'panel.diagUnavailable': '不可用（仅使用首次出现时间）',
    'panel.diagUnknown': '未知',

    // Import-time sources
    'importSource.birthtime': '文件创建时间',
    'importSource.mtime': '文件修改时间',
    'importSource.first-seen': '首次出现',
    'importSource.unknown': '未知来源',
    'importSource.none': '无',

    // Option tooltips
    'tooltip.importTime': '导入时间：{time}（{source}）',
    'tooltip.firstSeen': '首次出现：{time}',
    'tooltip.usage': '使用次数：{count}',
    'tooltip.lastUsed': '最近使用：{time}',
    'tooltip.never': '从未',
    'tooltip.noStats': '暂无使用记录',
    'time.unknown': '未知时间',

    // Toasts / feedback
    'toast.refreshed': '已刷新 {count} 个预设的导入时间',
    'toast.refreshUnavailable': '无法读取主机文件时间，已回退到首次出现时间',
    'toast.resetUsage': '使用统计已重置',
    'toast.error': '操作失败：{message}',
    'toast.disabled': '预设排序已关闭，已恢复原始顺序',
    'confirm.resetUsage': '确定要重置所有预设的使用统计吗？',

    // API names
    'api.openai': 'OpenAI 预设',
    'api.textgenerationwebui': '文本生成预设',
    'api.kobold': 'KoboldAI 预设',
    'api.novel': 'NovelAI 预设',
    'api.context': '上下文模板',
    'api.instruct': '指令模板',
    'api.sysprompt': '系统提示词',
    'api.reasoning': '推理模板',
};

/** @type {Record<string, string>} */
const EN = {
    // Sort control
    'sort.label': 'Sort',
    'sort.title': 'Preset sort mode (only changes the dropdown display order; preset contents are never modified)',
    'mode.default': 'Default order',
    'mode.import-asc': 'Import time: oldest first',
    'mode.import-desc': 'Import time: newest first',
    'mode.usage-desc': 'Usage: most used first',
    'mode.recent-desc': 'Recently used first',
    'mode.usage-asc': 'Usage: least used first',
    'mode.recent-asc': 'Least recently used first',
    'mode.unknown': 'Unknown sort mode: {mode}',

    // Sort field + direction (v1.1.0 independent controls)
    'field.label': 'Sort by',
    'field.default': 'Default order',
    'field.import': 'Import time',
    'field.usage': 'Usage count',
    'field.recent': 'Recently used',
    'field.unknown': 'Unknown sort field: {field}',
    'direction.label': 'Descending',
    'direction.asc': 'Ascending',
    'direction.desc': 'Descending',
    'direction.title': 'Checked = descending, unchecked = ascending',
    'direction.disabledHint': 'Has no effect with "Default order"',
    'direction.hint': 'Descending: newest / most used / most recent first; unchecked = ascending',
    'control.title': 'Preset sort order (only changes the dropdown display order; preset contents are never modified)',
    'control.groupLabel': 'Preset sort',
    'mode.effective': '{field} · {direction}',

    // Settings panel
    'panel.title': 'Preset Sorter',
    'panel.enabled': 'Enable preset sorting',
    'panel.enabledHint': 'When disabled, the original SillyTavern order is restored',
    'panel.defaultMode': 'Default sort mode',
    'panel.defaultModeHint': 'Used by preset managers without an individual mode',
    'panel.defaultField': 'Default sort field',
    'panel.defaultFieldHint': 'Used by preset managers without an individual sort field',
    'panel.effectiveHint': 'Current: {mode}',
    'panel.applyAll': 'Apply to all preset managers',
    'panel.applyAllHint': 'Use the default mode everywhere; disable to set modes individually',
    'panel.refresh': 'Refresh import times',
    'panel.refreshing': 'Reading import times…',
    'panel.refreshHint': 'Reads preset file creation/modification times from the Tauri host; falls back to first-seen times in a browser',
    'panel.resetUsage': 'Reset usage stats',
    'panel.resetUsageHint': 'Clears usage counts and last-used times; import times are kept',
    'panel.diagnostics': 'Diagnostics',
    'panel.diagFs': 'Filesystem timestamps',
    'panel.diagDataRoot': 'Data root',
    'panel.diagHandle': 'Current user',
    'panel.diagKnown': 'Tracked presets',
    'panel.diagUsed': 'Usage records',
    'panel.diagImportTimes': 'Import times',
    'panel.diagAvailable': 'available',
    'panel.diagUnavailable': 'unavailable (first-seen times only)',
    'panel.diagUnknown': 'unknown',

    // Import-time sources
    'importSource.birthtime': 'file creation time',
    'importSource.mtime': 'file modification time',
    'importSource.first-seen': 'first seen',
    'importSource.unknown': 'unknown source',
    'importSource.none': 'none',

    // Option tooltips
    'tooltip.importTime': 'Imported: {time} ({source})',
    'tooltip.firstSeen': 'First seen: {time}',
    'tooltip.usage': 'Used: {count}',
    'tooltip.lastUsed': 'Last used: {time}',
    'tooltip.never': 'never',
    'tooltip.noStats': 'No usage recorded',
    'time.unknown': 'Unknown time',

    // Toasts / feedback
    'toast.refreshed': 'Refreshed import times for {count} presets',
    'toast.refreshUnavailable': 'Host file timestamps are unavailable; using first-seen times',
    'toast.resetUsage': 'Usage stats reset',
    'toast.error': 'Operation failed: {message}',
    'toast.disabled': 'Preset sorting disabled; original order restored',
    'confirm.resetUsage': 'Reset usage stats for all presets?',

    // API names
    'api.openai': 'OpenAI presets',
    'api.textgenerationwebui': 'Text completion presets',
    'api.kobold': 'KoboldAI presets',
    'api.novel': 'NovelAI presets',
    'api.context': 'Context templates',
    'api.instruct': 'Instruct templates',
    'api.sysprompt': 'System prompts',
    'api.reasoning': 'Reasoning templates',
};

/**
 * Built-in dictionaries. Exposed for tests / tooling; treat as read-only.
 * @type {Readonly<Record<'zh'|'en', Readonly<Record<string, string>>>>}
 */
export const DICTIONARIES = Object.freeze({
    [LOCALES.ZH]: Object.freeze(ZH),
    [LOCALES.EN]: Object.freeze(EN),
});

/** i18n keys of the legacy combined sort modes. @type {Readonly<Record<string, string>>} */
const MODE_LABEL_KEYS = Object.freeze({
    [SORT_MODES.DEFAULT]: 'mode.default',
    [SORT_MODES.IMPORT_ASC]: 'mode.import-asc',
    [SORT_MODES.IMPORT_DESC]: 'mode.import-desc',
    [SORT_MODES.USAGE_ASC]: 'mode.usage-asc',
    [SORT_MODES.USAGE_DESC]: 'mode.usage-desc',
    [SORT_MODES.RECENT_ASC]: 'mode.recent-asc',
    [SORT_MODES.RECENT_DESC]: 'mode.recent-desc',
});

/** i18n keys of the sort fields. @type {Readonly<Record<string, string>>} */
const FIELD_LABEL_KEYS = Object.freeze({
    [SORT_FIELDS.DEFAULT]: 'field.default',
    [SORT_FIELDS.IMPORT]: 'field.import',
    [SORT_FIELDS.USAGE]: 'field.usage',
    [SORT_FIELDS.RECENT]: 'field.recent',
});

/** i18n keys of the sort directions. @type {Readonly<Record<string, string>>} */
const DIRECTION_LABEL_KEYS = Object.freeze({
    [SORT_DIRECTIONS.ASC]: 'direction.asc',
    [SORT_DIRECTIONS.DESC]: 'direction.desc',
});

/** `Intl.DateTimeFormat` locale tags for the supported locales. */
const INTL_LOCALE_TAGS = Object.freeze({ [LOCALES.ZH]: 'zh-CN', [LOCALES.EN]: 'en-US' });

/**
 * Detects the preferred locale from the browser environment.
 * Any locale whose primary language tag is `zh` maps to Chinese, everything
 * else (including an unknown/absent environment) maps to English.
 *
 * @returns {'zh'|'en'} Detected locale.
 */
export function detectLocale() {
    try {
        if (typeof navigator !== 'undefined' && navigator) {
            const candidates = [];
            if (typeof navigator.language === 'string' && navigator.language !== '') {
                candidates.push(navigator.language);
            }
            if (Array.isArray(navigator.languages)) {
                candidates.push(...navigator.languages);
            }
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && /^zh\b/i.test(candidate)) {
                    return LOCALES.ZH;
                }
                if (typeof candidate === 'string' && candidate !== '') {
                    return LOCALES.EN;
                }
            }
        }
    } catch {
        // Ignore unavailable/broken `navigator`; fall back to English below.
    }
    return LOCALES.EN;
}

/** @type {'zh'|'en'} */
let activeLocale = detectLocale();

/** @type {Intl.DateTimeFormat|null} */
let cachedFormatter = null;

/** @type {'zh'|'en'|''} */
let cachedFormatterLocale = '';

/**
 * Normalises an arbitrary locale string to a supported locale.
 *
 * @param {unknown} locale Raw locale (`zh`, `zh-CN`, `en-US`, ...).
 * @returns {'zh'|'en'} Supported locale.
 */
function normalizeLocale(locale) {
    return typeof locale === 'string' && /^zh\b/i.test(locale.trim()) ? LOCALES.ZH : LOCALES.EN;
}

/**
 * Sets the active locale.
 *
 * @param {'zh'|'en'|'auto'|string|null|undefined} [locale] Locale to use;
 * `undefined`, `null`, `''` or `'auto'` re-detects it from the environment.
 * @returns {'zh'|'en'} The locale that is now active.
 */
export function setLocale(locale) {
    if (locale === undefined || locale === null || locale === '' || locale === 'auto') {
        activeLocale = detectLocale();
    } else {
        activeLocale = normalizeLocale(locale);
    }
    cachedFormatter = null;
    cachedFormatterLocale = '';
    return activeLocale;
}

/**
 * @returns {'zh'|'en'} The currently active locale.
 */
export function getLocale() {
    return activeLocale;
}

/**
 * Translates an i18n key.
 *
 * Falls back to the English dictionary and finally to the key itself when a
 * translation is missing. Placeholders use `{name}` syntax; values that are
 * `undefined`/`null` are left untouched.
 *
 * @param {string} key i18n key, e.g. `mode.default`.
 * @param {Record<string, string|number>} [vars] Placeholder values.
 * @returns {string} Translated (and interpolated) text.
 */
export function t(key, vars) {
    const dictionary = DICTIONARIES[activeLocale] ?? DICTIONARIES[LOCALES.EN];
    let template = dictionary[key];
    if (template === undefined) {
        template = DICTIONARIES[LOCALES.EN][key];
    }
    if (template === undefined) {
        return key;
    }
    if (vars && Object.keys(vars).length > 0) {
        template = template.replace(/\{(\w+)\}/g, (match, name) => {
            const value = vars[name];
            return value === undefined || value === null ? match : String(value);
        });
    }
    return template;
}

/**
 * Returns a cached `Intl.DateTimeFormat` for the active locale, or `null` when
 * `Intl` is not usable.
 *
 * @returns {Intl.DateTimeFormat|null} Date formatter.
 */
function getDateTimeFormatter() {
    if (cachedFormatter !== null && cachedFormatterLocale === activeLocale) {
        return cachedFormatter;
    }
    cachedFormatterLocale = activeLocale;
    cachedFormatter = null;
    try {
        if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
            cachedFormatter = new Intl.DateTimeFormat(INTL_LOCALE_TAGS[activeLocale] ?? 'en-US', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
        }
    } catch {
        cachedFormatter = null;
    }
    return cachedFormatter;
}

/**
 * Formats a timestamp (ms since epoch) for display in the active locale.
 *
 * @param {number|null|undefined} ms Timestamp in ms since epoch.
 * @returns {string} Localized timestamp, or the localized "unknown time" text.
 */
export function formatTimestamp(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        return t('time.unknown');
    }
    const date = new Date(ms);
    const formatter = getDateTimeFormatter();
    if (formatter) {
        try {
            return formatter.format(date);
        } catch {
            // Fall through to the manual formatting below.
        }
    }
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Returns the localized label of a legacy combined sort mode.
 *
 * @param {string} mode Sort mode id.
 * @returns {string} Localized label (or a descriptive fallback for unknown modes).
 */
export function formatModeLabel(mode) {
    const key = MODE_LABEL_KEYS[mode];
    return key ? t(key) : t('mode.unknown', { mode: String(mode) });
}

/**
 * Returns the localized label of a v1.1.0 sort field.
 *
 * @param {string} field Sort field (`default` | `import` | `usage` | `recent`).
 * @returns {string} Localized field label.
 */
export function formatFieldLabel(field) {
    const key = FIELD_LABEL_KEYS[field];
    return key ? t(key) : t('field.unknown', { field: String(field) });
}

/**
 * Returns the localized label of a sort direction.
 *
 * @param {string} direction Sort direction (`asc` | `desc`).
 * @returns {string} Localized direction label (falls back to the descending label).
 */
export function formatDirectionLabel(direction) {
    const key = DIRECTION_LABEL_KEYS[direction];
    return key ? t(key) : t('direction.desc');
}

/**
 * Returns a compact localized "field · direction" description.
 *
 * @param {{field: string, direction: string}} spec Sort spec.
 * @returns {string} Localized description, e.g. `导入时间 · 倒序`.
 */
export function formatSortSpec(spec) {
    const field = spec && spec.field ? spec.field : SORT_FIELDS.DEFAULT;
    const direction = spec && spec.direction ? spec.direction : SORT_DIRECTIONS.DESC;
    return t('mode.effective', {
        field: formatFieldLabel(field),
        direction: formatDirectionLabel(direction),
    });
}

/**
 * Returns the localized human-readable label of an import-time source tag.
 *
 * @param {string|null|undefined} source Source tag (`birthtime`, `mtime`, `first-seen`, ...).
 * @returns {string} Localized source label.
 */
export function formatImportSourceLabel(source) {
    if (!source) {
        return t('importSource.none');
    }
    const key = `importSource.${source}`;
    const translated = t(key);
    return translated === key ? t('importSource.unknown') : translated;
}

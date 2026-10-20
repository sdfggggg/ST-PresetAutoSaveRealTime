/**
 * Clean-room preset series grouping engine (v1.2.0, grouping-quality pass).
 *
 * This module is a **behavioral reimplementation** of the series/version
 * detection idea used by ST-PresetAutoSaveRealTime (AGPL-3.0). No code, regex
 * arrays, comments or markup were copied from that project; only the observable
 * behavior ("strip version/copy suffixes, cluster presets by series name") is
 * reproduced here, with our own conservative patterns. See README §分组/致谢.
 *
 * Safe by design: this module is pure (no DOM, no SillyTavern imports) and never
 * drops information — it only *suggests* groups; manual overrides always win.
 *
 * @module preset-sorter/grouping-engine
 */

import {
    DEFAULT_GROUPING_MODE,
    GROUPING_MODES,
    GROUPING_UNGROUPED,
    MIN_AUTO_GROUP_SIZE,
    MIN_PREFIX_GROUP_LENGTH,
} from './constants.js';

/** Maximum number of cached `parsePresetName` results. @type {number} */
const MAX_PARSE_CACHE = 1000;

/**
 * @typedef {object} ParsedPresetName
 * @property {string} original Original display name.
 * @property {string} duplicate Name after stripping copy/import suffixes.
 * @property {string} series Detected series display name ('' when none).
 * @property {string} version Detected version token ('' when none).
 * @property {string} kind Detection kind.
 * @property {boolean} copyMarker Whether a copy/index suffix was stripped.
 */

/**
 * @typedef {object} SeriesInfo
 * @property {string} original Original display name.
 * @property {string} series Detected/overridden series display name ('' when none).
 * @property {string} version Version token ('' when none/manual).
 * @property {string} kind Detection kind.
 * @property {boolean} manual Whether a manual override produced this result.
 * @property {boolean} ungrouped Whether `__ungrouped__` excluded the preset.
 * @property {boolean} heuristic Whether the smart prefix heuristic produced the series.
 */

/**
 * @typedef {object} PresetItem
 * @property {string} name Preset logical name.
 * @property {string|number} value Option value.
 */

/**
 * @typedef {object} GroupEntity
 * @property {'group'} type Entity discriminator.
 * @property {string} key Stable internal group key.
 * @property {string} label Display label including member count, e.g. `Virgo_Preset (3)`.
 * @property {string} baseLabel Series display name without the count suffix.
 * @property {PresetItem[]} members Group members (input order).
 * @property {boolean} manual Whether the group was created/confirmed manually.
 */

/**
 * @typedef {object} OptionEntity
 * @property {'option'} type Entity discriminator.
 * @property {PresetItem} item Preset item.
 * @property {string} name Preset name.
 * @property {string|number} value Option value.
 */

/**
 * @typedef {GroupEntity|OptionEntity} GroupedEntity
 */

/** Characters that may separate a series name from its version token. */
const BOUNDARY_CHARS = '\\s_\\-—–‒―−·・.,;:!?()\\[\\]{}【】<>《》';

/** Separator/boundary matcher used at the start of version-suffix patterns. */
const BOUNDARY_PREFIX = `(?:^|[${BOUNDARY_CHARS}]+)`;

/** Matches a numeric version token, optionally followed by attached word suffixes. */
const NUMBER_TOKEN = String.raw`\d+(?:[._]\d+)*(?:\s*[A-Za-z\u4e00-\u9fff]+)?(?:[-_][A-Za-z\u4e00-\u9fff]+)*`;

/** Matches an explicit V/v version token. */
const VERSION_TOKEN = String.raw`(?:[vV]|ver\.?)\s*\d+(?:[._]\d+)*(?:\s*[A-Za-z\u4e00-\u9fff]+)?(?:[-_][A-Za-z\u4e00-\u9fff]+)*`;

/**
 * Our own conservative trailing-version patterns (capture group 1 = version token).
 * Order matters: more specific patterns first.
 * @type {ReadonlyArray<{kind: string, re: RegExp}>}
 */
const VERSION_SUFFIX_PATTERNS = Object.freeze([
    { kind: 'v', re: new RegExp(`${BOUNDARY_PREFIX}(${VERSION_TOKEN})\\s*$`) },
    { kind: 'date', re: new RegExp(`${BOUNDARY_PREFIX}(\\d{4}[-_.年]\\d{1,2}[-_.月]\\d{1,2}日?)\\s*$`) },
    { kind: 'phase', re: /(?:^|[\s_\-—–‒―−·・.,;:!?()[\]{}【】<>《》]+)((?:alpha|beta|rc|final|stable|fix|test)(?:\s*\d+)?|(?:正式版?|测试版?|修正版?|修复版?|终焉版))\s*$/i },
    { kind: 'chinese', re: new RegExp(`${BOUNDARY_PREFIX}(第?[一二三四五六七八九十百零〇两]+(?:版|期|代))\\s*$`) },
    { kind: 'roman', re: new RegExp(`${BOUNDARY_PREFIX}([IVX]{2,6})\\s*$`) },
    { kind: 'number', re: new RegExp(`${BOUNDARY_PREFIX}(${NUMBER_TOKEN})\\s*$`) },
]);

/** Generic prefixes the smart heuristic must never turn into a group. @type {ReadonlySet<string>} */
const GENERIC_PREFIX_KEYS = Object.freeze(new Set([
    'preset', 'presets', 'template', 'templates', 'untitled', 'new', 'default', 'test', 'copy',
    '预设', '模板', '默认', '新建', '测试', '副本', '拷贝',
]));

/** @type {Map<string, ParsedPresetName>} */
const parseCache = new Map();

/**
 * Converts fullwidth ASCII / ideographic spaces to halfwidth and trims.
 *
 * @param {unknown} value Raw text.
 * @returns {string} Normalised display text.
 */
export function normalizeGroupText(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    let result = '';
    for (const character of text) {
        const code = character.codePointAt(0);
        if (code === 0x3000) {
            result += ' ';
        } else if (code >= 0xff01 && code <= 0xff5e) {
            result += String.fromCodePoint(code - 0xfee0);
        } else {
            result += character;
        }
    }
    return result.trim();
}

/**
 * Builds a stable comparison key for a series display name: case-insensitive and
 * whitespace/separator-insensitive.
 *
 * @param {unknown} value Series display name.
 * @returns {string} Normalised series key.
 */
export function normalizeSeriesKey(value) {
    const text = normalizeGroupText(value).toLowerCase();
    const compact = text.replace(/[\s_\-—–‒―−·・]+/g, '');
    return compact || text;
}

/**
 * Strips copy/index/import stamps from the end (and `Copy of` from the start) of
 * a preset name.
 *
 * Handles: trailing `(1)`/`（2）`, `Copy of …`, `- 副本/拷贝/备份/复制`,
 * `(旧/新/备份/副本)` and SillyTavern import date stamps (`_2026-05-01`,
 * `_20260501`).
 *
 * @param {string} name Preset display name.
 * @returns {{name: string, duplicate: boolean, stamp: boolean}} Stripped name and flags.
 */
export function stripCopySuffixes(name) {
    let text = normalizeGroupText(name);
    let duplicate = false;
    let stamp = false;
    for (let pass = 0; pass < 6; pass += 1) {
        const before = text;
        const copyOf = /^copy\s+of\s+/i.exec(text);
        if (copyOf) {
            text = text.slice(copyOf[0].length).trim();
            duplicate = true;
        }
        const indexSuffix = /\s*[（(]\s*\d{1,3}\s*[)）]\s*$/.exec(text);
        if (indexSuffix) {
            text = text.slice(0, indexSuffix.index).trimEnd();
            duplicate = true;
        }
        const chineseCopy = /\s*[-_—–]?\s*(?:副本|拷贝|备份|复制)\s*\d{0,3}\s*$/.exec(text);
        if (chineseCopy) {
            text = text.slice(0, chineseCopy.index).trimEnd();
            duplicate = true;
        }
        const oldNewSuffix = /\s*[（(]\s*(?:旧|新|备份|副本)\s*[)）]\s*$/.exec(text);
        if (oldNewSuffix) {
            text = text.slice(0, oldNewSuffix.index).trimEnd();
            duplicate = true;
        }
        // SillyTavern import stamps are attached with an underscore, e.g.
        // "Name_2026-05-01" / "Name_20260501" (a space-separated date is much
        // more likely a real version/date suffix and is left to the parser).
        const dateStamp = /_\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\s*$/.exec(text);
        if (dateStamp) {
            text = text.slice(0, dateStamp.index).trimEnd();
            stamp = true;
        }
        const compactStamp = /_(?:19|20)\d{6}\s*$/.exec(text);
        if (compactStamp) {
            text = text.slice(0, compactStamp.index).trimEnd();
            stamp = true;
        }
        if (text === before) {
            break;
        }
    }
    return { name: text.trim(), duplicate, stamp };
}

/**
 * Cleans a candidate series string: trims and drops dangling separators.
 *
 * @param {string} value Candidate series.
 * @returns {string} Cleaned series display name.
 */
function cleanSeries(value) {
    let text = String(value ?? '').trim();
    text = text.replace(/[\s_\-—–‒―−·・.,;:!?]+$/g, '').trim();
    text = text.replace(/^[\s_\-—–‒―−·・.,;:!?]+/g, '').trim();
    text = text.replace(/\s+/g, ' ');
    return text;
}

/**
 * Cleans a "prefix before first digit" candidate: trims, drops trailing
 * separators and a trailing standalone version marker letter (`V`/`v`) that was
 * followed by the digit, e.g. `teraV`→`tera`, `Genesis_Presets_V`→
 * `Genesis_Presets`, `XHM-v`→`XHM`.
 *
 * @param {string} value Raw prefix.
 * @returns {string} Cleaned prefix ('' when unusable).
 */
function cleanPrefixDisplay(value) {
    let prefix = String(value ?? '').trim();
    prefix = prefix.replace(/[\s_\-—–‒―−·・.,;:!?]+$/g, '').trim();
    if (/[vV]$/.test(prefix)) {
        const withoutMarker = prefix.slice(0, -1).replace(/[\s_\-—–‒―−·・.,;:!?]+$/g, '').trim();
        if ([...withoutMarker].length >= MIN_PREFIX_GROUP_LENGTH) {
            prefix = withoutMarker;
        }
    }
    prefix = prefix.replace(/[\s_\-—–‒―−·・.,;:!?]+$/g, '').trim();
    return prefix;
}

/**
 * Natural version comparison: numeric segments first, then trailing letters,
 * then locale fallback. Empty/unknown versions rank **last** (stable sort keeps
 * their relative order).
 *
 * @param {string} a First version token.
 * @param {string} b Second version token.
 * @returns {number} Negative when `a` sorts before `b`, positive after, `0` equal.
 */
export function compareVersions(a, b) {
    const versionA = String(a ?? '').trim();
    const versionB = String(b ?? '').trim();
    if (versionA === '' && versionB === '') {
        return 0;
    }
    if (versionA === '') {
        return 1; // unknown versions last
    }
    if (versionB === '') {
        return -1;
    }
    const numbersA = versionA.match(/\d+/g)?.map(Number) ?? [];
    const numbersB = versionB.match(/\d+/g)?.map(Number) ?? [];
    const length = Math.max(numbersA.length, numbersB.length);
    for (let index = 0; index < length; index += 1) {
        const left = numbersA[index] ?? 0;
        const right = numbersB[index] ?? 0;
        if (left !== right) {
            return left - right;
        }
    }
    const lettersA = (versionA.match(/[^\d]+/g) ?? []).join('').toLowerCase();
    const lettersB = (versionB.match(/[^\d]+/g) ?? []).join('').toLowerCase();
    if (lettersA !== lettersB) {
        return lettersA.localeCompare(lettersB);
    }
    return 0;
}

/**
 * Conservative "prefix before the first digit" heuristic used by grouping mode
 * `smart`. The caller still requires a cluster of >= 2 members.
 *
 * @param {string} name Preset display name.
 * @returns {string} Candidate series prefix, or `''`.
 */
export function smartPrefixSeries(name) {
    const base = stripCopySuffixes(normalizeGroupText(name)).name;
    const digitIndex = base.search(/\d/);
    if (digitIndex < MIN_PREFIX_GROUP_LENGTH) {
        return '';
    }
    const prefix = cleanPrefixDisplay(base.slice(0, digitIndex));
    if ([...prefix].length < MIN_PREFIX_GROUP_LENGTH) {
        return '';
    }
    if (/^[\p{P}\p{S}\s]+$/u.test(prefix)) {
        return '';
    }
    const key = normalizeSeriesKey(prefix);
    if (!key || GENERIC_PREFIX_KEYS.has(key)) {
        return '';
    }
    return prefix;
}

/**
 * Parses one preset name into series + version using our own conservative rules.
 * Results are cached by name.
 *
 * @param {string} name Preset display name.
 * @returns {ParsedPresetName} Parse result.
 */
export function parsePresetName(name) {
    const original = typeof name === 'string' ? name : String(name ?? '');
    const cached = parseCache.get(original);
    if (cached) {
        return cached;
    }
    const result = computeParsedPresetName(original);
    if (parseCache.size >= MAX_PARSE_CACHE) {
        parseCache.clear();
    }
    parseCache.set(original, result);
    return result;
}

/**
 * Finds the best explicit version marker (`V1.5`, `v3.3`, `ver2`) inside a name
 * (series prefix before it). Separated markers (`Name_V1.5`, `XHM-v3.3`) are
 * preferred over attached markers (`teraV4`); markers that are part of a numeric
 * token (`1.71v-T`) are ignored. When a marker is followed by a descriptor, the
 * explicit marker version wins over numbers inside the descriptor (`claude3.5`).
 *
 * @param {string} base Normalised, copy-stripped name.
 * @returns {{series: string, version: string, kind: string}|null} Marker candidate.
 */
function findVersionMarkerCandidate(base) {
    const markerPattern = /([vV])(\d+(?:[._]\d+)*)/g;
    /** @type {Array<{tokenStart: number, version: string, separated: boolean}>} */
    const markers = [];
    let match;
    while ((match = markerPattern.exec(base)) !== null) {
        const tokenStart = match.index;
        if (tokenStart <= 0) {
            continue;
        }
        const previous = base[tokenStart - 1] ?? '';
        // Inside a numeric token like "1.71v-T": not a series marker.
        if (/[0-9.]/.test(previous)) {
            continue;
        }
        markers.push({
            tokenStart,
            version: `V${match[2]}`,
            separated: !/[A-Za-z\u4e00-\u9fff]/.test(previous),
        });
    }
    if (markers.length === 0) {
        return null;
    }
    const separatedMarkers = markers.filter(marker => marker.separated);
    const chosen = separatedMarkers.length > 0
        ? separatedMarkers.sort((a, b) => a.tokenStart - b.tokenStart)[0]
        : markers.sort((a, b) => a.tokenStart - b.tokenStart)[0];
    const series = cleanSeries(base.slice(0, chosen.tokenStart));
    if (!series) {
        return null;
    }
    if (chosen.separated) {
        // "Genesis_Presets_V1.5_for_claude3.5" -> series Genesis_Presets,
        // version V1.5 (the descriptor is ignored).
        return { series, version: chosen.version, kind: 'v' };
    }
    // Attached marker: "gal_adaption_of_teraV4andMO_1.9.3_by_sugar_water" or
    // "神秘V1之书". If a descriptor follows, prefer an explicit version inside
    // it (the first numeric token after the marker), otherwise keep the marker
    // version.
    const remainder = base.slice(chosen.tokenStart + 1 + chosen.version.length - 1);
    if (/^[\u4e00-\u9fff]+$/.test(remainder)) {
        // Embedded marker inside a CJK name: "神秘V1之书" -> "神秘之书".
        return { series: cleanSeries(`${base.slice(0, chosen.tokenStart)}${remainder}`), version: chosen.version, kind: 'embedded' };
    }
    const descriptorVersion = /(?:^|[_\-\s])(\d+(?:[._]\d+)*(?:[A-Za-z\u4e00-\u9fff]+)?)/.exec(remainder);
    if (descriptorVersion) {
        return { series, version: descriptorVersion[1], kind: 'v' };
    }
    return { series, version: chosen.version, kind: 'v' };
}

/**
 * Handles names that *start* with a version marker, e.g. `V0.1`, `V0.2a`,
 * `V0.a11`, `V3.0.0_GAL_...`. Only pure numeric V-major families are grouped:
 * `V0.<n>` -> series `V0`; a descriptor suffix (`V3.0.0_GAL…`) or a
 * letter-first minor (`V0.a11`) stays a single preset.
 *
 * @param {string} base Normalised, copy-stripped name.
 * @returns {{series: string, version: string, kind: string}|null} Leading-version candidate.
 */
function parseVersionLeadingName(base) {
    const match = /^([vV])(\d+)((?:[._]\d+)*)(.*)$/.exec(base);
    if (!match) {
        return null;
    }
    const [, marker, major, dotted, rest] = match;
    if (dotted === '' && rest === '') {
        // "V0" alone: not a version reference, keep as a single preset.
        return null;
    }
    // Only `V0.1`, `V0.2a` style names form families; a descriptor suffix
    // ("V3.0.0_GAL_…") or a letter-first minor ("V0.a11") stays a single preset.
    const isSingleLetterMinor = /^[A-Za-z]$/.test(rest);
    if (!(rest === '' || isSingleLetterMinor)) {
        return null;
    }
    const version = `${major}${dotted}${rest}`;
    return { series: `${marker.toUpperCase()}${major}`, version, kind: 'v-leading' };
}

/**
 * @param {string} original Preset display name.
 * @returns {ParsedPresetName} Parse result (uncached).
 */
function computeParsedPresetName(original) {
    const text = normalizeGroupText(original);
    const stripped = stripCopySuffixes(text);
    const base = stripped.name;
    const makeResult = (series, version, kind) => ({
        original,
        duplicate: base,
        series,
        version,
        kind,
        copyMarker: stripped.duplicate,
    });
    if (base === '') {
        return makeResult('', '', 'none');
    }

    // 1. Version-only leading names: "V0.1", "V0.2a".
    const leading = parseVersionLeadingName(base);
    if (leading) {
        return makeResult(leading.series, leading.version, leading.kind);
    }

    // 2. Explicit V/v markers (separated or attached) before generic patterns.
    const marker = findVersionMarkerCandidate(base);
    if (marker) {
        return makeResult(marker.series, marker.version, marker.kind);
    }

    // Version-leading names that did not form a clean family (e.g.
    // "V3.0.0_GAL_…", "V0.a11") stay single presets: never fall through to the
    // generic suffix parser, which would otherwise cut a meaningless series.
    if (/^[vV]\d/.test(base)) {
        return makeResult(base, '', 'none');
    }

    // 3. Digits attached directly after the series, followed by a descriptor:
    //    "ny预设1.6.3-sonnet用", "Lyean3.18.5_Nyarlathotep". Requires a dotted
    //    version so short names like "44beta1-Takoyaki…" stay unparsed.
    const attachedDescriptor = /^(.*?[A-Za-z\u4e00-\u9fff_])(\d+(?:[._]\d+)+)([-–—_].*)$/.exec(base);
    if (attachedDescriptor) {
        const series = cleanSeries(attachedDescriptor[1]);
        if (series) {
            return makeResult(series, attachedDescriptor[2], 'number');
        }
    }

    // 4. Digits attached directly after the series and ending the name:
    //    "Lyean3.08", "ny预设1.7.5", "Virgo_Preset_1.84fix". Runs before the
    //    generic suffix patterns so a later numeric fragment (`3.08` in
    //    "Lyean3.08") cannot win over the attached version.
    const attached = /^(.*?[A-Za-z\u4e00-\u9fff_])(\d+(?:[._]\d+)*(?:[A-Za-z\u4e00-\u9fff]+)?)$/.exec(base);
    if (attached) {
        const series = cleanSeries(attached[1]);
        if (series) {
            return makeResult(series, attached[2], 'number');
        }
    }

    // 5. Generic suffix patterns (more specific first).
    for (const pattern of VERSION_SUFFIX_PATTERNS) {
        const match = pattern.re.exec(base);
        if (!match || match.index <= 0 || !match[1]) {
            continue;
        }
        const offset = match[0].indexOf(match[1]);
        if (offset < 0) {
            continue;
        }
        const tokenStart = match.index + offset;
        if (tokenStart <= 0) {
            continue;
        }
        const series = cleanSeries(base.slice(0, tokenStart));
        if (series && series !== base) {
            return makeResult(series, match[1].trim().replace(/[-_]+$/, ''), pattern.kind);
        }
    }

    return makeResult(base, '', 'none');
}

/**
 * Resolves the grouping info of a preset name. Manual overrides win; the
 * `__ungrouped__` sentinel excludes the preset; mode `strict` disables the
 * prefix heuristic.
 *
 * @param {string} name Preset display name.
 * @param {Record<string, string>} [overrides] Manual overrides for this API (`presetName -> groupName | __ungrouped__`).
 * @param {string} [mode] Grouping mode (`smart` | `strict`).
 * @returns {SeriesInfo} Series information.
 */
export function getSeriesInfo(name, overrides = {}, mode = DEFAULT_GROUPING_MODE) {
    const original = typeof name === 'string' ? name : String(name ?? '');
    const manualValue = overrides && typeof overrides === 'object' && Object.hasOwn(overrides, original)
        ? overrides[original]
        : undefined;
    if (manualValue === GROUPING_UNGROUPED) {
        return {
            original,
            series: '',
            version: '',
            kind: 'manual-ungrouped',
            manual: true,
            ungrouped: true,
            heuristic: false,
        };
    }
    if (typeof manualValue === 'string' && manualValue.trim() !== '') {
        return {
            original,
            series: manualValue.trim(),
            version: '',
            kind: 'manual',
            manual: true,
            ungrouped: false,
            heuristic: false,
        };
    }

    const parsed = parsePresetName(original);
    if (parsed.version !== '') {
        return {
            original,
            series: parsed.series,
            version: parsed.version,
            kind: parsed.kind,
            manual: false,
            ungrouped: false,
            heuristic: false,
        };
    }
    if (normalizeGroupingMode(mode) === GROUPING_MODES.SMART) {
        const prefix = smartPrefixSeries(original);
        if (prefix) {
            return {
                original,
                series: prefix,
                version: '',
                kind: 'heuristic',
                manual: false,
                ungrouped: false,
                heuristic: true,
            };
        }
    }
    return {
        original,
        series: '',
        version: '',
        kind: 'none',
        manual: false,
        ungrouped: false,
        heuristic: false,
    };
}

/**
 * @param {unknown} mode Raw grouping mode.
 * @returns {string} Normalised grouping mode.
 */
export function normalizeGroupingMode(mode) {
    return mode === GROUPING_MODES.STRICT ? GROUPING_MODES.STRICT : GROUPING_MODES.SMART;
}

/**
 * Groups preset items into series entities for native `<optgroup>` rendering.
 *
 * In `smart` mode **two candidates** are evaluated per preset: the parsed
 * version-suffix series and the cleaned "prefix before the first digit" series.
 * The prefix candidate wins when its normalised cluster has at least
 * {@link MIN_AUTO_GROUP_SIZE} members (this merges real-world names such as
 * `ny预设1.7.5`, `Lyean3.08`, `Genesis_Presets_V1.5_…` and
 * `gal_adaption_of_teraV4…`); otherwise the parsed series is used. In `strict`
 * mode only version parsing is used.
 *
 * Auto groups require >= 2 members; manual groups (overrides) may contain a
 * single preset. Input order is preserved for the first appearance of each
 * group/single; the caller (sort engine) re-orders entities by the current sort
 * field/direction.
 *
 * @param {PresetItem[]} items Preset items in current upstream order.
 * @param {{apiId?: string, overrides?: Record<string, string>, mode?: string}} [options] Grouping options.
 * @returns {GroupedEntity[]} Ordered group/option entities.
 */
export function groupPresetItems(items, { overrides = {}, mode = DEFAULT_GROUPING_MODE } = {}) {
    const list = Array.isArray(items) ? items : [];
    const normalizedMode = normalizeGroupingMode(mode);
    const overrideMap = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};

    /**
     * @typedef {object} Candidate
     * @property {PresetItem} item Preset item.
     * @property {number} index Input index.
     * @property {boolean} manual Manual override.
     * @property {string} manualLabel Manual group label.
     * @property {string} parsedKey Parsed-series key.
     * @property {string} parsedLabel Parsed series display.
     * @property {string} prefixKey Prefix-candidate key.
     * @property {string} prefixLabel Prefix display.
     * @property {boolean} ungrouped Manual `__ungrouped__` marker.
     */

    /** @type {Candidate[]} */
    const candidates = list.map((item, index) => {
        const info = getSeriesInfo(item ? item.name : '', overrideMap, normalizedMode);
        const parsed = parsePresetName(item ? item.name : '');
        const parsedLabel = parsed.version !== '' ? cleanSeries(parsed.series) : '';
        const prefixLabel = normalizedMode === GROUPING_MODES.SMART
            ? smartPrefixSeries(item ? item.name : '')
            : '';
        return {
            item,
            index,
            manual: !!info.manual && !info.ungrouped,
            manualLabel: info.manual && !info.ungrouped ? info.series : '',
            parsedKey: parsedLabel ? normalizeSeriesKey(parsedLabel) : '',
            parsedLabel,
            prefixKey: prefixLabel ? normalizeSeriesKey(prefixLabel) : '',
            prefixLabel,
            ungrouped: !!info.ungrouped,
        };
    });

    /** @type {Map<string, number>} */
    const prefixClusterSizes = new Map();
    /** @type {Map<string, number>} */
    const parsedClusterSizes = new Map();
    for (const candidate of candidates) {
        if (candidate.manual || candidate.ungrouped) {
            continue;
        }
        if (candidate.prefixKey) {
            prefixClusterSizes.set(candidate.prefixKey, (prefixClusterSizes.get(candidate.prefixKey) ?? 0) + 1);
        }
        if (candidate.parsedKey) {
            parsedClusterSizes.set(candidate.parsedKey, (parsedClusterSizes.get(candidate.parsedKey) ?? 0) + 1);
        }
    }

    /**
     * @param {Candidate} candidate Candidate.
     * @returns {string} Chosen group key ('' = flat option).
     */
    function chooseGroupKey(candidate) {
        if (candidate.ungrouped) {
            return '';
        }
        if (candidate.manual && candidate.manualLabel) {
            return `manual:${normalizeSeriesKey(candidate.manualLabel)}`;
        }
        if (candidate.prefixKey && (prefixClusterSizes.get(candidate.prefixKey) ?? 0) >= MIN_AUTO_GROUP_SIZE) {
            return `prefix:${candidate.prefixKey}`;
        }
        if (candidate.parsedKey && (parsedClusterSizes.get(candidate.parsedKey) ?? 0) >= MIN_AUTO_GROUP_SIZE) {
            return `auto:${candidate.parsedKey}`;
        }
        return '';
    }

    /** @type {Map<string, GroupEntity & {firstIndex: number}>} */
    const groups = new Map();
    for (const candidate of candidates) {
        const key = chooseGroupKey(candidate);
        if (!key) {
            continue;
        }
        if (!groups.has(key)) {
            const label = key.startsWith('manual:')
                ? candidate.manualLabel
                : key.startsWith('prefix:')
                    ? candidate.prefixLabel
                    : candidate.parsedLabel;
            groups.set(key, {
                type: 'group',
                key,
                label,
                baseLabel: label,
                members: [],
                manual: key.startsWith('manual:'),
                firstIndex: candidate.index,
            });
        }
        groups.get(key).members.push(candidate.item);
    }

    /** @type {GroupedEntity[]} */
    const entities = [];
    const emittedGroups = new Set();
    for (const candidate of candidates) {
        const groupKey = chooseGroupKey(candidate);
        if (groupKey && groups.has(groupKey)) {
            if (emittedGroups.has(groupKey)) {
                continue;
            }
            emittedGroups.add(groupKey);
            const group = groups.get(groupKey);
            entities.push({
                type: 'group',
                key: group.key,
                label: `${group.baseLabel} (${group.members.length})`,
                baseLabel: group.baseLabel,
                members: group.members.slice(),
                manual: group.manual,
            });
        } else {
            entities.push({
                type: 'option',
                item: candidate.item,
                name: candidate.item ? candidate.item.name : '',
                value: candidate.item ? candidate.item.value : '',
            });
        }
    }
    return entities;
}

/**
 * Aggregates member stats into one synthetic stats object used to order the
 * group among the flat entities.
 *
 * @param {PresetItem[]} members Group members.
 * @param {(name: string) => (import('./stats-store.js').PresetStatsEntry|undefined)} getStats Stats accessor.
 * @param {string} field Sort field (`import` | `usage` | `recent`).
 * @param {string} direction Sort direction (`asc` | `desc`).
 * @returns {{importTime?: number|null, count?: number, lastUsedAt?: number|null}} Aggregated stats.
 */
export function aggregateGroupStats(members, getStats, field, direction) {
    const list = Array.isArray(members) ? members : [];
    const statsOf = name => {
        try {
            return typeof getStats === 'function' ? getStats(name) : undefined;
        } catch {
            return undefined;
        }
    };
    const statsEntries = list.map(member => statsOf(member ? member.name : ''));
    const ascending = direction !== 'desc';

    if (field === 'import') {
        const times = statsEntries
            .map(entry => (entry && typeof entry.importTime === 'number' && Number.isFinite(entry.importTime) ? entry.importTime : null))
            .filter(value => value !== null);
        if (times.length === 0) {
            return { importTime: null };
        }
        return { importTime: ascending ? Math.min(...times) : Math.max(...times) };
    }

    const readCount = entry => (entry && typeof entry.count === 'number' && Number.isFinite(entry.count) && entry.count > 0 ? entry.count : 0);
    const readLastUsed = entry => (entry && typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0);
    const counts = statsEntries.map(readCount);
    const lastUsed = statsEntries.map(readLastUsed);

    if (field === 'usage') {
        return {
            count: ascending ? Math.min(...counts) : Math.max(...counts),
            lastUsedAt: ascending ? Math.min(...lastUsed) : Math.max(...lastUsed),
        };
    }

    // field === 'recent' (or any other non-default): primary lastUsedAt, secondary count.
    return {
        lastUsedAt: ascending ? Math.min(...lastUsed) : Math.max(...lastUsed),
        count: ascending ? Math.min(...counts) : Math.max(...counts),
    };
}

/**
 * Clears the internal parse cache (used by tests/tooling after fixture changes).
 *
 * @returns {void}
 */
export function clearGroupingCaches() {
    parseCache.clear();
}

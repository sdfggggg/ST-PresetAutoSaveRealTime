/**
 * Mapping between SillyTavern preset "logical names" (the text of the preset
 * dropdown option) and the JSON files TauriTavern stores them in.
 *
 * TauriTavern derives preset file names from the logical preset name with the
 * same sanitization rules as upstream SillyTavern (`sanitize-filename@1.6.3`,
 * see `tt-domain/src/models/filename.rs`). Older TauriTavern builds used a
 * different (lossy) scheme, so both candidate file names are produced and the
 * host bridge probes them in order.
 *
 * Pure module: no DOM / SillyTavern / Tauri imports.
 *
 * @module preset-sorter/preset-file
 */

import { PRESET_APIS } from './constants.js';

/** Maximum length of a sanitized file stem, in UTF-8 bytes (matches Rust `MAX_SANITIZED_FILENAME_BYTES`). */
export const MAX_SANITIZED_FILENAME_BYTES = 255;

/** Characters removed entirely by SillyTavern's sanitizer. */
const ILLEGAL_FILENAME_CHARACTERS = new Set(['/', '?', '<', '>', '\\', ':', '*', '|', '"']);

/**
 * Whitespace characters that Rust's `str::trim` strips (Unicode `White_Space`
 * property). Note that this set contains U+0085 but not the BOM (U+FEFF), which
 * differs slightly from JavaScript's `String.prototype.trim()`.
 */
const RUST_WHITESPACE_CLASS =
    '\\t\\n\\u000b\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

/** Regex equivalent of Rust's `str::trim` (both ends, Unicode White_Space). */
const RUST_TRIM_REGEX = new RegExp(`^[${RUST_WHITESPACE_CLASS}]+|[${RUST_WHITESPACE_CLASS}]+$`, 'g');

/**
 * Maps a SillyTavern API id to the canonical id recognised by the extension.
 * `koboldhorde` shares the `kobold` preset manager (directory and select).
 *
 * @param {string} apiId Raw API id.
 * @returns {string} Canonical API id (`koboldhorde` -> `kobold`, otherwise unchanged).
 */
export function normalizePresetApiId(apiId) {
    if (apiId === 'koboldhorde') {
        return 'kobold';
    }
    return typeof apiId === 'string' ? apiId : '';
}

/**
 * True when the extension knows how to locate preset files for this API id.
 *
 * @param {string} apiId API id, e.g. `openai`, `textgenerationwebui`, `koboldhorde`.
 * @returns {boolean} Whether preset files for this API can be resolved.
 */
export function isSupportedPresetApi(apiId) {
    const canonical = normalizePresetApiId(apiId);
    return Object.hasOwn(PRESET_APIS, canonical);
}

/**
 * Directory name (under the user data root) that stores this API's preset files.
 *
 * @param {string} apiId API id.
 * @returns {string|null} Directory name, or `null` for an unsupported API id.
 */
export function presetDirName(apiId) {
    const descriptor = PRESET_APIS[normalizePresetApiId(apiId)];
    return descriptor ? descriptor.dirName : null;
}

/**
 * File extension used for preset files of the given API, or `null` when unsupported.
 *
 * @param {string} apiId API id.
 * @returns {string|null} Extension including the dot (e.g. `.json`).
 */
export function presetFileExtension(apiId) {
    const descriptor = PRESET_APIS[normalizePresetApiId(apiId)];
    return descriptor ? descriptor.extension : null;
}

/**
 * Number of UTF-8 bytes needed to encode one Unicode code point.
 *
 * @param {number} codePoint Unicode code point.
 * @returns {number} UTF-8 byte length (1-4).
 */
function utf8LengthOfCodePoint(codePoint) {
    if (codePoint <= 0x7f) {
        return 1;
    }
    if (codePoint <= 0x7ff) {
        return 2;
    }
    if (codePoint <= 0xffff) {
        return 3;
    }
    return 4;
}

/**
 * ASCII-only lowercase, mirroring Rust's `str::to_ascii_lowercase`.
 * (JavaScript's `toLowerCase()` would also fold non-ASCII characters.)
 *
 * @param {string} value Input string.
 * @returns {string} Lowercased ASCII letters, all other characters unchanged.
 */
function toAsciiLowerCase(value) {
    let result = '';
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        result += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : value[index];
    }
    return result;
}

/**
 * True when the (already filtered) name is a Windows reserved device name.
 * Mirrors the `is_windows_reserved_name` helper of TauriTavern's Rust sanitizer.
 *
 * @param {string} value Candidate file stem.
 * @returns {boolean} Whether the value must be rejected as unsafe.
 */
function isWindowsReservedName(value) {
    if (!value) {
        return false;
    }

    const lower = toAsciiLowerCase(value);
    const firstDot = lower.indexOf('.');
    const stem = firstDot === -1 ? lower : lower.slice(0, firstDot);

    if (stem === 'con' || stem === 'prn' || stem === 'aux' || stem === 'nul') {
        return true;
    }

    // `com0`-`com9` / `lpt0`-`lpt9`: prefix plus exactly one ASCII digit.
    if (stem.length === 4) {
        const prefix = stem.slice(0, 3);
        const lastCode = stem.charCodeAt(3);
        if ((prefix === 'com' || prefix === 'lpt') && lastCode >= 0x30 && lastCode <= 0x39) {
            return true;
        }
    }

    return false;
}

/**
 * Exact JavaScript port of TauriTavern's `sanitize_filename` (which mirrors
 * SillyTavern's `sanitize-filename@1.6.3`). This is the canonical preset file
 * stem used by the Tauri host.
 *
 * Rules, in order:
 * 1. drop characters `/?<>\\:*|"` and control code points U+0000-U+001F / U+0080-U+009F;
 * 2. clear the result when it is made of dots only or is a Windows reserved name
 *    (`con`, `prn`, `aux`, `nul`, `com0`-`com9`, `lpt0`-`lpt9`, checked before the first dot);
 * 3. strip trailing dots and spaces repeatedly (leading whitespace is preserved);
 * 4. truncate to at most 255 UTF-8 bytes without splitting a code point.
 *
 * @param {string} name Logical preset name.
 * @returns {string} Safe file stem, or an empty string when nothing usable remains.
 */
export function sanitizePresetFileStem(name) {
    if (typeof name !== 'string' || name === '') {
        return '';
    }

    let filtered = '';
    for (const character of name) {
        const codePoint = character.codePointAt(0);
        const isControlCode = (codePoint >= 0x00 && codePoint <= 0x1f) || (codePoint >= 0x80 && codePoint <= 0x9f);
        if (isControlCode || ILLEGAL_FILENAME_CHARACTERS.has(character)) {
            continue;
        }
        filtered += character;
    }

    let isDotsOnly = filtered.length > 0;
    for (const character of filtered) {
        if (character !== '.') {
            isDotsOnly = false;
            break;
        }
    }

    if (isDotsOnly || isWindowsReservedName(filtered)) {
        filtered = '';
    }

    while (filtered.endsWith('.') || filtered.endsWith(' ')) {
        filtered = filtered.slice(0, -1);
    }

    let truncated = '';
    let byteLength = 0;
    for (const character of filtered) {
        const characterBytes = utf8LengthOfCodePoint(character.codePointAt(0));
        if (byteLength + characterBytes > MAX_SANITIZED_FILENAME_BYTES) {
            break;
        }
        byteLength += characterBytes;
        truncated += character;
    }

    return truncated;
}

/**
 * Legacy TauriTavern preset file stem (buggy, kept only for backwards
 * compatibility when loading existing files). Prefer
 * {@link sanitizePresetFileStem} for the canonical name.
 *
 * Rules: map `/ \ : * ? " < > |` to `_`; keep Unicode alphanumeric characters,
 * `-`, `_`, `.` and spaces; replace every other character with `_`; finally trim
 * Unicode whitespace from both ends (no length truncation).
 *
 * @param {string} name Logical preset name.
 * @returns {string} Legacy file stem.
 */
export function legacyPresetFileStem(name) {
    if (typeof name !== 'string' || name === '') {
        return '';
    }

    let stem = '';
    for (const character of name) {
        if ('/\\:*?"<>|'.includes(character)) {
            stem += '_';
        } else if (character === '-' || character === '_' || character === '.' || character === ' ') {
            stem += character;
        } else if (/[\p{Alphabetic}\p{N}]/u.test(character)) {
            // Rust's `char::is_alphanumeric()` == Unicode `Alphabetic` || numeric.
            stem += character;
        } else {
            stem += '_';
        }
    }

    return stem.replace(RUST_TRIM_REGEX, '');
}

/**
 * Picks the path separator style of the given base path.
 *
 * @param {string} base Base directory path.
 * @returns {'/'|'\\'} Path separator to use (`\\` for Windows-style bases).
 */
function chooseSeparator(base) {
    return base.includes('\\') && !base.includes('/') ? '\\' : '/';
}

/**
 * Joins a base directory and path segments while respecting the base path's
 * separator style and avoiding duplicated separators.
 *
 * Both separator styles are accepted in the segments so values coming from the
 * Rust side (always native separators) and from the browser (usually `/`) can be
 * joined safely on any platform.
 *
 * @param {string} base Base directory (keeps its separator style).
 * @param {...(string|null|undefined)} segments Segments to append.
 * @returns {string} Joined path without duplicated separators.
 */
export function joinPath(base, ...segments) {
    const baseValue = typeof base === 'string' ? base : '';
    const separator = chooseSeparator(baseValue);

    const cleanSegments = [];
    for (const segment of segments) {
        if (typeof segment !== 'string') {
            continue;
        }
        const cleaned = segment.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
        if (cleaned) {
            cleanSegments.push(cleaned);
        }
    }

    const strippedBase = baseValue.replace(/[\\/]+$/, '');
    const isRootOnly = /^[\\/]+$/.test(baseValue);
    const root = isRootOnly ? baseValue.slice(0, 1) : strippedBase;

    if (!root) {
        return cleanSegments.join(separator);
    }
    if (cleanSegments.length === 0) {
        return root;
    }
    if (isRootOnly) {
        // A root such as `/` already ends with the separator.
        return `${root}${cleanSegments.join(separator)}`;
    }
    return `${root}${separator}${cleanSegments.join(separator)}`;
}

/**
 * Builds the preset JSON file paths to probe for a logical preset name.
 *
 * The canonical name (identical to TauriTavern's `canonical_preset_file_stem`)
 * comes first; the legacy name is only appended when it differs. Unsupported
 * APIs, empty names and names that sanitize to nothing yield an empty list.
 *
 * @param {string} apiId API id (accepts `koboldhorde`).
 * @param {string} name Logical preset name (the option label shown in the UI).
 * @param {string} presetDir Absolute path to the API's preset directory.
 * @returns {string[]} Ordered, de-duplicated candidate file paths (canonical first).
 */
export function buildPresetFileCandidates(apiId, name, presetDir) {
    const extension = presetFileExtension(apiId);
    if (!extension || typeof name !== 'string' || name === '') {
        return [];
    }

    const stems = [];
    const canonicalStem = sanitizePresetFileStem(name);
    if (canonicalStem) {
        stems.push(canonicalStem);
    }
    const legacyStem = legacyPresetFileStem(name);
    if (legacyStem && !stems.includes(legacyStem)) {
        stems.push(legacyStem);
    }

    return stems.map(stem => joinPath(presetDir, `${stem}${extension}`));
}

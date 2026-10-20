/**
 * TauriTavern host filesystem bridge: resolves preset JSON files and reads
 * their creation/modification timestamps through the Tauri plugin-fs commands.
 *
 * Contract highlights (see `_research/CONTRACT.md` §5):
 * - `invoke('get_runtime_paths')` -> `{ data_root, mode, ... }`;
 * - `invoke('get_user_directory', { handle })` -> snake_case directory paths
 *   (preferred over manual path joining);
 * - `invoke('plugin:fs|open', { path, options: { read: true } })` -> `rid`;
 * - `invoke('plugin:fs|fstat', { rid })` -> FileInfo with camelCase fields and
 *   `mtime` / `birthtime` as **numbers in milliseconds**;
 * - `invoke('plugin:resources|close', { rid })` releases the handle.
 *
 * Everything is wrapped, timeout-bounded, idempotent and fail-soft: a missing
 * preset file or a denied/missing Tauri command never throws into the UI. After
 * repeated hard command failures the bridge disables itself.
 *
 * @module preset-sorter/host-fs
 */

import { FS_CONCURRENCY, FS_TIMEOUT_MS, PRESET_APIS } from './constants.js';
import {
    buildPresetFileCandidates,
    isSupportedPresetApi,
    joinPath,
    normalizePresetApiId,
} from './preset-file.js';

/**
 * Map of preset API id -> `get_user_directory` DTO field (snake_case).
 * @type {Readonly<Record<string, string>>}
 */
const USER_DIRECTORY_KEYS = Object.freeze({
    openai: 'openai_settings',
    textgenerationwebui: 'textgen_settings',
    kobold: 'kobold_ai_settings',
    novel: 'novel_ai_settings',
    context: 'context',
    instruct: 'instruct',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
});

/** Errors that mean "file does not exist" rather than "fs access failed". */
const MISSING_PATH_PATTERN = /os error 2|cannot find the file|no such file|not found|enoent/i;

/** Number of consecutive hard failures after which the bridge disables itself. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Preset JSON file name pattern used by the directory index fallback. */
const JSON_FILE_PATTERN = /\.json$/i;

/**
 * @typedef {object} FileTimestamps
 * @property {number|null} birthtime File creation time (ms since epoch).
 * @property {number|null} mtime File modification time (ms since epoch).
 * @property {number|null} size File size in bytes.
 */

/**
 * @typedef {object} ImportTimeInfo
 * @property {number} time Import timestamp (ms since epoch).
 * @property {'birthtime'|'mtime'} source Timestamp source.
 * @property {string} path File path the timestamp was read from.
 */

/**
 * @typedef {object} HostFsStatus
 * @property {boolean} available Tauri invoke API present and host directories resolved.
 * @property {boolean} enabled Bridge not disabled by repeated failures.
 * @property {boolean} initialized Directory resolution finished successfully.
 * @property {string|null} reason Why the bridge is unavailable/disabled.
 * @property {string|null} dataRoot Resolved data root path.
 * @property {string|null} dataRootSource `user_directory_root` | `runtime_paths` | `app_data_dir` | null.
 * @property {string|null} handle Current user handle.
 * @property {string|null} directorySource Source of the preset directories.
 * @property {number} failureCount Consecutive hard command failures.
 * @property {string|null} lastError Last hard failure message.
 * @property {number} presetDirectoryCount Number of resolved preset directories.
 */

/**
 * @typedef {object} HostFsBridge
 * @property {() => Promise<HostFsStatus>} initialize Resolve host directories once (idempotent).
 * @property {() => boolean} isAvailable Whether a Tauri invoke API is present.
 * @property {() => boolean} isEnabled Whether the bridge is usable (not self-disabled).
 * @property {(apiId: string) => string|null} getPresetDirectory Resolved preset directory for an API.
 * @property {(apiId: string, names: string[], options?: {signal?: AbortSignal}) => Promise<Map<string, ImportTimeInfo>>} readImportTimesBatch Read import times with bounded concurrency.
 * @property {() => void} clearCache Drop cached timestamps / directory indexes.
 * @property {() => HostFsStatus} getStatus Cheap status snapshot.
 */

/**
 * Creates a fail-soft host filesystem bridge.
 *
 * @param {object} [options] Bridge dependencies.
 * @param {((command: string, args?: object) => Promise<any>)|null} [options.invoke] Tauri invoke function (`window.__TAURI__.core.invoke`), or `null` in plain SillyTavern.
 * @param {{appDataDir?: () => Promise<string>}|null} [options.pathApi] Tauri path API (`window.__TAURI__.path`), used only as data-root fallback.
 * @param {(() => string)|null} [options.getCurrentUserHandle] Returns the SillyTavern user handle.
 * @param {{warn?: Function, error?: Function}|null} [options.logger] Optional logger.
 * @returns {HostFsBridge} Host filesystem bridge API.
 */
export function createHostFs({ invoke = null, pathApi = null, getCurrentUserHandle = null, logger = null } = {}) {
    const canInvoke = typeof invoke === 'function';
    const log = logger && typeof logger === 'object' ? logger : null;

    /** @type {HostFsStatus & {directories: Map<string, string>}} */
    const state = {
        available: canInvoke,
        enabled: canInvoke,
        initialized: false,
        reason: canInvoke ? null : 'no-tauri-runtime',
        dataRoot: null,
        dataRootSource: null,
        handle: null,
        directorySource: null,
        failureCount: 0,
        lastError: null,
        presetDirectoryCount: 0,
        directories: new Map(),
    };

    /** @type {Map<string, FileTimestamps>} Positive stat results only (misses are retried). */
    const fileInfoCache = new Map();
    /** @type {Map<string, Promise<FileTimestamps|null>>} In-flight stat de-duplication. */
    const inFlightStats = new Map();
    /** @type {Map<string, Promise<Map<string, string>|null>>} Lazy name -> path index per API. */
    const directoryIndexCache = new Map();

    /** @type {Promise<HostFsStatus>|null} */
    let initializePromise = null;

    /**
     * @param {string} action Action label for diagnostics.
     * @param {unknown} error Error value.
     * @returns {string} Human readable message.
     */
    function errorMessage(action, error) {
        const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
        return `${action}: ${message}`;
    }

    /**
     * @param {unknown} error Error value.
     * @returns {boolean} Whether the error means "path not found".
     */
    function isMissingPathError(error) {
        return MISSING_PATH_PATTERN.test(error instanceof Error ? error.message : String(error ?? ''));
    }

    /**
     * Records a hard command failure; disables the bridge after too many.
     *
     * @param {string} action Action label.
     * @param {unknown} error Error value.
     * @returns {void}
     */
    function noteFailure(action, error) {
        const message = errorMessage(action, error);
        state.failureCount += 1;
        state.lastError = message;
        if (state.failureCount === 1 || state.failureCount >= MAX_CONSECUTIVE_FAILURES) {
            log?.warn?.(`[preset-sorter] host fs ${action} failed: ${message}`);
        }
        if (state.failureCount >= MAX_CONSECUTIVE_FAILURES && state.enabled) {
            state.enabled = false;
            state.reason = 'too-many-failures';
            log?.warn?.('[preset-sorter] disabling host filesystem bridge after repeated failures');
        }
    }

    /**
     * Runs a Tauri command with a timeout, converting unexpected arguments.
     *
     * @param {string} command Command name.
     * @param {object} args Command arguments.
     * @returns {Promise<any>} Command result.
     */
    function call(command, args) {
        if (!canInvoke || !state.enabled) {
            throw new Error(`host fs bridge unavailable (${state.reason ?? 'disabled'})`);
        }
        return withTimeout(invoke(command, args), FS_TIMEOUT_MS, command);
    }

    /**
     * Resolves the current SillyTavern user handle.
     *
     * @returns {Promise<string>} User handle (falls back to `default-user`).
     */
    async function resolveUserHandle() {
        try {
            if (typeof getCurrentUserHandle === 'function') {
                const handle = await getCurrentUserHandle();
                if (typeof handle === 'string' && handle.trim() !== '') {
                    return handle.trim();
                }
            }
        } catch (error) {
            log?.warn?.(`[preset-sorter] could not resolve user handle: ${errorMessage('getCurrentUserHandle', error)}`);
        }
        return 'default-user';
    }

    /**
     * Derives the data root from a `<data_root>/<handle>` path returned by
     * `get_user_directory` (diagnostics only; used on platforms where the
     * desktop-only `get_runtime_paths` command is not registered).
     *
     * @param {unknown} handleRoot Absolute `<data_root>/<handle>` path.
     * @returns {string|null} Data root path, or `null` when it cannot be derived.
     */
    function deriveDataRootFromHandleRoot(handleRoot) {
        if (typeof handleRoot !== 'string' || handleRoot.trim() === '') {
            return null;
        }
        const trimmed = handleRoot.replace(/[\\/]+$/, '');
        const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
        if (lastSeparator <= 0) {
            return null;
        }
        return trimmed.slice(0, lastSeparator);
    }

    /**
     * Resolves preset directories and the data root.
     *
     * Order matters for mobile compatibility: `get_user_directory` is registered
     * on **all** platforms (desktop + Android + iOS) and returns absolute preset
     * directory paths, while `get_runtime_paths` is desktop-only in TauriTavern
     * 2.3.0. The bridge therefore asks for the user directory DTO first and only
     * falls back to `get_runtime_paths` when the directories could not be resolved
     * (so Android/iOS never invoke the unregistered command on the happy path).
     *
     * @returns {Promise<HostFsStatus>} Bridge status.
     */
    async function initializeInternal() {
        if (!canInvoke) {
            return getStatus();
        }

        state.handle = await resolveUserHandle();

        // 1. Preferred on EVERY platform: user directory DTO with absolute paths.
        let directorySource = null;
        try {
            const dto = await call('get_user_directory', { handle: state.handle });
            if (dto && typeof dto === 'object') {
                for (const [apiId, key] of Object.entries(USER_DIRECTORY_KEYS)) {
                    const directory = dto[key];
                    if (typeof directory === 'string' && directory !== '') {
                        state.directories.set(apiId, directory);
                    }
                }
                if (state.directories.size > 0) {
                    directorySource = 'get_user_directory';
                    // Derive the data root for diagnostics: `root` is
                    // `<data_root>/<handle>`, so its parent is the data root.
                    const derivedFromRoot = deriveDataRootFromHandleRoot(dto.root);
                    if (derivedFromRoot) {
                        state.dataRoot = derivedFromRoot;
                        state.dataRootSource = 'user_directory_root';
                    } else if (typeof dto.openai_settings === 'string') {
                        const handleRoot = deriveDataRootFromHandleRoot(dto.openai_settings);
                        const derivedFromPresetDir = handleRoot ? deriveDataRootFromHandleRoot(handleRoot) : null;
                        if (derivedFromPresetDir) {
                            state.dataRoot = derivedFromPresetDir;
                            state.dataRootSource = 'user_directory_root';
                        }
                    }
                }
            }
        } catch (error) {
            log?.warn?.(`[preset-sorter] get_user_directory failed: ${errorMessage('get_user_directory', error)}`);
        }

        // 2. Desktop-only diagnostics / fallback. Skipped when the user directory
        //    DTO already resolved everything, so mobile never calls the
        //    unregistered command. Failure here must never disable the bridge.
        if (state.directories.size === 0 && !state.dataRoot) {
            try {
                const runtimePaths = await call('get_runtime_paths', {});
                if (runtimePaths && typeof runtimePaths.data_root === 'string' && runtimePaths.data_root !== '') {
                    state.dataRoot = runtimePaths.data_root;
                    state.dataRootSource = 'runtime_paths';
                }
            } catch (error) {
                // Expected on Android/iOS (command not registered there).
                log?.debug?.(`[preset-sorter] get_runtime_paths unavailable: ${errorMessage('get_runtime_paths', error)}`);
            }
        }

        // 3. Plain `$APPDATA/data` fallback when the app commands are unavailable.
        if (!state.dataRoot && pathApi && typeof pathApi.appDataDir === 'function') {
            try {
                const appDataDir = await pathApi.appDataDir();
                if (typeof appDataDir === 'string' && appDataDir !== '') {
                    state.dataRoot = joinPath(appDataDir, 'data');
                    state.dataRootSource = 'app_data_dir';
                }
            } catch (error) {
                log?.warn?.(`[preset-sorter] appDataDir fallback failed: ${errorMessage('appDataDir', error)}`);
            }
        }

        // 4. Fallback: join data root + handle + known directory names.
        if (state.directories.size === 0 && state.dataRoot) {
            for (const apiId of Object.keys(PRESET_APIS)) {
                state.directories.set(
                    apiId,
                    joinPath(state.dataRoot, state.handle, PRESET_APIS[apiId].dirName),
                );
            }
            if (state.dataRootSource === 'runtime_paths') {
                directorySource = 'runtime_paths_fallback';
            } else if (state.dataRootSource === 'user_directory_root') {
                directorySource = 'user_directory_root_fallback';
            } else {
                directorySource = 'app_data_dir_fallback';
            }
        }

        if (state.directories.size === 0) {
            state.initialized = false;
            state.available = false;
            state.enabled = false;
            state.reason = 'no-preset-directories';
            return getStatus();
        }

        state.directorySource = directorySource;
        state.presetDirectoryCount = state.directories.size;
        state.initialized = true;
        state.available = true;
        state.enabled = true;
        state.reason = null;
        return getStatus();
    }

    /**
     * Resolves (once) the host directories.
     *
     * @returns {Promise<HostFsStatus>} Bridge status.
     */
    function initialize() {
        if (initializePromise) {
            return initializePromise;
        }
        initializePromise = (async () => {
            try {
                return await initializeInternal();
            } catch (error) {
                noteFailure('initialize', error);
                state.available = false;
                state.enabled = false;
                state.reason = 'initialize-failed';
                return getStatus();
            }
        })();
        return initializePromise;
    }

    /**
     * Reads numeric timestamps from a raw `plugin:fs|fstat` response.
     *
     * @param {any} info Raw FileInfo object.
     * @returns {FileTimestamps|null} Normalised timestamps, or `null` for unusable responses.
     */
    function normalizeFileInfo(info) {
        if (!info || typeof info !== 'object') {
            return null;
        }
        return {
            birthtime: typeof info.birthtime === 'number' && Number.isFinite(info.birthtime) ? info.birthtime : null,
            mtime: typeof info.mtime === 'number' && Number.isFinite(info.mtime) ? info.mtime : null,
            size: typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : null,
        };
    }

    /**
     * Opens a file, reads its metadata via fstat and always closes the resource.
     *
     * @param {string} path Absolute file path.
     * @returns {Promise<FileTimestamps|null>} File timestamps, or `null` when missing/unreadable.
     */
    async function statPath(path) {
        if (fileInfoCache.has(path)) {
            return fileInfoCache.get(path);
        }
        const inFlight = inFlightStats.get(path);
        if (inFlight) {
            return inFlight;
        }

        const task = (async () => {
            /** @type {number|null} */
            let rid = null;
            try {
                rid = await call('plugin:fs|open', { path, options: { read: true } });
                const info = await call('plugin:fs|fstat', { rid });
                const normalized = normalizeFileInfo(info);
                state.failureCount = 0;
                if (normalized) {
                    fileInfoCache.set(path, normalized);
                }
                return normalized;
            } catch (error) {
                if (isMissingPathError(error)) {
                    // Expected for absent canonical/legacy candidates; not a hard failure.
                    return null;
                }
                noteFailure('stat', error);
                return null;
            } finally {
                if (rid !== null && rid !== undefined) {
                    try {
                        await withTimeout(
                            invoke('plugin:resources|close', { rid }),
                            FS_TIMEOUT_MS,
                            'plugin:resources|close',
                        );
                    } catch (error) {
                        log?.warn?.(`[preset-sorter] resources|close failed: ${errorMessage('close', error)}`);
                    }
                }
            }
        })();

        inFlightStats.set(path, task);
        try {
            return await task;
        } finally {
            inFlightStats.delete(path);
        }
    }

    /**
     * Decodes a raw `plugin:fs|read_text_file` response.
     *
     * @param {string} path Absolute file path.
     * @returns {Promise<string|null>} UTF-8 text, or `null` on failure.
     */
    async function readTextFile(path) {
        try {
            const raw = await call('plugin:fs|read_text_file', { path });
            const bytes = raw instanceof ArrayBuffer
                ? new Uint8Array(raw)
                : (ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null);
            if (!bytes || typeof TextDecoder !== 'function') {
                return null;
            }
            return new TextDecoder('utf-8').decode(bytes);
        } catch (error) {
            if (!isMissingPathError(error)) {
                noteFailure('read_text_file', error);
            }
            return null;
        }
    }

    /**
     * Builds (lazily, once per API) a logical preset name -> file path index by
     * reading each preset JSON and using its embedded `name` when present.
     * Only used when canonical/legacy file name candidates are missing.
     *
     * @param {string} apiId Canonical API id.
     * @param {string} directory Preset directory.
     * @returns {Promise<Map<string, string>|null>} Name -> absolute path index.
     */
    async function buildDirectoryIndex(apiId, directory) {
        try {
            const entries = await call('plugin:fs|read_dir', { path: directory });
            if (!Array.isArray(entries)) {
                return null;
            }
            const index = new Map();
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
                    continue;
                }
                if (entry.isDirectory === true || !JSON_FILE_PATTERN.test(entry.name)) {
                    continue;
                }
                const filePath = joinPath(directory, entry.name);
                const stem = entry.name.replace(JSON_FILE_PATTERN, '');
                const text = await readTextFile(filePath);
                let logicalName = stem;
                if (typeof text === 'string') {
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed && typeof parsed.name === 'string' && parsed.name.trim() !== '') {
                            logicalName = parsed.name.trim();
                        }
                    } catch {
                        // Malformed preset JSON: fall back to the file stem.
                    }
                }
                if (!index.has(logicalName)) {
                    index.set(logicalName, filePath);
                }
            }
            return index;
        } catch (error) {
            if (!isMissingPathError(error)) {
                noteFailure('read_dir', error);
            }
            return null;
        }
    }

    /**
     * @param {string} apiId Canonical API id.
     * @param {string} directory Preset directory.
     * @returns {Promise<Map<string, string>|null>} Cached directory index.
     */
    function getDirectoryIndex(apiId, directory) {
        if (!directoryIndexCache.has(apiId)) {
            directoryIndexCache.set(apiId, buildDirectoryIndex(apiId, directory));
        }
        return /** @type {Promise<Map<string, string>|null>} */ (directoryIndexCache.get(apiId));
    }

    /**
     * Converts file timestamps into the import time used by the sort engine.
     *
     * @param {FileTimestamps|null} info File timestamps.
     * @param {string} path Source path.
     * @returns {ImportTimeInfo|null} Import time info (`birthtime` preferred, then `mtime`).
     */
    function toImportTime(info, path) {
        if (!info) {
            return null;
        }
        if (info.birthtime !== null) {
            return { time: info.birthtime, source: 'birthtime', path };
        }
        if (info.mtime !== null) {
            return { time: info.mtime, source: 'mtime', path };
        }
        return null;
    }

    /**
     * Resolves the import time of one preset.
     *
     * @param {string} apiId Canonical API id.
     * @param {string} name Logical preset name.
     * @returns {Promise<ImportTimeInfo|null>} Import time info, or `null`.
     */
    async function readImportTimeForPreset(apiId, name) {
        const directory = state.directories.get(apiId);
        if (!directory) {
            return null;
        }

        const candidates = buildPresetFileCandidates(apiId, name, directory);
        for (const candidate of candidates) {
            const info = toImportTime(await statPath(candidate), candidate);
            if (info) {
                return info;
            }
        }

        // Some files carry a logical name that differs from the stem; resolve via
        // a one-time directory index of embedded JSON names.
        const index = await getDirectoryIndex(apiId, directory);
        const fallbackPath = index ? index.get(name) : null;
        if (fallbackPath) {
            return toImportTime(await statPath(fallbackPath), fallbackPath);
        }
        return null;
    }

    /**
     * Reads import times for many presets with bounded concurrency.
     *
     * @param {string} apiId API id (koboldhorde accepted).
     * @param {string[]} names Logical preset names.
     * @param {{signal?: AbortSignal}} [options] Options; `signal` aborts between tasks.
     * @returns {Promise<Map<string, ImportTimeInfo>>} Resolved import times (missing entries = unresolved).
     */
    async function readImportTimesBatch(apiId, names, options = {}) {
        /** @type {Map<string, ImportTimeInfo>} */
        const results = new Map();
        const canonicalApiId = normalizePresetApiId(apiId);
        if (!state.enabled || !isSupportedPresetApi(canonicalApiId) || !Array.isArray(names)) {
            return results;
        }
        await initialize();
        if (!state.enabled) {
            return results;
        }

        const uniqueNames = [...new Set(names.filter(name => typeof name === 'string' && name !== ''))];
        if (uniqueNames.length === 0) {
            return results;
        }

        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < uniqueNames.length) {
                if (options.signal?.aborted) {
                    return;
                }
                const name = uniqueNames[nextIndex];
                nextIndex += 1;
                try {
                    const info = await readImportTimeForPreset(canonicalApiId, name);
                    if (info && !options.signal?.aborted) {
                        results.set(name, info);
                    }
                } catch (error) {
                    // readImportTimeForPreset is already fail-soft; this is a last-resort guard.
                    log?.warn?.(`[preset-sorter] import time read failed for ${canonicalApiId}/${name}: ${errorMessage('read', error)}`);
                }
                if (!state.enabled) {
                    return;
                }
            }
        };

        const workerCount = Math.min(FS_CONCURRENCY, uniqueNames.length);
        await Promise.all(Array.from({ length: workerCount }, worker));
        return results;
    }

    /**
     * Returns the resolved preset directory for an API.
     *
     * @param {string} apiId API id.
     * @returns {string|null} Absolute preset directory path.
     */
    function getPresetDirectory(apiId) {
        return state.directories.get(normalizePresetApiId(apiId)) ?? null;
    }

    /**
     * Drops cached file timestamps and directory indexes so the next batch
     * re-reads real filesystem metadata.
     *
     * @returns {void}
     */
    function clearCache() {
        fileInfoCache.clear();
        directoryIndexCache.clear();
    }

    /**
     * Returns a cheap status snapshot for diagnostics.
     *
     * @returns {HostFsStatus} Bridge status.
     */
    function getStatus() {
        return {
            available: state.available && canInvoke,
            enabled: state.enabled && canInvoke,
            initialized: state.initialized,
            reason: state.reason,
            dataRoot: state.dataRoot,
            dataRootSource: state.dataRootSource,
            handle: state.handle,
            directorySource: state.directorySource,
            failureCount: state.failureCount,
            lastError: state.lastError,
            presetDirectoryCount: state.presetDirectoryCount,
        };
    }

    return {
        initialize,
        isAvailable: () => canInvoke,
        isEnabled: () => canInvoke && state.enabled,
        getPresetDirectory,
        readImportTimesBatch,
        clearCache,
        getStatus,
    };
}

/**
 * Wraps a promise with a timeout.
 *
 * @param {Promise<any>} promise Promise to bound.
 * @param {number} timeoutMs Timeout in milliseconds.
 * @param {string} label Operation label used in the timeout error.
 * @returns {Promise<any>} Resolves/rejects like the wrapped promise.
 */
function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`timeout after ${timeoutMs}ms (${label})`));
            }
        }, timeoutMs);
        Promise.resolve(promise).then(
            value => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                }
            },
            error => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(error);
                }
            },
        );
    });
}

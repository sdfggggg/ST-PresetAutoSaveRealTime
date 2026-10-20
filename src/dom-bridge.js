/**
 * DOM bridge for the preset dropdowns.
 *
 * Responsibilities:
 * - discover the supported preset manager `<select>` elements;
 * - snapshot their `<option>` order (names + values);
 * - reorder the existing option **nodes** only (values/labels are never rebuilt,
 *   because OpenAI/Kobold/Novel values are indices into SillyTavern's arrays);
 * - preserve the selected option without firing `change`;
 * - observe option list mutations (bounded, childList-only observer);
 * - inject a compact sort-mode `<select>` next to each preset select;
 * - maintain localized option tooltips from usage/import statistics.
 *
 * The helpers only use standard DOM APIs and never touch jQuery. Top-level code
 * is side-effect free (no DOM access at module evaluation time), so the module
 * is safe to import in Node.js with DOM stubs.
 *
 * @module preset-sorter/dom-bridge
 */

import {
    DEFAULT_DIRECTION,
    DEFAULT_FIELD,
    DIRECTION_ORDER,
    FIELD_ORDER,
    PRESET_APIS,
    PRESET_SELECT_SELECTOR,
} from './constants.js';
import { formatDirectionLabel, formatFieldLabel, formatImportSourceLabel, formatTimestamp, t } from './i18n.js';
import { isSupportedPresetApi, normalizePresetApiId } from './preset-file.js';

/** `class` of the injected field + direction control group. @type {string} */
export const SORT_CONTROL_CLASS = 'preset-sorter-control-group';

/** Data attribute carried by the injected control group (value = apiId). @type {string} */
export const SORT_CONTROL_ATTR = 'data-preset-sorter-control';

/** `class` of the sort-field `<select>` inside the control group. @type {string} */
export const SORT_FIELD_CLASS = 'preset-sorter-field-select';

/** `class` of the independent 正序/倒序 checkbox inside the control group. @type {string} */
export const SORT_DIRECTION_CLASS = 'preset-sorter-direction-checkbox';

/** `class` of the direction `<label>` wrapper inside the control group. @type {string} */
export const SORT_DIRECTION_LABEL_CLASS = 'preset-sorter-direction-label';

/** `class` of the decorative sort icon. @type {string} */
export const SORT_ICON_CLASS = 'preset-sorter-sort-icon';

/** The value of the non-file "GUI KoboldAI Settings" placeholder option. @type {string} */
export const PRESET_PLACEHOLDER_VALUE = 'gui';

/** @type {WeakMap<Element, {element: any, apiId: string, getState: Function, setState: Function, setHidden: Function, dispose: Function}>} */
const controlBySelect = new WeakMap();

/** @type {WeakMap<Element, Map<string, string>>} */
const tooltipCacheBySelect = new WeakMap();

/**
 * @returns {Document|null} The document object when available.
 */
function getDocument() {
    return typeof document !== 'undefined' ? document : null;
}

/**
 * @param {Element|object} node Candidate node.
 * @returns {boolean} Whether the node looks like an `<option>` element.
 */
function isOptionLike(node) {
    if (!node || typeof node !== 'object') {
        return false;
    }
    const tagName = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
    if (tagName !== '' && tagName !== 'OPTION') {
        return false;
    }
    return node.value !== undefined || node.textContent !== undefined || tagName === 'OPTION';
}

/**
 * Reads the visible label of an option.
 *
 * @param {any} option Option element.
 * @returns {string} Option label.
 */
function readOptionName(option) {
    const raw = option.textContent ?? option.text ?? option.innerText ?? '';
    return typeof raw === 'string' ? raw : String(raw);
}

/**
 * @param {any} option Option element.
 * @returns {string} Option value as a string.
 */
function readOptionValue(option) {
    return option.value === undefined || option.value === null ? '' : String(option.value);
}

/**
 * Returns the option elements of a select in DOM order.
 *
 * @param {HTMLSelectElement|any} select Select element.
 * @returns {any[]} Option elements.
 */
function readOptionElements(select) {
    if (!select) {
        return [];
    }
    const collection = select.options ?? select.children ?? null;
    if (!collection || typeof collection.length !== 'number') {
        return [];
    }
    const options = [];
    for (let index = 0; index < collection.length; index += 1) {
        const option = collection[index];
        if (isOptionLike(option)) {
            options.push(option);
        }
    }
    return options;
}

/**
 * Reads the current options of a preset select, including option node references.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @returns {Array<{name: string, value: string, option: any}>} Options in DOM order.
 */
export function readOptionEntries(select) {
    return readOptionElements(select).map(option => ({
        name: readOptionName(option),
        value: readOptionValue(option),
        option,
    }));
}

/**
 * Reads the current options of a preset select as plain `{name, value}` snapshots
 * suitable for the pure sort engine.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @returns {Array<{name: string, value: string}>} Options in DOM order (both fields strings).
 */
export function readSelectOptions(select) {
    return readOptionEntries(select).map(entry => ({ name: entry.name, value: entry.value }));
}

/**
 * Returns the currently selected option snapshot.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @returns {{name: string, value: string}|null} Selected option, or `null`.
 */
export function readSelectedOption(select) {
    if (!select) {
        return null;
    }
    const selectedOptions = select.selectedOptions;
    if (selectedOptions && typeof selectedOptions.length === 'number' && selectedOptions.length > 0) {
        const option = selectedOptions[0];
        if (isOptionLike(option)) {
            return { name: readOptionName(option), value: readOptionValue(option) };
        }
    }
    const entries = readOptionEntries(select);
    if (entries.length === 0) {
        return null;
    }
    const selectedIndex = typeof select.selectedIndex === 'number' ? select.selectedIndex : -1;
    if (selectedIndex >= 0) {
        const byIndex = entries.find(entry => entry.option === select.options?.[selectedIndex]);
        if (byIndex) {
            return { name: byIndex.name, value: byIndex.value };
        }
    }
    const explicit = entries.find(entry => entry.option && entry.option.selected === true);
    if (explicit) {
        return { name: explicit.name, value: explicit.value };
    }
    const selectedValue = select.value === undefined || select.value === null ? '' : String(select.value);
    if (selectedValue !== '') {
        const byValue = entries.find(entry => entry.value === selectedValue);
        if (byValue) {
            return { name: byValue.name, value: byValue.value };
        }
    }
    return entries[0];
}

/**
 * True for the non-file placeholder option (`value="gui"`, Kobold only).
 *
 * @param {string} _apiId API id.
 * @param {{value: string}} entry Option snapshot.
 * @returns {boolean} Whether the option is a placeholder rather than a preset file.
 */
export function isPresetPlaceholder(_apiId, entry) {
    return !!entry && String(entry.value) === PRESET_PLACEHOLDER_VALUE;
}

/**
 * Reads the `class` names of an element.
 *
 * @param {any} element DOM element (or test double).
 * @returns {string[]} Class names.
 */
function readClassNames(element) {
    if (!element) {
        return [];
    }
    try {
        if (element.classList && typeof element.classList.contains === 'function') {
            return [...element.classList];
        }
    } catch {
        // Fall back to className below.
    }
    return typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean) : [];
}

/**
 * @param {any} element DOM element.
 * @param {string} className Class name to check.
 * @returns {boolean} Whether the element carries the class.
 */
function hasClassName(element, className) {
    if (!element) {
        return false;
    }
    try {
        if (element.classList && typeof element.classList.contains === 'function') {
            return element.classList.contains(className);
        }
    } catch {
        // Fall back to className below.
    }
    return readClassNames(element).includes(className);
}

/**
 * True for a horizontal flex **row** container (not a vertical settings column).
 * Rows are the correct injection sibling for a preset select; columns are only
 * a last resort. SillyTavern rows use `flex-container` (optionally `flexNoGap`),
 * while columns additionally carry `flexFlowColumn`.
 *
 * @param {any} element Candidate container.
 * @returns {boolean} Whether the element is a flex row.
 */
function isFlexRow(element) {
    return hasClassName(element, 'flex-container') && !hasClassName(element, 'flexFlowColumn');
}

/**
 * Returns the parent element of a node.
 *
 * `parentElement` is `null` (not `undefined`) in real DOM; some DOM doubles only
 * expose `parentNode`, so fall back to it when `parentElement` is unavailable.
 *
 * @param {any} element DOM element.
 * @returns {any|null} Parent element, or `null`.
 */
function getParentElement(element) {
    if (!element) {
        return null;
    }
    if (element.parentElement !== undefined) {
        return element.parentElement;
    }
    return element.parentNode ?? null;
}

/**
 * @param {any} node Candidate node.
 * @returns {boolean} Whether the node is the document / a document fragment boundary.
 */
function isDocumentBoundary(node) {
    if (!node) {
        return false;
    }
    if (node.nodeType === 9 || node.nodeType === 11) {
        return true;
    }
    const tagName = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
    return tagName === 'BODY' || tagName === 'HTML' || tagName === '#DOCUMENT' || tagName === '#DOCUMENT-FRAGMENT';
}

/**
 * Finds the flex row that contains a preset select (used for control injection).
 *
 * Preference order:
 * 1. the select's direct parent when it is a flex row (all upstream rows:
 *    `flex-container flexNoGap` for OpenAI/TextGen/Kobold/Novel, plain
 *    `flex-container` for Context/Instruct/Sysprompt/Reasoning);
 * 2. a nearby ancestor flex row (bounded to 4 levels) when the select sits in a
 *    small wrapper (legacy/alternative layouts);
 * 3. the direct parent as a safe fallback.
 *
 * Columns (`flexFlowColumn`) are deliberately never chosen: the nearest
 * `.flexNoGap` ancestor of several manager rows is the whole settings column, and
 * injecting there would append the control at the bottom of the column instead of
 * next to the select.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @returns {Element|null} Row container, or `null`.
 */
export function getPresetRow(select) {
    if (!select) {
        return null;
    }
    const directParent = getParentElement(select);
    if (!directParent) {
        return null;
    }
    if (isFlexRow(directParent)) {
        return directParent;
    }

    let node = directParent;
    for (let depth = 0; depth < 4; depth += 1) {
        const parent = getParentElement(node);
        if (!parent || parent === node || isDocumentBoundary(parent)) {
            break;
        }
        if (isFlexRow(parent)) {
            return parent;
        }
        node = parent;
    }
    return directParent;
}

/**
 * Reorders the option nodes of a select to match `items`.
 *
 * Options are moved (never recreated), their values and labels are untouched,
 * and the selected option/value is restored afterwards. No `change` event is
 * dispatched. When the DOM already matches the requested order this is a
 * structural no-op.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @param {Array<{value: string|number}>} items Desired option order (usually from `computePresetOrder`).
 * @returns {boolean} `true` when the DOM was reordered, `false` for a no-op.
 */
export function applyOptionOrder(select, items) {
    if (!select || !Array.isArray(items) || items.length === 0) {
        return false;
    }
    const entries = readOptionEntries(select);
    if (entries.length === 0) {
        return false;
    }

    // Build option queues per value so duplicated values (should not happen for
    // preset managers, but cheap to support) keep a deterministic order.
    /** @type {Map<string, any[]>} */
    const queues = new Map();
    for (const entry of entries) {
        if (!queues.has(entry.value)) {
            queues.set(entry.value, []);
        }
        queues.get(entry.value).push(entry.option);
    }

    /** @type {any[]} */
    const ordered = [];
    const consumed = new Set();
    const requestedValues = new Set();
    for (const item of items) {
        const value = item === null || item === undefined ? '' : String(item.value ?? '');
        requestedValues.add(value);
        const queue = queues.get(value);
        if (!queue || queue.length === 0) {
            continue;
        }
        const option = queue.shift();
        ordered.push(option);
        consumed.add(option);
    }
    // Keep any option that was not requested (paranoia: never drop DOM nodes).
    for (const entry of entries) {
        if (!consumed.has(entry.option)) {
            ordered.push(entry.option);
        }
    }

    // No-op check before touching the DOM.
    let identical = ordered.length === entries.length;
    if (identical) {
        for (let index = 0; index < ordered.length; index += 1) {
            if (String(ordered[index].value) !== entries[index].value) {
                identical = false;
                break;
            }
        }
    }
    if (identical) {
        return false;
    }

    const selectedValueBefore = select.value === undefined || select.value === null ? null : String(select.value);
    const documentRef = getDocument();
    const fragment = documentRef && typeof documentRef.createDocumentFragment === 'function'
        ? documentRef.createDocumentFragment()
        : null;

    if (fragment && typeof fragment.appendChild === 'function' && typeof select.appendChild === 'function') {
        for (const option of ordered) {
            fragment.appendChild(option);
        }
        select.appendChild(fragment);
    } else if (typeof select.appendChild === 'function') {
        for (const option of ordered) {
            select.appendChild(option);
        }
    }

    // Restore the selected option/value without firing events.
    if (selectedValueBefore !== null && selectedValueBefore !== '') {
        const match = readOptionEntries(select).find(entry => entry.value === selectedValueBefore);
        if (match) {
            try {
                match.option.selected = true;
            } catch {
                // Ignore non-writable test doubles.
            }
            if (String(select.value) !== selectedValueBefore) {
                try {
                    select.value = selectedValueBefore;
                } catch {
                    // Ignore non-writable test doubles.
                }
            }
        }
    }
    return true;
}

/**
 * Discovers the supported preset manager selects.
 *
 * Primary source: `select[data-preset-manager-for]`; fallback: the known ids from
 * `PRESET_APIS` (plain/older SillyTavern layouts). Unknown APIs are ignored.
 *
 * @param {Document|Element|null} [root] Root to search (defaults to `document`).
 * @returns {Array<{apiId: string, select: any}>} Managers in a stable API order.
 */
export function discoverPresetManagers(root = null) {
    const rootElement = root ?? getDocument();
    /** @type {Map<string, any>} */
    const found = new Map();

    if (rootElement) {
        /** @type {any[]} */
        let markedSelects = [];
        try {
            if (typeof rootElement.querySelectorAll === 'function') {
                markedSelects = Array.from(rootElement.querySelectorAll(PRESET_SELECT_SELECTOR));
            } else if (typeof rootElement.querySelector === 'function') {
                const single = rootElement.querySelector(PRESET_SELECT_SELECTOR);
                if (single) {
                    markedSelects = [single];
                }
            }
        } catch {
            markedSelects = [];
        }

        for (const select of markedSelects) {
            let rawAttribute = '';
            try {
                rawAttribute = typeof select.getAttribute === 'function'
                    ? String(select.getAttribute('data-preset-manager-for') ?? '')
                    : '';
            } catch {
                rawAttribute = '';
            }
            if (!rawAttribute && select.dataset && typeof select.dataset.presetManagerFor === 'string') {
                rawAttribute = select.dataset.presetManagerFor;
            }
            for (const rawApiId of rawAttribute.split(',')) {
                const apiId = normalizePresetApiId(rawApiId.trim());
                if (isSupportedPresetApi(apiId) && !found.has(apiId)) {
                    found.set(apiId, select);
                }
            }
        }

        if (typeof rootElement.getElementById === 'function') {
            for (const [apiId, descriptor] of Object.entries(PRESET_APIS)) {
                if (found.has(apiId)) {
                    continue;
                }
                try {
                    const select = rootElement.getElementById(descriptor.selectId);
                    if (select) {
                        found.set(apiId, select);
                    }
                } catch {
                    // Ignore lookup failures in test doubles.
                }
            }
        }
    }

    return Object.keys(PRESET_APIS)
        .filter(apiId => found.has(apiId))
        .map(apiId => ({ apiId, select: found.get(apiId) }));
}

/**
 * Builds the localized tooltip text of one preset option.
 *
 * @param {import('./stats-store.js').PresetStatsEntry|undefined} stats Preset stats entry.
 * @returns {string} Tooltip text (always non-empty for option entries).
 */
function buildOptionTitle(stats) {
    if (!stats) {
        return t('tooltip.noStats');
    }
    const lines = [];
    if (stats.importTime !== null && stats.importTime !== undefined) {
        lines.push(t('tooltip.importTime', {
            time: formatTimestamp(stats.importTime),
            source: formatImportSourceLabel(stats.importSource),
        }));
    } else if (stats.firstSeenAt !== null && stats.firstSeenAt !== undefined) {
        lines.push(t('tooltip.firstSeen', { time: formatTimestamp(stats.firstSeenAt) }));
    }
    if (stats.count !== undefined && stats.count > 0) {
        lines.push(t('tooltip.usage', { count: stats.count }));
        if (stats.lastUsedAt !== null && stats.lastUsedAt !== undefined) {
            lines.push(t('tooltip.lastUsed', { time: formatTimestamp(stats.lastUsedAt) }));
        }
    } else if (lines.length === 0) {
        lines.push(t('tooltip.noStats'));
    }
    return lines.join('\n');
}

/**
 * Updates the `title` tooltip of every preset option from stats.
 * Re-running with unchanged stats performs zero DOM writes.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @param {(name: string) => (import('./stats-store.js').PresetStatsEntry|undefined)} getStats Stats accessor.
 * @returns {number} Number of options whose `title` changed.
 */
export function updateOptionTooltips(select, getStats) {
    if (!select || typeof getStats !== 'function') {
        return 0;
    }
    let cache = tooltipCacheBySelect.get(select);
    if (!cache) {
        cache = new Map();
        tooltipCacheBySelect.set(select, cache);
    }

    let changed = 0;
    for (const entry of readOptionEntries(select)) {
        let stats;
        try {
            stats = getStats(entry.name);
        } catch {
            stats = undefined;
        }
        const title = buildOptionTitle(stats);
        const previousTitle = entry.option.title === undefined ? '' : String(entry.option.title);
        if (previousTitle === title) {
            cache.set(entry.value, title);
            continue;
        }
        try {
            entry.option.title = title;
            changed += 1;
        } catch {
            // Ignore non-writable test doubles.
        }
        cache.set(entry.value, title);
    }
    return changed;
}

/**
 * @param {unknown} field Raw sort field.
 * @returns {string} Normalised field.
 */
function normalizeFieldValue(field) {
    return FIELD_ORDER.includes(field) ? field : DEFAULT_FIELD;
}

/**
 * @param {unknown} direction Raw sort direction.
 * @returns {string} Normalised direction.
 */
function normalizeDirectionValue(direction) {
    return DIRECTION_ORDER.includes(direction) ? direction : DEFAULT_DIRECTION;
}

/**
 * Injects (or reuses) the compact v1.1.0 sort control group next to a preset
 * select: a small sort icon, a **sort-field** `<select>` and an **independent**
 * 「倒序」 checkbox (checked = descending, unchecked = ascending). The direction
 * checkbox is disabled and dimmed while the field is "默认排序" / "Default order".
 *
 * The group is a sibling inside the same flex row, so replacing the select's
 * options never removes it. Repeated calls with the same select are idempotent
 * and only synchronize the current field + direction. The
 * `data-preset-sorter-control="<apiId>"` attribute is preserved for tests/probes.
 *
 * @param {object} options Options.
 * @param {HTMLSelectElement|any} options.select Preset select element.
 * @param {string} options.apiId API id.
 * @param {string} [options.field] Current sort field (`default` | `import` | `usage` | `recent`).
 * @param {string} [options.direction] Current sort direction (`asc` | `desc`).
 * @param {(field: string, direction: string, apiId: string) => void} [options.onChange] Change handler.
 * @param {Document|null} [options.document] Document override (tests).
 * @returns {{
 *   element: any,
 *   apiId: string,
 *   getState: () => {field: string, direction: string},
 *   setState: (field: string, direction: string) => void,
 *   setHidden: (hidden: boolean) => void,
 *   dispose: () => void,
 * }|null} Control handle.
 */
export function injectSortControl({
    select,
    apiId,
    field = DEFAULT_FIELD,
    direction = DEFAULT_DIRECTION,
    onChange,
    document: documentOverride = null,
} = {}) {
    if (!select) {
        return null;
    }

    const existing = controlBySelect.get(select);
    if (existing && existing.element) {
        existing.setState(field, direction);
        return existing;
    }

    const documentRef = documentOverride ?? getDocument();
    if (!documentRef || typeof documentRef.createElement !== 'function') {
        return null;
    }

    const normalizedField = normalizeFieldValue(field);
    const normalizedDirection = normalizeDirectionValue(direction);

    // --- control group container -------------------------------------------------
    const group = documentRef.createElement('span');
    group.className = SORT_CONTROL_CLASS;
    try {
        group.setAttribute(SORT_CONTROL_ATTR, apiId);
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', t('control.groupLabel'));
    } catch {
        // Test doubles may not implement setAttribute.
    }
    group.title = t('control.title');

    // --- decorative sort icon ----------------------------------------------------
    const icon = documentRef.createElement('i');
    icon.className = `fa-solid fa-arrow-down-wide-short ${SORT_ICON_CLASS}`;
    try {
        icon.setAttribute('aria-hidden', 'true');
    } catch {
        // Ignore.
    }
    group.appendChild(icon);

    // --- sort field select -------------------------------------------------------
    const fieldSelect = documentRef.createElement('select');
    fieldSelect.className = `text_pole ${SORT_FIELD_CLASS}`;
    fieldSelect.title = t('control.title');
    try {
        fieldSelect.setAttribute('aria-label', t('field.label'));
    } catch {
        // Ignore.
    }
    for (const fieldOption of FIELD_ORDER) {
        const option = documentRef.createElement('option');
        option.value = fieldOption;
        option.textContent = formatFieldLabel(fieldOption);
        fieldSelect.appendChild(option);
    }
    fieldSelect.value = normalizedField;
    group.appendChild(fieldSelect);

    // --- independent direction checkbox -----------------------------------------
    const directionLabel = documentRef.createElement('label');
    directionLabel.className = `checkbox_label ${SORT_DIRECTION_LABEL_CLASS}`;
    const directionCheckbox = documentRef.createElement('input');
    directionCheckbox.type = 'checkbox';
    directionCheckbox.className = SORT_DIRECTION_CLASS;
    directionCheckbox.checked = normalizedDirection === 'desc';
    try {
        directionCheckbox.setAttribute('aria-label', t('direction.title'));
    } catch {
        // Ignore.
    }
    const directionText = documentRef.createElement('span');
    directionText.className = 'preset-sorter-direction-text';
    directionText.textContent = t('direction.label');
    directionLabel.appendChild(directionCheckbox);
    directionLabel.appendChild(directionText);
    group.appendChild(directionLabel);

    /**
     * Enables/disables the direction checkbox according to the current field and
     * keeps the tooltip in sync (the checkbox has no effect for "default order").
     *
     * @returns {void}
     */
    function syncDirectionAvailability() {
        const isDefaultField = fieldSelect.value === DEFAULT_FIELD;
        directionCheckbox.disabled = isDefaultField;
        directionLabel.classList.toggle('is-disabled', isDefaultField);
        directionLabel.title = isDefaultField ? t('direction.disabledHint') : t('direction.title');
    }
    syncDirectionAvailability();

    /**
     * Normalises the UI state and notifies the controller.
     *
     * @returns {void}
     */
    const handleChange = () => {
        const nextField = normalizeFieldValue(String(fieldSelect.value));
        if (String(fieldSelect.value) !== nextField) {
            fieldSelect.value = nextField;
        }
        syncDirectionAvailability();
        const nextDirection = directionCheckbox.checked ? 'desc' : 'asc';
        if (typeof onChange === 'function') {
            onChange(nextField, nextDirection, apiId);
        }
    };
    if (typeof fieldSelect.addEventListener === 'function') {
        fieldSelect.addEventListener('change', handleChange);
    }
    if (typeof directionCheckbox.addEventListener === 'function') {
        directionCheckbox.addEventListener('change', handleChange);
    }

    // Insert as a sibling of the preset select: prefer the end of the flex row.
    const row = getPresetRow(select);
    let inserted = false;
    if (row && typeof row.appendChild === 'function') {
        row.appendChild(group);
        inserted = true;
    } else if (typeof select.insertAdjacentElement === 'function') {
        select.insertAdjacentElement('afterend', group);
        inserted = true;
    }
    if (!inserted) {
        return null;
    }

    const handle = {
        element: group,
        apiId,
        /**
         * @returns {{field: string, direction: string}} Current control state.
         */
        getState() {
            return {
                field: normalizeFieldValue(String(fieldSelect.value)),
                direction: directionCheckbox.checked ? 'desc' : 'asc',
            };
        },
        /**
         * @param {string} nextField Sort field.
         * @param {string} nextDirection Sort direction.
         * @returns {void}
         */
        setState(nextField, nextDirection) {
            const normalizedNextField = normalizeFieldValue(nextField);
            if (String(fieldSelect.value) !== normalizedNextField) {
                fieldSelect.value = normalizedNextField;
            }
            const wantChecked = normalizeDirectionValue(nextDirection) === 'desc';
            if (Boolean(directionCheckbox.checked) !== wantChecked) {
                directionCheckbox.checked = wantChecked;
            }
            syncDirectionAvailability();
        },
        /**
         * @param {boolean} hidden Whether the control should be hidden.
         * @returns {void}
         */
        setHidden(hidden) {
            group.hidden = !!hidden;
        },
        /**
         * @returns {void}
         */
        dispose() {
            try {
                if (typeof fieldSelect.removeEventListener === 'function') {
                    fieldSelect.removeEventListener('change', handleChange);
                }
                if (typeof directionCheckbox.removeEventListener === 'function') {
                    directionCheckbox.removeEventListener('change', handleChange);
                }
            } catch {
                // Ignore.
            }
            try {
                if (typeof group.remove === 'function') {
                    group.remove();
                }
            } catch {
                // Ignore.
            }
            controlBySelect.delete(select);
        },
    };
    controlBySelect.set(select, handle);
    return handle;
}

/**
 * Observes option list mutations of a preset select.
 *
 * Only `childList` mutations are observed (option attributes/selection are
 * irrelevant for ordering). Mutations are batched into one microtask callback.
 * Non-option nodes are reported as well; callers can filter by `nodeName`.
 *
 * @param {HTMLSelectElement|any} select Preset select element.
 * @param {(records: MutationRecord[]) => void} callback Batch callback.
 * @returns {{disconnect: () => void, takeRecords: () => MutationRecord[]}} Observer handle.
 */
export function observePresetSelect(select, callback) {
    /** @type {{disconnect: () => void, takeRecords: () => MutationRecord[]}} */
    const noopHandle = { disconnect() {}, takeRecords() { return []; } };
    if (!select || typeof callback !== 'function' || typeof MutationObserver !== 'function') {
        return noopHandle;
    }

    /** @type {MutationRecord[]} */
    let pending = [];
    let scheduled = false;

    const observer = new MutationObserver(records => {
        if (!records || records.length === 0) {
            return;
        }
        pending.push(...records);
        if (scheduled) {
            return;
        }
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            const batch = pending;
            pending = [];
            if (batch.length > 0) {
                callback(batch);
            }
        });
    });
    observer.observe(select, { childList: true });

    return {
        disconnect() {
            observer.disconnect();
            pending = [];
        },
        takeRecords() {
            return typeof observer.takeRecords === 'function' ? observer.takeRecords() : [];
        },
    };
}

/**
 * Clean-room custom grouped preset dropdown (v1.3.0).
 *
 * Native `<optgroup>` cannot collapse its headers, so this module renders a
 * custom overlay panel next to the real `<select>`:
 *
 *  - the native `<select>` stays in the DOM as the **single source of truth**
 *    (it is only visually hidden; SillyTavern, toolbars and other extensions
 *    keep reading/writing it normally);
 *  - a trigger button shows the current preset name and opens a fixed-position
 *    panel with collapsible series group headers (default expanded);
 *  - clicking an item only sets the native select value and dispatches a
 *    **native** `change` event (never `jQuery.trigger`), so SillyTavern's own
 *    listeners run exactly as if the user had used the native control;
 *  - any initialization error returns `null`, and the controller falls back to
 *    the plain native list / native `<optgroup>` view.
 *
 * The series-header collapse idea is a behavioral reference to the AGPL-3.0
 * ST-PresetAutoSaveRealTime plugin; no code, HTML or CSS was copied from it.
 *
 * @module preset-sorter/custom-dropdown
 */

import { parsePresetName } from './grouping-engine.js';

/** Class applied to the native select while the custom trigger is shown. @type {string} */
export const NATIVE_SELECT_HIDDEN_CLASS = 'preset-sorter-native-select-hidden';

/** Trigger button class. @type {string} */
const TRIGGER_CLASS = 'preset-sorter-dropdown-trigger';

/** Panel class. @type {string} */
const PANEL_CLASS = 'preset-sorter-dropdown-panel';

/** Item class. @type {string} */
const ITEM_CLASS = 'preset-sorter-dropdown-item';

/** Group header class. @type {string} */
const GROUP_HEADER_CLASS = 'preset-sorter-dropdown-group-header';

/** Group wrapper class. @type {string} */
const GROUP_CLASS = 'preset-sorter-dropdown-group';

/** Selected item class. @type {string} */
const SELECTED_CLASS = 'is-selected';

/** Collapsed group class. @type {string} */
const COLLAPSED_CLASS = 'is-collapsed';

/**
 * @typedef {object} DropdownModel
 * @property {Array<{value: string|number, name?: string}>} [placeholders] Flat pinned options (e.g. kobold `gui`).
 * @property {Array<object>} [entities] Grouped/sorted entities from `computeGroupedEntityOrder`.
 */

/**
 * @typedef {object} DropdownHandle
 * @property {any} element Trigger element.
 * @property {(model?: DropdownModel) => void} sync Refresh trigger label and (if open) panel contents.
 * @property {() => void} open Open the panel.
 * @property {() => void} close Close the panel.
 * @property {(open: boolean) => void} setOpen Set open state.
 * @property {() => boolean} isOpen Whether the panel is open.
 * @property {() => string[]} getCollapsed Collapsed group keys for this API.
 * @property {() => void} destroy Tear down DOM/handlers and restore the native select.
 */

/**
 * Creates a collapsible grouped dropdown bound to a native `<select>`.
 *
 * @param {object} options Options.
 * @param {any} options.select Native preset `<select>` (source of truth).
 * @param {string} [options.apiId] Preset manager API id (collapse-state namespace).
 * @param {() => DropdownModel} [options.getModel] Model provider (called on open/sync without args).
 * @param {(value: string|number) => void} [options.onSelectItem] Optional post-selection callback.
 * @param {Document} [options.document] Document override (tests).
 * @param {Window} [options.window] Window override (tests).
 * @param {(key: string, params?: Record<string, unknown>) => string} [options.t] i18n function.
 * @returns {DropdownHandle|null} Handle, or `null` when the custom view cannot initialize.
 */
export function createGroupedPresetDropdown(options) {
    try {
        return createInternal(options);
    } catch (error) {
        try {
            options?.select?.classList?.remove?.(NATIVE_SELECT_HIDDEN_CLASS);
        } catch {
            // Restoring the native select is best-effort.
        }
        console.error('[preset-sorter] custom dropdown init failed; falling back to native view', error);
        return null;
    }
}

/**
 * @param {object} options Options.
 * @returns {DropdownHandle} Handle.
 */
function createInternal(options) {
    const documentRef = options?.document ?? (typeof document !== 'undefined' ? document : null);
    const windowRef = options?.window ?? (typeof window !== 'undefined' ? window : null);
    const select = options?.select;
    const apiId = String(options?.apiId ?? 'default');
    const getModel = typeof options?.getModel === 'function' ? options.getModel : () => ({});
    const onSelectItem = typeof options?.onSelectItem === 'function' ? options.onSelectItem : null;
    /**
     * @param {string} key i18n key.
     * @param {Record<string, unknown>} [params] Interpolation params.
     * @returns {string} Localized text.
     */
    const t = (key, params) => {
        if (typeof options?.t === 'function') {
            try {
                return options.t(key, params);
            } catch {
                // Fall through to the key itself.
            }
        }
        return key;
    };

    if (!documentRef || typeof documentRef.createElement !== 'function' || !select || typeof select.addEventListener !== 'function') {
        return null;
    }

    /** @type {DropdownModel} */
    let model = { placeholders: [], entities: [] };
    /** @type {Set<string>} */
    const collapsed = new Set();
    let opened = false;
    /** Selected value supplied by `sync({selectedValue})`; native select wins once it changes. @type {string|number|undefined} */
    let externalSelectedValue;
    /** @type {any[]} */
    let focusableRows = [];
    /** @type {number} */
    let lastFocusIndex = -1;
    let destroyed = false;

    /**
     * @param {string} key Collapse-state key.
     * @returns {string} Namespaced key.
     */
    const collapseKey = groupKey => `${apiId}\u0000${groupKey}`;

    /**
     * @param {any} element Element.
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @returns {void}
     */
    function setAttribute(element, name, value) {
        try {
            element?.setAttribute?.(name, value);
        } catch {
            // Attribute support is best-effort.
        }
    }

    /**
     * @param {any} element Element.
     * @param {string} className Class name.
     * @param {boolean} [enabled] Add or remove.
     * @returns {void}
     */
    function toggleClass(element, className, enabled = true) {
        try {
            element?.classList?.toggle?.(className, enabled);
        } catch {
            // Class support is best-effort.
        }
    }

    /**
     * @param {string} tagName Tag name.
     * @param {string} className Class name.
     * @returns {any} Created element.
     */
    function create(tagName, className) {
        const element = documentRef.createElement(tagName);
        if (className) {
            element.className = className;
        }
        return element;
    }

    /**
     * @param {any} element Element.
     * @returns {string} Trimmed text content.
     */
    function textOf(element) {
        return String(element?.textContent ?? '').trim();
    }

    /**
     * @returns {string} Value considered selected for labels/highlights.
     */
    function effectiveSelectedValue() {
        return externalSelectedValue !== undefined ? String(externalSelectedValue) : String(select.value);
    }

    /**
     * @param {string|number} value Option value.
     * @returns {string} Option text for the value ('' when unknown).
     */
    function optionTextForValue(value) {
        const options = Array.isArray(select.options) ? select.options : [];
        for (const option of options) {
            if (String(option?.value) === String(value)) {
                return textOf(option);
            }
        }
        const children = Array.isArray(select.childNodes) ? select.childNodes : [];
        for (const child of children) {
            if (String(child?.value) === String(value)) {
                return textOf(child);
            }
        }
        return '';
    }

    // ---------------------------------------------------------------------
    // Native select hiding + trigger
    // ---------------------------------------------------------------------

    try {
        select.classList?.add?.(NATIVE_SELECT_HIDDEN_CLASS);
    } catch {
        // Visual hiding is best-effort; the panel still works.
    }

    const trigger = create('button', TRIGGER_CLASS);
    trigger.type = 'button';
    setAttribute(trigger, 'aria-haspopup', 'listbox');
    setAttribute(trigger, 'aria-expanded', 'false');
    const triggerLabel = create('span', 'preset-sorter-dropdown-label');
    const triggerChevron = create('i', 'fa-solid fa-chevron-down preset-sorter-dropdown-chevron');
    setAttribute(triggerChevron, 'aria-hidden', 'true');
    trigger.appendChild(triggerLabel);
    trigger.appendChild(triggerChevron);

    try {
        if (typeof select.insertAdjacentElement === 'function') {
            select.insertAdjacentElement('afterend', trigger);
        } else if (select.parentNode) {
            select.parentNode.insertBefore(trigger, select.nextSibling);
        }
    } catch (error) {
        console.error('[preset-sorter] failed to insert dropdown trigger', error);
        try {
            select.classList?.remove?.(NATIVE_SELECT_HIDDEN_CLASS);
        } catch {
            // Ignore.
        }
        return null;
    }

    const panel = create('div', PANEL_CLASS);
    setAttribute(panel, 'role', 'listbox');
    setAttribute(panel, 'aria-label', t('dropdown.label'));
    panel.hidden = true;

    // ---------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------

    /**
     * @param {string|number} value Option value.
     * @param {string} name Display name.
     * @param {object} [extra] Extra metadata.
     * @param {object} [extra.group] Owning group entity.
     * @returns {any} Item row.
     */
    function buildItemRow(value, name, extra = {}) {
        const row = create('button', ITEM_CLASS);
        row.type = 'button';
        setAttribute(row, 'role', 'option');
        setAttribute(row, 'data-value', String(value));
        setAttribute(row, 'tabindex', '-1');
        if (extra.group?.key) {
            setAttribute(row, 'data-group-key', String(extra.group.key));
        }
        const selected = effectiveSelectedValue() === String(value);
        setAttribute(row, 'aria-selected', selected ? 'true' : 'false');
        toggleClass(row, SELECTED_CLASS, selected);
        const check = create('i', 'fa-solid fa-check preset-sorter-dropdown-check');
        setAttribute(check, 'aria-hidden', 'true');
        const label = create('span', 'preset-sorter-dropdown-item-label');
        label.textContent = name;
        row.appendChild(check);
        row.appendChild(label);
        const version = parsePresetName(name).version;
        if (version) {
            const meta = create('span', 'preset-sorter-dropdown-version');
            meta.textContent = version;
            row.appendChild(meta);
        }
        row.title = name;
        bindRowEvents(row);
        focusableRows.push(row);
        return row;
    }

    /**
     * @param {object} group Group entity.
     * @returns {any} Group wrapper.
     */
    function buildGroup(group) {
        const wrapper = create('div', GROUP_CLASS);
        setAttribute(wrapper, 'role', 'group');
        const baseLabel = String(group.baseLabel ?? group.label ?? '');
        setAttribute(wrapper, 'aria-label', baseLabel);
        const isCollapsed = collapsed.has(collapseKey(group.key));
        toggleClass(wrapper, COLLAPSED_CLASS, isCollapsed);

        const header = create('button', GROUP_HEADER_CLASS);
        header.type = 'button';
        setAttribute(header, 'data-group-key', String(group.key));
        setAttribute(header, 'aria-expanded', isCollapsed ? 'false' : 'true');
        setAttribute(header, 'tabindex', '-1');
        header.title = t(isCollapsed ? 'dropdown.expand' : 'dropdown.collapse');
        const chevron = create('i', 'fa-solid fa-chevron-right preset-sorter-dropdown-group-chevron');
        setAttribute(chevron, 'aria-hidden', 'true');
        const headerLabel = create('span', 'preset-sorter-dropdown-group-label');
        headerLabel.textContent = baseLabel;
        const count = create('span', 'preset-sorter-dropdown-group-count');
        count.textContent = `(${group.members.length})`;
        header.appendChild(chevron);
        header.appendChild(headerLabel);
        header.appendChild(count);
        bindRowEvents(header);
        wrapper.appendChild(header);
        focusableRows.push(header);

        if (!isCollapsed) {
            const members = Array.isArray(group.members) ? group.members : [];
            for (const member of members) {
                wrapper.appendChild(buildItemRow(member.value, member.name, { group }));
            }
        }
        return wrapper;
    }

    /**
     * Renders the panel from the current model, preserving scroll position.
     *
     * @returns {void}
     */
    function renderPanel() {
        const previousScroll = Number(panel.scrollTop) || 0;
        panel.textContent = '';
        focusableRows = [];
        lastFocusIndex = -1;
        const placeholders = Array.isArray(model.placeholders) ? model.placeholders : [];
        for (const placeholder of placeholders) {
            const name = placeholder.name ?? optionTextForValue(placeholder.value);
            const row = buildItemRow(placeholder.value, name);
            row.classList?.add?.('is-placeholder');
            panel.appendChild(row);
        }
        const entities = Array.isArray(model.entities) ? model.entities : [];
        for (const entity of entities) {
            if (!entity || typeof entity !== 'object') {
                continue;
            }
            if (entity.type === 'group') {
                panel.appendChild(buildGroup(entity));
            } else if (entity.type === 'option') {
                const name = entity.name ?? (entity.item ? entity.item.name : '') ?? optionTextForValue(entity.value);
                panel.appendChild(buildItemRow(entity.value, name));
            }
        }
        try {
            panel.scrollTop = previousScroll;
        } catch {
            // Scroll support is best-effort.
        }
        if (!panel.firstChild) {
            const empty = create('div', 'preset-sorter-dropdown-empty');
            empty.textContent = '—';
            panel.appendChild(empty);
        }
    }

    /**
     * @returns {string} Current trigger label.
     */
    function currentLabel() {
        const selectedValue = effectiveSelectedValue();
        const selectedOption = (Array.isArray(select.options) ? select.options : [])
            .find(option => String(option?.value) === selectedValue);
        const text = textOf(selectedOption) || optionTextForValue(selectedValue);
        if (text) {
            return text;
        }
        // Grouped-model fallback: show "Series · version" from the model.
        for (const entity of Array.isArray(model.entities) ? model.entities : []) {
            if (entity?.type === 'group') {
                const member = (entity.members ?? []).find(item => String(item.value) === selectedValue);
                if (member) {
                    const version = parsePresetName(member.name).version;
                    return version ? `${entity.baseLabel} · ${version}` : entity.baseLabel;
                }
            } else if (entity?.type === 'option' && String(entity.value) === selectedValue) {
                return entity.name ?? '';
            }
        }
        return selectedValue ?? '';
    }

    /**
     * @returns {void}
     */
    function updateTriggerLabel() {
        const label = currentLabel() || '—';
        triggerLabel.textContent = label;
        trigger.title = label;
        setAttribute(trigger, 'aria-label', `${t('dropdown.label')}: ${label}`);
    }

    // ---------------------------------------------------------------------
    // Selection
    // ---------------------------------------------------------------------

    /**
     * Dispatches the native `change` event (never jQuery.trigger).
     *
     * @returns {void}
     */
    function dispatchNativeChange() {
        /** @type {any} */
        let eventObject = null;
        const EventCtor = windowRef?.Event ?? (typeof Event !== 'undefined' ? Event : null);
        if (EventCtor) {
            try {
                eventObject = new EventCtor('change', { bubbles: true });
            } catch {
                eventObject = null;
            }
        }
        if (!eventObject) {
            try {
                if (typeof documentRef.createEvent === 'function') {
                    eventObject = documentRef.createEvent('Event');
                    eventObject.initEvent('change', true, false);
                }
            } catch {
                eventObject = null;
            }
        }
        if (!eventObject) {
            eventObject = { type: 'change', bubbles: true };
        }
        try {
            select.dispatchEvent(eventObject);
        } catch (error) {
            console.error('[preset-sorter] failed to dispatch native change', error);
        }
    }

    /**
     * Applies a value to the native select and notifies SillyTavern.
     *
     * @param {string|number} value Option value.
     * @returns {void}
     */
    function selectValue(value) {
        externalSelectedValue = undefined;
        const options = Array.isArray(select.options) ? select.options : [];
        let matched = null;
        for (const option of options) {
            if (String(option?.value) === String(value)) {
                matched = option;
                break;
            }
        }
        try {
            if (matched) {
                matched.selected = true;
            }
            select.value = String(value);
        } catch (error) {
            console.error('[preset-sorter] failed to set native select value', error);
        }
        dispatchNativeChange();
        updateTriggerLabel();
        close();
        onSelectItem?.(value);
    }

    // ---------------------------------------------------------------------
    // Open / close / positioning
    // ---------------------------------------------------------------------

    /**
     * Positions the panel under the trigger (fixed coordinates).
     *
     * @returns {void}
     */
    function positionPanel() {
        try {
            const rect = typeof trigger.getBoundingClientRect === 'function'
                ? trigger.getBoundingClientRect()
                : null;
            const viewportWidth = Number(windowRef?.innerWidth) || 0;
            const viewportHeight = Number(windowRef?.innerHeight) || 0;
            const left = Math.max(0, Number(rect?.left) || 0);
            const width = Math.max(220, Math.min(Number(rect?.width) || 0, viewportWidth || 320));
            let top = (Number(rect?.bottom) || 0) + 4;
            if (viewportHeight > 0 && top + 240 > viewportHeight) {
                top = Math.max(0, (Number(rect?.top) || 0) - 244);
            }
            panel.style.position = 'fixed';
            panel.style.left = `${left}px`;
            panel.style.top = `${top}px`;
            panel.style.width = `${width}px`;
            panel.style.zIndex = '10000';
        } catch {
            // Positioning is best-effort; CSS fallback keeps the panel usable.
        }
    }

    /**
     * @returns {void}
     */
    function focusRow(index) {
        const rows = focusableRows;
        if (rows.length === 0) {
            return;
        }
        const clamped = Math.max(0, Math.min(index, rows.length - 1));
        lastFocusIndex = clamped;
        try {
            rows[clamped]?.focus?.();
        } catch {
            // Focus is best-effort.
        }
    }

    /**
     * @param {number} delta Relative row movement.
     * @returns {void}
     */
    function moveFocus(delta) {
        const rows = focusableRows;
        if (rows.length === 0) {
            return;
        }
        let start = lastFocusIndex;
        try {
            const active = documentRef.activeElement;
            const activeIndex = rows.indexOf(active);
            if (activeIndex >= 0) {
                start = activeIndex;
            }
        } catch {
            // Ignore.
        }
        focusRow(start + delta);
    }

    /**
     * @param {any} row Focused row.
     * @returns {void}
     */
    function activateRow(row) {
        if (!row) {
            return;
        }
        if (row.classList?.contains?.(GROUP_HEADER_CLASS)) {
            const groupKey = row.getAttribute('data-group-key');
            if (!groupKey) {
                return;
            }
            const namespaced = collapseKey(groupKey);
            if (collapsed.has(namespaced)) {
                collapsed.delete(namespaced);
            } else {
                collapsed.add(namespaced);
            }
            const previousScroll = Number(panel.scrollTop) || 0;
            renderPanel();
            try {
                panel.scrollTop = previousScroll;
            } catch {
                // Ignore.
            }
            const header = focusableRows.find(candidate => String(candidate.getAttribute?.('data-group-key')) === String(groupKey)
                && candidate.classList?.contains?.(GROUP_HEADER_CLASS));
            try {
                header?.focus?.();
            } catch {
                // Ignore.
            }
            return;
        }
        const value = row.getAttribute('data-value');
        if (value === null || value === undefined) {
            return;
        }
        // Recover the original (possibly numeric-string) value from the model.
        let resolved = value;
        for (const entity of Array.isArray(model.entities) ? model.entities : []) {
            if (entity?.type === 'group') {
                const member = (entity.members ?? []).find(item => String(item.value) === String(value));
                if (member) {
                    resolved = member.value;
                    break;
                }
            } else if (entity?.type === 'option' && String(entity.value) === String(value)) {
                resolved = entity.value;
                break;
            }
        }
        selectValue(resolved);
    }

    /**
     * @param {any} event Keyboard event.
     * @returns {boolean} Whether the event was handled.
     */
    function handlePanelKeydown(event) {
        const key = String(event?.key ?? '');
        if (key === 'Escape') {
            event.preventDefault?.();
            close();
            return true;
        }
        if (key === 'Tab') {
            close();
            return false;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault?.();
            moveFocus(key === 'ArrowDown' ? 1 : -1);
            return true;
        }
        if (key === 'Home' || key === 'End') {
            event.preventDefault?.();
            focusRow(key === 'Home' ? 0 : focusableRows.length - 1);
            return true;
        }
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            event.preventDefault?.();
            let row = null;
            try {
                const active = documentRef.activeElement;
                row = focusableRows.includes(active) ? active : focusableRows[lastFocusIndex] ?? null;
            } catch {
                row = focusableRows[lastFocusIndex] ?? null;
            }
            activateRow(row);
            return true;
        }
        return false;
    }

    /**
     * @param {any} event Pointer event.
     * @returns {void}
     */
    function handleDocumentPointerDown(event) {
        const target = event?.target;
        try {
            if (trigger.contains?.(target) || panel.contains?.(target)) {
                return;
            }
        } catch {
            // Ignore containment errors.
        }
        close();
    }

    /**
     * @returns {void}
     */
    function handleViewportChange() {
        if (opened) {
            positionPanel();
        }
    }

    /**
     * @param {KeyboardEvent} event Keyboard event.
     * @returns {void}
     */
    function handleDocumentKeydown(event) {
        if (opened && String(event?.key ?? '') === 'Escape') {
            event.preventDefault?.();
            close();
        }
    }

    /**
     * @returns {void}
     */
    function addGlobalListeners() {
        try {
            documentRef.addEventListener?.('pointerdown', handleDocumentPointerDown, true);
            documentRef.addEventListener?.('keydown', handleDocumentKeydown, true);
            windowRef?.addEventListener?.('scroll', handleViewportChange, true);
            windowRef?.addEventListener?.('resize', handleViewportChange);
        } catch {
            // Global listeners are best-effort.
        }
    }

    /**
     * @returns {void}
     */
    function removeGlobalListeners() {
        try {
            documentRef.removeEventListener?.('pointerdown', handleDocumentPointerDown, true);
            documentRef.removeEventListener?.('keydown', handleDocumentKeydown, true);
            windowRef?.removeEventListener?.('scroll', handleViewportChange, true);
            windowRef?.removeEventListener?.('resize', handleViewportChange);
        } catch {
            // Ignore.
        }
    }

    /**
     * Opens the panel.
     *
     * @returns {void}
     */
    function open() {
        if (destroyed || opened) {
            return;
        }
        const nextModel = safeGetModel();
        if (nextModel) {
            model = nextModel;
        }
        renderPanel();
        try {
            if (!panel.parentNode) {
                documentRef.body?.appendChild?.(panel);
            }
            panel.hidden = false;
        } catch (error) {
            console.error('[preset-sorter] failed to show dropdown panel', error);
            return;
        }
        opened = true;
        setAttribute(trigger, 'aria-expanded', 'true');
        toggleClass(trigger, 'is-open', true);
        positionPanel();
        addGlobalListeners();
        focusRow(0);
    }

    /**
     * Closes the panel and returns focus to the trigger.
     *
     * @returns {void}
     */
    function close() {
        if (!opened) {
            return;
        }
        opened = false;
        panel.hidden = true;
        setAttribute(trigger, 'aria-expanded', 'false');
        toggleClass(trigger, 'is-open', false);
        removeGlobalListeners();
        if (panel.parentNode) {
            try {
                panel.parentNode.removeChild(panel);
            } catch {
                // Ignore removal errors.
            }
        }
        try {
            trigger.focus?.();
        } catch {
            // Focus is best-effort.
        }
    }

    /**
     * @param {boolean} nextOpen Desired open state.
     * @returns {void}
     */
    function setOpen(nextOpen) {
        if (nextOpen) {
            open();
        } else {
            close();
        }
    }

    /**
     * @returns {boolean} Current open state.
     */
    function isOpen() {
        return opened;
    }

    /**
     * @returns {DropdownModel|null} Model from the provider, or `null` on failure.
     */
    function safeGetModel() {
        try {
            const result = getModel();
            if (!result || typeof result !== 'object') {
                return null;
            }
            return {
                placeholders: Array.isArray(result.placeholders) ? result.placeholders : [],
                entities: Array.isArray(result.entities) ? result.entities : [],
            };
        } catch (error) {
            console.error('[preset-sorter] dropdown model provider failed', error);
            return null;
        }
    }

    /**
     * @param {DropdownModel} [nextModel] New model (defaults to the provider).
     * @returns {void}
     */
    function sync(nextModel) {
        if (destroyed) {
            return;
        }
        const resolved = nextModel && typeof nextModel === 'object' ? nextModel : safeGetModel();
        externalSelectedValue = resolved && resolved.selectedValue !== undefined
            ? resolved.selectedValue
            : undefined;
        if (resolved) {
            model = {
                placeholders: Array.isArray(resolved.placeholders) ? resolved.placeholders : [],
                entities: Array.isArray(resolved.entities) ? resolved.entities : [],
            };
        }
        updateTriggerLabel();
        if (opened) {
            renderPanel();
        }
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /**
     * Finds the row element an event belongs to.
     *
     * @param {any} event Event.
     * @returns {any} Row element or `null`.
     */
    function eventRow(event) {
        const direct = event?.currentTarget;
        try {
            if (direct?.classList?.contains?.(ITEM_CLASS) || direct?.classList?.contains?.(GROUP_HEADER_CLASS)) {
                return direct;
            }
        } catch {
            // Ignore.
        }
        try {
            return event?.target?.closest?.(`.${ITEM_CLASS}, .${GROUP_HEADER_CLASS}`) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Direct row click handler (works even in non-bubbling test doubles).
     *
     * @param {any} event Click event.
     * @returns {void}
     */
    const onDirectRowClick = event => {
        if (!event || event._presetSorterHandled) {
            return;
        }
        try {
            event._presetSorterHandled = true;
        } catch {
            // Event may be frozen/read-only; the delegation handler also guards.
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        activateRow(eventRow(event));
    };

    /**
     * Direct row keyboard handler.
     *
     * @param {any} event Keyboard event.
     * @returns {void}
     */
    const onDirectRowKeydown = event => {
        if (handlePanelKeydown(event)) {
            event?.preventDefault?.();
            event?.stopPropagation?.();
        }
    };

    /**
     * @param {any} row Row element.
     * @returns {void}
     */
    function bindRowEvents(row) {
        try {
            row.addEventListener?.('click', onDirectRowClick);
            row.addEventListener?.('keydown', onDirectRowKeydown);
        } catch {
            // Binding is best-effort; panel delegation remains as a fallback.
        }
    }

    const onTriggerClick = event => {
        event?.preventDefault?.();
        if (opened) {
            close();
        } else {
            open();
        }
    };
    const onTriggerKeydown = event => {
        const key = String(event?.key ?? '');
        if (key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'ArrowDown' || key === 'ArrowUp') {
            event.preventDefault?.();
            if (!opened) {
                open();
            }
            if (key === 'ArrowUp') {
                focusRow(focusableRows.length - 1);
            }
        } else if (key === 'Escape') {
            close();
        }
    };
    const onPanelClick = event => {
        const target = event?.target;
        let row = null;
        try {
            row = target?.closest?.(`.${ITEM_CLASS}, .${GROUP_HEADER_CLASS}`) ?? null;
        } catch {
            row = null;
        }
        if (!row) {
            return;
        }
        event?.preventDefault?.();
        event?.stopPropagation?.();
        activateRow(row);
    };
    const onPanelKeydown = event => {
        if (handlePanelKeydown(event)) {
            event?.stopPropagation?.();
        }
    };
    const onNativeChange = () => {
        if (destroyed) {
            return;
        }
        // The native select is the source of truth: drop any label-only override.
        externalSelectedValue = undefined;
        updateTriggerLabel();
        if (opened) {
            renderPanel();
        }
    };

    trigger.addEventListener('click', onTriggerClick);
    trigger.addEventListener('keydown', onTriggerKeydown);
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('keydown', onPanelKeydown);
    select.addEventListener('change', onNativeChange);

    updateTriggerLabel();

    return {
        element: trigger,
        sync,
        open,
        close,
        setOpen,
        isOpen,
        getCollapsed() {
            return Array.from(collapsed)
                .filter(key => key.startsWith(`${apiId}\u0000`))
                .map(key => key.slice(apiId.length + 1));
        },
        destroy() {
            if (destroyed) {
                return;
            }
            destroyed = true;
            removeGlobalListeners();
            try {
                trigger.removeEventListener?.('click', onTriggerClick);
                trigger.removeEventListener?.('keydown', onTriggerKeydown);
                panel.removeEventListener?.('click', onPanelClick);
                panel.removeEventListener?.('keydown', onPanelKeydown);
                select.removeEventListener?.('change', onNativeChange);
            } catch {
                // Ignore.
            }
            if (panel.parentNode) {
                try {
                    panel.parentNode.removeChild(panel);
                } catch {
                    // Ignore.
                }
            }
            try {
                trigger.parentNode?.removeChild?.(trigger);
            } catch {
                // Ignore.
            }
            try {
                select.classList?.remove?.(NATIVE_SELECT_HIDDEN_CLASS);
            } catch {
                // Ignore.
            }
        },
    };
}

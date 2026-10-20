/**
 * Settings panel view layer (v1.2.0: field + direction + native-optgroup grouping).
 *
 * The panel markup lives in `settings.html` (rendered by the controller through
 * `renderExtensionTemplateAsync`) and is deliberately language-neutral; this
 * module localizes every label and binds the controls. It only mutates the live
 * settings object through the injected callbacks — persistence stays in the
 * controller.
 *
 * The sort controls mirror the injected per-manager group: an independent
 * **sort field** select plus an independent **倒序 / Descending** checkbox.
 * The grouping section exposes an on/off switch, the auto-detect mode
 * (smart/strict) and a group manager (search + per-preset group override input +
 * "不分组" checkbox + save/reset) backed by controller callbacks.
 *
 * Top-level code is side-effect free (no DOM access at import time).
 *
 * @module preset-sorter/settings-ui
 */

import {
    DEFAULT_DIRECTION,
    DEFAULT_FIELD,
    DEFAULT_GROUPING_MODE,
    DIRECTION_ORDER,
    FIELD_ORDER,
    GROUPING_MODE_ORDER,
    GROUPING_MODES,
    GROUPING_UNGROUPED,
} from './constants.js';
import { formatFieldLabel, formatSortSpec, t } from './i18n.js';

/**
 * @typedef {object} SettingsUiDiagnostics
 * @property {boolean} fsAvailable Filesystem timestamps usable.
 * @property {boolean} [fsInitialized] Host directories resolved.
 * @property {string|null} [fsReason] Why fs is unavailable/disabled.
 * @property {string|null} [dataRoot] Resolved data root.
 * @property {string|null} [fsSource] Data root / directory source label.
 * @property {string|null} [handle] Current user handle.
 * @property {number} known Tracked presets.
 * @property {number} used Presets with usage records.
 * @property {number} importTimes Presets with resolved import times.
 * @property {boolean} [groupingEnabled] Grouping switch state.
 * @property {string} [groupingMode] Grouping auto-detect mode.
 * @property {number} [groupCount] Detected/manual group count.
 * @property {number} [groupingPresetCount] Presets available for grouping.
 * @property {number} [groupedPresetCount] Presets currently inside a group.
 * @property {number} [groupingOverrideCount] Manual override count.
 */

/**
 * @typedef {object} GroupingManagerPreset
 * @property {string} name Preset name.
 * @property {string} autoGroup Auto-detected group label ('' when none).
 * @property {string} override Manual override value (`''`, group name, or `__ungrouped__`).
 */

/**
 * @typedef {object} GroupingManagerApi
 * @property {string} apiId API id.
 * @property {string} [labelKey] i18n key of the API label.
 * @property {GroupingManagerPreset[]} presets Preset rows.
 * @property {number} groupCount Group count for this API.
 * @property {number} presetCount Preset count for this API.
 */

/**
 * @typedef {object} GroupingManagerData
 * @property {boolean} enabled Grouping switch state.
 * @property {string} mode Grouping mode.
 * @property {GroupingManagerApi[]} apis Per-API data.
 * @property {{groups: number, presets: number, grouped: number, manual: number}} summary Aggregate counts.
 */

/**
 * @typedef {object} SettingsUiOptions
 * @property {object} settings Live settings object (mutated by the UI).
 * @property {(patch: {field?: string, direction?: string, enabled?: boolean, applyToAll?: boolean, groupingEnabled?: boolean, groupingMode?: string}) => void} [onChange] Called after a control change.
 * @property {() => Promise<void>|void} [onRefresh] Refresh import times handler.
 * @property {() => Promise<void>|void} [onResetUsage] Reset usage handler.
 * @property {() => Promise<boolean>|boolean} [confirmReset] Confirmation for usage reset.
 * @property {() => SettingsUiDiagnostics} [getDiagnostics] Diagnostics provider.
 * @property {() => GroupingManagerData} [getGroupingManagerData] Group manager data provider.
 * @property {(overridesByApi: Record<string, Record<string, string>>) => void} [onSaveGroupingOverrides] Save manual group overrides.
 * @property {() => void} [onResetGroupingOverrides] Reset manual group overrides.
 * @property {Document|null} [document] Document override (tests).
 */

/**
 * @typedef {object} SettingsPanelHandle
 * @property {(state: {settings?: object, diagnostics?: SettingsUiDiagnostics, busy?: boolean}) => void} update Re-render the panel from state.
 * @property {(diagnostics: SettingsUiDiagnostics) => void} updateDiagnostics Update only the diagnostics block.
 * @property {(busy: boolean) => void} setBusy Toggle the refresh button busy state.
 * @property {() => void} refreshGroupManager Re-render the group manager (if open).
 * @property {() => void} destroy Remove event listeners.
 */

/**
 * @param {unknown} field Raw sort field.
 * @returns {string} Normalised field.
 */
function normalizeField(field) {
    return FIELD_ORDER.includes(field) ? field : DEFAULT_FIELD;
}

/**
 * @param {unknown} direction Raw sort direction.
 * @returns {string} Normalised direction.
 */
function normalizeDirection(direction) {
    return DIRECTION_ORDER.includes(direction) ? direction : DEFAULT_DIRECTION;
}

/**
 * @param {unknown} mode Raw grouping mode.
 * @returns {string} Normalised grouping mode.
 */
function normalizeGroupingMode(mode) {
    return GROUPING_MODE_ORDER.includes(mode) ? mode : DEFAULT_GROUPING_MODE;
}

/**
 * @param {object} settings Settings object.
 * @returns {{field: string, direction: string}} Normalised sort spec.
 */
function readDefaultSortSpec(settings) {
    const source = settings && typeof settings.default === 'object' && settings.default !== null
        ? settings.default
        : {};
    return {
        field: normalizeField(source.field),
        direction: normalizeDirection(source.direction),
    };
}

/**
 * @param {object} settings Settings object.
 * @returns {{enabled: boolean, mode: string, overrides: Record<string, Record<string, string>>}} Normalised grouping settings.
 */
function readGroupingSettings(settings) {
    const source = settings && typeof settings.grouping === 'object' && settings.grouping !== null
        ? settings.grouping
        : {};
    return {
        enabled: source.enabled !== false,
        mode: normalizeGroupingMode(source.mode),
        overrides: source.overrides && typeof source.overrides === 'object' && !Array.isArray(source.overrides)
            ? source.overrides
            : {},
    };
}

/**
 * Mounts the settings panel: localizes labels, fills the selects, wires the
 * independent direction checkbox, the grouping switch and the group manager.
 *
 * @param {SettingsUiOptions} options Panel options.
 * @returns {SettingsPanelHandle|null} Panel handle, or `null` when the markup is not present.
 */
export function mountSettingsPanel(options) {
    const documentRef = options?.document ?? (typeof document !== 'undefined' ? document : null);
    if (!documentRef || typeof documentRef.getElementById !== 'function') {
        return null;
    }

    const settings = options.settings;
    if (!settings.grouping || typeof settings.grouping !== 'object') {
        settings.grouping = { enabled: true, mode: DEFAULT_GROUPING_MODE, overrides: {} };
    }
    const byId = id => documentRef.getElementById(id);

    const elements = {
        root: byId('preset_sorter_settings'),
        title: byId('preset_sorter_title'),
        enabled: byId('preset_sorter_enabled'),
        enabledLabel: byId('preset_sorter_enabled_label'),
        field: byId('preset_sorter_field'),
        fieldLabel: byId('preset_sorter_field_label'),
        direction: byId('preset_sorter_direction'),
        directionLabel: byId('preset_sorter_direction_label'),
        effectiveHint: byId('preset_sorter_effective_hint'),
        applyAll: byId('preset_sorter_apply_all'),
        applyAllLabel: byId('preset_sorter_apply_all_label'),
        groupingEnabled: byId('preset_sorter_grouping_enabled'),
        groupingEnabledLabel: byId('preset_sorter_grouping_enabled_label'),
        groupingMode: byId('preset_sorter_grouping_mode'),
        groupingModeLabel: byId('preset_sorter_grouping_mode_label'),
        groupingHint: byId('preset_sorter_grouping_hint'),
        groupingCounts: byId('preset_sorter_grouping_counts'),
        manageGroups: byId('preset_sorter_manage_groups'),
        manager: byId('preset_sorter_group_manager'),
        managerTitle: byId('preset_sorter_group_manager_title'),
        managerHint: byId('preset_sorter_group_manager_hint'),
        groupSearch: byId('preset_sorter_group_search'),
        managerBody: byId('preset_sorter_group_manager_body'),
        groupSave: byId('preset_sorter_group_save'),
        groupReset: byId('preset_sorter_group_reset'),
        groupStatus: byId('preset_sorter_group_status'),
        refresh: byId('preset_sorter_refresh'),
        resetUsage: byId('preset_sorter_reset_usage'),
        diagnostics: byId('preset_sorter_diagnostics'),
        hint: byId('preset_sorter_hint'),
    };

    if (!elements.root) {
        return null;
    }

    /**
     * @param {any} element Element.
     * @param {string} key i18n key.
     * @returns {void}
     */
    function setText(element, key) {
        if (element) {
            element.textContent = t(key);
        }
    }

    /**
     * @param {any} element Element.
     * @param {string} key i18n key used as title.
     * @returns {void}
     */
    function setTitle(element, key) {
        if (element) {
            element.title = t(key);
        }
    }

    /**
     * @param {string} tagName Tag name.
     * @param {string} className CSS class.
     * @param {string} [text] Text content.
     * @returns {any} Created element.
     */
    function createElement(tagName, className, text) {
        const element = documentRef.createElement(tagName);
        if (className) {
            element.className = className;
        }
        if (text !== undefined) {
            element.textContent = text;
        }
        return element;
    }

    setText(elements.title, 'panel.title');
    setText(elements.enabledLabel, 'panel.enabled');
    setTitle(elements.enabled, 'panel.enabledHint');
    setText(elements.fieldLabel, 'panel.defaultField');
    setTitle(elements.field, 'panel.defaultFieldHint');
    setText(elements.directionLabel, 'direction.desc');
    setText(elements.applyAllLabel, 'panel.applyAll');
    setTitle(elements.applyAll, 'panel.applyAllHint');
    setText(elements.groupingEnabledLabel, 'grouping.enabled');
    setTitle(elements.groupingEnabled, 'grouping.enabledHint');
    setText(elements.groupingModeLabel, 'grouping.mode');
    setTitle(elements.groupingMode, 'grouping.modeHint');
    setText(elements.groupingHint, 'grouping.modeHint');
    setText(elements.manageGroups, 'grouping.manage');
    setText(elements.managerTitle, 'grouping.managerTitle');
    setText(elements.managerHint, 'grouping.managerHint');
    setText(elements.groupSave, 'grouping.save');
    setText(elements.groupReset, 'grouping.reset');
    setText(elements.refresh, 'panel.refresh');
    setTitle(elements.refresh, 'panel.refreshHint');
    setText(elements.resetUsage, 'panel.resetUsage');
    setTitle(elements.resetUsage, 'panel.resetUsageHint');
    setText(elements.hint, 'panel.refreshHint');
    setTitle(elements.direction, 'direction.title');
    if (elements.groupSearch) {
        elements.groupSearch.placeholder = t('grouping.search');
        elements.groupSearch.title = t('grouping.search');
    }

    // Fill selects once (they start empty in settings.html).
    if (elements.field) {
        const existingOptions = elements.field.options;
        if (!existingOptions || existingOptions.length === 0) {
            for (const field of FIELD_ORDER) {
                const option = documentRef.createElement('option');
                option.value = field;
                option.textContent = formatFieldLabel(field);
                elements.field.appendChild(option);
            }
        }
    }
    if (elements.groupingMode) {
        const existingOptions = elements.groupingMode.options;
        if (!existingOptions || existingOptions.length === 0) {
            const modeLabels = {
                [GROUPING_MODES.SMART]: 'grouping.modeSmart',
                [GROUPING_MODES.STRICT]: 'grouping.modeStrict',
            };
            for (const mode of GROUPING_MODE_ORDER) {
                const option = documentRef.createElement('option');
                option.value = mode;
                option.textContent = t(modeLabels[mode] ?? 'grouping.modeSmart');
                elements.groupingMode.appendChild(option);
            }
        }
    }

    /** @type {GroupingManagerData|null} */
    let latestManagerData = null;
    let managerDirty = false;

    /**
     * Enables/disables and dims the direction checkbox according to the field.
     *
     * @returns {void}
     */
    function syncDirectionAvailability() {
        const isDefaultField = String(elements.field?.value ?? DEFAULT_FIELD) === DEFAULT_FIELD;
        if (elements.direction) {
            elements.direction.disabled = isDefaultField;
        }
        const directionRow = elements.directionLabel?.closest?.('.preset-sorter-direction-row')
            ?? elements.directionLabel?.parentElement
            ?? null;
        if (directionRow && directionRow.classList && typeof directionRow.classList.toggle === 'function') {
            directionRow.classList.toggle('is-disabled', isDefaultField);
        }
        if (elements.direction) {
            elements.direction.title = isDefaultField ? t('direction.disabledHint') : t('direction.title');
        }
    }

    /**
     * Updates the localized effective-mode hint line.
     *
     * @returns {void}
     */
    function syncEffectiveHint() {
        if (!elements.effectiveHint) {
            return;
        }
        const spec = readDefaultSortSpec(settings);
        const description = spec.field === DEFAULT_FIELD
            ? formatFieldLabel(DEFAULT_FIELD)
            : formatSortSpec(spec);
        elements.effectiveHint.textContent = t('panel.effectiveHint', { mode: description });
    }

    /**
     * Synchronizes all controls from the live settings object.
     *
     * @returns {void}
     */
    function syncFromSettings() {
        if (elements.enabled) {
            elements.enabled.checked = !!settings.enabled;
        }
        if (elements.applyAll) {
            elements.applyAll.checked = !!settings.applyToAll;
        }
        const spec = readDefaultSortSpec(settings);
        if (elements.field && String(elements.field.value) !== spec.field) {
            elements.field.value = spec.field;
        }
        if (elements.direction) {
            elements.direction.checked = spec.direction === 'desc';
        }
        syncDirectionAvailability();
        syncEffectiveHint();
        syncGroupingControls();
    }

    /**
     * Synchronizes the grouping controls (switch, mode, counts).
     *
     * @returns {void}
     */
    function syncGroupingControls() {
        const grouping = readGroupingSettings(settings);
        if (elements.groupingEnabled) {
            elements.groupingEnabled.checked = grouping.enabled;
        }
        if (elements.groupingMode && String(elements.groupingMode.value) !== grouping.mode) {
            elements.groupingMode.value = grouping.mode;
        }
    }

    /**
     * Updates the grouping counts line from the latest manager data.
     *
     * @returns {void}
     */
    function syncGroupingCounts() {
        if (!elements.groupingCounts) {
            return;
        }
        if (!latestManagerData) {
            elements.groupingCounts.textContent = '';
            return;
        }
        const { summary } = latestManagerData;
        elements.groupingCounts.textContent = t('grouping.status', {
            groups: summary.groups,
            presets: summary.presets,
            manual: summary.manual,
        });
    }

    /**
     * @returns {boolean} Whether the refresh button is currently busy.
     */
    let busy = false;

    /**
     * @param {boolean} nextBusy Busy state.
     * @returns {void}
     */
    function setBusy(nextBusy) {
        busy = !!nextBusy;
        if (elements.refresh) {
            elements.refresh.disabled = busy;
            elements.refresh.textContent = busy ? t('panel.refreshing') : t('panel.refresh');
        }
        if (elements.resetUsage) {
            elements.resetUsage.disabled = busy;
        }
    }

    /**
     * Renders the diagnostics block.
     *
     * @param {SettingsUiDiagnostics|null|undefined} diagnostics Diagnostics data.
     * @returns {void}
     */
    function renderDiagnostics(diagnostics) {
        const container = elements.diagnostics;
        if (!container) {
            return;
        }
        if (!diagnostics) {
            container.textContent = '';
            return;
        }

        const lines = [];
        const fsValue = diagnostics.fsAvailable
            ? t('panel.diagAvailable')
            : t('panel.diagUnavailable');
        lines.push([t('panel.diagFs'), fsValue]);
        if (diagnostics.dataRoot) {
            const sourceSuffix = diagnostics.fsSource ? ` (${diagnostics.fsSource})` : '';
            lines.push([t('panel.diagDataRoot'), `${diagnostics.dataRoot}${sourceSuffix}`]);
        }
        if (diagnostics.handle) {
            lines.push([t('panel.diagHandle'), diagnostics.handle]);
        }
        lines.push([t('panel.diagKnown'), String(diagnostics.known ?? 0)]);
        lines.push([t('panel.diagUsed'), String(diagnostics.used ?? 0)]);
        lines.push([t('panel.diagImportTimes'), String(diagnostics.importTimes ?? 0)]);
        if (diagnostics.groupCount !== undefined) {
            lines.push([t('panel.diagGroups'), t('grouping.status', {
                groups: diagnostics.groupCount,
                presets: diagnostics.groupingPresetCount ?? 0,
                manual: diagnostics.groupingOverrideCount ?? 0,
            })]);
        }

        container.textContent = '';
        for (const [label, value] of lines) {
            const line = createElement('span', 'preset-sorter-diag-line');
            line.appendChild(createElement('span', 'preset-sorter-diag-label', `${label}: `));
            line.appendChild(createElement('span', 'preset-sorter-diag-value', value));
            container.appendChild(line);
        }
    }

    /**
     * @param {boolean} enabled Enabled state.
     * @returns {void}
     */
    function syncEnabledState(enabled) {
        if (elements.field) {
            elements.field.disabled = !enabled;
        }
        if (elements.direction) {
            elements.direction.disabled = !enabled || readDefaultSortSpec(settings).field === DEFAULT_FIELD;
        }
        if (elements.applyAll) {
            elements.applyAll.disabled = !enabled;
        }
        if (elements.groupingEnabled) {
            elements.groupingEnabled.disabled = !enabled;
        }
        if (elements.groupingMode) {
            elements.groupingMode.disabled = !enabled;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Group manager                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * Builds one preset row for the group manager.
     *
     * @param {string} apiId API id.
     * @param {GroupingManagerPreset} preset Preset data.
     * @returns {any} Row element.
     */
    function buildGroupRow(apiId, preset) {
        const row = createElement('div', 'preset-sorter-group-row');
        try {
            row.setAttribute('data-preset-name', preset.name);
            row.setAttribute('data-api-id', apiId);
        } catch {
            // Ignore non-writable test doubles.
        }
        const overrideValue = preset.override === GROUPING_UNGROUPED ? '' : preset.override;
        const nameElement = createElement('span', 'preset-sorter-group-preset', preset.name);
        nameElement.title = preset.name;

        const input = documentRef.createElement('input');
        input.type = 'text';
        input.className = 'text_pole preset-sorter-group-input';
        input.value = overrideValue;
        input.placeholder = preset.autoGroup
            ? t('grouping.autoGroup', { group: preset.autoGroup })
            : t('grouping.noAutoGroup');
        input.title = t('grouping.managerHint');

        const ungroupLabel = createElement('label', 'checkbox_label preset-sorter-group-ungroup');
        const ungroup = documentRef.createElement('input');
        ungroup.type = 'checkbox';
        ungroup.className = 'preset-sorter-group-ungroup-checkbox';
        ungroup.checked = preset.override === GROUPING_UNGROUPED;
        ungroupLabel.appendChild(ungroup);
        ungroupLabel.appendChild(createElement('span', 'preset-sorter-group-ungroup-text', t('grouping.ungroup')));

        const markDirty = () => {
            managerDirty = true;
        };
        if (typeof input.addEventListener === 'function') {
            input.addEventListener('input', markDirty);
            input.addEventListener('change', markDirty);
        }
        if (typeof ungroup.addEventListener === 'function') {
            ungroup.addEventListener('change', markDirty);
        }

        row.appendChild(nameElement);
        row.appendChild(input);
        row.appendChild(ungroupLabel);
        return row;
    }

    /**
     * Re-renders the group manager body from the controller data provider.
     *
     * @returns {void}
     */
    function renderGroupManager() {
        const body = elements.managerBody;
        if (!body) {
            return;
        }
        let data = null;
        try {
            data = typeof options.getGroupingManagerData === 'function' ? options.getGroupingManagerData() : null;
        } catch (error) {
            console.error('[preset-sorter] grouping manager data failed', error);
        }
        latestManagerData = data && typeof data === 'object' ? data : null;
        body.textContent = '';
        syncGroupingCounts();
        if (!latestManagerData || !Array.isArray(latestManagerData.apis) || latestManagerData.apis.length === 0) {
            body.appendChild(createElement('small', 'preset-sorter-hint', t('grouping.empty')));
            return;
        }
        for (const api of latestManagerData.apis) {
            if (!api || !Array.isArray(api.presets) || api.presets.length === 0) {
                continue;
            }
            const section = documentRef.createElement('details');
            section.className = 'preset-sorter-group-api';
            section.open = true;
            try {
                section.setAttribute('data-api-id', api.apiId);
            } catch {
                // Ignore.
            }
            const summary = documentRef.createElement('summary');
            summary.textContent = `${t(api.labelKey ?? `api.${api.apiId}`)} (${api.groupCount}/${api.presetCount})`;
            section.appendChild(summary);
            const rows = createElement('div', 'preset-sorter-group-rows');
            for (const preset of api.presets) {
                rows.appendChild(buildGroupRow(api.apiId, preset));
            }
            section.appendChild(rows);
            body.appendChild(section);
        }
        filterGroupRows();
    }

    /**
     * Filters preset rows by the manager search box without losing edits.
     *
     * @returns {void}
     */
    function filterGroupRows() {
        const body = elements.managerBody;
        if (!body || typeof body.querySelectorAll !== 'function') {
            return;
        }
        const query = String(elements.groupSearch?.value ?? '').trim().toLowerCase();
        let anyVisible = false;
        for (const section of body.querySelectorAll('.preset-sorter-group-api')) {
            let visibleInSection = 0;
            for (const row of section.querySelectorAll('.preset-sorter-group-row')) {
                const name = String(row.getAttribute('data-preset-name') ?? '');
                const matches = query === '' || name.toLowerCase().includes(query);
                row.hidden = !matches;
                if (matches) {
                    visibleInSection += 1;
                }
            }
            section.hidden = visibleInSection === 0;
            anyVisible = anyVisible || visibleInSection > 0;
        }
        if (!anyVisible && query !== '') {
            const existing = body.querySelector?.('.preset-sorter-group-no-matches');
            if (!existing) {
                body.appendChild(createElement('small', 'preset-sorter-hint preset-sorter-group-no-matches', t('grouping.noMatches')));
            }
        }
    }

    /**
     * Collects the manager inputs into a `{apiId: {presetName: groupName}}` map.
     *
     * @returns {Record<string, Record<string, string>>} Overrides map.
     */
    function collectGroupingOverrides() {
        /** @type {Record<string, Record<string, string>>} */
        const overrides = {};
        const body = elements.managerBody;
        if (!body || typeof body.querySelectorAll !== 'function') {
            return overrides;
        }
        for (const section of body.querySelectorAll('.preset-sorter-group-api')) {
            const apiId = section.getAttribute('data-api-id');
            if (!apiId) {
                continue;
            }
            /** @type {Record<string, string>} */
            const apiOverrides = {};
            for (const row of section.querySelectorAll('.preset-sorter-group-row')) {
                const presetName = row.getAttribute('data-preset-name');
                if (!presetName) {
                    continue;
                }
                const input = row.querySelector?.('.preset-sorter-group-input');
                const ungroup = row.querySelector?.('.preset-sorter-group-ungroup-checkbox');
                const groupName = input ? String(input.value ?? '').trim() : '';
                if (ungroup && ungroup.checked) {
                    apiOverrides[presetName] = GROUPING_UNGROUPED;
                } else if (groupName !== '') {
                    apiOverrides[presetName] = groupName;
                }
            }
            if (Object.keys(apiOverrides).length > 0) {
                overrides[apiId] = apiOverrides;
            }
        }
        return overrides;
    }

    /**
     * @param {string} key Status i18n key.
     * @returns {void}
     */
    function setGroupStatus(key) {
        if (elements.groupStatus) {
            elements.groupStatus.textContent = t(key);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Event handlers                                                     */
    /* ------------------------------------------------------------------ */

    const onEnabledChange = () => {
        settings.enabled = !!elements.enabled?.checked;
        syncEnabledState(settings.enabled);
        options.onChange?.({ enabled: settings.enabled });
    };
    const onFieldChange = () => {
        const field = normalizeField(String(elements.field?.value ?? ''));
        const current = readDefaultSortSpec(settings);
        settings.default = { field, direction: current.direction };
        syncDirectionAvailability();
        syncEffectiveHint();
        options.onChange?.({ field });
    };
    const onDirectionChange = () => {
        const direction = elements.direction?.checked ? 'desc' : 'asc';
        const current = readDefaultSortSpec(settings);
        settings.default = { field: current.field, direction };
        syncEffectiveHint();
        options.onChange?.({ direction });
    };
    const onApplyAllChange = () => {
        settings.applyAll = !!elements.applyAll?.checked;
        options.onChange?.({ applyToAll: settings.applyToAll });
    };
    const onGroupingEnabledChange = () => {
        const grouping = readGroupingSettings(settings);
        settings.grouping = {
            enabled: !!elements.groupingEnabled?.checked,
            mode: grouping.mode,
            overrides: grouping.overrides,
        };
        options.onChange?.({ groupingEnabled: settings.grouping.enabled });
    };
    const onGroupingModeChange = () => {
        const grouping = readGroupingSettings(settings);
        settings.grouping = {
            enabled: grouping.enabled,
            mode: normalizeGroupingMode(String(elements.groupingMode?.value ?? '')),
            overrides: grouping.overrides,
        };
        options.onChange?.({ groupingMode: settings.grouping.mode });
    };
    const onManageGroupsClick = () => {
        if (elements.manager) {
            elements.manager.open = !elements.manager.open;
        }
        if (elements.manager && elements.manager.open) {
            managerDirty = false;
            renderGroupManager();
            filterGroupRows();
        }
    };
    const onGroupSearchInput = () => {
        filterGroupRows();
    };
    const onGroupSaveClick = () => {
        try {
            const overrides = collectGroupingOverrides();
            options.onSaveGroupingOverrides?.(overrides);
            managerDirty = false;
            renderGroupManager();
            setGroupStatus('grouping.saved');
        } catch (error) {
            console.error('[preset-sorter] saving groups failed', error);
        }
    };
    const onGroupResetClick = () => {
        try {
            options.onResetGroupingOverrides?.();
            managerDirty = false;
            renderGroupManager();
            setGroupStatus('grouping.resetDone');
        } catch (error) {
            console.error('[preset-sorter] resetting groups failed', error);
        }
    };
    const onManagerToggle = () => {
        if (elements.manager && elements.manager.open && !managerDirty) {
            renderGroupManager();
        }
    };
    const onRefreshClick = async () => {
        if (busy) {
            return;
        }
        try {
            await options.onRefresh?.();
        } catch (error) {
            console.error('[preset-sorter] refresh failed', error);
        }
    };
    const onResetUsageClick = async () => {
        if (busy) {
            return;
        }
        try {
            const confirmed = await options.confirmReset?.();
            if (!confirmed) {
                return;
            }
            await options.onResetUsage?.();
        } catch (error) {
            console.error('[preset-sorter] reset usage failed', error);
        }
    };

    elements.enabled?.addEventListener?.('change', onEnabledChange);
    elements.field?.addEventListener?.('change', onFieldChange);
    elements.direction?.addEventListener?.('change', onDirectionChange);
    elements.applyAll?.addEventListener?.('change', onApplyAllChange);
    elements.groupingEnabled?.addEventListener?.('change', onGroupingEnabledChange);
    elements.groupingMode?.addEventListener?.('change', onGroupingModeChange);
    elements.manageGroups?.addEventListener?.('click', onManageGroupsClick);
    elements.groupSearch?.addEventListener?.('input', onGroupSearchInput);
    elements.groupSave?.addEventListener?.('click', onGroupSaveClick);
    elements.groupReset?.addEventListener?.('click', onGroupResetClick);
    elements.manager?.addEventListener?.('toggle', onManagerToggle);
    elements.refresh?.addEventListener?.('click', onRefreshClick);
    elements.resetUsage?.addEventListener?.('click', onResetUsageClick);

    syncFromSettings();
    syncEnabledState(!!settings.enabled);

    return {
        update(state = {}) {
            if (state.settings) {
                syncFromSettings();
                syncEnabledState(!!settings.enabled);
            }
            if (state.diagnostics !== undefined) {
                renderDiagnostics(state.diagnostics);
            } else {
                try {
                    renderDiagnostics(options.getDiagnostics?.());
                } catch (error) {
                    console.error('[preset-sorter] diagnostics failed', error);
                }
            }
            if (state.busy !== undefined) {
                setBusy(state.busy);
            }
            if (elements.manager && elements.manager.open && !managerDirty) {
                renderGroupManager();
            } else {
                // Keep the compact counts line fresh even while the manager is closed.
                try {
                    if (typeof options.getGroupingManagerData === 'function') {
                        latestManagerData = options.getGroupingManagerData();
                    }
                } catch {
                    // Ignore preview failures; diagnostics carry the primary counts.
                }
                syncGroupingCounts();
            }
        },
        updateDiagnostics(diagnostics) {
            renderDiagnostics(diagnostics);
        },
        setBusy,
        refreshGroupManager() {
            if (!managerDirty) {
                renderGroupManager();
            }
        },
        destroy() {
            elements.enabled?.removeEventListener?.('change', onEnabledChange);
            elements.field?.removeEventListener?.('change', onFieldChange);
            elements.direction?.removeEventListener?.('change', onDirectionChange);
            elements.applyAll?.removeEventListener?.('change', onApplyAllChange);
            elements.groupingEnabled?.removeEventListener?.('change', onGroupingEnabledChange);
            elements.groupingMode?.removeEventListener?.('change', onGroupingModeChange);
            elements.manageGroups?.removeEventListener?.('click', onManageGroupsClick);
            elements.groupSearch?.removeEventListener?.('input', onGroupSearchInput);
            elements.groupSave?.removeEventListener?.('click', onGroupSaveClick);
            elements.groupReset?.removeEventListener?.('click', onGroupResetClick);
            elements.manager?.removeEventListener?.('toggle', onManagerToggle);
            elements.refresh?.removeEventListener?.('click', onRefreshClick);
            elements.resetUsage?.removeEventListener?.('click', onResetUsageClick);
        },
    };
}

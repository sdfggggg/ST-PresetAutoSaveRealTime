/**
 * Settings panel view layer.
 *
 * The panel markup lives in `settings.html` (rendered by the controller through
 * `renderExtensionTemplateAsync`) and is deliberately language-neutral; this
 * module localizes every label and binds the controls. It only mutates the live
 * settings object through the injected callbacks — persistence stays in the
 * controller.
 *
 * Top-level code is side-effect free (no DOM access at import time).
 *
 * @module preset-sorter/settings-ui
 */

import { DEFAULT_MODE, MODE_ORDER } from './constants.js';
import { formatModeLabel, t } from './i18n.js';

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
 */

/**
 * @typedef {object} SettingsUiOptions
 * @property {object} settings Live settings object (mutated by the UI).
 * @property {(patch: object) => void} [onChange] Called after a toggle/select change.
 * @property {() => Promise<void>|void} [onRefresh] Refresh import times handler.
 * @property {() => Promise<void>|void} [onResetUsage] Reset usage handler.
 * @property {() => Promise<boolean>|boolean} [confirmReset] Confirmation for usage reset.
 * @property {() => SettingsUiDiagnostics} [getDiagnostics] Diagnostics provider.
 * @property {Document|null} [document] Document override (tests).
 */

/**
 * @typedef {object} SettingsPanelHandle
 * @property {(state: {settings?: object, diagnostics?: SettingsUiDiagnostics, busy?: boolean}) => void} update Re-render the panel from state.
 * @property {(diagnostics: SettingsUiDiagnostics) => void} updateDiagnostics Update only the diagnostics block.
 * @property {(busy: boolean) => void} setBusy Toggle the refresh button busy state.
 * @property {() => void} destroy Remove event listeners.
 */

/**
 * Mounts the settings panel: localizes labels, fills the sort-mode select and
 * binds the controls.
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
    const byId = id => documentRef.getElementById(id);

    const elements = {
        root: byId('preset_sorter_settings'),
        title: byId('preset_sorter_title'),
        enabled: byId('preset_sorter_enabled'),
        enabledLabel: byId('preset_sorter_enabled_label'),
        defaultMode: byId('preset_sorter_default_mode'),
        defaultModeLabel: byId('preset_sorter_default_mode_label'),
        applyAll: byId('preset_sorter_apply_all'),
        applyAllLabel: byId('preset_sorter_apply_all_label'),
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

    setText(elements.title, 'panel.title');
    setText(elements.enabledLabel, 'panel.enabled');
    setTitle(elements.enabled, 'panel.enabledHint');
    setText(elements.defaultModeLabel, 'panel.defaultMode');
    setTitle(elements.defaultMode, 'panel.defaultModeHint');
    setText(elements.applyAllLabel, 'panel.applyAll');
    setTitle(elements.applyAll, 'panel.applyAllHint');
    setText(elements.refresh, 'panel.refresh');
    setTitle(elements.refresh, 'panel.refreshHint');
    setText(elements.resetUsage, 'panel.resetUsage');
    setTitle(elements.resetUsage, 'panel.resetUsageHint');
    setText(elements.hint, 'panel.refreshHint');

    // Fill the sort-mode select once (it starts empty in settings.html).
    if (elements.defaultMode) {
        const existingOptions = elements.defaultMode.options;
        const optionCount = existingOptions && typeof existingOptions.length === 'number'
            ? existingOptions.length
            : 0;
        if (optionCount === 0) {
            for (const mode of MODE_ORDER) {
                const option = documentRef.createElement('option');
                option.value = mode;
                option.textContent = formatModeLabel(mode);
                elements.defaultMode.appendChild(option);
            }
        }
    }

    /**
     * Synchronizes the controls from the live settings object.
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
        if (elements.defaultMode) {
            const mode = MODE_ORDER.includes(settings.defaultMode) ? settings.defaultMode : DEFAULT_MODE;
            if (String(elements.defaultMode.value) !== mode) {
                elements.defaultMode.value = mode;
            }
        }
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

        container.textContent = '';
        for (const [label, value] of lines) {
            const line = documentRef.createElement('span');
            line.className = 'preset-sorter-diag-line';
            const labelElement = documentRef.createElement('span');
            labelElement.className = 'preset-sorter-diag-label';
            labelElement.textContent = `${label}: `;
            const valueElement = documentRef.createElement('span');
            valueElement.className = 'preset-sorter-diag-value';
            valueElement.textContent = value;
            line.appendChild(labelElement);
            line.appendChild(valueElement);
            container.appendChild(line);
        }
    }

    /**
     * @param {boolean} enabled Enabled state (kept for symmetry with future controls).
     * @returns {void}
     */
    function syncEnabledState(enabled) {
        if (elements.defaultMode) {
            elements.defaultMode.disabled = !enabled;
        }
        if (elements.applyAll) {
            elements.applyAll.disabled = !enabled;
        }
    }

    const onEnabledChange = () => {
        settings.enabled = !!elements.enabled?.checked;
        syncEnabledState(settings.enabled);
        options.onChange?.({ enabled: settings.enabled });
    };
    const onModeChange = () => {
        const value = String(elements.defaultMode?.value ?? '');
        if (MODE_ORDER.includes(value)) {
            settings.defaultMode = value;
            options.onChange?.({ defaultMode: value });
        }
    };
    const onApplyAllChange = () => {
        settings.applyToAll = !!elements.applyAll?.checked;
        options.onChange?.({ applyToAll: settings.applyToAll });
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
    elements.defaultMode?.addEventListener?.('change', onModeChange);
    elements.applyAll?.addEventListener?.('change', onApplyAllChange);
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
        },
        updateDiagnostics(diagnostics) {
            renderDiagnostics(diagnostics);
        },
        setBusy,
        destroy() {
            elements.enabled?.removeEventListener?.('change', onEnabledChange);
            elements.defaultMode?.removeEventListener?.('change', onModeChange);
            elements.applyAll?.removeEventListener?.('change', onApplyAllChange);
            elements.refresh?.removeEventListener?.('click', onRefreshClick);
            elements.resetUsage?.removeEventListener?.('click', onResetUsageClick);
        },
    };
}

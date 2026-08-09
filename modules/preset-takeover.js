/**
 * SillyTavern Preset Auto Save - Preset Takeover
 * 预设接管模块（核心特性）— Custom Dropdown Overlay 架构
 *
 * ⚠️ 核心原则（严格遵守）：
 *   1. 绝不修改 option.textContent — ST 的 text() 始终返回真实预设名
 *   2. 绝不从 select 中 detach/remove option — ST 的 find('option') 始终能找到所有预设
 *   3. 绝不拦截 select 的 change 事件 — ST 的原生 handler 始终正常执行
 *   4. 只通过 CSS 隐藏原生 select — opacity:0; pointer-events:none; position:absolute
 *   5. 用自定义 UI 替代视觉层 — 用户看到的是分组下拉，实际操作的是原生 select
 *
 * 数据流：
 *   select.options[] ──→ preset-grouping.js ──→ Custom Dropdown UI
 *                                                       │
 *                                                       ↓ (用户点击)
 *   $(select).val(targetValue).trigger('change') ──→ ST 原生 handler
 *                                                       │
 *                                                       ↓ (ST 事件)
 *   oai_preset_changed_after ──→ 更新 Custom Dropdown trigger 显示
 */
import { logger } from './logger.js';
import { getSettings, onSettingChange, updateSetting } from './settings.js';
import {
    on, getEventType, getCurrentApiId, escapeHtml, escapeAttr,
    getPresetSnapshot, savePresetSafe,
    toast, t,
} from './compatibility.js';
import {
    getSeriesInfo,
    pickRepresentativeVersion,
    normalizeSeriesKey,
    buildNestedGroupTree,
    compareVersion,
    getNodePath,
    findNodeByKey,
    collectAllPresetNames,
} from './preset-grouping.js';
import {
    initArchiveStore,
    listArchivedPresets,
    removeArchivedPreset,
} from './archive-store.js';
import { getSnapshots, addSnapshot, TRIGGER } from './history-store.js';
import { restoreArchiveEntries } from './core/archive-recovery.js';
import { RuntimeTimerRegistry } from './core/runtime-timers.js';
// =====================================================
// 常量
// =====================================================
const SELECT_SELECTOR = 'select[data-preset-manager-for]';
const TAKEOVER_DATA_ATTR = 'data-pas-takeover';        // 标记此 select 已被接管
// 时间常量
const INIT_REFRESH_RETRY_MS = 800;    // 初始化后兜底刷新延迟（等待 ST DOM 稳定）
const SEED_SNAPSHOT_DELAY_MS = 3000;  // 启动种子快照延迟（等待预设列表完全加载）
const SELECT_UI_REFRESH_MS = 50;      // select 变更后 UI 刷新微延迟
// =====================================================
// 模块状态
// =====================================================
let _initialized = false;
let _takeoverActive = false;
// 事件取消订阅句柄
let _eventUnsubscribers = [];
let _settingUnsubscribe = null;
// 监听 select 自身 children 变化的 observer
let _selectObserver = null;
// 监听整个文档（捕获新 select 的出现）
let _docObserver = null;
// 我们是否在写入 DOM（用于让自己的 mutation 不触发自己的 observer）
let _selfMutating = false;
// 管理的 select 集合（用于 teardown 时清理）
const _managedSelects = new Set();
// ⚡ 防抖与去重缓存
let _refreshTimer = null;
let _lastRefreshTs = 0;
let _refreshSuppressUntil = 0;
let _forceNextRefresh = false;
// 时间数据版本号：recordLastUsed / realTimes 刷新时自增，纳入指纹使 timeline/lastused 模式能随操作重排
let _timesVersion = 0;
// lastused 内存缓存（apiId -> Map(name -> ms)）：排序时高频读取，避免重复 localStorage.getItem 同步 IO
const _lastUsedCache = Object.create(null);
// realTimes 强制刷新的节流时间戳（按 apiId），避免高频拉取打爆后端
const _realTimesLastForceTs = Object.create(null);
// Bug fix: 缓存最后一次 refreshTakeover 传入的 overrides/tree，防止 SETTINGS_UPDATED 触发的二次 refresh() 用空值覆盖
let _cachedOverrides = null;
let _cachedTree = null;
const _runtimeTimers = new RuntimeTimerRegistry();
let _tearingDown = false;
let _seedActivityCount = 0;
let _seedIdleWaiters = [];

function beginSeedActivity() {
    _seedActivityCount++;
}

function endSeedActivity() {
    _seedActivityCount = Math.max(0, _seedActivityCount - 1);
    if (_seedActivityCount === 0) {
        const waiters = _seedIdleWaiters.splice(0);
        for (const resolve of waiters) resolve();
    }
}

function whenSeedIdle() {
    return _seedActivityCount === 0
        ? Promise.resolve()
        : new Promise(resolve => _seedIdleWaiters.push(resolve));
}
const REFRESH_DEBOUNCE_MS = 220;
const REFRESH_MIN_INTERVAL_MS = 350;
const REFRESH_FORCE_MIN_INTERVAL_MS = 50;   // P0-4: force 模式下的硬节流，防止连续调用导致性能雪崩
// 每个 select 对应的 option 指纹（用于判断是否需要重新渲染 dropdown）
const _selectFingerprints = new WeakMap();
// =====================================================
// 预设名有效性检查（模块级，消除重复定义）
// =====================================================
/**
 * 判断预设名是否"无效"（空白、纯数字占位符等）
 * @param {*} name
 * @returns {boolean}
 */
function _isInvalidPresetName(name) {
    if (typeof name !== 'string') return true;
    const s = name.trim();
    if (!s) return true;
    if (/^[\s\-_.]*\d+[\s\-_.]*$/.test(s)) return true;
    return false;
}
// =====================================================
// 初始化
// =====================================================
export async function initPresetTakeover() {
    if (_initialized) {
        logger.debug('Takeover already initialized, skip');
        return;
    }
    _initialized = true;
    _tearingDown = false;
    logger.info('[Takeover] Starting initialization (Custom Dropdown Overlay)...');
    // 初始化归档存储
    const archiveStore = await initArchiveStore();
    if (!archiveStore) {
        _initialized = false;
        throw new Error('Archive store is unavailable; takeover was not started');
    }
    // 监听设置变化
    _settingUnsubscribe = onSettingChange(({ key }) => {
        if (
            key === 'takeoverEnabled'
            || key === 'takeoverSortMode'
            || key === 'takeoverSortDir'
            || key === 'takeoverCustomOrder'
            || key === 'groupingManualOverrides'
            || key === 'groupingSeriesAliases'
            || key === 'groupingEnabled'
            || key === 'nestingEnabled'
            || key === 'nestingMaxDepth'
            || key === 'groupingTree'
            || key === 'enabled'
        ) {
            scheduleRefresh();
        }
    });
    // 监听 ST 事件
    const events = [
        'OAI_PRESET_CHANGED_AFTER',
        'PRESET_CHANGED',
        'CHATCOMPLETION_SOURCE_CHANGED',
        'MAIN_API_CHANGED',
        'APP_READY',
    ];
    let boundEventCount = 0;
    for (const evtName of events) {
        try {
            const evt = getEventType(evtName, evtName.toLowerCase());
            const unsub = on(evt, () => scheduleRefresh());
            if (typeof unsub === 'function') {
                _eventUnsubscribers.push(unsub);
                boundEventCount++;
            }
        } catch (e) {
            logger.debug(`[Takeover] failed to bind ${evtName}`, e);
        }
    }
    // SETTINGS_UPDATED：独立 throttle 到至少 2 秒间隔
    let _lastSettingsEvtTs = 0;
    try {
        const evt = getEventType('SETTINGS_UPDATED', 'settings_updated');
        const unsub = on(evt, () => {
            const now = Date.now();
            if (now - _lastSettingsEvtTs < 2000) return;
            _lastSettingsEvtTs = now;
            scheduleRefresh();
        });
        if (typeof unsub === 'function') {
            _eventUnsubscribers.push(unsub);
            boundEventCount++;
        }
    } catch (_) {}
    // 上次使用追踪：预设切换后记录时间戳（覆盖接管下拉之外的原生/插件切换路径）
    try {
        const evt = getEventType('OAI_PRESET_CHANGED_AFTER', 'oai_preset_changed_after');
        const unsub = on(evt, () => recordCurrentPresetLastUsed());
        if (typeof unsub === 'function') {
            _eventUnsubscribers.push(unsub);
            boundEventCount++;
        }
    } catch (_) {}
    logger.debug(`[Takeover] bound ${boundEventCount} ST events`);
    setupDocObserver();
    // 立即应用一次 + 800ms 兜底
    refresh();
    _runtimeTimers.schedule(() => refresh(), INIT_REFRESH_RETRY_MS);
    // 启动种子
    _runtimeTimers.schedule(() => {
        seedSnapshotsIfNeeded({ silent: true }).catch(e =>
            logger.warn('[Takeover] seed snapshots failed:', e)
        );
    }, SEED_SNAPSHOT_DELAY_MS);
    logger.success('[Takeover] Ready ✓ (Custom Dropdown Overlay)');
}
// =====================================================
// 调度刷新（防抖 + 最小间隔节流）
// =====================================================
function scheduleRefresh() {
    if (_refreshTimer) return;
    const now = Date.now();
    const earliest = Math.max(now + REFRESH_DEBOUNCE_MS,
                               _lastRefreshTs + REFRESH_MIN_INTERVAL_MS);
    const wait = Math.max(0, earliest - now);
    _refreshTimer = setTimeout(() => {
        _refreshTimer = null;
        if (Date.now() < _refreshSuppressUntil) return;
        try {
            refresh();
        } catch (e) {
            logger.error('Preset takeover refresh failed:', e);
        }
    }, wait);
}
// =====================================================
// 计算 select 的 option 列表指纹（幂等判断）
// =====================================================
function computeSelectFingerprint(select) {
    if (!select) return '';
    const opts = select.options;
    const len = opts ? opts.length : 0;
    if (len === 0) return `${select.id || ''}::0`;
    const getText = (opt) => opt ? (opt.textContent || '') : '';
    const firstT = getText(opts[0]);
    const lastT = getText(opts[len - 1]);
    const midT = getText(opts[Math.floor(len / 2)]);
    // P0-fix: 排序模式 + 自定义顺序纳入指纹。否则仅切换排序时 options 不变，会被守卫误判为
    // “内容无变化”而走 skipped 分支，只刷新 trigger 文本、不重渲染 panel —— 表现为“排序无法切换”。
    let sortSig = '';
    try {
        const s = getSettings();
        const _md = s.takeoverSortMode || 'default';
        // timeline/lastused 模式纳入时间版本号：文件 mtime 或使用记录变化时 _timesVersion 自增 → 指纹变 → refresh 重排
        const _vsig = (_md === 'timeline' || _md === 'lastused') ? `:v${_timesVersion}` : '';
        sortSig = `::${_md}:${s.takeoverSortDir || 'desc'}:${(s.takeoverCustomOrder || []).join('|')}${_vsig}`;
    } catch (_) { /* getSettings 不可用时忽略 */ }
    return `${select.id || select.getAttribute('data-preset-manager-for') || ''}::${len}::${firstT}::${midT}::${lastT}::${select.value}${sortSig}`;
}
// =====================================================
// 主刷新逻辑
// =====================================================
// Bug B: 支持 forceOverrides/forceTree 外部传入，跳过 getSettings() 时序问题
function refresh(forceOverrides = null, forceTree = null) {
    // 若调用方未传参（如 SETTINGS_UPDATED 事件触发），使用缓存值
    if (!forceOverrides && _cachedOverrides) forceOverrides = _cachedOverrides;
    if (!forceTree && _cachedTree) forceTree = _cachedTree;
    const s = getSettings();
    const shouldActive = !!(s.enabled && s.groupingEnabled && s.takeoverEnabled);
    _lastRefreshTs = Date.now();
    if (!shouldActive) {
        if (_takeoverActive) {
            logger.info('[Takeover] disabling → removing custom dropdowns, restoring native selects');
            teardownAllDropdowns();
            _takeoverActive = false;
        }
        return;
    }
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (e) {
        logger.warn('[Takeover] querySelectorAll failed:', e);
        return;
    }
    if (!selects || selects.length === 0) return;
    const forceRebuild = _forceNextRefresh;
    _forceNextRefresh = false;
    const settings = getSettings();
    let appliedCount = 0;
    let skippedCount = 0;
    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        // 幂等跳过：option 指纹未变 + 已有 wrapper → 仅更新 trigger 显示 + active 状态
        // AG-1: forceRebuild 时跳过指纹检查，强制重建
        // Bug B: 外部传参时也强制重建（forceRebuild 逻辑不变，forceOverrides 非空时跳过缓存）
        const selFp = computeSelectFingerprint(select);
        const lastSelFp = _selectFingerprints.get(select);
        const wrapper = select.closest('.pas-dd-wrapper');
        if (!forceRebuild && !forceOverrides && lastSelFp === selFp && wrapper) {
            // 只更新 trigger 文本和 active 标记
            updateTriggerDisplay(select, wrapper);
            updateActiveState(select, wrapper);
            skippedCount++;
            continue;
        }
        try {
            applyTakeoverToSelect(select, forceOverrides, forceTree);
            appliedCount++;
            _selectFingerprints.set(select, computeSelectFingerprint(select));
        } catch (e) {
            logger.warn('[Takeover] failed for select:', e);
        }
    }
    _refreshSuppressUntil = Date.now() + 800;
    if (appliedCount > 0) {
        if (!_takeoverActive) {
            logger.success(`[Takeover] activated (overlay) · ${appliedCount} select(s)`);
        } else {
            logger.debug(`[Takeover] refreshed · ${appliedCount} applied${skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}`);
        }
        _takeoverActive = true;
    } else {
        // all skipped - fingerprint cache hit
    }
}
// =====================================================
// 接管单个 select — 创建 Custom Dropdown Overlay
// =====================================================
// Bug B: forceOverrides/forceTree 优先于 getSettings()，绕过时序问题
function applyTakeoverToSelect(select, forceOverrides = null, forceTree = null) {
    const apiId = getApiIdOfSelect(select);
    const settings = getSettings();
    const overrides = forceOverrides || settings.groupingManualOverrides || {};
    const actualTree = forceTree || settings.groupingTree || {};
    const seriesDefaults = settings.seriesDefaultApply || {};
    // 如果已经创建了 wrapper，更新内容即可
    let wrapper = select.closest('.pas-dd-wrapper');
    if (wrapper) {
        const panel = wrapper.querySelector('.pas-dd-panel');
        if (panel) {
            renderDropdownContent(panel, select, apiId, overrides, seriesDefaults, forceTree);
            updateTriggerDisplay(select, wrapper);
            updateActiveState(select, wrapper);
        }
        return;
    }
    // P1 fix: 防御性检查 — select 必须有 parentNode 才能 insertBefore
    if (!select.parentNode) {
        logger.warn('[Takeover] select has no parentNode, skipping wrapper creation');
        return;
    }
    // 创建 wrapper，包裹 select
    wrapper = document.createElement('div');
    wrapper.className = 'pas-dd-wrapper';
    wrapper.style.position = 'relative';
    wrapper.style.display = 'flex';
    wrapper.style.flex = '1 1 0';
    wrapper.style.minWidth = '0';
    // BUG-03 fix: _selfMutating 保护覆盖整个 DOM 创建过程
    let trigger, panel;
    _selfMutating = true;
    try {
        select.parentNode.insertBefore(wrapper, select);
        wrapper.appendChild(select);
        // 隐藏原生 select（CSS only — ST 仍可通过 ID/selector 正常访问）
        select.style.opacity = '0';
        select.style.pointerEvents = 'none';
        select.style.position = 'absolute';
        select.style.width = '100%';
        select.style.height = '100%';
        select.style.top = '0';
        select.style.left = '0';
        select.style.zIndex = '-1';
        select.setAttribute(TAKEOVER_DATA_ATTR, '1');
        // 创建 trigger 按钮
        trigger = document.createElement('div');
        trigger.className = 'pas-dd-trigger';
        trigger.tabIndex = 0;
        trigger.innerHTML = `
            <span class="pas-dd-label"></span>
            <i class="fas fa-chevron-down pas-dd-chevron"></i>
        `;
        wrapper.appendChild(trigger);
        // 创建 panel（下拉面板）
        panel = document.createElement('div');
        panel.className = 'pas-dd-panel';
        panel.style.display = 'none';
        wrapper.appendChild(panel);
    } finally {
        _selfMutating = false;
    }
    // 渲染分组内容
    renderDropdownContent(panel, select, apiId, overrides, seriesDefaults);
    updateTriggerDisplay(select, wrapper);
    // ---------- 事件绑定 ----------
    // trigger 点击 → 显示/隐藏 panel
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.style.display !== 'none';
        if (isOpen) {
            closePanel(panel, trigger);
        } else {
            openPanel(panel, trigger);
        }
    });
    // 键盘导航
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            trigger.click();
        } else if (e.key === 'Escape') {
            closePanel(panel, trigger);
        }
    });
    // 点击外部 → 关闭 panel
    const onDocClick = (e) => {
        if (!wrapper.contains(e.target)) {
            closePanel(panel, trigger);
        }
    };
    document.addEventListener('click', onDocClick, true);
    // 保存引用以便 teardown
    wrapper._pasDocClickHandler = onDocClick;
    // 标记为已管理
    _managedSelects.add(select);
    // 记录"上次使用"：select 的 change 事件可捕获所有切换路径
    // （原生下拉、其它插件、接管下拉程序化设值都会触发 change），比单纯依赖
    // OAI_PRESET_CHANGED_AFTER 更可靠。以预设名为键。
    if (!select._pasLastUsedHandler) {
        const lastUsedHandler = () => {
            try {
                const apiId = getApiIdOfSelect(select);
                const opt = Array.from(select.options || []).find(o => o.value === select.value);
                const name = (opt && (opt.textContent || '').trim()) || select.value;
                if (name) recordLastUsed(apiId, String(name));
            } catch (_) { /* ignore */ }
        };
        select.addEventListener('change', lastUsedHandler);
        select._pasLastUsedHandler = lastUsedHandler;
    }
    // 设置 select observer
    setupSelectObserver(select);
    logger.debug(`[Takeover] overlay applied to [${apiId}]`);
}
// =====================================================
// 渲染下拉面板内容
// =====================================================
// Bug B: forceTree 优先于 settings.groupingTree
function renderDropdownContent(panel, select, apiId, overrides, seriesDefaults, forceTree = null) {
    fetchRealTimes(apiId); // 触发后端真实时间拉取（幂等，加载后自动重渲染一次）
    const settings = getSettings();
    // 从 select.options 读取所有预设名和 value
    const optionList = Array.from(select.options || []);
    if (optionList.length === 0) {
        panel.innerHTML = `<div class="pas-dd-empty">${escapeHtml(t('Grouping Dropdown Empty'))}</div>`;
        return;
    }
    const currentValue = select.value;
    // ================================================================
    // 嵌套模式：使用 buildNestedGroupTree 递归渲染
    // ================================================================
    if (settings.nestingEnabled) {
        renderDropdownNested(panel, select, optionList, currentValue, overrides, settings, forceTree);
        return;
    }
    // ================================================================
    // 扁平模式（原有逻辑，保持不变）
    // ================================================================
    // 收集有效预设名
    // 按系列分组（T4 fix: 使用 normalizeSeriesKey 确保与历史面板分组一致）
    const seriesGroups = new Map();          // normKey → items[]
    const seriesDisplayNames = new Map();    // normKey → 首次出现的原始大小写名
    const standaloneOptions = []; // 不参与分组的
    for (let _i = 0; _i < optionList.length; _i++) {
        const option = optionList[_i];
        const presetName = (option.textContent || '').trim();
        const value = option.value;
        const realName = presetName || value;
        recordImportTime(apiId, realName, _i);
        if (!realName || _isInvalidPresetName(realName)) {
            standaloneOptions.push({ presetName: realName || value, value });
            continue;
        }
        const info = getSeriesInfo(realName, overrides);
        const rawSeriesKey = info.series || realName;
        const normKey = normalizeSeriesKey(rawSeriesKey);
        if (!seriesGroups.has(normKey)) {
            seriesGroups.set(normKey, []);
            seriesDisplayNames.set(normKey, rawSeriesKey); // 保留首次出现的大小写形式
        }
        seriesGroups.get(normKey).push({
            presetName: realName,
            value,
            version: info.version,
            duplicate: info.duplicate,
            manualOverride: info.manualOverride,
        });
    }
    // 构建 HTML
    let html = '';
    // 排序条（默认 / 时间 / 自定义）
    html += buildSortBarHtml(settings);
    // 排序系列：按当前排序模式（字母序 / 导入时间 / 自定义）
    const sortedSeries = sortSeriesEntries(Array.from(seriesGroups.entries()), settings, apiId);
    for (const [normKey, items] of sortedSeries) {
        const displayName = seriesDisplayNames.get(normKey) || normKey;
        // 单版本系列 → 作为独立项（除非它是手动覆盖到自定义分组的，需要显示分组名）
        // AT-1 fix: manualOverride 的预设即使只有 1 个也要作为组渲染，
        //   否则自定义分组名在 takeover dropdown 中不可见
        if (items.length === 1 && !items[0].manualOverride) {
            const it = items[0];
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
                <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
            </div>`;
            continue;
        }
        // 多版本系列 → 组
        // 版本按版本号倒序（最新在前）
        items.sort((a, b) => compareVersion(b.version, a.version));
        const hasActiveInGroup = items.some(it => it.value === currentValue);
        // T7: 移除 ⭐ 默认预设标记；T5: group-body 默认 display:none（收起）
        html += `<div class="pas-dd-group" data-series-key="${escapeAttr(normKey)}">
            <div class="pas-dd-group-header${hasActiveInGroup ? ' pas-dd-group--has-active' : ''}" title="${escapeAttr(displayName)}">
                <span class="pas-dd-series-name">${escapeHtml(displayName)}</span>
                <span class="pas-dd-badge pas-dd-version-count">${items.length}</span>
                <i class="fas fa-chevron-right pas-dd-group-chevron"></i>
            </div>
            <div class="pas-dd-group-body" style="display:none;">`;
        for (const it of items) {
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
                    <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
                    ${it.version ? `<span class="pas-dd-version-tag">${escapeHtml(it.version)}</span>` : ''}
                </div>`;
        }
        html += `</div></div>`;
    }
    // 独立预设（不可分组的）
    for (const it of standaloneOptions) {
        if (!it.presetName) continue;
        const isActive = it.value === currentValue;
        html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
            <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
        </div>`;
    }
    panel.innerHTML = html;
    // ---------- 绑定 panel 内事件（事件委托，只绑定一次） ----------
    if (!panel._pasClickBound) {
        panel._pasClickBound = true;
    // item 点击 → 切换预设
    panel.addEventListener('click', (e) => {
        if (handleSortBarClick(e, select, panel)) return;
        const item = e.target.closest('.pas-dd-item');
        if (item) {
            e.stopPropagation();
            const value = item.getAttribute('data-value');
            if (value !== null) {
                onItemClick(select, value, panel);
            }
            return;
        }
        // 组头点击 → 展开/收起
        const header = e.target.closest('.pas-dd-group-header');
        if (header) {
            e.stopPropagation();
            const group = header.closest('.pas-dd-group');
            if (group) {
                toggleGroup(group);
            }
            return;
        }
    });
    } // end if (!panel._pasClickBound)
}
// =====================================================
// 嵌套模式渲染：构建嵌套树并递归生成 HTML
// =====================================================
/**
 * 嵌套模式：使用 buildNestedGroupTree 构建嵌套组树并渲染下拉面板
 * @param {HTMLElement} panel - 下拉面板容器
 * @param {HTMLSelectElement} select - 原生 select 元素
 * @param {Array<HTMLOptionElement>} optionList - 所有 option 元素
 * @param {string} currentValue - 当前选中的值
 * @param {object} overrides - groupingManualOverrides
 * @param {object} settings - 完整设置对象
 */
// Bug B: forceTree 优先于 settings.groupingTree
function renderDropdownNested(panel, select, optionList, currentValue, overrides, settings, forceTree = null) {
    const apiId = getApiIdOfSelect(select);
    fetchRealTimes(apiId); // 触发后端真实时间拉取（幂等，加载后自动重渲染一次）
    // 1. 收集有效预设名
    const allPresetNames = [];
    /** @type {Map<string, {value: string, presetName: string, version: string, duplicate: string, manualOverride: boolean}>} */
    const optionsMap = new Map();
    for (let _i = 0; _i < optionList.length; _i++) {
        const opt = optionList[_i];
        const name = (opt.textContent || '').trim();
        if (!name || _isInvalidPresetName(name)) continue;
        if (optionsMap.has(name)) continue; // 去重
        allPresetNames.push(name);
        recordImportTime(apiId, name, _i);
        const info = getSeriesInfo(name, overrides);
        optionsMap.set(name, {
            value: opt.value,
            presetName: name,
            version: info.version,
            duplicate: info.duplicate,
            manualOverride: info.manualOverride,
        });
    }
    // 2. 构建嵌套树（Bug B: forceTree 优先）
    const tree = forceTree || settings.groupingTree || {};
    const maxDepth = settings.nestingMaxDepth || 3;
    const rootNodes = buildNestedGroupTree(allPresetNames, overrides, tree, maxDepth, settings.groupingSeriesAliases || {});
    // —— 排序所有系列（根 + 嵌套子组，按当前排序模式）——
    {
        const mode = settings.takeoverSortMode || 'default';
        const customOrder = settings.takeoverCustomOrder || [];
        const dir = settings.takeoverSortDir || 'desc';
        const timeOfNode = (node) => {
            let t = Infinity;
            const names = collectAllPresetNames([node]);
            for (const n of names) {
                const tt = (mode === 'lastused') ? getLastUsedMs(apiId, n) : getImportTime(apiId, n);
                if (tt < t) t = tt;
            }
            return t;
        };
        // 递归：按排序模式对节点数组（及其 children）进行原地排序
        // （合并 8f85516 嵌套排序修复 + dir 方向支持）
        const sortNodeArray = (nodes, scopeCustomOrder) => {
            const sortedKeys = applySortToKeys(
                nodes.map(n => n.key),
                mode,
                scopeCustomOrder || [],
                (k) => {
                    const node = nodes.find(n => n.key === k);
                    return node ? timeOfNode(node) : Infinity;
                },
                dir
            );
            nodes.sort((a, b) => sortedKeys.indexOf(a.key) - sortedKeys.indexOf(b.key));
            // 递归排序子组（customOrder 仅用于顶级，子组不传 customOrder，按同一 mode 排）
            for (const n of nodes) {
                if (n.children && n.children.length > 0) {
                    sortNodeArray(n.children, null);
                }
            }
        };
        sortNodeArray(rootNodes, customOrder);
    }
    //    使用共享函数 getNodePath 获取祖先 key 链，再映射为 displayName 拼接成显示路径
    const keyToDisplay = new Map();
    (function collectDisplayNames(nodes) {
        for (const node of nodes) {
            keyToDisplay.set(node.key, node.displayName);
            if (node.children && node.children.length > 0) collectDisplayNames(node.children);
        }
    })(rootNodes);
    /** @type {Map<string, string>} */
    const nestedPathMap = new Map();
    (function buildPaths(nodes) {
        for (const node of nodes) {
            const keyPath = getNodePath(tree, node.key);
            const displayPath = keyPath.length > 0
                ? keyPath.map(k => keyToDisplay.get(k) || k).join(' / ')
                : node.displayName;
            for (const presetName of node.items) {
                if (!nestedPathMap.has(presetName)) {
                    nestedPathMap.set(presetName, displayPath);
                }
            }
            if (node.children && node.children.length > 0) buildPaths(node.children);
        }
    })(rootNodes);
    // 4. 递归渲染 HTML
    let html = buildSortBarHtml(settings) + renderNestedDropdownGroups(rootNodes, optionsMap, currentValue, overrides);
    // 5. 无效预设名 → 独立项
    for (const opt of optionList) {
        const name = (opt.textContent || '').trim();
        if (!name || !_isInvalidPresetName(name)) continue;
        if (!name && !opt.value) continue;
        const display = name || opt.value;
        const isActive = opt.value === currentValue;
        html += `<div class="pas-dd-item pas-dd-standalone${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(opt.value)}" data-preset-name="${escapeAttr(display)}" title="${escapeAttr(display)}">
            <span class="pas-dd-item-name">${escapeHtml(display)}</span>
        </div>`;
    }
    panel.innerHTML = html;
    // 存储路径映射，供 updateTriggerDisplay 使用
    panel._pasNestedPathMap = nestedPathMap;
    // 6. 绑定 panel 点击事件（与扁平模式共用同一个事件委托）
    if (!panel._pasClickBound) {
        panel._pasClickBound = true;
        panel.addEventListener('click', (e) => {
            if (handleSortBarClick(e, select, panel)) return;
            const item = e.target.closest('.pas-dd-item');
            if (item) {
                e.stopPropagation();
                const value = item.getAttribute('data-value');
                if (value !== null) {
                    onItemClick(select, value, panel);
                }
                return;
            }
            // 组头点击 → 展开/收起（嵌套组头同样使用 .pas-dd-group-header）
            const header = e.target.closest('.pas-dd-group-header');
            if (header) {
                e.stopPropagation();
                const group = header.closest('.pas-dd-group');
                if (group) {
                    toggleGroup(group);
                }
                return;
            }
        });
    }
}
/**
 * 递归检查节点及其子树是否包含当前激活的预设。
 * 使用共享函数 collectAllPresetNames 完成子树遍历，然后通过 optionsMap 查找 value 匹配。
 *
 * @param {object} node - 树节点
 * @param {Map<string, object>} optionsMap - 预设名 → option 信息映射
 * @param {string} currentValue - 当前选中的 value
 * @returns {boolean}
 */
function _nodeHasActive(node, optionsMap, currentValue) {
    const allNames = collectAllPresetNames([node]);
    return allNames.some(name => {
        const opt = optionsMap.get(name);
        return opt && opt.value === currentValue;
    });
}
/**
 * 递归渲染嵌套下拉组 HTML
 * @param {Array} rootNodes - 根节点数组（来自 buildNestedGroupTree）
 * @param {Map<string, object>} optionsMap - 预设名 → { value, presetName, version, duplicate, manualOverride }
 * @param {string} currentValue - 当前选中的值
 * @returns {string} HTML 字符串
 */
function renderNestedDropdownGroups(rootNodes, optionsMap, currentValue, overrides) {
    let html = '';
    for (const node of rootNodes) {
        // 递归子节点（先递归，获取子节点 HTML）
        const childHtml = node.children && node.children.length > 0
            ? renderNestedDropdownGroups(node.children, optionsMap, currentValue, overrides)
            : '';
        // 跳过空壳节点：自身无 items + 递归子节点 HTML 也为空 → 不渲染
        const hasOverride = overrides && Object.values(overrides).some(v => normalizeSeriesKey(v) === node.key);
        if (node.items.length === 0 && !childHtml.trim() && !hasOverride) continue;
        const depth = node.depth;
        const hasActive = _nodeHasActive(node, optionsMap, currentValue);
        const itemCount = node.items.length;
        const childCount = node.children.length;
        // 构建统计标签文本
        let badgeText = '';
        if (itemCount > 0) badgeText += `${itemCount}项`;
        if (childCount > 0) badgeText += (badgeText ? `, ${childCount}子组` : `${childCount}子组`);
        html += `<div class="pas-dd-group pas-dd-nested" data-series-key="${escapeAttr(node.key)}">
            <div class="pas-dd-group-header pas-dd-level-${depth}${hasActive ? ' pas-dd-group--has-active' : ''}" title="${escapeAttr(node.displayName)}">
                <span class="pas-dd-series-name">${escapeHtml(node.displayName)}</span>
                ${badgeText ? `<span class="pas-dd-badge pas-dd-version-count">${escapeHtml(badgeText)}</span>` : ''}
                <i class="fas fa-chevron-right pas-dd-group-chevron"></i>
            </div>
            <div class="pas-dd-group-body" style="display:none;">`;
        // 渲染直接归属于当前节点的预设项（按版本倒序）
        const directItems = node.items
            .map(name => optionsMap.get(name))
            .filter(Boolean);
        directItems.sort((a, b) => compareVersion(b.version, a.version));
        for (const it of directItems) {
            const isActive = it.value === currentValue;
            html += `<div class="pas-dd-item${isActive ? ' pas-dd-item--active' : ''}" data-value="${escapeAttr(it.value)}" data-preset-name="${escapeAttr(it.presetName)}" title="${escapeAttr(it.presetName)}">
                    <span class="pas-dd-item-name">${escapeHtml(it.presetName)}</span>
                    ${it.version ? `<span class="pas-dd-version-tag">${escapeHtml(it.version)}</span>` : ''}
                </div>`;
        }
        // 追加递归子节点 HTML
        html += childHtml;
        html += `</div></div>`;
    }
    return html;
}
// =====================================================
// item 点击 → 通过原生 select 切换预设
// =====================================================
function onItemClick(select, value, panel) {
    // 通过 jQuery 设值并触发 change — ST 原生 handler 完全接管
    try {
        // Native dispatch preserves capture-phase switch guards. jQuery.trigger()
        // may invoke target handlers without DOM capture, which can skip the last
        // unsaved edit on APIs that expose only a post-switch event.
        select.value = String(value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // 验证 val 是否实际生效（option 不存在时 jQuery 会静默失败）
        const actual = select.value;
        if (actual !== String(value)) {
            logger.warn(`[Takeover] onItemClick: val mismatch — expected="${value}" actual="${actual}"`);
            toast.warning(t('Preset Switch Failed'));
        } else {
            // 记录"上次使用"——必须以预设名为键（与 getLastUsedMs 读取键一致），
            // 不能用 option.value（如 "15"），否则读取端永远匹配不上 → 上次使用排序退化为导入时间。
            const opt = select.options && select.options[select.selectedIndex];
            const usedName = (opt && (opt.textContent || '').trim()) || String(value);
            recordLastUsed(getApiIdOfSelect(select), usedName);
        }
    } catch (e) {
        logger.warn('[Takeover] onItemClick failed:', e);
    }
    // 关闭 panel
    const wrapper = select.closest('.pas-dd-wrapper');
    if (wrapper) {
        const trigger = wrapper.querySelector('.pas-dd-trigger');
        closePanel(panel, trigger);
    }
    // 刷新 UI（trigger 显示 + active 状态）
    _runtimeTimers.schedule(() => {
        const w = select.closest('.pas-dd-wrapper');
        if (w) {
            updateTriggerDisplay(select, w);
            updateActiveState(select, w);
        }
    }, SELECT_UI_REFRESH_MS);
}
// =====================================================
// 组的展开/收起
// =====================================================
function toggleGroup(group) {
    const body = group.querySelector('.pas-dd-group-body');
    const chevron = group.querySelector('.pas-dd-group-chevron');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (chevron) {
        chevron.classList.toggle('fa-chevron-right', isOpen);
        chevron.classList.toggle('fa-chevron-down', !isOpen);
    }
    group.classList.toggle('pas-dd-group--open', !isOpen);
}
// =====================================================
// 更新 trigger 显示文字
// =====================================================
function updateTriggerDisplay(select, wrapper) {
    const label = wrapper.querySelector('.pas-dd-label');
    if (!label) return;
    // P0 fix: 防御性获取 selectedOpt — 与 compatibility.js:getSelectedPresetName() 同模式
    // 某些 ST 版本下 select 可能不是真正的 HTMLSelectElement（如 sysprompt/reasoning/instruct），
    // 没有 .options 属性，直接 select.options[select.selectedIndex] 会触发 TypeError。
    let selectedOpt = null;
    try {
        if (select && select.options && Number.isInteger(select.selectedIndex) && select.selectedIndex >= 0) {
            selectedOpt = select.options[select.selectedIndex];
        }
    } catch (_) { /* fallback null */ }
    if (!selectedOpt || typeof selectedOpt.textContent !== 'string') {
        label.textContent = '—';
        label.title = '';
        return;
    }
    const presetName = selectedOpt.textContent.trim();
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const info = getSeriesInfo(presetName, overrides);
    if (info.version && info.series) {
        label.textContent = `${info.series} · ${info.version}`;
    } else {
        label.textContent = presetName;
    }
    // title 属性：嵌套模式下显示完整路径，扁平模式显示预设原名
    const panel = wrapper.querySelector('.pas-dd-panel');
    if (settings.nestingEnabled && panel && panel._pasNestedPathMap) {
        const nestedPath = panel._pasNestedPathMap.get(presetName);
        if (nestedPath) {
            label.title = `分组: ${nestedPath}\n预设: ${presetName}`;
        } else {
            label.title = presetName;
        }
    } else {
        label.title = presetName;
    }
}
// =====================================================
// 更新 active 状态
// =====================================================
function updateActiveState(select, wrapper) {
    const panel = wrapper.querySelector('.pas-dd-panel');
    if (!panel) return;
    const currentValue = select.value;
    // 更新 items
    const allItems = panel.querySelectorAll('.pas-dd-item');
    for (const item of allItems) {
        const v = item.getAttribute('data-value');
        item.classList.toggle('pas-dd-item--active', v === currentValue);
    }
    // 更新 group headers 的 has-active 标记
    const groups = panel.querySelectorAll('.pas-dd-group');
    for (const group of groups) {
        const hasActive = group.querySelector('.pas-dd-item--active') !== null;
        const header = group.querySelector('.pas-dd-group-header');
        if (header) {
            header.classList.toggle('pas-dd-group--has-active', hasActive);
        }
    }
}
// =====================================================
// Panel 开/关
// =====================================================
function openPanel(panel, trigger) {
    panel.style.display = 'block';
    // 阶段11：动态 max-width（面板左边缘到视口右边缘-16px安全边距）
    const triggerRect = trigger.getBoundingClientRect();
    const available = Math.max(0, window.innerWidth - triggerRect.left - 16);
    // 修复：移动端 trigger 靠右时 available 坍缩到几十 px，导致面板/排序条宽度为 0 不可用。
    // 移动端用视口宽度做上限并设最小可读宽度 240px，让排序条 flex-wrap 正常换行。
    const isMobile = window.innerWidth <= 520;
    let maxW;
    if (isMobile) {
        const viewportCap = Math.max(240, window.innerWidth - 16);
        maxW = Math.min(viewportCap, 420);
        if (available < 200) maxW = Math.max(maxW, 280);
    } else {
        maxW = Math.min(380, Math.max(200, available));
    }
    panel.style.maxWidth = maxW + 'px';
    // 修复：移动端窄 wrapper 下 CSS `width: max-content` 被解析为 0、
    // `min-width:100%` 又只等于窄 wrapper 宽度，导致面板视觉宽度 0、排序条不可见。
    // 移动端显式给一个确定宽度（视口-16，至少 240px），桌面端保留 max-content 自适应。
    if (isMobile) {
        panel.style.width = Math.max(240, window.innerWidth - 16) + 'px';
    }
    // 根治：position:fixed 脱离 wrapper（mobile 设置抽屉 flex shrink 会把 wrapper 压成 0 宽，
    // 导致 position:absolute 面板被 0 宽 containing block + 抽屉 overflow:hidden 裁剪至不可见）。
    // 改为 fixed 并把面板固定到 trigger 下方相对视口，所有视口恒可见。
    panel.style.position = 'fixed';
    const _minLeft = 8;
    const _maxLeft = window.innerWidth - 16 - 240;
    panel.style.left = Math.max(_minLeft, Math.min(triggerRect.left, _maxLeft > _minLeft ? _maxLeft : _minLeft)) + 'px';
    panel.style.top = (triggerRect.bottom + 4) + 'px';

    if (trigger) {
        trigger.classList.add('pas-dd-trigger--open');
        const chevron = trigger.querySelector('.pas-dd-chevron');
        if (chevron) {
            chevron.classList.remove('fa-chevron-down');
            chevron.classList.add('fa-chevron-up');
        }
    }
    // panel 仍留在 wrapper 内 → panel.parentElement 即 wrapper
    const wrapper = panel.parentElement;
    if (wrapper) {
        const select = wrapper.querySelector('select');
        if (select) {
            updateActiveState(select, wrapper);
            // 打开面板时强制刷新文件时间（timeline 模式下反映最新 mtime，避免会话级缓存导致不随操作变化）
            const _apiId = getApiIdOfSelect(select);
            if (_apiId) fetchRealTimes(_apiId, { force: true });
        }
    }
    // M-2B: 读取 takeoverDefaultExpand 设置决定展开策略
    const settings = getSettings();
    const expandAll = settings.takeoverDefaultExpand;
    // T5: 先收起所有组
    const allOpenGroups = panel.querySelectorAll('.pas-dd-group.pas-dd-group--open');
    for (const g of allOpenGroups) {
        toggleGroup(g); // 收起已展开的组
    }
    if (expandAll) {
        // N-1: 展开所有一级组（不展开二级内容）
        // 嵌套模式下仅展开根级组（depth=0），扁平模式下展开所有
        let rootGroups;
        if (settings.nestingEnabled) {
            // 嵌套模式：仅展开 depth=0 的根级组头
            rootGroups = panel.querySelectorAll('.pas-dd-group-header.pas-dd-level-0');
        } else {
            // 扁平模式：展开所有（与原来行为一致）
            rootGroups = panel.querySelectorAll('.pas-dd-group-header');
        }
        for (const header of rootGroups) {
            const group = header.closest('.pas-dd-group');
            if (group && !group.classList.contains('pas-dd-group--open')) {
                toggleGroup(group);
            }
        }
    }
    // expandAll=false 时，所有组保持收起，不展开任何组
}
function closePanel(panel, trigger) {
    if (panel) {
        panel.style.display = 'none';
        panel.style.maxWidth = '';
    }
    if (trigger) {
        trigger.classList.remove('pas-dd-trigger--open');
        const chevron = trigger.querySelector('.pas-dd-chevron');
        if (chevron) {
            chevron.classList.remove('fa-chevron-up');
            chevron.classList.add('fa-chevron-down');
        }
    }
}
// =====================================================
// 键盘导航
// =====================================================
function navigateItems(panel, direction) {
    // 收集所有可聚焦项（排除 display:none 的元素及其祖先被隐藏的元素）
    const allCandidates = panel.querySelectorAll('.pas-dd-item');
    const items = Array.from(allCandidates).filter(el => {
        // 排除自身 display:none
        if (el.style.display === 'none') return false;
        // 排除被隐藏的 group-body 内的元素（通过检查祖先 .pas-dd-group-body 的 display 状态）
        const body = el.closest('.pas-dd-group-body');
        if (body && body.style.display === 'none') return false;
        return true;
    });
    if (items.length === 0) return;
    const current = panel.querySelector('.pas-dd-item--focused');
    let idx = current ? items.indexOf(current) : -1;
    if (current) current.classList.remove('pas-dd-item--focused');
    idx += direction;
    if (idx < 0) idx = items.length - 1;
    if (idx >= items.length) idx = 0;
    items[idx].classList.add('pas-dd-item--focused');
    items[idx].scrollIntoView({ block: 'nearest' });
}
// =====================================================
// 拆除所有自定义 dropdown（还原原生 select）
// =====================================================
function teardownAllDropdowns() {
    for (const select of _managedSelects) {
        teardownDropdown(select);
    }
    _managedSelects.clear();
    // P0-3: 所有 dropdown 已销毁，断开 MutationObserver 防止泄漏
    if (_selectObserver) {
        try { _selectObserver.disconnect(); } catch (_) {}
        _selectObserver = null;
    }
    if (_docObserver) {
        try { _docObserver.disconnect(); } catch (_) {}
        _docObserver = null;
    }
    // 清除所有 select 上的 pasObserved 标记，确保重新启用接管时不会跳过 observer 注册
    try {
        document.querySelectorAll('select.pas-takeover-select[data-pas-observed]').forEach(s => {
            delete s.dataset.pasObserved;
        });
    } catch (_) {}
}
function teardownDropdown(select) {
    if (!select) return;
    const wrapper = select.closest('.pas-dd-wrapper');
    if (!wrapper) return;
    _selfMutating = true;
    try {
        // 还原 select 样式
        select.style.opacity = '';
        select.style.pointerEvents = '';
        select.style.position = '';
        select.style.width = '';
        select.style.height = '';
        select.style.top = '';
        select.style.left = '';
        select.style.zIndex = '';
        select.removeAttribute(TAKEOVER_DATA_ATTR);
        // 移除上次使用记录监听器
        if (select._pasLastUsedHandler) {
            select.removeEventListener('change', select._pasLastUsedHandler);
            select._pasLastUsedHandler = null;
        }
        // 从 document 上移除 click handler
        if (wrapper._pasDocClickHandler) {
            document.removeEventListener('click', wrapper._pasDocClickHandler, true);
            wrapper._pasDocClickHandler = null;
        }
        // 将 select 移回 wrapper 的 parent，然后移除 wrapper
        const parent = wrapper.parentNode;
        if (parent) {
            parent.insertBefore(select, wrapper);
            parent.removeChild(wrapper);
        }
    } finally {
        _selfMutating = false;
    }
}
// =====================================================
// MutationObserver
// =====================================================
function setupSelectObserver(select) {
    if (!_selectObserver) {
        _selectObserver = new MutationObserver((mutations) => {
            if (_selfMutating) return;
            if (Date.now() < _refreshSuppressUntil) return;
            let needRefresh = false;
            for (const m of mutations) {
                if (m.type !== 'childList') continue;
                if (!m.addedNodes.length && !m.removedNodes.length) continue;
                const hasOption = (nodes) => {
                    for (const n of nodes) {
                        if (n && n.nodeType === 1 && n.tagName === 'OPTION') return true;
                    }
                    return false;
                };
                if (hasOption(m.addedNodes) || hasOption(m.removedNodes)) {
                    needRefresh = true;
                    break;
                }
            }
            if (needRefresh) scheduleRefresh();
        });
    }
    if (!select.dataset.pasObserved) {
        select.dataset.pasObserved = '1';
        try {
            _selectObserver.observe(select, { childList: true });
        } catch (_) {}
    }
}
function setupDocObserver() {
    if (_docObserver) return;
    _docObserver = new MutationObserver((mutations) => {
        if (_selfMutating) return;
        if (Date.now() < _refreshSuppressUntil) return;
        for (const m of mutations) {
            if (m.type !== 'childList' || !m.addedNodes.length) continue;
            for (const n of m.addedNodes) {
                if (!(n instanceof Element)) continue;
                if (n.matches?.(SELECT_SELECTOR) || n.querySelector?.(SELECT_SELECTOR)) {
                    scheduleRefresh();
                    return;
                }
            }
        }
    });
    try {
        _docObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
        });
    } catch (_) {}
}
// =====================================================
// 工具函数
// =====================================================
function getApiIdOfSelect(select) {
    const apiIds = (select.getAttribute('data-preset-manager-for') || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return apiIds[0] || 'openai';
}
// escapeAttr 已从 compatibility.js 导入（见文件顶部）
// compareVersion 已从 preset-grouping.js 统一导入（见文件顶部）

// =====================================================
// 预设接管下拉排序（默认 / 时间 / 自定义）
// =====================================================
const IMPORT_TIME_KEY_PREFIX = 'pas_import_v1::';
// 导入时间兜底基准（固定过去时间戳）：recordImportTime 传入 nativeIndex 时，
// 存储 BASELINE + index*1000，使每个预设获得稳定且可区分的“时间”，
// 满足云端无后端时 timeline 排序仍可重排、方向切换可见。
// 取值：2023-11-15 的 epoch ms，远早于任何真实文件 mtime（~2026 现 ~1.75e12），
// 确保后端真实时间（更大）天然排在兜底值之前，与“真 mtime 更新优先”语义一致。
const IMPORT_TIME_BASELINE = 1700000000000;

// ---- 后端真实时间（文件创建时间）----
// 端点：POST /api/plugins/preset-realtime/times  body: { apiId }  响应: { times: { [apiId]: { [name]: {birthtimeMs,ctimeMs,mtimeMs} } } }
const REAL_TIME_API = '/api/plugins/preset-realtime/times';
const _realTimes = Object.create(null);        // apiId -> { presetName: { birthtimeMs, ctimeMs, mtimeMs } }
const _realTimesFetching = Object.create(null); // apiId -> Promise（进行中的请求，合并去重）
const _realTimesLoaded = Object.create(null);   // apiId -> bool（是否已触发过一次重渲染）

/**
 * 获取 ST 请求头（含有效的 X-CSRF-Token）。
 * 动态获取，绝不静态 import ST 主脚本（避免模块加载失败拖垮本模块）。
 * 优先级：ST context.getRequestHeaders → window.getRequestHeaders → 纯 Content-Type。
 * ⚠️ 绝不能再自行 GET /csrf-token：csrf-sync 的 synchronizerToken 策略下，
 * 每次 GET 都会重新生成并覆盖服务端 session 中的 token，但 ST 客户端 token
 * 不会更新，从而导致 ST 自身与本插件此后所有 POST 全部 CSRF 失败。
 * @returns {object}
 */
function getSTHeaders() {
    try {
        const ctx = (typeof window !== 'undefined' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function')
            ? window.SillyTavern.getContext() : null;
        if (ctx && typeof ctx.getRequestHeaders === 'function') {
            return ctx.getRequestHeaders();
        }
    } catch (_) { /* ignore */ }
    try {
        if (typeof window !== 'undefined' && typeof window.getRequestHeaders === 'function') {
            return window.getRequestHeaders();
        }
    } catch (_) { /* ignore */ }
    return { 'Content-Type': 'application/json' };
}

/**
 * 向后端发起真实时间请求（POST）。
 * 优先使用 jQuery $.ajax —— ST 的 $.ajaxPrefilter 会自动注入它维护的
 * 正确 X-CSRF-Token，不会污染 session，也不会因外部 import 失败而挂掉。
 * 兜底：fetch + getSTHeaders()。
 * @returns {Promise<{ok:boolean, status:number, json:()=>Promise<object>}>}
 */
function postRealTimesRequest(apiId) {
    const jq = (typeof window !== 'undefined' && (window.jQuery || window.$));
    if (jq && typeof jq.ajax === 'function') {
        return new Promise((resolve) => {
            try {
                jq.ajax({
                    url: REAL_TIME_API,
                    method: 'POST',
                    contentType: 'application/json',
                    data: JSON.stringify({ apiId }),
                    success: (data, _textStatus, xhr) => {
                        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json: () => Promise.resolve(data) });
                    },
                    error: (xhr) => resolve({ ok: false, status: xhr ? xhr.status : 0, json: () => Promise.resolve(null) }),
                });
            } catch (e) {
                resolve({ ok: false, status: 0, json: () => Promise.resolve(null) });
            }
        });
    }
    // 兜底：fetch + 动态请求头
    return fetch(REAL_TIME_API, {
        method: 'POST',
        headers: getSTHeaders(),
        body: JSON.stringify({ apiId }),
    }).then(resp => ({
        ok: resp.ok,
        status: resp.status,
        json: () => resp.json(),
    })).catch(() => ({ ok: false, status: 0, json: () => Promise.resolve(null) }));
}

/**
 * 从后端拉取某 apiId 下所有预设文件的真实磁盘创建时间。
 * 幂等：同一 apiId 一次会话只真正拉一次（成功后缓存；进行中合并同一 Promise）。
 * 拉取成功后仅触发【一次】重渲染，使"时间排序"从 localStorage 近似切换到真实时间。
 * 任何失败（CSRF/404/网络）都静默回退 localStorage，绝不阻塞主流程。
 */
function fetchRealTimes(apiId, { force = false } = {}) {
    if (!apiId) return Promise.resolve();
    if (!force && _realTimes[apiId]) return Promise.resolve();
    if (_realTimesFetching[apiId]) return _realTimesFetching[apiId];
    // force 节流：同一 apiId 至少间隔 3 秒，避免频繁打开面板/高频刷新打爆后端
    const now = Date.now();
    if (force && _realTimesLastForceTs[apiId] && (now - _realTimesLastForceTs[apiId] < 3000)) {
        return Promise.resolve();
    }
    if (force) _realTimesLastForceTs[apiId] = now;
    _realTimesFetching[apiId] = (async () => {
        try {
            const resp = await postRealTimesRequest(apiId);
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            const map = (data && data.times && data.times[apiId]) || {};
            _realTimes[apiId] = map;
            _timesVersion++;  // 时间数据更新 → 指纹变化 → timeline 模式 refresh 重排
            logger.info(`[sort] real times loaded for "${apiId}": ${Object.keys(map).length} presets${force ? ' (force)' : ''}`);
        } catch (e) {
            logger.warn(`[sort] real times fetch failed for "${apiId}":`, e && e.message ? e.message : e);
        } finally {
            delete _realTimesFetching[apiId];
        }
    })();
    // 首次成功加载后触发一次重渲染（只触发一次，避免刷新环路）
    _realTimesFetching[apiId].then(() => {
        if (!_realTimesLoaded[apiId] && _realTimes[apiId] && Object.keys(_realTimes[apiId]).length) {
            _realTimesLoaded[apiId] = true;
            try { scheduleRefresh(); } catch (_) { /* ignore */ }
        } else if (force) {
            // force 刷新：_timesVersion 已自增，强制重建使面板立即用最新 mtime 重排
            try { _forceNextRefresh = true; refresh(); } catch (_) { /* ignore */ }
        }
    });
    return _realTimesFetching[apiId];
}

/** 读真实时间（优先后端文件修改时间 mtime，回退 ctime/birthtime，最后回退 localStorage 近似），未知返回 Infinity */
function getRealTimeMs(apiId, name) {
    const rt = _realTimes[apiId];
    if (rt && rt[name]) {
        const e = rt[name];
        // 用户需求：时间排序 = 预设文件"修改时间"。编辑/自动保存预设会更新 mtime → 顺序随之变化。
        if (typeof e.mtimeMs === 'number') return e.mtimeMs;
        if (typeof e.ctimeMs === 'number') return e.ctimeMs;
        if (typeof e.birthtimeMs === 'number') return e.birthtimeMs;
    }
    try {
        const v = localStorage.getItem(IMPORT_TIME_KEY_PREFIX + apiId + '::' + name);
        if (v != null) return Number(v);
    } catch (_) { /* ignore */ }
    return Infinity;
}

/**
 * 记录预设"首次被本插件见到"的时间，作为导入时间的近似（自包含，无需后端）。
 * 该时间持久化在 localStorage，插件重装前一直有效；作为后端不可用时的最终兜底。
 */
/**
 * 记录预设“首次被本插件见到”的时间，作为无后端时的最终兜底。
 * - 传入 nativeIndex（推荐）：写入 BASELINE + index*1000，使每个预设获得
 *   稳定且可区分的伪时间，timeline 排序与方向切换在云端无后端时真正可见。
 * - 未传 nativeIndex：回退为 Date.now()（兼容自动保存触碰等仅知 (apiId,name) 的场景）。
 * 该时间持久化于 localStorage；后端真实文件 mtime 始终优先（更大）。
 */
function recordImportTime(apiId, name, nativeIndex) {
    if (!name) return;
    try {
        const key = IMPORT_TIME_KEY_PREFIX + apiId + '::' + name;
        if (localStorage.getItem(key) == null) {
            let v;
            if (typeof nativeIndex === 'number' && Number.isFinite(nativeIndex) && nativeIndex >= 0) {
                v = String(IMPORT_TIME_BASELINE + nativeIndex * 1000);
            } else {
                v = String(Date.now());
            }
            localStorage.setItem(key, v);
        }
    } catch (_) { /* localStorage 不可用时忽略 */ }
}

/** 读取预设导入时间（ms 时间戳），未知返回 Infinity（排最后） */
function getImportTime(apiId, name) {
    return getRealTimeMs(apiId, name);
}

// ---- 上次使用时间（本地记录：用户切换预设时写入）----
const LASTUSED_KEY_PREFIX = 'pas_lastused_v1::';

/**
 * 记录预设"上次使用"时间（ms 时间戳）。
 * 在用户通过接管下拉切换预设、或 ST 原生预设切换事件触发时调用。
 * 持久化于 localStorage（与导入时间同源策略），作为"上次使用排序"的数据源。
 */
function recordLastUsed(apiId, name) {
    if (!name) return;
    const now = Date.now();
    try {
        localStorage.setItem(LASTUSED_KEY_PREFIX + apiId + '::' + name, String(now));
    } catch (_) { /* localStorage 不可用时忽略 */ }
    // 同步更新内存缓存（排序时直接读 Map，无需再 localStorage.getItem）
    if (!_lastUsedCache[apiId]) _lastUsedCache[apiId] = new Map();
    _lastUsedCache[apiId].set(name, now);
    _timesVersion++;  // 使用记录变化 → 下次 refresh 在 lastused 模式下重排
}

/**
 * 读取预设"上次使用"时间（ms），未知返回 Infinity（排最后）。
 * 未记录过使用时间的预设，回退到导入（文件创建）时间，保证列表稳定。
 */
function getLastUsedMs(apiId, name) {
    // 优先内存缓存（排序时高频读取，避免重复 localStorage.getItem 同步 IO）
    const cache = _lastUsedCache[apiId];
    if (cache && cache.has(name)) return cache.get(name);
    try {
        const v = localStorage.getItem(LASTUSED_KEY_PREFIX + apiId + '::' + name);
        if (v != null) {
            const n = Number(v);
            // 回填缓存，后续读取走内存
            if (!_lastUsedCache[apiId]) _lastUsedCache[apiId] = new Map();
            _lastUsedCache[apiId].set(name, n);
            return n;
        }
    } catch (_) { /* ignore */ }
    // 未记录使用 → 排最后（Infinity），不回退导入/文件时间，确保与 timeline 模式语义区分
    return Infinity;
}

/**
 * 在 ST 原生预设切换事件（OAI_PRESET_CHANGED_AFTER）后记录"上次使用"。
 * 覆盖接管下拉之外的切换路径（如原生 select、其它插件触发的切换）。
 * 带轻量防抖，避免高频重复写入 localStorage。
 */
let _lastUsedRecordTs = 0;
let _lastUsedRecordPending = false;
function recordCurrentPresetLastUsed() {
    const now = Date.now();
    if (now - _lastUsedRecordTs < 250) {
        _lastUsedRecordTs = now;
        if (_lastUsedRecordPending) return;
        _lastUsedRecordPending = true;
        setTimeout(() => { _lastUsedRecordPending = false; _doRecordCurrentLastUsed(); }, 300);
        return;
    }
    _lastUsedRecordTs = now;
    _doRecordCurrentLastUsed();
}
function _doRecordCurrentLastUsed() {
    try {
        const apiId = getCurrentApiId();
        if (!apiId) return;
        const selects = document.querySelectorAll(SELECT_SELECTOR);
        for (const sel of selects) {
            if (getApiIdOfSelect(sel) === apiId) {
                // 以预设名为键（与 getLastUsedMs 一致），而非 option.value
                const opt = Array.from(sel.options || []).find(o => o.value === sel.value);
                const name = (opt && (opt.textContent || '').trim()) || sel.value;
                if (name) recordLastUsed(apiId, String(name));
                break;
            }
        }
    } catch (_) { /* ignore */ }
}

/**
 * 通用 key 排序：根据排序模式对 key 数组排序。
 * @param {Array} keys
 * @param {string} mode 'default' | 'timeline' | 'custom' | 'lastused'
 * @param {string[]} customOrder 自定义顺序（series key 数组）
 * @param {(k:any)=>number} [getTime] 取 key 对应时间的函数（timeline/lastused 用）
 * @param {string} [dir] 'desc'(倒序) | 'asc'(正序)
 * @returns {Array} 排序后的 key 数组
 */
function applySortToKeys(keys, mode, customOrder, getTime, dir) {
    const asc = dir === 'asc';   // 正序
    const arr = Array.from(keys);
    if (mode === 'timeline' || mode === 'lastused') {
        const isLastUsed = mode === 'lastused';
        arr.sort((a, b) => {
            const ta = getTime ? getTime(a) : Infinity;
            const tb = getTime ? getTime(b) : Infinity;
            const ra = ta === Infinity ? 1 : 0;
            const rb = tb === Infinity ? 1 : 0;
            if (isLastUsed && asc) {
                // 上次使用·正序：最久未用在前 → 从未使用(Infinity) 排最前，最近使用排最后
                if (ra !== rb) return rb - ra;
                return ta - tb;
            }
            // timeline(任一方向) 或 lastused·倒序：未知/从未使用排最后
            if (ra !== rb) return ra - rb;
            // desc: 最新/最近在前 (tb-ta)；asc: 最旧/最久在前 (ta-tb)
            return asc ? (ta - tb) : (tb - ta);
        });
    } else if (mode === 'custom') {
        const order = customOrder || [];
        arr.sort((a, b) => {
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            const ha = ia >= 0, hb = ib >= 0;
            if (ha && hb) return asc ? (ia - ib) : (ib - ia);  // 倒序=反转自定义顺序
            if (ha) return -1;
            if (hb) return 1;
            return String(a).localeCompare(String(b));
        });
    } else {
        // default 字母序：asc = A→Z；desc = Z→A
        arr.sort((a, b) => {
            const c = String(a).localeCompare(String(b));
            return asc ? c : -c;
        });
    }
    return arr;
}

/**
 * 扁平模式：对 [[normKey, items], ...] 按当前排序模式排序。
 */
function sortSeriesEntries(entries, settings, apiId) {
    const mode = settings.takeoverSortMode || 'default';
    const customOrder = settings.takeoverCustomOrder || [];
    const dir = settings.takeoverSortDir || 'desc';
    const useLastUsed = mode === 'lastused';
    const timeOf = (items) => {
        let t = Infinity;
        for (const it of items) {
            const tt = useLastUsed ? getLastUsedMs(apiId, it.presetName) : getImportTime(apiId, it.presetName);
            if (tt < t) t = tt;
        }
        return t;
    };
    const keys = entries.map(([k]) => k);
    const sortedKeys = applySortToKeys(keys, mode, customOrder, (k) => {
        const entry = entries.find(([ek]) => ek === k);
        return entry ? timeOf(entry[1]) : Infinity;
    }, dir);
    return entries.slice().sort((a, b) => sortedKeys.indexOf(a[0]) - sortedKeys.indexOf(b[0]));
}

/** 渲染排序条 HTML（默认 / 时间 / 自定义 / 上次 + 方向切换 + 编辑按钮） */
function buildSortBarHtml(settings) {
    const mode = settings.takeoverSortMode || 'default';
    const dir = settings.takeoverSortDir || 'desc';
    const mk = (m, label) =>
        `<button type="button" class="pas-sort-btn${m === mode ? ' pas-sort-btn--active' : ''}" data-sort="${m}">${label}</button>`;
    const editBtn = mode === 'custom'
        ? `<button type="button" class="pas-sort-edit" data-action="edit-custom">编辑顺序</button>`
        : '';
    // 方向按钮：desc=倒序(↓ 晚/最近在前) | asc=正序(↑ 早/久未用在前)
    const dirLabel = dir === 'asc' ? '↑ 正序' : '↓ 倒序';
    const dirTitle = dir === 'asc'
        ? '正序：最早修改/最久未用在前'
        : '倒序：最新修改/最近使用在前';
    const dirBtn = `<button type="button" class="pas-sort-dir" data-action="toggle-dir" title="${dirTitle}">${dirLabel}</button>`;
    return `<div class="pas-sort-bar">${mk('default', '默认')}${mk('timeline', '时间')}${mk('custom', '自定义')}${mk('lastused', '上次')}${dirBtn}${editBtn}</div>`;
}

/**
 * 收集当前 select 的系列 key 与显示名，供自定义排序编辑器使用。
 * 扁平模式返回所有系列；嵌套模式返回根系列（normalized key）。
 */
function collectSeriesKeysForSort(select, apiId, settings) {
    const optionList = Array.from(select.options || []);
    if (settings.nestingEnabled) {
        const overrides = settings.groupingManualOverrides || {};
        const tree = settings.groupingTree || {};
        const maxDepth = settings.nestingMaxDepth || 3;
        const names = [...new Set(
            optionList.map(o => (o.textContent || '').trim()).filter(Boolean)
        )];
        const rootNodes = buildNestedGroupTree(names, overrides, tree, maxDepth, settings.groupingSeriesAliases || {});
        return {
            nesting: true,
            keys: rootNodes.map(n => n.key),
            labels: new Map(rootNodes.map(n => [n.key, n.displayName])),
        };
    }
    const overrides = settings.groupingManualOverrides || {};
    const groups = new Map();
    const labels = new Map();
    for (const opt of optionList) {
        const name = (opt.textContent || '').trim();
        if (!name || _isInvalidPresetName(name)) continue;
        const info = getSeriesInfo(name, overrides);
        const rawKey = info.series || name;
        const normKey = normalizeSeriesKey(rawKey);
        if (!groups.has(normKey)) { groups.set(normKey, []); labels.set(normKey, rawKey); }
        groups.get(normKey).push(name);
    }
    return { nesting: false, keys: Array.from(groups.keys()), labels };
}

/** 自建模态对话框（不依赖外部 popup 模块，降低耦合） */
function showModal(contentEl, onApply) {
    const overlay = document.createElement('div');
    overlay.className = 'pas-cs-overlay';
    const box = document.createElement('div');
    box.className = 'pas-cs-modal';
    box.appendChild(contentEl);
    const footer = document.createElement('div');
    footer.className = 'pas-cs-footer';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'menu_button';
    btnCancel.textContent = '取消';
    const btnApply = document.createElement('button');
    btnApply.className = 'menu_button';
    btnApply.textContent = '保存';
    footer.appendChild(btnCancel);
    footer.appendChild(btnApply);
    box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    btnCancel.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    btnApply.addEventListener('click', () => {
        try { onApply(); } catch (e) { logger.warn('[Sort] apply failed', e); }
        close();
    });
    return close;
}

/** 打开自定义排序编辑器（拖拽系列顺序） */
function openCustomSortEditor(select, apiId) {
    const settings = getSettings();
    const { keys, labels } = collectSeriesKeysForSort(select, apiId, settings);
    let order = (settings.takeoverCustomOrder || []).filter(k => keys.includes(k));
    const remaining = keys.filter(k => !order.includes(k));
    const orderedKeys = [...order, ...remaining];

    const items = orderedKeys.map((k, i) => `
        <li class="pas-cs-item" data-key="${escapeAttr(k)}">
            <span class="pas-cs-handle"><i class="fas fa-grip-vertical"></i></span>
            <span class="pas-cs-index">${i + 1}</span>
            <span class="pas-cs-name">${escapeHtml(labels.get(k) || k)}</span>
        </li>`).join('');
    const container = document.createElement('div');
    container.className = 'pas-cs-popup';
    container.innerHTML = `
        <h3>自定义预设顺序</h3>
        <p class="pas-cs-hint">拖拽系列调整顺序，保存后生效（未列入的系列按名称排在最后）。</p>
        <ul class="pas-cs-list">${items}</ul>`;
    const list = container.querySelector('.pas-cs-list');
    const $ = (window.jQuery || window.$);
    if ($ && $.fn && $.fn.sortable) {
        $(list).sortable({ handle: '.pas-cs-handle', axis: 'y', placeholder: 'pas-cs-placeholder' });
    }

    showModal(container, () => {
        const newOrder = [];
        list.querySelectorAll('.pas-cs-item').forEach(li => newOrder.push(li.getAttribute('data-key')));
        updateSetting('takeoverCustomOrder', newOrder);
        updateSetting('takeoverSortMode', 'custom');
        // 强制重建 panel（绕过指纹守卫），确保自定义顺序保存后立即生效
        _forceNextRefresh = true;
        refresh();
    });
}

/** panel 内排序条点击处理；返回 true 表示已处理（应阻止后续逻辑） */
function handleSortBarClick(e, select, panel) {
    const btn = e.target.closest('.pas-sort-btn');
    if (btn) {
        e.stopPropagation();
        const mode = btn.getAttribute('data-sort');
        if (mode) {
            updateSetting('takeoverSortMode', mode);
            // 切换到 timeline 模式时强制刷新文件 mtime，确保用最新修改时间排序
            if (mode === 'timeline') {
                const _apiId = getApiIdOfSelect(select);
                if (_apiId) fetchRealTimes(_apiId, { force: true });
            }
            // 强制重建 panel（绕过指纹守卫），确保切换排序后下拉内容立即重排
            _forceNextRefresh = true;
            refresh();
        }
        return true;
    }
    const dirBtn = e.target.closest('.pas-sort-dir');
    if (dirBtn) {
        e.stopPropagation();
        const s = getSettings();
        const next = (s.takeoverSortDir === 'asc') ? 'desc' : 'asc';
        updateSetting('takeoverSortDir', next);
        // 强制重建 panel（绕过指纹守卫），确保切换方向后下拉内容立即重排
        _forceNextRefresh = true;
        refresh();
        return true;
    }
    const edit = e.target.closest('.pas-sort-edit');
    if (edit) {
        e.stopPropagation();
        const apiId = getApiIdOfSelect(select);
        openCustomSortEditor(select, apiId);
        return true;
    }
    return false;
}

// =====================================================
// 公开 API
// =====================================================
/**
 * 重做接管（外部触发）
 * @param {object} [options]
 * @param {boolean} [options.force] - 若为 true，跳过防抖/抑制/指纹缓存，立即强制重建所有 dropdown
 */
export function refreshTakeover({ force = false, _overrides = null, _tree = null } = {}) {
    // Bug fix: 缓存 overrides/tree，防止 SETTINGS_UPDATED 触发的二次 refresh() 用空值覆盖
    if (_overrides) _cachedOverrides = _overrides;
    if (_tree) _cachedTree = _tree;
    if (!force) {
        // 非 force 模式暂不支持额外参数传递，走常规调度
        scheduleRefresh();
        return;
    }
    // P0-4: force 模式下的硬节流 — 连续调用间隔不得低于 REFRESH_FORCE_MIN_INTERVAL_MS
    const now = Date.now();
    if (now - _lastRefreshTs < REFRESH_FORCE_MIN_INTERVAL_MS) {
        // Bug 6 fix: 节流降级时也要设置 _forceNextRefresh，确保下次 scheduleRefresh 触发的 refresh() 强制重建
        // 否则 groupingTree 变更后接管面板不会更新嵌套视图
        _forceNextRefresh = true;
        // 过于密集，降级为 scheduleRefresh（合并到常规防抖流程）
        logger.debug('[Takeover] refreshTakeover({ force: true }) throttled — too frequent, falling back to scheduleRefresh');
        scheduleRefresh();
        return;
    }
    // AG-1: 强制模式 — 清除所有守卫，立即重建
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
    }
    _refreshSuppressUntil = 0;
    _forceNextRefresh = true;
    logger.debug('[Takeover] refreshTakeover({ force: true }) — immediate rebuild');
    try {
        // Bug B: 支持外部传入 overrides/tree，绕过 getSettings() 时序问题
        refresh(_overrides, _tree);
    } catch (e) {
        logger.error('[Takeover] force refresh failed:', e);
    }
}
/**
 * 返回指定 API 的所有预设名（直接从 select.options 读取，不再有 detached 概念）
 *
 * @param {string} [filterApiId] 仅返回该 apiId 的预设；不传 = 当前 API；'*' = 全部
 * @returns {Array<{apiId: string, presetName: string, detached: boolean}>}
 */
export function listAllPresetsIncludingDetached(filterApiId) {
    const out = [];
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (_) {
        return out;
    }
    let target = filterApiId;
    if (target === undefined || target === null) {
        try { target = getCurrentApiId(); } catch (_) { target = 'openai'; }
    }
    const wantAll = (target === '*');
    const seen = new Set();
    for (const sel of selects) {
        if (!sel || !sel.isConnected) continue;
        const apiId = getApiIdOfSelect(sel);
        if (!wantAll && apiId !== target) continue;
        for (const opt of sel.options || []) {
            const realName = (opt.textContent || opt.value || '').trim();
            if (_isInvalidPresetName(realName)) continue;
            const key = `${apiId}::${realName}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ apiId, presetName: realName, detached: false });
        }
    }
    return out;
}
/**
 * 列出所有 select 当前可见的"系列代表"
 * 返回 [{ apiId, seriesKey, items, representativeName, versionCount }]
 */
export function listSeriesFromNativeSelects() {
    const settings = getSettings();
    const overrides = settings.groupingManualOverrides || {};
    const out = [];
    let selects;
    try {
        selects = document.querySelectorAll(SELECT_SELECTOR);
    } catch (_) {
        return out;
    }
    const seenSeriesByApi = new Map();
    for (const select of selects) {
        if (!select || !select.isConnected) continue;
        const apiId = getApiIdOfSelect(select);
        // 直接从 select.options 读取所有预设名（不再有 detached）
        const allNames = Array.from(select.options || [])
            .map(o => (o.textContent || '').trim())
            .filter(Boolean);
        const unique = [...new Set(allNames)];
        // T4 fix: 使用 normalizeSeriesKey 确保与 renderDropdownContent 分组一致
        const seriesGroups = new Map();
        const seriesDisplayKeys = new Map(); // normKey → first-seen original case
        for (const name of unique) {
            const info = getSeriesInfo(name, overrides);
            const rawSeriesKey = info.series || name;
            const normKey = normalizeSeriesKey(rawSeriesKey);
            if (!seriesGroups.has(normKey)) {
                seriesGroups.set(normKey, []);
                seriesDisplayKeys.set(normKey, rawSeriesKey);
            }
            seriesGroups.get(normKey).push({
                presetName: name,
                version: info.version,
                duplicate: info.duplicate,
                manualOverride: info.manualOverride,
            });
        }
        if (!seenSeriesByApi.has(apiId)) seenSeriesByApi.set(apiId, new Set());
        const seenSet = seenSeriesByApi.get(apiId);
        for (const [normKey, items] of seriesGroups) {
            if (seenSet.has(normKey)) continue;
            seenSet.add(normKey);
            const displayKey = seriesDisplayKeys.get(normKey) || normKey;
            const rep = pickRepresentativeVersion(displayKey, items, settings.seriesDefaultApply || {});
            out.push({
                apiId,
                seriesKey: displayKey,
                items,
                representativeName: rep ? rep.presetName : (items[0]?.presetName || ''),
                versionCount: items.length,
            });
        }
    }
    return out;
}
/**
 * 获取当前预设所属系列的"默认应用版本"
 */
export function getSeriesDefaultApply(seriesKey) {
    const map = getSettings().seriesDefaultApply || {};
    return map[seriesKey] || '';
}
// =====================================================
// 卸载
// =====================================================
export async function teardown() {
    _tearingDown = true;
    _runtimeTimers.clearAll();
    try { teardownAllDropdowns(); } catch (_) {}
    if (_refreshTimer) {
        clearTimeout(_refreshTimer);
        _refreshTimer = null;
    }
    if (_selectObserver) {
        try { _selectObserver.disconnect(); } catch (_) {}
        _selectObserver = null;
    }
    if (_docObserver) {
        try { _docObserver.disconnect(); } catch (_) {}
        _docObserver = null;
    }
    for (const unsub of _eventUnsubscribers) {
        try { typeof unsub === 'function' && unsub(); } catch (_) {}
    }
    _eventUnsubscribers = [];
    if (_settingUnsubscribe) {
        try { _settingUnsubscribe(); } catch (_) {}
        _settingUnsubscribe = null;
    }
    // 清掉所有 select 上的标记
    try {
        const allSel = document.querySelectorAll('select[data-preset-manager-for]');
        for (const s of allSel) {
            delete s.dataset.pasObserved;
        }
    } catch (_) {}
    _managedSelects.clear();
    _refreshSuppressUntil = 0;
    _takeoverActive = false;
    _initialized = false;
    await whenSeedIdle();
    logger.info('Preset takeover torn down');
}
// =====================================================
// 种子快照
// =====================================================
let _seedingRunning = false;
/**
 * 给当前 ST 所有现存预设建立"初始快照"
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]
 * @param {boolean} [opts.silent=false]
 */
export async function seedSnapshotsIfNeeded(opts = {}) {
    const { force = false, silent = false } = opts;
    if (_seedingRunning) {
        logger.debug('[Seed] already running, skip');
        return { skipped: true };
    }
    const settings = getSettings();
    if (!settings.enabled || !settings.groupingEnabled) {
        logger.debug('[Seed] disabled by settings, skip');
        return { skipped: true };
    }
    // AT0: 如果首次扫描向导尚未完成（用户还没确认"建立分组"），跳过自动种子
    if (!force && !settings.groupingFirstScanDone) {
        logger.debug('[Seed] groupingFirstScanDone=false, skip until user confirms');
        return { skipped: true };
    }
    if (!force && !settings.autoSeedOnTakeover) {
        logger.debug('[Seed] autoSeedOnTakeover=false, skip');
        return { skipped: true };
    }
    _seedingRunning = true;
    beginSeedActivity();
    try {
        const apiId = getCurrentApiId();
        if (!apiId) {
            logger.warn('[Seed] no current API id, skip');
            return { skipped: true };
        }
        // 直接用 listAllPresetsIncludingDetached（现在读 select.options，不再有 detached）
        const fromDOM = listAllPresetsIncludingDetached(apiId) || [];
        const allNames = fromDOM
            .filter(e => e && e.apiId === apiId && typeof e.presetName === 'string' && e.presetName)
            .map(e => e.presetName);
        if (allNames.length === 0) {
            logger.debug('[Seed] no presets in ST');
            return { skipped: true, total: 0 };
        }
        if (silent) {
            logger.debug(`[Seed] checking ${allNames.length} presets for missing initial snapshots...`);
        } else {
            logger.info(`[Seed] checking ${allNames.length} presets for missing initial snapshots...`);
        }
        if (!silent) {
            try { toast.info(t('Seed Snapshots Start', { count: allNames.length })); } catch (_) {}
        }
        let added = 0;
        let skipped = 0;
        let failed = 0;
        const total = allNames.length;
        for (let i = 0; i < allNames.length; i++) {
            if (_tearingDown) {
                logger.debug('[Seed] stopped because takeover is tearing down');
                break;
            }
            const name = allNames[i];
            try {
                const existing = await getSnapshots(apiId, name);
                if (Array.isArray(existing) && existing.length > 0) {
                    skipped++;
                } else {
                    const data = getPresetSnapshot(name);
                    if (!data || typeof data !== 'object') {
                        failed++;
                        continue;
                    }
                    const snap = await addSnapshot(name, apiId, data, TRIGGER.MANUAL);
                    if (snap) {
                        added++;
                    } else {
                        failed++;
                    }
                }
            } catch (e) {
                logger.debug(`[Seed] error for "${name}":`, e);
                failed++;
            }
            if (i % 5 === 4 && i < allNames.length - 1) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
        const seedLogMsg =
            `[Seed] complete: added=${added}, skipped=${skipped}` +
            (failed > 0 ? `, failed=${failed}` : '') +
            ` (total=${total})`;
        if (added > 0) {
            logger.success(seedLogMsg);
        } else {
            logger.debug(seedLogMsg);
        }
        if (!silent) {
            try {
                if (added > 0) {
                    toast.success(t('Seed Snapshots Done', { added, skipped, total }));
                }
            } catch (_) {}
        }
        if (!_tearingDown) {
            try {
                updateSetting('seedSnapshotsDone', true);
            } catch (_) {}
        }
        return { added, skipped, failed, total };
    } catch (e) {
        logger.error('[Seed] seedSnapshotsIfNeeded failed:', e);
        return { error: String(e) };
    } finally {
        _seedingRunning = false;
        endSeedActivity();
    }
}
/**
 * 为单个预设创建初始快照（如果尚无快照）
 * V-1: 用于导入检测和切换时补种，避免新导入预设显示 "0 · 0 B · —"
 *
 * @param {string} presetName
 * @param {string} [apiId] - 不传则自动获取当前 API
 * @returns {Promise<{seeded: boolean}>}
 */
export async function seedSnapshotForPreset(presetName, apiId) {
    if (_tearingDown) return { seeded: false };
    beginSeedActivity();
    try {
        const aid = apiId || getCurrentApiId();
        if (!aid || !presetName) return { seeded: false };
        const existing = await getSnapshots(aid, presetName);
        if (_tearingDown) return { seeded: false };
        if (Array.isArray(existing) && existing.length > 0) {
            return { seeded: false };
        }
        const data = getPresetSnapshot(presetName);
        if (!data || typeof data !== 'object') {
            logger.debug(`[Seed] no data for "${presetName}", skip single-seed`);
            return { seeded: false };
        }
        const snap = await addSnapshot(presetName, aid, data, TRIGGER.MANUAL);
        if (snap) {
            logger.info(`[Seed] initial snapshot created for "${presetName}"`);
            return { seeded: true };
        }
        return { seeded: false };
    } catch (e) {
        logger.debug(`[Seed] seedSnapshotForPreset error for "${presetName}":`, e);
        return { seeded: false };
    } finally {
        endSeedActivity();
    }
}
/**
 * 强制重新种子
 */
export async function forceReseedSnapshots() {
    return seedSnapshotsIfNeeded({ force: true, silent: false });
}
/**
 * 从归档还原所有被数据接管的预设到 ST PresetManager
 */
export async function restoreAllFromArchive() {
    try {
        const archives = await listArchivedPresets({ strict: true });
        if (!archives || archives.length === 0) {
            logger.debug('[Takeover-Data] no archives to restore');
            return { restored: 0, failed: 0, cleanupFailed: 0, fromSnapshot: 0, fromArchive: 0 };
        }
        const result = await restoreArchiveEntries(archives, {
            getSnapshots,
            persistPreset: async (entry, preset, context) => {
                await savePresetSafe(entry.presetName, preset, { apiId: entry.apiId });
                const sourceLabel = context.source === 'snapshot'
                    ? `snapshot(${context.snapshot?.id?.slice(0, 6) || '?'}, ts=${context.snapshot?.timestamp})`
                    : 'archive';
                logger.debug(`[Takeover-Data] restored "${entry.presetName}" from ${sourceLabel}`);
            },
            removeArchive: entry => removeArchivedPreset(entry.apiId, entry.presetName),
            onError: ({ phase, archive, error }) => {
                const message = `[Takeover-Data] ${phase} failed for "${archive?.presetName || '?'}"`;
                if (phase === 'snapshot') logger.debug(message, error);
                else logger.warn(message, error);
            },
        });
        logger.success(
            `[Takeover-Data] restore complete: ${result.restored} restored ` +
            `(${result.fromSnapshot} from latest snapshot · ${result.fromArchive} from archive)` +
            (result.failed > 0 ? ` · ${result.failed} failed` : '') +
            (result.cleanupFailed > 0 ? ` · ${result.cleanupFailed} archive cleanup failed` : '')
        );
        return result;
    } catch (e) {
        logger.error('[Takeover-Data] restoreAllFromArchive failed:', e);
        return { restored: 0, failed: 1, cleanupFailed: 0, fromSnapshot: 0, fromArchive: 0, error: String(e) };
    }
}
/**
 * 公开 API：列出当前归档
 */
export async function getArchiveSummary() {
    const archives = await listArchivedPresets();
    return {
        count: archives.length,
        items: archives.map(a => ({
            apiId: a.apiId,
            presetName: a.presetName,
            seriesKey: a.seriesKey,
            archivedAt: a.archivedAt,
            reason: a.reason,
        })),
    };
}

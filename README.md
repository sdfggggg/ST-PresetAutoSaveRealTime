# Preset Sorter（预设排序器）

> 为 **TauriTavern**（SillyTavern 1.18 前端 + Tauri/Rust 后端，实机验证版本 2.3.0）编写的第三方前端扩展：
> 按 **导入时间** 和 **使用情况** 对预设下拉框排序，支持多种排序模式与持久化，兼容原版 SillyTavern 与多平台（Windows/macOS/Linux/Android/iOS）。

- 版本：1.0.0
- 依赖：无（纯前端 ES Module，零构建、零第三方运行库）
- 隐私：不联网、不上传、不改动预设文件；只在 SillyTavern 的 `extension_settings` 中保存扩展设置与统计

---

## 1. 功能

- 在预设下拉框所在行增加一个紧凑的 **排序方式** 选择器（例如「AI Response Configuration」中的 Chat Completion Presets 下拉框右侧）。
- 排序模式：

  | 模式 | 说明 |
  | --- | --- |
  | 默认顺序 | 保持 SillyTavern 原始顺序（不重排，默认值） |
  | 导入时间：早 → 晚 | 按预设文件的创建时间升序 |
  | 导入时间：晚 → 早 | 按预设文件的创建时间降序 |
  | 使用次数：多 → 少 | 按该预设被用于生成对话的次数降序 |
  | 最近使用：近 → 远 | 按最近一次使用时间降序 |

- 排序只改变 `<option>` 的显示顺序，**不修改** 预设名称、内容、绑定关系与当前选中项；不触发 `change` 事件，不改变 SillyTavern 内存数据。
- 鼠标悬停预设项可查看「导入时间（来源） / 使用次数 / 最近使用」原生提示（始终开启，不影响选择）。
- 设置与统计持久化在 `settings.json` 的 `extension_settings["preset-sorter"]`；TauriTavern 与原版 SillyTavern 共用同一数据目录时统计可延续。
- 扩展设置面板（Extensions 设置区）：启用开关、默认排序方式、是否应用到全部预设管理器、刷新导入时间、重置使用统计、诊断信息。
- 支持全部 8 个预设管理器：OpenAI（对话补全）、TextGen、KoboldAI、NovelAI、上下文模板、指令模板、系统提示词、推理模板。

## 2. 兼容性

| 环境 | 排序 | 导入时间来源 | 使用统计 |
| --- | --- | --- | --- |
| TauriTavern 桌面（Windows / macOS / Linux） | ✅ | 文件 `birthtime`（不可用时 `mtime`） | ✅ |
| TauriTavern Android / iOS | ✅ | 视平台文件系统提供 `birthtime`/`mtime` | ✅ |
| 原版 SillyTavern（浏览器） | ✅ | 首次发现时间（无文件系统访问） | ✅ |
| 自定义数据目录 / portable 模式 | ✅ | TauriTavern 会把运行时数据目录加入宿主 fs 授权范围，通常仍可读取 | ✅ |

默认排序方式为「默认顺序」，因此安装后不会立刻改变任何下拉框的顺序；在任意一个预设下拉框旁选择排序模式后立即生效。
「应用到所有预设管理器」默认开启：在任一预设下拉框切换排序模式时，所有预设管理器统一使用该模式；关闭后每个预设管理器可分别设置。

验证状态：已在 TauriTavern 2.3.0 的隔离 portable 实例中完成实机 E2E（扩展加载、排序、选中保持、使用统计、文件时间读取），
并已安装到真实数据目录验证（247/247 预设导入时间解析成功）。测试与证据见仓库 `docs/TEST-REPORT.md`、
`_research/LIVE-TEST-REPORT.md` 与 `_research/REAL-DATA-REPORT.md`。

## 3. 安装

### 3.1 TauriTavern（推荐）

1. 找到数据目录（`data_root`）：
   - **Windows**：`%APPDATA%\com.tauritavern.client\data`
   - **macOS**：`~/Library/Application Support/com.tauritavern.client/data`
   - **Linux**：`~/.config/com.tauritavern.client/data`（或 `$XDG_CONFIG_HOME` 下）
   - **Android**：应用数据目录下的 `data/`（以应用内「设置 → 数据目录」显示为准）
   - 自定义数据目录：以 TauriTavern「设置 → System → Data Directory」显示的路径为准。
2. 将本扩展整个 `preset-sorter/` 文件夹复制到：
   - 当前用户：`<data_root>/default-user/extensions/preset-sorter/`
   - 或全局（所有用户）：`<data_root>/extensions/third-party/preset-sorter/`
3. 重启 TauriTavern（扩展在启动时发现并自动启用；若扩展面板中显示为禁用，勾选启用后重启）。

目录结构应为：

```text
<data_root>/default-user/extensions/preset-sorter/
├── manifest.json
├── index.js
├── settings.html
├── style.css
├── package.json
└── src/ ...
```

### 3.2 原版 SillyTavern

复制到 SillyTavern 安装目录的 `public/scripts/extensions/third-party/preset-sorter/`，
或在「扩展」面板使用「Install extension」从本地目录安装，然后刷新页面。

## 4. 使用

1. 打开任意包含预设下拉框的面板（如「AI Response Configuration」）。
2. 在下拉框右侧找到新增的 **排序** 选择器，选择排序方式即可立即生效；选择会持久化。
3. 需要更细的控制时，到「扩展设置 → Preset Sorter」：
   - **启用预设排序**：总开关，关闭后恢复 SillyTavern 原始顺序；
   - **默认排序方式**：全局默认模式（「应用到所有预设管理器」开启时即所有管理器使用该模式）；
   - **应用到所有预设管理器**：默认开启；关闭后可分别设置各预设管理器的排序方式；
   - **刷新导入时间**：清除缓存并重新从 Tauri 宿主读取文件时间（批量复制预设后使用）；
   - **重置使用统计**：二次确认后清零使用次数与最近使用时间，保留导入时间。
4. 诊断信息会显示文件系统时间是否可用、数据目录/用户、已跟踪预设数、已解析导入时间数。

## 5. 导入时间：来源与限制（请阅读）

扩展按以下优先级确定一个预设的「导入时间」：

1. 预设 JSON 文件的 **创建时间**（`birthtime`，经 Tauri 宿主 `plugin:fs` 读取）；
2. 若创建时间不可用，使用 **修改时间**（`mtime`）；
3. 若无法访问文件系统（原版 SillyTavern、权限受限、自定义目录不可读等），使用 **首次发现时间**（扩展第一次看到该预设的时间）。

限制：

- **批量复制/迁移数据的存量预设**：文件创建时间会变成复制时间（同一毫秒级窗口）。此时排序是确定且稳定的，但反映的是复制顺序，而不是你当初逐个导入的时间；扩展无法恢复已被复制的历史顺序。安装后可点击「刷新导入时间」重新读取，但对存量数据结果相同。
- **更新预设**：在提供 `birthtime` 的平台不会改变导入时间；仅提供 `mtime` 的平台会把更新视为更近的时间。
- **首次发现时间**：从扩展第一次运行开始记录；对安装前就存在的预设无法凭空得到真实导入时间。

> 本机实测（72 个真实预设）：文件创建时间跨度约 83ms、66 个不同毫秒值，属于典型的批量迁移数据。排序仍然确定、可复现；新导入的预设会获得真实的创建时间并被正确排序。

## 6. 使用统计语义

- 「使用次数 / 最近使用」统计的是 **当前 API 的预设实际用于生成对话** 的次数与时间：监听 SillyTavern 的 `GENERATION_AFTER_COMMANDS` 事件，在非 dry-run、非 `quiet` 生成时记录当前预设管理器所选中的预设。
- 只统计当前激活 API 的预设（例如使用 OpenAI 对话补全时统计 Chat Completion Preset；切换到 TextGen/Kobold/Novel 时统计对应预设，高级格式化的模板同理由各自管理器在激活时统计）。
- 统计从扩展安装后开始累积，不包含历史数据（SillyTavern 不保存预设历史使用记录）。
- 数据保存在 `extension_settings["preset-sorter"]`；换用同一数据目录的 TauriTavern/SillyTavern 时继续累积。
- 重命名预设会迁移其统计；删除预设会移除对应统计。
- 关闭「启用预设排序」时不会记录新的使用统计；如需长期统计请保持开启（排序模式仍可选择「默认顺序」，不影响顺序）。

## 7. 性能

- 启动时优先用内存/持久化缓存立即排序，不阻塞页面；文件时间读取在浏览器空闲时批量异步执行（并发 4、单次超时 4s），缓存命中后不再访问磁盘。
- 重排使用一次 `DocumentFragment` 批量提交，避免逐项触发布局；重复排序会先比较顺序，一致时零 DOM 操作。
- 仅监听受支持的预设下拉框（`childList`），回调批量合并，忽略自身重排产生的变更；tooltip 仅在内容变化时写入。
- 实测（Node 基准，`tests/perf/bench.mjs`）：5000 个预设排序约 0.37–1.66ms；1500 项 DOM 重排约 3.3ms；重复应用零变更。

## 8. 故障排查

- **看不到排序控件**：确认扩展已启用并重启；确认当前面板的预设下拉框带 `data-preset-manager-for` 属性（SillyTavern 1.18+ / TauriTavern）。
- **导入时间显示「首次出现」**：宿主文件时间读取不可用。打开扩展设置面板的「诊断信息」查看原因；原版 SillyTavern 浏览器环境属预期降级。
- **排序后当前选中预设变了**：不应发生（扩展会保持选中值）。如遇到请附带浏览器控制台日志反馈。
- **设置文件过大**：统计按每个预设管理器最多 600 条自动裁剪，不会无限增长。
- **调试**：浏览器控制台可读取只读诊断对象 `window.__PRESET_SORTER__.getStatus()`。

## 9. 卸载

- 在「扩展」面板禁用，或删除扩展目录；
- 可选：清除 `settings.json` → `extension_settings["preset-sorter"]` 键，移除本扩展的设置与统计（不影响任何预设文件）。

## 10. 开发与测试

```bash
# 单元测试（Node 内置 test runner，无依赖）
node --test tests/unit

# 冒烟检查扩展清单与模块可加载性
node tests/smoke/import-extension.mjs

# 性能基准（--strict 会把 dom-bridge 实测纳入）
node tests/perf/bench.mjs --strict

# 只读分析真实预设目录
node tools/verify-real-data.mjs
```

设计文档见仓库 `docs/DESIGN.md`；真实数据只读分析见 `_research/REAL-DATA-REPORT.md`，
隔离实例实机验证见 `_research/LIVE-TEST-REPORT.md`。

## 11. 致谢与说明

- 面向 TauriTavern / SillyTavern 生态的兼容扩展，遵循对应项目的行为约定。
- 预设文件名映射规则与 TauriTavern 的 `sanitize_filename`（`sanitize-filename@1.6.3`）保持一致。
- 本扩展只读预设文件元数据，不读取/修改预设内容。

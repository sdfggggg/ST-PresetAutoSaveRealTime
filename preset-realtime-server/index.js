import fs from 'node:fs';
import path from 'node:path';

/**
 * preset-realtime — 预设文件真实创建时间后端
 *
 * 为 SillyTavern 的预设接管下拉（PresetAutoSave 等）提供每个预设文件的
 * 真实磁盘时间（birthtime / ctime / mtime），用于"按导入时间排序"。
 *
 * 与单纯前端 localStorage 记录"首次见到"不同，这里读取文件系统的
 * 真实创建时间，反映预设文件真正被写入磁盘的时刻。
 *
 * 端点：
 *   POST /api/plugins/preset-realtime/times
 *     请求体：{ apiId?: string, apiIds?: string[] }
 *     响应：{
 *       times: { [apiId]: { [presetName]: { birthtimeMs, ctimeMs, mtimeMs } } },
 *       serverNow: number
 *     }
 *
 * 鉴权：SillyTavern 在挂载插件路由时已应用登录 / 用户中间件，
 *       可直接使用 request.user.directories。
 */

export const info = {
    id: 'preset-realtime',
    name: 'Preset Realtime',
    description: 'Provides real on-disk creation/modification times of preset files for import-time sorting.',
};

/**
 * 将预设管理器的 apiId 映射到用户目录键。
 * 与 SillyTavern src/endpoints/presets.js 的 getPresetSettingsByAPI 保持一致。
 * @param {string} apiId
 * @returns {string|null} directories 上的键名
 */
function directoryKeyForApi(apiId) {
    switch (apiId) {
        case 'openai':
            return 'openAI_Settings';
        case 'kobold':
        case 'koboldhorde':
            return 'koboldAI_Settings';
        case 'novel':
            return 'novelAI_Settings';
        case 'textgenerationwebui':
            return 'textGen_Settings';
        case 'instruct':
            return 'instruct';
        case 'context':
            return 'context';
        case 'sysprompt':
            return 'sysprompt';
        case 'reasoning':
            return 'reasoning';
        default:
            return null;
    }
}

/**
 * 扫描某个 apiId 对应目录，返回每个预设文件（去扩展名）的真实时间。
 * @param {string} apiId
 * @param {object} directories request.user.directories
 * @returns {object} { [presetName]: { birthtimeMs, ctimeMs, mtimeMs } }
 */
function scanApiPresets(apiId, directories) {
    const key = directoryKeyForApi(apiId);
    const result = {};
    if (!key || !directories || !directories[key]) {
        return result;
    }
    const folder = directories[key];
    if (!folder || !fs.existsSync(folder)) {
        return result;
    }
    let files;
    try {
        files = fs.readdirSync(folder);
    } catch {
        return result;
    }
    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (ext !== '.json') continue;
        const filePath = path.join(folder, file);
        try {
            const stat = fs.statSync(filePath);
            const name = path.parse(file).name;
            result[name] = {
                birthtimeMs: stat.birthtimeMs || stat.ctimeMs,
                ctimeMs: stat.ctimeMs,
                mtimeMs: stat.mtimeMs,
            };
        } catch {
            // 跳过无法 stat 的文件
        }
    }
    return result;
}

export function init(router) {
    router.post('/times', (request, response) => {
        try {
            const body = request.body || {};
            const directories = request.user?.directories;
            if (!directories) {
                return response.status(401).json({ error: 'No user directories (not authenticated?)' });
            }

            /** @type {string[]} */
            let apiIds = [];
            if (Array.isArray(body.apiIds) && body.apiIds.length) {
                apiIds = body.apiIds.filter(x => typeof x === 'string').slice(0, 32);
            } else if (typeof body.apiId === 'string' && body.apiId) {
                apiIds = [body.apiId];
            } else {
                // 默认返回常用类型，避免前端未传时整页空白
                apiIds = ['openai'];
            }

            const times = {};
            for (const apiId of apiIds) {
                times[apiId] = scanApiPresets(apiId, directories);
            }

            response.json({ times, serverNow: Date.now() });
        } catch (error) {
            console.error('[preset-realtime] Failed to get times:', error);
            response.status(500).json({ error: error?.message || String(error) });
        }
    });
}

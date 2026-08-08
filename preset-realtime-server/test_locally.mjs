import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(__dirname, 'index.js')).href);

// 1) 准备临时目录与几个预设文件（创建时间天然不同）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prt-test-'));
const dirs = { openAI_Settings: tmp, instruct: path.join(tmp, 'instruct') };
fs.mkdirSync(dirs.instruct, { recursive: true });

const names = ['Alpha v1', 'Beta v2', 'Gamma'];
for (const n of names) {
    fs.writeFileSync(path.join(tmp, n + '.json'), '{}');
    await new Promise(r => setTimeout(r, 30));
}
fs.writeFileSync(path.join(dirs.instruct, 'Instruct A.json'), '{}');

// 2) 构造 mock router + 调用 /times
const handlers = {};
const router = { post: (p, h) => { handlers[p] = h; } };
mod.init(router);

function call(body) {
    return new Promise((resolve) => {
        const req = { body, user: { directories: dirs } };
        const res = {
            _status: 200,
            _json: null,
            status(s) { this._status = s; return this; },
            json(j) { this._json = j; resolve({ status: this._status, json: j }); },
        };
        handlers['/times'](req, res);
    });
}

const { status, json } = await call({ apiId: 'openai' });
console.log('status =', status);
console.log('openai times keys =', Object.keys(json.times.openai));
const sample = json.times.openai['Alpha v1'];
console.log('Alpha v1 sample =', sample);
const ok =
    status === 200 &&
    json.times.openai &&
    json.times.openai['Alpha v1'] &&
    json.times.openai['Beta v2'] &&
    json.times.openai['Gamma'] &&
    typeof sample.birthtimeMs === 'number' &&
    typeof sample.ctimeMs === 'number' &&
    typeof sample.mtimeMs === 'number';

// 验证 instruct 类型也能扫到
const r2 = await call({ apiId: 'instruct' });
console.log('instruct keys =', Object.keys(r2.json.times.instruct));

// 验证未知类型返回空对象而非报错
const r3 = await call({ apiId: 'does-not-exist' });
console.log('unknown type result =', r3.json.times['does-not-exist']);

// 验证 birthtime 确实随创建顺序递增
const t1 = json.times.openai['Alpha v1'].birthtimeMs;
const t2 = json.times.openai['Gamma'].birthtimeMs;
console.log('Alpha birth < Gamma birth ?', t1 < t2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? 'BACKEND_TEST_PASS' : 'BACKEND_TEST_FAIL');
process.exit(ok ? 0 : 1);

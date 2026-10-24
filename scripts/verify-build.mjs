/**
 * 构建产物自检。
 *
 * 存在的理由：曾经出现过一次「测试全绿、类型检查干净、构建成功，但扩展根本装不上」
 * 的故障 —— 产物里含有裸露的控制字节，Chrome 以「不是 UTF-8 编码」为由拒绝加载内容脚本。
 * 这类问题只能在加载阶段暴露，所以必须在构建后立刻用脚本拦住。
 *
 * 用法：node scripts/verify-build.mjs [产物目录]
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const targetDir = resolve(process.argv[2] ?? '.output/chrome-mv3');

/** 允许出现的 C0 控制字符：JS 里合法且必要的空白。 */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

if (!existsSync(targetDir)) {
  fail(`产物目录不存在: ${targetDir}（请先执行构建）`);
} else {
  // 1) manifest 必须是合法 JSON，且关键字段齐全
  const manifestPath = join(targetDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    fail('缺少 manifest.json');
  } else {
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      notes.push(`manifest: ${manifest.name} v${manifest.version} MV${manifest.manifest_version}`);
    } catch (error) {
      fail(`manifest.json 不是合法 JSON: ${error.message}`);
    }
    if (manifest) {
      if (!manifest.manifest_version) fail('manifest 缺少 manifest_version');
      if (!manifest.content_scripts?.length) fail('manifest 没有声明任何 content_scripts');
      for (const cs of manifest.content_scripts ?? []) {
        if (!cs.js?.length) fail('content_scripts 条目没有 js 文件');
        for (const file of cs.js ?? []) {
          const p = join(targetDir, file);
          if (!existsSync(p)) fail(`manifest 声明的脚本不存在: ${file}`);
        }
      }
    }
  }

  // 2) 逐个检查脚本文件：严格 UTF-8 + 无裸露控制字符
  const scripts = [join(targetDir, 'content-scripts', 'content.js'), join(targetDir, 'manifest.json')].filter(
    (p) => existsSync(p),
  );

  for (const file of scripts) {
    const raw = readFileSync(file);
    const rel = file.slice(targetDir.length + 1);

    // 严格 UTF-8（等价于 Chrome 的校验意图）
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch (error) {
      fail(`${rel}: 不是合法 UTF-8 -> ${error.message}`);
      continue;
    }

    // 高风险字符 —— 这正是导致「不是 UTF-8 编码」报错的真凶。
    // 注意：Chromium 的严格 IsStringUTF8 不仅拒绝非法字节，也拒绝**非字符**（U+FFFE 等），
    // 所以这里同时检查 C0 控制符与非字符，二者都会让扩展装不上。
    const text = new TextDecoder('utf-8').decode(raw);
    const offenders = [];
    let idx = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const low = cp & 0xffff;
      const risky =
        (cp < 0x20 && !ALLOWED.has(cp)) ||
        cp === 0x7f ||
        (cp >= 0xfdd0 && cp <= 0xfdef) ||
        low === 0xfffe ||
        low === 0xffff;
      if (risky) offenders.push([idx, cp]);
      idx += ch.length;
    }
    if (offenders.length > 0) {
      const sample = offenders
        .slice(0, 3)
        .map(([i, cp]) => `offset ${i} = U+${cp.toString(16).padStart(4, '0')}`)
        .join('; ');
      fail(
        `${rel}: 含 ${offenders.length} 个高风险字符（Chrome 会拒绝加载内容脚本，报称「不是 UTF-8 编码」）: ${sample}\n` +
          '        修复：确认 wxt.config.ts 里的 bz-escape-risky-chars 插件生效。',
      );
    }

    notes.push(`${rel}: 合法 UTF-8，${statSync(file).size} bytes，无高风险字符`);
  }
}

if (problems.length > 0) {
  console.error('\n✖ 产物自检未通过：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\n✓ 产物自检通过');
for (const n of notes) console.log(`  - ${n}`);

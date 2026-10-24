/**
 * 自检：**模板字符串内部**的注释不允许出现反引号。
 *
 * 背景（已犯过三次）：print-css.ts / pdf.ts 用模板字符串拼 CSS，
 * 在其中的注释里写带反引号的说明（例如 `border-top: 1px dashed`）时，
 * 反引号会**提前终止模板字符串**，让 esbuild 报出与真实原因毫不相干的语法错误
 * （"Expected ; but found ..."），排查成本很高。
 *
 * 判定方式：追踪每行的模板字符串开关状态，只在「处于模板字符串内」的注释里查反引号。
 * 其它位置的反引号（普通注释、真实代码）是安全的，不予拦截。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];

/** 统计一行里未被转义的反引号数量，并判断 ${...} 之外是否切换了模板状态。 */
function countBackticks(line) {
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') { i += 1; continue; }
    if (line[i] === '`') n += 1;
  }
  return n;
}

function check(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inTemplate = false;

  for (const [index, raw] of lines.entries()) {
    const line = raw;
    const wasInTemplate = inTemplate;

    // 先判断本行结束时是否仍在模板字符串内
    const ticks = countBackticks(line);
    if (ticks % 2 === 1) inTemplate = !inTemplate;

    // 只检查「整行都处于模板内」的注释行（状态在行首与行尾都应为真）
    const trimmed = line.trim();
    const isComment =
      trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
    if (!isComment) continue;

    const inTemplateForLine = wasInTemplate && inTemplate && ticks % 2 === 0;
    if (!inTemplateForLine) continue;
    if (countBackticks(line) === 0 && !line.includes('`')) continue;

    problems.push(`${file}:${index + 1}  ${trimmed.slice(0, 90)}`);
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) check(full);
  }
}

walk('src');

if (problems.length > 0) {
  console.error('✗ 模板字符串内的注释出现反引号（会提前终止模板，导致难懂的语法错误）：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('✓ 模板字符串内的注释无反引号');

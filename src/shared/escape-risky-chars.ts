/**
 * 产物字符转义。
 *
 * 为什么存在（实测，真实故障）：
 * 打包器会把源码里的 `\uXXXX` 转义**还原成真实字符**写进产物，其中两类字符
 * 会被 Chrome 的严格 UTF-8 校验（`base::IsStringUTF8`）拒绝：
 *
 *   1) C0 控制字符 —— 来自 `docx` 依赖里 JSZip 的 ZIP 魔数常量 `"PK\x03\x04"`。
 *   2) **非字符**（U+FFFE/U+FFFF 等）—— 来自 `docx/html` 里的
 *      `/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g`。
 *
 * 后果是 Chrome 拒绝加载内容脚本，报错却极易误导：
 *   「无法为内容脚本加载 content.js。该文件采用的不是 UTF-8 编码。」
 * 而产物字节其实是合法 UTF-8 —— 于是扩展**完全装不上**，
 * 且 `tsc` / `vitest` / `wxt build` 三者全都发现不了。
 *
 * 把这两类字符转义回 `\uXXXX` 在语义上等价（字符串、模板串、正则字面量里都成立），
 * 产物变成纯文本后 Chrome 即可正常加载。
 */

/** 是否为需要转义的字符。 */
export function isRiskyChar(codePoint: number): boolean {
  // JS 里合法且必要的空白，保持原样
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return false;
  if (codePoint < 0x20) return true;
  if (codePoint === 0x7f) return true;
  // 非字符区段
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return true;
  // 各平面末尾的非字符
  const low = codePoint & 0xffff;
  return low === 0xfffe || low === 0xffff;
}

/** 生成等价的 `\uXXXX` 转义文本；超出 BMP 的码点用代理对。 */
export function escapeOf(codePoint: number): string {
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }
  const v = codePoint - 0x10000;
  const hi = 0xd800 + (v >> 10);
  const lo = 0xdc00 + (v & 0x3ff);
  return `\\u${hi.toString(16)}\\u${lo.toString(16)}`;
}

export interface EscapeResult {
  readonly code: string;
  readonly changed: number;
}

/** 把代码文本里的高风险字符转义掉。按码点遍历，避免拆坏代理对。 */
export function escapeRiskyCharsInCode(code: string): EscapeResult {
  let out = '';
  let changed = 0;
  for (const ch of code) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isRiskyChar(cp)) {
      out += escapeOf(cp);
      changed += 1;
    } else {
      out += ch;
    }
  }
  return { code: changed > 0 ? out : code, changed };
}

/**
 * 文本处理小工具（共享层，适配器与导出层都可使用）。
 */

/**
 * 把包含换行/连续空格的文本压成单行。
 *
 * 站点元信息里夹杂大量格式化空白，实测形如：
 *   "整体难度：\n                                    \n                                    适中"
 * 不规范化会让导出的标题行被拆成好几段。
 */
export function normalizeInlineText(text: string): string {
  return text.replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}

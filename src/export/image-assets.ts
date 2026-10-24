/**
 * 内容图片资源收集（题目插图、公式位图等）。
 *
 * 两个实测要点，都会直接影响导出质量：
 *
 * 1) **题目插图不在公式 CDN 上。** 实测一份 19 题的数学卷里有 133 张 `<img>`：
 *    132 张来自 `staticzujuan.xkw.com`（公式），1 张来自 `img.xkw.com`（题目插图）。
 *    只处理公式 CDN 会让题目插图在 DOCX 里消失。
 *
 * 2) **站点图片 URL 常带缩略参数。** 实测同一张图：
 *      `...5bf40bce....png?resizew=167`      → 167×65，2,198 字节
 *      `...5bf40bce....png`（去掉参数）      → 925×358，28,415 字节
 *    即去掉 `resizew` 能拿到 5.5 倍分辨率的原图，对打印与文档质量影响很大。
 *
 * 取图统一用「先试原图，失败再退回原 URL」，保证即使站点改了参数规则也不会丢图。
 */

import { FULLSIZE_STRIPPABLE_PARAMS } from '../shared/constants';
import { blobToDataUrl } from './data-url';

/** 去掉缩略参数，尝试拿到原图。无法解析时原样返回。 */
export function fullSizeImageUrl(src: string): string {
  try {
    const url = new URL(src, 'https://zujuan.xkw.com');
    let changed = false;
    for (const param of FULLSIZE_STRIPPABLE_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        changed = true;
      }
    }
    if (!changed) return src;
    // 参数被清空后不要留下多余的 '?'
    return url.search === '' ? url.href.replace(/\?$/, '') : url.href;
  } catch {
    return src;
  }
}

export interface CollectImageDataUrlsOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly concurrency?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 返回 true 表示该 src 已由其它途径覆盖（例如公式已转成 MathML），无需再取图。 */
  readonly skip?: ((src: string) => boolean) | undefined;
}

/**
 * 把一组图片 URL 取回并转成 data URL。
 * 返回的 Map 以**原始 src** 为键（不是原图 URL），因为文档转换是按 DOM 里的 src 查表的。
 * 单个图片失败不影响其它图片，也不抛异常 —— 失败项由调用方以警告形式如实上报。
 */
export async function collectImageDataUrls(
  srcs: readonly (string | null | undefined)[],
  options: CollectImageDataUrlsOptions = {},
): Promise<Map<string, string>> {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const src of srcs) {
    if (!src || seen.has(src)) continue;
    if (options.skip?.(src)) continue;
    seen.add(src);
    targets.push(src);
  }

  const result = new Map<string, string>();
  if (targets.length === 0) return result;

  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.max(1, options.concurrency ?? 6);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const src = targets[cursor];
      cursor += 1;
      if (!src) return;

      const candidates = [fullSizeImageUrl(src), src].filter((u, i, arr) => u && arr.indexOf(u) === i);
      for (const candidate of candidates) {
        try {
          const response = await fetchImpl(candidate, {
            credentials: 'omit',
            cache: 'force-cache',
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (blob.size === 0) continue;
          result.set(src, await blobToDataUrl(blob));
          break;
        } catch {
          // 继续尝试下一个候选地址；全部失败则该图缺失，由调用方告警
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return result;
}

/**
 * 公式 MathML 获取。
 *
 * 实测（不要凭直觉改）：
 *   页面上每个公式都只是一个 `<img>`：
 *     https://staticzujuan.xkw.com/quesimg/Upload/formula/{hash}.png
 *   但同一个 hash 在 CDN 上还有一份 **base64 编码的 MathML**：
 *     https://staticzujuan.xkw.com/quesimg/Upload/formula/{hash}.mml   → HTTP 200
 *   例如 0371ee50... 的 .mml 解出：
 *     <math><mrow><mi>M</mi><mo>=</mo><mfenced open="{" close="}">...</mfenced></mrow></math>
 *
 * 这带来一个关键质量差异：DOCX 里可以把公式转成**可编辑的 OMML 公式对象**，
 * 而不是塞一张位图 —— 这正是既有导出脚本做不到的地方。
 *
 * 两条实测约束：
 *   1) `.mml` 内容是 base64，解码后是 UTF-8 的 MathML；必须用
 *      `TextDecoder('utf-8')` 解码字节，不能直接 `atob` 当 Latin-1 用，
 *      否则公式里的中文/生僻符号会变乱码。
 *   2) 同一份试卷上公式会**大量重复**（实测同一 hash 出现多次），
 *      因此必须按 hash 去重缓存，否则会重复发上百个请求。
 */

import { FORMULA_PATH_PATTERN, FORMULA_ORIGIN, FORMULA_MML_PATH_TEMPLATE } from '../shared/constants';

/**
 * 从公式图片 URL 中取出 hash；非公式图片返回 null。
 *
 * 除了路径形状，还**必须校验域名**：否则其它站点上恰好同形的图片路径
 * 也会被当成公式，导致无意义地去找 `.mml`（并可能替换成错误内容）。
 */
export function formulaHashFromSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  if (!trimmed) return null;

  // 相对/协议相对地址也要支持：夹具与页面里都出现过 `//host/path` 形式
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate, 'https://staticzujuan.xkw.com');
  } catch {
    return null;
  }
  if (parsed.hostname !== 'staticzujuan.xkw.com') return null;

  const match = parsed.pathname.match(FORMULA_PATH_PATTERN);
  return match?.[1] ?? null;
}

/** 由 hash 拼出 .mml 资源地址。 */
export function mmlUrlForHash(hash: string): string {
  return `${FORMULA_ORIGIN}${FORMULA_MML_PATH_TEMPLATE.replace('{hash}', hash)}`;
}

/**
 * 解码 `.mml` 的 base64 内容为 MathML 字符串。
 * 失败返回 null（调用方应退回使用 png）。
 */
export function decodeMmlBase64(base64Text: string): string | null {
  const cleaned = base64Text.trim().replace(/\s+/g, '');
  if (!cleaned) return null;
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // 关键：按 UTF-8 解码，而不是把 code point 当字符直接拼
    const decoded = new TextDecoder('utf-8').decode(bytes);
    return decoded.includes('<math') ? decoded : null;
  } catch {
    return null;
  }
}

export interface CollectFormulaMathMlOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  /** 并发上限，避免一次打满 CDN 连接数 */
  readonly concurrency?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * 为给定的一组公式图片 URL 收集 MathML（按 hash 返回）。
 * 单个公式失败不影响其它公式；失败项直接不出现在结果里。
 */
export async function collectFormulaMathMl(
  srcs: readonly (string | null | undefined)[],
  options: CollectFormulaMathMlOptions = {},
): Promise<Map<string, string>> {
  const hashes = new Set<string>();
  for (const src of srcs) {
    const hash = formulaHashFromSrc(src);
    if (hash) hashes.add(hash);
  }
  const result = new Map<string, string>();
  if (hashes.size === 0) return result;

  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const queue = [...hashes];

  const worker = async (): Promise<void> => {
    for (;;) {
      const hash = queue.shift();
      if (!hash) return;
      try {
        const response = await fetchImpl(mmlUrlForHash(hash), {
          credentials: 'omit',
          cache: 'force-cache',
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) continue;
        const mathml = decodeMmlBase64(await response.text());
        if (mathml) result.set(hash, mathml);
      } catch {
        // 静默跳过：该公式退回使用 png 位图
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}

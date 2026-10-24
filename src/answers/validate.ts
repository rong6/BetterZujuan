/**
 * 答案图片有效性判定。
 *
 * 为什么需要这个模块（实测结论）：
 * 当答案图 URL 过期或无权限时，服务端**仍然返回 HTTP 200**，但内容是一张
 * 414×30 / 417×29 的 PNG 提示图，文字为「(403) 您没有权限查看组卷网答案解析，请直接访问站点查看！」。
 *
 * 这会导致：
 *   - `<img>.complete === true`
 *   - `onload` 正常触发
 *   - `naturalWidth === 414`（非 0）
 * 因此「只检查 complete」或「只检查 naturalWidth > 0」都会误判为成功，
 * 把 403 提示图当成答案导出 —— 这正是「静默丢失/静默出错」的经典来源。
 *
 * 判据来自实测指纹：
 *   - 真图：`width=884` → 1768×220；`width=1240` → 2400×220，`image/jpeg`，约 22–24KB
 *   - 提示图：约 414×30，且**不随 width 参数缩放**（884/1240/2480 都是 ~414×30），`image/png`，约 5.3–5.6KB
 */

import {
  FORBIDDEN_NOTICE_MAX_HEIGHT,
  FORBIDDEN_NOTICE_MAX_WIDTH,
  MIN_VALID_ANSWER_IMAGE_HEIGHT,
  MIN_VALID_ANSWER_IMAGE_WIDTH,
} from '../shared/constants';

export interface AnswerImageMeta {
  /** 解码后的自然宽度 */
  readonly width: number;
  /** 解码后的自然高度 */
  readonly height: number;
  /** 响应的 content-type（可选，用于二次确认） */
  readonly mime?: string | undefined;
  /** 字节数（可选，用于二次确认） */
  readonly byteLength?: number | undefined;
}

export type AnswerImageVerdict =
  | { readonly kind: 'valid' }
  /** 命中 403 提示图指纹：明确是「无权限 / URL 已失效」，必须报错而非当作答案 */
  | { readonly kind: 'forbidden'; readonly reason: string }
  /** 尺寸不符合任何已知指纹：保守起见视为失败，避免把未知小图当作答案 */
  | { readonly kind: 'suspicious'; readonly reason: string };

/**
 * 判定一张答案图片是否可信。
 *
 * 注意判定顺序：先确认「够大」，再看是否命中提示图指纹，最后兜底为可疑。
 * 这样即使站点以后换了提示图尺寸，也不会误判为真图。
 */
export function classifyAnswerImage(meta: AnswerImageMeta): AnswerImageVerdict {
  const { width, height, mime, byteLength } = meta;

  if (width >= MIN_VALID_ANSWER_IMAGE_WIDTH && height >= MIN_VALID_ANSWER_IMAGE_HEIGHT) {
    return { kind: 'valid' };
  }

  // 尺寸为 0 表示图片根本没有解码成功（未加载 / 加载失败 / 已被移除），
  // 这与「服务端返回 403 提示图」是两回事，必须区分开，否则会把加载失败误报成权限问题。
  if (width <= 0 || height <= 0) {
    return {
      kind: 'suspicious',
      reason: '答案图片未加载完成或加载失败（解码尺寸为 0），无法确认内容。',
    };
  }

  // 命中实测的 403 提示图指纹（小且扁，且不随 width 缩放）
  const looksLikeNotice =
    width <= FORBIDDEN_NOTICE_MAX_WIDTH && height <= FORBIDDEN_NOTICE_MAX_HEIGHT;
  if (looksLikeNotice) {
    return {
      kind: 'forbidden',
      reason:
        `收到站点的无权限提示图（${describeMeta(width, height, mime, byteLength)}）。` +
        '通常表示答案图片 URL 已过期、未登录，或账号无查看答案解析的权限。',
    };
  }

  return {
    kind: 'suspicious',
    reason:
      `答案图片尺寸异常（${describeMeta(width, height, mime, byteLength)}），` +
      `未达到可信阈值 ${MIN_VALID_ANSWER_IMAGE_WIDTH}×${MIN_VALID_ANSWER_IMAGE_HEIGHT}，已按失败处理。`,
  };
}

function describeMeta(
  width: number,
  height: number,
  mime: string | undefined,
  byteLength: number | undefined,
): string {
  return [
    `${width}×${height}`,
    mime ? `type=${mime}` : null,
    typeof byteLength === 'number' ? `${byteLength}B` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** 便捷判定：是否为可直接使用的答案图片。 */
export function isUsableAnswerImage(meta: AnswerImageMeta): boolean {
  return classifyAnswerImage(meta).kind === 'valid';
}

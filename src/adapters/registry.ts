/**
 * 适配器注册表：把当前页面分派给合适的适配器。
 *
 * 未识别的页面一律不注入、不猜测、不做 DOM 操作 —— 宁可不出现在页面上，
 * 也不要在一个陌生结构上乱改用户的页面。
 */

import { paperDetailAdapter } from './paper-detail';
import { usertkPaperAdapter } from './usertk-paper';
import { zujuanCenterAdapter } from './zujuan-center';
import type { PageAdapter } from './types';

/**
 * 已注册的适配器，**按优先级排列**。
 *
 * 顺序敏感：个人题库页与试卷详情页的 URL 形状不同（`/usertk/…` vs `/…`），
 * 但两者的 DOM 都含 `article.exam-cnt`，因此个人题库适配器必须排在前面 ——
 * 它的 `matches` 额外要求「有多个 sec-item」，能干净地与详情页区分开。
 */
export const ADAPTERS: readonly PageAdapter[] = [
  usertkPaperAdapter,
  zujuanCenterAdapter,
  paperDetailAdapter,
];

export interface DetectResult {
  readonly adapter: PageAdapter | null;
  /** 未命中时给出可读原因，供 UI 提示 */
  readonly reason: string;
}

export function detectAdapter(url: string, doc: Document): DetectResult {
  for (const adapter of ADAPTERS) {
    try {
      if (adapter.matches(url, doc)) return { adapter, reason: '' };
    } catch {
      // 某个适配器判定失败不应影响其它适配器
      continue;
    }
  }
  return {
    adapter: null,
    reason:
      `当前页面暂不支持（${url}）。` +
      '已支持：试卷详情页（/{bankId}p{paperId}.html）、' +
      '个人题库试卷（/usertk/{bankId}p{paperId}.html）、组卷中心（/zujuan）。',
  };
}

/**
 * 答案与解析加载。
 *
 * 设计与实测依据：
 *
 * 1) **并发获取**。站点自带的「显示全部答案和解析」本身就是一次性全量请求，
 *    顺序单发只会让用户白等（实测 19 题顺序执行耗时约 28 秒）。这里用有限并发池
 *    （默认 8）把总耗时压到几秒，同时不至于把连接数打满。
 *
 * 2) **不设额度上限**。额度由站点判定，扩展不替用户做限制 ——
 *    一键展开就是展开全部，与站点自身行为一致。
 *
 * 3) **铸造签名后立即取图**。答案 URL 的签名只有约 24–60 秒有效期，
 *    因此每道题的「取签名 → 取图」必须在同一个任务内紧挨着完成，
 *    不能先批量取签名再统一取图。
 *
 * 4) **必须校验图片**。URL 失效时服务端返回 HTTP 200 + 414×30 的提示小图，
 *    只看 onload 会把它当成答案。校验通过后立刻固化为 blob，
 *    避免签名过期导致导出时变成报错图。
 */

import type { PaperModel, QuestionRef } from '@/adapters/types';
import {
  buildAnswerImageUrl,
  checkQuesParse,
  extractUserToken,
  fetchAnswerImage,
  readRequestVerificationToken,
} from './api';
import { classifyAnswerImage, type AnswerImageVerdict } from './validate';

export type AnswerLoadStatus = 'loaded' | 'cached' | 'forbidden' | 'suspicious' | 'error';

export interface AnswerLoadRecord {
  readonly question: QuestionRef;
  readonly status: AnswerLoadStatus;
  readonly message?: string;
  readonly blobUrl?: string;
}

export interface AnswerLoadProgress {
  readonly completed: number;
  readonly total: number;
  readonly current: QuestionRef | null;
}

export interface AnswerLoaderOptions {
  readonly doc: Document;
  readonly fetchImpl?: typeof fetch | undefined;
  /** 并发数；默认 8 */
  readonly concurrency?: number | undefined;
  readonly onProgress?: ((progress: AnswerLoadProgress) => void) | undefined;
  readonly decodeDimensions?: ((blob: Blob) => Promise<{ width: number; height: number }>) | undefined;
  readonly createObjectURL?: ((blob: Blob) => string) | undefined;
  readonly revokeObjectURL?: ((url: string) => void) | undefined;
}

/**
 * 默认并发数。
 *
 * 实地抓包：站点自带的「显示全部答案和解析」会在同一秒内把整卷请求全部发出去，
 * 因此并发本身就是站点的正常使用方式。这里取 12 作为折中 ——
 * 足够快，又不至于一次性占满连接数。
 */
export const DEFAULT_ANSWER_CONCURRENCY = 12;

/** 把图片 blob 解码成尺寸，用于识别 403 提示图。 */
export async function decodeImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前浏览器不支持 createImageBitmap，无法安全校验答案图片。');
  }
  const bitmap = await createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
}

function verdictMessage(verdict: AnswerImageVerdict): string | undefined {
  return verdict.kind === 'valid' ? undefined : verdict.reason;
}

/** 把校验通过的答案写回页面。只写入 blob URL，不复制带令牌的原始地址。 */
function revealAnswer(question: QuestionRef, blobUrl: string): void {
  const opt = question.node.querySelector<HTMLElement>('.exam-item__opt');
  const answer = question.node.querySelector<HTMLElement>('.exam-item__opt .item.answer, .item.answer');
  if (!answer) return;

  let img = answer.querySelector<HTMLImageElement>('img');
  if (!img) {
    img = question.node.ownerDocument.createElement('img');
    img.alt = '答案与解析';
    answer.appendChild(img);
  }
  img.src = blobUrl;

  answer.removeAttribute('hidden');
  answer.style.removeProperty('display');
  if (opt) {
    opt.removeAttribute('hidden');
    opt.style.removeProperty('display');
  }
}

/**
 * 获取当前试卷的答案与解析（并发执行）。
 * 只在当前试卷范围内工作，不跳卷、不做长时间重试。
 */
export class AnswerLoader {
  private readonly cache = new Map<string, AnswerLoadRecord>();
  private readonly sourceToBlobUrl = new Map<string, string>();
  private readonly ownedUrls = new Set<string>();
  private readonly options: AnswerLoaderOptions;

  constructor(options: AnswerLoaderOptions) {
    this.options = options;
  }

  /** 原始答案图地址 → 已验证的 blob 地址（导出时用，避免重新请求已失效的签名 URL）。 */
  getImageUrlForSource(src: string): string | undefined {
    if (this.ownedUrls.has(src)) return src;
    return this.sourceToBlobUrl.get(src);
  }

  async load(
    model: PaperModel,
    onProgress?: ((progress: AnswerLoadProgress) => void) | undefined,
  ): Promise<readonly AnswerLoadRecord[]> {
    const questions = model.sections.flatMap((section) => section.questions);
    const total = questions.length;
    const records = new Map<string, AnswerLoadRecord>();
    let completed = 0;

    const keyOf = (question: QuestionRef): string =>
      `${model.url}\u0000${question.bankId}\u0000${question.qid}`;

    const report = (current: QuestionRef | null): void => {
      const progress: AnswerLoadProgress = { completed, total, current };
      this.options.onProgress?.(progress);
      onProgress?.(progress);
    };

    report(null);

    // 两个令牌都按需解析一次：
    //  - user_token：答案图一旦换成 blob，页面上就再也回捞不到它了
    //  - 防伪令牌：取自页面隐藏域，缺了会被服务端以 401 拒绝（实测）
    let token: string | null | undefined;
    const resolveToken = (): string | null => {
      if (token === undefined) {
        token = extractUserToken({ cookieString: this.options.doc.cookie, doc: this.options.doc });
      }
      return token;
    };
    let verificationToken: string | null | undefined;
    const resolveVerificationToken = (): string | null => {
      if (verificationToken === undefined) {
        verificationToken = readRequestVerificationToken(this.options.doc);
      }
      return verificationToken;
    };

    let cursor = 0;
    const concurrency = Math.max(1, this.options.concurrency ?? DEFAULT_ANSWER_CONCURRENCY);

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const question = questions[index];
        if (!question) return;

        const cacheKey = keyOf(question);
        const cached = this.cache.get(cacheKey);
        if (cached) {
          records.set(cacheKey, {
            ...cached,
            status: cached.status === 'loaded' ? 'cached' : cached.status,
          });
        } else {
          records.set(cacheKey, await this.fetchOne(question, resolveToken, resolveVerificationToken, cacheKey));
        }
        completed += 1;
        report(question);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

    // 按试卷顺序返回，避免并发导致展示顺序错乱
    return questions
      .map((question) => records.get(keyOf(question)))
      .filter((record): record is AnswerLoadRecord => record !== undefined);
  }

  private async fetchOne(
    question: QuestionRef,
    resolveToken: () => string | null,
    resolveVerificationToken: () => string | null,
    cacheKey: string,
  ): Promise<AnswerLoadRecord> {
    const token = resolveToken();
    if (!token) {
      return this.remember(cacheKey, {
        question,
        status: 'error',
        message: '未找到登录令牌；请确认已登录组卷网。',
      });
    }

    const originalImageSrc =
      question.node.querySelector<HTMLImageElement>('.item.answer img')?.getAttribute('src') ?? undefined;

    try {
      // 关键：取签名与取图必须紧挨着，签名只有几十秒有效期
      const signature = await checkQuesParse(question, {
        fetchImpl: this.options.fetchImpl,
        verificationToken: resolveVerificationToken(),
      });
      const url = buildAnswerImageUrl({ ...question, key: signature.key, token });
      const response = await fetchAnswerImage(url, { fetchImpl: this.options.fetchImpl });

      const blob = new Blob([response.bytes], { type: response.mime || 'application/octet-stream' });
      const decode = this.options.decodeDimensions ?? decodeImageDimensions;
      const dimensions = await decode(blob);
      const verdict = classifyAnswerImage({
        ...dimensions,
        mime: response.mime,
        byteLength: response.byteLength,
      });

      if (verdict.kind !== 'valid') {
        return this.remember(cacheKey, {
          question,
          status: verdict.kind,
          message: verdictMessage(verdict),
        });
      }

      const createUrl = this.options.createObjectURL ?? ((value: Blob) => URL.createObjectURL(value));
      const blobUrl = createUrl(blob);
      this.ownedUrls.add(blobUrl);
      revealAnswer(question, blobUrl);
      if (originalImageSrc) this.sourceToBlobUrl.set(originalImageSrc, blobUrl);

      return this.remember(cacheKey, { question, status: 'loaded', blobUrl });
    } catch (error) {
      return this.remember(cacheKey, {
        question,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private remember(cacheKey: string, record: AnswerLoadRecord): AnswerLoadRecord {
    this.cache.set(cacheKey, record);
    return record;
  }

  dispose(): void {
    const revoke = this.options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
    for (const url of this.ownedUrls) revoke(url);
    this.ownedUrls.clear();
    this.sourceToBlobUrl.clear();
    this.cache.clear();
  }
}

/** 面向用户的结果摘要。 */
export function summarizeAnswerLoads(records: readonly AnswerLoadRecord[]): string {
  const loaded = records.filter((r) => r.status === 'loaded' || r.status === 'cached').length;
  if (records.length > 0 && loaded === records.length) {
    return `已展开全部 ${records.length} 道题的答案与解析。`;
  }

  const forbidden = records.filter((r) => r.status === 'forbidden').length;
  const suspicious = records.filter((r) => r.status === 'suspicious').length;
  const errored = records.filter((r) => r.status === 'error').length;

  const parts = [`已展开 ${loaded}/${records.length} 道题`];
  if (forbidden > 0) parts.push(`${forbidden} 道无权限或链接已失效`);
  if (suspicious > 0) parts.push(`${suspicious} 道图片校验未通过`);
  if (errored > 0) parts.push(`${errored} 道请求失败`);
  return `${parts.join('，')}。`;
}

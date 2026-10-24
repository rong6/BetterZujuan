/**
 * PDF 导出（打印 CSS + window.print）。
 *
 * 两条路径，按风险从低到高选择：
 *
 *  A) `as-is`（默认）：**完全不改 DOM**。只注入一份「仅 @media print 生效」的样式，
 *     隐藏框架/侧栏/试卷分析等噪声，然后直接 print。原页面状态 100% 保留。
 *
 *  B) 需要重排的模式（仅试题 / 答案移至末尾 / 仅答案）：
 *     构造一个离屏 clone 挂在 body 上（屏幕态 display:none），
 *     打印时隐藏原正文、显示 clone，打印结束即销毁。
 *
 * 关键安全点：clone 里的答案图片 `src` 必须替换成我们已抓取的 blob URL。
 * 原因是答案图 URL 只有约 30–60 秒有效期，clone 一旦触发重新请求，
 * 服务端会返回 HTTP 200 的「(403) 您没有权限…」小图，**直接把报错印进试卷**。
 */

import type { PaperModel, QuestionRef } from '@/adapters/types';
import { cloneAnswer, cloneStem } from '@/core/purify';
import {
  buildPrintCss,
  CLONE_MODE_CLASS,
  PRINT_ROOT_ID,
  PRINTING_CLASS,
} from './print-css';
import { requiresClone, type PrintJobOptions } from './options';

/** 注入的打印样式元素 id（导出以便测试与诊断定位）。 */
export const PRINT_STYLE_ID = 'bz-print-style';

export interface PrintDeps {
  readonly doc: Document;
  readonly model: PaperModel;
  readonly options: PrintJobOptions;
  readonly noiseSelectors: readonly string[];
  /**
   * 把答案图的原始 src 换成已抓取的 blob URL。
   * 返回 undefined 时保留原 src（此时该图可能已失效，调用方应已给出告警）。
   */
  readonly resolveImageSrc?: ((originalSrc: string) => string | undefined) | undefined;
  /** 触发打印，默认 window.print（测试可注入） */
  readonly print?: (() => void) | undefined;
  /** 运行环境，决定 print() 是否阻塞；默认取 WXT 注入的 import.meta.env.BROWSER */
  readonly browserKind?: 'chrome' | 'firefox' | undefined;
  /** Firefox 下 afterprint 不触发时的兜底清理延时（ms） */
  readonly fallbackCleanupMs?: number | undefined;
}

export interface PrintSession {
  /** 幂等清理：移除样式与 clone、恢复 class */
  dispose(): void;
  /** 是否已经清理 */
  readonly disposed: boolean;
  /** 实际使用的路径，便于 UI 说明与测试断言 */
  readonly path: 'original-dom' | 'clone';
}

/**
 * 把 clone 内的图片 src 换成已抓取资源，避免失效 URL 被重新请求。
 * 没有已验证 blob 的答案图会被移除并明确标注，绝不把 403 小提示图打印出去。
 */
function rewriteCloneImageSources(
  root: Element,
  resolveImageSrc: ((src: string) => string | undefined) | undefined,
): void {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const replacement = resolveImageSrc?.(src);
    if (replacement) {
      img.setAttribute('src', replacement);
      continue;
    }

    // Non-answer images (formula/diagram assets) keep their original URL.
    const answerWrap = img.closest('.bz-print-answer');
    if (!answerWrap) continue;
    img.remove();
    if (!answerWrap.querySelector('.bz-print-unavailable')) {
      const note = root.ownerDocument.createElement('div');
      note.className = 'bz-print-unavailable';
      note.textContent = '答案未加载或未通过校验；请先点击「加载全部答案和解析」后再导出。';
      answerWrap.appendChild(note);
    }
  }
}

/** 构造打印用 clone 的内容树。 */
export function buildPrintRoot(
  doc: Document,
  model: PaperModel,
  options: PrintJobOptions,
  noiseSelectors: readonly string[],
  resolveImageSrc?: ((src: string) => string | undefined) | undefined,
): HTMLElement {
  const root = doc.createElement('div');
  root.id = PRINT_ROOT_ID;

  const title = doc.createElement('div');
  title.className = 'bz-print-title';
  title.textContent = model.title;
  root.appendChild(title);

  if (model.meta.length > 0) {
    const meta = doc.createElement('div');
    meta.className = 'bz-print-meta';
    meta.textContent = model.meta.join(' · ');
    root.appendChild(meta);
  }

  const wantQuestions = options.mode !== 'answers-only';
  const wantAnswersInline = options.mode === 'as-is';
  const wantAnswersAtEnd = options.mode === 'answers-at-end';
  const wantAnswersOnly = options.mode === 'answers-only';

  const answersForEnd: { question: QuestionRef; node: Element }[] = [];

  for (const section of model.sections) {
    if (wantQuestions && section.title) {
      const heading = doc.createElement('div');
      heading.className = 'bz-print-section-title';
      heading.textContent = section.title;
      root.appendChild(heading);
    }

    for (const question of section.questions) {
      if (wantQuestions) {
        const stem = cloneStem(question, noiseSelectors);
        if (stem) {
          const wrap = doc.createElement('div');
          wrap.className = 'bz-print-question';
          wrap.appendChild(stem);
          root.appendChild(wrap);

          if (wantAnswersInline) {
            const answer = cloneAnswer(question, noiseSelectors);
            if (answer) wrap.appendChild(labelAnswer(doc, answer));
          }
        }
      }

      if (wantAnswersAtEnd || wantAnswersOnly) {
        const answer = cloneAnswer(question, noiseSelectors);
        if (answer) answersForEnd.push({ question, node: answer });
      }
    }
  }

  if (answersForEnd.length > 0) {
    // 题目与答案都有时（答案置末），答案部分**另起一页**，避免混在题目尾部
    const group = doc.createElement('div');
    group.className = wantAnswersAtEnd ? 'bz-print-answers bz-page-break-before' : 'bz-print-answers';

    if (wantAnswersAtEnd) {
      const heading = doc.createElement('div');
      heading.className = 'bz-print-section-title';
      heading.textContent = '答案与解析';
      group.appendChild(heading);
    }
    for (const { question, node } of answersForEnd) {
      const wrap = doc.createElement('div');
      wrap.className = 'bz-print-question';
      wrap.appendChild(labelAnswer(doc, node, question.index));
      group.appendChild(wrap);
    }
    root.appendChild(group);
  }

  rewriteCloneImageSources(root, resolveImageSrc);
  return root;
}

/** 给答案块加一个可辨识的标签（答案图本身不含题号，文末答案需要它来对应）。 */
function labelAnswer(doc: Document, answer: Element, questionIndex?: number): Element {
  const wrap = doc.createElement('div');
  wrap.className = 'bz-print-answer';
  if (typeof questionIndex === 'number') {
    const label = doc.createElement('span');
    label.className = 'bz-print-answer-label';
    label.textContent = `${questionIndex}. `;
    wrap.appendChild(label);
  }
  wrap.appendChild(answer);
  return wrap;
}

/**
 * 启动一次打印会话。
 *
 * 调用方在 print 结束后无需手动清理：Chromium 下 `print()` 会阻塞到对话框关闭，
 * 因此返回后立即清理；Firefox 下 `print()` 可能立即返回，改为等 `afterprint`。
 */
export function startPrintSession(deps: PrintDeps): PrintSession {
  const { doc, model, options, noiseSelectors } = deps;
  const useClone = requiresClone(options.mode);
  // 正文根容器由适配器给出（详情页 article.exam-cnt / 组卷中心 article.paper-cnt）
  const rootSelector = model.rootSelector || 'article.exam-cnt';
  const browserKind =
    deps.browserKind ?? ((import.meta.env.BROWSER as 'chrome' | 'firefox') ?? 'chrome');
  // 注意：不能写成 `doc.defaultView?.print() ?? window.print()`，
  // 因为调用 undefined 会直接抛错而不是返回 nullish，回退分支永远不会生效。
  const printFn =
    deps.print ??
    (() => {
      const view = doc.defaultView;
      if (view && typeof view.print === 'function') {
        view.print();
        return;
      }
      if (typeof window !== 'undefined' && typeof window.print === 'function') {
        window.print();
        return;
      }
      throw new Error('当前环境不支持 window.print()，无法发起打印。');
    });

  const style = doc.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = buildPrintCss(options, noiseSelectors, useClone, rootSelector);
  doc.head.appendChild(style);

  const html = doc.documentElement;
  html.classList.add(PRINTING_CLASS);

  let cloneRoot: HTMLElement | null = null;
  if (useClone) {
    cloneRoot = buildPrintRoot(doc, model, options, noiseSelectors, deps.resolveImageSrc);
    doc.body.appendChild(cloneRoot);
    html.classList.add(CLONE_MODE_CLASS);
  }

  let disposed = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    doc.defaultView?.removeEventListener('afterprint', dispose);
    style.remove();
    cloneRoot?.remove();
    html.classList.remove(PRINTING_CLASS, CLONE_MODE_CLASS);
  };

  // Firefox 下 print() 可能不阻塞，因此以 afterprint 为主信号
  doc.defaultView?.addEventListener('afterprint', dispose, { once: true });

  printFn();

  if (browserKind === 'firefox') {
    // 兜底：万一 afterprint 没触发，也不能让 clone 永久留在页面里
    fallbackTimer = setTimeout(dispose, deps.fallbackCleanupMs ?? 5 * 60 * 1000);
  } else {
    // Chromium：print() 返回即表示对话框已关闭，可立即恢复页面
    dispose();
  }

  return {
    dispose,
    get disposed() {
      return disposed;
    },
    path: useClone ? 'clone' : 'original-dom',
  };
}

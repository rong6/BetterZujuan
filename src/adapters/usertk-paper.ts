/**
 * 个人题库试卷页适配器。
 *
 * 目标页面：`https://zujuan.xkw.com/usertk/{bankId}p{paperId}.html`
 *
 * 实测结构（与试卷详情页**不同**，这是必须单独写适配器的原因）：
 *
 *   article.exam-cnt
 *     h2.exam-title
 *       .title-txt                        → **没有** `span.txt`，取 .title-txt 本身
 *     section.exam-list
 *       div.sec-item            × 3        ← 每个题型**各自一个** sec-item！
 *         h4.sec-title  「一、单选题」      ← 内含「添加题型下试题」按钮
 *         div.sec-list  × N                ← 每个 sec-list 1 道题
 *       div.sec-item            （多选题）
 *       div.sec-item            （解答题）
 *
 * 与试卷详情页最关键的差异：
 *
 * | | 试卷详情页 | 个人题库页 |
 * |---|---|---|
 * | `section.exam-list > .sec-item` | **1 个**（整卷容器） | **N 个**（每题型 1 个） |
 * | 题型标题所在层级 | sec-item 的**子元素** | sec-item 自己**就带**标题 |
 *
 * 因此试卷详情页那套「在单一容器内按标题有序切分」的算法在这里会**只拿到第一个题型**
 * （实测 15 道题只采到 8 道）。本适配器改为直接遍历每个 `.sec-item`。
 *
 * 另外实测：本页所有题目容器都带 `.selected-mask`（加入试题篮后站点加的），
 * 透明度被压到 0.5。见 `core/gray-mask.ts`。
 *
 * 采集过程**只读**，不修改任何 DOM。
 */

import { normalizeInlineText } from '../shared/text';
import { GRAY_MASK_SELECTOR } from '../core/gray-mask';
import { resolveAll, resolveOne, type SelectionReport } from './selectors';
import type { CollectResult, PageAdapter, PaperModel, PaperSection, QuestionRef } from './types';

/**
 * 打印/导出时需要剔除的噪声。仅作用于打印样式与离屏 clone，不动原页面。
 *
 * 注意这里**不含** `.item.knowlegde` —— 知识点要与答案一起保留。
 */
export const USERTK_NOISE_SELECTORS: readonly string[] = [
  // 站点框架
  'header.page-header',
  'header',
  'nav',
  '.main-nav',
  '.bread-nav',
  '.fixed-nav',
  '.footer',
  // 侧栏与悬浮物
  'aside.other-info',
  '.other-info',
  '.aside-pop.activity-btn',
  '.ai-entry.fixed',
  '.quest-basket',
  '.quest-basket-nav',
  // 试卷分析
  'section.exam-analyze',
  '#paperAnalyze',
  // 题目上的操作与元信息（个人题库页的操作条更丰富）
  '.add-sec-ques',
  '.ques-additional',
  '.exam-item__custom',
  '.exam-item__info',
  '.ctrl-box',
  '.ques-ctrl',
  '.video-help',
  // 个人题库独有的编辑态标记
  '.edit-status',
];

/** 从题节点读取身份信息。 */
function readQuestionRef(node: HTMLElement, documentOrderIndex: number): QuestionRef | null {
  const wrapper = node.querySelector('.wrapper.quesdiv');
  const qid = node.getAttribute('questionid') ?? wrapper?.id.replace(/^quesdiv/, '') ?? '';
  if (!qid) return null;
  return {
    qid,
    bankId: node.getAttribute('bankid') || '11',
    index: documentOrderIndex,
    node,
  };
}

/** 从题型标题节点取纯文本（标题里嵌着「添加题型下试题」按钮）。 */
function sectionTitleOf(secItem: Element): string {
  const heading = secItem.querySelector('h4.sec-title, .sec-title');
  if (!heading) return '';
  // 标题里嵌着「添加题型下试题」，必须先取 span 再回退整块
  const span = heading.querySelector('span');
  return normalizeInlineText(span?.textContent ?? heading.textContent ?? '');
}

/** 采集个人题库试卷页。题目永不丢失：所有兜底分支都会把题目补齐。 */
export function collectUsertkPaper(doc: Document): CollectResult {
  const reports: SelectionReport[] = [];

  const articleResolved = resolveOne<HTMLElement>(doc, 'article');
  reports.push(articleResolved.report);
  const article = articleResolved.value;
  if (!article) {
    return {
      ok: false,
      reason: '未找到试卷正文容器（article.exam-cnt）。页面结构可能已改版。',
      reports,
    };
  }

  const titleResolved = resolveOne<HTMLElement>(article, 'titleText');
  reports.push(titleResolved.report);
  const title = normalizeInlineText(titleResolved.value?.textContent ?? '');

  const questionResolved = resolveAll<HTMLElement>(article, 'questionItem');
  reports.push(questionResolved.report);
  const allQuestionNodes = questionResolved.values;
  if (allQuestionNodes.length === 0) {
    return {
      ok: false,
      reason: '未找到任何题目容器（.tk-quest-item）。页面可能尚未渲染完成，或站点结构已改版。',
      reports,
    };
  }

  // 直接按 sec-item 逐个收集 —— 本页每个题型一个 sec-item，不能套用单容器算法
  const secItems = Array.from(article.querySelectorAll<HTMLElement>('.sec-item'));

  let runningIndex = 0;
  let droppedWithoutQid = 0;
  const collectFrom = (nodes: readonly HTMLElement[]): QuestionRef[] => {
    const refs: QuestionRef[] = [];
    for (const node of nodes) {
      runningIndex += 1;
      const ref = readQuestionRef(node, runningIndex);
      if (ref) refs.push(ref);
      else droppedWithoutQid += 1;
    }
    return refs;
  };

  const sections: PaperSection[] = [];
  const collected = new Set<HTMLElement>();

  for (const secItem of secItems) {
    const nodes = Array.from(secItem.querySelectorAll<HTMLElement>('.tk-quest-item'));
    if (nodes.length === 0) continue;
    for (const node of nodes) collected.add(node);
    const refs = collectFrom(nodes);
    if (refs.length > 0) sections.push({ title: sectionTitleOf(secItem), questions: refs });
  }

  // 兜底：未被任何 sec-item 覆盖的题目（结构变化）——全部补进来，绝不丢题
  const leftovers = allQuestionNodes.filter((node) => !collected.has(node));
  if (leftovers.length > 0) {
    const refs = collectFrom(leftovers);
    if (refs.length > 0) sections.push({ title: '', questions: refs });
  }

  const totalQuestions = sections.reduce((sum, s) => sum + s.questions.length, 0);
  if (totalQuestions === 0) {
    return {
      ok: false,
      reason:
        droppedWithoutQid > 0
          ? `页面上的 ${droppedWithoutQid} 个题目节点都缺少 questionid 属性，无法确定题目身份。`
          : '未能从页面采集到任何题目。',
      reports,
    };
  }

  const model: PaperModel = {
    url: doc.location?.href ?? '',
    title: title || doc.title || '未命名试卷',
    rootSelector: 'article.exam-cnt',
    sections,
    meta: [],
    selectionReports: reports,
  };
  return { ok: true, model };
}

/** 个人题库页 URL：`/usertk/{bankId}p{paperId}.html` */
export const USERTK_URL_PATTERN = /^https:\/\/zujuan\.xkw\.com\/usertk\/\d+p\d+\.html/i;

export const usertkPaperAdapter: PageAdapter = {
  id: 'usertk-paper',
  label: '个人题库试卷',
  matches(url: string, doc: Document): boolean {
    if (!USERTK_URL_PATTERN.test(url)) return false;
    // URL 与 DOM 双判定。这里额外要求「至少一个 sec-item 自带题型标题」，
    // 以区分本页与试卷详情页（后者标题在 sec-item 内部，且只有一个 sec-item）。
    if (!doc.querySelector('article.exam-cnt')) return false;
    return doc.querySelectorAll('section.exam-list > .sec-item').length > 1;
  },
  collect: collectUsertkPaper,
  noiseSelectors: USERTK_NOISE_SELECTORS,
};
/**
 * 试卷详情页适配器（本期 MVP 目标页面）。
 *
 * 目标页面：`https://zujuan.xkw.com/{bankId}p{paperId}.html`
 *
 * 实测结构（14/14 份试卷一致）：
 *
 *   article.exam-cnt
 *     h2.exam-title                       → .title-txt span.txt 为纯标题
 *     section.exam-list
 *       div.sec-item                      ← **只有一个**，是整份试题清单的容器
 *         h4.sec-title  「一、单选题」      ← 题型分区靠它切分
 *         div.sec-list  × 8                 ← 每个 sec-list 恰好 1 道题
 *         h4.sec-title  「二、多选题」
 *         div.sec-list  × 3
 *         …
 *           div.tk-quest-item.quesroot[questionid][bankid][questionindex]
 *             div.wrapper.quesdiv#quesdiv{qid}
 *               div.exam-item__cnt           ← 题干：文本 + 公式 img + 选项 table
 *               div.exam-item__opt           ← 答案区（初始 hidden）
 *                 div.item.knowlegde         ← 知识点（与答案一起保留）
 *                 div.item.answer            ← 答案/解析（单张图片，含【答案】【分析】【详解】）
 *     section.exam-analyze               ← 试卷分析（噪声；注意它也用了 .sec-item 类名）
 *   aside.other-info                     ← 侧栏：内含 .tools > .link-box（试卷下载等按钮）
 *
 * 采集过程**只读**，不修改任何 DOM。
 */

import { PAPER_DETAIL_URL_PATTERN } from '../shared/constants';
import { normalizeInlineText } from '../shared/text';
import { resolveAll, resolveOne, type SelectionReport } from './selectors';
import type { CollectResult, PageAdapter, PaperModel, PaperSection, QuestionRef } from './types';

/** 打印/导出时需要剔除的噪声。仅作用于打印样式与离屏 clone，不动原页面。 */
export const PAPER_DETAIL_NOISE_SELECTORS: readonly string[] = [
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
  // 试卷分析（不属于试卷正文）
  'section.exam-analyze',
  '#paperAnalyze',
  // 题目上的操作与元信息
  '.add-sec-ques',
  '.ques-additional',
  '.exam-item__custom',
  '.exam-item__info',
  '.ctrl-box',
  '.video-help',
];

/** 一道题的列表包裹层选择器（每个 sec-list 内恰好一道题）。 */
const QUESTION_ITEM_SELECTOR = '.tk-quest-item';

/**
 * 从题节点读取身份信息。qid 与 bankId 是答案接口的必需参数。
 *
 * 关于序号：实测发现 `questionindex` 属性**不可靠**——同一份试卷上 19 道题
 * 该属性全为 "0"（并非全局递增序号）。因此对外暴露的 `index` 一律取
 * **文档顺序**（1 开始），这才是「第几题」的正确语义。
 */
function readQuestionRef(node: HTMLElement, documentOrderIndex: number): QuestionRef | null {
  const wrapper = node.querySelector('.wrapper.quesdiv');
  const qid = node.getAttribute('questionid') ?? wrapper?.id.replace(/^quesdiv/, '') ?? '';
  if (!qid) return null;

  // bankid 在试卷详情页实测恒为 "11"；缺失时按站点默认题库兜底
  const bankId = node.getAttribute('bankid') || '11';

  return { qid, bankId, index: documentOrderIndex, node };
}

interface RawGroup {
  title: string;
  listNodes: HTMLElement[];
}

/**
 * 按「题型标题 + 紧随其后的 sec-list」切分试题清单。
 *
 * 之所以不能简单地用 `.sec-item` 分组：整份清单只有一个 `.sec-item`，
 * 而 `section.exam-analyze` 里另有若干个同名的 `.sec-item`（用于试卷分析表格），
 * 直接选择会串入分析区块。因此必须做**有序遍历**。
 */
function groupBySectionTitles(container: Element): RawGroup[] {
  const groups: RawGroup[] = [];
  let current: RawGroup | null = null;

  for (const child of Array.from(container.children)) {
    if (child.matches('h4.sec-title, .sec-title')) {
      const title =
        child.querySelector('span')?.textContent?.trim() ?? child.textContent?.trim() ?? '';
      current = { title, listNodes: [] };
      groups.push(current);
    } else if (child.matches('.sec-list')) {
      if (!current) {
        // 题目出现在任何标题之前：归入一个无名分组，绝不丢弃
        current = { title: '', listNodes: [] };
        groups.push(current);
      }
      current.listNodes.push(child as HTMLElement);
    }
  }
  return groups;
}

/** 采集整份试卷。题目永不丢失：所有兜底分支都会把题目补齐。 */
export function collectPaperDetail(doc: Document): CollectResult {
  const reports: SelectionReport[] = [];

  const articleResolved = resolveOne<HTMLElement>(doc, 'article');
  reports.push(articleResolved.report);
  const article = articleResolved.value;
  if (!article) {
    return {
      ok: false,
      reason:
        '未找到试卷正文容器（article.exam-cnt）。页面结构可能已改版，或当前不是试卷详情页。',
      reports,
    };
  }

  const titleResolved = resolveOne<HTMLElement>(article, 'titleText');
  reports.push(titleResolved.report);
  const title = titleResolved.value?.textContent?.trim() ?? '';

  const infoResolved = resolveOne<HTMLElement>(article, 'titleInfoList');
  reports.push(infoResolved.report);
  // 元信息里夹杂大量换行与缩进（实测形如 "整体难度：\n   \n   适中"），
  // 必须规范化，否则导出的标题行会被拆得七零八落。
  const meta = infoResolved.value
    ? Array.from(infoResolved.value.querySelectorAll('span.item'))
        .map((el) => normalizeInlineText(el.textContent ?? ''))
        .filter((text) => text.length > 0)
    : [];

  const questionResolved = resolveAll<HTMLElement>(article, 'questionItem');
  reports.push(questionResolved.report);
  const allQuestionNodes = questionResolved.values;
  if (allQuestionNodes.length === 0) {
    return {
      ok: false,
      reason:
        '未找到任何题目容器（.tk-quest-item）。页面可能尚未渲染完成，或站点结构已改版。',
      reports,
    };
  }

  const containerResolved = resolveOne<HTMLElement>(article, 'sectionItem');
  reports.push(containerResolved.report);
  const container = containerResolved.value ?? resolveOne<HTMLElement>(article, 'examList').value;

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

  if (container) {
    const groups = groupBySectionTitles(container);
    for (const group of groups) {
      const nodes = group.listNodes.flatMap((listNode) =>
        Array.from(listNode.querySelectorAll<HTMLElement>(QUESTION_ITEM_SELECTOR)),
      );
      const refs = collectFrom(nodes);
      if (refs.length > 0) sections.push({ title: group.title, questions: refs });
    }
  }

  // 兜底一：分组未覆盖到的题目（结构变化 / 题目不在 sec-list 内）——全部补进来，绝不丢题。
  const collected = new Set(sections.flatMap((s) => s.questions.map((q) => q.node)));
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
    meta,
    selectionReports: reports,
  };
  return { ok: true, model };
}

export const paperDetailAdapter: PageAdapter = {
  id: 'paper-detail',
  label: '试卷详情页',
  matches(url: string, doc: Document): boolean {
    if (!PAPER_DETAIL_URL_PATTERN.test(url)) return false;
    // URL 与 DOM 双判定，避免站点路由变化时误注入
    return doc.querySelector('article.exam-cnt') !== null;
  },
  collect: collectPaperDetail,
  noiseSelectors: PAPER_DETAIL_NOISE_SELECTORS,
};

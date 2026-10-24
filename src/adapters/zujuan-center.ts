/**
 * 组卷中心适配器（正在组的那份卷）。
 *
 * 目标页面：`https://zujuan.xkw.com/zujuan`
 *
 * 这是**结构差异最大**的一类页面，必须单独写适配器：
 *
 *   article.paper-cnt                       ← 不是 article.exam-cnt
 *     div.paper-head
 *       div.paper-title
 *         #pui_maintitle   ← 标题在 contenteditable 上，且**没有** .title-txt
 *     div.paper-body
 *       div.paper-part        × N           ← 「第I卷」分段（常为 hidden）
 *         div.part-head     （多为 hidden）
 *         div.part-body
 *           div.ques-type     × N           ← 一个题型
 *             div.questype-head
 *               .questypetitle                ← **题型标题在这里**
 *                 .questypeindex  「一、」
 *                 .questypename   「单选题」
 *             .questype-ctrl          ← 操作按钮（噪声）
 *             div.questype-body
 *               div.ques-item[questionid]     ← 题目外层（**不是** .tk-quest-item）
 *                 div.ques-ctrl               ← 操作条（噪声）
 *                 div.tk-quest-item.quesroot  ← 真正的题目，内部结构与详情页一致
 *                   div.wrapper.quesdiv
 *                     div.exam-item__cnt      ← 题干
 *                     div.exam-item__opt      ← 知识点 + 答案（初始 hidden）
 *   aside.tools  /  .global-ctrl            ← 操作栏（噪声）
 *
 * 与试卷详情页的差异汇总：
 *
 * | | 试卷详情页 | 组卷中心 |
 * |---|---|---|
 * | 根容器 | `article.exam-cnt` | `article.paper-cnt` |
 * | 题型标记 | `h4.sec-title` | `.questype-head .questypetitle` |
 * | 题目外层 | `.sec-list` | `.ques-item` |
 * | 标题 | `.exam-title .title-txt span.txt` | `#pui_maintitle` |
 * | 操作栏 | `aside.other-info` | `aside.tools` / `.global-ctrl` |
 *
 * 一个必须注意的陷阱：页面**底部还有一个用于拖拽排序的模板区**
 * （`.ques-type` 直接位于 `.group-ctrl` 下，里面的 `h3` 带「拖动排序」），
 * 它同样含 `.ques-list`。因此本题型选择器一律限定在 `.paper-body` 之内，
 * 否则会把模板当成真实题型。实测模板区的 `.tk-quest-item` 数为 0，
 * 但仍显式避开，避免站点以后往模板里塞示例题。
 *
 * 采集过程**只读**，不修改任何 DOM。
 */

import { normalizeInlineText } from '../shared/text';
import { resolveAll, resolveOne, type SelectionReport } from './selectors';
import type { CollectResult, PageAdapter, PaperModel, PaperSection, QuestionRef } from './types';

/**
 * 打印/导出时需要剔除的噪声。仅作用于打印样式与离屏 clone，不动原页面。
 *
 * 组卷中心的编辑态控件远多于详情页，必须清干净，否则会把
 * 「换题 / 纠错 / 详情 / 插入作答区 / 分值 / 上移 / 下移 / 删除」
 * 整条操作栏印到纸上。实测每道题的操作条里还有一句提示文案。
 */
export const ZUJUAN_CENTER_NOISE_SELECTORS: readonly string[] = [
  // 站点框架
  'header.page-header',
  'header',
  'nav',
  '.main-nav',
  '.bread-nav',
  '.fixed-nav',
  '.footer',
  // 操作栏与侧栏
  'aside.tools',
  '.tools',
  '.global-ctrl',
  '.member-guide',
  '.recent-group',
  '.quest-basket',
  '.quest-basket-nav',
  '.aside-pop.activity-btn',
  '.ai-entry.fixed',
  // 试卷编辑态控件
  '.seal-line',
  '.paper-title .sub-title',
  '.part-head',
  '.questype-ctrl',
  '.questypeheadbox .questypescore',
  '.ques-ctrl',            // 每题的「换题/纠错/详情/插入作答区/分值/上移/下移/删除」
  '.add-res',
  '.msg-prompt',
  '.ctrl-box',
  '.exam-item__info',
  '.deleted-box',          // 「已删试题」回收区
  '.group-ctrl',           // 底部拖拽排序模板区
  '.qt-box',
  '.part-box',
  '.ques-box',
];

/** 从题节点读取身份信息。 */
function readQuestionRef(node: HTMLElement, documentOrderIndex: number): QuestionRef | null {
  const wrapper = node.querySelector('.wrapper.quesdiv');
  // 组卷中心实测三层都带 questionid：.ques-item / .tk-quest-item / #quesdiv{qid}
  const qid =
    node.getAttribute('questionid') ??
    node.querySelector('.tk-quest-item[questionid]')?.getAttribute('questionid') ??
    wrapper?.id.replace(/^quesdiv/, '') ??
    '';
  if (!qid) return null;

  // bankid 实测在 .tk-quest-item 上（内层），外层 .ques-item 没有
  const bankId =
    node.getAttribute('bankid') ??
    node.querySelector('.tk-quest-item[bankid]')?.getAttribute('bankid') ??
    '11';

  return { qid, bankId, index: documentOrderIndex, node };
}

/** 从题型标题节点取纯文本（「一、」+「单选题」被拆成两个 span）。 */
function typeTitleOf(typeNode: Element): string {
  const title = typeNode.querySelector('.questypetitle');
  if (!title) return '';
  const index = title.querySelector('.questypeindex')?.textContent ?? '';
  const name = title.querySelector('.questypename')?.textContent ?? '';
  const combined = normalizeInlineText(`${index}${name}`);
  if (combined) return combined;
  // 兜底：整块文本，但要去掉可能的操作按钮文字
  return normalizeInlineText(title.textContent ?? '');
}

/** 采集组卷中心的这份卷。题目永不丢失。 */
export function collectZujuanCenter(doc: Document): CollectResult {
  const reports: SelectionReport[] = [];

  const articleResolved = resolveOne<HTMLElement>(doc, 'groupPaperRoot');
  reports.push(articleResolved.report);
  const article = articleResolved.value;
  if (!article) {
    return {
      ok: false,
      reason:
        '未找到组卷试卷容器（article.paper-cnt）。页面结构可能已改版，或当前组卷中心里还没有内容。',
      reports,
    };
  }

  const titleResolved = resolveOne<HTMLElement>(article, 'groupTitle');
  reports.push(titleResolved.report);
  // 标题在 contenteditable 上；副标题是占位符（hidden），不取
  const title = normalizeInlineText(titleResolved.value?.textContent ?? '');

  const questionResolved = resolveAll<HTMLElement>(article, 'groupQuestionItem');
  reports.push(questionResolved.report);
  const allQuestionNodes = questionResolved.values;
  if (allQuestionNodes.length === 0) {
    return {
      ok: false,
      reason:
        '组卷中心里还没有任何题目（.paper-body .tk-quest-item）。请先从题库中添加试题。',
      reports,
    };
  }

  // 只取 .paper-body 之内的题型，避开底部拖拽排序模板区
  const body = article.querySelector('.paper-body') ?? article;
  const typeNodes = Array.from(body.querySelectorAll<HTMLElement>('.ques-type'));

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

  for (const typeNode of typeNodes) {
    const nodes = Array.from(typeNode.querySelectorAll<HTMLElement>('.tk-quest-item'));
    if (nodes.length === 0) continue;
    for (const node of nodes) collected.add(node);
    const refs = collectFrom(nodes);
    if (refs.length > 0) sections.push({ title: typeTitleOf(typeNode), questions: refs });
  }

  // 兜底：未被题型覆盖的题目全部补进来，绝不丢题
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
          : '未能从组卷中心采集到任何题目。',
      reports,
    };
  }

  const model: PaperModel = {
    url: doc.location?.href ?? '',
    title: title || doc.title || '未命名试卷',
    rootSelector: 'article.paper-cnt',
    sections,
    meta: [],
    selectionReports: reports,
  };
  return { ok: true, model };
}

/** 组卷中心 URL：`/zujuan` 或 `/zujuan/`，也兼容带 query 的形态。 */
export const ZUJUAN_CENTER_URL_PATTERN = /^https:\/\/zujuan\.xkw\.com\/zujuan\/?(?:\?.*)?$/i;

export const zujuanCenterAdapter: PageAdapter = {
  id: 'zujuan-center',
  label: '组卷中心（正在组卷）',
  matches(url: string, doc: Document): boolean {
    if (!ZUJUAN_CENTER_URL_PATTERN.test(url)) return false;
    return doc.querySelector('article.paper-cnt') !== null;
  },
  collect: collectZujuanCenter,
  noiseSelectors: ZUJUAN_CENTER_NOISE_SELECTORS,
};
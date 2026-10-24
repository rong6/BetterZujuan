/**
 * 页面净化。
 *
 * 铁律：**只在 clone 上删除节点**。原页面永远不动 —— 这是与既有油猴脚本
 * 最本质的差异（它们会 `document.body.innerHTML = ''` 然后 reload，
 * 直接破坏页面状态，还可能让已加载的答案图片重新走一次请求而拿到 403 提示图）。
 */

import type { QuestionRef } from '@/adapters/types';
import { clearInheritedMaskFrom, restoreOpacityIn } from './gray-mask';

/** 题干节点选择器（与适配器保持一致，这里只做局部查询）。 */
const STEM_SELECTOR = '.exam-item__cnt';
const OPT_SELECTOR = '.exam-item__opt';
const ANSWER_BLOCK_SELECTOR = '.item.answer';

/** 删除 root 内所有匹配噪声选择器的元素。仅用于 clone。 */
export function stripNoise(root: Element, noiseSelectors: readonly string[]): void {
  for (const selector of noiseSelectors) {
    let matches: Element[] = [];
    try {
      matches = Array.from(root.querySelectorAll(selector));
    } catch {
      // 选择器非法（站点改版）时跳过，不影响其它清理项
      continue;
    }
    for (const node of matches) node.remove();
  }
  // 同时清理 root 自身（当 root 命中噪声选择器时）
  for (const selector of noiseSelectors) {
    try {
      if (root.matches(selector)) {
        root.remove();
        return;
      }
    } catch {
      continue;
    }
  }
}

/** 移除所有 `hidden`，让答案区在打印时可见（只在 clone 上做）。 */
export function unhideAll(root: Element): void {
  for (const node of Array.from(root.querySelectorAll('[hidden]'))) {
    node.removeAttribute('hidden');
  }
  for (const opt of Array.from(root.querySelectorAll<HTMLElement>(OPT_SELECTOR))) {
    opt.style.display = 'block';
  }
}

/**
 * 取出题干的净化副本。
 *
 * 题干实测内容只包含「文本 + 公式 img + 选项 table」，所以这里不做任何标记级
 * 改写，只删噪声，最大限度保留原始排版。
 */
export function cloneStem(
  question: QuestionRef,
  noiseSelectors: readonly string[],
): Element | null {
  const stem = question.node.querySelector(STEM_SELECTOR);
  if (!stem) return null;
  const copy = stem.cloneNode(true) as Element;
  // 题干内部的噪声（极少，但知识点偶有混入）同样清掉
  stripNoise(copy, noiseSelectors);
  stripInteractiveControls(copy);
  stripScriptLinks(copy);
  restoreOpacityIn(copy);
  // 蒙版通常在 .wrapper.quesdiv（本节点的父级），不在克隆结果里，
  // 必须沿祖先链补一次，否则导出的题干依旧是灰的。
  clearInheritedMaskFrom(stem, copy);
  return copy;
}

/**
 * 去掉 javascript: 伪链接（站点常用 `javascript:void 0` 承载点击事件）。
 *
 * 这些链接在导出的文档里毫无意义，而且 docx 的转换器会把它们判为
 * unsafe-link 并告警 —— 留着只会制造噪音。文字本身保留。
 */
function stripScriptLinks(root: Element): void {
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = (anchor.getAttribute('href') ?? '').trim().toLowerCase();
    if (href.startsWith('javascript:')) anchor.removeAttribute('href');
  }
}

/** 知识点块的类名（站点原始拼写为 knowlegde）。 */
const KNOWLEDGE_SELECTOR = '.item.knowlegde, .item.knowledge';

/**
 * 知识点里「解读」按钮的选择器。
 *
 * 实测结构（试卷详情页实测 44 处）：
 *   <a data-type="knowledgeItem" href="javascript:void 0"
 *      class="knowledge-explain primary-button btn_KnowledgeUnscramble"
 *      cid="27977" cname="交集的概念及运算" bankid="11">解读</a>
 *
 * 它只是个交互入口（点击弹窗讲解），导出到文档里毫无意义；
 * 而且 href 是 `javascript:void 0`，还会触发 docx 的 unsafe-link 告警。
 * 注意知识点名称那侧的 `<a class="knowledge-name">` **没有**这个类名，
 * 因此按类名精确删除，不能按文字匹配（否则会误伤名称里含「解读」的知识点）。
 */
const KNOWLEDGE_EXPLAIN_SELECTOR = '.knowledge-explain, .btn_KnowledgeUnscramble';

/**
 * 删除纯交互控件：知识点「解读」按钮。
 *
 * 与 `stripScriptLinks` 的区别：这里把元素整个删掉。
 * 只去掉 href 是不够的 —— 按钮文字「解读」会紧跟在知识点名称后面，
 * 读起来变成「交集的概念及运算解读」。
 */
function stripInteractiveControls(root: Element): void {
  for (const node of Array.from(root.querySelectorAll(KNOWLEDGE_EXPLAIN_SELECTOR))) {
    node.remove();
  }
}

/**
 * 取出「知识点 + 答案与解析」的净化副本。
 *
 * 实测站点结构：`.exam-item__opt` 下正好是两项 —— `.item.knowlegde` 与
 * `.item.answer`（【答案】【分析】【详解】被合并渲染成里面的一张图片）。
 *
 * 为什么把知识点一起取出：知识点和答案是同一个题目的「解答部分」，
 * 一旦分开放（例如「答案置末」模式只搬走 `.item.answer`），
 * 知识点就会孤零零留在题目那边，用户实际看到的正是这个问题。
 * 因此这里把两者作为**一个整体**克隆，导出时始终同行同页。
 */
export function cloneAnswer(
  question: QuestionRef,
  noiseSelectors: readonly string[],
): Element | null {
  const opt = question.node.querySelector(OPT_SELECTOR) ?? question.node;
  if (!opt.querySelector(ANSWER_BLOCK_SELECTOR)) return null;

  const copy = opt.cloneNode(true) as Element;
  stripNoise(copy, noiseSelectors);
  stripInteractiveControls(copy);
  stripScriptLinks(copy);
  restoreOpacityIn(copy);
  // 同上：蒙版是 .exam-item__opt 的父级，不在克隆结果内
  clearInheritedMaskFrom(opt, copy);

  // 只保留知识点与答案两项，其余（来源、操作条等）一律去掉
  for (const child of Array.from(copy.children)) {
    if (child.matches(ANSWER_BLOCK_SELECTOR) || child.matches(KNOWLEDGE_SELECTOR)) continue;
    child.remove();
  }
  if (!copy.querySelector(ANSWER_BLOCK_SELECTOR)) return null;

  // 知识点排在答案之前，读起来更自然。
  // 这里用子节点下标比较而不是 compareDocumentPosition，避免依赖全局 Node 常量
  // （单测跑在 node 环境里，没有该全局）。
  const knowledge = copy.querySelector(KNOWLEDGE_SELECTOR);
  const answer = copy.querySelector(ANSWER_BLOCK_SELECTOR);
  if (knowledge && answer) {
    const order = Array.from(copy.children);
    if (order.indexOf(knowledge) > order.indexOf(answer)) copy.insertBefore(knowledge, answer);
  }
  return copy;
}

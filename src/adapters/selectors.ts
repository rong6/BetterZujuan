/**
 * 全站选择器的唯一来源。
 *
 * 设计目的：站点 DOM 明显会变，所以不允许选择器散落在各处。
 * 每个键都带一组「候选选择器」，按顺序尝试，并把「实际命中了哪一个」记录下来，
 * 供诊断报告使用 —— 出问题时能立刻定位是哪一环断了。
 *
 * 注意：站点 class 串含多余空格（实测 `" tk-quest-item  quesroot  "`），
 * 因此所有判定必须走 `classList.contains` / CSS 选择器，禁止精确字符串比较。
 */

export type Cardinality = 'one' | 'many';

export interface SelectorSpec {
  /** 人类可读的用途说明，会出现在诊断报告中 */
  readonly description: string;
  /** 按优先级排列的候选选择器 */
  readonly candidates: readonly string[];
  readonly cardinality: Cardinality;
}

/**
 * 选择器注册表。键名即用途，值给出候选与期望数量。
 * 所有条目均已在试卷详情页 (`/{bankId}p{paperId}.html`) 实测命中。
 */
export const SELECTORS = {
  /** 试卷正文根容器 */
  article: {
    description: '试卷正文根容器 (article.exam-cnt)',
    candidates: ['article.exam-cnt', 'main.page.exam-detail article', 'article'],
    cardinality: 'one',
  },
  /** 页面主体（打印时用于隐藏噪声/保留正文） */
  main: {
    description: '页面主体容器 (main.page.exam-detail)',
    candidates: ['main.page.exam-detail', 'main', 'article.exam-cnt'],
    cardinality: 'one',
  },
  /** 试卷标题纯文本节点 */
  titleText: {
    description: '试卷标题文本 (.exam-title .title-txt span.txt)',
    candidates: [
      '.exam-title .title-txt span.txt',
      '.exam-title .title-txt',
      'h2.exam-title .txt',
      'h2.exam-title',
    ],
    cardinality: 'one',
  },
  /** 标题块（含元信息） */
  titleBlock: {
    description: '试卷标题块 (h2.exam-title)',
    candidates: ['h2.exam-title', '.exam-title'],
    cardinality: 'one',
  },
  /** 标题下的元信息列表（地区/年级/类型/日期等） */
  titleInfoList: {
    description: '试卷元信息列表 (.exam-title .info-list)',
    candidates: ['.exam-title .info-list', 'h2.exam-title .info-list'],
    cardinality: 'one',
  },
  /**
   * 试题清单容器：**只有一个**，其直接子元素是若干组
   * （`h4.sec-title` + 紧随其后的多个 `.sec-list`）。
   *
   * 注意：必须限定在 `section.exam-list` 之下。站点在「试卷分析」区块
   * (`section.exam-analyze`) 里也用了 `.sec-item` 类名（配 `.sec-item__title` 等），
   * 若只写 `.sec-item` 会误命中分析区块，实测确实存在这种碰撞。
   */
  sectionItem: {
    description: '试题清单容器 (section.exam-list > .sec-item)',
    candidates: ['section.exam-list > .sec-item', '.exam-list > .sec-item'],
    cardinality: 'one',
  },
  /** 试卷题目列表区 */
  examList: {
    description: '题目列表区 (section.exam-list)',
    candidates: ['section.exam-list', '.exam-list'],
    cardinality: 'one',
  },
  /** 题型分区标题（同一容器内按出现顺序排列，用于切分题型） */
  sectionTitle: {
    description: '题型分区标题 (h4.sec-title)',
    candidates: ['h4.sec-title', '.sec-title'],
    cardinality: 'many',
  },
  /** 单题的列表包裹层（每个 .sec-list 内含 1 道题） */
  questionListItem: {
    description: '单题列表包裹层 (.sec-list)',
    candidates: ['.sec-list'],
    cardinality: 'many',
  },
  /** 单题容器 */
  questionItem: {
    description: '单题容器 (.tk-quest-item.quesroot)',
    candidates: ['.tk-quest-item.quesroot', '.tk-quest-item'],
    cardinality: 'many',
  },
  /** 单题内容包裹层（其 id 形如 quesdiv{qid}） */
  questionWrapper: {
    description: '单题内容包裹层 (.wrapper.quesdiv)',
    candidates: ['.wrapper.quesdiv', '.quesdiv'],
    cardinality: 'one',
  },
  /** 题干（纯文本 + 公式 img + 选项 table） */
  questionStem: {
    description: '题干 (.exam-item__cnt)',
    candidates: ['.exam-item__cnt'],
    cardinality: 'one',
  },
  /** 答案区容器（初始带 hidden） */
  questionOpt: {
    description: '答案区容器 (.exam-item__opt)',
    candidates: ['.exam-item__opt'],
    cardinality: 'one',
  },
  /** 答案/解析块 */
  answerBlock: {
    description: '答案/解析块 (.item.answer)',
    candidates: ['.exam-item__opt .item.answer', '.item.answer'],
    cardinality: 'one',
  },
  /** 答案/解析图片 */
  answerImage: {
    description: '答案/解析图片 (.item.answer img)',
    candidates: ['.item.answer img', '.item.answer > img'],
    cardinality: 'one',
  },
  /** 全局「显示全部答案和解析」开关的包裹元素（真实状态在它的 checked class 上） */
  globalToggleWrap: {
    description: '全局答案开关包裹 (.tklabel-checkbox.show-answer)',
    candidates: ['.tklabel-checkbox.show-answer', '.show-answer'],
    cardinality: 'one',
  },
  /** 全局开关的隐藏 input（checked 恒为 false，仅用于定位，不用于判状态） */
  globalToggleInput: {
    description: '全局答案开关 input (#isshowAnswer)',
    candidates: ['#isshowAnswer', 'input[name="showAnswer"]'],
    cardinality: 'one',
  },
  /** 全局开关的 label（点击目标） */
  globalToggleLabel: {
    description: '全局答案开关 label (label[for="isshowAnswer"])',
    candidates: ['label[for="isshowAnswer"]', '.show-answer .checkbox-label', '.show-answer label'],
    cardinality: 'one',
  },
  /**
   * 按钮容器（注入导出入口，多级回退）。
   *
   * 三类页面的容器不同：
   *   - 试卷详情页 / 个人题库页：`aside.other-info` 里的 `.tools > .link-box`
   *   - 组卷中心 `/zujuan`：`.global-ctrl > .btn-box.clearfix`
   * 候选顺序刻意把最具体的放前面。
   */
  buttonContainer: {
    description: '操作按钮容器 (.tools .link-box / .global-ctrl .btn-box)',
    candidates: [
      '.tools .link-box',
      '.other-info .link-box',
      '.link-box',
      '.global-ctrl .btn-box.clearfix',
      '.global-ctrl .btn-box',
      '.btn-box.clearfix',
      '.btn-box',
    ],
    cardinality: 'one',
  },
  /** 侧栏（含全局开关与题型统计；打印时隐藏）。组卷中心的操作栏是 aside.tools */
  sidebar: {
    description: '侧栏 (aside.other-info / aside.tools)',
    candidates: ['aside.other-info', '.other-info', 'aside.tools', '.global-ctrl'],
    cardinality: 'one',
  },

  // ---------- 组卷中心 /zujuan ----------
  /** 组卷中心根容器（不是 article.exam-cnt） */
  groupPaperRoot: {
    description: '组卷试卷根容器 (article.paper-cnt)',
    candidates: ['article.paper-cnt', '.paper-cnt'],
    cardinality: 'one',
  },
  /** 组卷中心标题（在 contenteditable 上，没有 .title-txt） */
  groupTitle: {
    description: '组卷标题 (#pui_maintitle)',
    candidates: ['#pui_maintitle', '.paper-title .main-title', '.paper-title'],
    cardinality: 'one',
  },
  /** 组卷中心的题目：外层是 .ques-item，真正的题目是其中的 .tk-quest-item */
  groupQuestionItem: {
    description: '组卷题目 (.paper-body .tk-quest-item)',
    candidates: [
      // 从宽到窄：先取整卷内所有题目，再逐步收紧。
      // 反过来的话，站点一旦调整题型与题目的嵌套关系就会漏采。
      '.paper-body .tk-quest-item',
      '.paper-body .ques-type .tk-quest-item',
      'article.paper-cnt .tk-quest-item',
      '.tk-quest-item',
    ],
    cardinality: 'many',
  },
  /** 组卷中心的题型块 */
  groupQuestionType: {
    description: '组卷题型块 (.paper-body .ques-type)',
    candidates: ['.paper-body .ques-type', '.paper-cnt .ques-type'],
    cardinality: 'many',
  },
  /** 组卷中心的题型标题（「一、」与「单选题」拆成两个 span） */
  groupQuestionTypeTitle: {
    description: '组卷题型标题 (.questypetitle)',
    candidates: ['.questypetitle', '.questype-head .questypename'],
    cardinality: 'many',
  },
} as const satisfies Record<string, SelectorSpec>;

export type SelectorKey = keyof typeof SELECTORS;

/** 一条选择器的解析结果，用于诊断上报。 */
export interface SelectionReport {
  readonly key: SelectorKey;
  readonly expected: Cardinality;
  readonly found: number;
  /** 实际命中的候选选择器；全部未命中为 null */
  readonly used: string | null;
  /** 被依次尝试过的候选选择器 */
  readonly attempted: readonly string[];
}

export interface ResolvedOne<T extends Element = Element> {
  readonly value: T | null;
  readonly report: SelectionReport;
}

export interface ResolvedMany<T extends Element = Element> {
  readonly values: readonly T[];
  readonly report: SelectionReport;
}

function buildReport(
  key: SelectorKey,
  spec: SelectorSpec,
  found: number,
  used: string | null,
): SelectionReport {
  return { key, expected: spec.cardinality, found, used, attempted: spec.candidates };
}

/**
 * 解析单个元素：按候选顺序返回第一个命中者。
 * 不抛异常；未命中时 value 为 null，并如实记录 attempted 供诊断。
 */
export function resolveOne<T extends Element = Element>(
  root: ParentNode,
  key: SelectorKey,
): ResolvedOne<T> {
  const spec: SelectorSpec = SELECTORS[key];
  for (const candidate of spec.candidates) {
    let hit: Element | null = null;
    try {
      hit = root.querySelector(candidate);
    } catch {
      // 站点改版导致选择器非法时不应中断整条链路
      continue;
    }
    if (hit) return { value: hit as T, report: buildReport(key, spec, 1, candidate) };
  }
  return { value: null, report: buildReport(key, spec, 0, null) };
}

/** 解析多个元素：使用第一个能产出非空结果的候选选择器。 */
export function resolveAll<T extends Element = Element>(
  root: ParentNode,
  key: SelectorKey,
): ResolvedMany<T> {
  const spec: SelectorSpec = SELECTORS[key];
  for (const candidate of spec.candidates) {
    let hits: Element[] = [];
    try {
      hits = Array.from(root.querySelectorAll(candidate));
    } catch {
      continue;
    }
    if (hits.length > 0) {
      return { values: hits as T[], report: buildReport(key, spec, hits.length, candidate) };
    }
  }
  return { values: [], report: buildReport(key, spec, 0, null) };
}

/** 在给定作用域内解析单元素（语义同 `resolveOne`，用于「这道题的题干」这类局部查询）。 */
export function resolveOneWithin<T extends Element = Element>(
  scope: ParentNode,
  key: SelectorKey,
): ResolvedOne<T> {
  return resolveOne<T>(scope, key);
}

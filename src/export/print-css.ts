/**
 * 打印样式生成。
 *
 * 这里集中了「纸面适配」的经验值，每一条都对应一类真实故障：
 *   - box-sizing / wrapper padding → 打印右侧被裁切的主因
 *   - overflow-wrap: anywhere        → 公式与长英文不断行会撑出页面
 *   - img/table max-width            → 宽表格与图片溢出
 *   - break-inside: avoid            → 题目被跨页切断
 *
 * 同时遵循一条铁律：**样式只作用于打印**，屏幕态一律不受影响
 * （原页面 DOM 不做任何删除，只在需要重排时使用离屏 clone）。
 */

import { grayMaskCss } from '@/core/gray-mask';
import { KNOWLEDGE_FONT_PT } from './document-model';
import type { PrintJobOptions } from './options';

export const PRINT_ROOT_ID = 'bz-print-root';

/**
 * 扩展自身注入的 UI。
 *
 * 必须在打印时一并隐藏 —— 这是实测中发现的真 bug：
 * 面板是 `position: fixed`，打印规则只隐藏了站点噪声，**没隐藏我们自己**，
 * 于是真打印时整个侧边面板会被印到试卷纸上。
 * 这类问题只有把扩展装进真实浏览器、并真的走一遍打印才会暴露。
 */
export const EXTENSION_UI_SELECTORS: readonly string[] = [
  '#better-zujuan-panel-host',
  '.bz-entry-btn',
  '#bz-measure-style',
];

/** 打印时用于屏蔽原页面的标记 class（挂在 <html> 上）。 */
export const PRINTING_CLASS = 'bz-printing';

/** 使用离屏 clone 时挂在 <html> 上的标记 class。 */
export const CLONE_MODE_CLASS = 'bz-clone-mode';

function pageSize(options: PrintJobOptions): string {
  return `${options.paperSize} ${options.orientation}`;
}

/**
 * 生成打印样式。
 *
 * @param noiseSelectors 需要隐藏的噪声选择器（来自适配器）
 * @param useClone 是否使用离屏 clone 重排（答案移至末尾 / 仅答案 / 仅试题）
 */
export function buildPrintCss(
  options: PrintJobOptions,
  noiseSelectors: readonly string[],
  useClone: boolean,
  rootSelector = 'article.exam-cnt',
): string {
  // 站点噪声 + 扩展自身 UI，二者都必须隐藏
  const noise = [...noiseSelectors, ...EXTENSION_UI_SELECTORS].join(',\n');

  const fontRules = [
    options.fontFamily ? `font-family: ${options.fontFamily} !important;` : '',
    options.fontSizePt ? `font-size: ${options.fontSizePt}pt !important;` : '',
  ]
    .filter(Boolean)
    .join('\n      ');

  return `
/* ============ 屏幕态：离屏 clone 不可见 ============ */
@media screen {
  #${PRINT_ROOT_ID} { display: none !important; }
}

/* ============ 打印态 ============ */
@media print {
  @page {
    size: ${pageSize(options)};
    margin: ${options.marginMm}mm;
  }

  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
    overflow: visible !important;
    height: auto !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* 关键：避免 padding/border 把宽度撑爆导致右侧裁切 */
  *, *::before, *::after { box-sizing: border-box !important; }
${grayMaskCss()}

  /* —— 隐藏噪声（框架、侧栏、试卷分析、题目操作条…）—— */
  ${noise ? `${noise} { display: none !important; }` : ''}

  /*
   * 知识点里的「解读」按钮。
   *
   * 必须在这里藏着，不能只靠 purify 删除 —— 因为「原样」模式走的是
   * **零 DOM 变更**路径，直接打印原页面，根本不经过 clone，
   * 于是删除逻辑永远不执行，解读按钮照样被印出来（实测踩坑）。
   * 打印样式对两条路径都生效，因此这里才是唯一可靠的位置。
   */
  .knowledge-explain,
  .btn_KnowledgeUnscramble {
    display: none !important;
  }

  /* 默认答案区在站点 DOM 中带 hidden；打印时仅通过 CSS 展开，不改动页面状态。
     三类页面（详情页/个人题库/组卷中心）都用 .exam-item__opt，因此不限定根类名。 */
  .exam-item__opt,
  .exam-item__opt[hidden],
  .exam-item__opt .item.answer,
  .exam-item__opt .item.answer[hidden],
  .exam-item__opt .item.knowlegde,
  .exam-item__opt .item.knowlegde[hidden] {
    display: block !important;
    visibility: visible !important;
  }

  /* 站点容器在打印时铺满纸面，去掉定宽（详情页 1200px）与内边距 */
  main.page.exam-detail,
  main.page.exam-detail .wrapper,
  main.page.group-exam-page,
  main.page.group-exam-page .wrapper,
  ${rootSelector},
  ${rootSelector} .wrapper {
    width: auto !important;
    max-width: none !important;
    min-width: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    float: none !important;
  }

  ${fontRules ? `${rootSelector}, #${PRINT_ROOT_ID} {\n      ${fontRules}\n  }` : ''}

  /* 图片与表格不溢出 */
  img {
    max-width: 100% !important;
    height: auto !important;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  table {
    width: 100% !important;
    max-width: 100% !important;
    border-collapse: collapse;
  }
  td, th { max-width: 100% !important; }

  /* 长串/公式强制可断行，防止一行撑出页面 */
  p, div, span, li, td, th {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  /*
   * 防跨页切断 —— 这里**只能**对「通常小于一页」的块生效。
   *
   * 踩过的坑：早期把 .sec-item 也加进来，而它是整卷题目的容器
   * （实测高 2470px ≈ 2.2 页）。引擎无法把它塞进一页，就整体推到下一页，
   * 结果第一页只剩一个标题、下面一大片空白。
   * 容器级元素绝不能加 break-inside: avoid。
   */
  .exam-item__cnt,
  .item.knowlegde,
  .item.answer,
  img,
  table[name="optionsTable"] {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* 题型标题不要孤零零留在页尾（详情页用 h4.sec-title，组卷中心用 .questypetitle） */
  h4.sec-title, .sec-title, .questypetitle {
    break-after: avoid;
    page-break-after: avoid;
  }

  /*
   * 知识点与答案放在一起呈现，且字号向答案图片里的正文看齐。
   *
   * 答案是一张位图，显示时被压到正文宽（DOCX 601px / 打印 703px），
   * 图内文字的实际视觉大小只取决于显示宽度。按实测比例
   * （见 document-model.ts 的 ANSWER_IMAGE_TEXT_INK_RATIO）折算，
   * 答案正文约 9.3pt；知识点若沿用 14px（10.5pt）就会明显比答案文字大一圈。
   */
  .item.knowlegde, .item.knowlegde .knowledge-title, .item.knowlegde .knowledge-item,
  .item.knowlegde span, .item.knowlegde a {
    font-size: ${KNOWLEDGE_FONT_PT}pt !important;
    line-height: 1.5 !important;
  }
  .item.knowlegde { margin-bottom: 4px; }

  /*
   * 清掉站点自带的可见边框。
   *
   * 实测站点给答案区 .exam-item__opt 加了 1px 虚线边框（#dcdcdc）作为
   * 「题目 / 答案」的分隔线 —— 展开答案后，每道题的答案上方都会出现一条虚线，
   * 印在纸上很像裁剪线。题目容器 .tk-quest-item 也带边框。
   *
   * 这里只对**导出/打印**清除；屏幕观感保持站点原样
   * （与「原始 DOM 只读」的铁律一致：不改站点，只改我们输出到纸面的样式）。
   * 注意排除表格：选项表格本身无边框，且 border-collapse 需要保留。
   */
  .tk-quest-item,
  .exam-item__cnt,
  .exam-item__opt,
  .exam-item__info,
  .item.answer,
  .item.knowlegde,
  .sec-list,
  .sec-item,
  .ques-item,
  .questype-body {
    border: 0 none !important;
  }

  /* 纸面用深色字，避免字迹过淡 */
  .exam-item__cnt, .exam-title, .sec-title, .questypetitle, .paper-title, p, div, span {
    color: #000 !important;
    text-shadow: none !important;
    background: transparent !important;
  }
  a { text-decoration: none !important; color: #000 !important; }

  /*
   * 题目之间只用留白分隔，不加任何线条。
   *
   * 曾经用虚线当分隔线，结果每道题的边界都多出一条线，
   * 印在纸上很像「裁剪线」，观感很差。留白已经足够区分题目了。
   */
  .sec-list { margin-bottom: 16px; }

  /* 试卷标题（详情页 .exam-title .title-txt；组卷中心 .paper-title .main-title） */
  .exam-title .title-txt span.txt,
  .exam-title .title-txt,
  .paper-title .main-title {
    font-size: 15pt !important;
    font-weight: 700 !important;
    text-align: center;
    display: block;
    margin-bottom: 6px;
  }

  /* 组卷中心的题目外层：同样只用留白分隔，不加线条 */
  .ques-item { margin-bottom: 16px; }
  .paper-part + .paper-part { margin-top: 14px; }
}

/* ============ 离屏 clone 模式 ============ */
${
  useClone
    ? `
@media print {
  html.${CLONE_MODE_CLASS} main { display: none !important; }
  html.${CLONE_MODE_CLASS} #${PRINT_ROOT_ID} { display: block !important; }

  #${PRINT_ROOT_ID} .bz-print-title {
    font-size: 15pt; font-weight: 700; text-align: center;
    margin: 0 0 4px; padding: 0;
  }
  /* 元信息只用留白分隔，不加下划线（与题目边界一致：不要多余的线） */
  #${PRINT_ROOT_ID} .bz-print-meta {
    text-align: center; font-size: 9pt; color: #444;
    margin: 0 0 14px; padding: 0;
  }
  #${PRINT_ROOT_ID} .bz-print-section-title {
    font-size: 12pt; font-weight: 700;
    margin: 14px 0 8px;
    break-after: avoid; page-break-after: avoid;
  }
  #${PRINT_ROOT_ID} .bz-print-question {
    margin-bottom: 12px;
    break-inside: avoid; page-break-inside: avoid;
  }
  /* 答案块同样不加竖线，仅靠留白与缩进区分 */
  #${PRINT_ROOT_ID} .bz-print-answer {
    margin: 6px 0 0; padding-left: 0;
    break-inside: avoid; page-break-inside: avoid;
  }
  /* 题目与答案都有时，答案部分另起一页 */
  #${PRINT_ROOT_ID} .bz-page-break-before {
    break-before: page; page-break-before: always;
  }
  #${PRINT_ROOT_ID} .bz-print-answer-label {
    font-weight: 700; font-size: 10pt; color: #333;
  }
}`
    : ''
}
`;
}

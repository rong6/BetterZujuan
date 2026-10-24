import { normalizeInlineText } from '../shared/text';

export { normalizeInlineText };

/**
 * 统一内容模型：PDF 与 DOCX 共用同一份「内容 + 版面事实」。
 *
 * 存在的理由（实测教训）：
 * 两条导出路径曾各自为政 —— PDF 打印的是**原始 DOM**（站点 CSS 生效：配图 167px、
 * 选项表格无边框），DOCX 则是把 clone 丢给 docx 的 HTML 转换器**重新渲染**
 * （站点 CSS 全部失效：配图用了原图尺寸 925px、表格套上默认边框）。
 * 于是同一份试卷在 PDF 里正常、在 DOCX 里走样。
 *
 * 解决办法不是在 DOCX 里逐条打补丁，而是**先把版面事实量出来**，
 * 让两条路径都基于同一份事实渲染：
 *   - 图片：取页面**实际显示尺寸**写进 width/height 属性；
 *     像素数据仍可用原图（清晰度与版面互不牺牲）。
 *   - 元信息：空白规范化为单行文本。
 *   - 表格：站点选项表格本就没有边框，导出时显式去掉。
 */

/** 一张图片的版面事实。 */
export interface ImageLayout {
  /** 页面实际显示的宽（CSS px） */
  readonly width: number;
  /** 页面实际显示的高（CSS px） */
  readonly height: number;
}

/**
 * 量出 `root` 内每张图片的**实际显示尺寸**，按 `src` 归集。
 *
 * 为什么要量而不是用 naturalWidth：站点会主动用带 `?resizew=` 的缩略 URL
 * 把配图限制在显示尺寸（实测某题配图 natural 与显示都是 167×65，
 * 而同一张图的原图是 925×358）。若按原图尺寸导出，配图会比页面大 5.5 倍。
 */
export function measureImageLayout(root: Element): Map<string, ImageLayout> {
  const out = new Map<string, ImageLayout>();
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const rect = img.getBoundingClientRect();
    const width = Math.round(rect.width) || img.naturalWidth || 0;
    const height = Math.round(rect.height) || img.naturalHeight || 0;
    if (width <= 0 || height <= 0) continue;
    // 同一 src 可能多处出现；尺寸一致时无差别，取首次即可
    if (!out.has(src)) out.set(src, { width, height });
  }
  return out;
}

/**
 * 按「原始 DOM → clone」的顺序并行遍历，把测得的显示尺寸写成 width/height **属性**。
 *
 * 为什么必须是属性：实测 `style="width:167px"` 会让 docx 把高度也算成 167（丢比例），
 * 而 `width="167" height="65"` 会被精确采用。
 *
 * 为什么并行遍历而不是按 src 查表：同一 src 在不同上下文可能显示尺寸不同，
 * 按位置一一对应才不会串。
 *
 * @returns 实际写入尺寸的图片数量
 */
export function applyMeasuredImageSizes(originalRoot: Element, cloneRoot: Element): number {
  const originals = Array.from(originalRoot.querySelectorAll('img'));
  const clones = Array.from(cloneRoot.querySelectorAll('img'));
  if (originals.length === 0 || clones.length === 0) return 0;

  const layout = measureImageLayout(originalRoot);
  let applied = 0;

  // 优先按位置对齐（同结构 clone 必然等长）
  if (originals.length === clones.length) {
    for (let i = 0; i < clones.length; i += 1) {
      const clone = clones[i];
      const original = originals[i];
      if (!clone || !original) continue;
      const src = original.getAttribute('src');
      const size = src ? layout.get(src) : undefined;
      if (size && write(clone, size)) applied += 1;
    }
    return applied;
  }

  // 结构不一致时退回按 src 查表
  for (const clone of clones) {
    const src = clone.getAttribute('src');
    const size = src ? layout.get(src) : undefined;
    if (size && write(clone, size)) applied += 1;
  }
  return applied;
}

function write(img: Element, size: ImageLayout): boolean {
  img.setAttribute('width', String(size.width));
  img.setAttribute('height', String(size.height));
  return true;
}


/**
 * 答案图片内部正文的「墨高 / 图宽」比例。
 *
 * 实测 4 张真答案图（自然宽均为 1768px）：墨高 25/26/30/35px，
 * 比例落在 1.41%–1.98%，中位数约 1.5%。差异来自不同图片里混有
 * 【答案】标签行、分式、上下标等不同内容，因此取中位数作为常量。
 */
export const ANSWER_IMAGE_TEXT_INK_RATIO = 0.015;

/** 中文字形的墨高约为字号的 0.85 倍（用于把墨高折算成字号）。 */
export const CJK_INK_TO_EM = 0.85;

/**
 * 答案图片在文档中按给定宽度显示时，图中正文对应的字号（pt）。
 *
 * 关键点：图片被缩放后，图中文字的大小**只取决于显示宽度**，
 * 与图片的固有宽度无关 —— 因此可以直接由显示宽度算出字号。
 */
export function answerTextFontPt(displayWidthPx: number): number {
  const inkPx = displayWidthPx * ANSWER_IMAGE_TEXT_INK_RATIO;
  const fontPx = inkPx / CJK_INK_TO_EM;
  return fontPx * (72 / 96);
}

/** DOCX 里图片的显示宽度上限（docx 的 maxImageWidth 默认 601px = Word 正文宽）。 */
export const DOCX_IMAGE_MAX_WIDTH_PX = 601;

/** 打印时正文宽度（A4 + 12mm 页边距）。 */
export const PRINT_CONTENT_WIDTH_PX = 703;

/** 与答案图片文字对齐的知识点字号。 */
export const KNOWLEDGE_FONT_PT = Math.round(answerTextFontPt(PRINT_CONTENT_WIDTH_PX) * 2) / 2;

/** DOCX 里与答案图片文字对齐的知识点字号（半磅，docx 的 size 单位）。 */
export const KNOWLEDGE_FONT_HALF_POINTS = Math.round(answerTextFontPt(DOCX_IMAGE_MAX_WIDTH_PX) * 2);

/** DOCX 里知识点应使用的字号（pt），与答案图片正文对齐。 */
export const KNOWLEDGE_FONT_PT_DOCX = answerTextFontPt(DOCX_IMAGE_MAX_WIDTH_PX);

/**
 * 导出到 DOCX 时用的样式表。
 *
 * 两件事：
 *  1) 站点选项表格实测是**无边框**的（computed border 为 0px none），
 *     而 docx 的 HTML 转换器在 HTML 未声明边框时会套上默认单线边框；
 *     这里显式声明无边框，让 DOCX 与页面观感一致。
 *  2) 知识点字号向答案图片内的正文看齐 —— 答案图会被压到正文宽，
 *     图内文字随之变小，知识点若用 Word 默认字号会明显偏大。
 */
export const DOCX_EXPORT_STYLESHEET = `
  table, td, th, tr { border: 0 none !important; }
  table { border-collapse: collapse; }
  .item.knowlegde, .item.knowlegde * {
    font-size: ${KNOWLEDGE_FONT_PT_DOCX}pt !important;
    line-height: 1.5 !important;
  }
`;

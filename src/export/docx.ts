/** DOCX export: editable HTML conversion, including tables and MathML → OMML. */
import { Document as DocxDocument, Packer, Paragraph, TextRun } from 'docx';
import { htmlToContent } from 'docx/html';
import type { PaperModel } from '@/adapters/types';
import type { AnswerLoadRecord } from '@/answers/loader';
import { cloneAnswer, cloneStem } from '@/core/purify';
import { formulaHashFromSrc } from './formula-mathml';
import { blobToDataUrl } from './data-url';
import { applyMeasuredImageSizes, DOCX_EXPORT_STYLESHEET } from './document-model';
import type { ExportMode } from './options';

export interface DocxExportOptions {
  readonly mode: ExportMode;
  readonly title?: string;
  readonly onWarning?: ((message: string) => void) | undefined;
}

export interface DocxExportResult {
  readonly blob: Blob;
  readonly filename: string;
  readonly warnings: readonly string[];
}

const DEFAULT_NOISE = [
  'header.page-header', 'nav', '.fixed-nav', 'aside.other-info', 'section.exam-analyze',
  '.ctrl-box', '.ques-additional', '.exam-item__info',
];

function removeNoise(root: Element, selectors: readonly string[]): void {
  for (const selector of selectors) {
    try {
      root.querySelectorAll(selector).forEach((node) => node.remove());
    } catch {
      // Ignore a selector unsupported by the current browser engine.
    }
  }
}



function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  return `${(cleaned || '试卷').slice(0, 100)}.docx`;
}

/**
 * 把公式 `<img>` 就地换成真实 MathML，使其在 DOCX 中变成**可编辑公式**（OMML）。
 *
 * 为什么可行：同一 hash 在 CDN 上有 base64 的 MathML（见 formula-mathml.ts 实测记录）。
 * 拿不到 MathML 的公式保留位图；MathML 解析失败时同样保留位图，绝不产出空公式。
 *
 * @returns 成功转换的公式数量
 */
function applyFormulaMathMl(root: Element, mathMlByHash: ReadonlyMap<string, string>): number {
  if (mathMlByHash.size === 0) return 0;
  let applied = 0;
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const hash = formulaHashFromSrc(img.getAttribute('src') ?? img.src);
    if (!hash) continue;
    const mathml = mathMlByHash.get(hash);
    if (!mathml) continue;

    const wrapper = root.ownerDocument.createElement('span');
    wrapper.className = 'bz-formula';
    wrapper.innerHTML = mathml;
    // 解析后必须真的拿到 <math>，否则视为失败并保留原位图
    if (!wrapper.querySelector('math')) continue;
    img.replaceWith(wrapper);
    applied += 1;
  }
  return applied;
}

function statusByQuestion(records: readonly AnswerLoadRecord[]): Map<string, AnswerLoadRecord> {
  return new Map(records.map((record) => [`${record.question.bankId}:${record.question.qid}`, record]));
}

/** Build a DOCX Blob from the captured paper model. */
export async function buildPaperDocx(
  doc: Document,
  model: PaperModel,
  options: DocxExportOptions,
  answers: readonly AnswerLoadRecord[] = [],
  imageData: ReadonlyMap<string, string> = new Map(),
  formulaMathMl: ReadonlyMap<string, string> = new Map(),
): Promise<DocxExportResult> {
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    options.onWarning?.(message);
  };
  // 知识点与答案一起保留；来源等元信息始终剔除（界面不再提供该开关）
  const noise = [...DEFAULT_NOISE];
  const answerMap = statusByQuestion(answers);
  const children: (Paragraph | ReturnType<typeof htmlToContent>[number])[] = [];
  const baseUrl = doc.location?.href ?? model.url;

  // 关键：htmlToContent 不会自行下载图片。必须通过 images 选项（或 data URL）
  // 提供字节，否则该 <img> 会被丢弃，只给一条 missing-image 警告。
  const imagesOption = (source: string): { data: string } | undefined => {
    const direct = imageData.get(source);
    if (direct) return { data: direct };
    if (baseUrl) {
      try {
        const viaBase = imageData.get(new URL(source, baseUrl).href);
        if (viaBase) return { data: viaBase };
      } catch {
        // source 不是合法 URL，忽略
      }
    }
    return undefined;
  };

  /** 把 htmlToContent 的警告转成带题号、可读的中文提示。 */
  const makeOnWarning = (scope: string) => (warning: { code: string; message: string }) => {
    if (warning.code === 'missing-image') {
      warn(`${scope}：缺少图片数据，该图已从文档中移除（${warning.message}）`);
      return;
    }
    warn(`${scope}：${warning.code} — ${warning.message}`);
  };

  children.push(new Paragraph({
    alignment: 'center',
    heading: 'Title',
    children: [new TextRun({ text: options.title ?? model.title, bold: true, size: 30 })],
  }));
  if (model.meta.length) {
    // 元信息偏长（地区/年级/难度/考查范围…），居中会换行得参差不齐，改为左对齐小字号
    children.push(new Paragraph({
      spacing: { before: 0, after: 160 },
      children: [new TextRun({ text: model.meta.join('　·　'), size: 18, color: '595959' })],
    }));
  }

  const includeQuestions = options.mode !== 'answers-only';
  const includeInlineAnswers = options.mode === 'as-is';
  const answersAtEnd = options.mode === 'answers-at-end' || options.mode === 'answers-only';
  const answerItems: { label: string; html: Element }[] = [];

  for (const section of model.sections) {
    if (includeQuestions && section.title) {
      children.push(new Paragraph({ heading: 'Heading1', children: [new TextRun({ text: section.title, bold: true })] }));
    }
    for (const question of section.questions) {
      const key = `${question.bankId}:${question.qid}`;
      const record = answerMap.get(key);
      if (includeQuestions) {
        const stem = cloneStem(question, noise);
        if (stem) {
          // 先记下图片在页面上的实际显示尺寸（配图可能被站点用缩略 URL 限制得很小），
          // 再把公式换成可编辑 MathML —— 顺序不能反，否则公式 img 已消失、位置对不上。
          applyMeasuredImageSizes(question.node, stem);
          applyFormulaMathMl(stem, formulaMathMl);
          const content = htmlToContent(stem.outerHTML, {
            images: imagesOption,
            baseUrl,
            stylesheet: DOCX_EXPORT_STYLESHEET,
            onWarning: makeOnWarning(`第 ${question.index} 题题干`),
          });
          children.push(...content);
        } else {
          warn(`第 ${question.index} 题未找到题干节点。`);
        }
      }

      if (includeInlineAnswers || answersAtEnd) {
        const answer = cloneAnswer(question, noise);
        if (answer) {
          applyMeasuredImageSizes(question.node, answer);
          applyFormulaMathMl(answer, formulaMathMl);
          if (answersAtEnd) answerItems.push({ label: `${question.index}. `, html: answer });
          else {
            const content = htmlToContent(answer.outerHTML, {
              images: imagesOption,
              baseUrl,
              stylesheet: DOCX_EXPORT_STYLESHEET,
              onWarning: makeOnWarning(`第 ${question.index} 题答案`),
            });
            children.push(...content);
          }
        } else if (record?.status !== 'loaded' && record?.status !== 'cached') {
          warn(`第 ${question.index} 题答案未加载或未通过校验，已留空。`);
        }
      }
    }
  }

  if (answerItems.length) {
    if (options.mode === 'answers-at-end') {
      // 题目与答案都有时，答案部分另起一页
      children.push(new Paragraph({
        heading: 'Heading1',
        pageBreakBefore: true,
        children: [new TextRun({ text: '答案与解析', bold: true })],
      }));
    }
    for (const item of answerItems) {
      children.push(new Paragraph({ children: [new TextRun({ text: item.label, bold: true })] }));
      const content = htmlToContent(item.html.outerHTML, {
        images: imagesOption,
        baseUrl,
        stylesheet: DOCX_EXPORT_STYLESHEET,
        onWarning: makeOnWarning('文末答案'),
      });
      children.push(...content);
    }
  }

  const docxDocument = new DocxDocument({ sections: [{ children }] });
  const blob = await Packer.toBlob(docxDocument);
  return { blob, filename: safeFilename(model.title), warnings };
}

/** Create data URLs for only the verified answer blob URLs the loader owns. */
export async function collectAnswerImageData(
  records: readonly AnswerLoadRecord[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const record of records) {
    if (record.status !== 'loaded' && record.status !== 'cached') continue;
    const img = record.question.node.querySelector<HTMLImageElement>('.item.answer img');
    try {
      // 只读已校验并持有的 blob URL，绝不去重新请求站点的短时签名 URL
      // （那会返回 403 提示小图，把报错印进文档）。
      const source = record.blobUrl ?? img?.getAttribute('src');
      if (!source) continue;
      const response = await fetch(source);
      if (!response.ok) continue;
      const dataUrl = await blobToDataUrl(await response.blob());
      result.set(source, dataUrl);
      if (img) result.set(img.getAttribute('src') ?? img.src, dataUrl);
    } catch {
      // Reported by buildPaperDocx as a missing image when conversion cannot embed it.
    }
  }
  return result;
}

/** Download a generated DOCX in the current tab. */
export function downloadDocx(result: DocxExportResult, pageDoc: globalThis.Document = globalThis.document): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = pageDoc.createElement('a');
  anchor.href = url;
  anchor.download = result.filename;
  anchor.style.display = 'none';
  pageDoc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

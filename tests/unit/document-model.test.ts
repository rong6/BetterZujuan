import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  applyMeasuredImageSizes,
  DOCX_EXPORT_STYLESHEET,
  measureImageLayout,
} from '@/export/document-model';
import { normalizeInlineText } from '@/shared/text';

const fixtureHtml = readFileSync(resolve(process.cwd(), 'tests/fixtures/paper-detail.html'), 'utf8');

function loadDoc(url = 'https://zujuan.xkw.com/11p3524937.html'): Document {
  return new JSDOM(fixtureHtml, { url }).window.document as unknown as Document;
}

describe('normalizeInlineText', () => {
  it('把站点元信息里的换行与缩进压成单行', () => {
    // 实测原始值就是这个形态
    const raw = '整体难度：\n                                    \n                                    适中';
    expect(normalizeInlineText(raw)).toBe('整体难度： 适中');
  });

  it('处理全角空格与不换行空格', () => {
    expect(normalizeInlineText('考查范围：\u3000\u00a0集合')).toBe('考查范围： 集合');
  });

  it('去掉首尾空白', () => {
    expect(normalizeInlineText('  江苏  ')).toBe('江苏');
  });

  it('保留内部单个空格', () => {
    expect(normalizeInlineText('2026/10/17   0次')).toBe('2026/10/17 0次');
  });

  it('空与纯空白返回空串', () => {
    expect(normalizeInlineText('')).toBe('');
    expect(normalizeInlineText('   \n\t  ')).toBe('');
  });
});

/** jsdom 既不加载图片也不做布局，因此显式打桩来模拟真实浏览器的 getBoundingClientRect。 */
function stubRects(root: Element, size: { width: number; height: number }): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    img.getBoundingClientRect = () =>
      ({
        width: size.width,
        height: size.height,
        top: 0,
        left: 0,
        right: size.width,
        bottom: size.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
}

describe('measureImageLayout', () => {
  it('按 src 量出图片的实际布局尺寸', () => {
    const doc = loadDoc();
    const stem = doc.querySelector('.exam-item__cnt') as Element;
    stubRects(stem, { width: 167, height: 65 });

    const layout = measureImageLayout(stem);
    // 夹具题干里有多个公式图片
    expect(layout.size).toBeGreaterThan(0);
    for (const [src, size] of layout) {
      expect(src).toContain('/quesimg/Upload/formula/');
      // 关键：量到的是布局尺寸，而不是图片的固有尺寸
      expect(size).toEqual({ width: 167, height: 65 });
    }
  });

  it('量不到尺寸的图片被跳过（jsdom 无布局时的真实行为，避免写入 0 尺寸）', () => {
    const doc = loadDoc();
    const stem = doc.querySelector('.exam-item__cnt') as Element;
    // 不打桩：jsdom 下 rect 与 naturalWidth 都是 0
    expect(measureImageLayout(stem).size).toBe(0);
  });

  it('无图片时返回空表', () => {
    const doc = loadDoc();
    const div = doc.createElement('div');
    div.textContent = '没有图片';
    expect(measureImageLayout(div).size).toBe(0);
  });
});

describe('applyMeasuredImageSizes', () => {
  it('把实测显示尺寸写成 width/height 属性（而不是依赖 naturalWidth）', () => {
    const doc = loadDoc();
    const stem = doc.querySelector('.exam-item__cnt') as Element;
    const clone = stem.cloneNode(true) as Element;

    // 模拟「页面用缩略 URL 把配图限制为 167×65」
    stubRects(stem, { width: 167, height: 65 });
    const applied = applyMeasuredImageSizes(stem, clone);

    expect(applied).toBeGreaterThan(0);
    const first = clone.querySelector('img') as HTMLImageElement;
    expect(first.getAttribute('width')).toBe('167');
    expect(first.getAttribute('height')).toBe('65');
  });

  it('clone 必须原样保留尺寸属性，供 docx 精确取值', () => {
    const doc = loadDoc();
    const stem = doc.querySelector('.exam-item__cnt') as Element;
    const clone = stem.cloneNode(true) as Element;
    stubRects(stem, { width: 300, height: 120 });
    applyMeasuredImageSizes(stem, clone);

    for (const img of Array.from(clone.querySelectorAll('img'))) {
      expect(img.getAttribute('width')).toBe('300');
      expect(img.getAttribute('height')).toBe('120');
    }
  });

  it('不改动原始 DOM（导出过程只读）', () => {
    const doc = loadDoc();
    const stem = doc.querySelector('.exam-item__cnt') as Element;
    const before = stem.outerHTML;
    const clone = stem.cloneNode(true) as Element;
    stubRects(stem, { width: 167, height: 65 });

    applyMeasuredImageSizes(stem, clone);
    expect(stem.outerHTML).toBe(before);
    expect(stem.querySelector('img')?.hasAttribute('width')).toBe(false);
  });

  it('结构不一致时退回按 src 查表，不抛异常', () => {
    const doc = loadDoc();
    const stem = doc.querySelector('.exam-item__cnt') as Element;
    stubRects(stem, { width: 167, height: 65 });
    const partial = doc.createElement('div');
    partial.innerHTML = '<img src="' + (stem.querySelector('img')?.getAttribute('src') ?? '') + '">';

    expect(() => applyMeasuredImageSizes(stem, partial)).not.toThrow();
    expect(partial.querySelector('img')?.getAttribute('width')).toBe('167');
  });
});

describe('DOCX_EXPORT_STYLESHEET', () => {
  it('声明去除表格边框（站点选项表格本身无边框，docx 默认会加线）', () => {
    expect(DOCX_EXPORT_STYLESHEET).toContain('border: 0 none');
    expect(DOCX_EXPORT_STYLESHEET).toContain('table');
    expect(DOCX_EXPORT_STYLESHEET).toContain('td');
  });
});

describe('cloneAnswer / cloneStem —— 结构与链接清理', () => {
  it('知识点与答案被作为一体取出（不再只剩答案图）', async () => {
    const { cloneAnswer } = await import('@/core/purify');
    const { collectPaperDetail } = await import('@/adapters/paper-detail');
    const doc = loadDoc();
    const collected = collectPaperDetail(doc);
    if (!collected.ok) throw new Error(collected.reason);
    const question = collected.model.sections[0]?.questions[0];
    expect(question).toBeTruthy();

    const clone = cloneAnswer(question!, []);
    expect(clone).not.toBeNull();
    // 关键：知识点与答案都在，且作为整体返回
    expect(clone!.querySelector('.item.answer')).not.toBeNull();
    expect(clone!.querySelector('.item.knowlegde, .item.knowledge')).not.toBeNull();
    // 其它同级内容（来源等）不应带进来
    expect(clone!.querySelector('.exam-item__info')).toBeNull();
  });

  it('去掉 javascript: 伪链接，但保留文字', async () => {
    const { cloneAnswer } = await import('@/core/purify');
    const { collectPaperDetail } = await import('@/adapters/paper-detail');
    const doc = loadDoc();
    const collected = collectPaperDetail(doc);
    if (!collected.ok) throw new Error(collected.reason);
    const question = collected.model.sections[0]?.questions[0];

    const clone = cloneAnswer(question!, []);
    expect(clone).not.toBeNull();
    for (const anchor of Array.from(clone!.querySelectorAll('a'))) {
      expect((anchor.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:')).toBe(false);
    }
  });
});

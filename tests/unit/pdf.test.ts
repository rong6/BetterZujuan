import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectPaperDetail } from '@/adapters/paper-detail';
import type { PaperModel } from '@/adapters/types';
import {
  buildPrintRoot,
  PRINT_STYLE_ID,
  startPrintSession,
} from '@/export/pdf';
import { buildPrintCss, CLONE_MODE_CLASS, PRINT_ROOT_ID, PRINTING_CLASS } from '@/export/print-css';
import { DEFAULT_PRINT_OPTIONS, type PrintJobOptions } from '@/export/options';

const fixtureHtml = readFileSync(
  fileURLToPath(new URL('../fixtures/paper-detail.html', import.meta.url)),
  'utf8',
);
const fixtureUrl = 'https://zujuan.xkw.com/11p3524937.html';

function setup(): { dom: JSDOM; doc: Document; model: PaperModel } {
  const dom = new JSDOM(fixtureHtml, { url: fixtureUrl });
  const doc = dom.window.document as unknown as Document;
  const result = collectPaperDetail(doc);
  if (!result.ok) throw new Error(result.reason);
  return { dom, doc, model: result.model };
}

function options(overrides: Partial<PrintJobOptions> = {}): PrintJobOptions {
  return { ...DEFAULT_PRINT_OPTIONS, ...overrides };
}

afterEach(() => {
  vi.useRealTimers();
});


describe('buildPrintRoot', () => {
  it('answers-at-end 保留题目，将答案集中到文末并标注题号', () => {
    const { doc, model } = setup();
    const root = buildPrintRoot(doc, model, options({ mode: 'answers-at-end' }), [], () => 'blob:test/answer');

    expect(root.id).toBe(PRINT_ROOT_ID);
    expect(root.querySelectorAll('.bz-print-question .exam-item__cnt')).toHaveLength(4);
    expect(root.querySelectorAll('.bz-print-answer img')).toHaveLength(4);
    expect(root.textContent).toContain('答案与解析');
    expect(Array.from(root.querySelectorAll('.bz-print-answer-label')).map((e) => e.textContent)).toEqual([
      '1. ', '2. ', '3. ', '4. ',
    ]);
  });

  it('questions-only 不包含答案图', () => {
    const { doc, model } = setup();
    const root = buildPrintRoot(doc, model, options({ mode: 'questions-only' }), []);
    expect(root.querySelectorAll('.exam-item__cnt')).toHaveLength(4);
    expect(root.querySelectorAll('.item.answer img')).toHaveLength(0);
    expect(root.textContent).not.toContain('答案与解析');
  });

  it('answers-only 不包含题干，但保留答案图与题号', () => {
    const { doc, model } = setup();
    const root = buildPrintRoot(doc, model, options({ mode: 'answers-only' }), [], () => 'blob:test/answer');
    expect(root.querySelectorAll('.exam-item__cnt')).toHaveLength(0);
    expect(root.querySelectorAll('.bz-print-answer img')).toHaveLength(4);
    expect(Array.from(root.querySelectorAll('.bz-print-answer-label')).map((e) => e.textContent)).toEqual([
      '1. ', '2. ', '3. ', '4. ',
    ]);
  });

  it('未提供已验证 blob 时，移除短期答案 URL 并提示先加载', () => {
    const { doc, model } = setup();
    const root = buildPrintRoot(doc, model, options({ mode: 'answers-only' }), []);
    expect(root.querySelectorAll('.bz-print-answer img')).toHaveLength(0);
    expect(root.querySelectorAll('.bz-print-unavailable')).toHaveLength(4);
    expect(root.textContent).toContain('先点击「加载全部答案和解析」');
  });

  it('重写 clone 中的答案图片为 blob URL，但不改变原页面', () => {
    const { doc, model } = setup();
    const originals = Array.from(doc.querySelectorAll('.item.answer img')).map((img) => img.getAttribute('src'));
    const root = buildPrintRoot(
      doc,
      model,
      options({ mode: 'answers-at-end' }),
      [],
      (src) => (src.includes('imzujuan.xkw.com') ? 'blob:better-zujuan/test-image' : undefined),
    );

    expect(Array.from(root.querySelectorAll('.item.answer img')).every((img) =>
      img.getAttribute('src') === 'blob:better-zujuan/test-image',
    )).toBe(true);
    expect(Array.from(doc.querySelectorAll('.item.answer img')).map((img) => img.getAttribute('src'))).toEqual(originals);
  });

  it('缺少答案时不伪造内容，题干仍可打印', () => {
    const { doc } = setup();
    doc.querySelector('.item.answer')?.remove();
    const result = collectPaperDetail(doc);
    if (!result.ok) throw new Error(result.reason);
    const root = buildPrintRoot(doc, result.model, options({ mode: 'answers-at-end' }), [], () => 'blob:test/answer');
    expect(root.querySelectorAll('.exam-item__cnt')).toHaveLength(4);
    expect(root.querySelectorAll('.bz-print-answer img')).toHaveLength(3);
  });
});

describe('startPrintSession — 原页面零变更路径', () => {
  it('as-is 不创建 clone；清理后 body 与 html class 恢复', () => {
    const { doc, model } = setup();
    const bodyBefore = doc.body.innerHTML;
    const htmlClassesBefore = doc.documentElement.className;
    const print = vi.fn();
    const session = startPrintSession({
      doc, model, options: options({ mode: 'as-is' }), noiseSelectors: ['section.exam-analyze'],
      print, browserKind: 'chrome',
    });

    expect(session.path).toBe('original-dom');
    expect(print).toHaveBeenCalledOnce();
    expect(doc.getElementById(PRINT_ROOT_ID)).toBeNull();
    expect(doc.getElementById(PRINT_STYLE_ID)).toBeNull();
    expect(session.disposed).toBe(true);
    expect(doc.body.innerHTML).toBe(bodyBefore);
    expect(doc.documentElement.className).toBe(htmlClassesBefore);
  });

  it('开始打印期间只注入样式，不删除或改写试卷节点', () => {
    const { doc, model } = setup();
    const bodyBefore = doc.body.innerHTML;
    const session = startPrintSession({
      doc, model, options: options({ mode: 'as-is' }), noiseSelectors: [],
      print: () => {}, browserKind: 'firefox', fallbackCleanupMs: 10000,
    });

    expect(session.disposed).toBe(false);
    expect(doc.body.innerHTML).toBe(bodyBefore);
    expect(doc.documentElement.classList.contains(PRINTING_CLASS)).toBe(true);
    session.dispose();
    expect(doc.body.innerHTML).toBe(bodyBefore);
  });
});

describe('startPrintSession — clone 重排路径', () => {
  it('答案移至末尾时保留原文档，注入 clone；dispose 后完全还原', () => {
    const { dom, doc, model } = setup();
    const bodyBefore = doc.body.innerHTML;
    const htmlClassesBefore = doc.documentElement.className;
    const print = vi.fn();
    const session = startPrintSession({
      doc, model, options: options({ mode: 'answers-at-end' }), noiseSelectors: [],
      print, browserKind: 'firefox', fallbackCleanupMs: 10000,
      resolveImageSrc: (src) => src.includes('imzujuan.xkw.com') ? 'blob:answer/test' : undefined,
    });

    expect(session.path).toBe('clone');
    expect(print).toHaveBeenCalledOnce();
    expect(doc.querySelector('article.exam-cnt')).not.toBeNull();
    expect(doc.documentElement.classList.contains(PRINTING_CLASS)).toBe(true);
    expect(doc.documentElement.classList.contains(CLONE_MODE_CLASS)).toBe(true);
    const clone = doc.getElementById(PRINT_ROOT_ID);
    expect(clone).not.toBeNull();
    expect(clone?.querySelectorAll('.item.answer img')).toHaveLength(4);
    expect(Array.from(clone?.querySelectorAll('.item.answer img') ?? []).every((img) =>
      img.getAttribute('src') === 'blob:answer/test',
    )).toBe(true);
    expect(session.disposed).toBe(false);

    dom.window.dispatchEvent(new dom.window.Event('afterprint'));
    expect(session.disposed).toBe(true);
    expect(doc.getElementById(PRINT_ROOT_ID)).toBeNull();
    expect(doc.getElementById(PRINT_STYLE_ID)).toBeNull();
    expect(doc.body.innerHTML).toBe(bodyBefore);
    expect(doc.documentElement.className).toBe(htmlClassesBefore);
  });

  it('dispose 可重复调用且无副作用', () => {
    const { doc, model } = setup();
    const session = startPrintSession({
      doc, model, options: options({ mode: 'questions-only' }), noiseSelectors: [],
      print: () => {}, browserKind: 'firefox', fallbackCleanupMs: 10000,
    });
    expect(() => {
      session.dispose();
      session.dispose();
    }).not.toThrow();
    expect(doc.getElementById(PRINT_ROOT_ID)).toBeNull();
  });

  it('Firefox fallback timer 可清理未触发 afterprint 的会话', () => {
    vi.useFakeTimers();
    const { doc, model } = setup();
    const session = startPrintSession({
      doc, model, options: options({ mode: 'answers-only' }), noiseSelectors: [],
      print: () => {}, browserKind: 'firefox', fallbackCleanupMs: 250,
    });
    expect(session.disposed).toBe(false);
    vi.advanceTimersByTime(250);
    expect(session.disposed).toBe(true);
    expect(doc.getElementById(PRINT_ROOT_ID)).toBeNull();
  });
});

describe('print CSS', () => {
  it('包含实测裁切/溢出/分页防护规则与噪声选择器', () => {
    const css = buildPrintCss(options(), ['header.page-header', 'section.exam-analyze'], false);
    expect(css).toContain('@page');
    expect(css).toContain('size: A4 portrait');
    expect(css).toContain('break-inside: avoid');
    expect(css).toContain('overflow-wrap: anywhere');

    // 噪声选择器被合并成一条隐藏规则，这里断言语义而非格式
    const hideRule = css.slice(css.indexOf('header.page-header'));
    const hideRuleEnd = hideRule.indexOf('}');
    const hideList = hideRule.slice(0, hideRuleEnd);
    expect(hideList).toContain('header.page-header');
    expect(hideList).toContain('section.exam-analyze');
    expect(hideList).toContain('display: none !important');
  });

  it('打印时一并隐藏扩展自身注入的 UI（实测真 bug：面板会被印到纸上）', () => {
    const css = buildPrintCss(options(), ['section.exam-analyze'], false);
    const hideRule = css.slice(css.indexOf('section.exam-analyze'));
    const hideList = hideRule.slice(0, hideRule.indexOf('}'));
    expect(hideList).toContain('#better-zujuan-panel-host');
    expect(hideList).toContain('.bz-entry-btn');
  });

  it('使用 A3 横向选项时生成相应 @page', () => {
    const css = buildPrintCss(options({ paperSize: 'A3', orientation: 'landscape' }), [], false);
    expect(css).toContain('size: A3 landscape');
  });

  it('clone 模式 CSS 会在打印时隐藏原正文、显示 clone', () => {
    const css = buildPrintCss(options({ mode: 'answers-at-end' }), [], true);
    // 改用裸 main：组卷中心的 main 是 .page.group-exam-page，限定 exam-detail 会隐藏不掉
    expect(css).toContain(`html.${CLONE_MODE_CLASS} main { display: none !important; }`);
    expect(css).toContain(`html.${CLONE_MODE_CLASS} #${PRINT_ROOT_ID} { display: block !important; }`);
  });

  it('非 clone 模式不生成隐藏原正文的规则', () => {
    const css = buildPrintCss(options(), [], false);
    expect(css).not.toContain(`html.${CLONE_MODE_CLASS} main`);
  });
});

describe('打印样式不产生任何多余的线条（题目边界虚线）', () => {
  const css = () =>
    buildPrintCss(
      { ...DEFAULT_PRINT_OPTIONS },
      ['section.exam-analyze'],
      true,
      'article.exam-cnt',
    );

  it('题目分隔不再使用虚线边框', () => {
    const out = css();
    expect(out).not.toContain('dashed');
    expect(out).not.toMatch(/\.sec-list\s*\+\s*\.sec-list\s*\{[^}]*border/);
    expect(out).not.toMatch(/\.ques-item\s*\+\s*\.ques-item\s*\{[^}]*border/);
  });

  it('clone 模式的元信息与答案块也不带边框', () => {
    const out = css();
    expect(out).not.toMatch(/\.bz-print-meta\s*\{[^}]*border/);
    expect(out).not.toMatch(/\.bz-print-answer\s*\{[^}]*border/);
  });

  it('不存在任何会画出线条的 border 声明', () => {
    const out = css();
    // 只看**声明**（属性: 值;），不看注释文字
    const declarations = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('*') && !line.startsWith('/*'))
      .filter((line) => /^border(-[a-z]+)?\s*:/.test(line))
      // 允许：box-sizing 用的是 border-box，表格用 border-collapse，
      // 两者都不会画出可见线条
      .filter((line) => !/border-box/.test(line))
      .filter((line) => !/border-collapse/.test(line))
      // 允许「清除边框」的重置声明（这正是在去掉线条，而不是画线条）
      .filter((line) => !/^border:\s*(0|none)/i.test(line));
    expect(declarations).toEqual([]);
  });

  it('题目之间仍有留白（去掉线条不等于挤成一团）', () => {
    const out = css();
    expect(out).toMatch(/\.sec-list\s*\{\s*margin-bottom:\s*\d+px/);
    expect(out).toMatch(/\.ques-item\s*\{\s*margin-bottom:\s*\d+px/);
  });
});

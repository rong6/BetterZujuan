import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  GRAY_MASK_SELECTOR,
  grayMaskCss,
  hasGrayMask,
  needsGrayMaskFix,
  readEditStatus,
  restoreOpacityIn,
} from '@/core/gray-mask';

function docFrom(html: string): Document {
  return new JSDOM(html).window.document as unknown as Document;
}

describe('readEditStatus', () => {
  it('读取站点实际写入的 True', () => {
    expect(readEditStatus('a=1; editStatus=True; b=2')).toBe(true);
  });

  it('兼容小写与 1，避免站点改写法后判定失效', () => {
    expect(readEditStatus('editStatus=true')).toBe(true);
    expect(readEditStatus('editStatus=1')).toBe(true);
  });

  it('缺失或非真值一律视为 false', () => {
    expect(readEditStatus('')).toBe(false);
    expect(readEditStatus('editStatus=False')).toBe(false);
    expect(readEditStatus('editStatus=')).toBe(false);
    expect(readEditStatus('other=True')).toBe(false);
  });

  it('不会把名字里含 editStatus 的其它 cookie 误判', () => {
    expect(readEditStatus('not_editStatus=True')).toBe(false);
  });

  it('容忍 cookie 段周围的空白', () => {
    expect(readEditStatus(' a=1 ;  editStatus=True ;  b=2 ')).toBe(true);
  });
});

describe('hasGrayMask / needsGrayMaskFix', () => {
  it('页面上有 .selected-mask 时判定为需要修复', () => {
    const doc = docFrom('<div class="wrapper quesdiv selected-mask"></div>');
    expect(hasGrayMask(doc)).toBe(true);
    expect(needsGrayMaskFix(doc, '')).toBe(true);
  });

  it('没有蒙版元素但 cookie 为 True 时同样需要修复', () => {
    const doc = docFrom('<div></div>');
    expect(hasGrayMask(doc)).toBe(false);
    expect(needsGrayMaskFix(doc, 'editStatus=True')).toBe(true);
  });

  it('两者都不成立时不需要修复（不打扰正常页面）', () => {
    const doc = docFrom('<div></div>');
    expect(needsGrayMaskFix(doc, 'editStatus=False')).toBe(false);
  });

  it('doc 缺失时不抛异常', () => {
    expect(hasGrayMask(undefined)).toBe(false);
    expect(needsGrayMaskFix(undefined, undefined)).toBe(false);
  });
});

describe('restoreOpacityIn', () => {
  it('把 opacity 与 filter 就地还原为可见', () => {
    const doc = docFrom(
      '<div id="a" class="selected-mask" style="opacity:.5"></div>' +
        '<div id="b" class="selected-mask"></div>' +
        '<div id="c" class="selected-mask" style="opacity: 0.5; filter: grayscale(1)"></div>',
    );
    const count = restoreOpacityIn(doc.body);
    expect(count).toBe(3);
    for (const id of ['a', 'b', 'c']) {
      const el = doc.getElementById(id) as HTMLElement;
      expect(el.style.getPropertyValue('opacity')).toBe('1');
      expect(el.style.getPropertyValue('filter')).toBe('none');
    }
  });

  it('也处理根本身就是蒙版的情况', () => {
    const doc = docFrom('<div id="root" class="selected-mask" style="opacity:.4"></div>');
    const root = doc.getElementById('root') as HTMLElement;
    expect(restoreOpacityIn(root)).toBe(1);
    expect(root.style.getPropertyValue('opacity')).toBe('1');
  });

  it('没有蒙版时返回 0，不做任何改动', () => {
    const doc = docFrom('<div class="normal" style="opacity:.5"></div>');
    expect(restoreOpacityIn(doc.body)).toBe(0);
    expect((doc.querySelector('.normal') as HTMLElement).style.opacity).toBe('0.5');
  });
});

describe('grayMaskCss', () => {
  it('生成 !important 规则，能压过站点样式', () => {
    const css = grayMaskCss();
    expect(css).toContain(GRAY_MASK_SELECTOR);
    expect(css).toContain('opacity: 1 !important');
    expect(css).toContain('filter: none !important');
  });
});

describe('个人题库页的灰色蒙版（真实夹具）', () => {
  const fixture = readFileSync(
    fileURLToPath(new URL('../fixtures/usertk-paper.html', import.meta.url)),
    'utf8',
  );

  it('夹具里确实存在被压暗的蒙版（否则这条测试就失去意义）', () => {
    const doc = docFrom(fixture);
    // 夹具按实测给题目容器加了 selected-mask + opacity:.5
    expect(doc.querySelectorAll(GRAY_MASK_SELECTOR).length).toBeGreaterThan(0);
  });
});
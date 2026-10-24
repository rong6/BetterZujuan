import { describe, expect, it } from 'vitest';
import { escapeOf, escapeRiskyCharsInCode, isRiskyChar } from '@/shared/escape-risky-chars';

/**
 * 这组测试守的是一个「测试全绿却根本装不上」的真实故障：
 * 产物里出现裸写的控制字符/非字符时，Chrome 会以「不是 UTF-8 编码」为由
 * 拒绝加载内容脚本。详见 src/shared/escape-risky-chars.ts。
 */

/** 在独立作用域里执行代码并取回表达式的值，用于验证转义前后语义等价。 */
function run<T = unknown>(code: string, expression: string): T {
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\nreturn (${expression});`)() as T;
}

describe('isRiskyChar', () => {
  it('C0 控制字符要转义（来自 JSZip 的 ZIP 魔数常量）', () => {
    for (const cp of [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f]) {
      expect(isRiskyChar(cp)).toBe(true);
    }
  });

  it('制表/换行/回车是合法空白，不能转义', () => {
    for (const cp of [0x09, 0x0a, 0x0d]) expect(isRiskyChar(cp)).toBe(false);
  });

  it('DEL (0x7f) 要转义', () => {
    expect(isRiskyChar(0x7f)).toBe(true);
  });

  it('非字符要转义（来自 docx/html 的正则字面量，这是最隐蔽的一类）', () => {
    expect(isRiskyChar(0xfffe)).toBe(true);
    expect(isRiskyChar(0xffff)).toBe(true);
    expect(isRiskyChar(0xfdd0)).toBe(true);
    expect(isRiskyChar(0xfdef)).toBe(true);
    expect(isRiskyChar(0x1fffe)).toBe(true);
    expect(isRiskyChar(0x10ffff)).toBe(true);
  });

  it('正常字符（含中文、数学符号、emoji）不能转义', () => {
    for (const cp of [0x20, 0x41, 0x7a, 0x4e00, 0xfffd, 0x2200, 0x1f600, 0x10fffd]) {
      expect(isRiskyChar(cp), `U+${cp.toString(16)}`).toBe(false);
    }
  });
});

describe('escapeOf', () => {
  it('BMP 内用 \\uXXXX 表示', () => {
    expect(escapeOf(0x03)).toBe('\\u0003');
    expect(escapeOf(0xfffe)).toBe('\\ufffe');
    expect(escapeOf(0xffff)).toBe('\\uffff');
  });

  it('超出 BMP 的码点用代理对表示', () => {
    expect(escapeOf(0x1fffe)).toBe('\\ud83f\\udffe');
  });
});

describe('escapeRiskyCharsInCode', () => {
  it('转义裸写的控制字符，且不改变字符串语义', () => {
    // 真实控制字节，等价于 JSZip 里的 "PK\x03\x04"
    const risky = `var a = "PK\u0003\u0004";`;
    const { code: safe, changed } = escapeRiskyCharsInCode(risky);

    expect(changed).toBe(2);
    expect(safe).toBe('var a = "PK\\u0003\\u0004";');
    expect(run(safe, 'a')).toBe(run(risky, 'a'));
    expect(run(safe, 'a')).toBe('PK\u0003\u0004');
  });

  it('转义裸写的非字符，且不改变正则语义', () => {
    // 这一段刻意照抄 docx/html 里的真实正则形式（含控制符区间 + 两个非字符）
    const risky = `var re = /[\u0000-\u0008\ufffe\uffff]/g;`;
    const { code: safe, changed } = escapeRiskyCharsInCode(risky);

    // U+0000、U+0008、U+FFFE、U+FFFF 共 4 个（区间里的其它字符尚未展开）
    expect(changed).toBe(4);
    expect(safe).toContain('\\u0000');
    expect(safe).toContain('\\u0008');
    expect(safe).toContain('\\ufffe');
    expect(safe).toContain('\\uffff');

    // 语义等价：转义前后是同一个正则，对同样的输入给出同样结果
    for (const probe of ['\uffff', '\ufffe', 'a', '\u0000']) {
      expect(run<RegExp>(safe, 're').test(probe)).toBe(run<RegExp>(risky, 're').test(probe));
    }
  });

  it('保留 \\t \\n \\r，避免破坏代码结构', () => {
    const code = 'var a=1;\n\tvar b=2;\r\n';
    const { code: out, changed } = escapeRiskyCharsInCode(code);
    expect(changed).toBe(0);
    expect(out).toBe(code);
  });

  it('没有高风险字符时原样返回', () => {
    const code = 'const 标题 = "一、单选题"; // 公式 ∀x';
    const { code: out, changed } = escapeRiskyCharsInCode(code);
    expect(changed).toBe(0);
    expect(out).toBe(code);
  });

  it('不会拆坏代理对（emoji 应保持可解析）', () => {
    const code = `var s = "\u{1f600}图";`;
    const { code: out, changed } = escapeRiskyCharsInCode(code);
    expect(changed).toBe(0);
    expect(out).toBe(code);
    expect(run(code, 's')).toBe('\u{1f600}图');
  });

  it('多个高风险字符全部处理，计数准确', () => {
    const code = 'a\u0001b\u0002c\ufffed\uffffe';
    const { changed } = escapeRiskyCharsInCode(code);
    expect(changed).toBe(4);
  });

  it('结果不含任何裸写高风险字符，且再转义一次不再变化（幂等）', () => {
    const risky = 'x\u0001y\ufffez\u007f';
    const once = escapeRiskyCharsInCode(risky);
    const twice = escapeRiskyCharsInCode(once.code);

    expect(twice.changed).toBe(0);
    expect(twice.code).toBe(once.code);
    for (const ch of once.code) {
      expect(isRiskyChar(ch.codePointAt(0) as number)).toBe(false);
    }
  });

  it('转义后仍是可执行的合法 JS', () => {
    const risky = `function f(){ return "PK\u0003\u0004"; }`;
    const { code: safe } = escapeRiskyCharsInCode(risky);
    expect(run<string>(safe, 'f()')).toBe('PK\u0003\u0004');
  });
});

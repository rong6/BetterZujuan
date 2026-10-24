import { describe, expect, it } from 'vitest';
import { classifyAnswerImage, isUsableAnswerImage } from '@/answers/validate';

/**
 * 这些尺寸全部来自线上实测，不要凭空编造：
 *  - 真图：width=884 → 1768×220；width=1240 → 2400×220（image/jpeg，约 22–24KB）
 *  - 403 提示图：414×30 / 417×29（image/png，约 5.3–5.6KB），且不随 width 缩放
 */
describe('classifyAnswerImage', () => {
  it('把实测的真图尺寸判为 valid', () => {
    expect(classifyAnswerImage({ width: 1768, height: 220, mime: 'image/jpeg' }).kind).toBe('valid');
    expect(classifyAnswerImage({ width: 2400, height: 220, mime: 'image/jpeg' }).kind).toBe('valid');
  });

  it('把实测的 403 提示图判为 forbidden —— 这是最关键的一条', () => {
    // 服务端在无权限/URL 过期时返回 HTTP 200 + 这张小图，
    // 因此 img.complete / onload / naturalWidth>0 都会“成功”，必须靠尺寸识破。
    for (const [width, height] of [
      [414, 30],
      [417, 29],
    ] as const) {
      const verdict = classifyAnswerImage({ width, height, mime: 'image/png' });
      expect(verdict.kind).toBe('forbidden');
      if (verdict.kind === 'forbidden') {
        expect(verdict.reason).toContain('无权限提示图');
      }
    }
  });

  it('提示图的判定不受 width 参数影响（实测 884/1240/2480 都是 ~414×30）', () => {
    const atWidths = [414, 417, 414];
    for (const width of atWidths) {
      expect(classifyAnswerImage({ width, height: 30 }).kind).toBe('forbidden');
    }
  });

  it('把既非真图也非已知提示图的尺寸判为 suspicious，而不是当成成功', () => {
    // 介于两者之间：保守判失败，避免把未知占位图当答案导出
    expect(classifyAnswerImage({ width: 800, height: 100 }).kind).toBe('suspicious');
  });

  it('尺寸为 0（未加载/加载失败）判为 suspicious，而不是误报成权限问题', () => {
    const verdict = classifyAnswerImage({ width: 0, height: 0 });
    expect(verdict.kind).toBe('suspicious');
    if (verdict.kind === 'suspicious') {
      expect(verdict.reason).toContain('未加载');
    }
  });

  it('高度足够但宽度不足（窄条）不被当作真图', () => {
    expect(classifyAnswerImage({ width: 900, height: 400 }).kind).toBe('suspicious');
  });

  it('宽度足够但高度不足（横条）不被当作真图，也不误判成提示图', () => {
    // 2000×40 不是实测的 414×30 指纹，只是尺寸异常，应归为 suspicious
    expect(classifyAnswerImage({ width: 2000, height: 40 }).kind).toBe('suspicious');
  });

  it('isUsableAnswerImage 只在 valid 时为 true', () => {
    expect(isUsableAnswerImage({ width: 1768, height: 220 })).toBe(true);
    expect(isUsableAnswerImage({ width: 414, height: 30 })).toBe(false);
    expect(isUsableAnswerImage({ width: 0, height: 0 })).toBe(false);
  });
});

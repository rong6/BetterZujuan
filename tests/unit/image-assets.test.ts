import { describe, expect, it, vi } from 'vitest';
import { fullSizeImageUrl, collectImageDataUrls } from '@/export/image-assets';

describe('fullSizeImageUrl', () => {
  it('去掉实测确认的缩略参数 resizew/resizeh', () => {
    const bare = 'https://img.xkw.com/dksih/QBM/editorImg/2026/9/30/5bf40bce-5cb5-4207-965a-e54551dda087.png';
    // 实测：带参数只有 167×65，去掉后是 925×358 原图
    expect(fullSizeImageUrl(`${bare}?resizew=167`)).toBe(bare);
    expect(fullSizeImageUrl(`${bare}?resizeh=65`)).toBe(bare);
    expect(fullSizeImageUrl(`${bare}?resizew=167&resizeh=65`)).toBe(bare);
  });

  it('保留其它参数，避免误删站点可能需要的参数', () => {
    const url = 'https://img.xkw.com/a/b.png?resizew=167&v=2';
    expect(fullSizeImageUrl(url)).toContain('v=2');
    expect(fullSizeImageUrl(url)).not.toContain('resizew');
  });

  it('没有缩略参数时原样返回', () => {
    const url = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/abc123.png';
    expect(fullSizeImageUrl(url)).toBe(url);
  });

  it('无参数可去时不会留下多余的问号', () => {
    const url = 'https://img.xkw.com/a/b.png?resizew=100';
    expect(fullSizeImageUrl(url)).not.toMatch(/\?$/);
  });

  it('对非法 URL 原样返回，不抛异常', () => {
    expect(fullSizeImageUrl('not a url')).toBe('not a url');
    expect(fullSizeImageUrl('')).toBe('');
  });
});

describe('collectImageDataUrls', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('按原始 src 建键，值是可用的 data URL', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    const src = 'https://img.xkw.com/a/figure.png?resizew=167';
    const map = await collectImageDataUrls([src], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(map.has(src)).toBe(true);
    expect(map.get(src)).toMatch(/^data:image\/png;base64,/);
  });

  it('优先请求去掉缩略参数的原图', async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const src = 'https://img.xkw.com/a/figure.png?resizew=167';
    await collectImageDataUrls([src], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(requested[0]).toBe('https://img.xkw.com/a/figure.png');
  });

  it('原图请求失败时退回原始 URL，避免丢图', async () => {
    const requested: string[] = [];
    const bare = 'https://img.xkw.com/a/figure.png';
    const src = `${bare}?resizew=167`;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url === bare) return new Response('', { status: 404 });
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    const map = await collectImageDataUrls([src], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(requested).toEqual([bare, src]);
    expect(map.get(src)).toMatch(/^data:image\/png;base64,/);
  });

  it('skip 命中的 src 不发请求（公式已转 MathML 时不必再取位图）', async () => {
    const fetchImpl = vi.fn(async () => new Response(png, { status: 200 }));
    const covered = 'https://staticzujuan.xkw.com/quesimg/Upload/formula/aaa.png';
    const figure = 'https://img.xkw.com/a/figure.png';
    const map = await collectImageDataUrls([covered, figure], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      skip: (s) => s === covered,
    });

    expect(map.has(covered)).toBe(false);
    expect(map.has(figure)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('去重：同一 src 只请求一次', async () => {
    const fetchImpl = vi.fn(async () => new Response(png, { status: 200 }));
    const src = 'https://img.xkw.com/a/figure.png';
    await collectImageDataUrls([src, src, src, null, undefined], {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('单个图片彻底失败时不抛异常，也不写入结果（交由调用方告警）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    });
    const src = 'https://img.xkw.com/a/figure.png';
    const map = await collectImageDataUrls([src], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(map.size).toBe(0);
  });

  it('空输入不发请求', async () => {
    const fetchImpl = vi.fn();
    const map = await collectImageDataUrls([], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(map.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('空响应体视为失败，避免写入无效 data URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(0), { status: 200 }));
    const src = 'https://img.xkw.com/a/figure.png';
    const map = await collectImageDataUrls([src], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(map.size).toBe(0);
  });
});

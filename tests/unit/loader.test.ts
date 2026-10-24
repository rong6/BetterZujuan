import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { collectPaperDetail } from '@/adapters/paper-detail';
import { AnswerLoader, DEFAULT_ANSWER_CONCURRENCY, summarizeAnswerLoads } from '@/answers/loader';

const html = readFileSync(resolve(process.cwd(), 'tests/fixtures/paper-detail.html'), 'utf8');
const url = 'https://zujuan.xkw.com/11p3524937.html';
const fakeBytes = new Uint8Array([1, 2, 3, 4]);

function setup() {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document as unknown as Document;
  const collected = collectPaperDetail(doc);
  if (!collected.ok) throw new Error(collected.reason);
  return { dom, doc, model: collected.model };
}

interface FetchMockOptions {
  readonly firstFlags?: boolean[];
  readonly delayMs?: number;
  readonly onInFlight?: (n: number) => void;
}

/** 模拟站点接口；可统计同时在飞的请求数（用于验证并发）。 */
function fetchMock(options: FetchMockOptions = {}) {
  const firstFlags = options.firstFlags ?? [];
  let sigIndex = 0;
  let inFlight = 0;

  return vi.fn(async (input: string | URL | Request) => {
    const requestUrl = String(input);
    const isSignature = requestUrl.endsWith('/zujuan-api/check_ques_parse');

    inFlight += 1;
    options.onInFlight?.(inFlight);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    inFlight -= 1;

    if (isSignature) {
      const first = firstFlags[sigIndex] ?? false;
      sigIndex += 1;
      return new Response(JSON.stringify({ key: `synthetic-key-${sigIndex}`, first }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(fakeBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
}

function makeLoader(doc: Document, fetchImpl: unknown, extra: Record<string, unknown> = {}) {
  let n = 0;
  return new AnswerLoader({
    doc,
    fetchImpl: fetchImpl as typeof fetch,
    decodeDimensions: async () => ({ width: 2400, height: 220 }),
    createObjectURL: () => `blob:synthetic/${++n}`,
    ...extra,
  });
}

describe('AnswerLoader —— 并发获取', () => {
  it('一次加载整份试卷，并全部展开到页面', async () => {
    const { doc, model } = setup();
    const loader = makeLoader(doc, fetchMock());

    const records = await loader.load(model);

    expect(records).toHaveLength(4);
    expect(records.every((r) => r.status === 'loaded')).toBe(true);
    expect(doc.querySelectorAll('.item.answer img[src^="blob:"]')).toHaveLength(4);
    expect(
      Array.from(doc.querySelectorAll<HTMLElement>('.exam-item__opt')).every((e) => !e.hasAttribute('hidden')),
    ).toBe(true);
    expect(summarizeAnswerLoads(records)).toContain('已展开全部 4 道题');
  });

  it('确实是并发（同时在飞请求数 > 1），而不是一个一个来', async () => {
    const { doc, model } = setup();
    let peak = 0;
    const fetchImpl = fetchMock({
      delayMs: 25,
      onInFlight: (n) => {
        peak = Math.max(peak, n);
      },
    });

    await makeLoader(doc, fetchImpl).load(model);

    expect(peak).toBeGreaterThan(1);
  });

  it('并发数可配置；设为 1 时退化为顺序执行', async () => {
    const { doc, model } = setup();
    let peak = 0;
    const fetchImpl = fetchMock({
      delayMs: 15,
      onInFlight: (n) => {
        peak = Math.max(peak, n);
      },
    });

    await makeLoader(doc, fetchImpl, { concurrency: 1 }).load(model);

    expect(peak).toBe(1);
  });

  it('默认并发数为 12（站点自身也是一次性全量并发）', () => {
    expect(DEFAULT_ANSWER_CONCURRENCY).toBe(12);
  });

  it('返回顺序与试卷题目顺序一致（并发不乱序）', async () => {
    const { doc, model } = setup();
    const expected = model.sections.flatMap((s) => s.questions.map((q) => q.qid));

    const records = await makeLoader(doc, fetchMock({ delayMs: 8 })).load(model);

    expect(records.map((r) => r.question.qid)).toEqual(expected);
  });

  it('不设额度上限：服务端持续返回 first=true 也不会中途停下', async () => {
    const { doc, model } = setup();
    const fetchImpl = fetchMock({ firstFlags: [true, true, true, true] });

    const records = await makeLoader(doc, fetchImpl).load(model);

    expect(records).toHaveLength(4);
    expect(records.every((r) => r.status === 'loaded')).toBe(true);
  });

  it('进度回调会汇报完成度与总数', async () => {
    const { doc, model } = setup();
    const seen: string[] = [];

    await makeLoader(doc, fetchMock({ delayMs: 4 })).load(model, (p) => seen.push(`${p.completed}/${p.total}`));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe('0/4');
    expect(seen[seen.length - 1]).toBe('4/4');
  });
});

describe('AnswerLoader —— 图片校验与失败处理', () => {
  it('不把 403 提示图当成答案写回页面', async () => {
    const { doc, model } = setup();
    const createObjectURL = vi.fn(() => 'blob:should-not-exist');
    const loader = new AnswerLoader({
      doc,
      fetchImpl: fetchMock() as unknown as typeof fetch,
      decodeDimensions: async () => ({ width: 414, height: 30 }),
      createObjectURL,
    });

    const records = await loader.load(model);

    expect(records.every((r) => r.status === 'forbidden')).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(doc.querySelectorAll('.item.answer img[src^="blob:"]')).toHaveLength(0);
    expect(summarizeAnswerLoads(records)).toContain('无权限或链接已失效');
  });

  it('未登录时逐题报错，且不发起任何请求', async () => {
    const { doc, model } = setup();
    for (const img of Array.from(doc.querySelectorAll('.item.answer img'))) img.removeAttribute('src');
    Object.defineProperty(doc, 'cookie', { configurable: true, value: '' });
    const fetchImpl = vi.fn();

    const records = await new AnswerLoader({ doc, fetchImpl: fetchImpl as unknown as typeof fetch }).load(model);

    expect(records.every((r) => r.status === 'error')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('单题失败不影响其它题目', async () => {
    const { doc, model } = setup();
    let signatureCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const isSignature = String(input).endsWith('/zujuan-api/check_ques_parse');
      if (isSignature) {
        signatureCalls += 1;
        if (signatureCalls <= 2) throw new Error('offline');
        return new Response(JSON.stringify({ key: 'k', first: false }), { status: 200 });
      }
      return new Response(fakeBytes, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const records = await makeLoader(doc, fetchImpl).load(model);

    expect(records.some((r) => r.status === 'error')).toBe(true);
    expect(records.some((r) => r.status === 'loaded')).toBe(true);
  });
});

describe('AnswerLoader —— 缓存与资源释放', () => {
  it('第二次加载命中缓存，不再发请求，状态为 cached', async () => {
    const { doc, model } = setup();
    const fetchImpl = fetchMock();
    const loader = makeLoader(doc, fetchImpl);

    const first = await loader.load(model);
    const callsAfterFirst = fetchImpl.mock.calls.length;
    const second = await loader.load(model);

    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirst);
    expect(first).toHaveLength(4);
    expect(second.map((r) => r.status)).toEqual(['cached', 'cached', 'cached', 'cached']);
    expect(summarizeAnswerLoads(second)).toContain('已展开全部 4 道题');
  });

  it('能用原始答案地址反查到已验证的 blob（供导出复用）', async () => {
    const { doc, model } = setup();
    const original = doc.querySelector<HTMLImageElement>('.item.answer img')?.getAttribute('src') ?? '';
    expect(original).not.toBe('');

    const loader = makeLoader(doc, fetchMock());
    await loader.load(model);

    const mapped = loader.getImageUrlForSource(original);
    expect(mapped).toMatch(/^blob:synthetic\//);
    expect(loader.getImageUrlForSource(mapped as string)).toBe(mapped);
  });

  it('dispose 释放所有自有 blob 地址', async () => {
    const { doc, model } = setup();
    const revokeObjectURL = vi.fn();
    let n = 0;
    const loader = new AnswerLoader({
      doc,
      fetchImpl: fetchMock() as unknown as typeof fetch,
      decodeDimensions: async () => ({ width: 2400, height: 220 }),
      createObjectURL: () => `blob:owned/${++n}`,
      revokeObjectURL,
    });

    await loader.load(model);
    loader.dispose();

    expect(revokeObjectURL).toHaveBeenCalledTimes(4);
  });
});

describe('summarizeAnswerLoads', () => {
  const question = { qid: '1', bankId: '11', index: 1, node: null as never };

  it('全部成功时给出简洁结论', () => {
    expect(summarizeAnswerLoads([{ question, status: 'loaded' }])).toBe('已展开全部 1 道题的答案与解析。');
  });

  it('部分失败时按原因分类计数', () => {
    const text = summarizeAnswerLoads([
      { question, status: 'loaded' },
      { question, status: 'forbidden' },
      { question, status: 'error' },
    ]);
    expect(text).toContain('已展开 1/3 道题');
    expect(text).toContain('1 道无权限或链接已失效');
    expect(text).toContain('1 道请求失败');
  });

  it('空结果不谎报成功', () => {
    expect(summarizeAnswerLoads([])).toBe('已展开 0/0 道题。');
  });
});

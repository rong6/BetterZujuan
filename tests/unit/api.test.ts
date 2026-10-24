import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import {
  AnswerApiError,
  buildAnswerImageUrl,
  checkQuesParse,
  extractTokenFromAnswerUrl,
  extractUserToken,
  fetchAnswerImage,
  parseAnswerImageUrl,
  readCookieValue,
  readRequestVerificationToken,
} from '@/answers/api';
import {
  ANSWER_IMAGE_WIDTH,
  MIN_VALID_ANSWER_IMAGE_WIDTH,
} from '@/shared/constants';

/** Synthetic test token; never store a real account credential in tests. */
const TEST_TOKEN = 'synthetic-test-token-not-live';

describe('readCookieValue', () => {
  it('从 cookie 串中取值', () => {
    const cookie = `a=1; user_token=${TEST_TOKEN}; b=2`;
    expect(readCookieValue(cookie, 'user_token')).toBe(TEST_TOKEN);
  });

  it('处理首尾位置与缺失情况', () => {
    expect(readCookieValue(`user_token=${TEST_TOKEN}`, 'user_token')).toBe(TEST_TOKEN);
    expect(readCookieValue(`x=1; user_token=${TEST_TOKEN}`, 'user_token')).toBe(TEST_TOKEN);
    expect(readCookieValue('x=1', 'user_token')).toBeNull();
    expect(readCookieValue('', 'user_token')).toBeNull();
  });

  it('不会把名字相似的 cookie 误当成目标', () => {
    expect(readCookieValue('my_user_token=bad; user_token=good', 'user_token')).toBe('good');
    expect(readCookieValue('user_token_x=bad', 'user_token')).toBeNull();
  });
});

describe('extractTokenFromAnswerUrl', () => {
  it('从答案图片 URL 中回捞令牌', () => {
    const url = `https://imzujuan.xkw.com/getAnswerAndParse/35628232/11/abcdef?enVqdWFu=${TEST_TOKEN}&width=884`;
    expect(extractTokenFromAnswerUrl(url)).toBe(TEST_TOKEN);
  });

  it('无该参数时返回 null', () => {
    expect(extractTokenFromAnswerUrl('https://imzujuan.xkw.com/getAnswerAndParse/1/11/abc?width=884')).toBeNull();
  });
});

describe('buildAnswerImageUrl / parseAnswerImageUrl', () => {
  const params = { qid: '35628232', bankId: '11', key: 'db30fa92', token: TEST_TOKEN };

  it('按实测格式拼装 URL', () => {
    expect(buildAnswerImageUrl(params)).toBe(
      `https://imzujuan.xkw.com/getAnswerAndParse/35628232/11/db30fa92?enVqdWFu=${encodeURIComponent(TEST_TOKEN)}&width=${ANSWER_IMAGE_WIDTH}`,
    );
  });

  it('默认宽度为 884（返回 1768px）——两个显示场景都远小于它，取更小值以加快展开', () => {
    // 显示端实测：PDF 打印约 703px、DOCX 受 maxImageWidth 限制为 601px
    expect(ANSWER_IMAGE_WIDTH).toBe(884);
    expect(buildAnswerImageUrl(params)).toContain('&width=884');
    expect(ANSWER_IMAGE_WIDTH * 2).toBeGreaterThanOrEqual(1768);
  });

  it('可显式指定宽度', () => {
    expect(buildAnswerImageUrl({ ...params, width: 884 })).toContain('&width=884');
  });

  it('URL 可被解析回原始参数（往返一致）', () => {
    const parsed = parseAnswerImageUrl(buildAnswerImageUrl(params));
    expect(parsed).not.toBeNull();
    expect(parsed?.qid).toBe('35628232');
    expect(parsed?.bankId).toBe('11');
    expect(parsed?.key).toBe('db30fa92');
    expect(parsed?.token).toBe(TEST_TOKEN);
    expect(parsed?.width).toBe(ANSWER_IMAGE_WIDTH);
  });

  it('拒绝非答案图片的 URL', () => {
    expect(parseAnswerImageUrl('https://staticzujuan.xkw.com/quesimg/Upload/formula/abc.png')).toBeNull();
    expect(parseAnswerImageUrl('https://imzujuan.xkw.com/other/path')).toBeNull();
    expect(parseAnswerImageUrl('not a url')).toBeNull();
  });
});

describe('extractUserToken', () => {
  it('优先使用 cookie', () => {
    const doc = {
      querySelectorAll: () => [],
    } as unknown as Document;
    expect(extractUserToken({ cookieString: `user_token=${TEST_TOKEN}`, doc })).toBe(TEST_TOKEN);
  });

  it('cookie 不可读时回捞页面上的答案图片 URL', () => {
    const img = {
      getAttribute: (name: string) =>
        name === 'src'
          ? `https://imzujuan.xkw.com/getAnswerAndParse/1/11/k?enVqdWFu=${TEST_TOKEN}&width=884`
          : null,
    };
    const doc = {
      querySelectorAll: () => [img],
    } as unknown as Document;
    expect(extractUserToken({ cookieString: '', doc })).toBe(TEST_TOKEN);
  });

  it('两条路径都不可用时返回 null（不抛异常）', () => {
    const doc = { querySelectorAll: () => [] } as unknown as Document;
    expect(extractUserToken({ cookieString: '', doc })).toBeNull();
    expect(extractUserToken()).toBeNull();
  });
});

describe('checkQuesParse', () => {
  it('带上站点要求的防伪令牌与 X-Requested-With 请求头（缺了会被 401）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'abc123', first: false }), { status: 200 }),
    );
    await checkQuesParse(
      { qid: '35628232', bankId: '11' },
      { fetchImpl, verificationToken: 'CfDJ8SYNTHETIC-TOKEN' },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.RequestVerification).toBe('CfDJ8SYNTHETIC-TOKEN');
    expect(headers['x-requested-with']).toBe('XMLHttpRequest');
  });

  it('没有防伪令牌时不发该头（便于降级与诊断）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'k', first: false }), { status: 200 }),
    );
    await checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.RequestVerification).toBeUndefined();
    expect(headers['x-requested-with']).toBe('XMLHttpRequest');
  });

  it('401 时给出可操作的提示（而不是只报状态码）', async () => {
    const noToken = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl: noToken }),
    ).rejects.toThrow(/未取得页面防伪令牌/);

    const withToken = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl: withToken, verificationToken: 'x' }),
    ).rejects.toThrow(/防伪令牌可能已失效/);
  });

  it('按实测格式发起表单 POST 并解析 key/first', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'abc123', first: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await checkQuesParse({ qid: '35628232', bankId: '11' }, { fetchImpl });

    expect(result).toEqual({ key: 'abc123', first: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://zujuan.xkw.com/zujuan-api/check_ques_parse');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('quesId=35628232&bankId=11');
    // 同源接口需要携带登录态
    expect(init.credentials).toBe('include');
  });

  it('把 first=true 如实上报（配额护栏依赖它）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'k', first: true }), { status: 200 }),
    );
    await expect(checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl })).resolves.toEqual({
      key: 'k',
      first: true,
    });
  });

  it('缺少 key 时报错而不是静默返回空字符串', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ first: false }), { status: 200 }));
    await expect(checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl })).rejects.toBeInstanceOf(
      AnswerApiError,
    );
  });

  it('非 2xx 与非法 JSON 都报错', async () => {
    const bad = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl: bad })).rejects.toThrow(/HTTP 500/);

    const notJson = vi.fn(async () => new Response('<html>', { status: 200 }));
    await expect(checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl: notJson })).rejects.toThrow(
      /不是合法 JSON/,
    );
  });

  it('网络异常被包装成可读错误', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('offline');
    });
    await expect(checkQuesParse({ qid: '1', bankId: '11' }, { fetchImpl: throwing })).rejects.toThrow(
      /网络层/,
    );
  });
});

describe('fetchAnswerImage', () => {
  it('使用 omit + no-store（实测：带凭据会被 CORS 拒绝，缓存会污染失败图）', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async () =>
      new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
    const result = await fetchAnswerImage('https://imzujuan.xkw.com/x', { fetchImpl });

    expect(result.mime).toBe('image/jpeg');
    expect(result.byteLength).toBe(4);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
  });

  it('非 2xx 时报错', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    await expect(fetchAnswerImage('https://imzujuan.xkw.com/x', { fetchImpl })).rejects.toThrow(/HTTP 403/);
  });
});

describe('实测阈值常量', () => {
  it('可信阈值能区分真图与 414×30 提示图', () => {
    expect(MIN_VALID_ANSWER_IMAGE_WIDTH).toBeGreaterThan(417);
    expect(MIN_VALID_ANSWER_IMAGE_WIDTH).toBeLessThanOrEqual(1768);
  });
});

describe('readRequestVerificationToken', () => {
  it('从页面隐藏域读取防伪令牌（站点的真实来源）', () => {
    const doc = new JSDOM(
      '<html><body><input name="__RequestVerificationToken" value="CfDJ8TESTTOKEN"></body></html>',
    ).window.document as unknown as Document;
    expect(readRequestVerificationToken(doc)).toBe('CfDJ8TESTTOKEN');
  });

  it('去掉首尾空白；空值视为缺失', () => {
    const doc = new JSDOM(
      '<html><body><input name="__RequestVerificationToken" value="  tok  "></body></html>',
    ).window.document as unknown as Document;
    expect(readRequestVerificationToken(doc)).toBe('tok');

    const empty = new JSDOM(
      '<html><body><input name="__RequestVerificationToken" value=""></body></html>',
    ).window.document as unknown as Document;
    expect(readRequestVerificationToken(empty)).toBeNull();
  });

  it('页面上没有该隐藏域时返回 null，不抛异常', () => {
    const doc = new JSDOM('<html><body></body></html>').window.document as unknown as Document;
    expect(readRequestVerificationToken(doc)).toBeNull();
    expect(readRequestVerificationToken(undefined)).toBeNull();
  });
});

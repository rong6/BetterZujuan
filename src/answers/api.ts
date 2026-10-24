/**
 * 答案/解析资源获取。
 *
 * 机制完全来自实测（试卷详情页，已登录）：
 *
 *   1) 站点点「显示全部答案和解析」时，会对**每道题**调用一次同源接口：
 *        POST /zujuan-api/check_ques_parse
 *        body: quesId={qid}&bankId={bankId}
 *        resp: {"key":"<48位hex签名>","first":false}
 *
 *   2) 答案图片 URL 可直接由此拼装：
 *        https://imzujuan.xkw.com/getAnswerAndParse/{qid}/{bankId}/{key}?enVqdWFu={user_token}&width={w}
 *
 * 关键实测性质：
 *   - `enVqdWFu` 即 `user_token` cookie 的值（base64 的 {"userId":..,"user_token":..}），
 *     实测 `document.cookie` 可读；也可从已存在的答案 <img src> 中回捞，两条路径都可行。
 *   - `key` 内含时间戳，**有效期约 24–60 秒**（t+24s 仍为真图，数分钟后失效）。
 *     因此拿到 key 后必须立即请求，不能缓存 URL 留到导出时再用。
 *   - 该 URL **不是一次性**的：TTL 内可重复 fetch。
 *   - 请求**无需 cookie**：响应头 `access-control-allow-origin: *`，
 *     故页面上下文 `fetch(url, { credentials: 'omit' })` 即可拿到真图。
 *     （带凭据反而会被 CORS 拒绝：实测 `credentials: 'include'` → Failed to fetch。）
 *   - 失效时返回 HTTP 200 + 414×30 提示图，必须用 `classifyAnswerImage` 校验。
 */

import {
  ANSWER_IMAGE_ORIGIN,
  ANSWER_IMAGE_PATH_PREFIX,
  ANSWER_IMAGE_WIDTH,
  ANSWER_TOKEN_QUERY,
  CHECK_QUES_PARSE_PATH,
  USER_TOKEN_COOKIE,
  ZJUAN_ORIGIN,
} from '../shared/constants';

export interface AnswerQuestionRef {
  readonly qid: string;
  readonly bankId: string;
}

export interface CheckQuesParseResult {
  /** 服务端签发的答案图签名 */
  readonly key: string;
  /**
   * 是否为「首次获取」。
   * 实测语义：`true` 表示消耗免费额度，`false` 表示重复获取（不计额度）。
   * 用于配额护栏，绝不用于判断成功/失败。
   */
  readonly first: boolean;
}

export interface BuildAnswerUrlParams extends AnswerQuestionRef {
  readonly key: string;
  readonly token: string;
  /** 默认 `ANSWER_IMAGE_WIDTH`（1240 → 服务端返回 2400px 宽真图） */
  readonly width?: number | undefined;
}

/** 从 cookie 串中读取某个 cookie 的值。 */
export function readCookieValue(cookieString: string, name: string): string | null {
  if (!cookieString) return null;
  const pattern = new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`);
  const match = cookieString.match(pattern);
  return match?.[1] ?? null;
}

/**
 * 从答案图片 URL 中回捞 `enVqdWFu`（即 user_token）。
 * 用于 cookie 不可读时的兜底。
 */
export function extractTokenFromAnswerUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get(ANSWER_TOKEN_QUERY);
  } catch {
    const match = url.match(new RegExp(`[?&]${ANSWER_TOKEN_QUERY}=([^&]+)`));
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

export interface ExtractUserTokenOptions {
  /** `document.cookie` 的内容 */
  readonly cookieString?: string | undefined;
  /** 页面文档，用于从已存在的答案图片中回捞令牌 */
  readonly doc?: Document | undefined;
}

/**
 * 取得用户会话令牌，按可靠性排序：
 *   1) `user_token` cookie（实测可读，最直接）
 *   2) 页面上已有答案图片 URL 里的 `enVqdWFu`
 */
export function extractUserToken(options: ExtractUserTokenOptions = {}): string | null {
  const fromCookie = options.cookieString
    ? readCookieValue(options.cookieString, USER_TOKEN_COOKIE)
    : null;
  if (fromCookie) return fromCookie;

  const doc = options.doc;
  if (doc) {
    for (const img of Array.from(doc.querySelectorAll('.item.answer img, .item.answer img[src]'))) {
      const src = img.getAttribute('src');
      if (!src) continue;
      const token = extractTokenFromAnswerUrl(src);
      if (token) return token;
    }
  }
  return null;
}

/** 拼装答案图片 URL。 */
export function buildAnswerImageUrl(params: BuildAnswerUrlParams): string {
  const width = params.width ?? ANSWER_IMAGE_WIDTH;
  const path = `${ANSWER_IMAGE_PATH_PREFIX}/${encodeURIComponent(params.qid)}/${encodeURIComponent(
    params.bankId,
  )}/${encodeURIComponent(params.key)}`;
  const query = `${ANSWER_TOKEN_QUERY}=${encodeURIComponent(params.token)}&width=${width}`;
  return `${ANSWER_IMAGE_ORIGIN}${path}?${query}`;
}

export interface ParsedAnswerImageUrl extends AnswerQuestionRef {
  readonly key: string;
  readonly token: string | null;
  readonly width: number | null;
}

/** 解析答案图片 URL（测试与诊断用）。 */
export function parseAnswerImageUrl(url: string): ParsedAnswerImageUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== ANSWER_IMAGE_ORIGIN) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  // 期望：["getAnswerAndParse", qid, bankId, key]
  if (segments.length !== 4 || `/${segments[0]}` !== ANSWER_IMAGE_PATH_PREFIX) return null;
  const [, qid, bankId, key] = segments as [string, string, string, string];
  const rawWidth = parsed.searchParams.get('width');
  return {
    qid,
    bankId,
    key,
    token: parsed.searchParams.get(ANSWER_TOKEN_QUERY),
    width: rawWidth && /^\d+$/.test(rawWidth) ? Number(rawWidth) : null,
  };
}

export class AnswerApiError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AnswerApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 读取页面上的防伪令牌。
 *
 * 实测（这是必须发的一个头，缺了会 401）：
 * 站点每个 AJAX 请求都会带上 `RequestVerification` 头，取值来自页面上的隐藏域：
 *
 *   <input name="__RequestVerificationToken" value="CfDJ8…（此处为会话相关的长令牌，已省略）">
 *
 * 配套脚本原文：
 *   var pageToken = $('[name=__RequestVerificationToken]').val();
 *   tklib.request.tokenKey = 'RequestVerification';
 *   tklib.request.token = pageToken;
 *
 * 早期版本漏发了这个头，接口会返回 **HTTP 401 且响应体为空**，
 * 表现为「答案全部加载失败」但页面看起来仍是登录状态 —— 很难从现象反推。
 */
export function readRequestVerificationToken(doc: Document | undefined): string | null {
  if (!doc) return null;
  const input = doc.querySelector<HTMLInputElement>('input[name="__RequestVerificationToken"]');
  const value = input?.value?.trim();
  return value && value.length > 0 ? value : null;
}

export interface CheckQuesParseOptions {
  readonly fetchImpl?: FetchLike | undefined;
  readonly signal?: AbortSignal | undefined;
  /** 页面防伪令牌；由 `readRequestVerificationToken` 读出后传入 */
  readonly verificationToken?: string | null | undefined;
}

/**
 * 请求答案签名。
 *
 * 与站点点开关时调用的是同一个接口；同源请求，浏览器自动携带 cookie。
 * 请求头刻意与站点自身保持一致（含 `RequestVerification` 与 `X-Requested-With`）。
 */
export async function checkQuesParse(
  ref: AnswerQuestionRef,
  options: CheckQuesParseOptions = {},
): Promise<CheckQuesParseResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${ZJUAN_ORIGIN}${CHECK_QUES_PARSE_PATH}`;
  const body = new URLSearchParams({ quesId: ref.qid, bankId: ref.bankId }).toString();
  const token = options.verificationToken ?? null;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
        ...(token ? { RequestVerification: token } : {}),
      },
      body,
      credentials: 'include',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new AnswerApiError(`请求答案签名失败（网络层）：${String(error)}`, error);
  }

  if (response.status === 401) {
    throw new AnswerApiError(
      token
        ? '请求答案签名失败：HTTP 401。页面防伪令牌可能已失效，请刷新页面后重试。'
        : '请求答案签名失败：HTTP 401。未取得页面防伪令牌（__RequestVerificationToken），请刷新页面后重试。',
    );
  }

  if (!response.ok) {
    throw new AnswerApiError(`请求答案签名失败：HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new AnswerApiError('答案签名接口返回的不是合法 JSON', error);
  }

  const key = (payload as { key?: unknown } | null)?.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new AnswerApiError('答案签名接口未返回 key，可能是未登录或无权限');
  }
  return { key, first: (payload as { first?: unknown }).first === true };
}

export interface FetchAnswerImageResult {
  readonly bytes: ArrayBuffer;
  readonly mime: string;
  readonly byteLength: number;
}

/**
 * 抓取答案图片字节。
 *
 * 默认 `credentials: 'omit'` —— 实测该接口 CORS 为 `*`，无需 cookie 且带凭据会被拒绝。
 * 默认 `cache: 'no-store'` —— 避免已经缓存下来的失败/提示图污染结果。
 */
export async function fetchAnswerImage(
  url: string,
  options: CheckQuesParseOptions = {},
): Promise<FetchAnswerImageResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new AnswerApiError(`抓取答案图片失败（网络层）：${String(error)}`, error);
  }

  if (!response.ok) {
    throw new AnswerApiError(`抓取答案图片失败：HTTP ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  return {
    bytes,
    mime: response.headers.get('content-type') ?? '',
    byteLength: bytes.byteLength,
  };
}

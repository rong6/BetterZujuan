/**
 * 站点相关的固定常量与实测指纹。
 *
 * 这里的每个数字/字符串都来自对线上页面的实测，不要凭直觉修改；
 * 若站点改版，请先复测再更新本文件，并在 `Evidence` 注释中记录新的观测结果。
 */

/** 试卷详情页所属源（页面本体 + check_ques_parse 接口） */
export const ZJUAN_ORIGIN = 'https://zujuan.xkw.com';

/** 答案/解析图片所在源 */
export const ANSWER_IMAGE_ORIGIN = 'https://imzujuan.xkw.com';

/** 公式 png/mml/svg 所在源（阿里云 OSS，`cache-control: max-age=86400`，无 Referer 校验） */
export const FORMULA_ORIGIN = 'https://staticzujuan.xkw.com';

/** 取答案签名的接口（站点点开关时调用的同一个接口，同源） */
export const CHECK_QUES_PARSE_PATH = '/zujuan-api/check_ques_parse';

/** 答案图片路径前缀 */
export const ANSWER_IMAGE_PATH_PREFIX = '/getAnswerAndParse';

/**
 * 请求答案图片时使用的 `width` 参数。
 *
 * Evidence: `width=884` → 1768px 宽；`width=1240` 及以上 → 2400px 宽（服务端封顶）。
 *
 * 取值 884（1768px）而不是 2400px，理由是**两个实际显示场景都远小于 1768px**：
 *   - PDF 打印：A4 + 12mm 页边距 → 正文宽约 703px
 *   - DOCX：受 docx 的 `maxImageWidth` 限制 → 601px
 * 即 1768px 已有 2.5 倍以上余量；而 2400px 会让下载体积约翻倍，
 * 直接拖慢「一键展开」的等待时间（实测是整条链路的主要瓶颈）。
 * 这是清晰度与等待时间之间的取舍：显示端用不到多出来的像素。
 */
export const ANSWER_IMAGE_WIDTH = 884;

/** 答案图片 URL 的有效期（秒）。仅用于 UI 提示与超时兜底，不作为严格判据。 */
export const ANSWER_URL_TTL_HINT_SECONDS = 45;

/**
 * 判定「答案图片有效」的最小尺寸。
 *
 * Evidence: 真图在 `width=884` 时为 1768×220，`width=1240` 时为 2400×220；
 * 而失效/无权限时服务端返回 414×30 / 417×29 的提示图，且**不随 width 缩放**
 * （实测 width=884/1240/2480 均返回约 414×30）。因此宽度阈值 1000 可以干净地区分两者。
 */
export const MIN_VALID_ANSWER_IMAGE_WIDTH = 1000;
export const MIN_VALID_ANSWER_IMAGE_HEIGHT = 60;

/**
 * 「(403) 您没有权限查看组卷网答案解析」提示图的实测指纹。
 *
 * Evidence: HTTP **200**，`content-type: image/png`，约 5.3–5.6KB，尺寸 414×30 / 417×29。
 * 这是「不能只依赖 img.complete」的根因 —— onload 会正常触发。
 */
export const FORBIDDEN_NOTICE_MAX_WIDTH = 600;
export const FORBIDDEN_NOTICE_MAX_HEIGHT = 40;

/** 真图为 JPEG；提示图为 PNG。作为尺寸判定的二次确认。 */
export const EXPECTED_ANSWER_MIME_PREFIX = 'image/jpeg';

/**
 * 公式图片路径形如 `/quesimg/Upload/formula/{hash}.{png|svg|mml}`。
 * 注意：仅凭路径不足以判定是公式，还必须同时校验域名
 * （见 `formulaHashFromSrc`），否则会误伤其它站点的同形路径。
 */
export const FORMULA_PATH_PATTERN = /^\/quesimg\/Upload\/formula\/([0-9a-f]+)\.(?:png|svg|mml)$/i;

/** 公式图片路径前缀 */
export const FORMULA_PATH_PREFIX = '/quesimg/Upload/formula/';

/**
 * 同一 hash 的 MathML 资源模板（实测 HTTP 200，内容为 base64 的 UTF-8 MathML）。
 * 这是 DOCX 里能把公式转成可编辑 OMML 而非位图的关键。
 */
export const FORMULA_MML_PATH_TEMPLATE = `${FORMULA_PATH_PREFIX}{hash}.mml`;

/** 同一 hash 的矢量图资源模板（保留给后续提高打印清晰度时使用）。 */
export const FORMULA_SVG_PATH_TEMPLATE = `${FORMULA_PATH_PREFIX}{hash}.svg`;

/** 页面类型：试卷详情页 `/{bankId}p{paperId}.html` */
export const PAPER_DETAIL_URL_PATTERN = /^https:\/\/zujuan\.xkw\.com\/\d+p\d+\.html/i;

/** 用户会话令牌 cookie 名（base64 的 `{"userId":..,"user_token":..}`，实测可被 document.cookie 读取） */
export const USER_TOKEN_COOKIE = 'user_token';

/** 答案图片 URL 上承载同一令牌的查询参数名（其值即 user_token cookie 的值） */
export const ANSWER_TOKEN_QUERY = 'enVqdWFu';

/** 题目插图所在源（实测：非公式图片走这里，与公式 CDN 不同） */
export const CONTENT_IMAGE_ORIGIN = 'https://img.xkw.com';

/**
 * 图片 URL 上的缩略参数；导出时去掉它们以取原图。
 *
 * Evidence: `?resizew=167` → 167×65（2,198B）；去掉后 → 925×358（28,415B）。
 * 只列出已确认的参数，避免误删站点可能需要的其它参数。
 */
export const FULLSIZE_STRIPPABLE_PARAMS: readonly string[] = ['resizew', 'resizeh'];

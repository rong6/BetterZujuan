# 技术说明

这份文档记录 **怎么实现的**、**为什么这么实现**，以及**站点上踩到的坑**。

面向想读代码或想改代码的人。日常使用看 [README](../README.md) 就够了。

---

## 目录

- [设计原则](#设计原则)
- [架构](#架构)
- [三种页面的结构差异](#三种页面的结构差异)
- [两条导出路径为什么要共用模型](#两条导出路径为什么要共用模型)
- [站点实测发现](#站点实测发现)
- [质量保障](#质量保障)
- [构建与发布](#构建与发布)

---

## 设计原则

### 1. 原页面只读

**所有净化都作用在「离屏 clone」或「打印样式」上，绝不对原始 DOM 做删除。**

大部分同类用户脚本的做法是清空 `body` 再刷新页面。问题是：

- 会破坏站点的页面状态（滚动位置、展开状态、编辑器状态）
- 答案图 URL 带短时签名，重新请求会拿到一张「无权限」的提示图
- 用户可能正在编辑，刷新等于丢掉他的操作

本项目的做法是：要么只注入 `@media print` 生效的 CSS，要么把节点克隆到离屏容器里再处理。

### 2. 未识别页面绝不注入

页面适配器用 **URL + DOM 双重判定**。两者都命中才注入 UI；否则静默退出，一行 DOM 都不碰。

宁可在这个页面上「不出现」，也不要在陌生结构上乱改。

### 3. 静默失败是不可接受的

导出的文档最怕「看起来成功、实际少了东西」。因此：

- 图片拿不到字节 → 带题号告警，并说明已从文档中移除
- 答案没加载 / 校验没过 → 明确写出是哪几道题
- 颗粒度到题号，而不是「部分内容缺失」

---

## 架构

```
src/
├── adapters/           页面适配器：URL + DOM 双判定，只读采集
│   ├── selectors.ts       全站选择器的唯一来源（含命中诊断）
│   ├── paper-detail.ts    试卷详情页适配器
│   ├── usertk-paper.ts    个人题库试卷适配器
│   └── zujuan-center.ts   组卷中心适配器
├── answers/            答案获取
│   ├── api.ts             签名接口、答案图 URL、防伪令牌
│   ├── validate.ts        图片有效性判定（识别 403 提示图）
│   └── loader.ts          并发加载 + 内存缓存 + 数据固化
├── core/
│   ├── purify.ts          页面净化（只在 clone 上删除节点）
│   └── gray-mask.ts       灰色蒙版还原（含祖先级判定）
├── export/
│   ├── document-model.ts  PDF 与 DOCX 共用的「内容 + 版面事实」
│   ├── pdf.ts             打印会话（原 DOM 优先，必要时离屏 clone）
│   ├── print-css.ts       打印样式生成
│   ├── docx.ts            DOCX 生成（OMML 公式 + 图片内联 + 告警）
│   ├── formula-mathml.ts  公式 MathML 获取
│   ├── image-assets.ts    内容图片收集（含原图 URL 推导）
│   └── data-url.ts        Blob → data URL（不依赖 FileReader）
├── ui/
│   ├── panel.ts           Shadow DOM 面板
│   └── icon.ts            内联图标（避免 web_accessible_resources）
└── shared/             常量、文本与字符转义工具
```

分层约束：`adapters` 不知道 `export` 的存在，`export` 只依赖 `adapters/types.ts` 里的数据契约。共享的小工具（如文本规范化）放在 `shared/`，避免适配器反向依赖导出层。

选择器**不允许散落在各处**。所有选择器集中在 `adapters/selectors.ts`，每个键带一组候选，按顺序尝试，并记录「实际命中了哪一个」，供诊断面板展示。

---

## 三种页面的结构差异

同一份试卷，三种页面的 DOM 完全不同，因此各有一个适配器。

| | 试卷详情页 | 个人题库 | 组卷中心 |
| --- | --- | --- | --- |
| 根容器 | `article.exam-cnt` | `article.exam-cnt` | `article.paper-cnt` |
| 题型容器 | `section.exam-list > .sec-item`，**只有 1 个** | **每个题型 1 个** `.sec-item` | `.paper-body .ques-type` |
| 题型标题 | `h4.sec-title` | `h4.sec-title` | `.questypetitle` |
| 题目外层 | `.sec-list` | `.sec-list` | `.ques-item` |
| 标题 | `.exam-title .title-txt span.txt` | `.exam-title .title-txt` | `#pui_maintitle` |
| 操作栏 | `aside.other-info` | `aside.other-info` | `aside.tools` / `.global-ctrl` |

两个直接后果：

1. **详情页那套「在单一容器内按标题有序切分」的算法不能复用到个人题库页** —— 那里有 3 个 `.sec-item`，只取第一个会漏掉 2/3 的题（实测 15 题只采到 8 题）。
2. **组卷中心必须独立适配器**，且题型选择器要限定在 `.paper-body` 内 —— 页面底部还有一块用于拖拽排序的 `.group-ctrl` 模板区，同样含 `.ques-list`。

因此 `PaperModel` 里带一个 `rootSelector`，由适配器给出自己的根容器选择器，导出层不硬编码 `article.exam-cnt`。

---

## 两条导出路径为什么要共用模型

早期实现的教训：

- **PDF** 打印的是原始 DOM，站点 CSS 全部生效（配图 167px、选项表格无边框）
- **DOCX** 是把 clone 交给 docx 的 HTML 转换器**重新渲染**，站点 CSS 全部失效（配图按原图 925px、表格套上默认边框）

同一份试卷于是出现「PDF 正常、DOCX 走样」。

解决办法不是给 DOCX 逐条打补丁，而是**先把版面事实量出来**（`document-model.ts`）：

- 图片在页面上的**实际显示尺寸** → 写进 `width`/`height` 属性
- 选项表格是否有边框 → 转成显式的无边框声明
- 元信息文本 → 规范化成单行
- 答案图内正文的字号 → 折算成知识点字号

然后让两条路径基于同一份事实渲染。

需要说明：PDF 与 DOCX 终究是两套渲染引擎（CSS 打印 vs OOXML），字体、行距无法逐像素一致。共用的是**内容模型与版面决策**，不是渲染器本身。

---

## 站点实测发现

以下每一条都在真实站点上验证过，并配有回归测试或产物自检。记录下来是因为它们都属于**静默失败**类问题 —— 现象与原因往往对不上。

### 构建与加载

| 发现 | 影响 |
| --- | --- |
| **产物含裸控制字符/非字符时，Chrome 会以「不是 UTF-8 编码」为由拒绝加载内容脚本。** 打包器会把依赖里的 `\uXXXX` 还原成真实字符：JSZip 的 `"PK\x03\x04"`（控制字符）、`docx/html` 的 `/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g`（**非字符**）。 | 曾导致扩展**完全装不上**。产物字节其实是合法 UTF-8，`tsc`、`vitest`、`wxt build` 三者全都发现不了。现由构建插件转义，并由 `scripts/verify-build.mjs` 与单测双重把守。 |
| WXT 把内容脚本打成 IIFE，`import()` 会被内联。 | 动态导入**无法**为约 800KB 的 `docx` 依赖做代码分割（已实测确认）。 |
| 模板字符串里拼 CSS 时，注释中若出现反引号会**提前终止模板**。 | esbuild 报的是 `Expected ";" but found ...`，与真实原因毫不相干。这个坑踩过三次，现由 `scripts/lint-template-backticks.mjs` 拦截。 |

### 站点结构与接口

| 发现 | 影响 |
| --- | --- |
| **`check_ques_parse` 接口要求 `RequestVerification` 请求头**，取值来自页面隐藏域 `input[name="__RequestVerificationToken"]`（站点脚本原文：`tklib.request.tokenKey = 'RequestVerification'`）。 | 缺这个头会返回 **HTTP 401 且响应体为空**，表现为「答案全部加载失败」，但页面看起来仍是登录状态，极难从现象反推。 |
| `section.exam-list` 下**只有一个** `.sec-item`，题型靠重复出现的 `h4.sec-title` 切分；而「试卷分析」区块（`section.exam-analyze`）里另有 3 个同名 `.sec-item`。 | 裸写 `.sec-item` 会把试卷分析当成题型分区混进来。分组必须是有序遍历。 |
| 每个 `h4.sec-title` 内部还嵌着「添加题型下试题」按钮。 | 取整个标题的 `textContent` 会得到「一、单选题 添加题型下试题」，必须取第一个 `span`。 |
| 一整份试卷上 `questionindex` **全是 0**。 | 题号只能取文档顺序，不能信这个属性。 |
| 答案 URL 失效或无权限时，服务端返回 **HTTP 200 + 414×30 的 PNG 提示图**。 | `img.complete` 与 `naturalWidth > 0` 都会「成功」。只能靠解码尺寸区分真图（≥1768px 宽的 JPEG）。 |
| 答案图 URL 带短时签名，几分钟内失效。 | 打印/导出的副本绝不能重新请求，否则会把 403 提示图印进试卷。 |
| **个人题库页每个题型各有一个 `.sec-item`**，而试卷详情页整卷只有 **1 个**。 | 详情页的切分算法在这里只拿到第一个题型。必须按 `.sec-item` 逐个收集。 |
| **组卷中心的骨架与详情页毫无共同点**，且底部有拖拽排序模板区（`.group-ctrl`，同样含 `.ques-list`）。 | 必须独立适配器，题型选择器限定在 `.paper-body` 内。 |
| **组卷中心的内容是前端异步渲染的**：首屏发空壳（`.empty-box.group-exam-empty`），题目随后由 JS 注入。`document_idle` 时经常还没渲染出来。 | 表现为「首次打开报采集失败，点一下『重新采集』就好了」。现首次采集为空时会等待内容出现（MutationObserver + 轮询，20 秒封顶）并自动刷新面板，实测 400ms 内恢复。 |
| 组卷题目的选择器若写成 `.paper-body .ques-type .tk-quest-item`，就把「题目必须嵌在题型之下」当成了前提。 | 站点一旦调整嵌套层级就会静默漏采。候选改为**从宽到窄**排列。 |
| 组卷中心的 `.btn-box` 是 `flex-wrap` 网格，每行恰好 2 个 115×28 的单元格。 | 往里面追加按钮只能另起一行，且与相邻单元格高矮不一（实测错位 79px）。改为**独立的悬浮启动器**，不参与站点任何布局。 |
| **灰色蒙版的载体是 `.wrapper.quesdiv`，而它正是题干与答案的父节点。** 克隆的却是内层节点，因此蒙版元素根本不在克隆结果里。 | 只在克隆结果内部找 `.selected-mask` 会一个都找不到、导出依旧发灰。必须沿**祖先链**检查并修正。另外 `opacity` 不继承（子节点 computed 值仍是 1）但作用于整个渲染子树，所以「看 computed 值」也会误判为正常。 |

### 导出质量

| 发现 | 影响 |
| --- | --- |
| 每个公式 `<img>` 在 CDN 上都有同 hash 的 `.mml`（base64 的 UTF-8 MathML）。 | 这是 DOCX 里公式**可编辑**的前提。实测 132 个公式 → 132 个 OMML 对象。 |
| 题图**不在**公式 CDN 上，而在 `img.xkw.com`。 | 只收集公式 CDN 会让题图从 DOCX 中消失。 |
| 站点用**缩略参数**控制配图显示尺寸：`?resizew=167` 为 167×65，去掉后才是 925×358 原图。 | 直接用原图尺寸排版会让配图比页面大 5.5 倍。正确做法是**原图取像素、按页面显示尺寸排版**。 |
| 站点选项表格本身**无边框**（computed border 为 `0px none`）。 | docx 的 HTML 转换器在 HTML 未声明边框时会套上默认单线边框，需显式声明无边框。 |
| 元信息文本里夹杂大量换行与缩进，形如 `"整体难度：\n   \n   适中"`。 | 不规范化成单行会把标题行拆得七零八落。 |
| `docx/html` 的 `htmlToContent` **不下载任何图片**，没有提供字节的 `<img>` 会被丢弃。 | 公式与答案图会从 DOCX 中消失。必须显式提供图片字节。 |
| docx 的 `maxImageWidth` 默认 601px（即 Word 正文宽度）。 | 比正文宽的图片会被收窄到页宽 —— 这是期望行为；比页宽小的图（如题图）则保持页面尺寸。 |
| 扩展自身面板是 `position: fixed`。 | 实机打印时**面板自己会被印到纸上**（打印规则原本只隐藏了站点噪声）。现由 `EXTENSION_UI_SELECTORS` 显式隐藏。 |
| **给容器加 `break-inside: avoid` 会造成整页空白。** `.sec-item` 是整卷题目的容器（实测高 2470px ≈ 2.2 页），引擎无法把它塞进一页，就整体推到下一页。 | 「原样」模式下第一页一大片空白正是此因。防断页只能用在「通常小于一页」的块上。 |
| 答案图片被压到正文宽后，图内文字也随之变小；知识点若沿用 Word 默认字号会明显偏大。 | 实测答案图内正文墨高约为图宽的 1.5%，按此折算文档中答案文字约 8pt（DOCX）/ 9.3pt（打印），知识点据此设置字号。 |
| **题目边界的虚线有两处来源**：一处是自加的分隔线；另一处是**站点自带的** —— 答案区 `.exam-item__opt` 上有 `border-top: 1px dashed #dcdcdc`，题目容器 `.tk-quest-item` 也带边框。 | 展开答案后每道题的答案上方都多出一条虚线，印在纸上很像「裁剪线」。两处都在打印样式里清掉了。 |
| 知识点里的「解读」按钮是 `a.knowledge-explain.btn_KnowledgeUnscramble`，`href` 为 `javascript:void 0`。 | 它是纯交互入口，导出后紧跟在知识点名称后面读成「…及运算解读」，还会触发 docx 的 unsafe-link 告警。按类名删除（不能按文字匹配，否则会误伤名称里含「解读」的知识点）。 |
| **「原样」模式走的是零 DOM 变更路径，直接打印原页面，根本不经过 clone** —— 于是所有基于 clone 的清理（删噪声、删解读按钮）全部不执行。 | 实测「原样」下 44 个解读按钮全都印了出来。**打印样式才是唯一对两条路径都生效的位置**，因此这类清理必须同时写在 CSS 里，不能只靠 purify 删除。 |
| **`collect` 只在注入时算一次，里面存的是对当时 DOM 节点（`QuestionRef.node`）的引用。** | 用户展开答案或页面重渲染后，这些引用可能已指向被替换掉的旧节点 —— 表现为「页面明明变了，打印出来还是旧的」。现在每次打印/导出前都重新采集。 |

---

## 质量保障

`pnpm run check` 是一条完整流水线，缺一不可：

```bash
node scripts/lint-template-backticks.mjs   # 注释反引号自检
tsc --noEmit                               # 类型
vitest run                                 # 单元测试
wxt build                                  # 构建
node scripts/verify-build.mjs              # 产物自检
```

### 产物自检（`scripts/verify-build.mjs`）

不是形式主义。曾经出现过「单测全绿、类型干净、构建成功，但扩展根本装不上」的事故 —— 原因是产物里含裸写的控制字符与非字符，Chrome 拒绝加载内容脚本。

该脚本在构建后立刻检查严格 UTF-8 有效性与高风险字符，把这类问题挡在发布之前。

### 注释反引号自检（`scripts/lint-template-backticks.mjs`）

`print-css.ts` 用模板字符串拼 CSS。在其中的注释里写带反引号的说明（例如 `` `border-top: 1px dashed` ``）会**提前终止模板字符串**，让 esbuild 报出与真实原因毫不相干的语法错误。这个坑踩过三次，所以加了机器防线。

### 测试夹具

`tests/fixtures/` 下的页面取自真实站点并已脱敏，**刻意保留了真实的结构陷阱**：

- `paper-detail.html` — 保留了 `.sec-item` 类名碰撞（`exam-analyze` 里也有 3 个）
- `usertk-paper.html` — 保留了「3 个 `.sec-item`，每个 1 个题型」的形状，以及 `.selected-mask` 蒙版
- `zujuan-center.html` — 保留了 `article.paper-cnt` + `.ques-type` + `.ques-item` 三层结构

夹具如果被「简化」得太干净，测试就会失去意义。因此有专门的用例断言夹具本身仍带着这些陷阱。

---

## 构建与发布

### 本地构建

```bash
pnpm install
pnpm build          # Chrome / Edge (MV3) → .output/chrome-mv3
pnpm build:firefox  # Firefox (MV2)      → .output/firefox-mv2
pnpm zip            # → .output/better-zujuan-<version>-chrome.zip
pnpm zip:firefox    # → -firefox.zip 与 -sources.zip（供 AMO 审核）
```

### GitHub Actions

`.github/workflows/build.yml`，**仅手动触发**（Actions 页面点 Run workflow）：

1. 安装依赖（`pnpm install --frozen-lockfile`）
2. 跑完整 `pnpm run check`
3. 构建 Firefox 并自检
4. 打包三个 zip
5. 上传为 workflow artifact
6. 创建 **prerelease**，标签形如 `v1.0.0-pre.<run_number>`

正式发布不自动进行 —— 确认预发布没问题后，在 GitHub 上把对应 prerelease 改成正式发布（或手动新建 release）即可。

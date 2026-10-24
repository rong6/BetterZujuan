/**
 * 「灰色蒙版」处理（全局）。
 *
 * ## 现象
 *
 * 一旦往试题篮里加过题，站点会把 `editStatus` cookie 置为 `True`；
 * 此后**很多页面**上的题目容器都会带上 `.selected-mask` 类并被压到
 * `opacity: 0.5`，整卷看起来蒙了一层灰。
 *
 * 实测（个人题库 `/usertk/*`）：15 道题全部 `.selected-mask`，
 * `getComputedStyle(el).opacity === "0.5"`，覆盖整页正文宽度。
 *
 * ## 为什么必须处理
 *
 * 1) **打印会把它印进纸里。** `opacity` 会参与打印渲染，导出的 PDF 整卷发灰。
 * 2) **DOCX 也会继承。** `htmlToContent` 会把 `opacity` 转成 Word 的透明度，
 *    文档同样发灰。
 * 3) 这不是用户的意图 —— 用户只是加过题，并不是想把整卷变灰。
 *
 * ## 做法
 *
 * 只在**打印样式**与**离屏 clone** 上把透明度还原（`opacity: 1`），
 * 原页面的屏幕观感一律不动（与项目「原始 DOM 只读」的铁律一致）。
 * 即便用户没加过题，把 `opacity` 显式置 1 也无副作用。
 */

/** `editStatus` cookie 名（站点用它标记「试题篮里有题」）。 */
export const EDIT_STATUS_COOKIE = 'editStatus';

/** 半透明蒙版的类名。 */
export const GRAY_MASK_SELECTOR = '.selected-mask';

/**
 * 从 cookie 字符串读取 `editStatus`。
 *
 * 值实测为 `True`（首字母大写）。这里对大小写与空白都做归一，
 * 避免站点改成 `true` 后判定失效。
 */
export function readEditStatus(cookieString: string): boolean {
  for (const part of cookieString.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== EDIT_STATUS_COOKIE) continue;
    const value = rest.join('=').trim().toLowerCase();
    return value === 'true' || value === '1';
  }
  return false;
}

/** 页面上是否真的存在被压暗的容器（比只看 cookie 更可靠）。 */
export function hasGrayMask(doc: Document | undefined): boolean {
  if (!doc) return false;
  return doc.querySelector(GRAY_MASK_SELECTOR) !== null;
}

/**
 * 判断当前页面是否需要「还原灰色蒙版」。
 *
 * 两个条件取或：cookie 说加过题，或页面上真的存在 `.selected-mask`。
 * 只看 cookie 会漏掉 cookie 读不到的场景（HttpOnly / 分区存储）；
 * 只看 DOM 又可能在站点换类名后失效。两者互补。
 */
export function needsGrayMaskFix(doc: Document | undefined, cookieString?: string): boolean {
  if (hasGrayMask(doc)) return true;
  return readEditStatus(cookieString ?? doc?.cookie ?? '');
}

/** 生成还原透明度的 CSS 规则（供打印样式使用）。 */
export function grayMaskCss(): string {
  return `
  /* 灰色蒙版还原：加入试题篮后站点把 .selected-mask 压到 opacity .5，
     打印与导出必须还原，否则整卷发灰（DOCX 也会继承透明度）。 */
  ${GRAY_MASK_SELECTOR} {
    opacity: 1 !important;
    filter: none !important;
  }`;
}

/**
 * 在 clone 上就地还原透明度。
 *
 * 打印路径靠 CSS 即可，但 DOCX 走的是 `htmlToContent` 重新渲染 ——
 * 它不读我们的打印样式表里的这条规则是否生效，因此还必须在克隆出来的
 * DOM 上把内联样式写死。
 *
 * @returns 被修正的元素数量
 */
export function restoreOpacityIn(root: Element): number {
  const masked = Array.from(root.querySelectorAll<Element>(GRAY_MASK_SELECTOR));
  // 不写 `root instanceof HTMLElement`：单测跑在 node 环境里没有该全局，
  // 而且跨 iframe 的元素也不满足 instanceof。用鸭子类型判断即可。
  if (root.matches(GRAY_MASK_SELECTOR)) masked.push(root);
  for (const el of masked) {
    const style = (el as Partial<HTMLElement>).style;
    style?.setProperty('opacity', '1');
    style?.setProperty('filter', 'none');
  }
  return masked.length;
}

/**
 * 在克隆出来的子树里消除**祖先带来的**压暗效果。
 *
 * ## 为什么单独需要这个函数（实测踩坑）
 *
 * 蒙版元素是 `.wrapper.quesdiv`，而它是 `.exam-item__cnt`（题干）与
 * `.exam-item__opt`（答案）的**直接父节点**。而 `cloneStem` / `cloneAnswer`
 * 克隆的恰恰是这两个**内层**节点 —— 也就是说 **蒙版元素本身不在克隆结果里**，
 * `restoreOpacityIn` 找不到任何东西可改，导出的内容依旧发灰。
 *
 * 实测确认（线上个人题库页）：
 *   - `.wrapper.quesdiv.selected-mask` 的 computed `opacity` 为 `0.5`
 *   - 其子节点 `.exam-item__cnt` 的 computed `opacity` 为 `1`（opacity 不继承！）
 *   - 但 `opacity` 作用在**渲染子树**上，孩子照样被压暗
 *
 * 结论：不能只看克隆结果内部，必须**沿着原节点的祖先链**找出带
 * `.selected-mask` 的祖先，再把「祖先被压暗」这一事实转成克隆根节点上的
 * 内联 `opacity: 1`（克隆根在导出时已脱离原祖先，因此显式置 1 即可复原）。
 *
 * @param original  原页面上的节点（其祖先链会被检查）
 * @param cloneRoot 对应的克隆节点
 * @returns 是否发现并修正了祖先级蒙版
 */
export function clearInheritedMaskFrom(original: Element, cloneRoot: Element): boolean {
  let maskedAncestor: Element | null = null;
  let node: Element | null = original.parentElement;
  while (node) {
    if (node.matches?.(GRAY_MASK_SELECTOR)) {
      maskedAncestor = node;
      break;
    }
    node = node.parentElement;
  }
  if (!maskedAncestor) return false;

  const style = (cloneRoot as Partial<HTMLElement>).style;
  if (!style) return false;
  style.setProperty('opacity', '1');
  style.setProperty('filter', 'none');
  return true;
}
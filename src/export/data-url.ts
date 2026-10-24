/**
 * Blob → data URL。
 *
 * 刻意**不用 `FileReader`**：它只在浏览器里存在，在 Node（测试环境）里没有，
 * 于是同一段逻辑在测试中会静默失败（异常被 catch 掉，结果为空 Map）。
 * 改用 `Blob.arrayBuffer()` + `btoa`，浏览器与 Node 行为一致，测试才能真正覆盖到。
 */

/** 把字节按块编码成 base64，避免超大图片一次展开参数导致调用栈溢出。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 把 Blob 转成 data URL。mime 缺失时按八位字节流处理。 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || 'application/octet-stream';
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

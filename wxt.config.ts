import { defineConfig } from 'wxt';
import { escapeRiskyCharsInCode } from './src/shared/escape-risky-chars';

/**
 * 把产物里「裸写的高风险字符」重新转义，否则 Chrome 会以
 * 「该文件采用的不是 UTF-8 编码」为由拒绝加载内容脚本，导致扩展完全装不上。
 * 完整成因与实测记录见 `src/shared/escape-risky-chars.ts`。
 */
function escapeRiskyChars() {
  type ChunkLike = { type?: string; code?: string; fileName?: string };

  return {
    name: 'bz-escape-risky-chars',
    apply: 'build' as const,
    generateBundle(_options: unknown, bundle: Record<string, ChunkLike>) {
      for (const file of Object.values(bundle)) {
        if (!file || file.type !== 'chunk' || typeof file.code !== 'string') continue;
        const { code, changed } = escapeRiskyCharsInCode(file.code);
        if (changed === 0) continue;
        file.code = code;
        console.log(
          `  [better-zujuan] 已转义 ${changed} 个高风险字符（否则 Chrome 会拒绝加载内容脚本）: ${file.fileName}`,
        );
      }
    },
  };
}

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    plugins: [escapeRiskyChars()],
  }),
  // 内容脚本自动注入 zujuan.xkw.com 全站；具体页面由适配器识别
  // （试卷详情页 / 个人题库试卷 / 组卷中心），未识别的页面静默退出。
  manifest: {
    name: 'Better Zujuan',
    description: '改善组卷网试卷预览、页面净化与导出体验',
    version: '1.0.0',
    // 最小权限：不申请任何 API 权限（页面、公式、答案图、题图均可在页面上下文直接 fetch，
    // 已实测无需绕过 CORS）；曾经用 storage 保存额度用量，该功能移除后权限一并去掉。
    host_permissions: [
      'https://zujuan.xkw.com/*',
      'https://staticzujuan.xkw.com/*',
      'https://imzujuan.xkw.com/*',
      // 题目插图在此源上（实测与公式 CDN 不是一个域），导出取原图需要它
      'https://img.xkw.com/*',
    ],
  },
});

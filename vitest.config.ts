import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * 两处测试：
 *  · `server/test` —— shared 解析层 + 后端归一化（fixture 与 node 环境都在 server 侧）；
 *  · `web/test` —— 前端状态机（turnStore 等）在 `*.test.ts`，组件的 DOM 行为在 `*.test.tsx`。
 *    turnStore 是"运行态唯一事实源"，不能被"浏览器里点一遍看起来对"代替：增量渲染、
 *    停止接收、跨轮污染这些行为都只在时序里出现，肉眼在真实浏览器里很难稳定复现。
 *
 * **默认 environment 是 node**，DOM 测试在文件顶部用 `// @vitest-environment jsdom` 单独切换。
 * 不整库切 jsdom 的原因：状态机测试故意跑在"没有 DOM"的环境里，源码对浏览器 API 的
 * `typeof` 守卫一旦退化就会当场炸出来；混在 jsdom 里，"前端环境缺失导致的假失败"
 * 和"状态机错了"就分不开了。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['server/test/**/*.test.ts', 'web/test/**/*.test.{ts,tsx}'],
    // 长样例的解析要一点时间，但远不到 5s；给到 20s 是为了
    // 让"真的卡住"和"机器慢"区分开——超时失败必须值得看一眼。
    testTimeout: 20_000,
  },
});

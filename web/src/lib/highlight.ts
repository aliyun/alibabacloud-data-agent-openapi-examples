import type { createHighlighterCore } from 'shiki/core';

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

/**
 * 代码高亮：懒加载单例 + 语言别名 + LRU 缓存 + 亮暗双主题。
 *
 * 从 Markdown.tsx 里拆出来是因为这四件事都跟"渲染 Markdown"无关，
 * 混在一起会让组件文件同时承担语法数据加载策略与 DOM 结构。
 */

/**
 * 只登记这个样板工程真会用到的语言，每种一个动态 import。
 *
 * 刻意不用 `shiki/bundle/web`：那个入口把上百种语言全注册成动态导入，Vite 会给
 * 每种语言切一个 chunk（产物里会出现 cpp / wasm / blade / php / vue-vine……），
 * dist 凭空涨几 MB，而 DataAgent 的回答里根本不会有这些。
 *
 * 覆盖面靠 `LANG_ALIAS` 而不是靠继续加语言：agent 写 ```sh / ```py / ```yml
 * 的频率远高于写 ```shellscript，把它们映射到已登记的语法上，
 * 比多切十几个 chunk 划算得多。
 *
 * 这里刻意不写类型注解：`Record<string, () => Promise<unknown>>` 会把每个 thunk 的
 * 返回类型抹成 unknown，`langs` 就不再是 shiki 的 `LanguageInput[]`。让它按字面量推断。
 */
const LANG_MODULES = {
  sql: () => import('shiki/langs/sql.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  http: () => import('shiki/langs/http.mjs'),
  console: () => import('shiki/langs/console.mjs'),
};

/**
 * 已登记的语言名。渲染侧显示"实际用的是哪种语法"时读这一份，避免两处清单漂移。
 *
 * 额外补一个 'text'：shiki 对它有特殊处理（不需要语法数据），所以它不能出现在
 * LANG_MODULES 里（那会给 createHighlighterCore 传一个空对象），但别名映射需要它当落点。
 */
export const LOADED_LANGS: string[] = [...Object.keys(LANG_MODULES), 'text'];

const LANGS = Object.values(LANG_MODULES);

/** 围栏里常见的简写 → shiki 的语法名。左边的键全部按小写比较。 */
const LANG_ALIAS: Record<string, string> = {
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  shell: 'shellscript',
  shellsession: 'console',
  console: 'console',
  py: 'python',
  python3: 'python',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  htm: 'html',
  vue: 'html',
  xml: 'xml',
  svg: 'xml',
  json5: 'jsonc',
  jsonc: 'jsonc',
  toml: 'toml',
  ini: 'ini',
  dotenv: 'ini',
  properties: 'ini',
  csv: 'csv',
  tsv: 'csv',
  text: 'text',
  plain: 'text',
  plaintext: 'text',
  none: 'text',
  txt: 'text',
};

const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

/**
 * 超过这个长度就不高亮，直接出纯文本。
 *
 * 一段几万行的日志或 CSV 被 agent 贴进回答时，语法分析会阻塞主线程几百毫秒——
 * 而那种内容本来也没有"着色"的价值（全是同一种 token）。
 */
const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * 单行长度上限。
 *
 * 总字数只是成本的一半：引擎用的是 JS 正则（见下面 `createJavaScriptRegexEngine` 的说明），
 * 一行的长度决定了一次匹配里要试探多少位置。一段 3 万字的压缩 JSON 全挤在一行上，
 * 总字数远低于上面那个阈值，但单行长度已经进入了正则引擎最容易退化的区间。
 * agent 把查询结果整行贴出来、或者吐一行 minified JSON，都属于这一类形态。
 *
 * 如实交代：这是**预防性**护栏，不是实测到的性能事故——单行长度对 shiki JS 正则引擎
 * 的阻塞时间影响，本工程没有量过（要量得造一段 2 万字单行的样本并在真机上打点）。
 * 阈值取 2 万的依据是"正常代码不会有这么长的一行"，不是测出来的拐点。
 */
const MAX_LINE_CHARS = 20_000;

/** 跳过高亮的原因。给界面用：两种原因该说不同的话，笼统一句"过长"没法自查。 */
export type SkipHighlight = 'too-long' | 'overlong-line';

/** 缓存条数上限。一轮长回答里十几个代码块，128 条足够覆盖来回滚动重渲染。 */
const CACHE_LIMIT = 128;

/**
 * LRU：`Map` 的迭代顺序就是插入顺序，命中后删掉再插回去，
 * 于是"最久未用"永远是第一个键——不需要额外维护链表。
 */
const cache = new Map<string, string>();

let highlighterPromise: Promise<Highlighter> | undefined;

async function create(): Promise<Highlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ]);
  return createHighlighterCore({
    /**
     * 路径必须是字面量：含变量的 import() 会让 Vite 把 shiki/themes 整个目录
     * 都切进产物，那正是上面避开 bundle/web 想省掉的东西。
     *
     * 两套主题一次性装载。实测输出把**亮色写成字面量颜色、暗色写成 `--shiki-dark`
     * 自定义属性**（`<span style="color:#D73A49;--shiki-dark:#F97583">`），
     * 暗色由 index.css 里那条 `!important` 规则翻过去 —— 所以切换主题
     * **不需要重新高亮**，缓存也就不必按主题分键。
     */
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: LANGS.map((load) => load()),
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
}

/**
 * 引擎用 JS 正则而不是 oniguruma wasm：省掉一个几百 KB 的 wasm 产物，
 * 代价是极少数依赖回溯特性的语法可能着色不准 —— `forgiving: true` 让这种情况
 * 退化成不着色而不是抛错。SQL / JSON / Shell 这些目标语言都不受影响。
 */
function getHighlighter(): Promise<Highlighter> {
  // 必须**同步**把 promise 存下来：等 await 之后再存的话，这段窗口里的并发调用
  // （一轮回答里十几个代码块同时挂载）会各自建一个 highlighter。
  highlighterPromise ??= create();
  return highlighterPromise;
}

/** 围栏里写的语言名 → 实际能用的语法名。认不出来就返回 'text'。 */
export function resolveLang(raw: string, loaded: string[]): string {
  const lower = raw.trim().toLowerCase();
  const aliased = LANG_ALIAS[lower] ?? lower;
  return loaded.includes(aliased) ? aliased : 'text';
}

/** 最长的一行有多少字。逐段扫而不是 split：不给一段 10 万字的代码再造一个数组。 */
export function longestLine(code: string): number {
  let longest = 0;
  let start = 0;
  for (;;) {
    const nl = code.indexOf('\n', start);
    const end = nl === -1 ? code.length : nl;
    if (end - start > longest) longest = end - start;
    if (nl === -1) return longest;
    start = nl + 1;
  }
}

export function skipHighlightReason(code: string): SkipHighlight | undefined {
  if (code.length > MAX_HIGHLIGHT_CHARS) return 'too-long';
  if (longestLine(code) > MAX_LINE_CHARS) return 'overlong-line';
  return undefined;
}

export function isTooLongToHighlight(code: string): boolean {
  return skipHighlightReason(code) !== undefined;
}

/** 界面上那句说明。两种原因说不同的话，用户才知道该拆行数还是该拆整块。 */
export function skipHighlightNote(reason: SkipHighlight, code: string): string {
  return reason === 'too-long'
    ? `超过 ${MAX_HIGHLIGHT_CHARS.toLocaleString('zh-CN')} 字（实际 ${code.length.toLocaleString('zh-CN')} 字），跳过语法高亮以免阻塞主线程`
    : `有一行超过 ${MAX_LINE_CHARS.toLocaleString('zh-CN')} 字（最长 ${longestLine(code).toLocaleString('zh-CN')} 字），跳过语法高亮：单行过长会让正则引擎退化`;
}

/**
 * 高亮一段代码，返回可直接 dangerouslySetInnerHTML 的 HTML。
 *
 * 返回 undefined 表示"这段不该/没能高亮"（太长、语法数据没加载出来），
 * 调用方退回纯文本渲染——代码本身必须看得见，颜色只是锦上添花。
 */
export async function highlight(code: string, rawLang: string): Promise<string | undefined> {
  if (isTooLongToHighlight(code)) return undefined;

  const key = `${rawLang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  try {
    const highlighter = await getHighlighter();
    const lang = resolveLang(rawLang, highlighter.getLoadedLanguages());
    const html = highlighter.codeToHtml(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
    });
    cache.set(key, html);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return html;
  } catch {
    // 高亮失败就留在纯文本，不值得为它报错或者开白屏
    return undefined;
  }
}

/** 测试与诊断用：当前缓存条数。 */
export function highlightCacheSize(): number {
  return cache.size;
}

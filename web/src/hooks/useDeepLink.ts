import { useEffect } from 'react';

import { readSessionParam, writeSessionParam } from '@/lib/deepLink';
import { sessionStore } from '@/state/session';

/**
 * `?session=<id>` 深链：进来时按链接选中会话，之后选中态变了就把链接同步回去。
 *
 * 用 replaceState（见 lib/deepLink.ts）：切会话不该在浏览器历史里留一堆条目。
 *
 * 不校验链接里的 id 是否真存在：一个失效会话被链接指过来，用户该看到的是中栏照实报错，
 * 而不是"链接被静默忽略、界面停在空态"——后者会让人以为链接格式写错了。
 */
export function useDeepLink(): void {
  useEffect(() => {
    const fromUrl = readSessionParam(window.location.search);
    if (fromUrl !== undefined) sessionStore.select(fromUrl);

    const sync = (): void => {
      const next = writeSessionParam(window.location.search, sessionStore.getSnapshot());
      if (next === window.location.search) return;
      window.history.replaceState(null, '', `${window.location.pathname}${next}${window.location.hash}`);
    };

    sync();
    return sessionStore.subscribe(sync);
  }, []);
}

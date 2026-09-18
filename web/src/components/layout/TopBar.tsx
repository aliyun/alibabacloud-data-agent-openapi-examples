import { AlertTriangle, Keyboard, Moon, PanelLeft, PanelRight, ServerOff, Sun } from 'lucide-react';

import { API_BASE } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { useHealth } from '@/hooks/useHealth';
import { cn } from '@/lib/utils';
import { layoutStore, useLayout } from '@/state/layout';
import { overlayStore, useHelpOpen } from '@/state/overlays';
import { themeStore, useTheme } from '@/state/theme';

/**
 * 顶栏。
 *
 * 它要第一眼回答两个问题：后端连上了没有、现在看到的是真接口还是回放。
 * MOCK 模式下所有界面都是绿的，如果不显眼标注，很容易把回放当成线上验证结论。
 *
 * 窄屏时左右两栏不再占栅格列，改由这里的两个按钮开抽屉——所以这两个按钮
 * **只在窄屏出现**：宽屏下侧栏自己有标题行与收起按钮，再放一份是两个入口
 * 控制同一件事，会出现"点哪个"的困惑。
 */
export function TopBar() {
  const { data, isError, isPending } = useHealth();
  const { narrow, leftDrawer, rightDrawer } = useLayout();
  const theme = useTheme();
  const helpOpen = useHelpOpen();

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 [padding-left:max(0.75rem,env(safe-area-inset-left))] [padding-right:max(0.75rem,env(safe-area-inset-right))] sm:gap-3 sm:px-4">
      {narrow && (
        <PanelButton
          label="会话"
          open={leftDrawer}
          Icon={PanelLeft}
          onClick={() => layoutStore.toggleDrawer('left')}
        />
      )}

      <span className="truncate text-sm font-semibold">DataAgent OpenAPI 样板工程</span>

      {isPending ? (
        <Badge variant="outline">连接中…</Badge>
      ) : isError ? (
        <Badge variant="destructive" className="gap-1">
          <ServerOff />
          后端未连接
        </Badge>
      ) : (
        <>
          <Badge variant={data.mock ? 'warning' : 'secondary'}>
            {data.mock ? 'MOCK 回放' : 'LIVE 真实接口'}
          </Badge>
          <span className="hidden truncate text-xs text-muted-foreground md:inline">
            {data.region} · {data.agent}
          </span>
          {!data.mock && data.credentials === 'missing' && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle />
              凭证缺失
            </Badge>
          )}
        </>
      )}

      <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground lg:inline">{API_BASE}</span>

      <div className={cn('flex items-center gap-1', !narrow && 'ml-auto')}>
        {narrow && (
          <PanelButton
            label="扩展区"
            open={rightDrawer}
            Icon={PanelRight}
            onClick={() => layoutStore.toggleDrawer('right')}
          />
        )}
        <button
          type="button"
          onClick={() => overlayStore.toggleHelp()}
          aria-label="键盘快捷键"
          aria-haspopup="dialog"
          aria-expanded={helpOpen}
          title="键盘快捷键（?）"
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Keyboard className="size-4" />
        </button>
        <button
          type="button"
          onClick={themeStore.toggle}
          aria-label={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </header>
  );
}

interface PanelButtonProps {
  label: string;
  open: boolean;
  Icon: typeof PanelLeft;
  onClick: () => void;
}

function PanelButton({ label, open, Icon, onClick }: PanelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${open ? '关闭' : '打开'}${label}`}
      aria-expanded={open}
      title={`${open ? '关闭' : '打开'}${label}`}
      className={cn(
        'rounded p-1.5 transition-colors hover:bg-accent hover:text-foreground',
        open ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

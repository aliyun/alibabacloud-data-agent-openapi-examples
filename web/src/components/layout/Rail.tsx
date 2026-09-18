import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface RailProps {
  side: 'left' | 'right';
  label: string;
  onExpand: () => void;
}

/** 侧栏收起后剩下的那条竖排把手。 */
export function Rail({ side, label, onExpand }: RailProps) {
  const Icon = side === 'left' ? PanelRightOpen : PanelLeftOpen;
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center gap-3 border-border bg-muted/30 py-3',
        side === 'left' ? 'border-r' : 'border-l',
      )}
    >
      <button
        type="button"
        onClick={onExpand}
        title={`展开${label}`}
        aria-label={`展开${label}`}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Icon className="size-4" />
      </button>
      <span className="text-xs tracking-widest text-muted-foreground [writing-mode:vertical-rl]">
        {label}
      </span>
    </div>
  );
}

export interface PanelHeaderProps {
  side: 'left' | 'right';
  title: string;
  onCollapse: () => void;
  children?: ReactNode;
}

/** 展开态侧栏的标题行，右侧带收起按钮。 */
export function PanelHeader({ side, title, onCollapse, children }: PanelHeaderProps) {
  const Icon = side === 'left' ? PanelLeftClose : PanelRightClose;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="ml-auto flex items-center gap-1">
        {children}
        <button
          type="button"
          onClick={onCollapse}
          title={`收起${title}`}
          aria-label={`收起${title}`}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon className="size-4" />
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';

import { PanelHeader, Rail } from '@/components/layout/Rail';
import { ArtifactTab } from '@/components/right/ArtifactTab';
import { CheckTab } from '@/components/right/CheckTab';
import { ReconcileTab } from '@/components/right/ReconcileTab';
import { SessionTab } from '@/components/right/SessionTab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UsageTab } from '@/components/right/UsageTab';
import { cn } from '@/lib/utils';
import { readJson, writeJson } from '@/lib/persist';
import { layoutStore, useLayout } from '@/state/layout';

/**
 * 右栏：扩展区，五个 tab。
 *
 * 每个 tab 只放"已经拿到手的数据"，不为凑数造面板：Artifact 恒空也照样留着，
 * 因为那条空本身就是实测结论；自检要用户点一次才跑（第②步在 LIVE 下是真写操作）。
 *
 * 点当前已激活的 tab = 收起整栏（窄屏是关抽屉）。这是"可关闭"的落点：
 * tab 集合是固定的，关掉某一个只会让下次想看时找不到入口，收起整栏才是用户要的动作。
 */
const TABS = [
  { id: 'artifact', label: 'Artifact' },
  { id: 'usage', label: '用量' },
  { id: 'reconcile', label: '对账' },
  { id: 'check', label: '自检' },
  { id: 'session', label: '会话' },
] as const;

export type RightTabId = (typeof TABS)[number]['id'];

const TAB_KEY = 'das.rightTab.v1';
const DEFAULT_TAB: RightTabId = 'artifact';

function isTabId(value: unknown): value is RightTabId {
  return typeof value === 'string' && TABS.some((tab) => tab.id === value);
}

export interface ArtifactPanelProps {
  /**
   * `dock` = 常驻栅格列（自己画标题行与收起后的竖条）；
   * `drawer` = 窄屏抽屉里（标题行与关闭按钮由 Drawer 画，这里不再重复一遍）。
   */
  variant?: 'dock' | 'drawer';
  /** 窄屏下"点已激活的 tab"要关抽屉，关抽屉的手在 App 里，所以由外面传进来。 */
  onRequestClose?: () => void;
}

export function ArtifactPanel({ variant = 'dock', onRequestClose }: ArtifactPanelProps) {
  const { rightCollapsed } = useLayout();
  const inDrawer = variant === 'drawer';
  const [tab, setTab] = useState<RightTabId>(() => readJson<RightTabId>(TAB_KEY, DEFAULT_TAB, isTabId));

  if (!inDrawer && rightCollapsed) {
    return <Rail side="right" label="扩展区" onExpand={layoutStore.toggleRight} />;
  }

  function pickTab(next: RightTabId): void {
    setTab(next);
    writeJson(TAB_KEY, next);
  }

  /** 点已激活的 tab：收起整栏。Radix 在这种情况下不会触发 onValueChange，得自己接。 */
  function collapse(): void {
    if (inDrawer) onRequestClose?.();
    else layoutStore.toggleRight();
  }

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', !inDrawer && 'border-l border-border')}>
      {!inDrawer && <PanelHeader side="right" title="扩展区" onCollapse={layoutStore.toggleRight} />}
      <Tabs value={tab} onValueChange={(value) => pickTab(value as RightTabId)} className="flex min-h-0 flex-1 flex-col gap-0 p-2">
        <TabsList className="h-8 shrink-0 self-start">
          {TABS.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              className="px-2.5 py-1 text-xs"
              title={item.id === tab ? '再点一次收起扩展区' : undefined}
              onClick={() => {
                if (item.id === tab) collapse();
              }}
            >
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="artifact" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <ArtifactTab />
        </TabsContent>
        <TabsContent value="usage" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <UsageTab />
        </TabsContent>
        <TabsContent value="reconcile" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <ReconcileTab />
        </TabsContent>
        <TabsContent value="check" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <CheckTab />
        </TabsContent>
        <TabsContent value="session" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <SessionTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

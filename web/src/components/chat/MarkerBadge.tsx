import { ShieldCheck, ShieldQuestion } from 'lucide-react';

import { Badge } from '@/components/ui/badge';

export interface MarkerBadgeProps {
  marker: string | undefined;
  verified: boolean;
  /** MOCK 回放的是固定样例，里面不可能有本轮的校验码。 */
  mock?: boolean;
}

/**
 * 回答归属校验徽标。
 *
 * 服务端有过跨会话串答案的问题（实测 5 个会话并发时隔离率只有 1/5），
 * 所以"这段回答是从我的连接里流出来的"不足以证明它属于我这一轮。
 * 每条 prompt 末尾注入一个唯一校验码、要求 agent 在回答第一行原样输出，
 * 再在收到的正文里找它——找到才算归属已校验。
 *
 * 未校验不等于答错了，但等于**无法证明这段内容属于本轮**，必须让用户看见。
 */
export function MarkerBadge({ marker, verified, mock }: MarkerBadgeProps) {
  if (verified) {
    return (
      <Badge variant="secondary" className="gap-1 font-mono text-[11px] font-normal" title={`回答正文里原样出现了本轮校验码 ${marker}`}>
        <ShieldCheck className="size-3" />
        归属已校验 {marker}
      </Badge>
    );
  }

  const title = mock
    ? 'MOCK 回放的是固定样例，正文里不会有本轮新生成的校验码，所以这里恒为未校验。'
    : marker === undefined
      ? '还没有拿到本轮校验码（流可能刚建立就断了）。'
      : `回答正文里没有找到本轮校验码 ${marker}。这段内容无法证明属于本轮——实测存在跨会话串答案的情况。`;

  return (
    <Badge variant="outline" className="gap-1 font-mono text-[11px] font-normal text-muted-foreground" title={title}>
      <ShieldQuestion className="size-3" />
      归属未校验{marker ? ` ${marker}` : ''}
    </Badge>
  );
}

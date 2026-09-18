// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NoTurnsNotice, WelcomeHead } from '@/components/chat/ChatPanel';

/**
 * 中栏两个空态。
 *
 * 这两个组件都不接数据、只接一个数，所以能在 jsdom 里直接渲染。钉住的是**措辞**，
 * 因为它们的价值全在措辞上：
 *  · `WelcomeHead` 不给示例提示词（仓里的样例提示词带归属校验码这类
 *    脚手架约束，摆出来会被照着抄）；
 *  · `NoTurnsNotice` 必须把「真的一帧都没有」和「有帧但没一帧是提示词回显」分开说，
 *    后者是 prompt 被上游 200 收下却从未派发时历史里的形状，只显示"还没有轮次"
 *    会让人以为自己没发出去过。
 */

afterEach(cleanup);

describe('WelcomeHead（未选中会话）', () => {
  it('说清"直接发就自动建会话"，这是空态唯一要传达的事', () => {
    render(<WelcomeHead />);
    expect(screen.getByText('在下面的输入框写下任务，回车发送 —— 会自动新建一个会话。')).toBeTruthy();
  });

  it('不给示例提示词：一个可点的范例就会被当成模板抄走', () => {
    render(<WelcomeHead />);
    const buttons = document.querySelectorAll('button');
    expect(buttons.length).toBe(0);
    // 也不写产品名——顶栏已经有了，重复一遍只会挤掉上面那句话。
    expect(document.body.textContent).not.toContain('DataAgent');
  });
});

describe('NoTurnsNotice（会话有了，轮次为零）', () => {
  it('totalFrames === 0：照实说"还没发过"，并给出下一步动作', () => {
    render(<NoTurnsNotice totalFrames={0} />);
    expect(screen.getByText('这个会话还没有任何轮次。在下面的输入框写下任务，回车发送。')).toBeTruthy();
    expect(document.querySelectorAll('p').length).toBe(1);
  });

  it('totalFrames > 0：把帧数报出来，说明"有帧但没构成轮次"', () => {
    render(<NoTurnsNotice totalFrames={2} />);
    expect(screen.getByText(/历史里有 2 帧/)).toBeTruthy();
    expect(screen.getByText(/不构成轮次/)).toBeTruthy();
  });

  it('totalFrames > 0 才附那句"别照着原文重发"：重发等于把同一个写操作执行两遍', () => {
    const { unmount } = render(<NoTurnsNotice totalFrames={2} />);
    expect(screen.getByText('别照着原文重发一遍：先确认这一轮到底有没有在服务端跑起来。')).toBeTruthy();
    unmount();

    render(<NoTurnsNotice totalFrames={0} />);
    expect(screen.queryByText(/别照着原文重发/)).toBeNull();
  });
});

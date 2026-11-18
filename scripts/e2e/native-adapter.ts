// CI-owned fixture/session; importing this module never sends requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DaemonClient, DaemonSessionClient, createDaemonTranscriptStore, normalizeDaemonEvent, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { installHttpPromptTransport } from '../../web/src/http-prompt-transport.js';

export async function verifyAdapter(base: string, sessionId: string, signal: AbortSignal, onProgress: (phase: string) => void = () => {}) {
  const clients = [0, 1].map(() => {
    const client = new DaemonClient({ baseUrl: `${base}/d` });
    const transport = installHttpPromptTransport(client, `${base}/d`, async () => 'http-stream');
    const session = new DaemonSessionClient({ client, session: { sessionId, clientId: randomUUID(), workspaceCwd: '/data-agent', attached: false } });
    transport.decorate(session);
    return { client, transport, session };
  });
  const rounds = [];
  const markers: string[] = [];
  let after: number | undefined;
  let epoch: string | undefined;
  const until = async (ready: () => boolean) => {
    while (!ready()) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    for (let round = 0; round < 2; round++) {
      onProgress(`round-${round + 1}-subscribe`);
      const marker = `DEMO_${randomUUID().replaceAll('-', '')}`;
      markers.push(marker);
      const text = `请只回复 ${marker}，不调用工具。`;
      const controllers = clients.map(() => new AbortController());
      const observed: DaemonEvent[][] = [[], []];
      const stores = clients.map(() => createDaemonTranscriptStore());
      let failure: unknown;
      // Match OpenApiPromptRendering: no optimistic copy, both views render native user echoes.
      const readers = clients.map(({ session }, index) => (async () => {
        for await (const event of session.events({ signal: AbortSignal.any([signal, controllers[index]!.signal]),
          ...(after === undefined ? {} : { lastEventId: after, epoch }), onEpoch: value => {
            if (epoch !== undefined) assert.equal(value, epoch, 'epoch changed between rounds');
            epoch = value;
          } })) {
          observed[index]!.push(event);
          stores[index]!.dispatch(normalizeDaemonEvent(event));
          if (observed[index]!.length > 4096) throw new Error('unbounded Events subscription');
        }
      })().catch(error => { if (!controllers[index]!.signal.aborted) failure = error; }));
      try {
        await until(() => { if (failure) throw failure; return observed.every(events => events.some(e => e.type === 'stream_open')); });
        onProgress(`round-${round + 1}-submit`);
        // Exactly one real SDK submitPrompt. No retry even if admission/transport becomes unknown.
        const accepted = await clients[round % 2]!.session.submitPrompt({ prompt: [{ type: 'text', text }] }, signal);
        assert.ok(accepted.promptId, 'owned prompt identity missing');
        const owner = round % 2;
        let nativePromptId: string | undefined;
        onProgress(`round-${round + 1}-terminal`);
        await until(() => {
          if (failure) throw failure;
          nativePromptId = observed[owner]!.map(event => event._meta?.nativePromptId)
            .find((value): value is string => typeof value === 'string');
          return !!nativePromptId && observed.every((events, index) => events.some(event => event.type === 'turn_complete'
            && event.promptId === (index === owner ? accepted.promptId : nativePromptId)));
        });
        const views = stores.map((store, index) => {
          const events = observed[index]!.filter(event => event.promptId === (index === owner ? accepted.promptId : nativePromptId));
          assert.equal(events.filter(event => event.type === 'turn_complete').length, 1, 'duplicate terminal');
          const blocks = store.getSnapshot().blocks;
          assert.equal(blocks.filter(block => block.kind === 'user' && block.text.includes(marker)).length, 1, 'user echo duplicated or missing');
          assert.ok(blocks.flatMap(block => block.kind === 'assistant' ? [block.text] : []).join('').includes(marker), 'assistant text missing');
          const terminal = events.find(event => event.type === 'turn_complete')!;
          assert.equal((terminal.data as { stopReason?: string }).stopReason, 'end_turn');
          if (index !== owner) assert.ok(Number.isSafeInteger(terminal.id), 'observer requires a native terminal ID');
          if (index === owner) assert.ok(events.some(event => event._meta?.nativePromptId === nativePromptId), 'owned/native identity correlation missing');
          return { terminal: terminal.id, nativeEvents: events.length, userBlocks: 1, terminalCount: 1 };
        });
        const terminal = views[1 - owner]!.terminal!;
        controllers.forEach(controller => controller.abort());
        await Promise.all(readers);
        // Reconnect after execution has ended. Hold through replay_complete, not just terminal delivery.
        const replayAbort = new AbortController();
        onProgress(`round-${round + 1}-ended-replay`);
        const replayed: DaemonEvent[] = [];
        // A fresh observer verifies native replay independently of browser-owned completion retention.
        const replayClient = new DaemonClient({ baseUrl: `${base}/d` });
        const replaySession = new DaemonSessionClient({ client: replayClient, session: { sessionId, workspaceCwd: '/data-agent', attached: false } });
        try {
          for await (const event of replaySession.events({ lastEventId: terminal - 1, epoch,
            signal: AbortSignal.any([signal, replayAbort.signal]) })) {
            replayed.push(event);
            if (event.type === 'replay_complete') break;
            assert.ok(replayed.length <= 4096);
          }
        } finally { replayAbort.abort(); replayClient.dispose(); }
        assert.equal(replayed.filter(event => event.type === 'turn_complete' && event.promptId === nativePromptId && event.id === terminal).length, 1);
        assert.equal(replayed.filter(event => event.type === 'replay_complete').length, 1, 'missing replay receipt');
        after = terminal;
        rounds.push({ promptId: accepted.promptId, nativePromptId, promptSubmissions: 1, eventEpoch: epoch, views, endedReplay: true });
      } finally {
        controllers.forEach(controller => controller.abort());
        await Promise.all(readers);
      }
    }
    onProgress('history');
    const historyResponse = await fetch(`${base}/d/standalone/sessions/${encodeURIComponent(sessionId)}/load`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
    assert.ok(historyResponse.ok, 'demo history HTTP failure');
    const history = await historyResponse.json();
    const events = [...history.compactedReplay, ...history.liveJournal] as DaemonEvent[];
    const content = events.flatMap(event => {
      const update = (event.data as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
      return update?.sessionUpdate === 'agent_message_chunk' ? [update.content?.text ?? ''] : [];
    }).join('');
    assert.ok(markers.every(marker => content.includes(marker)), 'Load lost a completed demo turn');
    return { rounds, promptSubmissions: 2, historyVerified: true, transcript: 'canonical-sdk-no-optimistic-user-copy' };
  } finally {
    for (const { client, transport } of clients) { transport.dispose(); client.dispose(); }
  }
}

if (process.argv[1]?.endsWith('/native-adapter.ts')) {
  const [base, sessionId, timeout] = process.argv.slice(2);
  if (!base || !sessionId || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('owned loopback backend/session required');
  // stdout contains correlation/counts only. No transcript or credential values.
  const result = await verifyAdapter(base, sessionId, AbortSignal.timeout(Math.min(500_000, Number(timeout) || 120_000)));
  process.stdout.write(JSON.stringify(result));
}

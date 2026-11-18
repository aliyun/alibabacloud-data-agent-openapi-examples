import { createContext, useContext, useEffect, useState } from 'react';
import { useActions, useConnection } from '@qwen-code/web-shell';

export interface SessionRecoveryRequest { sessionId: string; automatic: boolean; id: number }
export const SessionRecoveryContext = createContext<{
  request?: SessionRecoveryRequest;
  complete: (request: SessionRecoveryRequest) => void;
  retry: (sessionId: string) => void;
} | undefined>(undefined);

/** Use the public provider reload so history, cursor provenance and the view change together. */
export function SessionEventRecovery() {
  const recovery = useContext(SessionRecoveryContext);
  const { sessionId } = useConnection();
  const actions = useActions();
  const request = recovery?.request;
  const complete = recovery?.complete;
  const [error, setError] = useState<{ sessionId: string; message: string }>();
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!request || !complete) return;
    if (request.sessionId !== sessionId) { complete(request); return; }
    if (!request.automatic) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]);
    setRunning(true); setError(undefined);
    void (async () => {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          try { await actions.reloadSession(signal); return; }
          catch (cause) {
            if (signal.aborted || attempt === 2 || !/INSTANCE_OPERATION_IN_PROGRESS|INSTANCE_RECLAIMING/.test(String(cause))) throw cause;
            await new Promise<void>(resolve => {
              const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
              const timer = setTimeout(finish, 1000 * (attempt + 1));
              signal.addEventListener('abort', finish, { once: true });
              if (signal.aborted) finish();
            });
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError({ sessionId: request.sessionId,
          message: cause instanceof Error ? cause.message : '会话恢复失败，请重试。' });
      } finally {
        if (!controller.signal.aborted) { setRunning(false); complete(request); }
      }
    })();
    return () => controller.abort();
  }, [request, complete, sessionId, actions]);
  if (running && request?.sessionId === sessionId) return <div role="status">正在恢复会话历史和实时连接…</div>;
  if (sessionId && ((request?.sessionId === sessionId && !request.automatic) || error?.sessionId === sessionId)) {
    return <div role="alert">{error?.sessionId === sessionId ? error.message : '会话再次闲置，实时连接已暂停。'}
      <button onClick={() => recovery?.retry(sessionId)}>恢复会话</button></div>;
  }
  return null;
}

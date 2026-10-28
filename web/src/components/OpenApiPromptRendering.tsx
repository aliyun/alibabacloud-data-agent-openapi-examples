import { useEffect, useState, type ReactNode } from 'react';
import { useActions, useTranscriptStore } from '@qwen-code/web-shell';
import { installRequestErrorDedup } from '../request-error-dedup';

/** POP does not forward the daemon's trusted client ID, so render the authoritative
 * user echo instead of also inserting an optimistic copy or guessing its owner. */
export function OpenApiPromptRendering({ children }: { children: ReactNode }) {
  const actions = useActions();
  const store = useTranscriptStore();
  useEffect(() => installRequestErrorDedup(store), [store]);
  const [ready, setReady] = useState<typeof actions>();
  useEffect(() => {
    const send = actions.sendPrompt;
    const submit = actions.submitPrompt;
    actions.sendPrompt = (text, options) => send(text, { ...options, optimisticUserMessage: false });
    actions.submitPrompt = (text, options) => submit(text, { ...options, optimisticUserMessage: false });
    setReady(actions);
    return () => { actions.sendPrompt = send; actions.submitPrompt = submit; };
  }, [actions]);
  return ready === actions ? children : null;
}

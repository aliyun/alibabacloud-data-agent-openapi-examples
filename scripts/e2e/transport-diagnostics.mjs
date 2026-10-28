// Opt-in Node HTTP metadata only. Never records paths, bodies, authentication or arbitrary error messages.
import { channel } from 'node:diagnostics_channel';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function observeTransport(write) {
  let sequence = 0;
  const watched = new WeakSet();
  const cleanups = new Set();
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
  const listener = ({ request }) => {
    const action = safe(request.getHeader('x-acs-action'));
    if (!action || watched.has(request)) return;
    watched.add(request);
    const requestNo = `${process.pid}-${++sequence}`;
    const emit = (event, fields = {}) => {
      try { write({ at: new Date().toISOString(), requestNo, action, event,
        reusedSocket: !!request.reusedSocket, ...fields }); } catch { /* Diagnostics cannot change request execution. */ }
    };
    const hooks = [];
    const once = (target, event, fn) => { target.once(event, fn); hooks.push(() => target.removeListener(event, fn)); };
    const release = () => { hooks.forEach(fn => fn()); cleanups.delete(release); };
    cleanups.add(release);
    emit('request_start', { host: safe(request.host), connection: safe(request.getHeader('connection')) });
    const socketInfo = socket => {
      const snapshot = () => emit('socket', { remoteAddress: safe(socket.remoteAddress), remotePort: socket.remotePort,
        localPort: socket.localPort, connecting: socket.connecting });
      snapshot();
      if (socket.connecting) once(socket, 'connect', snapshot);
    };
    if (request.socket) socketInfo(request.socket); else once(request, 'socket', socketInfo);
    once(request, 'error', error => emit('request_error', { code: safe(error.code), syscall: safe(error.syscall) }));
    once(request, 'response', response => {
      emit('response_headers', { statusCode: response.statusCode, requestId: safe(response.headers['x-acs-request-id']) });
      once(response, 'aborted', () => emit('response_aborted'));
      once(response, 'error', error => emit('response_error', { code: safe(error.code) }));
      once(response, 'end', () => emit('response_end'));
      once(response, 'close', release);
    });
    once(request, 'close', () => { if (!request.res) release(); });
  };
  const start = channel('http.client.request.start');
  start.subscribe(listener);
  return () => { start.unsubscribe(listener); for (const cleanup of [...cleanups]) cleanup(); };
}

const output = process.env.WORKBENCH_TRANSPORT_DIAGNOSTICS;
if (output) {
  const repo = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const parent = fs.realpathSync(path.dirname(path.resolve(output)));
  const relative = path.relative(repo, parent);
  if (!(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('transport diagnostics must be outside checkout');
  const file = path.join(parent, path.basename(output));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  observeTransport(record => fs.writeSync(fd, `${JSON.stringify(record)}\n`));
}

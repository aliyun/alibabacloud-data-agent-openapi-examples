import type { Plugin, ProxyOptions } from 'vite';

const API_PATH = /^\/(?:api|d)(?:\/|\?|$)/;

/** LAN clients use one origin; only Vite is exposed, the backend stays loopback-only. */
export function lanApiProxy(target: string): Plugin {
  const targetOrigin = new URL(target).origin;
  const proxy: ProxyOptions = {
    target,
    changeOrigin: true, // Preserve the backend's localhost Host guard.
    timeout: 0,
    proxyTimeout: 0, // Prompt/NDJSON and SSE must not inherit a short proxy timeout.
    configure(server) {
      server.on('proxyReq', (outgoing, incoming) => {
        // configureServer rejects cross-origin API requests before they reach here.
        // Spring validates Origin against the rewritten Host even for same-origin POSTs.
        if (incoming.headers.origin) outgoing.setHeader('origin', targetOrigin);
      });
    },
  };
  return {
    name: 'data-agent-lan-api',
    apply: 'serve',
    config: () => ({ server: { proxy: { '^/(api|d)(/|\\?|$)': proxy } } }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!API_PATH.test(req.url ?? '')) return next();
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'LAN API requests must come from this page origin' }));
          return;
        }
        next();
      });
    },
  };
}

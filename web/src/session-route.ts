/** Read canonical paths, retaining compatibility with previously shared query links. */
export function sessionIdFromLocation(): string | undefined {
  const match = /^\/session\/([^/]+)\/?$/.exec(window.location.pathname);
  if (match) {
    try { return decodeURIComponent(match[1]!); } catch { return undefined; }
  }
  return new URLSearchParams(window.location.search).get('session') || undefined;
}

export function writeSessionRoute(sessionId: string | undefined, replace = false): void {
  const url = new URL(window.location.href);
  url.pathname = sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/';
  url.searchParams.delete('session');
  url.hash = '';
  if (url.href !== window.location.href) {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
  }
}

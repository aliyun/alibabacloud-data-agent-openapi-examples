// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { sessionIdFromLocation, writeSessionRoute } from '../../src/session-route';

beforeEach(() => window.history.replaceState(null, '', '/'));
it('writes path routes with the real ID, preserves other query parameters and removes hash', () => {
  window.history.replaceState(null, '', '/?theme=dark&session=old#old');
  writeSessionRoute('real-session-id');
  expect(window.location.pathname).toBe('/session/real-session-id');
  expect(window.location.search).toBe('?theme=dark');
  expect(window.location.hash).toBe('');
  expect(sessionIdFromLocation()).toBe('real-session-id');
  writeSessionRoute(undefined);
  expect(window.location.pathname).toBe('/');
});
it('restores path IDs on reload and migrates old query links', () => {
  window.history.replaceState(null, '', '/?session=real-id');
  writeSessionRoute(sessionIdFromLocation(), true);
  expect(window.location.pathname).toBe('/session/real-id');
  expect(sessionIdFromLocation()).toBe('real-id');
  window.history.replaceState(null, '', '/session/%broken');
  expect(sessionIdFromLocation()).toBeUndefined();
});

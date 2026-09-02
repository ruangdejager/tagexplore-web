import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import type { AuthUser } from '../api.js';

export type AuthStatus = 'checking' | 'anonymous' | 'authed';

/**
 * Who is logged in, backed by the session cookie the server already set — this
 * hook asks `/api/auth/me` once on load rather than inferring anything from
 * client-side state, so a page refresh, an expired session, or logging in from
 * another tab all resolve to the truth.
 */
export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchCurrentUser()
      .then((res) => {
        if (cancelled) return;
        setUser(res.user);
        setStatus(res.user ? 'authed' : 'anonymous');
      })
      .catch(() => {
        if (!cancelled) setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (kind: 'login' | 'signup', username: string, password: string): Promise<boolean> => {
      setError(null);
      try {
        const res = kind === 'login' ? await api.login(username, password) : await api.signup(username, password);
        setUser(res.user);
        setStatus('authed');
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not sign in.');
        return false;
      }
    },
    [],
  );

  const login = useCallback((u: string, p: string) => submit('login', u, p), [submit]);
  const signup = useCallback((u: string, p: string) => submit('signup', u, p), [submit]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  return { status, user, error, login, signup, logout, clearError: () => setError(null) };
}

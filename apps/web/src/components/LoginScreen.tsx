import { useState } from 'react';
import type { useAuth } from '../state/useAuth.js';

interface Props {
  auth: ReturnType<typeof useAuth>;
}

/**
 * The whole screen for anyone not signed in — there is no demo view to browse
 * first. Username and password only: no email to reserve, and no reset flow
 * that would need one to work.
 */
export function LoginScreen({ auth }: Props): JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const changeMode = (next: 'login' | 'signup'): void => {
    auth.clearError();
    setMode(next);
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    await (mode === 'login' ? auth.login(username, password) : auth.signup(username, password));
    setBusy(false);
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="mark" style={{ marginBottom: 18 }}>
          Tag<span>·</span>Explore
        </div>

        <div className="modal-tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => changeMode('login')}>
            Log in
          </button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => changeMode('signup')}>
            Sign up
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="modal-form">
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              minLength={3}
              maxLength={32}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={8}
              required
            />
          </label>

          {mode === 'signup' && (
            <p className="modal-hint">
              At least 8 characters. Signing up lets an admin know you're waiting — you'll see data once they put you
              in an organisation.
            </p>
          )}
          {auth.error && <p className="modal-error">{auth.error}</p>}

          <button type="submit" className="button-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

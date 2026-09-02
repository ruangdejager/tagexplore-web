import { useState } from 'react';

interface Props {
  mode: 'login' | 'signup';
  error: string | null;
  onModeChange: (mode: 'login' | 'signup') => void;
  onSubmit: (username: string, password: string) => Promise<boolean>;
  onClose: () => void;
}

/** Username and password only — no email to reserve, and no reset flow that
 *  would need one to work. */
export function AuthModal({ mode, error, onModeChange, onSubmit, onClose }: Props): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    const ok = await onSubmit(username, password);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => onModeChange('login')}>
            Log in
          </button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => onModeChange('signup')}>
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
              At least 8 characters. A new account can see nothing until an admin puts it in an organisation.
            </p>
          )}
          {error && <p className="modal-error">{error}</p>}

          <button type="submit" className="button-primary" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

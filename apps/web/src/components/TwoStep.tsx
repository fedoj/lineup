import { useEffect, useState } from 'react';
import { api, type TwoStep } from '../lib/api';

/**
 * Account › Two-step sign-in (Fady, 10/19): optional. Turned on, every sign-in
 * also asks for a code sent by text message; the first time, the person adds
 * their phone number. Hidden where it isn't set up.
 */
export default function TwoStepCard() {
  const [data, setData] = useState<TwoStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .twoStep()
      .then(setData)
      .catch(() => setData({ available: false }));
  }, []);

  if (!data || !data.available) return null;

  async function act(action: 'on' | 'off' | 'reset-phone', done: string) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      setData(await api.twoStepAction(action));
      setMsg(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const signInAgain = `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent('/.auth/login/lineup?post_login_redirect_uri=/account')}`;

  return (
    <section className="card" id="two-step">
      <div className="card-head">
        <h2>Two-step sign-in</h2>
        <span className={`pill${data.enabled ? ' good' : ''}`}>{data.enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="note">
        Extra protection for your account. When it's on, signing in also asks for a 6-digit code we text to your phone,
        so nobody can get in with just your password. The first time, you add your mobile number.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={busy}
          onChange={(e) =>
            void act(
              e.target.checked ? 'on' : 'off',
              e.target.checked
                ? 'Turned on. The next time you sign in, you’ll add your phone number and get a code by text.'
                : 'Turned off. Signing in asks only for your password again.',
            )
          }
        />
        Ask for a code by text message when I sign in
      </label>
      {data.enabled && (
        <>
          <p className="sub">
            {data.phone
              ? `Codes go to ${data.phone}.`
              : 'You haven’t added a phone yet. You’ll be asked for it the next time you sign in.'}
          </p>
          <div className="row">
            <a className="btn btn-sm" href={signInAgain}>
              {data.phone ? 'Sign in again now' : 'Set it up now (sign in again)'}
            </a>
            {data.phone && (
              <button
                type="button"
                className="btn ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  if (confirm('Use a different phone? Your current number is removed, and the next sign-in asks for a new one.')) {
                    void act('reset-phone', 'Your number was removed. The next time you sign in, you’ll add the new one.');
                  }
                }}
              >
                Use a different phone
              </button>
            )}
          </div>
        </>
      )}
      {msg && (
        <p className="note" role="status">
          {msg}
        </p>
      )}
      {error && <p className="danger-text">{error}</p>}
    </section>
  );
}

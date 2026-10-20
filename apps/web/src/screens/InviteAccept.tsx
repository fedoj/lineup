import { useEffect, useState } from 'react';
import { api, type InvitePreview } from '../lib/api';

/**
 * Landing page for an invite link, /invite/<token>.
 *
 * Works signed out: it shows what the invite is for, then sends the person
 * through sign-up or sign-in and straight back here to accept.
 */
export default function InviteAccept({
  token,
  signedIn,
  onAccepted,
}: {
  token: string;
  signedIn: boolean;
  onAccepted: (r: { teamId: string | null; regionId: string | null; orgId: string | null }) => void;
}) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .invitePreview(token)
      .then(setPreview)
      .catch((e) => setError(e instanceof Error ? e.message : 'This invite link is not valid.'));
  }, [token]);

  const back = encodeURIComponent(`/invite/${token}`);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      onAccepted(await api.acceptInvite(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept this invite.');
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <section className="card invite-card">
        <div className="brand">
          <span className="ball">⚽</span>
          <div>
            <h1>Lineup</h1>
            <span className="sub">You have been invited</span>
          </div>
        </div>

        {error && (
          <p className="danger-text">
            {error}{' '}
            {signedIn && (
              <a href={`/.auth/logout?post_logout_redirect_uri=${back}`}>Sign out and try again</a>
            )}
          </p>
        )}
        {!preview && !error && <p className="note">Loading invite…</p>}

        {preview && (
          <>
            <h2>
              Join {preview.scopeName} as {preview.roleLabel}
            </h2>
            <p className="note">
              {preview.inviter} invited {preview.emailHint}.
            </p>

            {preview.status === 'valid' ? (
              signedIn ? (
                <>
                  <button type="button" className="btn btn-lg" disabled={busy} onClick={accept}>
                    {busy ? 'Joining…' : 'Accept invite'}
                  </button>
                  <p className="note">
                    You are signed in. Not the invited person?{' '}
                    <a href={`/.auth/logout?post_logout_redirect_uri=${back}`}>Sign out</a> and open
                    the link again with the invited account.
                  </p>
                </>
              ) : (
                <>
                  <p className="note">
                    New to Lineup? Choose <strong>Create an account</strong> and sign up with the
                    invited email ({preview.emailHint}). You will set your password there.
                  </p>
                  <div className="auth-actions">
                    <a className="btn btn-lg" href={`/.auth/login/lineupsignup?post_login_redirect_uri=${back}`}>
                      Create an account
                    </a>
                    <a className="btn btn-lg ghost" href={`/.auth/login/lineup?post_login_redirect_uri=${back}`}>
                      I already have one
                    </a>
                  </div>
                </>
              )
            ) : (
              <p className="note warn">
                {preview.status === 'accepted'
                  ? 'This invite has already been used.'
                  : preview.status === 'expired'
                    ? 'This invite has expired. Ask for a new one.'
                    : 'This invite was withdrawn.'}
              </p>
            )}
          </>
        )}

        <p className="note">
          <a href="/">Go to Lineup</a>
        </p>
      </section>
    </main>
  );
}

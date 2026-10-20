import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { LEGAL_EFFECTIVE, PrivacyBody, TermsBody } from '../screens/Legal';

/**
 * Shown once after sign-in, and again whenever the terms change. The app is
 * for adults, so confirming age is required alongside accepting the terms.
 * The Terms of Use and Privacy Policy are shown in a box that has to be
 * scrolled to the end before "I agree" can be ticked (Fady, 10/17).
 */
export default function TermsGate({ version, onAccepted }: { version: string; onAccepted: () => void }) {
  const [over18, setOver18] = useState(false);
  const [agree, setAgree] = useState(false);
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const checkRead = useCallback(() => {
    const el = boxRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setRead(true);
  }, []);
  // A tall screen may show the whole text without any scrolling.
  useEffect(() => {
    checkRead();
    window.addEventListener('resize', checkRead);
    return () => window.removeEventListener('resize', checkRead);
  }, [checkRead]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api.acceptTerms({ version, over18, agree });
      onAccepted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your answer');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <section className="card terms-gate">
        <div className="brand">
          <span className="ball">⚽</span>
          <div>
            <h1>Lineup</h1>
            <span className="sub">Before you continue</span>
          </div>
        </div>
        <p>
          Lineup is for adults: coaches, team administrators, parents and guardians. It is free to use
          and supported by ads. Please read the Terms of Use and Privacy Policy below, then confirm
          the following to continue.
        </p>
        <div
          ref={boxRef}
          className="terms-scroll legal-doc"
          onScroll={checkRead}
          tabIndex={0}
          role="document"
          aria-label="Terms of Use and Privacy Policy"
        >
          <h2>Terms of Use</h2>
          <p className="note">Effective {LEGAL_EFFECTIVE}</p>
          <TermsBody />
          <h2 className="terms-scroll-next">Privacy Policy</h2>
          <p className="note">Effective {LEGAL_EFFECTIVE}</p>
          <PrivacyBody />
          <p className="note terms-scroll-end">End of the Terms of Use and Privacy Policy.</p>
        </div>
        <p className={`note terms-scroll-hint${read ? ' done' : ''}`} aria-live="polite">
          {read ? '✓ You’ve reached the end.' : 'Scroll to the end of the terms to continue ↓'}
        </p>
        <label className="check">
          <input type="checkbox" checked={over18} onChange={(e) => setOver18(e.target.checked)} />
          <span>I am 18 years of age or older.</span>
        </label>
        <label className={`check${read ? '' : ' locked'}`}>
          <input
            type="checkbox"
            checked={agree}
            disabled={!read}
            onChange={(e) => setAgree(e.target.checked)}
          />
          <span>
            I have read and agree to the Terms of Use and Privacy Policy, including that the app shows
            advertising.
          </span>
        </label>
        {error && <p className="danger-text">{error}</p>}
        <div className="row">
          <button type="button" className="btn" disabled={busy || !over18 || !agree || !read} onClick={accept}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
          <a className="btn ghost" href="/.auth/logout">
            Sign out
          </a>
        </div>
      </section>
    </main>
  );
}
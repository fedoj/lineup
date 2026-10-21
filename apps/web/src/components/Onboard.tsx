import { useEffect, useState } from 'react';
import { api, type MySignups } from '../lib/api';

export type OnboardChoice = 'parent' | 'coach';

/**
 * The first question for someone who signed up on their own, with no team
 * yet (Shadi, 10/20): a parent signing a child up with a league or
 * tournament, or a coach with a team of their own. Parents never see team
 * creation; coaches get the new team form below this card.
 */
export default function Onboard({
  choice,
  onChoose,
  onCode,
}: {
  choice: OnboardChoice | null;
  onChoose: (c: OnboardChoice | null) => void;
  /** A league or tournament sign-up code to use on Account. */
  onCode: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [mine, setMine] = useState<MySignups | null>(null);

  useEffect(() => {
    api
      .mySignups()
      .then((m) => {
        setMine(m);
        // Already signed a child up: they are a parent, no need to ask.
        if (m.signups.length > 0 && choice === null) onChoose('parent');
      })
      .catch(() => setMine(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (choice === null) {
    return (
      <section className="card onboard">
        <h2>Welcome to Lineup! 👋</h2>
        <p className="note">Tell us what brings you here and we'll take you to the right place.</p>
        <div className="onboard-choices">
          <button type="button" className="onboard-choice" onClick={() => onChoose('parent')}>
            <span aria-hidden="true">👪</span>
            <strong>I'm a parent</strong>
            <span className="sub">My child plays in a league or tournament</span>
          </button>
          <button type="button" className="onboard-choice" onClick={() => onChoose('coach')}>
            <span aria-hidden="true">🧢</span>
            <strong>I coach my own team</strong>
            <span className="sub">A team that's not part of a league or region on Lineup</span>
          </button>
        </div>
      </section>
    );
  }

  if (choice === 'coach') {
    return (
      <p className="note onboard-back">
        Here to sign up a child instead?{' '}
        <button type="button" className="linkish" onClick={() => onChoose('parent')}>
          I'm a parent
        </button>
      </p>
    );
  }

  const signups = mine?.signups ?? [];
  return (
    <section className="card onboard">
      <h2>Signing your child up 👪</h2>
      {signups.length > 0 && (
        <p className="note">
          You're in! {signups.map((s) => `${s.childName} (${s.competitionName ?? s.regionName})`).join(', ')}{' '}
          {signups.length === 1 ? 'is' : 'are'} signed up. The league places players on teams, and you'll get a
          notification the moment it happens.
        </p>
      )}
      <p className="note">
        Your league or tournament gives you a sign-up code (like SYSO-CYPRESS154) or a link. Enter the code here
        {signups.length > 0 ? ' to sign up another child or for another league' : ''}.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const c = code.trim();
          if (c) onCode(c);
        }}
      >
        <input
          aria-label="Sign-up code"
          placeholder="Sign-up code"
          value={code}
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="btn" disabled={!code.trim()}>
          Continue
        </button>
      </form>
      <p className="note onboard-back">
        Coaching a team of your own?{' '}
        <button type="button" className="linkish" onClick={() => onChoose('coach')}>
          Set up my team
        </button>
      </p>
    </section>
  );
}

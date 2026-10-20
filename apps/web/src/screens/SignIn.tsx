import type { ThemeChoice } from '../lib/theme';
import ThemeToggle from '../components/ThemeToggle';
import PlanPicker from '../components/PlanPicker';

/**
 * Both actions hit the same Entra External ID user flow. The "lineupsignup"
 * provider is the same app registration pointed at an authorize endpoint
 * carrying `prompt=create`, so "Create account" lands straight on sign-up.
 */
const SIGN_IN_URL = '/.auth/login/lineup?post_login_redirect_uri=/';
// A new account lands on "Choose the plan that's right for you".
const SIGN_UP_URL = '/.auth/login/lineupsignup?post_login_redirect_uri=/plans';

const FEATURES: Array<{ icon: string; title: string; body: string }> = [
  {
    icon: '📅',
    title: 'Game schedules',
    body: 'League games scheduled once from the top land on every team, with friendlies alongside.',
  },
  {
    icon: '🎉',
    title: 'Events',
    body: 'Team parties, picture day, fundraisers and tournaments, with reminders before each one.',
  },
  {
    icon: '🗓️',
    title: 'Shared calendars',
    body: 'One calendar for each team, region and organization, shared with families in a link.',
  },
  {
    icon: '✅',
    title: 'Player check-in and RSVP',
    body: 'Families answer for games, practices and events, so coaches know who is coming.',
  },
  {
    icon: '💬',
    title: 'Team chats',
    body: 'Chats for everyone, staff and coaches, with polls and photos.',
  },
  {
    icon: '🧭',
    title: 'Coach lineups',
    body: 'Formations and fair rotation, so every player gets their fair share of minutes.',
  },
  {
    icon: '📈',
    title: 'Player stat tracking',
    body: 'Goals, assists, cards and more, rolled up into team, region and organization standings.',
  },
  {
    icon: '🟨',
    title: 'Referees',
    body: 'Referees sign up for league games and record the official result from the sideline.',
  },
];

export default function SignIn({
  theme,
  onThemeChange,
  notice,
}: {
  theme: ThemeChoice;
  onThemeChange: (c: ThemeChoice) => void;
  /** Why the sign-in screen is showing, e.g. the session expired. */
  notice?: string;
}) {
  // After an expired session, or arriving on a link to a page (such as Plans
  // opened from the app), signing in returns to that page.
  const back = location.pathname + location.search;
  const signInUrl =
    notice || location.pathname !== '/'
      ? `/.auth/login/lineup?post_login_redirect_uri=${encodeURIComponent(back)}`
      : SIGN_IN_URL;
  return (
    <main className="auth">
      <div className="auth-top">
        <div className="brand">
          <span className="ball" aria-hidden="true">
            ⚽
          </span>
          <div>
            <h1>Lineup</h1>
            <span className="sub">Schedules · team chat · lineups · stats</span>
          </div>
        </div>
        <ThemeToggle choice={theme} onChange={onThemeChange} />
      </div>

      <div className="auth-grid">
        <section className="auth-card">
          {notice && (
            <p className="auth-notice" role="alert">
              <span aria-hidden="true">⏱️</span> {notice}
            </p>
          )}
          <span className="eyebrow">Organizations · regions · clubs · teams · coaches · parents</span>
          <h2 className="auth-title">
            Empower your league,
            <br />
            club and team.
          </h2>
          <p className="auth-lede">
            One app for organizations, regions, clubs, coaches and parents: game schedules and events, shared calendars,
            player check-in and RSVP, team chats, coach lineups and player stats. On the sideline, from your phone.
          </p>

          <div className="auth-actions">
            <a className="btn btn-lg" href={SIGN_UP_URL}>
              Create an account
            </a>
            <a className="btn btn-lg ghost" href={signInUrl}>
              Sign in
            </a>
          </div>

          <p className="auth-switch">
            New here? <a href={SIGN_UP_URL}>Create an account</a> with your email address — it takes
            about a minute.
          </p>

          <p className="note auth-note">
            <span aria-hidden="true">🔒</span> We only store your name and email address. No social media
            required.
          </p>

          <p className="note auth-note">
            Lineup is for adults 18 and over and is supported by ads. By creating an account you agree
            to the <a href="/terms">Terms of Use</a> and <a href="/privacy">Privacy Policy</a>.
          </p>
        </section>

        <aside className="auth-aside" aria-label="What you get">
          <ul className="feature-list">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="feature-icon" aria-hidden="true">
                  {f.icon}
                </span>
                <div>
                  <strong>{f.title}</strong>
                  <p>{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      <PlanPicker signUpUrl={SIGN_UP_URL} signInUrl={SIGN_IN_URL} />
    </main>
  );
}

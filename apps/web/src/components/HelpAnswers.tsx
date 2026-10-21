import { useMemo, useState } from 'react';

/**
 * Answers to common questions, searchable, above the support form (Fady,
 * 10/20): most people find what they need here before sending a request.
 */

interface Qa {
  q: string;
  a: string;
  /** Extra words people might search with. */
  tags?: string;
}

const ANSWERS: Qa[] = [
  {
    q: 'How do I sign my child up for a league or tournament?',
    a: 'Open the sign-up link (or enter the sign-up code) your league or tournament shared. Create your account, then register your children. The league’s staff approve each child and place them on a team, and you are linked to your child automatically.',
    tags: 'register join code parent family',
  },
  {
    q: 'How do I say whether my child is going to a game or practice?',
    a: 'Open the Calendar, tap the game or practice, and choose Going or Not going. Coaches see the answers right away.',
    tags: 'rsvp attendance available absent',
  },
  {
    q: 'How do I turn on notifications on my phone?',
    a: 'Go to Account › The Lineup app and tap Turn on notifications, then allow them when your phone asks. On iPhone, add Lineup to your home screen first (Safari › Share › Add to Home Screen) and open it from there.',
    tags: 'push alerts android iphone',
  },
  {
    q: 'How do I put Lineup on my home screen like an app?',
    a: 'Account › The Lineup app shows the steps. On Android, Chrome’s menu › Install app. On iPhone, Safari › Share › Add to Home Screen.',
    tags: 'install pwa android iphone',
  },
  {
    q: 'How do I set the lineup for a game?',
    a: 'Open Match day and pick the game. Tap Auto formation for a fair lineup that shares the minutes, or place your players yourself. Every lineup is saved, so you can look back at what worked.',
    tags: 'formation positions match day fair play minutes',
  },
  {
    q: 'How do I create my own team?',
    a: 'In the menu, tap ＋ New team. It shows under My Own Teams. Add players yourself in Team & roster, or create a league or tournament on the Games page and share its sign-up link so parents register their children.',
    tags: 'new team coach my own teams',
  },
  {
    q: 'How do I invite an assistant coach or a team parent?',
    a: 'Open the team’s Team & roster page, tap Team members, and invite them by email. They get a link to accept.',
    tags: 'invite staff assistant parent email',
  },
  {
    q: 'Where are league and tournament games scheduled?',
    a: 'On the Games page, inside the league or tournament. Friendlies can also be added from a team’s Calendar.',
    tags: 'schedule friendly match fixture',
  },
  {
    q: 'How do I design my child’s avatar?',
    a: 'Open your child’s team, go to Team & roster, tap your child and choose Design avatar. Only a parent linked to the child can design it.',
    tags: 'player card picture cartoon',
  },
  {
    q: 'How do I referee games?',
    a: 'Ask your organization or region for its referee code or link. Then go to Account and tap Enter a referee code to see the games you can sign up for.',
    tags: 'referee ref code',
  },
  {
    q: 'How do I change or cancel my plan?',
    a: 'Go to Account and use Manage billing. Cancelling keeps your plan until the end of the current term. To ask for a refund, cancel first, then choose Refund here in Help & support.',
    tags: 'subscription billing cancel refund upgrade',
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes, and no card is needed. Start it from Account.',
    tags: 'trial free',
  },
  {
    q: 'How do I turn on two-step sign-in?',
    a: 'Go to Account and turn on two-step sign-in. After that, signing in also asks for a code sent to your phone by text message.',
    tags: 'security sms code password',
  },
  {
    q: 'How do I download my data or close my account?',
    a: 'Go to Account › Your data. You can export a copy of a team, or close your account there.',
    tags: 'export delete privacy',
  },
  {
    q: 'Does Lineup ask for my location?',
    a: 'No. Lineup never asks for your location.',
    tags: 'privacy gps',
  },
];

export default function HelpAnswers() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const hits = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (!words.length) return ANSWERS.map((qa, i) => ({ qa, i }));
    return ANSWERS.map((qa, i) => ({ qa, i })).filter(({ qa }) => {
      const text = `${qa.q} ${qa.a} ${qa.tags ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [query]);

  return (
    <section className="card help-answers" data-fold-open>
      <h2>Answers to common questions</h2>
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(null);
        }}
        placeholder="Search, for example “notifications” or “sign up”"
        aria-label="Search the answers"
      />
      {hits.length === 0 ? (
        <p className="note">No answer matches that. Send us a request below and we’ll help.</p>
      ) : (
        <ul className="faq">
          {hits.map(({ qa, i }) => (
            <li key={i} className={open === i ? 'open' : ''}>
              <button type="button" className="faq-q" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                <span>{qa.q}</span>
                <span className="person-caret" aria-hidden="true">
                  {open === i ? '▾' : '▸'}
                </span>
              </button>
              {open === i && <p className="faq-a">{qa.a}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="sub">Still stuck? Open “Ask us something” below.</p>
    </section>
  );
}

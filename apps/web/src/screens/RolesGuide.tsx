/**
 * "Who does what" knowledge base page, /help/roles. Public, like the legal
 * pages. It documents the proposed roles, permissions and plans so coaches,
 * parents and admins can see what each role can do before the permission
 * model is rebuilt to match. Keep it in step with the RBAC proposal on the
 * support ticket until it is confirmed and implemented.
 */

const ROLES: Array<{ role: string; who: string; can: string[]; cannot: string[] }> = [
  {
    role: 'Coach',
    who: 'Runs one or more teams.',
    can: [
      'Create teams and games (league and friendly)',
      'Build lineups and run match day',
      'Approve or reject the assistant coach’s lineup changes, and let the assistant change a game’s lineup without approval',
      'Manage results and stats, and edit player numbers and positions',
      'Rate players (player evaluation), on any plan',
      'On a team of their own: add and remove players, and invite and remove team members',
      'Set the practice schedule and track attendance',
      'Share the team calendar and stats',
      'Use team chat',
    ],
    cannot: [
      'See other teams unless they hold an organization or region role',
      'Add players or invite people on a team in an organization or region: its staff do that',
    ],
  },
  {
    role: 'Assistant coach',
    who: 'Helps the coach run a team.',
    can: [
      'Match day, stats, practices, player evaluation and chat, like the coach',
      'Mark players absent at any time',
      'Propose formation and lineup changes before a game (the coach approves them), and change the lineup straight away during the game',
    ],
    cannot: ['Create teams', 'Add or remove players', 'Invite or remove team members', 'Change a lineup before the game without the coach’s approval, unless the coach allowed it for that game'],
  },
  {
    role: 'Team parent (team mom / manager)',
    who: 'Organizes the team off the field.',
    can: [
      'See the calendar and standings',
      'Run the snack schedule',
      'Create team events (team party, picture day) and share the calendar',
      'Track practice attendance (marking it by hand on the Parent plan)',
      'See who is going and not going to games and practices',
      'Use team chat',
    ],
    cannot: ['Open match day or stats', 'Change the roster, games or results'],
  },
  {
    role: 'Parent',
    who: 'Follows their own child on the team.',
    can: [
      'Read the calendar and standings',
      'RSVP for their child to games, practices and events as soon as they are scheduled (not going: sick, injured or other)',
      'Get reminders a week and two days before games and events, and two days before practices',
      'Use team chat',
    ],
    cannot: ['Edit anything on the team', 'See other teams'],
  },
  {
    role: 'Region director and region admin',
    who: 'Oversee every team in a region. The director is the top role in the region.',
    can: [
      'See everything from the region down: all teams, standings, stats and team chats',
      'Add and remove players and invite people on every team in the region',
      'Region director only: rename the region and invite region admins',
      'All paid features, when the region or organization is on a paid plan',
    ],
    cannot: [
      'See other regions unless they also hold an organization role',
      'Region admins cannot rename the region',
    ],
  },
  {
    role: 'Scheduler',
    who: 'Schedules the games of an organization’s or region’s leagues and tournaments. Given by its admins and directors.',
    can: [
      'Schedule and edit games in the leagues and tournaments that already exist: dates, times, places and fields',
      'Add and change the field maps',
      'See the teams and games they schedule',
    ],
    cannot: [
      'Create or delete leagues and tournaments, or delete games',
      'Approve or place players, invite people, or change teams and rosters',
      'See billing',
    ],
  },
  {
    role: 'Organization director and organization admin',
    who: 'Run the whole organization. Whoever starts the organization is its director.',
    can: [
      'See everything in the organization: all regions, teams, standings, stats and team chats',
      'Set up regions and teams, and invite region and team staff',
      'Organization director only: rename the organization and invite organization admins',
      'All paid features, on the Organization plan',
    ],
    cannot: ['Organization admins cannot rename the organization or its regions'],
  },
  {
    role: 'Referee',
    who: "Referees league games for an organization or region. Joins with the organization's referee code or link.",
    can: [
      'Sign up for any league game in the organization as the main referee or one of two assistants, first come first served',
      'Pick a favorite region to see its games first, and give up a spot before the game',
      "Main referee: open the match screen with both rosters and the coaches' lineups filled in, change who starts, record subs, goals and cards with the minute, and submit the final score",
      "The referee's final score is the official result: it replaces the coaches' score in the standings",
      'Assistant referees see the match screen but do not record',
      'Running game clock on the match screen with Referee Premium ($4.99 / year)',
    ],
    cannot: [
      'See team chats, rosters or stats outside the games they referee',
      "Referee a team's own games (friendlies and My Own Teams)",
    ],
  },
];

const PLANS: Array<[string, string, string]> = [
  ['Free', '$0', 'Coaches: up to 2 teams and 12 games per team each season (friendlies included). Teams stay independent of any organization or region.'],
  ['Coach', '$9.99 / year', "For coaches and assistant coaches: up to 6 teams and 20 games per team each season, every paid team feature, and your own child's stats and player card."],
  ['Parent', '$4.99 / year', "For every parent, team parents included: your own child's stats and player card, designing their avatar, organization and region standings, photos, polls and message editing in team chat, and adding games and events to your calendar. Team parents also add flyers to the events they create and take practice attendance by hand."],
  ['Referee', '$4.99 / year', 'For referees: the running game clock on the referee match screen. Signing up for games and recording results is free.'],
  ['Region', '$199 / year', 'A region on its own, not part of an organization: every paid feature for its admins and directors, up to 20 teams with 20 games each.'],
  ['Organization', '$299 / year', 'Up to 20 regions and 200 teams, shared across the regions however you need (20 games per team). Every paid feature for organization and region admins and directors, with top-down visibility including team chats.'],
  ['Organization Plus', '$499 / year', 'Everything in Organization, for up to 40 regions and unlimited teams.'],
];

const FEATURES: Array<[string, string, string]> = [
  ['Teams and games', '2 teams, 12 games each per season', 'Coach: 6 teams, 20 games each per season. Region: 20 teams. Organization: 20 or 40 regions. A season runs August to July'],
  ['Stats you can track', 'Goals, assists, yellow and red cards', 'All stats, including your own custom stats'],
  ['Match day clock (start and stop)', '-', 'Included'],
  ['Share stats link', 'Expires after 1 day', 'Up to 30 days'],
  ['Share calendar link', 'Expires after 7 days', 'Up to 90 days'],
  ['Add a game, practice or event to your own calendar', '–', 'One tap'],
  ['Team events (party, picture day, fundraiser)', 'Create and share on the calendar', 'Attach a flyer (Parent, Coach and Organization plans)'],
  ['Snack schedule', 'Included', 'Included'],
  ['Team chat', 'Messages kept for 3 months; see photos; vote in polls', 'Send photos; edit and delete your messages; create polls'],
  ['Practice schedule', 'Up to 100 days per season', 'Longer seasons'],
  ['Practice attendance', 'Automatic from parent check-ins', 'Manual attendance tracking (Coach, Parent and Organization plans)'],
  ['Organization and region standings', '-', 'Included'],
  ['Ads', 'Shown', 'Removed'],
];

export default function RolesGuide() {
  return (
    <main className="wrap legal">
      <header className="bar">
        <a className="brand" href="/" style={{ textDecoration: 'none' }}>
          <span className="ball">⚽</span>
          <div>
            <h1>Lineup</h1>
            <span className="sub">Who does what</span>
          </div>
        </a>
      </header>

      <article className="card legal-doc kb">
        <h2>Who does what in Lineup</h2>
        <p className="note warn">
          Plans and roles confirmed October 9, 2026. Some features listed here, such as team chat,
          practices and check-ins, are still being built.
        </p>

        <h3>How visibility works</h3>
        <ul>
          <li>Everyone sees only what their role allows, starting from where they sit.</li>
          <li>
            Organization and region staff on the Organization plan see everything below them,
            including standings. A coach, parent or team parent inside an organization sees where
            their team sits, and can open the organization and region standings with their own paid
            plan, but nothing else.
          </li>
          <li>
            Paid features belong to the person who pays for them. Being invited by an organization
            or region on a paid plan does not unlock paid features for coaches, parents or team
            parents; they subscribe on their own.
          </li>
          <li>
            A coach's own teams (My Own Teams) stay theirs. Joining an organization adds the teams the
            organization set up; it does not move existing teams into it.
          </li>
          <li>A team can have more than one team parent. The coach assigns them.</li>
          <li>Tapping any paid feature opens the plans page with a side-by-side comparison.</li>
        </ul>

        <h3>Roles</h3>
        <div className="kb-roles">
          {ROLES.map((r) => (
            <section key={r.role} className="kb-role">
              <h4>{r.role}</h4>
              <p className="note">{r.who}</p>
              <ul>
                {r.can.map((c) => (
                  <li key={c}>✓ {c}</li>
                ))}
                {r.cannot.map((c) => (
                  <li key={c} className="kb-no">✕ {c}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <h3>Plans</h3>
        <table className="kb-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Price</th>
              <th>Who it is for</th>
            </tr>
          </thead>
          <tbody>
            {PLANS.map(([p, price, desc]) => (
              <tr key={p}>
                <td>{p}</td>
                <td>{price}</td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Free trials, no card needed: organizations and regions get 30 days, with the person who starts
          the trial as director; coaches get 7 days of the Coach plan. If an organization or region trial
          ends without a subscription it is paused for everyone and kept for 30 days, so subscribing brings
          it back as it was.
        </p>

        <h3>Free and paid features</h3>
        <table className="kb-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Free</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {FEATURES.map(([f, free, paid]) => (
              <tr key={f}>
                <td>{f}</td>
                <td>{free}</td>
                <td>{paid}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="note legal-links">
          <a href="/terms">Terms of Use</a> · <a href="/privacy">Privacy Policy</a> ·{' '}
          <a href="/">Back to Lineup</a>
        </p>
      </article>
    </main>
  );
}

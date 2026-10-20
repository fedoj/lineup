import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FAMILY_ROLES, isFamilyOnly, type Game, type Player, type Role, type Team } from '@lineup/shared';
import {
  api,
  ApiError,
  apiPath,
  forgetDeviceCache,
  onSessionExpired,
  peek,
  setDeviceCacheOwner,
  type Hierarchy,
  type InviteCreated,
  type MeResponse,
  type StandingsScope,
} from './lib/api';
import { useTheme } from './lib/theme';
import ThemeToggle from './components/ThemeToggle';
import SignIn from './screens/SignIn';
import GlobalSearch from './components/GlobalSearch';
import InviteShare from './components/InviteShare';
import { ImpersonationBanner } from './components/Impersonation';
import ScopeTeams, { JoinHelp } from './screens/ScopeTeams';
import { FeaturesProvider } from './lib/features';
import { lazyScreen } from './lib/lazyScreen';
import NotificationBell from './components/NotificationBell';
import { MyPlayerRating, PlayerCardsGrid } from './components/PlayerEvaluation';
import { ArchivedTeamBanner, ArchiveTeamCard } from './components/TeamArchive';
import RosterImport from './components/RosterImport';
import GettingStarted, { guideHidden, setGuideHidden, TourTip, type GuideStep, type TourTarget } from './components/GettingStarted';
import PlanPicker, { PENDING_TRIAL_KEY } from './components/PlanPicker';
import { PLAN_FOR_KEY, recommendPlan } from './lib/planFor';
import InviteAccept from './screens/InviteAccept';
import TeamSetup, { NewTeam } from './screens/TeamSetup';
import MenuDrawer from './components/MenuDrawer';
import AdSlot from './components/AdSlot';
import { Logo } from './components/Logo';
import { TrialEnded } from './components/Trial';
import { PENDING_JOIN_KEY, PENDING_REF_KEY } from './lib/pendingKeys';
import RefereeSettings from './components/RefereeSettings';
import { startUsageTracking, trackPage } from './lib/usage';
import { InstallBanner, NotifyAsk } from './components/InstallCard';

// The team's tabs other than Standings load on first use, and are fetched in
// the background once the app is idle, so they still open instantly.
const TeamCalendar = lazyScreen(() => import('./screens/TeamCalendar'));
const Calendar = lazyScreen(() => import('./screens/Calendar'));
const TeamChat = lazyScreen(() => import('./screens/TeamChat'));
const MatchDay = lazyScreen(() => import('./screens/MatchDay'));
const Analytics = lazyScreen(() => import('./screens/Analytics'));
const Account = lazyScreen(() => import('./screens/Account'));
const Competitions = lazyScreen(() => import('./screens/Competitions'));
type CompetitionStandingsProps = Parameters<(typeof import('./screens/Competitions'))['CompetitionStandings']>[0];
const CompetitionStandings = lazyScreen<CompetitionStandingsProps>(() =>
  import('./screens/Competitions').then((m) => ({ default: m.CompetitionStandings })),
);
const PRELOAD = [Competitions, TeamCalendar, Calendar, TeamChat, MatchDay, Analytics, Account];

// Screens most people rarely open load on first use, which keeps the first
// download small. Each loads in the background while "Loading…" shows.
const Admin = lazy(() => import('./screens/Admin'));
const Support = lazy(() => import('./screens/Support'));
const Organization = lazy(() => import('./screens/Organization'));
const Referee = lazy(() => import('./screens/Referee'));
const RolesGuide = lazy(() => import('./screens/RolesGuide'));
const TermsOfUse = lazy(() => import('./screens/Legal').then((m) => ({ default: m.TermsOfUse })));
const PrivacyPolicy = lazy(() => import('./screens/Legal').then((m) => ({ default: m.PrivacyPolicy })));
// Carries the full Terms and Privacy text, so only loaded when acceptance is due.
const TermsGate = lazy(() => import('./components/TermsGate'));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<section className="card screen-loading">Loading…</section>}>{children}</Suspense>;
}

type Screen =
  | 'standings'
  | 'seasons'
  | 'competitions'
  | 'calendar'
  | 'teams'
  | 'chat'
  | 'matchday'
  | 'team'
  | 'analytics'
  | 'org'
  | 'settings'
  | 'signups'
  | 'account'
  | 'plans'
  | 'support'
  | 'referee'
  | 'admin';

/** What is selected in the menu: an organization, a region or one team. */
interface Selection {
  kind: StandingsScope;
  id: string;
}

/**
 * Tabs shown on the page for whatever is selected in the menu. Seasons and
 * tournaments stand on their own (Fady, 10/16): an organization or region
 * lands on its leagues and tournaments, and its Standings tab picks one of the
 * running ones. A team has no seasons or standings of its own; it lands on its
 * calendar, where those games show.
 */
const SCOPE_TABS: Array<[Screen, string]> = [
  ['seasons', 'Games & matches'],
  ['standings', 'Standings'],
  ['calendar', 'Calendar'],
  ['teams', 'Teams'],
];
const TEAM_TABS: Array<[Screen, string]> = [
  ['calendar', 'Calendar'],
  ['chat', 'Chat'],
  ['matchday', 'Match day'],
  ['analytics', 'Stats'],
  ['team', 'Team & roster'],
];

const PATHS: Partial<Record<Screen, string>> = {
  // The admin console has no address of its own: it opens only from the menu
  // for platform admins, and /admin redirects to the public roles guide.
  account: '/account',
  plans: '/plans',
  support: '/support',
  org: '/org',
  settings: '/settings',
  signups: '/signups',
  referee: '/referee',
  competitions: '/competitions',
  seasons: '/seasons',
  calendar: '/calendar',
  // Before 'team': screenFromPath matches by prefix, in this order.
  teams: '/teams',
  chat: '/chat',
  matchday: '/matchday',
  analytics: '/stats',
  team: '/team',
};

function screenFromPath(pathname: string): Screen {
  const hit = (Object.entries(PATHS) as Array<[Screen, string]>).find(([, p]) => pathname.startsWith(p));
  return hit ? hit[0] : 'standings';
}

/** Page names for the admin console's usage counts (Fady, 10/19). */
const PAGE_NAME: Record<Screen, string> = {
  standings: 'Standings',
  seasons: 'Games & matches',
  competitions: 'Games & matches',
  calendar: 'Calendar',
  teams: 'Teams',
  chat: 'Chat',
  matchday: 'Match day',
  team: 'Team & roster',
  analytics: 'Stats',
  org: 'Organization',
  settings: 'Settings',
  signups: 'Sign-ups',
  account: 'Account',
  plans: 'Plans',
  support: 'Help & support',
  referee: 'Referee',
  admin: 'Admin console',
};

function pathForScreen(next: Screen): string {
  return PATHS[next] ?? '/';
}

// A /ref/CODE link (an organization's referee sign-up) keeps its code through
// sign-in, then opens the Referee screen with the code filled in.
if (typeof location !== 'undefined' && location.pathname.startsWith('/ref/')) {
  const code = decodeURIComponent(location.pathname.slice('/ref/'.length)).replace(/\/+$/, '');
  if (code) localStorage.setItem(PENDING_REF_KEY, code);
  history.replaceState(null, '', '/referee');
}

// A /join/CODE link (shared by a region) keeps its code until the person has
// signed in, then opens Account where the code is already filled in.
if (typeof location !== 'undefined' && location.pathname.startsWith('/join/')) {
  const code = decodeURIComponent(location.pathname.slice('/join/'.length)).replace(/\/+$/, '');
  if (code) localStorage.setItem(PENDING_JOIN_KEY, code);
  history.replaceState(null, '', '/account');
}

export default function App() {
  const { choice: theme, setChoice: setTheme } = useTheme();

  // A shared card is a public page: it must render before any auth or profile
  // fetch, because the viewer has no account and never will.
  const shareToken = typeof location !== 'undefined' && location.pathname.startsWith('/s/')
    ? decodeURIComponent(location.pathname.slice(3)).replace(/\/+$/, '')
    : null;
  // Same for a shared calendar.
  const calendarToken = typeof location !== 'undefined' && location.pathname.startsWith('/c/')
    ? decodeURIComponent(location.pathname.slice(3)).replace(/\/+$/, '')
    : null;
  // The legal pages are public: app stores and ad networks link to them. The
  // roles guide is public too, so it can be linked from anywhere.
  const legalPage = typeof location !== 'undefined'
    ? location.pathname.replace(/\/+$/, '') === '/privacy'
      ? 'privacy'
      : location.pathname.replace(/\/+$/, '') === '/terms'
        ? 'terms'
        : location.pathname.replace(/\/+$/, '') === '/help/roles'
          ? 'roles'
          : null
    : null;

  // An invite link must work signed out, so it is resolved before sign-in.
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    typeof location !== 'undefined' && location.pathname.startsWith('/invite/')
      ? decodeURIComponent(location.pathname.slice('/invite/'.length)).replace(/\/+$/, '') || null
      : null,
  );

  const [me, setMe] = useState<MeResponse | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [gameId, setGameId] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(location.pathname));
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminCheckError, setAdminCheckError] = useState<string | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [addingTeam, setAddingTeam] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<InviteCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountDisabled, setAccountDisabled] = useState<string | null>(null);
  /** The person deactivated their own account; they can switch it back on. */
  const [deactivated, setDeactivated] = useState<{ deletesAt: string | null } | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [loading, setLoading] = useState(true);
  /** A fixture search asked for, pending its team finishing loading. */
  const pendingGameRef = useRef<string | null>(null);
  /** From a notification link: what to show on the Calendar, and which chat. */
  const [focus, setFocus] = useState<string | null>(null);
  const [chatChannel, setChatChannel] = useState<string | null>(null);
  /** A league or tournament to open on the Games tab. */
  const [openCompetition, setOpenCompetition] = useState<string | null>(null);
  /** Getting started: shown until closed; the pop-up tip it points with. */
  const [guideOpen, setGuideOpen] = useState(false);
  const [tour, setTour] = useState<TourTarget | null>(null);
  const [guideComps, setGuideComps] = useState<Array<{ games: number }> | null>(null);
  /** Bumped after players are brought in from another team, so Team & roster reloads. */
  const [rosterVersion, setRosterVersion] = useState(0);
  // /referee?match=<fixture>: the referee's match screen for that league game.
  const [refMatch, setRefMatch] = useState<string | null>(null);
  // Opened from a calendar game: Back goes back there rather than to the referee list.
  const [refMatchPushed, setRefMatchPushed] = useState(false);
  // The sign-in ran out while using the app: back to sign in, saying why.
  const [sessionExpired, setSessionExpired] = useState(false);
  const meRef = useRef<MeResponse | null>(null);
  meRef.current = me;
  // Usage counts for the admin console: pages opened and buttons tapped,
  // counted without who did it (Fady, 10/19).
  const selectionKind = selection?.kind ?? null;
  useEffect(() => {
    if (!me) return;
    startUsageTracking();
    const kind = selectionKind === 'org' ? 'organization' : selectionKind;
    trackPage(kind && ['calendar', 'seasons', 'standings', 'teams'].includes(screen) ? `${PAGE_NAME[screen]} (${kind})` : PAGE_NAME[screen]);
  }, [me, screen, selectionKind]);
  useEffect(() => {
    onSessionExpired(() => {
      if (!meRef.current) return;
      forgetDeviceCache();
      setMe(null);
      setSessionExpired(true);
    });
    return () => onSessionExpired(null);
  }, []);

  const checkAdmin = useCallback(() => {
    // Only a 403 means "not an admin". Anything else (a timeout, a cold start,
    // a 5xx) is reported as a failed check that can be retried, so a blip
    // never tells a real admin they have no access.
    setAdminCheckError(null);
    api
      .admin('summary')
      .then(() => setIsAdmin(true))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) {
          setIsAdmin(false);
        } else {
          setAdminCheckError(e instanceof Error ? e.message : 'Admin check failed');
        }
      });
  }, []);

  const refreshMe = useCallback(async (): Promise<Hierarchy | null> => {
    // The profile and the menu are independent, so both are asked for at once.
    const hierarchyP = api.hierarchy().catch(() => null);
    try {
      const m = await api.me();
      // Answers saved on this device belong to this account (and "view as" role).
      const imp = m.impersonation?.active ? `|${m.impersonation.role ?? ''}|${m.impersonation.tier ?? ''}` : '';
      setDeviceCacheOwner(`${m.user.id}${imp}`);
      setMe(m);
      // The admin tab only appears when the admin endpoint actually answers.
      // Only platform admin accounts ask (older servers do not say: ask then).
      if (m.platformAdmin === false) {
        setIsAdmin(false);
        setAdminCheckError(null);
      } else {
        checkAdmin();
      }
      // The menu is built from the hierarchy, so it is awaited, not raced.
      const h = await hierarchyP;
      setHierarchy(h);
      return h;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SIGNED_OUT') {
        // An admin signed this account out everywhere: drop the session cookie.
        forgetDeviceCache();
        location.href = '/.auth/logout?post_logout_redirect_uri=/';
        return null;
      }
      if (err instanceof ApiError && err.code === 'ACCOUNT_DISABLED') {
        forgetDeviceCache();
        setAccountDisabled(err.message);
        return null;
      }
      if (err instanceof ApiError && err.code === 'ACCOUNT_DEACTIVATED') {
        forgetDeviceCache();
        const details = (err.details ?? {}) as { deletesAt?: string | null };
        setDeactivated({ deletesAt: details.deletesAt ?? null });
        return null;
      }
      if (err instanceof ApiError && err.status === 401) forgetDeviceCache();
      if (!(err instanceof ApiError && err.status === 401)) {
        setError(err instanceof Error ? err.message : 'Failed to load profile');
      }
      return null;
    }
  }, [checkAdmin]);

  /**
   * Re-read everything. Changing role or plan can alter which teams are
   * visible and what may be edited, so a partial refresh would leave the UI
   * showing a surface the server no longer permits.
   */
  const reloadAll = useCallback(async () => {
    const teamsP = api.listTeams();
    teamsP.catch(() => undefined);
    const h = await refreshMe();
    try {
      const t = await teamsP;
      setTeams(t);
      // Keep the selected team if it is still visible. Otherwise a solo coach
      // falls back to their first team, and a hierarchy user picks again.
      const fallback = h && (h.orgs.length > 0 || (h.regions?.length ?? 0) > 0) ? null : t[0]?.id ?? null;
      setTeamId((prev) => (prev && t.some((x) => x.id === prev) ? prev : fallback));
    } catch {
      /* signed out */
    }
  }, [refreshMe]);

  useEffect(() => {
    if (shareToken || calendarToken || legalPage) {
      setLoading(false);
      return;
    }
    (async () => {
      // Profile, menu and teams load together rather than one after another.
      const teamsP = api.listTeams();
      teamsP.catch(() => undefined);
      const h = await refreshMe();
      try {
        const t = await teamsP;
        setTeams(t);
        const atTeamLevel = !['/account', '/support', '/admin', '/org', '/competitions'].some((p) =>
          location.pathname.startsWith(p),
        );
        if (h && (h.orgs.length > 0 || (h.regions?.length ?? 0) > 0)) {
          // Hierarchy users start at the top of their organization (or their
          // standalone region) and pick a region or team from the menu before
          // any team screen appears.
          setSelection(
            h.orgs.length > 0 ? { kind: 'org', id: h.orgs[0].id } : { kind: 'region', id: h.regions![0].id },
          );
          if (atTeamLevel) {
            setScreen('seasons');
            if (location.pathname === '/') history.replaceState(null, '', pathForScreen('seasons'));
          }
        } else if (t.length) {
          setTeamId(t[0].id);
          setSelection({ kind: 'team', id: t[0].id });
        }
        // Someone who arrived from a region's sign-up link lands on Account,
        // where the code is waiting, even after the sign-in round trip.
        const pendingPlan = localStorage.getItem(PENDING_TRIAL_KEY);
        if (localStorage.getItem(PENDING_REF_KEY)) {
          setScreen('referee');
          if (location.pathname !== '/referee') history.replaceState(null, '', '/referee');
        } else if (localStorage.getItem(PENDING_JOIN_KEY)) {
          setScreen('account');
          if (location.pathname !== '/account') history.replaceState(null, '', '/account');
        } else if (pendingPlan === 'free') {
          // "Start free" on the home page: straight to setting up a team.
          localStorage.removeItem(PENDING_TRIAL_KEY);
          setScreen('standings');
          history.replaceState(null, '', '/');
        } else if (pendingPlan) {
          // A free trial picked on the home page before signing in waits on
          // Account, ready to start.
          setScreen('account');
          history.replaceState(null, '', '/account#trial');
        } else if (location.search) {
          // A link from a notification: the right team, screen and item.
          applyLink(location.pathname + location.search, t);
        }
      } catch {
        /* signed out */
      }
      setLoading(false);
    })();
  }, [refreshMe, shareToken, calendarToken, legalPage]);

  // Once the first screen is up and the app is idle, fetch the other tabs'
  // code in the background, one at a time, so opening them is instant.
  const signedIn = me !== null;
  useEffect(() => {
    if (loading || !signedIn) return;
    let cancelled = false;
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const idle = (fn: () => void) => (ric ? ric(fn, { timeout: 4000 }) : window.setTimeout(fn, 1500));
    idle(async () => {
      for (const screen of PRELOAD) {
        if (cancelled) return;
        await screen.preload();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loading, signedIn]);

  useEffect(() => {
    const onPopState = () => setScreen(screenFromPath(location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // A referee with no team of their own starts on their referee games.
  useEffect(() => {
    if (!loading && (me?.refereeOrgs ?? 0) > 0 && teams.length === 0 && !selection && screen === 'standings') {
      setScreen('referee');
      history.replaceState(null, '', '/referee');
    }
  }, [loading, me, teams.length, selection, screen]);

  // A team has no standings of its own (they belong to seasons and
  // tournaments), so its home is the calendar.
  useEffect(() => {
    if (selection?.kind === 'team' && screen === 'standings') {
      setScreen('calendar');
      history.replaceState(null, '', pathForScreen('calendar'));
    }
  }, [selection, screen]);

  // Getting started opens for someone who has not closed it; it counts their
  // leagues and games to tick those steps off.
  const meId = me?.user?.id ?? null;
  useEffect(() => {
    if (meId) setGuideOpen(!guideHidden(meId));
  }, [meId]);
  useEffect(() => {
    if (!guideOpen || !meId) return;
    api
      .competitions('mine', '')
      .then((l) => setGuideComps(l.competitions))
      .catch(() => setGuideComps([]));
  }, [guideOpen, meId, screen]);

  useEffect(() => {
    if (!teamId) {
      // Nothing selected: drop the previous team's roster and fixtures.
      setPlayers([]);
      setGames([]);
      setGameId(null);
      return;
    }
    let cancelled = false;
    // A team opened earlier in this visit shows its roster and games at once.
    const cachedPlayers = peek<Player[]>(apiPath.listPlayers(teamId));
    const cachedGames = peek<Game[]>(apiPath.listGames(teamId));
    const seeded = Boolean(cachedPlayers && cachedGames);
    if (cachedPlayers && cachedGames) {
      setPlayers(cachedPlayers);
      setGames(cachedGames);
      const wanted = pendingGameRef.current;
      const target = wanted && cachedGames.some((x) => x.id === wanted) ? wanted : null;
      setGameId(target ?? (cachedGames.length ? cachedGames[cachedGames.length - 1].id : null));
    }
    (async () => {
      try {
        const [p, g] = await Promise.all([api.listPlayers(teamId), api.listGames(teamId)]);
        if (cancelled) return;
        setPlayers(p);
        setGames(g);
        // Search can ask for a specific fixture on a team that is not loaded
        // yet. Honour that request here, otherwise this would immediately
        // overwrite the selection with the most recent game.
        const wanted = pendingGameRef.current;
        pendingGameRef.current = null;
        const target = wanted && g.some((x) => x.id === wanted) ? wanted : null;
        const latest = g.length ? g[g.length - 1].id : null;
        // After showing the remembered games, keep a game picked meanwhile.
        setGameId((prev) => target ?? (seeded && prev && g.some((x) => x.id === prev) ? prev : latest));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load team');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const team = teams.find((t) => t.id === teamId) ?? null;
  // The selected game must survive the games list changing underneath it —
  // adding the first game from the Team tab used to leave this null, so Match
  // day claimed there were no games at all.
  const game = games.find((g) => g.id === gameId) ?? games[games.length - 1] ?? null;

  // Team capacity comes from the plan, so the button disappears at the limit
  // rather than letting the create call fail with a 402. Team parents,
  // parents and viewers join by invite and never create teams.
  const familyOnly = teams.length > 0 && isFamilyOnly(teams.map((t) => t.myRole));
  const teamLimit = me?.limits?.teams ?? Number.MAX_SAFE_INTEGER;
  const canAddTeam = !familyOnly && teams.length < teamLimit;
  const teamLimitLabel =
    teamLimit >= Number.MAX_SAFE_INTEGER ? 'unlimited' : String(teamLimit);

  /**
   * Open an in-app link such as a notification's: /calendar?team=..&focus=..,
   * /chat?team=..&channel=.., /?team=.., /settings?region=... Selects the
   * team, region or organization, then the screen, then what to show.
   */
  function applyLink(href: string, knownTeams: Team[] = teams) {
    const u = new URL(href, location.origin);
    const q = u.searchParams;
    const next = screenFromPath(u.pathname);
    const team = q.get('team');
    const region = q.get('region');
    const org = q.get('org');
    if (team && knownTeams.some((t) => t.id === team)) {
      setSelection({ kind: 'team', id: team });
      setTeamId(team);
    } else if (region) {
      setSelection({ kind: 'region', id: region });
    } else if (org) {
      setSelection({ kind: 'org', id: org });
    }
    setFocus(q.get('focus'));
    setChatChannel(q.get('channel'));
    setRefMatch(next === 'referee' ? q.get('match') : null);
    setRefMatchPushed(false);
    setScreen(next);
    setMenuOpen(false);
    setAddingTeam(false);
    const path =
      next === 'referee' && q.get('match')
        ? `/referee?match=${q.get('match')}`
        : next === 'account' && u.search
          ? `/account${u.search}`
          : pathForScreen(next);
    if (location.pathname + location.search !== path) history.replaceState(null, '', path);
  }

  // Screens without the app's navigation (a calendar game's referee report)
  // open in-app links through this event; Back on that screen returns here.
  useEffect(() => {
    const open = (e: Event) => {
      const href = (e as CustomEvent<string>).detail;
      if (typeof href === 'string' && href.startsWith('/')) {
        history.pushState(null, '', href);
        applyLink(href);
        setRefMatchPushed(href.startsWith('/referee?match='));
      }
    };
    window.addEventListener('lineup:open', open);
    return () => window.removeEventListener('lineup:open', open);
  });

  function navigate(next: Screen) {
    setFocus(null);
    setRefMatch(null);
    setRefMatchPushed(false);
    setOpenCompetition(null);
    setScreen(next);
    setMenuOpen(false);
    // Any navigation abandons a half-filled new team form.
    setAddingTeam(false);
    const path = pathForScreen(next);
    if (location.pathname !== path) history.pushState(null, '', path);
  }

  /**
   * Start loading a tab's data the moment it is pressed (pointer down comes a
   * little before the click), so the screen often has it by the time it opens.
   * The screen's own requests join these instead of asking twice.
   */
  function prefetchScreen(next: Screen) {
    if (!selection) return;
    const ignore = () => undefined;
    const { kind, id } = selection;
    void (async () => {
      if (next === 'seasons' || next === 'standings') {
        if (kind !== 'team') await api.competitions(kind, id).catch(ignore);
      } else if (next === 'calendar' && kind === 'team') {
        await Promise.all([api.calendar('team', id), api.teamLife(id), api.practices(id), api.checkins(id)]).catch(ignore);
      } else if (next === 'calendar') {
        await Promise.all([api.calendar(kind, id), kind === 'team' ? null : api.scopeLife(kind, id)]).catch(ignore);
      } else if (kind === 'team' && next === 'chat') {
        await api.chat(id, chatChannel ?? undefined).catch(ignore);
      } else if (kind === 'team' && next === 'analytics') {
        await Promise.all([api.analytics(id), api.teamStats(id)]).catch(ignore);
      } else if (kind === 'team' && next === 'team') {
        await Promise.all([api.teamPeople(id), api.evaluations(id)]).catch(ignore);
      }
    })();
  }

  /** Pick an organization, region or team in the menu and go to its home. */
  function select(kind: StandingsScope, id: string) {
    setSelection({ kind, id });
    if (kind === 'team') setTeamId(id);
    // A team lands on its calendar, an organization or region on its seasons
    // and tournaments; the other screens are page tabs.
    navigate(kind === 'team' ? 'calendar' : 'seasons');
  }

  /** Jump from a calendar entry to that game on match day. */
  function openGame(nextTeamId: string, nextGameId: string) {
    if (nextTeamId !== teamId) {
      pendingGameRef.current = nextGameId;
      setTeamId(nextTeamId);
    } else {
      setGameId(nextGameId);
    }
    setSelection({ kind: 'team', id: nextTeamId });
    navigate('matchday');
  }

  function startAddingTeam() {
    setAddingTeam(true);
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // While adding a team, show only the form. The rest of the page belongs to
  // the currently selected team and is just noise until the new one exists.
  const focusNewTeam = addingTeam && teams.length > 0;

  const orgs = hierarchy?.orgs ?? [];
  const standaloneRegions = hierarchy?.regions ?? [];
  const allRegions = [...orgs.flatMap((o) => o.regions), ...standaloneRegions];
  // Can set up or already belongs to an organization or region, as opposed
  // to only seeing it as a paid upgrade.
  const canStartRegion = Boolean(hierarchy?.createRegion?.allowed);
  const canUseOrgs = Boolean(
    hierarchy &&
      (orgs.length > 0 || standaloneRegions.length > 0 || hierarchy.createOrg.allowed || canStartRegion),
  );
  // The set-up entry shows while there is nothing in the tree yet, or while a
  // Region plan holder still has their region to start.
  const showOrgSetup = (orgs.length === 0 && standaloneRegions.length === 0) || canStartRegion;
  // Teams the caller can open, placed where they sit in the hierarchy.
  const menuTeams = hierarchy?.teams ?? teams.map((t) => ({
    id: t.id,
    name: t.name,
    logo: null,
    orgId: null,
    orgName: null,
    regionId: null,
    regionName: null,
    canMove: false,
  }));

  const selectedRegion =
    selection?.kind === 'region' ? allRegions.find((r) => r.id === selection.id) : undefined;
  const selectedOrg = selection?.kind === 'org' ? orgs.find((o) => o.id === selection.id) : undefined;
  const selectedTeam = selection?.kind === 'team' ? menuTeams.find((t) => t.id === selection.id) : undefined;

  const contextLabel = selectedOrg?.name ?? selectedRegion?.name ?? team?.name;
  const contextLogo = selectedOrg?.logo ?? selectedRegion?.logo ?? selectedTeam?.logo ?? null;
  const contextKind =
    selection?.kind === 'org' ? 'Organization' : selection?.kind === 'region' ? 'Region' : 'Team';
  /** Where the selection sits, e.g. "AYSO Area 10 › Region 42". */
  const contextPath =
    selection?.kind === 'region'
      ? orgs.find((o) => o.regions.some((r) => r.id === selection.id))?.name
      : selection?.kind === 'team'
        ? [selectedTeam?.orgName, selectedTeam?.regionName].filter(Boolean).join(' › ')
        : undefined;

  // Free accounts see a preview of stats. While the paywall is off, the
  // preview is simulated for everyone so it can be reviewed.
  const statsLocked = me ? (me.paywallEnabled ? me.tier === 'free' : true) : false;
  // Ads fund the free tier, so a paid plan removes them. With the paywall
  // off nobody has paid yet, and ads show for everyone.
  const showAds = !(me?.paywallEnabled && me.tier !== 'free');

  useEffect(() => {
    if (game && game.id !== gameId) setGameId(game.id);
    else if (!game && gameId) setGameId(null);
  }, [game, gameId]);

  // Share links are gone (Fady, 10/19): things are shared as images and
  // calendar files that the app makes on the spot and never keeps.
  if (shareToken || calendarToken) {
    return (
      <main className="share-page">
        <section className="card">
          <h2>This link no longer works</h2>
          <p className="note">
            Lineup doesn't keep shared links any more. Ask the coach to send the {calendarToken ? 'calendar' : 'stats'} again:
            it now comes as a picture or a calendar file.
          </p>
          <a className="btn" href="/">
            Open Lineup
          </a>
        </section>
      </main>
    );
  }

  if (legalPage) {
    return (
      <Lazy>
        {legalPage === 'privacy' ? <PrivacyPolicy /> : legalPage === 'terms' ? <TermsOfUse /> : <RolesGuide />}
      </Lazy>
    );
  }

  if (loading) {
    return (
      <main className="wrap">
        <section className="card">Loading…</section>
      </main>
    );
  }

  if (inviteToken) {
    return (
      <InviteAccept
        token={inviteToken}
        signedIn={Boolean(me)}
        onAccepted={async (r) => {
          setInviteToken(null);
          history.replaceState(null, '', '/');
          await reloadAll();
          if (r.teamId) select('team', r.teamId);
          else if (r.regionId) select('region', r.regionId);
          else if (r.orgId) select('org', r.orgId);
          else navigate('standings');
        }}
      />
    );
  }

  if (accountDisabled) {
    return (
      <main className="wrap">
        <section className="card err">
          <h2>Account disabled</h2>
          <p>{accountDisabled}</p>
          <p className="note">
            <a href="/.auth/logout">Sign out</a>
          </p>
        </section>
      </main>
    );
  }

  if (deactivated) {
    return (
      <main className="wrap">
        <section className="card deactivated-card">
          <div className="brand">
            <span className="ball">⚽</span>
            <div>
              <h1>Lineup</h1>
              <span className="sub">Account deactivated</span>
            </div>
          </div>
          <h2>Your account is deactivated</h2>
          <p>
            Everything is kept safe
            {deactivated.deletesAt
              ? ` until ${new Date(deactivated.deletesAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`
              : ' for a year'}
            . Reactivate to pick up right where you left off. After that date your account, the teams
            you own and their player records are deleted for good.
          </p>
          {error && <p className="danger-text">{error}</p>}
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={reactivating}
              onClick={async () => {
                setReactivating(true);
                setError(null);
                try {
                  await api.reactivateAccount();
                  location.reload();
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Could not reactivate the account');
                  setReactivating(false);
                }
              }}
            >
              {reactivating ? 'Reactivating…' : 'Reactivate my account'}
            </button>
            <a className="btn ghost" href="/.auth/logout?post_logout_redirect_uri=/">
              Sign out
            </a>
          </div>
        </section>
      </main>
    );
  }

  if (!me) {
    return (
      <SignIn
        theme={theme}
        onThemeChange={setTheme}
        notice={sessionExpired ? 'Your session expired. Please sign in again.' : undefined}
      />
    );
  }

  if (me.terms && !me.terms.accepted) {
    return (
      <Lazy>
        <TermsGate version={me.terms.version} onAccepted={() => void refreshMe()} />
      </Lazy>
    );
  }

  // The admin console opens from the menu only. It is not a screen inside the
  // team layout, so it never shows team headers, page tabs or ads.
  if (screen === 'admin') {
    return (
      <main className="wrap admin-console">
        <header className="bar">
          <div className="brand">
            <span className="ball">🛠️</span>
            <div>
              <h1>Lineup Admin</h1>
              <span className="sub">Platform console</span>
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => navigate('standings')}>
              ← Back to app
            </button>
            <ThemeToggle choice={theme} onChange={setTheme} />
          </div>
        </header>
        {isAdmin === null && !adminCheckError && (
          <section className="card">
            <p className="note">Checking admin access…</p>
          </section>
        )}
        {isAdmin === null && adminCheckError && (
          <section className="card err">
            <h2>Could not check admin access</h2>
            <p className="note">{adminCheckError}</p>
            <button type="button" className="btn" onClick={checkAdmin}>
              Try again
            </button>
          </section>
        )}
        {isAdmin === false && (
          <section className="card err">
            <h2>No admin access</h2>
            <p className="note">This account is not a platform admin.</p>
          </section>
        )}
        {isAdmin && (
          <Lazy>
            <Admin />
          </Lazy>
        )}
      </main>
    );
  }

  const teamScreens = selection?.kind === 'team' && team;

  // A director whose organization or region trial ran out unpaid sees only
  // the choice to subscribe or carry on as a free coach (Help & support stays
  // reachable for subscribing while checkout is not live).
  const endedTrial =
    me.trial?.scope && me.trial.scope.state === 'ended' && !me.trial.scope.dismissed ? me.trial.scope : null;
  if (endedTrial && screen !== 'support') {
    return (
      <TrialEnded
        trial={endedTrial}
        onSwitched={() => {
          setSelection(null);
          void reloadAll();
          navigate('standings');
        }}
        onSupport={() => navigate('support')}
      />
    );
  }
  // What the caller's role on this team allows. Team parents, parents and
  // viewers follow the team (standings and calendar); coaches run it. The API
  // enforces all of this; the app just keeps unusable screens out of the way.
  const myRole = team?.myRole ?? null;
  const noMatchDay = myRole !== null && FAMILY_ROLES.includes(myRole as Role);
  const canEditRoster = myRole === null || ['org_admin', 'director', 'region_admin', 'coach'].includes(myRole);
  const canRunMatch = canEditRoster || myRole === 'assistant';
  const canInvite = team?.canInvite ?? canEditRoster;
  // Bringing players in from an older roster: whoever adds players here.
  const canImportRoster = Boolean(team && canEditRoster && team.canAddPlayers && !team.archivedAt);
  async function afterRosterImport(id: string) {
    try {
      const next = await api.listPlayers(id);
      if (id === teamId) setPlayers(next);
    } finally {
      setRosterVersion((v) => v + 1);
    }
  }
  const teamTabs = (
    noMatchDay
      ? // Families follow the team; parents and team parents also get Stats, with their child's player card.
        TEAM_TABS.filter(([id]) => !['matchday', 'team'].includes(id) && (id !== 'analytics' || myRole === 'parent' || myRole === 'team_parent'))
      : TEAM_TABS
  )
    // Viewers follow the team but have no chat of their own.
    .filter(([id]) => !(id === 'chat' && myRole === 'viewer'));
  // Organization and region settings live on the organization's or region's
  // own page, for the people who can manage it or invite into it.
  const parentOfRegion = selection?.kind === 'region' ? orgs.find((o) => o.regions.some((r) => r.id === selection.id)) : undefined;
  const canOpenSettings =
    selection?.kind === 'org'
      ? Boolean(selectedOrg && (selectedOrg.canManage || selectedOrg.canInvite))
      : selection?.kind === 'region'
        ? Boolean(selectedRegion && (selectedRegion.canManage || selectedRegion.canInvite || parentOfRegion?.canManage))
        : false;
  // A region's sign-ups (join code, placing players, people, invites) have
  // their own tab, for the region's staff.
  const canOpenSignups =
    selection?.kind === 'region' &&
    Boolean(selectedRegion && (selectedRegion.canManage || selectedRegion.canInvite || parentOfRegion?.canManage));
  const scopeTabs: Array<[Screen, string]> = [
    ...SCOPE_TABS,
    ...(canOpenSignups ? ([['signups', '📝 Sign-ups']] as Array<[Screen, string]>) : []),
    ...(canOpenSettings ? ([['settings', '⚙️ Settings']] as Array<[Screen, string]>) : []),
  ];
  const pageTabs = selection?.kind === 'team' ? (team ? teamTabs : null) : selection ? scopeTabs : null;
  const showPageTabs = Boolean(pageTabs && pageTabs.some(([id]) => id === screen));

  // Getting started (Fady, 10/17): an organization or region admin's steps,
  // or a coach's with their own team.
  const point = (selector: string, text: string) => setTour({ selector, text });
  const adminOrg = orgs.find((o) => o.canManage) ?? null;
  const adminRegion =
    adminOrg?.regions[0] ?? standaloneRegions.find((r) => r.canManage || r.canInvite) ?? null;
  const coachTeam = teams.find((t) => t.myRole === 'coach' && !t.inLeague) ?? null;
  const comps = guideComps ?? [];
  const leaguesKnown = guideComps !== null;
  const goRegion = (next: Screen) => {
    if (adminRegion) select('region', adminRegion.id);
    else if (adminOrg) select('org', adminOrg.id);
    navigate(next);
  };
  const guide: { title: string; steps: GuideStep[] } | null = adminOrg || adminRegion
    ? {
        title: 'Getting started with your league',
        steps: [
          ...(adminOrg
            ? [
                {
                  id: 'region',
                  title: 'Create a region',
                  hint: 'Your organization’s regions hold its teams.',
                  done: adminOrg.regions.length > 0,
                  show: () => {
                    select('org', adminOrg.id);
                    navigate('settings');
                    point('[data-tour="add-region"]', 'Type the region’s name here and tap “Add region”.');
                  },
                },
              ]
            : []),
          {
            id: 'team',
            title: 'Create a team in the region',
            hint: 'Each team gets its coach by invite.',
            done: menuTeams.some((t) => t.regionId),
            show: () => {
              goRegion('teams');
              point('[data-tour="create-team"]', 'Tap “＋ New team” to create a team in this region and invite its coach.');
            },
          },
          {
            id: 'league',
            title: 'Create a league or tournament',
            hint: 'With its dates and registration window.',
            done: leaguesKnown ? comps.length > 0 : undefined,
            show: () => {
              goRegion('seasons');
              point('[data-tour="new-competition"]', 'Tap “＋ League or season” or “＋ Tournament”, and set its dates.');
            },
          },
          {
            id: 'signup',
            title: 'Share the sign-up link',
            hint: 'Families sign their children up for the league.',
            show: () => {
              goRegion('signups');
              point('[data-tour="signup-links"]', 'Copy the league’s sign-up link and send it to families. Set the registration dates here.');
            },
          },
          {
            id: 'place',
            title: 'Approve and place players',
            hint: 'Each child goes on one of the league’s teams.',
            show: () => {
              goRegion('signups');
              point('[data-tour="players-to-place"]', 'Approve each child, pick one of the league’s teams and tap “Place”.');
            },
          },
          {
            id: 'staff',
            title: 'Invite staff',
            hint: 'Coaches, assistant coaches and admins.',
            show: () => {
              goRegion('signups');
              point('[data-tour="invite-members"]', 'Invite coaches, assistant coaches and admins by email.');
            },
          },
          {
            id: 'games',
            title: 'Schedule the games',
            hint: 'They show on each team’s calendar.',
            done: leaguesKnown ? comps.some((c) => c.games > 0) : undefined,
            show: () => {
              goRegion('seasons');
              point('[data-tour="competition-list"]', 'Open the league, add its teams, then tap “＋ Schedule a game”.');
            },
          },
        ],
      }
    : coachTeam
      ? {
          title: 'Getting started with your team',
          steps: [
            {
              id: 'players',
              title: 'Add your players',
              hint: 'Type them in, or bring them from another team.',
              done: teamId === coachTeam.id ? players.length > 0 : undefined,
              show: () => {
                select('team', coachTeam.id);
                navigate('team');
                point('[data-tour="roster"]', 'Add your players here: tap “＋ Add player”, or bring them from another team.');
              },
            },
            {
              id: 'invite',
              title: 'Invite your assistant and parents',
              hint: 'They get a link to join the team.',
              show: () => {
                select('team', coachTeam.id);
                navigate('team');
                point('[data-tour="team-invite"]', 'Invite your assistant coach and parents by email, or share the invite link.');
              },
            },
            {
              id: 'league',
              title: 'Create a league or tournament',
              hint: 'Your season, or a tournament you are entering.',
              done: leaguesKnown ? comps.length > 0 : undefined,
              show: () => {
                navigate('competitions');
                point('[data-tour="new-competition"]', 'Tap “＋ League or season” or “＋ Tournament” to create it.');
              },
            },
            {
              id: 'games',
              title: 'Schedule its games',
              hint: 'They show on your team’s calendar.',
              done: leaguesKnown ? comps.some((c) => c.games > 0) : undefined,
              show: () => {
                navigate('competitions');
                point('[data-tour="competition-list"]', 'Open your league, add your team, then tap “＋ Schedule a game”.');
              },
            },
          ],
        }
      : null;
  // Shown on the home page: an organization's or region's leagues, or the coach's calendar.
  const guideHere =
    guideOpen &&
    guide !== null &&
    ((adminOrg || adminRegion) ? screen === 'seasons' && selection?.kind !== 'team' : screen === 'calendar' && selection?.kind === 'team');
  const openGuide = () => {
    if (!meId) return;
    setGuideHidden(meId, false);
    setGuideOpen(true);
    if (adminOrg) select('org', adminOrg.id);
    else if (adminRegion) select('region', adminRegion.id);
    else if (coachTeam) select('team', coachTeam.id);
  };

  return (
    <FeaturesProvider features={me.features}>
    <main className="wrap">
      <InstallBanner
        onOpen={() => {
          navigate('account');
          window.setTimeout(() => document.getElementById('install')?.scrollIntoView({ behavior: 'smooth' }), 300);
        }}
      />
      {!me.impersonation?.active && <NotifyAsk />}
      {me.impersonation?.active && (
        <ImpersonationBanner
          state={{
            ...me.impersonation,
            available: true,
            roles: [],
            tiers: [],
          }}
          onStop={async () => {
            await api.stopImpersonation();
            await reloadAll();
          }}
        />
      )}
      <header className="bar">
        <button
          type="button"
          className="btn menu-trigger"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          ☰
        </button>
        <button
          type="button"
          className="brand brand-home"
          title="Home"
          aria-label={`Lineup${contextLabel ? `, ${contextLabel}` : ''}: home`}
          onClick={() => {
            setAddingTeam(false);
            navigate(selection?.kind === 'team' ? 'calendar' : selection ? 'seasons' : 'standings');
          }}
        >
          <span className="ball">⚽</span>
          <div>
            <h1>Lineup</h1>
            {contextLabel && <span className="sub">{contextLabel}</span>}
          </div>
        </button>
        <div className="row">
          <NotificationBell onOpen={(link) => applyLink(link)} />
          {guide && (
            <button type="button" className="btn ghost btn-sm guide-help" title="Getting started" aria-label="Getting started" onClick={openGuide}>
              ?
            </button>
          )}
          <ThemeToggle choice={theme} onChange={setTheme} />
        </div>
      </header>

      {menuOpen && (
        <MenuDrawer
          orgs={orgs}
          regions={standaloneRegions}
          teams={menuTeams}
          selection={selection}
          onSelect={select}
          onClose={() => setMenuOpen(false)}
          orgUpsell={
            showOrgSetup ? (
              <button
                type="button"
                className="item"
                onClick={() => navigate(canUseOrgs ? 'org' : 'account')}
              >
                🏛️ {canStartRegion && orgs.length > 0 ? 'Start a region' : 'Organization & regions'}
                {!canUseOrgs && <span className="pill-paid">Paid</span>}
              </button>
            ) : null
          }
          newTeam={
            teams.length > 0 && canAddTeam && !addingTeam ? (
              <button
                type="button"
                className="item small"
                title={`${teams.length} of ${teamLimitLabel} teams used`}
                onClick={startAddingTeam}
              >
                ＋ New team
              </button>
            ) : null
          }
          top={
            teams.length > 0 ? (
              <button
                type="button"
                className={`item ${screen === 'competitions' ? 'on' : ''}`}
                onPointerDown={() => void api.competitions('mine', '').catch(() => undefined)}
                onClick={() => navigate('competitions')}
              >
                🏟️ Games &amp; matches
              </button>
            ) : null
          }
        >
          {(me?.refereeOrgs ?? 0) > 0 && (
            <button
              type="button"
              className={`item ${screen === 'referee' ? 'on' : ''}`}
              onClick={() => navigate('referee')}
            >
              🟨 Referee
            </button>
          )}
          <button
            type="button"
            className={`item ${screen === 'account' ? 'on' : ''}`}
            onClick={() => navigate('account')}
          >
            👤 Account
          </button>
          <button
            type="button"
            className={`item ${screen === 'support' ? 'on' : ''}`}
            onClick={() => navigate('support')}
          >
            💬 Help & support
          </button>
          {isAdmin && (
            <button
              type="button"
              className="item"
              onClick={() => navigate('admin')}
            >
              🛠️ Admin portal
            </button>
          )}
          <a className="item signout" href="/.auth/logout">
            ↩ Sign out
          </a>
          <div className="drawer-legal">
            <a href="/help/roles" target="_blank" rel="noopener noreferrer">Who does what</a> ·{' '}
            <a href="/terms" target="_blank" rel="noopener noreferrer">Terms</a> ·{' '}
            <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy</a>
          </div>
        </MenuDrawer>
      )}

      {teams.length > 0 && !focusNewTeam && (
        <GlobalSearch
          onPick={(hit) => {
            const switching = hit.teamId !== teamId;
            if (hit.kind === 'game') {
              // Remember it so the team load does not clobber the choice.
              if (switching) pendingGameRef.current = hit.id;
              else setGameId(hit.id);
              navigate('matchday');
            } else {
              navigate('team');
            }
            setSelection({ kind: 'team', id: hit.teamId });
            if (switching) setTeamId(hit.teamId);
          }}
        />
      )}

      {!focusNewTeam && <AdSlot show={showAds} position="top" />}

      {error && (
        <section className="card err">
          <strong>Problem:</strong> {error}
        </section>
      )}

      {inviteNotice && <InviteShare invite={inviteNotice} onClose={() => setInviteNotice(null)} />}

      {teams.length === 0 && !addingTeam && screen !== 'account' && screen !== 'plans' && screen !== 'referee' && !(me?.refereeOrgs ?? 0) && (
        <section className="card">
          <h2>Signing up a child with your league?</h2>
          <p className="note">
            If your region gave you a code (like SYSO-CYPRESS154), use it to sign your children up. The
            region places them on a team. Coaches starting their own team can use the form below.
          </p>
          <button type="button" className="btn ghost" onClick={() => navigate('account')}>
            Enter a region code
          </button>
        </section>
      )}

      {((teams.length === 0 && screen !== 'account' && screen !== 'plans' && screen !== 'referee' && !(me?.refereeOrgs ?? 0)) || addingTeam) && (
        <NewTeam
          canCancel={teams.length > 0}
          onCancel={() => setAddingTeam(false)}
          onCreated={(t, invite, inviteError) => {
            setTeams((prev) => [...prev, t]);
            setTeamId(t.id);
            setSelection({ kind: 'team', id: t.id });
            setAddingTeam(false);
            setInviteNotice(invite ?? null);
            if (inviteError) setError(`${t.name} was created, but the invite failed: ${inviteError}`);
            navigate('team');
            // The new team has to appear in the menu tree.
            void refreshMe();
          }}
        />
      )}

      {!focusNewTeam && (
        <>
      {showPageTabs && selection && (
        <section className="card scope-head">
          <div className="scope-title">
            <Logo kind={selection.kind} id={selection.id} version={contextLogo} size={40} />
            <div>
              <h2>{contextLabel ?? 'Loading…'}</h2>
              <span className="sub">
                {contextKind}
                {contextPath ? ` · ${contextPath}` : ''}
              </span>
            </div>
          </div>
          <nav className="nav page-tabs" aria-label={`${contextKind} pages`}>
            {pageTabs!.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={screen === id ? 'on' : ''}
                aria-current={screen === id ? 'page' : undefined}
                onPointerDown={() => prefetchScreen(id)}
                onClick={() => navigate(id)}
              >
                {label}
              </button>
            ))}
          </nav>
        </section>
      )}

      {selection?.kind === 'team' && team?.archivedAt && (
        <ArchivedTeamBanner team={team} onChanged={() => void reloadAll()} />
      )}

      {guideHere && guide && meId && (
        <GettingStarted
          userId={meId}
          title={guide.title}
          steps={guide.steps}
          onClose={() => {
            setGuideHidden(meId, true);
            setGuideOpen(false);
          }}
        />
      )}
      <TourTip target={tour} onClose={() => setTour(null)} />

      {!teamScreens && ['matchday', 'team', 'analytics'].includes(screen) && teams.length > 0 && (
        <section className="card">
          <h2>Pick a team</h2>
          <p className="note">
            Choose an organization, region or team from the menu. Match day, roster and stats
            open once a team is selected.
          </p>
          <button type="button" className="btn" onClick={() => setMenuOpen(true)}>
            Open menu
          </button>
        </section>
      )}

      {screen === 'analytics' && selection?.kind === 'team' && team && (myRole === 'parent' || myRole === 'team_parent') && (
        <MyPlayerRating teamId={team.id} />
      )}

      {screen === 'standings' && selection && selection.kind !== 'team' && (
        <Lazy>
          <CompetitionStandings
            key={`${selection.kind}-${selection.id}`}
            scope={selection.kind}
            id={selection.id}
            onAll={() => navigate('seasons')}
            onOpen={(competitionId) => {
              navigate('seasons');
              setOpenCompetition(competitionId);
            }}
          />
        </Lazy>
      )}
      {screen === 'seasons' && selection && selection.kind !== 'team' && (
        <Lazy>
          <Competitions
            key={`${selection.kind}-${selection.id}`}
            scope={selection.kind}
            id={selection.id}
            initialOpenId={openCompetition}
            onOpenGame={openGame}
          />
        </Lazy>
      )}
      {(screen === 'competitions' || (screen === 'seasons' && selection?.kind !== 'org' && selection?.kind !== 'region')) && (
        <Lazy>
          <Competitions
            scope="mine"
            id=""
            onOpenGame={openGame}
            friendlyTeams={teams
              // Every team the caller can add games to: coaches and assistants,
              // and organization and region staff on their teams (Fady, 10/19).
              .filter((t) => ['coach', 'assistant', 'org_admin', 'director', 'region_admin'].includes(t.myRole ?? ''))
              .map((t) => ({ id: t.id, name: t.name }))}
          />
        </Lazy>
      )}
      {['standings', 'calendar'].includes(screen) && !selection && (
        <section className="card">
          <p className="note">Pick a team, region or organization from the menu.</p>
        </section>
      )}

      {screen === 'calendar' && selection && selection.kind === 'team' && (
        <Lazy>
          <TeamCalendar key={selection.id} teamId={selection.id} onOpenGame={openGame} focus={focus} />
        </Lazy>
      )}
      {screen === 'calendar' && selection && selection.kind !== 'team' && (
        <Lazy>
          <Calendar scope={selection.kind} id={selection.id} onOpenGame={openGame} />
        </Lazy>
      )}

      {screen === 'plans' && (
        <PlanPicker
          onChoose={(trial) => {
            if (trial) {
              localStorage.setItem(PENDING_TRIAL_KEY, trial);
              setScreen('account');
              history.pushState(null, '', '/account#trial');
            } else {
              navigate('standings');
            }
          }}
        />
      )}

      {screen === 'teams' && selection && selection.kind !== 'team' && (
        <ScopeTeams
          kind={selection.kind}
          id={selection.id}
          hierarchy={hierarchy}
          onOpenTeam={(t) => select('team', t)}
          onOpenSettings={
            canOpenSignups ? () => navigate('signups') : canOpenSettings ? () => navigate('settings') : undefined
          }
          openLabel={canOpenSignups ? 'Open Sign-ups' : 'Open Settings'}
          onChanged={() => void reloadAll()}
        />
      )}

      {screen === 'chat' && teamScreens && (
        <Lazy>
          <TeamChat key={`${team.id}-${chatChannel ?? ''}`} teamId={team.id} initialChannel={chatChannel ?? undefined} />
        </Lazy>
      )}

      {noMatchDay && teamScreens && ['matchday', 'analytics', 'team'].includes(screen) && (
        <section className="card">
          <h2>Coaches only</h2>
          <p className="note">
            Match day, stats and the roster are run by the coaches. You can follow the team's
            standings and calendar{team?.myRole === 'team_parent' ? ', and look after team events and the snack schedule' : ''}.
          </p>
          <button type="button" className="btn" onClick={() => navigate('calendar')}>
            Open the calendar
          </button>
        </section>
      )}

      {screen === 'matchday' && teamScreens && !noMatchDay && (
        <>
          {games.length > 1 && (
            <select
              className="game-pick"
              value={gameId ?? ''}
              onChange={(e) => setGameId(e.target.value)}
            >
              {games.map((g) => (
                <option key={g.id} value={g.id}>
                  #{g.gameNo} {g.opponent || 'TBD'} {g.date ? `· ${g.date}` : ''}
                </option>
              ))}
            </select>
          )}
          {game ? (
            <Lazy>
              <MatchDay
                game={game}
                games={games}
                players={players}
                teamName={team?.name ?? ''}
                canEdit={canRunMatch}
                onGameChange={(g) =>
                  setGames((prev) => prev.map((x) => (x.id === g.id ? g : x)))
                }
              />
            </Lazy>
          ) : (
            <section className="card">
              <p>No games yet. Add one from the Calendar.</p>
            </section>
          )}
        </>
      )}

      {screen === 'team' && teamScreens && !noMatchDay && canImportRoster && players.length === 0 && (
        <RosterImport key={`ri-${team.id}`} teamId={team.id} startOpen onImported={() => void afterRosterImport(team.id)} />
      )}
      {screen === 'team' && teamScreens && !noMatchDay && (
        <TeamSetup
          key={`ts-${team.id}-${rosterVersion}`}
          team={team}
          players={players}
          canEdit={canEditRoster && !team.archivedAt}
          canInvite={canInvite && !team.archivedAt}
          logo={selectedTeam?.logo ?? null}
          onLogo={() => void refreshMe()}
          onPlayers={setPlayers}
          onTeam={(t) => setTeams((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...t } : x)))}
        />
      )}
      {screen === 'team' && teamScreens && !noMatchDay && canImportRoster && players.length > 0 && (
        <RosterImport key={`ri-${team.id}`} teamId={team.id} onImported={() => void afterRosterImport(team.id)} />
      )}
      {screen === 'team' && teamScreens && !noMatchDay && (
        <ArchiveTeamCard team={team} onChanged={() => void reloadAll()} />
      )}

      {screen === 'analytics' && teamScreens && !noMatchDay && (
        <>
          <PlayerCardsGrid key={`cards-${team.id}`} teamId={team.id} />
          <Lazy>
            <Analytics teamId={team.id} teamName={team.name} roster={players} locked={statsLocked} />
          </Lazy>
        </>
      )}

      {screen === 'account' && (
        <Lazy>
        <Account
          me={me}
          teamId={teamId}
          familyOnly={familyOnly}
          recommended={recommendPlan({
            teamRoles: teams.map((t) => t.myRole),
            managesOrg: orgs.some((o) => o.canManage),
            managesRegion: standaloneRegions.some((r) => r.canManage),
            referee: (me?.refereeOrgs ?? 0) > 0,
            signupAnswer: (() => {
              try {
                return localStorage.getItem(PLAN_FOR_KEY);
              } catch {
                return null;
              }
            })(),
          })}
          onRefresh={reloadAll}
          onTrialStarted={async (scope) => {
            await reloadAll();
            if (scope.orgId) select('org', scope.orgId);
            else if (scope.regionId) select('region', scope.regionId);
          }}
        />
        </Lazy>
      )}

      {screen === 'account' && !(me?.refereeOrgs ?? 0) && (
        <section className="card">
          <h2>🟨 Refereeing for a league?</h2>
          <p className="note">If your organization or region gave you a referee code or link, use it to sign up for games.</p>
          <button type="button" className="btn ghost" onClick={() => navigate('referee')}>
            Enter a referee code
          </button>
        </section>
      )}

      {screen === 'referee' && (
        <Lazy>
          <Referee
            initialMatch={refMatch}
            onChanged={() => void refreshMe()}
            onCloseMatch={
              refMatchPushed
                ? () => {
                    setRefMatch(null);
                    setRefMatchPushed(false);
                    history.back();
                  }
                : undefined
            }
          />
        </Lazy>
      )}

      {screen === 'org' && (
        <Lazy>
          <Organization onChanged={reloadAll} />
        </Lazy>
      )}

      {screen === 'settings' && selection && selection.kind !== 'team' && canOpenSettings && (
        <>
          {selection.kind === 'org' && <JoinHelp kind="org" />}
          <Lazy>
            <Organization focus={{ kind: selection.kind, id: selection.id }} onChanged={reloadAll} />
          </Lazy>
          <RefereeSettings scope={selection.kind === 'org' ? 'org' : 'region'} id={selection.id} />
        </>
      )}

      {screen === 'signups' && selection?.kind === 'region' && canOpenSignups && (
        <>
          <JoinHelp kind="region" />
          <Lazy>
            <Organization focus={{ kind: 'region', id: selection.id }} section="signups" onChanged={reloadAll} />
          </Lazy>
        </>
      )}

      {screen === 'support' && (
        <Lazy>
          <Support subscription={me.subscription} />
        </Lazy>
      )}
        </>
      )}
      {!focusNewTeam && <AdSlot show={showAds} position="bottom" />}
    </main>
    </FeaturesProvider>
  );
}

import type {
  AppPlan,
  Assignments,
  Avatar,
  CardStat,
  CardTier,
  Feature,
  Game,
  GameEvent,
  GameEventKind,
  LineupResource,
  Player,
  PlayerFairness,
  Role,
  Team,
  TierId,
  RsvpReason,
  TrialStatus,
  TrialTier,
  Usage,
} from '@lineup/shared';

export type { GameEvent, GameEventKind };

const BASE = '/api';

export interface SearchHit {
  kind: 'team' | 'player' | 'game';
  id: string;
  teamId: string;
  title: string;
  subtitle: string;
}

export interface ImpersonationState {
  available: boolean;
  active: boolean;
  role: string | null;
  tier: TierId | null;
  until: string | null;
  roles: string[];
  /** Plans offered for testing: Free and Premium. */
  tiers: string[];
}

export interface MeResponse {
  user: { id: string; email: string | null; provider: string };
  tier: TierId;
  paywallEnabled: boolean;
  usage: Usage<LineupResource>;
  limits: Record<LineupResource, number>;
  features: readonly Feature[];
  impersonation?: {
    active: boolean;
    role: string | null;
    tier: TierId | null;
    until: string | null;
  };
  subscription: {
    status: 'active' | 'cancelled' | 'expired';
    accessUntil: string | null;
    scope: 'org' | 'region' | 'personal';
  } | null;
  plan: AppPlan<LineupResource>;
  /** Free trials: running, ended, and which can still be started. */
  trial?: TrialStatus | null;
  /** Terms of Use / Privacy Policy acceptance, including the 18+ confirmation. */
  terms?: { version: string; accepted: boolean };
  /** How many organizations or regions this person referees for. */
  refereeOrgs?: number;
  /** A platform admin account (the admin console is checked only for these). */
  platformAdmin?: boolean;
  /** Online billing through Stripe. */
  billing?: {
    /** Plans can be bought online here. */
    checkout: boolean;
    mode: 'test' | 'live' | null;
    /** Stripe's portal can be opened (card, invoices, cancel). */
    portal: boolean;
    /** The current plan is paid through Stripe. */
    stripePlan: boolean;
  };
}

export interface CatalogDivision {
  id: string;
  label: string;
  gender: 'boys' | 'girls' | 'coed';
  ageU: number;
  format: '5v5' | '7v7' | '9v9' | '11v11';
  periods: 'quarters' | 'halves';
  periodLengthSec: number;
}

export interface GamePeriod {
  id: string;
  gameId: string;
  periodIndex: number;
  formation: string | null;
  lengthSec: number;
  elapsedSec: number;
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Availability {
  player_id: string;
  status: 'available' | 'absent' | 'late' | 'injured';
  note: string | null;
}

export interface AnalyticsPlayer {
  playerId: string;
  name: string;
  number: string;
  goals: number;
  assists: number;
  ownGoals: number;
  yellow: number;
  red: number;
  fouls: number;
  saves: number;
  clearances: number;
  minutes: number;
  gamesPlayed: number;
  present: number;
  absent: number;
  attendanceRate: number;
}

export interface TeamTotals {
  corners: number;
  cornersAgainst: number;
  fouls: number;
  foulsAgainst: number;
  yellow: number;
  yellowAgainst: number;
  red: number;
  redAgainst: number;
}

export interface Analytics {
  record: {
    played: number; won: number; drawn: number; lost: number;
    goalsFor: number; goalsAgainst: number;
  };
  team: TeamTotals;
  fairness: { min: number; max: number; spread: number; average: number } | null;
  players: AnalyticsPlayer[];
  games: Array<{
    id: string; gameNo: number; date: string | null;
    opponent: string; us: number; them: number;
  }>;
}

export interface Member {
  id: string;
  role: Role;
  userId: string;
  email: string | null;
  displayName: string | null;
  teamId: string | null;
}

export interface SupportComment {
  id: string;
  authorKind: 'user' | 'support' | 'scout';
  authorName: string;
  body: string;
  createdAt: string;
}

export interface SupportRequest {
  id: string;
  subject: string;
  body: string;
  status: 'open' | 'in_progress' | 'resolved' | 'dismissed';
  scoutEligible: boolean;
  createdAt: string;
  updatedAt: string;
  comments: SupportComment[];
}

export type LogoKind = 'org' | 'region' | 'team';

/** A team's own stats (premium), with season totals per player. */
export interface CustomStats {
  stats: Array<{ id: string; name: string }>;
  /** playerId -> statId -> season total */
  totals: Record<string, Record<string, number>>;
  locked: boolean;
  canManage: boolean;
  canRecord: boolean;
}

export interface CalendarTeamRef {
  id: string | null;
  name: string;
}

export interface CalendarEntry {
  id: string;
  fixtureId: string | null;
  date: string | null;
  kickoff: string | null;
  location: string | null;
  field: string | null;
  /** The region's field map for this location, when it has one. */
  fieldMapId?: string | null;
  home: CalendarTeamRef;
  away: CalendarTeamRef;
  score: { home: number; away: number } | null;
  /** Scheduled by the org or region, as opposed to added by a team. */
  league: boolean;
  /** A team's own game marked as a friendly. */
  friendly?: boolean;
  canManage: boolean;
  /** The caller may edit this team-added game. */
  canEdit?: boolean;
  /** Cancelled, with why; a cancelled game has no score. */
  canceled?: boolean;
  cancelReason?: string | null;
  cancelLabel?: string | null;
  cancelNote?: string | null;
  /** The caller may cancel this game, or undo a cancellation. */
  canCancel?: boolean;
  /** The caller's own team copies of this game, for jumping to match day. */
  links: Array<{ teamId: string; gameId: string; teamName: string }>;
  /** League games: the organization, and who referees (userId for staff who manage it). */
  orgId?: string | null;
  referees?: Record<RefereeSlot, { name: string; userId?: string } | null> | null;
  /** The referee submitted the final score: it is the official result. */
  official?: boolean;
  /** The caller may open the referee's match screen (a referee on it, or its organizers). */
  canOpenRefMatch?: boolean;
  /** The season or tournament it is played in. */
  competition?: { id: string; name: string; kind: CompetitionKind } | null;
}

export interface Calendar {
  scope: StandingsScope;
  id: string;
  title: string;
  entries: CalendarEntry[];
  schedulable: Array<{ id: string; name: string; regionName: string | null }>;
  canSchedule: boolean;
  canShare: boolean;
  /** Team calendars: the caller may add their own (friendly) games. */
  canAddFriendly?: boolean;
  /** Standalone teams only: the caller may also add regular (non-friendly) games. */
  canAddGame?: boolean;
  /** Team calendars: the caller is a coach (or above) who approves assistant lineups. */
  canApproveLineups?: boolean;
  /** Each organization's referees, for staff filling the spots on its games. */
  refereePools?: Record<string, RefereePerson[]>;
}

export type RefereeSlot = 'main' | 'ar1' | 'ar2';

export interface RefereePerson {
  userId: string;
  name: string;
}

/** A league game as a referee sees it. */
export interface RefereeGame {
  fixtureId: string;
  orgId: string;
  orgName: string;
  regionId: string | null;
  regionIds: string[];
  regionName: string | null;
  date: string;
  kickoff: string | null;
  location: string | null;
  field: string | null;
  home: string;
  away: string;
  canceled: boolean;
  /** The referee submitted the final score. */
  official?: boolean;
  mySlot: RefereeSlot | null;
  slots: Record<RefereeSlot, { name: string; mine: boolean } | null>;
}

export type RefPlayerStatus = 'start' | 'bench' | 'absent';
export type RefEventKind = 'goal' | 'own_goal' | 'yellow' | 'red' | 'sub';

export interface RefMatchSide {
  teamId: string;
  name: string;
  /** The coach has set a starting lineup. */
  lineupSet: boolean;
  players: Array<{
    id: string;
    name: string;
    number: string;
    publicId: string | null;
    status: RefPlayerStatus;
    /** What the coach's lineup and check-ins say. */
    fromCoach: RefPlayerStatus;
    /** The referee changed it from the coach's. */
    changed: boolean;
    played: boolean;
    yellow: number;
    red: number;
    goals: number;
  }>;
}

export interface RefMatchEvent {
  id: string;
  side: 'home' | 'away';
  kind: RefEventKind;
  label: string;
  playerId: string | null;
  playerName: string | null;
  playerOutId: string | null;
  playerOutName: string | null;
  minute: number | null;
  periodIndex: number | null;
}

/** The referee's match screen for one league game. */
export interface RefMatch {
  fixtureId: string;
  date: string;
  kickoff: string | null;
  location: string | null;
  field: string | null;
  regionName: string | null;
  canceled: boolean;
  role: 'main' | 'assistant' | 'staff';
  canEdit: boolean;
  canFinal: boolean;
  /** Referee Premium: the running game clock. */
  clockPaid: boolean;
  periods: number;
  periodLengthSec: number;
  clock: { periodIndex: number; elapsedSec: number; running: boolean };
  referees: Record<RefereeSlot, string | null>;
  home: RefMatchSide;
  away: RefMatchSide;
  events: RefMatchEvent[];
  score: { home: number; away: number };
  coachScore: { home: number; away: number } | null;
  official: { home: number; away: number; at: string; by: string | null } | null;
  notes: string;
}

export interface RefereeView {
  orgs: Array<{
    orgId: string;
    name: string;
    favoriteRegionId: string | null;
    regions: Array<{ id: string; name: string }>;
  }>;
  mine: RefereeGame[];
  open: RefereeGame[];
}

/** An organization's or region's referees, for its staff. */
export interface RefereeStaffView {
  orgId: string;
  enabled: boolean;
  code: string | null;
  link: string | null;
  canManageCode: boolean;
  referees: Array<{ userId: string; name: string; email: string | null; favoriteRegion: string | null; upcoming: number }>;
}

export interface FriendlyInput {
  teamId: string;
  opponent: string;
  date: string;
  kickoff?: string;
  isHome: boolean;
  location?: string;
  field?: string;
  kind?: 'friendly' | 'game';
  /** Coaches only: the assistant coach may change this game's lineup without approval. */
  assistantFree?: boolean;
  /** The season or tournament it is played in. */
  competitionId?: string;
  /** Another Lineup team: the friendly goes on its calendar too. */
  opponentTeamId?: string;
}

/** A Lineup team a friendly can be played against. */
/** A friendly a team in an organization or region asked for, waiting for (or past) its staff's approval. */
export interface FriendlyRequest {
  id: string;
  teamId: string;
  teamName: string;
  teamRegion: string | null;
  opponentTeamId: string;
  opponentName: string;
  opponentRegion: string | null;
  date: string;
  kickoff: string;
  isHome: boolean;
  location: string;
  field: string | null;
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  requestedBy: string | null;
  /** Who still has to approve, in words (pending only). */
  waitingFor: string | null;
  declineReason: string | null;
  gameId: string | null;
  canApprove: boolean;
  canCancel: boolean;
}

export interface FriendlyOpponent {
  id: string;
  name: string;
  regionName: string | null;
  orgName: string | null;
  /** One of the caller's own teams. */
  mine: boolean;
}

/** An assistant coach's lineup changes waiting for the coach, and what the caller may do. */
export interface LineupProposalState {
  /** The caller's lineup changes wait for the coach (an assistant before the game). */
  needsApproval: boolean;
  /** The caller approves or rejects proposals and sets assistantFree (a coach). */
  canApprove: boolean;
  live: boolean;
  assistantFree: boolean;
  proposal: {
    assignments: Assignments;
    formations: Record<string, string>;
    proposedBy: string | null;
    proposedByName: string | null;
    updatedAt: string;
  } | null;
}

export interface FixtureInput {
  homeTeamId: string;
  awayTeamId: string;
  date: string;
  kickoff?: string;
  location?: string;
  field?: string;
  /** The season or tournament it is played in. */
  competitionId?: string;
}

export type CompetitionKind = 'season' | 'tournament';
export type CompetitionStatus = 'upcoming' | 'active' | 'archived';

/** A season or tournament in a list. */
export interface CompetitionSummary {
  id: string;
  kind: CompetitionKind;
  name: string;
  startsOn: string;
  endsOn: string;
  status: CompetitionStatus;
  /** When an ended one is deleted. */
  deleteOn: string;
  /** Who runs it: a region or organization name, or "Your teams". */
  owner: string;
  teams: number;
  games: number;
  canManage: boolean;
  /** On a team's list: where that team stands in it (Fady, 10/17). */
  standing?: TeamStanding | null;
}

/** A team's place in a league or tournament: "3rd of 8", and how far it got in a bracket. */
export interface TeamStanding {
  position: number | null;
  positionLabel: string | null;
  of: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pts: number;
  gf: number;
  ga: number;
  /** Tournaments: "Champion", "Out in the Semi-finals", "2nd in Group A". */
  stage: string | null;
}

/** Where a new season or tournament belongs; "mine" is a coach's own standalone teams. */
export type CompetitionOwnerScope = 'region' | 'org' | 'team' | 'mine';

export interface CompetitionList {
  canCreate: boolean;
  createAs: { scope: 'region' | 'org' | 'team'; id: string } | null;
  /** Where the caller may create one (several on the app's own Seasons & tournaments page). */
  createOptions: Array<{ scope: CompetitionOwnerScope; id: string; label: string }>;
  competitions: CompetitionSummary[];
  /** The Games page's Friendlies section (mine, region and organization lists). */
  friendlies?: FriendlyItem[];
  /** Region and organization lists: the caller approves friendly requests there. */
  approvesFriendlies?: boolean;
  /** Region and organization lists, for staff who add games: the teams a friendly can be added between. */
  friendlyTeams?: Array<{ id: string; name: string; regionName: string | null }>;
}

/** Two-step sign-in: unavailable where it isn't set up (or for other sign-in providers). */
export type TwoStep = { available: false } | { available: true; enabled: boolean; phone: string | null };

/** Usage counts for the admin console: pages opened and buttons tapped. */
export interface AdminUsage {
  days: number;
  pages: Array<{ name: string; hits: number }>;
  clicks: Array<{ name: string; hits: number }>;
  daily: Array<{ day: string; pages: number; clicks: number }>;
}

/** A friendly: a team's own game outside any league or tournament. */
export interface FriendlyItem {
  gameId: string;
  teamId: string;
  teamName: string;
  date: string | null;
  kickoff: string | null;
  opponent: string;
  home: boolean;
  location: string | null;
  canceled: boolean;
  past: boolean;
  score: { us: number; them: number } | null;
}

export interface CompetitionDetail extends Omit<CompetitionSummary, 'teams' | 'games'> {
  ownerKind: 'coach' | 'region' | 'org';
  /** Managers, while it has not ended. */
  canEdit: boolean;
  /** May schedule its games: managers and the organization's or region's scheduler (Fady, 10/20). */
  canSchedule?: boolean;
  teams: Array<{ id: string; name: string; regionName: string | null; reachable: boolean }>;
  eligibleTeams: Array<{ id: string; name: string; regionName: string | null }>;
  standings: {
    table: Array<{ teamId: string; name: string; played: number; won: number; drawn: number; lost: number; gf: number; ga: number; gd: number; pts: number }>;
    scorers: Array<{ name: string; teamName: string; goals: number; assists: number }>;
  };
  games: Array<{
    id: string;
    date: string | null;
    kickoff: string | null;
    location: string | null;
    home: string;
    away: string;
    score: { home: number; away: number } | null;
    canceled: boolean;
    links: Array<{ teamId: string; gameId: string; teamName: string }>;
  }>;
  /** A tournament's bracket; null until one is made. */
  bracket: Bracket | null;
}

/** A team in a bracket: on Lineup (teamId) or typed in by name. */
export interface BracketEntryInput {
  teamId?: string | null;
  name?: string;
}

export interface BracketMatch {
  id: string;
  round: number;
  slot: number;
  thirdPlace: boolean;
  roundName: string;
  home: { teamId?: string | null; name: string; pending?: boolean } | null;
  away: { teamId?: string | null; name: string; pending?: boolean } | null;
  winner: 'home' | 'away' | null;
  decidedBy: 'bye' | 'score' | 'hand' | null;
  score: { home: number; away: number } | null;
  date: string | null;
  kickoff: string | null;
  location: string | null;
  scheduled: boolean;
  links: Array<{ teamId: string; gameId: string }>;
  /** No game on Lineup keeps its score, so it is typed in. */
  canEnterScore: boolean;
}

export interface BracketGroupMatch {
  id: string;
  matchday: number;
  home: { teamId?: string | null; name: string } | null;
  away: { teamId?: string | null; name: string } | null;
  score: { home: number; away: number } | null;
  date: string | null;
  kickoff: string | null;
  location: string | null;
  scheduled: boolean;
  links: Array<{ teamId: string; gameId: string }>;
  canEnterScore: boolean;
}

export interface BracketGroup {
  label: string;
  complete: boolean;
  table: Array<{ teamId: string | null; name: string; played: number; won: number; drawn: number; lost: number; gf: number; ga: number; gd: number; pts: number }>;
  matches: BracketGroupMatch[];
}

export interface Bracket {
  /** Knockout rounds (0 when there is no knockout). */
  rounds: number;
  /** The group stage, when there is one. */
  groups: BracketGroup[];
  matches: BracketMatch[];
}

export type TeamEventKind = 'party' | 'picture_day' | 'fundraiser' | 'meeting' | 'tournament' | 'volunteer' | 'tryout' | 'other';

/** One thing an event can be limited to (Fady, 10/17). */
export interface EventAudienceEntry {
  kind: 'region' | 'division' | 'team' | 'user';
  ref: string;
}

/** Borrowing players for games (Fady, 10/18). */
export interface GameGuests {
  /** May ask to borrow players for this team's games. */
  canBorrow: boolean;
  /** May approve lending this team's players. */
  canDecide: boolean;
  outgoing: Array<{
    id: string;
    gameId: string;
    playerId: string;
    playerName: string;
    number: string | null;
    fromTeamId: string;
    fromTeam: string;
    status: 'pending' | 'approved' | 'declined';
    requestedBy: string | null;
  }>;
  incoming: Array<{
    id: string;
    gameId: string;
    date: string | null;
    kickoff: string | null;
    opponent: string;
    borrower: string;
    playerId: string;
    playerName: string;
    status: 'pending' | 'approved';
    requestedBy: string | null;
    note: string | null;
  }>;
}

export interface BorrowTeam {
  id: string;
  name: string;
  regionName: string | null;
  division: string | null;
  players: Array<{ id: string; name: string; number: string | null }>;
}

/** What an event can be limited to, for the people who create events. */
export interface EventAudienceOptions {
  regions: Array<{ id: string; name: string }>;
  divisions: Array<{ code: string; label: string }>;
  teams: Array<{ id: string; name: string; regionName: string | null; division: string | null }>;
  people: Array<{ id: string; name: string | null; email: string | null; teams: string[] }>;
}

export interface TeamEvent {
  id: string;
  teamId: string | null;
  /** Whose event it is: the team's own, or its region's or organization's. */
  scope?: 'team' | 'region' | 'org';
  scopeName?: string | null;
  /** The team, region or organization the event belongs to. */
  scopeId?: string | null;
  /** The caller may edit or delete this event. */
  canEdit?: boolean;
  kind: TeamEventKind;
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  notes: string | null;
  flyer: { name: string; mime: string; url: string } | null;
  createdBy: string | null;
  /** The most people who may say they're going, across every team. */
  maxGoing?: number | null;
  goingTotal?: number;
  full?: boolean;
  /** Shown only to chosen regions, age groups, teams or people. */
  restricted?: boolean;
  /** Who it is for; only for the people who edit it. Empty means everyone. */
  audience?: EventAudienceEntry[];
  /** Check-ins for an upcoming event, on a team's calendar only. */
  checkin?: {
    children: RsvpChild[];
    counts: { going: number; notGoing: number; noAnswer: number };
    summary: { going: string[]; notGoing: string[]; noAnswer: string[] } | null;
  } | null;
}

export interface TeamEventInput {
  kind: TeamEventKind;
  title: string;
  date: string;
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  notes?: string | null;
  /** A new flyer as a data URL; null removes the current one. */
  flyer?: { dataUrl: string; name: string } | null;
  /** Who sees it; an empty list means everyone in the team, region or organization. */
  audience?: EventAudienceEntry[];
  /** The most people who may say they're going; null for no limit. */
  maxGoing?: number | null;
}

export interface SnackSlot {
  gameId: string;
  gameNo: number;
  date: string | null;
  kickoff: string | null;
  opponent: string;
  isHome: boolean;
  playerId: string | null;
  playerName: string | null;
  family: string | null;
  notes: string | null;
}

/** Events and the snack schedule for one team. */
export interface TeamLife {
  events: TeamEvent[];
  snacks: SnackSlot[];
  canEditEvents: boolean;
  canEditSnacks: boolean;
  canSeeSnacks: boolean;
  /** The caller's plan includes flyers. */
  flyers: boolean;
}

/** Whether an action is allowed, and if not, why and which plan would allow it. */
export interface ScopeDecision {
  allowed: boolean;
  reason: 'no-membership' | 'role-denied' | 'upgrade-required' | 'not-guardian' | 'limit-reached' | null;
  upgradeTo: TierId | null;
}

/** One practice as the caller sees it. */
/**
 * A child's answer to going or not going. The status is the stored one
 * (games: available/absent/injured/late; practices: present/absent/excused/
 * late; events: going/not_going); not going carries a reason.
 */
export interface RsvpChild {
  playerId: string;
  name: string;
  status: string | null;
  reason?: RsvpReason | null;
  note?: string | null;
}

export interface Practice {
  id: string;
  seriesId: string | null;
  date: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  canceled: boolean;
  cancelReason: string | null;
  cancelLabel: string | null;
  cancelNote: string | null;
  opensAt: string;
  closesAt: string;
  open: boolean;
  closed: boolean;
  children: RsvpChild[];
  /** Totals everyone on the team sees; names are in attendance, staff only. */
  counts?: { going: number; notGoing: number; noAnswer: number };
  attendance: RsvpChild[];
}

export interface Practices {
  canSchedule: boolean;
  canSeeSummary: boolean;
  canMarkAttendance: boolean;
  manualAttendancePaid: boolean;
  extendedPractice: boolean;
  freeDays: number;
  reasons: Array<{ id: string; label: string }>;
  series: Array<{
    id: string;
    days: number[];
    startTime: string;
    endTime: string | null;
    location: string | null;
    startsOn: string;
    endsOn: string;
    upcoming: number;
  }>;
  practices: Practice[];
}

/** One team chat as the caller sees it. */
export interface ChatMessage {
  id: string;
  kind: 'message' | 'system' | 'poll';
  mine: boolean;
  author: string;
  /** For a parent: their child (or children) on this team, shown lighter beside the name. */
  child?: string | null;
  role: string | null;
  body: string;
  /** A photo sent with the message (the caption is the body). */
  image?: { url: string } | null;
  createdAt: string;
  editedAt: string | null;
  replyTo: { id: string; author: string; body: string } | null;
  replies: number;
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  /** For a poll: its answers, who picked each, and whether it is closed. */
  poll?: {
    options: Array<{ text: string; votes: number; voters: string[]; mine: boolean }>;
    multi: boolean;
    closed: boolean;
    voters: number;
    canClose: boolean;
  } | null;
  canEdit: boolean;
  canDelete: boolean;
  /** A coach or organization/region staff removing someone else's message. */
  canRemove: boolean;
}

export interface TeamChat {
  teamId: string;
  channel: 'all' | 'staff' | 'coaches';
  channels: Array<{ id: 'all' | 'staff' | 'coaches'; label: string; access: 'member' | 'dropin'; present: boolean }>;
  canRead: boolean;
  dropIn: boolean;
  present: boolean;
  paid: boolean;
  /** The caller may create polls (chatPolls). Anyone in the chat votes. */
  canPoll?: boolean;
  /** The caller may send photos (chatAttachments). Everyone sees them. */
  canPhoto?: boolean;
  pollMaxOptions?: number;
  editMinutes: number;
  retentionDays: number;
  maxLength: number;
  reactions: string[];
  visitors: Array<{ name: string; role: string }>;
  messages: ChatMessage[];
}

/** Game check-ins for a team: a parent's children, or the staff summary. */
export interface CheckinGame {
  id: string;
  date: string;
  kickoff: string | null;
  opponent: string;
  isHome: boolean;
  location: string | null;
  open: boolean;
  canceled?: boolean;
  children: RsvpChild[];
  counts?: { going: number; notGoing: number; late: number; noAnswer: number };
  summary: { going: string[]; notGoing: string[]; late: string[]; noAnswer: string[] } | null;
}

export interface Checkins {
  canSeeSummary: boolean;
  games: CheckinGame[];
}

/** People on a team for the roster's Staff and Parents lists. Names only. */
export interface TeamPeople {
  /** The caller may link or unlink children (coaches on their own team, league staff). */
  canLink?: boolean;
  staff: Array<{
    userId: string;
    name: string;
    role: 'coach' | 'assistant' | 'team_parent';
    children?: Array<{ id: string; name: string }>;
  }>;
  parents: Array<{ userId: string; name: string; children: Array<{ id: string; name: string }> }>;
}

export interface HierarchyRegion {
  id: string;
  name: string;
  teams: number;
  logo: string | null;
  canAssign: boolean;
  /** Rename the region and change its logo (region admins and directors, org staff). */
  canManage?: boolean;
  /** Rename the region: directors only. */
  canRename?: boolean;
  /** Invite people at this region or a team in it. */
  canInvite?: boolean;
  /** Schedule league and tournament games and keep the field maps (staff and schedulers). */
  canSchedule?: boolean;
  /** Set while a standalone region is on its free trial. */
  trialEndsAt?: string | null;
}

export interface HierarchyOrg {
  id: string;
  name: string;
  logo: string | null;
  canManage: boolean;
  /** Rename the organization: its directors only. */
  canRename?: boolean;
  /** Invite people at this organization or anything in it. */
  canInvite?: boolean;
  /** Schedule league and tournament games (staff and schedulers). */
  canSchedule?: boolean;
  /** Set while the organization is on its free trial. */
  trialEndsAt?: string | null;
  addRegion: ScopeDecision;
  regions: HierarchyRegion[];
}

/** One of a region's fields, with its map (Fady, 10/17). */
export interface RegionField {
  id: string;
  regionId: string;
  regionName: string;
  name: string;
  location: string;
  hasMap: boolean;
  version: string;
}

/** A substitution planned for match day: at `atSec` on the period clock, on for off. */
export interface PlannedSub {
  id: string;
  periodIndex: number;
  atSec: number;
  offPlayerId: string;
  onPlayerId: string;
  done: boolean;
  skipped: boolean;
}

/** Older rosters a team can bring players from (its coach's other teams, or its region's). */
export interface RosterSources {
  sources: Array<{
    teamId: string;
    name: string;
    archived: boolean;
    regionName: string | null;
    players: Array<{ id: string; name: string; number: string; active: boolean; hasParents: boolean }>;
  }>;
}

export interface HierarchyTeam {
  id: string;
  name: string;
  logo?: string | null;
  orgId: string | null;
  orgName: string | null;
  regionId: string | null;
  regionName: string | null;
  canMove: boolean;
  /** Archived: read-only, listed under Archived teams in the menu. */
  archived?: boolean;
}

export interface Hierarchy {
  createOrg: ScopeDecision;
  /** Start a standalone region (the Region plan). */
  createRegion?: ScopeDecision;
  orgs: HierarchyOrg[];
  /** Standalone regions: no organization above them. */
  regions?: HierarchyRegion[];
  teams: HierarchyTeam[];
}

/** What creating an invite returns: the link, and whether it was emailed. */
export interface InviteCreated {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: string;
  link: string;
  scopeName: string;
  emailed: boolean;
  emailStatus: 'sent' | 'not-configured' | 'failed';
  shareText: string;
}

export interface InvitePreview {
  status: 'valid' | 'expired' | 'accepted' | 'revoked';
  role: Role;
  roleLabel: string;
  scopeKind: 'org' | 'region' | 'division' | 'team';
  scopeName: string;
  inviter: string;
  emailHint: string;
  expiresAt: string;
}

export type StandingsScope = 'team' | 'region' | 'org';

export interface StandingsRow {
  teamId: string;
  name: string;
  regionId: string | null;
  regionName: string | null;
  reachable: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  pts: number;
}

export interface Standings {
  scope: StandingsScope;
  id: string;
  title: string;
  crumbs: Array<{ kind: 'org' | 'region' | 'team'; id: string; name: string }>;
  table: StandingsRow[];
  scorers: Array<{ name: string; teamName: string; goals: number; assists: number }>;
  /** Region and organization tables count league games only. */
  leagueOnly?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The last answer to each GET during this visit. A screen opened again shows
 * it straight away and refreshes it in the background, so going back to a
 * tab is instant. Any change (POST, PUT, PATCH, DELETE) forgets everything,
 * so nothing older than an edit is ever shown.
 *
 * - The same GET asked twice while the first is still on its way shares that
 *   one request (two screens, or a tab tapped while its data is prefetching).
 * - An answer less than two seconds old is reused without asking again.
 * - Otherwise the app sends the answer's fingerprint (ETag); when nothing
 *   changed the server replies 304 with no body and the same object is
 *   reused, so the screen does not redraw.
 * - The answers a team's screens open with are also saved on this device
 *   (see "Saved on this device" below), so the app opens with them too.
 */
interface Kept {
  data: unknown;
  etag: string | null;
  /** When it was fetched; 0 for an answer loaded from the device, not yet re-checked. */
  at: number;
  /** When the server last confirmed it, for answers loaded from the device. */
  saved?: number;
}
const recent = new Map<string, Kept>();
const inflight = new Map<string, Promise<unknown>>();
const RECENT_MAX = 150;
const FRESH_MS = 2000;
/** Bumped by every change, so an answer that left before it is not kept. */
let generation = 0;

/** The last answer to a GET for this path, if there is one. */
export function peek<T>(path: string): T | undefined {
  return recent.get(path)?.data as T | undefined;
}

function keep(path: string, kept: Kept, save = true) {
  recent.delete(path);
  recent.set(path, kept);
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
  if (save && onDevice(path)) scheduleSave();
}

/* ------------------------------------------------- saved on this device */

/**
 * The calendar, RSVPs, practices, team events, games and roster are saved in
 * the browser (and the Android app's web view), so a screen opens at once
 * with what was last seen. The app then only asks "has it changed?" with the
 * saved fingerprint; an unchanged answer is an empty 304, so nothing is
 * downloaded again. Saved for one account at a time (and per "view as"
 * role), wiped on sign out and on any change, and dropped after a week.
 */
const DEVICE_KEY = 'lineup.cache.v1';
const DEVICE_PATHS = ['/calendar?', '/checkins?', '/practices?', '/team-events?', '/games?', '/players?'];
const DEVICE_MAX_CHARS = 1_500_000;
const DEVICE_MAX_AGE_MS = 7 * 86_400_000;
let deviceOwner: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

interface DeviceCache {
  owner: string;
  entries: Array<[string, { data: unknown; etag: string | null; savedAt: number }]>;
}

function onDevice(path: string): boolean {
  return DEVICE_PATHS.some((p) => path.startsWith(p));
}

function dropDevice() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function scheduleSave() {
  if (!deviceOwner) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDevice, 800);
}

function saveDevice() {
  saveTimer = undefined;
  if (!deviceOwner) return;
  // Oldest first, so the oldest go first when it does not fit.
  let entries: DeviceCache['entries'] = [...recent]
    .filter(([p, k]) => onDevice(p) && (k.at || k.saved))
    .map(([p, k]) => [p, { data: k.data, etag: k.etag, savedAt: k.at || k.saved || 0 }]);
  while (entries.length) {
    const raw = JSON.stringify({ owner: deviceOwner, entries } satisfies DeviceCache);
    if (raw.length <= DEVICE_MAX_CHARS) {
      try {
        localStorage.setItem(DEVICE_KEY, raw);
        return;
      } catch {
        /* storage full: drop the oldest and try again */
      }
    }
    entries = entries.slice(1);
  }
  dropDevice();
}

/** Forget everything saved on this device (sign out). */
export function forgetDeviceCache() {
  deviceOwner = null;
  dropDevice();
}

/**
 * Who is signed in (with any "view as" role). Their saved answers are loaded
 * so screens open with them; another account's are wiped.
 */
export function setDeviceCacheOwner(owner: string | null) {
  if (owner === deviceOwner) return;
  if (!owner) {
    forgetDeviceCache();
    return;
  }
  let saved: DeviceCache | null = null;
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    saved = raw ? (JSON.parse(raw) as DeviceCache) : null;
  } catch {
    saved = null;
  }
  deviceOwner = owner;
  if (!saved || saved.owner !== owner || !Array.isArray(saved.entries)) {
    dropDevice();
    return;
  }
  const oldest = Date.now() - DEVICE_MAX_AGE_MS;
  for (const [path, e] of saved.entries) {
    if (onDevice(path) && e.savedAt >= oldest && !recent.has(path)) {
      keep(path, { data: e.data, etag: e.etag, at: 0, saved: e.savedAt }, false);
    }
  }
}

// Every "Sign out" link wipes what is saved before leaving.
if (typeof document !== 'undefined') {
  document.addEventListener(
    'click',
    (ev) => {
      const a = (ev.target as Element | null)?.closest?.('a[href*="/.auth/logout"]');
      if (a) forgetDeviceCache();
    },
    true,
  );
}

async function failure(res: Response): Promise<ApiError> {
  let payload: { error?: string; code?: string; details?: unknown } = {};
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(payload.error ?? `Request failed (${res.status})`, res.status, payload.code, payload.details);
}

/**
 * Called when the server answers 401 (the sign-in ran out). The app shows the
 * sign-in screen with "Your session expired" instead of an error.
 */
let sessionExpired: (() => void) | null = null;
export function onSessionExpired(fn: (() => void) | null) {
  sessionExpired = fn;
}

async function failed(res: Response): Promise<ApiError> {
  const err = await failure(res);
  if (res.status === 401 && err.code !== 'SIGNED_OUT') sessionExpired?.();
  return err;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { 'Content-Type': 'application/json', ...((init?.headers as Record<string, string>) ?? {}) };

  if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
    try {
      const res = await fetch(`${BASE}${path}`, { ...init, headers });
      if (!res.ok) throw await failed(res);
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    } finally {
      generation += 1;
      recent.clear();
      dropDevice();
      inflight.clear();
    }
  }

  const kept = recent.get(path);
  if (kept && Date.now() - kept.at < FRESH_MS) return kept.data as T;
  const running = inflight.get(path);
  if (running) return running as Promise<T>;

  const started = generation;
  const p = (async () => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: kept?.etag ? { ...headers, 'If-None-Match': kept.etag } : headers,
    });
    if (res.status === 304 && kept) {
      if (started === generation) keep(path, { ...kept, at: Date.now() });
      return kept.data as T;
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) recent.delete(path);
      throw await failed(res);
    }
    const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    if (started === generation) keep(path, { data, etag: res.headers.get('ETag'), at: Date.now() });
    return data;
  })();
  inflight.set(path, p);
  p.finally(() => {
    if (inflight.get(path) === p) inflight.delete(path);
  }).catch(() => undefined);
  return p;
}

const enc = encodeURIComponent;

/** Addresses of the GETs screens show again on return, shared with peek(). */
export const apiPath = {
  listGames: (teamId: string) => `/games?teamId=${enc(teamId)}`,
  listPlayers: (teamId: string) => `/players?teamId=${enc(teamId)}`,
  teamPeople: (teamId: string) => `/team-people?teamId=${enc(teamId)}`,
  checkins: (teamId: string) => `/checkins?teamId=${enc(teamId)}`,
  practices: (teamId: string) => `/practices?teamId=${enc(teamId)}`,
  chat: (teamId: string, channel?: string) => `/chat?teamId=${enc(teamId)}${channel ? `&channel=${channel}` : ''}`,
  analytics: (teamId: string) => `/analytics?teamId=${enc(teamId)}`,
  calendar: (scope: StandingsScope, id: string) => `/calendar?scope=${scope}&id=${enc(id)}`,
  teamStats: (teamId: string) => `/team-stats?teamId=${enc(teamId)}`,
  teamLife: (teamId: string) => `/team-events?teamId=${enc(teamId)}`,
  standings: (scope: StandingsScope, id: string) => `/standings?scope=${scope}&id=${enc(id)}`,
  evaluations: (teamId: string) => `/evaluations?teamId=${enc(teamId)}`,
};

const body = (b: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(b) });

export const api = {
  health: () => request<{ status: string; database: string }>('/health'),
  me: () => request<MeResponse>('/me'),
  acceptTerms: (b: { version: string; over18: boolean; agree: boolean }) =>
    request<{ version: string; accepted: boolean }>('/me/terms', body(b)),

  listTeams: () => request<Team[]>('/teams'),
  createTeam: (team: Partial<Team> & { catalogDivisionId?: string; regionId?: string }) =>
    request<Team>('/teams', body(team)),
  updateTeam: (team: { id: string; name?: string; coach?: string; catalogDivisionId?: string }) =>
    request<Team>('/teams', { method: 'PATCH', body: JSON.stringify(team) }),
  /** Archive a team (read-only) or bring it back within 1 month. */
  archiveTeam: (id: string, action: 'archive' | 'restore') =>
    request<Team>('/teams', { method: 'PATCH', body: JSON.stringify({ id, action }) }),
  /** Older rosters this team can bring players from. */
  rosterSources: (teamId: string) => request<RosterSources>(`/roster-import?teamId=${encodeURIComponent(teamId)}`),
  importPlayers: (b: { teamId: string; sourceTeamId: string; playerIds: string[]; withParents: boolean }) =>
    request<{ added: number; skipped: number; parentsAdded: number }>('/roster-import', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  listGames: (teamId: string) =>
    request<Game[]>(apiPath.listGames(teamId)),
  saveGame: (game: Partial<Game>) => request<Game & { proposalPending?: boolean }>('/games', body(game)),

  listPlayers: (teamId: string) =>
    request<Player[]>(apiPath.listPlayers(teamId)),
  savePlayers: (teamId: string, players: Partial<Player>[]) =>
    request<Player[]>('/players', {
      method: 'PUT',
      body: JSON.stringify({ teamId, players }),
    }),
  /** Staff and parents on a team, names only. */
  teamPeople: (teamId: string) =>
    request<TeamPeople>(apiPath.teamPeople(teamId)),
  linkChild: (b: { action: 'link' | 'unlink'; teamId: string; userId: string; playerId: string }) =>
    request<{ ok: boolean }>('/team-people', body(b)),
  checkins: (teamId: string) => request<Checkins>(apiPath.checkins(teamId)),
  practices: (teamId: string) => request<Practices>(apiPath.practices(teamId)),
  practiceAction: (b: {
    action: 'schedule' | 'add' | 'removeSchedule' | 'cancel' | 'restore' | 'delete' | 'checkin' | 'mark';
    teamId?: string;
    practiceId?: string;
    seriesId?: string;
    playerId?: string;
    status?: string;
    days?: number[];
    date?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    startsOn?: string;
    endsOn?: string;
    timezone?: string;
    reason?: string;
    note?: string;
  }) => request<{ ok?: boolean; practices?: number }>('/practices', body(b)),
  chat: (teamId: string, channel?: string) =>
    request<TeamChat>(apiPath.chat(teamId, channel)),
  chatAction: (b: {
    action: 'send' | 'edit' | 'delete' | 'react' | 'enter' | 'leave' | 'poll' | 'vote' | 'closePoll';
    teamId?: string;
    channel?: string;
    body?: string;
    replyTo?: string;
    messageId?: string;
    emoji?: string;
    question?: string;
    options?: string[];
    multi?: boolean;
    choices?: number[];
    /** A photo as a data URL (image/jpeg, png, webp or gif). */
    image?: string;
    /** Up to CHAT_PHOTOS_PER_SEND photos; each becomes its own message. */
    images?: string[];
  }) => request<{ ok?: boolean; id?: string; ids?: string[] }>('/chat', body(b)),
  checkIn: (b: { gameId: string; playerId: string; status: 'available' | 'absent'; reason?: RsvpReason; note?: string }) =>
    request<{ status: string }>('/checkins', body(b)),

  catalog: () => request<CatalogDivision[]>('/divisions/catalog'),

  search: (q: string) =>
    request<{ query: string; results: SearchHit[] }>(
      `/search?q=${encodeURIComponent(q)}`,
    ),

  impersonation: () => request<ImpersonationState>('/impersonate'),
  startImpersonation: (b: { role: string | null; tier: string | null }) =>
    request<ImpersonationState>('/impersonate', body(b)),
  stopImpersonation: () =>
    request<ImpersonationState>('/impersonate', body({ stop: true })),

  periods: (gameId: string) =>
    request<GamePeriod[]>(`/periods?gameId=${encodeURIComponent(gameId)}`),
  clock: (
    gameId: string,
    periodIndex: number,
    action: 'start' | 'pause' | 'reset' | 'end' | 'setFormation' | 'setLength',
    extra: { formation?: string; lengthSec?: number } = {},
  ) =>
    request<GamePeriod[]>(
      `/periods?gameId=${encodeURIComponent(gameId)}`,
      body({ periodIndex, action, ...extra }),
    ),

  availability: (gameId: string) =>
    request<Availability[]>(`/availability?gameId=${encodeURIComponent(gameId)}`),
  setAvailability: (gameId: string, playerId: string, status: string) =>
    request<Availability[]>(
      `/availability?gameId=${encodeURIComponent(gameId)}`,
      body({ playerId, status }),
    ),

  autoLineup: (gameId: string, seed?: number) =>
    request<{
      assignments: Assignments;
      report: { fairness: PlayerFairness[]; spread: number; warnings: string[] } | null;
      proposal?: boolean;
    }>('/lineup', body({ gameId, action: 'auto', seed })),
  copyLineup: (gameId: string, sourceGameId: string) =>
    request<{ assignments: Assignments; report: { dropped: string[] } | null; proposal?: boolean }>(
      '/lineup',
      body({ gameId, action: 'copy', sourceGameId }),
    ),
  placePlayer: (
    gameId: string,
    periodIndex: number,
    slotId: string,
    playerId: string | null,
  ) =>
    request<{ assignments: Assignments; proposal?: boolean }>(
      '/lineup',
      body({ gameId, action: 'set', periodIndex, slotId, playerId }),
    ),
  clearLineup: (gameId: string) =>
    request<{ assignments: Assignments; proposal?: boolean }>('/lineup', body({ gameId, action: 'clear' })),
  lineupProposal: (gameId: string) =>
    request<LineupProposalState>(`/lineup-proposal?gameId=${encodeURIComponent(gameId)}`),
  lineupProposalAction: (b: { gameId: string; action: 'approve' | 'reject' | 'assistantFree'; value?: boolean }) =>
    request<LineupProposalState>('/lineup-proposal', body(b)),

  /** A region's fields and field maps (by region, a team's region, or a league's). */
  regionFields: (q: { regionId?: string; teamId?: string; competitionId?: string }) =>
    request<{ fields: RegionField[]; canManage: boolean; max: number }>(
      `/region-fields?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as Array<[string, string]>).toString()}`,
    ),
  regionFieldAction: (
    b:
      | { action: 'add'; regionId: string; name: string; location: string; map: string | null }
      | { action: 'update'; id: string; name: string; location: string; map: string | null }
      | { action: 'remove'; id: string },
  ) => request<{ fields: RegionField[] }>('/region-fields', body(b)),

  /** Planned substitutions on match day. */
  subs: (gameId: string) => request<{ subs: PlannedSub[] }>(`/subs?gameId=${encodeURIComponent(gameId)}`),
  subAction: (
    b:
      | { action: 'add'; gameId: string; periodIndex: number; atSec: number; offPlayerId: string; onPlayerId: string }
      | { action: 'remove' | 'done' | 'skip' | 'undo'; id: string },
  ) => request<{ subs: PlannedSub[] }>('/subs', body(b)),

  events: (gameId: string) =>
    request<GameEvent[]>(`/events?gameId=${encodeURIComponent(gameId)}`),
  addEvent: (gameId: string, e: Partial<GameEvent>) =>
    request<GameEvent>(`/events?gameId=${encodeURIComponent(gameId)}`, body(e)),
  deleteEvent: (gameId: string, id: string) =>
    request<void>(
      `/events?gameId=${encodeURIComponent(gameId)}&id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  attendance: (teamId: string, from?: string, to?: string) => {
    const q = new URLSearchParams({ teamId });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return request<Array<{ player_id: string; on_date: string; status: string }>>(
      `/attendance?${q}`,
    );
  },
  saveAttendance: (
    teamId: string,
    entries: Array<{ playerId: string; onDate: string; status: string }>,
  ) =>
    request<{ saved: number }>(
      `/attendance?teamId=${encodeURIComponent(teamId)}`,
      body({ entries }),
    ),

  analytics: (teamId: string) =>
    request<Analytics>(apiPath.analytics(teamId)),

  members: (teamId: string) =>
    request<Member[]>(`/members?teamId=${encodeURIComponent(teamId)}`),
  invite: (b: {
    email: string;
    name?: string;
    role: Role;
    teamId?: string;
    regionId?: string;
    orgId?: string;
    playerId?: string;
  }) =>
    request<InviteCreated>('/members', body(b)),
  removeMember: (id: string) =>
    request<void>(`/members?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  exportUrl: (teamId: string) => `${BASE}/export?teamId=${encodeURIComponent(teamId)}`,
  deleteThing: (scope: 'team' | 'game' | 'player' | 'account', id?: string) => {
    const q = new URLSearchParams({ scope });
    if (id) q.set('id', id);
    return request<{ deleted?: string; queued?: boolean; executeAt?: string }>(
      `/delete?${q}`,
      { method: 'DELETE' },
    );
  },
  undelete: () => request<{ cancelled: boolean }>('/undelete', body({})),
  deactivateAccount: () => request<{ deactivated: boolean; deletesAt: string | null }>('/me/deactivate', body({})),
  reactivateAccount: () => request<{ reactivated: boolean }>('/me/reactivate', body({})),
  resumeSubscription: () =>
    request<{ resumed: boolean; tier: TierId }>('/subscription/resume', body({})),

  /** Places matching a typed location (OpenStreetMap), to pick the exact address. */
  referee: () => request<RefereeView>('/referee'),
  refereeAction: (b: {
    action: 'join' | 'leave' | 'favorite' | 'take' | 'drop';
    code?: string;
    orgId?: string;
    regionId?: string | null;
    fixtureId?: string;
    slot?: RefereeSlot;
  }) => request<RefereeView>('/referee', body(b)),
  refereeStaff: (scope: 'org' | 'region', id: string) =>
    request<RefereeStaffView>(`/referees?scope=${scope}&id=${encodeURIComponent(id)}`),
  refereeStaffAction: (b: {
    action: 'code' | 'remove' | 'assign' | 'unassign';
    scope?: 'org' | 'region';
    id?: string;
    on?: boolean;
    rotate?: boolean;
    userId?: string;
    fixtureId?: string;
    slot?: RefereeSlot;
  }) => request<RefereeStaffView & { ok?: boolean }>('/referees', body(b)),
  refMatch: (fixtureId: string) => request<RefMatch>(`/ref-match?fixtureId=${encodeURIComponent(fixtureId)}`),
  refMatchAction: (b: {
    fixtureId: string;
    action: 'status' | 'event' | 'deleteEvent' | 'clock' | 'notes' | 'final' | 'reopen';
    playerId?: string;
    playerOutId?: string;
    status?: RefPlayerStatus;
    kind?: RefEventKind;
    side?: 'home' | 'away';
    minute?: number | null;
    eventId?: string;
    op?: 'start' | 'pause' | 'next' | 'reset';
    notes?: string;
    homeScore?: number;
    awayScore?: number;
  }) => request<RefMatch>('/ref-match', body(b)),
  findPlaces: (q: string, lang = 'en') =>
    request<{ places: Array<{ label: string; name: string; lat: number; lon: number }>; source: string }>(
      `/places?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`,
    ),
  trials: () => request<TrialStatus>('/trials'),
  startTrial: (tier: TrialTier, name?: string) =>
    request<{ tier: TrialTier; days: number; endsAt: string; orgId: string | null; regionId: string | null; status: TrialStatus }>(
      '/trials',
      body({ tier, name }),
    ),
  dismissTrial: () => request<TrialStatus>('/trials/dismiss', body({})),

  supportRequests: () => request<SupportRequest[]>('/support'),
  createSupportRequest: (b: { subject: string; body: string }) =>
    request<SupportRequest>('/support', body(b)),
  addSupportComment: (requestId: string, text: string) =>
    request<SupportComment>('/support/comments', body({ requestId, body: text })),
  adminSupport: (b: { requestId: string; body?: string; status?: SupportRequest['status']; scoutEligible?: boolean }) =>
    request<{ comments: SupportComment[]; status: SupportRequest['status'] | null; scoutEligible?: boolean | null }>(
      '/console/support',
      body(b),
    ),

  calendar: (scope: StandingsScope, id: string) =>
    request<Calendar>(apiPath.calendar(scope, id)),
  createFixture: (f: FixtureInput) => request<{ id: string }>('/fixtures', body(f)),
  competitions: (scope: StandingsScope | 'mine', id: string) =>
    request<CompetitionList>(`/competitions?scope=${scope}&id=${encodeURIComponent(id)}`),
  competition: (id: string) => request<CompetitionDetail>(`/competitions?competitionId=${encodeURIComponent(id)}`),
  competitionAction: (b: {
    action: 'create' | 'update' | 'delete' | 'addTeams' | 'removeTeam';
    id?: string;
    scope?: CompetitionOwnerScope;
    scopeId?: string;
    kind?: CompetitionKind;
    name?: string;
    startsOn?: string;
    endsOn?: string;
    teamIds?: string[];
    teamId?: string;
  }) => request<{ id?: string; added?: number }>('/competitions', body(b)),
  /** A tournament's bracket: make, remove, set a first-round match, set a winner, schedule a match. */
  bracketAction: (
    b:
      | {
          action: 'bracketCreate';
          id: string;
          entries: BracketEntryInput[];
          thirdPlace: boolean;
          /** A group stage first: teams per group and how many of each go through. */
          groups?: { perGroup: number; advance: number } | null;
        }
      | { action: 'bracketScore'; id: string; matchId: string; homeScore: number | null; awayScore: number | null }
      | { action: 'bracketDelete'; id: string }
      | { action: 'bracketSet'; id: string; matchId: string; home: BracketEntryInput | null; away: BracketEntryInput | null }
      | { action: 'bracketWinner'; id: string; matchId: string; winner: 'home' | 'away' | null }
      | { action: 'bracketSchedule'; id: string; matchId: string; date: string; kickoff?: string; location?: string },
  ) => request<unknown>('/competitions', body(b)),
  /** A team in an organization or region gets back a pending request (status 'pending') unless the caller may approve it. */
  createFriendly: (f: FriendlyInput) =>
    request<{
      id?: string;
      pairedGameId?: string | null;
      requestId?: string;
      status?: 'approved' | 'pending';
      waitingFor?: string;
    }>('/friendlies', body(f)),
  friendlyRequests: (q: { teamId: string } | { scope: 'region' | 'org'; id: string }) =>
    request<{ requests: FriendlyRequest[] }>(
      'teamId' in q
        ? `/friendly-requests?teamId=${encodeURIComponent(q.teamId)}`
        : `/friendly-requests?scope=${q.scope}&id=${encodeURIComponent(q.id)}`,
    ),
  friendlyRequestAction: (b: { action: 'approve' | 'decline' | 'cancel'; id: string; reason?: string }) =>
    request<{ status: string; waitingFor?: string; gameId?: string }>('/friendly-requests', body(b)),
  friendlyOpponents: (teamId: string, search?: string) =>
    request<{ opponents: FriendlyOpponent[]; searchable?: boolean; requestOnly?: boolean }>(
      `/friendlies?teamId=${encodeURIComponent(teamId)}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    ),

  teamStats: (teamId: string) => request<CustomStats>(apiPath.teamStats(teamId)),
  addTeamStat: (teamId: string, name: string) =>
    request<{ id: string; name: string }>('/team-stats', body({ teamId, name })),
  removeTeamStat: (id: string) =>
    request<void>(`/team-stats?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  statValues: (gameId: string) =>
    request<Array<{ playerId: string; statId: string; value: number }>>(
      `/stat-values?gameId=${encodeURIComponent(gameId)}`,
    ),
  bumpStat: (gameId: string, playerId: string, statId: string, delta: 1 | -1) =>
    request<{ playerId: string; statId: string; value: number }>(
      '/stat-values',
      body({ gameId, playerId, statId, delta }),
    ),
  updateFixture: (f: { id: string; date?: string; kickoff?: string; location?: string; field?: string }) =>
    request<{ id: string }>('/fixtures', { method: 'PATCH', body: JSON.stringify(f) }),
  /** Cancel a game (or undo): a league game by fixtureId, a team's own by gameId. */
  cancelGame: (b: { gameId?: string; fixtureId?: string; action: 'cancel' | 'restore'; reason?: string; note?: string }) =>
    request<{ ok: boolean; canceled: boolean }>('/games/cancel', body(b)),
  deleteFixture: (id: string) =>
    request<void>(`/fixtures?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  teamLife: (teamId: string) => request<TeamLife>(apiPath.teamLife(teamId)),
  /** Events of a region or organization (and its organization's or regions'). */
  scopeLife: (scope: 'org' | 'region', id: string) =>
    request<TeamLife>(`/team-events?scope=${scope}&id=${encodeURIComponent(id)}`),
  createScopeEvent: (e: TeamEventInput & { scope: 'org' | 'region'; scopeId: string }) =>
    request<TeamEvent>('/team-events', body(e)),
  createTeamEvent: (e: TeamEventInput & { teamId: string }) => request<TeamEvent>('/team-events', body(e)),
  eventAudienceOptions: (scope: 'org' | 'region' | 'team', id: string) =>
    request<EventAudienceOptions>(`/team-events/audience?scope=${scope}&id=${encodeURIComponent(id)}`),
  gameGuests: (teamId: string) => request<GameGuests>(`/game-guests?teamId=${encodeURIComponent(teamId)}`),
  coachSignups: (competitionId: string) =>
    request<CoachSignups>(`/competition-signups?competitionId=${encodeURIComponent(competitionId)}`),
  coachSignupAction: (b: {
    competitionId: string;
    action: 'approve' | 'decline' | 'place' | 'window';
    ids?: string[];
    id?: string;
    teamId?: string;
    regOpensOn?: string | null;
    regClosesOn?: string | null;
  }) => request<{ placed?: boolean; secondParent?: string | null; updated?: number }>('/competition-signups', body(b)),
  family: () => request<Family>('/family'),
  familyAction: (
    b: { action: 'invite'; email: string; label?: ParentLabel | null } | { action: 'profile'; salutation: string | null; label: ParentLabel | null },
  ) => request<{ invited?: boolean; linked?: boolean; emailed?: boolean; link?: string | null }>('/family', body(b)),
  borrowOptions: (teamId: string) =>
    request<{ teams: BorrowTeam[] }>(`/game-guests?teamId=${encodeURIComponent(teamId)}&options=1`),
  gameGuestAction: (
    b:
      | { action: 'request'; gameId: string; playerId: string; note?: string }
      | { action: 'decide'; id: string; approve: boolean }
      | { action: 'cancel'; id: string },
  ) => request<{ id?: string; status?: string }>('/game-guests', body(b)),
  updateTeamEvent: (e: TeamEventInput & { id: string }) =>
    request<TeamEvent>('/team-events', { method: 'PATCH', body: JSON.stringify(e) }),
  deleteTeamEvent: (id: string) =>
    request<void>(`/team-events?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  eventCheckIn: (b: {
    eventId: string;
    teamId: string;
    playerId: string;
    status: 'going' | 'not_going';
    reason?: RsvpReason;
    note?: string;
  }) =>
    request<{ status: string }>('/team-events/checkin', body(b)),
  setSnack: (s: { gameId: string; playerId?: string | null; family?: string | null; notes?: string | null }) =>
    request<void>('/snacks', body(s)),

  logoUrl: (kind: LogoKind, id: string, version: string) =>
    `${BASE}/logo?kind=${kind}&id=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}`,
  uploadLogo: (kind: LogoKind, id: string, dataUrl: string) =>
    request<{ version: string | null }>('/logo', {
      method: 'PUT',
      body: JSON.stringify({ kind, id, dataUrl }),
    }),
  removeLogo: (kind: LogoKind, id: string) =>
    request<void>(`/logo?kind=${kind}&id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  hierarchy: () => request<Hierarchy>('/hierarchy'),
  createOrg: (name: string) => request<{ id: string; name: string }>('/orgs', body({ name })),
  updateOrg: (b: { id: string; name: string }) =>
    request<{ id: string; name: string }>('/orgs', { method: 'PATCH', body: JSON.stringify(b) }),
  /** Without orgId, starts a standalone region (the Region plan). */
  createRegion: (b: { orgId?: string; name: string }) =>
    request<{ id: string }>('/regions', body(b)),
  updateRegion: (b: { id: string; orgId?: string; name?: string }) =>
    request<{ id: string }>('/regions', { method: 'PATCH', body: JSON.stringify(b) }),
  moveTeam: (teamId: string, regionId: string | null) =>
    request<{ teamId: string }>('/hierarchy/move-team', body({ teamId, regionId })),

  invitePreview: (token: string) =>
    request<InvitePreview>(`/invites/preview?token=${encodeURIComponent(token)}`),
  acceptInvite: (token: string) =>
    request<{ role: Role; teamId: string | null; regionId: string | null; orgId: string | null }>(
      '/invites/accept',
      body({ token }),
    ),

  standings: (scope: StandingsScope, id: string) =>
    request<Standings>(apiPath.standings(scope, id)),

  admin: (
    view: 'insights' | 'summary' | 'users' | 'abuse' | 'subscriptions' | 'deletions' | 'support',
    q?: string,
  ) => request<any>(`/console?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  /** Most-opened pages and most-tapped buttons over the last `days` days. */
  adminUsage: (days: number) => request<AdminUsage>(`/console?view=usage&days=${days}`),
  /** Two-step sign-in with text-message codes: whether it is on, and the phone (masked). */
  twoStep: () => request<TwoStep>('/two-step'),
  twoStepAction: (action: 'on' | 'off' | 'reset-phone') => request<TwoStep>('/two-step', body({ action })),
  /** Push notifications: the public key, and how many devices have them on. */
  push: () => request<{ available: boolean; publicKey: string | null; devices: number }>('/push'),
  savePush: (sub: PushSubscriptionJSON) => request<{ ok: boolean }>('/push', body(sub)),
  removePush: (endpoint: string) => request<void>(`/push?endpoint=${encodeURIComponent(endpoint)}`, { method: 'DELETE' }),
  testPush: () => request<{ sent: number }>('/push', body({ test: true })),
  reportPush: (report: { outcome: string; step?: string; detail?: string; permission?: string; installed?: boolean }) =>
    request<void>('/push', body({ report })),
  adminUser: (id: string) => request<any>(`/console?view=user&id=${encodeURIComponent(id)}`),
  adminUserAction: (b: {
    userId: string;
    action: 'disable' | 'enable' | 'signout' | 'delete' | 'recover';
    reason?: string;
  }) => request<{ ok: boolean; action: string }>('/console/users/action', body(b)),
  notifications: () => request<NotificationList>('/notifications'),
  markNotificationsRead: (b: { ids?: string[]; all?: boolean }) =>
    request<NotificationList>('/notifications', body(b)),
  adminNotifyInfo: () => request<any>('/console/notify'),
  adminNotify: (b: {
    title?: string;
    body?: string;
    link?: string;
    target: { scope: 'platform' | 'org' | 'region' | 'team'; id?: string | null; roles?: string[]; tiers?: string[] };
    dryRun?: boolean;
  }) => request<{ recipients: number; id?: string }>('/console/notify', body(b)),
  adminBilling: () => request<AdminBilling>('/console/billing'),
  adminBillingAction: (
    b: Record<string, unknown> & { action: 'coupon.create' | 'coupon.toggle' | 'refund.decide' | 'refund.issue' },
  ) => request<any>('/console/billing', body(b)),
  refunds: () => request<RefundRequest[]>('/refunds'),
  requestRefund: (reason: string) => request<{ id: string; status: string }>('/refunds', body({ reason })),
  /** Stripe's payment page for a plan. */
  checkout: (tier: TierId) => request<{ url: string }>('/billing/checkout', body({ tier })),
  /** Stripe's customer portal: card, invoices, cancel. */
  billingPortal: () => request<{ url: string }>('/billing/portal', body({})),
  evaluations: (teamId: string) => request<Evaluations>(apiPath.evaluations(teamId)),
  saveEvaluation: (b: { playerId: string; scores: Record<string, number>; strongFoot: string | null; notes: string | null }) =>
    request<PlayerEvaluation>('/evaluations', body(b)),
  savePlayerAvatar: (playerId: string, avatar: Avatar, heritage?: string | null) =>
    request<{ playerId: string; avatar: Avatar; heritage: string | null }>(
      '/player-avatar',
      body(heritage === undefined ? { playerId, avatar } : { playerId, avatar, heritage }),
    ),
  joinLookup: (code: string) => request<JoinRegionInfo>('/join', body({ code, lookup: true })),
  joinRegion: (b: {
    code: string;
    phone?: string;
    children: JoinChildInput[];
    parentLabel?: ParentLabel;
    salutation?: string;
    secondParentEmail?: string;
    secondParentLabel?: ParentLabel;
  }) =>
    request<{ created: number; skipped: number; region: JoinRegionInfo }>('/join', body(b)),
  mySignups: () => request<MySignups>('/join'),
  withdrawSignup: (id: string) => request<void>(`/join?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
  regionSignups: (regionId: string) =>
    request<RegionSignups>(`/region-signups?regionId=${encodeURIComponent(regionId)}`),
  regionSignupAction: (b: {
    regionId: string;
    action: 'approve' | 'decline' | 'place' | 'assign' | 'window';
    ids?: string[];
    id?: string;
    teamId?: string;
    userId?: string;
    role?: string;
    /** For assign: the person's child on the chosen team (required for Parent). */
    playerId?: string;
    /** For window: a league's or tournament's registration dates. */
    competitionId?: string;
    regOpensOn?: string | null;
    regClosesOn?: string | null;
  }) => request<any>('/region-signups', body(b)),
};

export interface JoinRegionInfo {
  regionId: string;
  regionName: string;
  orgName: string | null;
  code: string;
  season: string;
  /** The league or tournament the sign-up code belongs to. */
  competitionId?: string;
  competitionName?: string;
  kind?: 'season' | 'tournament';
  startsOn?: string;
  endsOn?: string;
  regOpensOn?: string | null;
  regClosesOn?: string;
  registration?: 'upcoming' | 'open' | 'closed';
}

/** One of a region's leagues or tournaments on its Sign-ups tab. */
export interface SignupCompetition extends Required<Pick<JoinRegionInfo, 'competitionId' | 'competitionName' | 'kind' | 'startsOn' | 'endsOn' | 'regClosesOn' | 'registration'>> {
  regionId: string;
  regionName: string;
  orgName: string | null;
  code: string;
  regOpensOn: string | null;
  teamIds: string[];
  waiting: number;
}

export interface JoinChildInput {
  name: string;
  birthYear: number;
  birthMonth: number;
  gender: 'boys' | 'girls';
  priorPlayerId?: string | null;
}

export interface Signup {
  id: string;
  /** Null for a coach's own league or tournament. */
  regionId: string | null;
  regionName: string;
  orgName: string | null;
  /** The league or tournament signed up for (none for old region-wide sign-ups). */
  competitionId?: string | null;
  competitionName?: string | null;
  season: string;
  childName: string;
  birthYear: number;
  birthMonth: number;
  gender: 'boys' | 'girls';
  division: string;
  status: 'pending' | 'approved' | 'declined' | 'placed' | 'withdrawn';
  teamId: string | null;
  teamName: string | null;
  createdAt: string;
  parentEmail?: string | null;
  parentName?: string | null;
  parentPhone?: string | null;
  /** Mother, father or guardian, if the parent said (Fady, 10/19). */
  parentLabel?: ParentLabel | null;
  secondParentEmail?: string | null;
}

export type ParentLabel = 'mother' | 'father' | 'guardian';

/** A coach's own league or tournament: its sign-up link and who is waiting (Fady, 10/19). */
export interface CoachSignups {
  competition: SignupCompetition;
  signups: Signup[];
  teams: Array<{ id: string; name: string; division: string | null }>;
  /** A coach of one of its teams: sees and shares the link, nothing else (Fady, 10/20). */
  shareOnly?: boolean;
}

/** A parent's family on Account (Fady, 10/19). */
export interface Family {
  salutation: string | null;
  label: ParentLabel | null;
  children: Array<{ playerId: string; name: string; teamId: string; teamName: string }>;
  otherParents: Array<{ name: string | null; email: string | null; salutation: string | null; label: ParentLabel | null; children: string[] }>;
  pending: Array<{ email: string; label: ParentLabel | null; sentAt: string }>;
}

export interface MySignups {
  signups: Signup[];
  children: Array<{ playerId: string; name: string; teamName: string }>;
  season: string;
}

export interface RegionSignups {
  region: JoinRegionInfo;
  /** The region's leagues and tournaments that have not ended, each with its sign-up link. */
  competitions: SignupCompetition[];
  signups: Signup[];
  teams: Array<{ id: string; name: string; division: string | null }>;
  /** People who signed up with the code or already hold a role on a team here. */
  people?: Array<{
    userId: string;
    name: string | null;
    email: string | null;
    roles: Array<{ teamId: string; teamName: string; role: string; children?: string[] }>;
  }>;
}

export interface PlayerEvaluation {
  playerId: string;
  playerName?: string;
  number?: string;
  position?: string | null;
  /** The cartoon a parent designed; null until they do. */
  avatar?: Avatar | null;
  /** Boy or girl: the avatar shown until one is designed. */
  gender?: 'boy' | 'girl' | null;
  /** The caller is this player's parent, so they may design the avatar. */
  canEditAvatar?: boolean;
  scores?: Record<string, number>;
  strongFoot?: 'left' | 'right' | 'both' | null;
  notes?: string | null;
  overall: number | null;
  /** FIFA-style card: overall and six stats out of 99, and its colour. */
  card?: { rating: number | null; stats: Record<CardStat, number | null>; tier: CardTier };
  updatedAt?: string | null;
  /** The player's ID in an organization or region, e.g. "AvaG001". */
  publicId?: string | null;
  /** Shown as flags on the card: always the US, plus the family's home country if picked. */
  country?: string;
  heritage?: string | null;
  teamName?: string | null;
  regionName?: string | null;
  /** The team's region logo, for the card. */
  regionLogo?: string | null;
}

export interface Evaluations {
  /** edit: coaches and assistants; view: org and region staff; overall: a parent's own child. */
  mode: 'edit' | 'view' | 'overall';
  locked: boolean;
  /** Designing a child's avatar needs a paid plan. */
  avatarLocked?: boolean;
  evaluations: PlayerEvaluation[];
}

export interface Integration {
  key: string;
  name: string;
  status: 'connected' | 'not_connected' | 'off' | 'pending' | 'error';
  detail: string;
}

export interface Coupon {
  id: string;
  code: string;
  percentOff: number | null;
  amountOffCents: number | null;
  tiers: string[];
  maxRedemptions: number | null;
  redemptions: number;
  expiresAt: string | null;
  active: boolean;
  expired: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface RefundRequest {
  id: string;
  tier: string;
  reason: string;
  status: 'pending' | 'approved' | 'declined' | 'refunded';
  adminNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  userId?: string;
  email?: string | null;
  name?: string | null;
  decidedBy?: string | null;
  /** Sent back through Stripe. */
  amountCents?: number | null;
  refundedAt?: string | null;
  /** Paid through Stripe, so the console can send the refund. */
  canIssue?: boolean;
}

export interface AdminBilling {
  integrations: Integration[];
  coupons: Coupon[];
  refunds: RefundRequest[];
  subscribers: Record<string, number>;
  prices: Record<string, number>;
  /** This month (Pacific): money in from Stripe, paid plans, refunds against the cap. */
  money?: {
    mode: 'test' | 'live' | null;
    monthStart: string;
    revenueCents: number | null;
    activePaidPlans: number;
    refundedCents: number;
    refundCapCents: number;
  };
}

export interface AppNotification {
  id: string;
  kind: 'message' | 'reminder' | 'system';
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  /** Messages rolled into this one (a busy chat keeps one notification). */
  batch?: number;
  /** Who sent the first of them, and their child on the team (or role). */
  fromName?: string | null;
  fromDetail?: string | null;
}

export interface NotificationList {
  unread: number;
  items: AppNotification[];
}

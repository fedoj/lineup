# Lineup

Team lineup, fair rotation and season tracking. First app on a shared
TypeScript platform designed to host many small apps.

## Stack

| Layer | Technology |
|---|---|
| Web | React 18 + TypeScript + Vite |
| API | Azure Functions v4 (TypeScript) |
| Database | Azure Database for PostgreSQL Flexible Server |
| Hosting | Azure Static Web Apps (Standard) |
| IaC | Bicep |
| CI/CD | GitHub Actions with OIDC federation |
| Mobile | Capacitor Android shell (`apps/web/android`) with Google AdMob |

## Layout

```
apps/web/          React front end
api/               Azure Functions HTTP API
packages/shared/   Types, access control, formations, fair play
infra/             Bicep templates
db/migrations/     SQL schema
```

## Hierarchy

```
Organization  ->  Region  ->  Division  ->  Team  ->  Player
   (paid)        (paid)     (paid custom, or
                             free picks from
                             a static catalog)
```

Free accounts get a hidden personal org and region so foreign keys resolve,
but never see or manage them. They choose a division from `division_catalog`
(48 entries: U4-U19 x boys/girls/coed), which supplies the match format,
period type and period length.

The **Organization** screen (nav and ☰ menu, `/org`) creates organizations,
adds regions to them, moves regions between organizations and links teams
into a region. It appears for org-level access, including when testing as an
org admin, and as an upgrade prompt when only the plan falls short. Creating
an organization requires `org.manage` (organization director or admin) plus the
plan; the creator becomes its `director`. Linking a team requires `team.edit` on
it and `team.create` in the target region.

## Roles

`director` · `org_admin` · `region_admin` · `scheduler` · `coach` · `assistant` ·
`team_parent` · `parent` · `player` · `viewer`

A `director` (at an organization or a region) is the top role at that level
(`ROLE_RANK` 70, above `org_admin` 60): only directors rename the organization
or region (`scope.rename`, `DIRECTOR_ONLY`), and they can invite the admins who
help run it. Organization and region admins keep everything else (settings,
logo, regions, teams, invites). A region-scope role never gets
organization-level rights, so a region director cannot move their region to
another organization.

`scheduler` (Fady, 10/20; migration 064, rank 45, organization or region only,
given by its admins and directors): schedules and edits the games of existing
leagues and tournaments (`fixture.schedule`: fixture POST/PATCH and cancel,
`canScheduleInCompetition`, the competition's `canSchedule`) and keeps the field
maps (`field.manage`), and sees the teams and games (`team.view`, `game.view`).
Deleting games stays with staff (`game.create`), and so do creating leagues and
tournaments, sign-ups, invites and rosters. With no Settings tab, a scheduler
finds the region's field maps on its Games tab. Staff roles hold both new
actions too.

Custom roles (Shadi, 10/21; migration 069 `custom_role`, `custom_role_member`,
`invite.custom_role_id`; `/api/custom-roles`, `components/CustomRoles.tsx` in
an organization's or region's Settings; shared `customRoles.ts`): the staff
who can invite there (`member.invite` at that scope) make a role with a name,
the teams it covers (age group codes such as BU10, which follow teams added
later, and/or single teams) and permissions picked from `CUSTOM_PERMISSIONS`
(seeing the teams is always on; schedule games, edit teams and rosters, invite
people, run match day, team events and snacks, see player ratings, start group
chats). Nobody can hand out a permission they do not hold there themselves.
They give it by email: someone already on Lineup gets it at once (and a bell
notification), anyone else gets an invite email whose accept adds them to the
role. `readMemberships` expands each held role into team-level memberships
(role `custom`, rank 44) carrying exactly its actions (`Membership.actions`,
which `canOnTeam` uses instead of the role's grants; they also satisfy the
league-staff check), and `REACHABLE_TEAM_IDS_SQL` includes those teams, so they
appear in the menu under their organization. Being team-level, a custom role
never reaches the organization or region itself. `/api/teams` returns
`myActions` and `myRoleName` for it, and the app hides Match day without that
permission. `custom` is never an invite role or an impersonation role, and is
not counted toward the holder's team limit.

Group chats (Shadi, 10/21; migration 070 `group_chat`, `group_chat_message`,
`group_chat_read`; `/api/group-chats`, `screens/GroupChats.tsx`; shared
`groupChat.ts`) live on an organization's or region's own 💬 Chats tab, where
they were made (`?scope=&id=` filters the list and the start options), not in
the menu. The tab shows for its staff and for anyone holding a team role other
than parent, player or viewer. Organization and region staff (`member.invite`
there) start a chat at that level, and so does anyone whose custom role made
at that level has "Start group chats", for that role's teams only (written out
as `team_ids`, so the chat never grows past them). Members are the team roles
picked (coaches, assistant coaches, team parents; never parents) on the chat's
teams (every team, age groups, or single teams), holders of picked custom
roles, the staff if picked (an organization chat reaches the organization's
and every region's staff, a region chat only that region's), and the person
who started it. Membership is worked out on every read (`MEMBERS_SQL`,
`IS_MEMBER`), so people who join later are in. Messages notify like team chat
(`notification.group_key` `chat:g:<id>`, link `/groups?org=|region=<id>&focus=<chat>`,
chat notification setting) and are kept 90 days. An optional end date (`ends_on`,
Pacific) makes the chat read-only and moves it to Archived after that day; the
starter and the scope's staff rename it, change the end date, archive or
reopen it (reopening clears a passed end date) and delete it or any message.
They are called "Chats" in the app (Shadi, 10/22). Every organization and
region also has two default chats (migration 071 `group_chat.kind`), made the
first time its Chats tab opens and pinned at the top: "Staff" (`kind` `staff`,
roles `{staff}`: directors, admins and schedulers at that level) and "Admins &
directors" (`kind` `admins`, roles `{admins}`: no schedulers). They cannot be
renamed, ended, archived or deleted (`group_chat_default_uq` keeps one of each).
The tab and headings say "Chat", with no emoji (Shadi, 10/22).

Photos, polls and reactions in chats (Shadi, 10/22; migration 072
`group_chat_message.image_mime/image_data`, kind `poll`, `group_chat_reaction`,
`group_chat_poll`, `group_chat_poll_vote`; photos at `/api/group-chats/image`):
the same as team chat (`CHAT_REACTIONS`, `parseChatImage`, `cleanChatPoll`,
`cleanChatVote`; `components/ChatParts.tsx` holds the poll card, poll writer
and photo preparation both chats use). Anyone in an open chat reacts and votes.
Sending photos and creating polls (`chatPerks`) is free in the Staff and Admins &
directors chats; elsewhere it needs the paid `chatAttachments` / `chatPolls`
features, or a custom role in that organization with "Photos in chat"
(`chatPhotos`) or "Polls in chat" (`chatPolls`) ticked. The poll's author, the
chat's starter and its organization or region staff close polls.

Family stats (Shadi, 10/21; `components/FamilyStats.tsx` under the parent's
player card on a team's Stats tab, `/api/analytics?view=family`): parents and
team parents see where the team stands in each league and tournament for free;
the season record (friendlies included), results and their own child's goals,
assists, minutes and attendance need the Parent plan's `ownPlayerStats`, and
until then show greyed out with what they unlock. The family view is guarded by
`game.view`, never returns other players, and returns only `locked` without the
plan. A free parent's player card spells out its three locks: the card and
rating, designing the avatar, and sharing the card.

`team_parent` (team mom / manager) runs team events, the snack schedule and
calendar sharing (`event.*`, `snack.*`, `calendar.share`). They see the whole
roster's names but never lineups: `/api/games` hides assignments from them and
the app hides Match day, Stats and Team & roster. Coaches invite them at team
scope; a team can have several.

Accounts whose every role is `team_parent`, `parent`, `player` or `viewer`
join teams by invite and cannot create teams (403 `ROLE_CANNOT_CREATE_TEAM`);
the app hides New team and the team and game limits for them. While a role or
tier is impersonated the platform-admin bypass is off, so an admin testing a
role sees exactly that role's controls.

`player` is retired: new invites with it are refused (`ROLE_RETIRED`). A
`parent` invite must name the child (`PLAYER_REQUIRED`); coach, assistant coach
and team parent invites may name one too (optional, `CHILD_LINK_ROLES`), which
links them as that child's guardian on accept. People who can invite on a team
can also link or unlink a child for any parent or staff member later, from Team
& roster (Staff and Parents lists; `POST /api/team-people`), and region staff
pick the child when giving someone a role in People in this region (required
for Parent). Only coaches and above
invite; coaches do it from Team & roster. On a team in a league (a real
organization, or a standalone region; `TeamContext.inLeague`), `member.invite`
and `roster.add` (adding or removing players) come only from organization and
region staff roles (`LEAGUE_STAFF_ACTIONS`): coaches there still edit numbers,
names, pictures and positions, and `PUT /api/players` refuses additions and
removals (`LEAGUE_MANAGES_ROSTER`). `/api/teams` returns `inLeague`,
`canAddPlayers` and `canInvite` per team. Linking a team into an organization
or region, or out of one, needs `team.create` at that organization or region,
so only its admins and directors can; coaches never move teams. Parents and
viewers see Standings and Calendar only.

Team & roster shows the roster as Players, Staff and Parents lists. Players
carry a boy or girl picture (`player.gender`, migration 025; falls back to the
team's gender, or a neutral child on coed teams) and open their details when
tapped. `/api/team-people` returns staff (coach, assistant coach, team parent)
and parents by name only, never email; parents, players and viewers get staff
only.

Player evaluation (`player_evaluation`, migration 022; `/api/evaluations`):
coaches and assistants rate each player 1 to 10 (migration 044 doubled the
earlier 1 to 5 ratings) in
seven categories (`packages/shared/src/evaluation.ts`) plus strong foot, and the
overall rating is the average of the rated categories, on any plan. It shows as
a FIFA-style player card (`components/PlayerCard.tsx`): the overall and six
stats out of 99 (`cardRating`, `cardStats`: pace, shooting, passing, dribbling,
defending, teamwork = teamwork and effort), position, number and avatar, on a
bronze, silver (65+) or gold (75+) card in shiny metal (banded gradient, bevelled
rim, brushed grain and a light glint that sweeps across; the glint stays still
for people who turn off motion). Organization and region
admins and directors read evaluations; parents and team parents on a paid plan
(`playerEvaluation`, Parent and Coach plans)
see only their own child's card; everyone else sees nothing. The card also
shows (Fady, 10/19) a LINEUP watermark and FIFA-like condensed lettering, the
🇺🇸 flag plus the family's home country if a parent picks one (`player.heritage_country`,
migration 058, set with the avatar; `packages/shared/src/countries.ts`), the
team's region logo, and the player ID. "📤 Share card" under the card stack
draws it as a picture (`renderPlayerCardImage` in `lib/exportImages.ts`) with
the site on it. Redesigned again the same day in the EA FC style Fady pointed to:
`PlayerCardArt` draws the whole card as one SVG (notched top, pointed bottom,
 metal by tier with a sunburst and swoosh), the player from the waist up holding
 a ball and filling most of the card (`PlayerFigure` / `FigureArt`, a shaded,
 near-human drawing from the avatar choices; still never a photo), the overall and
 position top left, a purple ID tag under the player, the name, the six stats in
 a row and a faint LINEUP watermark. Flags and the region badge are laid over the
 bottom row (HTML on screen, drawn on the canvas for the share picture), because
 SVG drawn as a picture cannot show emoji or load logos. The share picture
 (`makeCardPicture`) renders that same SVG off screen, so it always matches. Player avatars
(`player.avatar`, migration 044; `packages/shared/src/avatar.ts`,
`components/PlayerAvatar.tsx`, `POST /api/player-avatar`): a cartoon (skin
tone, face shape, hairstyle and colour, eyes, glasses) drawn with the Lorelei
avatar art since 10/20 (DiceBear `@dicebear/lorelei`, art by Lisa Wischofsky,
CC0; `lib/lorelei.ts`): its 48 hairstyles (`h01`..`h48`) are the hairstyle
picker, recolored; names saved before (`short`, `afro`…) map to the closest
one (`LEGACY_HAIR`). The art (~47 KB gz) loads as its own chunk when idle;
eye color is a colored iris with a pupil dot drawn over each eye (`IRIS` in
`lib/lorelei.ts`; the art's eye line stays dark, as coloring it colored the
lids); until a parent designs one, girls show long wavy hair (`h35`) and the
slimmer `heart` face (`defaultAvatarFor`, from `player.gender`, sent with the
evaluations). Girls also get two optional parts (`GIRL_ONLY_PARTS`, Shadi 10/20):
glitter in the hair (sparkles at points precomputed per hairstyle,
`data/avatarGlitter.ts`) and rosy cheeks; `avatarForGender` drops them for
anyone else, on save and on read. On the card the tee has a scooped collar,
narrows under the arms and carries the region's logo on the chest (inlined into
the shared picture). Since 10/21 (Shadi): only the art's own neck lines (the
shorter inner pair is gone); girls are drawn slimmer (`SLIM`, body and arms
scaled to 86% across); the tee color is the avatar's `shirt` part (13 colors,
white by default; the small head-and-shoulders avatar keeps the jersey blue
unless another color is picked); hairstyles are offered by gender (`BOY_HAIR`
short cuts, `GIRL_HAIR` longer styles, ponytails and buns; `hairChoices`, all
of them when no gender is on file), and the first Lorelei style (`h01`) was
dropped (saved ones become `h02`),
designed by any parent linked to the player (also a coach who is the child's
parent), on any plan; never a photo. Evaluation lives on the roster (Fady,
10/18): Team & roster shows each player's avatar (instead of the old boy or girl
emoji) and rating chip, and tapping a player opens "Evaluate" (the card and the 1
to 10 ratings for coaches and assistants; "Player card" read-only for staff) and
"Design avatar" for a parent's own child; the separate Player evaluation section
is gone. Test as
offers only Free or Premium; Premium is the paid plan the tested role would buy
(`premiumTierFor`), and organization and region staff are always Premium.

Sign-ups per league or tournament (migration 051, Fady 10/17; `/api/join`,
`/api/region-signups`; helpers in `packages/shared/src/signup.ts`): each league or
tournament a region runs gets its own sign-up code (`competition.join_code`, like
`FALL-7KQ2`) and link `/join/<code>`, open between its registration dates
(`reg_opens_on`, optional; `reg_closes_on`, defaulting to its end date;
`registrationStatus`). Parents open the link (kept through sign-in) or enter the
code on Account and register children with name, birth year and month, and boys
or girls; returning families pick children already on file. A child can be in a
league and a tournament at once (one sign-up per child per league). Before the
window the link says when registration opens; after it, "Registration closed on
<day>" (409 `REGISTRATION_CLOSED`); staff extend it by moving the closing date
on the region's Sign-ups tab, which lists each league's link, code and dates.
Region staff (`member.invite` at the region) see "Players to place" with a
suggested age group and the league, approve or decline, and place each child on
one of that league's teams in the region: that adds the player, links the parent
as guardian and gives them the parent role on the team, and notifies them.
Regions have no code of their own (the region join code and region number were
removed, migration 057).
"People in this region" (everyone who signed up for one of its leagues, now or
before, or holds a role on one of its teams) lets staff give a coach, assistant
coach, team parent or parent role on a team directly, without an invite
(`action: 'assign'`).

Coach sign-ups (migration 056, Fady 10/19; `/api/competition-signups`,
`CoachSignupsPanel` in `RegionJoin.tsx`): a coach's own league or tournament
gets a sign-up link and code too (`competition.join_code`). Families sign up as
for a region's (`region_signup` rows with no region, only `competition_id`); the
coach who owns it sees "Sign-ups" on its page with the link, registration dates
and "Players to place", approves or declines, and places each child on one of
its teams (same placement as a region's: player added, parent linked with the
parent role). The coach only adds numbers and positions.

Which team a child can go on (Shadi, 10/21; `placementCheck` in
`packages/shared/src/signup.ts`, enforced by `placeSignup`, 400 `WRONG_TEAM`):
a boys' team takes boys and a girls' team girls (the team's `gender`, else its
age group's B/G/C letter); a coed team, or one with no gender, takes both. A
child's age group is the US Soccer birth-year rule (`suggestedDivision`); they
may play in it or any older one ("play up": a U9 on a U9 or U10 team, since many
leagues only have U8, U10, U12), never younger. A team with no age group takes
any age. The team picker lists the child's own age group first, then older
ones marked "plays up", and greys out the rest with why.

Parents (Shadi, 10/21): everyone who signed a child up through a league or
tournament link is a parent. `/api/me` returns `signupChildren`; before their
child is placed they are treated as family (no team limits, trials or new team
form) and Account suggests the Parent plan, not Coach.

Age groups for teams (Shadi, 10/21; `TEAM_AGE_GROUPS` in `signup.ts`): the
team set-up and "Set division" pickers offer AYSO's groups as leagues run them
on MatchTrak: region play in two-year bands (U6, U8, U10, U12, U14, U16, U19)
plus U9, U11 and U13 (Extra and Section play), for boys, girls and coed. The
catalog keeps every U4-U19 group, so teams already on another keep it.

Announcements (Shadi, 10/21; migration 067 `announcement`,
`announcement_recipient`; `/api/announcements`, `screens/Announcements.tsx`,
☰ › 📣 Announcements): organization and region staff (`member.invite` there)
post a title and message (web links become clickable) to everyone, chosen
roles (coaches, assistants, team parents, parents, region and organization
staff) or, from an organization, referees only (`referee.org_id`); across the
whole organization or region, chosen regions, or chosen teams. Recipients are
fixed when it is posted and each gets a bell notification (pushed to phones)
linking to `/announcements?id=`. Staff see who it went to and can delete it
(which also removes the notifications); everyone else sees only what was sent
to them, for 90 days.

Organization and region stats (Shadi, 10/21; `/api/scope-stats`,
`screens/ScopeStats.tsx`, the 📊 Stats tab for its admins and directors,
`analytics.view`): this season's (August to July) leaders across its teams from
match events (goals, assists on the goal or as an event, saves, shots) and the
coaches' player ratings (top rated by overall; defenders by the defending score
then near-goal clearances), plus each team's record (W-D-L, goals, clean
sheets), narrowed to a region or a team.

Since 10/21 (later, Shadi) the stats also show players injured in the last two
months (game replies and attendance marked injured; an upcoming game marked
injured reads "out for"), fair play by team (fairest and least even, by the gap
in minutes per game between the most and least played, counting only games a
player came to: `fairnessOf`, `MISSED_GAME_STATUSES`; teams with 2+ games with
a lineup), and a Team type filter. The team Stats page's fairness uses the same
per-game measure. Season-long stats are read from a stored copy
(`lib/statsCache.ts`, migration 068 `stats_snapshot`): refreshed at night (1 to
5 am Pacific) by whatever request comes in then, a few at a time, once more than
20 hours old; during the day the stored copy is served, and only a missing copy
or one over 2 days old is worked out on the spot. Copies unread for 2 weeks are
dropped. The screen says when the numbers were worked out.

Team type (Shadi, 10/21; migration 068 `team.team_type`): free text such as
All Stars, MLS Next 2 or NCL, with suggestions (`TEAM_TYPE_SUGGESTIONS`), set on
New team and on Team & roster; shown in the stats.

Announcements are the home page (Shadi, 10/21): opening the app with no page
asked for lands on 📣 Announcements. The author also gets their own
announcement when they are in its audience, so it shows on their phone too.

Evaluation reminder (Shadi, 10/21; `competition.eval_reminded_at`, migration
067): three quarters of the way through a league (not tournaments), its teams'
coaches and assistant coaches get "Time to evaluate your players", once, from
`sendReminders`.

The other parent (migration 056; `api/src/lib/coParent.ts`, `/api/family`,
`FamilyCard`): the sign-up form has an optional "About you and the other
parent": mother, father or guardian, a salutation (Mr, Mrs, Ms, Miss, Mx, Dr;
`app_user.salutation`), and the other parent's email and label. The parent who
signed up is the primary parent (`player_guardian.is_primary`, `label`). When a
child is placed the other parent is emailed an invite (`invite.co_parent_of`,
`guardian_label`); accepting links them to every child of the parent who sent it,
with the parent role on each team (also when already on that team). Someone who
already shares a child is linked to a new child straight away. Account shows
"Your family": children, other parents and invites waiting, inviting the other
parent (up to 5 waiting), and the label and salutation.
Standalone regions (the Region plan): `POST /api/regions` without `orgId`
creates a real region inside a hidden personal organization and makes the
creator its region director. It needs a Region plan the person actually holds
(not the paywall-off default) or a platform admin, and allows one per person
(`standaloneRegionGate`); the creator's Region entitlement is attached to the
region so the staff they invite are covered. `/api/hierarchy` returns them as
`regions` (top level of the menu, with `createRegion`), their teams have no
`orgId` but a `regionId`, and a team in one counts as in a league: only the
region's staff move it, and its regular games come from region fixtures.

Membership attaches at exactly one scope and inherits downward. Two gates are
checked independently and both must pass:

1. **Role** — does this membership grant the action?
2. **Tier** — is the feature in the plan covering that scope?

A free coach is blocked from `org.manage` by role. An `org_admin` on the free
plan is blocked by tier, and the UI shows an upgrade prompt rather than an
access error.

Parents and players see only players they are linked to through
`player_guardian`. No link means nothing visible — the default is deny, not
whole-team access.

## Plans

| Tier | Teams | Games/team | Players/team | Regions | Who it is for | Price / year |
|---|---:|---:|---:|---:|---|---:|
| Free | 2 | 12 | 30 | – | Coaches starting out (friendlies count toward games) | — |
| Parent | 2 | 12 | 30 | – | Every parent, team parents included (Team parent merged in 10/19; stored `teamParent` rows read as Parent via `LEGACY_TIER`): own child's stats and player card, avatar, org/region standings, chat photos, polls and editing, add to calendar, and for team parents event flyers and manual practice attendance | $4.99 |
| Referee | 2 | 12 | 30 | – | Referees: the running game clock on the referee match screen (approved by Fady 10/15) | $4.99 |
| Coach | 6 | 20 | 40 | – | Coaches and assistants: every paid team feature, including event flyers, plus everything in Parent (their own child's stats and player card) | $9.99 |
| Region | 20 | 20 | 60 | 1 | A standalone region (no organization): its admins and directors | $199 |
| Organization | 200 | 20 | 60 | 20 | Org and region admins and directors: everything, top down. Teams are shared across regions, no cap per region (Shadi, 10/22) | $299 |
| Organization Plus | Unlimited | 20 | 60 | 40 | Same as Organization, more regions, unlimited teams (`UNLIMITED`) | $499 |

The catalog lives in `packages/shared/src/entitlements.ts`. The October 2026
change retired Club, League and Region: stored `club` rows map to `coach` and
`league`/`region` to `organization` (migration 016 and `normalizeTier`). The
public "Who does what" page (`/help/roles`) documents roles and plans for users.

Paid plans are yearly subscriptions. Games are metered **per team**, not per
account: both free teams each get twelve games. `PAYWALL_ENABLED=false` treats
everyone as top tier, so the product can launch free and enable billing later
without a code change.

Cancelling sets `status='cancelled'` and keeps access until `access_until` —
the next anniversary of the subscription — then silently drops to free. No
data is ever removed by a downgrade.

### Free trials

`/api/trials` (migration 030 `plan_trial`; rules in `packages/shared/src/trial.ts`,
lifecycle in `api/src/lib/trials.ts`; UI in `components/Trial.tsx`). No card.

- **Organization or Region, 30 days.** Account › Free trial asks for a name and
  creates the organization (or a standalone region) with the starter as its
  **director**. The trial plan is an `entitlement` row with `external_ref='trial'`
  and `expires_at` at the trial's end; attached to the organization or region, it
  also covers the admins the director invites. One organization-or-region trial
  per person (`UNIQUE (user_id, kind)`, kind `scope`).
- **Coach, 7 days.** A Coach entitlement that expires; afterwards the account is
  free again with the usual locks. Offered only while the paywall is on (with it
  off everyone already has every Coach feature). One per person; not offered
  while an organization or region trial runs; an org/region trial may replace a
  running Coach trial.
- Someone already on a paid plan cannot start a trial. Trials are left out of
  subscriber and revenue counts in the console.
- **When an organization or region trial ends unpaid** it is *paused*: the
  organization, its regions and the teams created in it get `deleted_at` and
  `paused_by_trial`, and `loadMemberships` ignores memberships in paused scopes,
  so the director, admins and everyone invited see nothing of it. Teams that were
  linked in from elsewhere (`team.joined_league_at`, set by move-team, or created
  before the trial) go back to their coaches as standalone teams. The director
  sees "Your trial has ended" instead of the app, with **Subscribe** (checkout is
  not live yet: points to Help & support) or **Switch to a free coach account**
  (`POST /api/trials/dismiss`).
- Paused data is kept 30 days (`TRIAL_KEEP_DAYS`). Subscribing in that window
  (today: a console grant to the director, which calls `convertTrial`) restores
  everything as it was, people included. After it, the paused rows are deleted.
- Static Web Apps managed functions have no timer, so `settleTrials()` runs
  lazily from `buildAccessContext` and `/api/me`, at most once a minute per
  instance.
- Account shows one **Your plan** card (Fady, 10/20): the plan and billing, then
  the free trial (`TrialCard embedded`, `#trial`), then the plans (`#plans`).
  Paid plans with a trial on offer have **Start free trial** next to Subscribe,
  which picks that trial (`requested`) and scrolls to it.
- Not built yet: archiving free accounts inactive for a year.

### Home page plan picker

The signed-out home page (`SignIn.tsx`) has "Choose the plan that's right for
you" (`components/PlanPicker.tsx`): one question with three answers
(organization, region, coach), then the matching plans with their prices and
blurbs from `LINEUP_PLAN`, and a "See all plans and prices" table. "Try it free"
remembers the trial in `localStorage` (`lineup.pendingTrial`) through sign-up;
once signed in, the app opens Account › Free trial with that trial preselected
("Start free" stores `free` and opens team set-up instead). Creating an account
lands on `/plans`, the same picker inside the app, so a new person chooses a
plan first. The answer is kept (`lineup.planFor`) for Account's suggestion.

Someone with no team, organization or region yet is asked first (Shadi, 10/20;
`components/Onboard.tsx`, kept in `lineup.onboard`): **I'm a parent** asks for
the league or tournament sign-up code and opens Account's sign-up with it (no
team form), and **I coach my own team** shows the new team form. People with a
sign-up already are treated as parents. A parent can later tap **I'm starting to
coach my own team** on Account (`lineup.coachingOwn`), which lifts the family-only
block on ＋ New team and points to the Coach plan.

### Account › Plans

Account › Plans opens with **Best for you** (`lib/planFor.ts`
`recommendPlan`): the paid plan that fits what the person does in Lineup
(runs an organization or region, coaches, team parent, parent, referee),
falling back to their sign-up answer and then Coach. It shows why, the top five
features that plan is bought for (`PLAN_HIGHLIGHTS`) and a Subscribe button.
Below it, "Compare every plan" is a scrolling window about five features tall:
plan names, prices and Subscribe buttons stay pinned at the top, feature names
on the left, the suggested plan's column is highlighted (and scrolled into view
on phones), and its key features are listed first. Tapping any plan's name (or a
cell in its column) shows that plan's details on top instead, in turquoise with
a "You picked" tag and its column tinted turquoise, so it is not mistaken for
the suggestion; "Back to … best for you" returns to it (Fady, 10/19).

The ⚽ LINEUP logo in the header is a button back to Standings.

## Team calendar

A team's Calendar (`screens/TeamCalendar.tsx`; organizations and regions keep
`screens/Calendar.tsx`) is one card, top to bottom:

1. **Create buttons**, only those the person's role allows: ＋ Game (own games
   and friendlies), ＋ League game (league staff), ＋ Practice (the practice
   schedule, with "Remove upcoming" for each series) and ＋ Team event. The form
   opens in place.
2. Boxes for Games (ticked by default), Practices, Team events and Snack
   schedule, and for each ticked category one "Add <category> to your own
   calendar" (one `.ics` with every item, `buildIcsCalendar`).
3. List or Calendar (month) view of what is ticked, in date order. Each item is
   a card with a big date tile (day, date, month and time; components/DateTile.tsx,
   .cal-cards in the styles; tinted blue for practices, purple for events,
   amber for snacks) that carries its own actions: RSVP, edit, cancel or delete
   for games, practices and events, assign for snacks. League games also show
   who referees. "Show past" adds the past.
4. **Share this calendar**, collapsed until tapped.

RSVP (`components/Rsvp.tsx`, rules in `packages/shared/src/rsvp.ts`, migration
034): going or not going for each linked child as soon as something is
scheduled. Not going asks why: sick, injured, or other with an optional comment
(`reason`, `note` on `game_availability`, `attendance` and `event_checkin`). A
game's "injured" is kept as the game's injured availability for match day.
Staff see names with reasons ("Ben (sick)"); everyone else sees totals.
The totals are one component everywhere (`components/RsvpTally.tsx`): coloured
Going / Not going / (Late) / No answer tiles with an "answered" bar. For staff
they open the names grouped by answer, or practice attendance marking. The
going / not going buttons and the attendance marks share one coloured
segmented control (`.rsvp-choice`).

Adding to your own calendar downloads an `.ics` (`buildIcs` for one item,
`buildIcsCalendar` for a category; local "floating" time, all day when there is
no time). It is a paid feature (`addToCalendar`, every paid plan); on the free
plan each ticked category shows one lock, "Add <category> to your own calendar ·
Premium feature", that opens the plans. Single items show no lock.

Addresses (`components/LocationInput.tsx`, `GET /api/places?q=&lang=`): every
location field (games, league games, practices, team events) has **Find**,
which looks the address up in OpenStreetMap (Nominatim) and offers up to five
matches, and **Check on map**, which opens the address in maps. Lookups happen
only on Find (never per keystroke), are throttled to one a second, cached for a
day, and show "Addresses © OpenStreetMap contributors" as Nominatim's usage
policy requires. Google address autocomplete would need a Google Maps API key
with billing.

Player IDs (migrations 036 and 037, `packages/shared/src/playerId.ts`,
`api/src/lib/playerIds.ts`): every player on a team in an organization or region
gets an ID made of the player's first name, the last initial of the parent
linked to them, and a number counting up from 001 for that name: "AvaG001",
"AvaG002", or "Ava001" when no parent's last name is known. It is unique
within the organization (any case; a standalone region's own organization),
kept when the player moves team or season, assigned when the roster is first
read, and shown under the name on the roster. Standalone teams have none.
Migration 037 cleared IDs given in the first format ("Ava G. 482").

Notification links open in place (`api/src/lib/links.ts`, `App.applyLink`):
`/calendar?team=…&focus=game:<id>|practice:<id>|event:<id>|snacks|practices`
selects the team, shows that category and scrolls to the item;
`/chat?team=…&channel=…` opens that chat; `/?team=…` the team;
`/settings?region=…` a region's settings and `/signups?region=…` its sign-ups
(new family sign-ups link there). Reminders, new events, practice
schedules and cancellations, snack assignments, child links and placements all
carry these links.

Chat notifications (migrations 034 `notification.group_key`, `batch` and 042
`from_name`, `from_detail`): a new message or poll notifies everyone in that
chat except the sender. Each person keeps one notification per chat: while it
is unread, later messages only add to its count (the bell shows the first
sender, their child on the team or their role in a lighter colour, the first
message and "and N more messages"); once read, the next message brings the
same notification back as unread instead of adding another. Opening the chat
marks it read. Chat messages also show a parent's child beside their name.

Chat photos (migration 039 `chat_message.image_mime/image_data`): sending a
photo is a paid feature (`chatAttachments`: Parent, Coach and the
staff plans); everyone in the chat sees it, and the free plan shows a "Send
photos · Premium feature" lock. Up to 4 photos go at once
(`CHAT_PHOTOS_PER_SEND`, the `images` array of the `send` action); each
becomes its own message, the caption and reply going with the first, and the
chat gets one notification ("📷 4 photos"). The app shrinks a photo to 1024 px on its
longest side as a JPEG, lowering the quality (then the size) until it is under
256 KB (a small GIF goes as it is; `lib/image.ts`); the API takes JPEG, PNG,
WebP or GIF up to 256 KB (`CHAT_IMAGE_MAX_BYTES`), the caption is optional, and the
photo is served from `/api/chat/image?id=` only to people who can read that
chat. Photos go with their message after 90 days.

## Match day

- 5v5 / 7v7 / 9v9 / 11v11, 4-6 formations each
- A different formation per quarter or half
- Server-authoritative period clock: `elapsed_sec` plus `started_at` means a
  refresh or a second device shows the same time
- Tap-to-select then tap-to-place; empty slots pulse while a player is held.
  No drag and drop — unreliable on a phone on a touchline
- Mark a player absent and they are pulled from the lineup automatically
- Copy a lineup from a previous game, dropping anyone no longer eligible
- Auto fair play: seeded, so the same input always gives the same lineup
- Assistant coaches (migration 043, `packages/shared/src/lineupApproval.ts`,
  `api/src/lib/lineupApproval.ts`): an assistant marks players absent at any
  time. Before a game, their formation and lineup changes (tap-to-place, auto,
  copy, clear, per-period formation, Game details formation) go into one
  `lineup_proposal` per game instead of the game; the team's coaches get one
  "Lineup changes to approve" notification, and match day shows them the
  proposal with Show proposal / Approve / Reject (approve copies it onto the
  game and its periods; the assistant is told either way). The assistant
  changes the lineup straight away during the game: from 30 minutes before
  kick-off on game day (all of game day without a kick-off time) or while the
  match clock runs. A coach can tick "Assistant coach can change the lineup
  without my approval" on a game (`game.assistant_free`, off by default; when
  adding a game, or on match day); an assistant cannot change it.

- Planned subs (migration 050 `game_sub_plan`, `/api/subs`,
  `components/PlannedSubs.tsx`; Fady 10/17): coaches and assistant coaches
  (`lineup.edit`, no approval needed) plan each period's subs: the time on the
  period clock, who comes off (on the pitch that period) and who comes on (from
  the bench). Once the running clock reaches one, match day pops up "Sub now"
  with Done and Skip. Done records a `sub` match event and moves the rest of
  the period's minutes from the player going off to the one coming on
  (`minutesFromAssignments` with done subs, used by Stats and share cards);
  Undo takes it back.

### Fairness guarantees (unit tested)

- Playing-time spread <= 1 period for squads of 8-15
- Nobody benched two periods running with a 9-player squad
- Keeper duty never exceeds one period per player across four quarters
- No outfielder spends all four periods in the same position
- Absent players never appear
- Prior minutes carry into a mid-game rebuild

## League games and calendar

Org admins (any region) and region directors/admins (their own region) schedule
a game between two teams from the **Calendar** tab of an org or region. The
`fixture` row owns the date, kick-off, location and field number. Each team gets
an ordinary `game` row linked by `fixture_id`, so match day, lineups, stats and
standings work unchanged. Coaches cannot change a league game's date, opponent
or venue, and a trigger mirrors the score to the other side.

The calendar follows the selected scope: an org shows every region, a region
shows its teams, a team shows its own games. The list view is the default and
a month view is a toggle. Organizations, regions and teams can carry a logo,
stored in the `logo` table and served from `/api/logo`.

Sharing keeps nothing (Fady, 10/19): there are no share links any more. The
app makes the file on the phone and hands it to the share sheet (or downloads
it), and nothing is stored on Lineup (`lib/shareFile.ts`). It is a premium
feature (`longShareLinks`, now "Share lineups, stats and calendars"):
- **Calendar**: "Share this calendar" builds one `.ics` file of the upcoming
  games and events (`buildIcsCalendar`), invite-only events left out; there is no
  subscription feed.
- **Stats**: "Share stats" draws one picture on white with as much as fits: the
  record, points, match events, leagues and tournaments with the team's place,
  every player's games, minutes, goals, assists, clearances, saves, cards and
  attendance, and every result (`renderStatsImage` in `lib/exportImages.ts`); or
  one player's numbers with the team. First name and last initial unless "Show
  full names".
- **Lineup**: Match day's "Share lineup picture" / "Download to print" draws the
  whole game on one white page: four pitches for quarters (2 by 2) or two for
  halves, each with the formation, numbers and names, bench and who is out
  (`renderLineupImage`).
The share-link endpoints (`/api/shares`, `/api/share/public`,
`/api/calendar/shares`, `/api/calendar/public`, `/api/calendar/feed`) are
removed; old `/s/` and `/c/` links show "This link no longer works". The old
`share_link` and `calendar_share` tables are dropped (migration 057).
The Stats tab also lists the team's leagues and tournaments
with its place ("3rd of 8"), points, W-D-L and, in a tournament, how far it got
("Champion", "Out in the Semi-finals", "2nd in Group A"): `GET
/api/competitions?scope=team` adds `standing` to each.

A team's own games are added from its Calendar (`/api/friendlies`) and edited
there; Team & roster no longer lists games. `game.is_friendly` (migration 021)
marks them: a team inside an organization or region may only add friendlies
(its regular games come from the top as fixtures), while a standalone team adds
regular games (`kind: 'game'`) or friendlies. Opponents (Shadi, 10/20): a
league team picks teams of its own organization or region; a standalone team
picks only other standalone teams, never a league team (even one its coach also
coaches): the ones its coach is on, plus any other found by name (`search`, 3+
letters; the GET returns `searchable`). POST checks the same rule
(`allowedOpponent`). There is no separate Games menu item any more: a
standalone coach adds games from the team's Calendar ("＋ Game"), and a
standalone team has its own **⚽ Games** tab (Shadi, 10/20; `screen 'seasons'`
on a team, `GET /api/competitions?scope=team`): only its coach's own leagues
and tournaments (`owner_user_id`) and the team's friendlies, never an
organization's or region's. A coach's own league or tournament now takes only
standalone teams (`eligibleTeams`; since 10/19 it took any team they coached).

**Friendly requests** (Shadi, 10/20; migration 065 `friendly_request`,
`/api/friendly-requests`, `components/FriendlyRequests.tsx`). On a team in an
organization or region, "＋ Game" opens only "Request a friendly": the
opponent is picked from the organization's other teams (no typed names, no
league or tournament games: `LEAGUE_SCHEDULES_GAMES`, `PICK_TEAM`), and the
POST returns 202 with a pending request. Approval needs `fixture.schedule`:
both teams in one region, that region's staff (admins, directors, schedulers)
or the organization's; across two regions, both regions' staff
(`team_ok_by` and `opponent_ok_by`), or the organization's staff alone
(`org_ok_by`). A requester who holds a side's approval gives it at once, so
staff requests in their own region go straight on. Approved, the paired games
are written as before (`insertFriendlyGames`) and the other team and the
requester are told; declined (optional reason) tells the requester. Staff are
notified with a link to their Games tab, which shows a Friendly requests card
(`approvesFriendlies`); the team's Calendar lists its pending and declined
ones, with Cancel. Organization and region Games tabs have **＋ Friendly** for
their staff who add games (Shadi, 10/20; `friendlyTeams` in the list): pick
the home team from the scope and the away team from its organization; it goes
straight on both calendars when the caller approves both sides (both teams
are told), otherwise it waits for the other region or the organization.

Team events (`team_event`, migration 019): a team's Calendar has a Team events
section (party, picture day, fundraiser, meeting, tournament, tryout, volunteer shift)
for coaches, assistants and team parents, with a bell notification to the team
on create. A flyer (PNG, JPEG, WebP or PDF up to 512 KB, `FLYER_MAX_BYTES`;
the app turns any flyer photo into a JPEG of at most 1400 px that fits; served from
`/api/team-events/flyer`) needs the `eventFlyers` feature (Parent, Coach,
Organization). The snack schedule (`snack_slot`) assigns one family per game.
Shared team calendars and their iCalendar feed include team events (name, time
and place only).

## Referees

Part 1 (migration 038, `api/src/functions/referees.ts`, `screens/Referee.tsx`,
`components/RefereeSettings.tsx`, `packages/shared/src/referee.ts`):

- **Turning it on**: in an organization's Settings (or a standalone region's),
  its admins and directors turn referee sign-up on, which makes an 8-character
  code (`organization.referee_code`) and a `/ref/<code>` link to share. They can
  make a new code or turn it off; referees who already joined stay. Region staff
  inside an organization see the code but the organization manages it.
- **Joining**: anyone signed in enters the code on the Referee screen
  (`/referee`; `/ref/<code>` fills it in, kept through sign-in). A referee
  (`referee` row) joins the whole organization, not a region, and can pick a
  favorite region, which filters the open games (either team's region counts).
  The menu shows 🟨 Referee to referees; Account offers "Enter a referee code".
- **Signing up**: every league game (`fixture`) has three spots, main referee
  and two assistants (`fixture_referee`, one person per game). First come, first
  served, no approval; a referee can give a spot up before the game. Cancelled,
  past and teams' own games (friendlies, standalone teams) take no referees.
- **Organizers**: the staff who schedule a game see the referees on its card and
  can change any spot from the organization's referee list (`refereePools` on
  the calendar); the referee who is put in or taken out is notified. Everyone
  else who sees the calendar sees the names only. Staff can remove a referee from
  the organization, which frees their upcoming spots.
- **Notifications** (link `/referee`): put in or taken off a game by an organizer,
  removed as a referee, and a game cancelled, back on or deleted.

Part 2, the match screen (migration 039, `api/src/functions/refmatch.ts`
`/api/ref-match`, `screens/RefMatch.tsx`, opened from My games on the Referee
screen or "Referee report" on a calendar game, `/referee?match=<fixture>`):

- **Who**: the main referee records; assistant referees see it read-only; the
  staff who schedule the game open it to correct it. Coaches and parents do not.
- **Rosters**: both teams, first name and last initial, number and player ID.
  Who starts comes from each coach's first-period lineup, who is out from
  check-ins (absent or injured); everyone else is on the bench. The referee can
  change any player (`fixture_ref_player` keeps only the changes).
- **Events** (`fixture_ref_event`): goals, own goals (counted for the other
  side), yellow and red cards, and substitutions (on and off), each with the
  minute. Who played = starters plus everyone subbed on; the rest sat out.
- **Clock** (`fixture_ref_report.period_index/elapsed_sec/started_at`): start,
  pause, next quarter or half, reset; the minute fills itself in. It is
  Referee Premium (`refereeClock`); without it the referee types the minute.

Part 3, the official score: "Submit final score" (on or after game day) sets
`fixture_ref_report.final_at` and writes the score to both teams' games. The
`game_official_score` trigger keeps it there whatever writes the score later
(a coach's match day, recounted goals), so standings, records and the calendar
("Official" pill) follow the referee. Both teams' coaches and assistants are
notified. The referee or the organizers can reopen it to correct it.

Referee Premium: the `referee` plan, $4.99 a year (the Parent price, approved
by Fady on 10/15), unlocks `refereeClock` and no ads. Organization and region
plans include the clock too. Someone holding it next to a bigger plan keeps the
clock (`refereeClockEnabled`).

## Leagues and tournaments

Part 1 (migration 046, `api/src/functions/competitions.ts` `/api/competitions`,
`screens/Competitions.tsx`, `packages/shared/src/competition.ts`). Teams stay
permanent; a league or tournament (`competition`) stands on its own with a name,
start and end dates and the teams taking part (`competition_team`):

Kinds (Fady, 10/16): League (stored as `season`: a season and a league are the
same thing, named like Fall 2026 or 2026–2027) or Tournament.

- **Who runs it**: a region or an organization (the staff who schedule league
  games, `game.create` on the scope), or a coach for their own teams
  (`owner_user_id`; "My own teams (independent)"): any team they coach, in a
  region or not (Fady, 10/19), and regular games in it are allowed for those teams.
  Every league and tournament, cups included, shows its sign-up link and code on
  its own page for its managers (`/api/competition-signups`: the coach, or
  `member.invite` staff of its region or organization). Coaches and assistants of a team in it
  see the link and code to share (`shareOnly`, 10/20), but cannot approve,
  place or change dates. Managers create, rename, change dates, add and remove teams.
  An organization's staff may add teams from any of its regions, even to a
  region's league (Fady 10/17); region staff add their own region's teams. On
  the app's own page "Run by" lists the organization (all regions) first.
- **Games**: scheduled only from the league or tournament (Fady, 10/16: games
  are exclusive to them): a league fixture between two of its teams, or a game
  against any opponent. `/api/fixtures` and regular games on `/api/friendlies`
  (`kind: 'game'`) answer 400 `COMPETITION_REQUIRED` without a `competitionId`;
  a team's calendar adds only friendlies, practices and events. The
  fixture and each team's `game` row carry `competition_id`, so the game shows
  on every participating team's calendar as before, with a 🏆 badge. A game's
  date must fall within the dates and every team must take part
  (`competitionForGame`).
- **Standings**: per league or tournament, over its games only (3 points a win,
  1 a draw), plus top scorers.
- **Ended**: after the end date it is archived: read-only (409 `ARCHIVED`),
  listed under Past, everything kept. The API also returns `deleteOn` (3 months
  after the end) in case Fady wants ended ones cleaned up; nothing deletes them.
- **Where** (Fady, 10/16: they are not part of a team; renamed **Games & matches** 10/19, menu emoji 🏟️, the team calendar's button "＋ Match"):
  the Games page (`/competitions`, `?scope=mine`; no ☰ menu item since 10/20; a standalone team's ＋ Game › League or tournament match opens the team's own Games tab instead) lists every one the
  caller runs or takes part in and creates one for any place they schedule
  games ("Run by": their own standalone teams, an organization or one of its
  regions). Its buttons are ＋ League or season, ＋ Tournament and ＋ Friendly
  (a friendly picks one of the teams the caller can add games to: coach,
  assistant, or organization or region staff on it; it and opens that team's
  calendar with the friendly form, `focus=new:friendly`). The page lists
  leagues and tournaments together under "Leagues & tournaments", then a
  separate **Friendlies** card (Fady, 10/19): the list response carries
  `friendlies` (`friendliesFor`: games with no fixture or competition,
  the last 60 days and ahead) for the caller's own teams on `mine` and for
  the scope's teams (all for staff, else the caller's) on a region or
  organization; tapping one opens it on Match day. Ended ones are under
  "Past leagues & tournaments".
- **Friendlies between two Lineup teams** (Fady, 10/19; migration 060
  `game.pair_id`, `game.opponent_team_id`): the friendly form lists
  "Opponent team on Lineup" (`GET /api/friendlies?teamId=`: every team in the same
  organization or standalone region, plus the caller's own teams) or a typed name.
  Picking a team creates the friendly on both calendars, from each side, with a
  shared `pair_id`, and notifies that team's members. Both teams RSVP and set
  lineups as usual. Editing date, time, place or score (`/api/games`) mirrors
  to the other copy (score swapped), cancelling cancels both, the calendar shows
  the pair as one entry, and the Games page lists it once. An organization or
  region lands on its own Games
  tab (`/seasons`); its Standings tab has no overall table any more, just a
  dropdown of the running leagues and tournaments and the picked one's table.
  A team has neither tab: it lands on its Calendar, where those games show
  (parents see their child's rating there). A team's calendar has ＋ Game,
  which asks: Friendly (the friendly form) or League or tournament game (opens
  the Games page).

Team archive (migration 047, `packages/shared/src/teamArchive.ts`,
`components/TeamArchive.tsx`): whoever may edit a team (`team.edit`) archives
it from Team & roster (`PATCH /api/teams {id, action: 'archive'}`). An archived
team keeps everything but is read-only for everyone: `canOnTeam` denies every
action except `*.view` and `data.export` with reason `archived` (409
`TEAM_ARCHIVED`), and chat, game RSVPs, practice check-ins and event RSVPs
refuse too. It sends no reminders, does not count toward the plan's teams,
cannot join a league or tournament, and sits under 🗄️ Archived teams at the
bottom of the menu with a banner on its pages. "Bring it back"
(`action: 'restore'`) works for 30 days (`TEAM_RESTORE_DAYS`, subject to the
team limit); after that the team is deleted with everything in it by the database's cascades (`api/src/lib/teamPurge.ts`, swept from request housekeeping every 15 minutes and by the daily purge job). People's accounts, parents and players included, stay (Fady, 10/16: they may hold subscriptions); a league game against another team stays on that team's calendar.

Bring players from another team (`api/src/functions/rosterImport.ts`
`/api/roster-import`, `components/RosterImport.tsx` on Team & roster, open by
default on a team with no players): whoever adds players (`roster.add`) picks
players from the coach's other standalone teams, or from the same region's
teams, archived ones included. Players are copied (name, number, positions,
picture; one already on the roster by name is skipped, the roster limit
applies); a league Player ID moves with the child when the old team is
archived. With "Bring their parents too" their guardian links are copied and
they join the team with the family role they had, and are notified.

Tournament brackets (migration 048 `competition_match`, `packages/shared/src/bracket.ts`,
`api/src/lib/brackets.ts`, `screens/Bracket.tsx`; Fady 10/16): a tournament's
managers make a single-elimination bracket from its teams plus teams typed in
by name, seeded by its standings, in the order listed, or at random. Seeds are
placed so the best meet last (1 v 8, 4 v 5, 2 v 7, 3 v 6), the top seeds get
byes when the field is not a power of two, and a third-place game is optional.
Only round one is stored; later rounds come from the winners on every read.
A match is won on its game's score (`isGamePlayed`) or by hand
(`winner_override`, for draws decided on penalties). Scheduling a match creates
the games: a league fixture when both teams are league teams of one
organization, otherwise a game on each Lineup team's calendar against the
other's name (`insertLeagueGame` / `insertTeamGame` in `league.ts`); two
teams not on Lineup just get a date. First-round matches can be changed until
they are scheduled; removing a bracket leaves scheduled games in place.
Brackets are read-only once the tournament has ended. Colours (Fady, 10/17):
each knockout stage has its own colour (early rounds blue, quarter-finals teal,
semi-finals purple, final gold, third place bronze) on the round title and the
match cards, winners are green with a tick, scores sit in coloured pills, the
champion shows in a gold banner once the final has a winner, and each group of a
group stage has its own colour.

Group stage (migration 049; Fady 10/16): "Group stage, then knockout" splits the
seeded teams into groups of 3 to 6 (snake order, so each group gets a fair mix;
`makeGroups`), everyone in a group plays everyone once (`roundRobin`, stored as
`stage = 'group'` rows), and the top 1 to 3 of each group go through. The
knockout's first round names group places (`home_ref`/`away_ref` like `A1`:
winners first, so they get the byes and meet other groups' runners-up), filled
in when that group's games are all played (`groupTable`: points, goal
difference, goals, head to head). A match with no game on Lineup (two teams
typed in by name, or not scheduled) takes a score typed in by hand
(`bracketScore`).

Rules (Fady 10/16): every new game needs a kick-off time and a location
(fixtures, friendlies and bracket matches answer 400 `WHEN_WHERE_REQUIRED`).
Teams typed in by name are only for a coach's own leagues and tournaments; an
organization's or region's use its own teams (`PICK_FROM_LIST`, "Pick the
teams from the list"), and their bracket form offers its teams plus the
region's or organization's other teams, which join the tournament when picked.

Game lock (`api/src/lib/gameLock.ts`, `GAME_LOCK_DAYS` in `competition.ts`; Fady
10/16): 3 days after a league or tournament ends its games lock: saving the
game, lineups, periods and the clock, match events, planned subs, lineup
proposals and editing the league fixture answer 409 `GAME_LOCKED`. Viewing,
rosters and deleting data still work.

Fields and field maps (migration 052, `/api/region-fields`,
`components/RegionFields.tsx`; Fady 10/17): a region, standalone or in an
organization, keeps up to 10 fields on its Settings (region staff with
`team.create`): a name, a location found with Find, and a field map picture
(JPEG/PNG/WebP up to 600 KB, shrunk in the browser; served from
`/api/region-fields/map?id=` to anyone in the region). Game forms (friendlies,
league and tournament games, bracket matches) show the region's fields as
one-tap location picks, and a game whose location matches a field with a map
shows "🗺️ Field map" on calendars (`fieldMapId`; not on public calendars).

Getting started (`components/GettingStarted.tsx`; Fady 10/17): a checklist on the
home page for a new organization or region admin (create a region, a team in
it, a league or tournament, share its sign-up link, approve and place players,
invite staff, schedule games) and for a coach with their own team (add
players, invite the assistant and parents, create a league or tournament,
schedule its games). "Show me" opens the right page and points at the button
with a pop-up tip (`TourTip`, elements marked `data-tour`). Region, team,
league and game steps tick themselves off; the rest are ticked by hand
(`localStorage`). Closing it hides it; the ? next to the bell brings it back.
`GUIDE_VIDEO_URL` adds a video link once there is one.

Player cards (Stats tab) are a stack to swipe left or right (`CardStack`): a
parent's or coach's own children first, then best rating first. Parents see
only their own children's cards. Sign-ups are per league or tournament.

## Navigation

The ☰ menu is an Organization › Region › Team tree. Nodes collapse, any node
can be pinned to Favorites, and both settings are kept in `localStorage`. Menu
order (Fady, 10/18): ★ Favorites at the top, then 🏟️ Games & matches
(`MenuDrawer` `top`), then the tree; teams outside any organization or region are
listed under "Independent teams" (formerly "Standalone teams"). Pages
for the selection are tabs on the page: an organization or region has Games
(its home), Standings, Calendar and Teams (games are scheduled
inside a league or tournament and all show on the Calendar; Teams lists its teams and lets staff create one straight into a
region, inviting its coach); a team has Calendar (its home), Chat, Match day,
Stats (with every player's FIFA-style card; parents and team parents get a
Stats tab with their own child's card) and Team & roster. On
phones the tabs wrap into a grid instead of scrolling sideways. Organization and
region settings (rename, logo, regions, inviting at that level and below,
moving teams) are a Settings tab on the organization's or region's own page,
shown only to people who can manage it or invite into it; they are no longer
in the menu. A region also has a Sign-ups tab for the same people: the join
code, players to place, people in the region, and Invite members at the bottom
(so a region's Settings keeps the name, code, logo, teams and referees). Teams
and Sign-ups both explain the two ways in: sharing the
region's sign-up link (families) and inviting by email (staff, or a parent for a
child already on a roster). Staff creating a team in a region do not become its
coach; a coach creating their own team does.

Games per team are counted per season, August to July (`getTeamUsage`), so the
allowance starts again each season within the yearly plan; games with no date
count toward the current season.

Game check-in (`/api/checkins`, migration 026 adds `responded_by` and
`responded_at` to `game_availability`): a parent answers going or not going for
their own linked child as soon as a game is on the schedule, until the end of
game day (the next 20 upcoming games are listed). The answer is the game's availability, so a child who
is not going drops out of the saved lineup and auto formation, exactly as when
the coach marks them absent. Game and practice check-ins live on the team's
Calendar only; coaches and staff (`lineup.edit`) see going, not going, late and no
answer per game there with names. Everyone else on the team sees the totals
only (`counts`), because parents see only the players linked to them.

Borrowing a player (migration 055 `game_guest`, `api/src/functions/gameGuests.ts`,
`components/GameGuests.tsx`; Fady 10/18): on a team's Calendar, a coach or
assistant coach (`lineup.edit`) taps "＋ Borrow a player" on an upcoming game,
picks another team (any team in the same organization, or another team they
run) and one of its players, with an optional note. That team's coach and
assistant coach get a notification; its "Requests to borrow your players" card
(top of its Calendar, link focus `borrow`) lets the coach (`team.edit`) approve
or decline, the assistant only sees them. The asking team hears back; on approval
the player's parents are told. Approved guests are listed on the game, join the
match day player list as "(guest)" (also in auto formation, copy lineup and planned
subs), and can be removed or cancelled by the asking team.

Team chat (`/api/chat`, migration 027 `chat_message`, `chat_reaction`,
`chat_presence`; rules in `packages/shared/src/chat.ts`): every team has three
chats, Everyone (`all`: coaches, assistant coaches, team parents, parents),
Staff (`staff`: coaches, assistant coaches, team parents) and Coaches
(`coaches`). People see only the chats their role belongs to; viewers have none.
Organization and region admins and directors drop in to any of their teams'
chats without approval (`enter`/`leave`); a system message tells everyone they
joined or left, and while in they read, post and react like anyone else. Replies
quote the original and reactions are 👍 ❤️ 😂 🎉 ⚽ 🚀 😢 🔥. On a paid plan
(`chatEditing`) an author can edit a message for 10 minutes and delete it for
everyone until someone reacts or replies; free users can do neither. Messages
older than 90 days are deleted when the chat is read, and a deleted account takes
its messages with it. Coaches, and organization or region staff while in a chat,
can remove anyone's message (free); it simply disappears for everyone, with no
notice of who wrote or removed it. The app checks for new messages every 3
seconds while a chat is busy and slows down when it is quiet (10 s after a
minute, 20 s after 3 minutes, 30 s after 10; `chatRefreshDelay`), speeding up
again when anything arrives or the person types or comes back. The chat paragraphs in the
Terms and Privacy pages are drafts for review before release.

Chat polls (migration 032: `chat_message.kind = 'poll'`, whose body is the
question, plus `chat_poll` and `chat_poll_vote`; rules in `cleanChatPoll` /
`cleanChatVote`): anyone in a chat on a paid plan (`chatPolls`, on every paid
tier) posts a poll with 2 to 6 answers, one answer or several. Anyone in the
chat votes, on any plan; a vote replaces the last one and an empty vote takes
it back. Everyone sees the counts and, on tap, who picked what. The creator or a
chat moderator closes a poll. Polls cannot be edited; the creator can delete one
only until someone votes, reacts or replies, and moderators remove one like any
message (its votes go with it).

Region-wide and organization-wide events (migration 028: `team_event` belongs to
exactly one of a team, a region or an organization): organization and region
admins and directors (`event.create` at that scope) add them from the
organization's or region's Calendar (`POST /api/team-events` with `scope` and
`scopeId`; `GET ?scope=&id=`). They show on the Calendar of every team in that
region or organization, marked with the region or organization name, and
everyone on those teams is notified. Only that scope's staff can edit them.

Event check-ins and reminders (migration 031 `event_checkin`, `event_reminder`):
on a team's Calendar each upcoming event, the team's own or its region's or
organization's, has Going / Not going for the caller's linked children
(`POST /api/team-events/checkin`, open until the event day ends). Everyone sees
the team totals; coaches, assistants and team parents (`event.edit` or
`lineup.edit`) see names.

Tryouts, who sees an event, and a limit on how many go (migration 054, Fady
10/17; `api/src/lib/eventAudience.ts`, `components/EventAudience.tsx`): tryouts
are an event type (`kind = 'tryout'`, 🎯) at an organization, region or team,
not a separate feature. Any event can be for everyone in its scope (as before) or
only for chosen regions (organization events), age groups (a team's division
code such as BU10), teams, or people (`team_event_audience`; no rows means
everyone). The event form's "Who sees this event" loads the choices from
`GET /api/team-events/audience?scope=&id=` (staff with `event.create` there;
people are everyone with a role on a team in scope, searchable by name, email or
team). A team event can only pick people. A chosen person sees the event on
their own team's calendar and RSVPs there. Restricted events show only to the
chosen teams and people and to whoever can edit them (team calendar, organization
and region calendars, the flyer, check-ins), are marked "🔒 Invited only", notify
and remind only them, and stay off public calendar links. "Most going" sets
`team_event.max_going`: the event shows "12 of 20 going" (going counted across
every team) and "Full", and a further Going answers 409 `EVENT_FULL`; Not going is
always allowed and a child already going keeps their place.

Reminders (in-app bell only for now, as Fady asked; `api/src/lib/reminders.ts`):
everyone on a team gets a `notification.kind = 'reminder'` a week before and two
days before each of its games and events, and two days before each practice
(10/14: a week ahead too was too many for teams that practice twice a week).
Region and organization events remind every team in them. With no timer in Static Web Apps, the sweep
runs lazily from `buildAccessContext`, at most every 5 minutes per instance. Each
reminder is claimed first (`event_reminder`, and migration 033's `game_reminder`
and `practice_reminder`, which record the date the reminder was for), so it goes
out once. A reminder whose moment passed before the item was created is skipped
(migration 033 adds `game.created_at`; existing games took the migration time,
so nothing already scheduled inside the window fires at once), as are cancelled
practices. Practices count days in their own time zone. Moving a game or
practice to a new date sends its reminders again; changing an event's date
clears its reminders.

Cancelling games (migration 035; `POST /api/games/cancel`, `cancelGameHandler`
in `league.ts`): a team's own game or friendly is cancelled (and un-cancelled)
by its coaches (`game.edit`); a league game only by that league's admins and
directors, and on both teams' copies at once. A reason (weather, field closed,
emergency, other) and an optional note are kept; everyone on the team is
notified with a link to the game. A cancelled game shows "Cancelled: Weather"
on calendars (struck through in the month view, `Cancelled:` in calendar
feeds), takes no RSVPs, sends no reminders, has no score, and is left out of
standings, the team record, share cards and the free plan's game count.
Rain, heat and lightning are one `weather` reason for practices and games
(10/14); older values are mapped by `cancelReasonOf`, and existing cancelled
practices were moved to it.
Locations of games, practices and events are links to maps (`components/MapLink.tsx`):
Apple Maps on iPhone, iPad and Mac, Google Maps elsewhere. The field number is
not part of the search.

Practices (migration 029: `practice_series`, and `practice` gains times,
location, time zone and cancellation; `/api/practices`; rules in
`packages/shared/src/practice.ts`): coaches and assistant coaches
(`game.create`) set a practice schedule of weekdays, a time and a date range,
which creates one `practice` row per date. The free plan allows up to 100 days
per schedule (`extendedPractice` for longer). Parents check their own child in
or out as soon as a practice is on the schedule, until it starts, in the
practice's time zone (sent by the browser when the schedule is made); the answer
is the practice's `attendance`. Coaches cancel a practice with a reason (weather, field closed, emergency,
other) and an optional note; the team is notified, check-in closes, and Undo cancel restores it.
Coaches, assistants and team parents see going, not going and no answer, for
practices and (since 10/16) games; marking practice attendance by hand is paid
(`manualAttendance`: Coach, Parent and staff plans), while marking a game
for someone else stays with coaches and assistants. Removing a schedule
deletes only its upcoming practices.

## Look and feel

- **Font** (Fady, 10/20): Montserrat (`@fontsource-variable/montserrat`,
  bundled with the app, OFL), with lighter weights throughout: headings 600,
  nothing above 700, so pages aren't a wall of bold.
- **Folded cards** (10/20, `lib/foldCards.ts`): on the Account, Team, Teams,
  Stats, Settings, Organizations, Sign-ups, Referee and Help pages each card
  shows only its title until tapped (a `section.card` whose first child is an
  h2 or a `.card-head`). `data-fold-open` keeps a card open (the roster, player
  cards, help answers, how players join); links to a card (`#plans`, `#trial`)
  open it, and `revealInFold(el)` opens one before scrolling to it. What's
  opened stays open for the visit (sessionStorage).
- **Verse of the day** (10/20, `components/VerseOfTheDay.tsx`,
  `data/webVerses.ts`): a Bible verse at the bottom of every page, from 340
  verses on love, peace, forgiveness and the fruit of the Spirit, World English
  Bible (public domain, text as published by eBible.org without the psalm
  titles; Shadi, 10/21, in place of the ASV). Each page shows a different verse
  and they all change each day (Pacific time); the list loads after the page
  and costs the server nothing.
- **Words** (10/20): the leagues-and-tournaments page is "Games" (⚽), a
  coach's own teams are "My Own Teams", a player's code shows without "ID"
  in front, and the calendar's button is "＋ Game". The menu has no Games item
  since 10/20 (standalone teams have a Games tab; organizations and regions
  their own). **＋ New team** sits at the end of My Own Teams (Shadi, 10/20);
  at the plan's team limit it stays, with "N of M teams used on your plan. See
  plans ›" (to `/plans`), instead of disappearing.
- **⚽ in the bar** (Shadi, 10/20, `goHome`): goes to the top of where you are:
  the selected item's organization, else its region, else the team's
  calendar; with nothing selected, your first organization, region or team.
- **Help answers** (10/20, `components/HelpAnswers.tsx`): searchable questions
  and answers on Help & support, above "Ask us something".
- **How players join** (10/20): on the Teams tab only (`JoinHelp`, with a
  button to the leagues and tournaments), and on a team's Team & roster
  (`RosterHelp`): for a team in a region or organization, players are placed by
  its staff; for My Own Teams, start a league or tournament and share its
  sign-up link, or "No, I'll add the roster myself" (remembered per team).
## Install the app and notifications

Fady, 10/19. The website installs like an app: `public/manifest.webmanifest`
(name, standalone, navy theme, icons in `public/icons/`: 192, 512, maskable
512, Apple touch, 32 favicon) and `public/sw.js` (no caching of pages or data;
it makes the app installable, shows push notifications and opens their link
when tapped). `staticwebapp.config.json` serves `/sw.js` with `no-cache`, the
manifest as `application/manifest+json`, and keeps both out of the navigation
fallback. `lib/install.ts` registers the worker after load, keeps Chrome's/Edge's
`beforeinstallprompt` for our own button, and detects home-screen use.

Account › The Lineup app (`components/InstallCard.tsx`): **Install the app**
(the browser prompt), or step-by-step Add to Home Screen for iPhone/iPad and
the menu on Android; and **Turn on notifications** (asks the browser's
permission, subscribes to push with the VAPID public key and saves the device
with `/api/push`), with **Send a test** once on. On iPhone, notifications need
Lineup on the home screen. A small banner (`InstallBanner`) offers the install
on phones until it's installed or closed. Lineup never asks for location. The
Android store app (Capacitor) hides all of this.

Asking (10/20): browsers only show their permission prompt after a tap, so
`NotifyAsk` (top of the app) asks "Get a notification when…? Allow / Not now"
on Android and on installed apps where the person hasn't answered; "Allow"
brings up the phone's prompt, "Not now" waits two weeks. Where permission is
already granted it re-registers the device quietly on every start.

Push: migration 061 `push_subscription` (user, endpoint, keys), `/api/push`
(`api/src/functions/push.ts`: GET public key and device count, POST save or
`{ test: true }`, DELETE by endpoint). VAPID keys are in Key Vault
(`lineup-<env>-vapid-public-key`, `-vapid-private-key`) and reach the app as
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (optional `VAPID_SUBJECT`, default
`mailto:support@mahoul.io`).

Sending (10/20, `api/src/lib/pushSend.ts`, `web-push`): every in-app
notification (the bell) also goes to the person's devices. Static Web Apps
functions only run on requests, so `requestHook.ts` sends whatever is waiting
at the end of each API request, usually the one that created it. Migration 062
adds `notification.pushed_at`; a batch is claimed with `FOR UPDATE SKIP LOCKED`
so it's sent once. Grouped chat and lineup notifications clear `pushed_at` when
they gather more, so the phone's notification is replaced with the new count
(same `tag`). Devices the push service reports gone (404/410) are removed.

When it doesn't work (10/20): `lib/install.ts` splits turning on into steps
(permission, helper, subscribe, save) and `pushProblemText` tells the person
what to do for each (blocked in settings, prompt never shown, the browser's
push service off, e.g. Brave or phones without Google Play services). Every
attempt, and once a day where the device stands, is reported with
`POST /api/push { report }` into `push_setup_log` (migration 063, kept 30 days:
outcome, step, the browser's error, permission, installed, user agent).

What gets pushed (Shadi, 10/21; migration 066 `notification_pref`,
`packages/shared/src/notifyPrefs.ts`, `components/NotificationSettings.tsx` on
Account): Games, Practices and Team events on or off, and Chat messages for
every message, only @mentions, or off. No row means everything on.
`GET /api/push` returns `prefs`; `POST /api/push { prefs }` saves them.
`pushSend.ts` sorts each notification with `notifyCategory` (group `chat:`,
`mention:`, `lineup:`, else the link's calendar `focus=game|practice|event`)
and skips what `pushAllowed` says no to. The bell keeps everything, and
sign-ups, placements and approvals always come through.

@mentions in team chat (Shadi, 10/21; `chat_message.mentions` jsonb and
`mention_all`, migration 066): typing @ in a chat suggests its people (GET
returns `members` and `canMentionAll`); the server finds "@Name" for people in
the chat (`findMentions`, longest names first) and "@everyone" from staff
(coaches, assistants, team parents, organization and region staff dropped in).
Mentioned people get "X mentioned you in Team" (group `mention:<team>:<chat>`,
one unread per chat, cleared when the chat is read) instead of the usual new
messages notification; @everyone tells the whole chat. Mentions are highlighted
in the message.

Android app push (Shadi, 10/22; `api/src/lib/fcm.ts`): the store app gets
notifications through Firebase Cloud Messaging (project `lineup-mahoul`, free).
On every start the app (`startNativePush` in `lib/install.ts`, called from
`NotifyAsk`; `nativePush()` in `lib/native.ts` reaches
`@capacitor/push-notifications` through the native shell, so the website never
loads it) asks Android for permission once, makes the `lineup` notification
channel, registers with Firebase and sends the token as
`POST /api/push { fcmToken }`, saved as a `push_subscription` with endpoint
`fcm:<token>` (keys `fcm`). Tapping a notification opens its link in the app.
`pushSend.ts` sends to those devices with the FCM HTTP v1 API, signing in with
the project's service account (`FCM_SERVICE_ACCOUNT_JSON` from the shared Key
Vault secret `android-app-firebase-serviceaccount-privatekey-json`, via
`infra/set-settings.cjs`); tokens Firebase reports unregistered are removed.
`GET /api/push` reports `native` when Firebase is set up. The app build needs
`apps/web/android/app/google-services.json` (git-ignored; write it from the
shared secret `firebase-google-services-json` before building).

## Android app and ads

**Ads are switched off for now** (Fady, 10/14/2026): `ADS_ENABLED = false` in
`apps/web/src/lib/ads.ts` keeps every ad slot empty and never loads the AdSense
or AdMob scripts, and the plan table hides its "No ads" row. Set it back to
`true` to bring them back as described below.

`apps/web/android` is a Capacitor shell (package `io.mahoul.lineup`) that
loads the live site, so sign-in and `/api` behave exactly as in a browser and
a web deploy updates the app. Point a build at dev with
`CAP_SERVER_URL=https://lineup-dev.mahoul.io`.

Building it locally (10/16): JDK 21 and the Android SDK (platform 36, build
tools 36) live under `%LOCALAPPDATA%\LineupAndroid` (`jdk`, `sdk`); set
`JAVA_HOME` and `ANDROID_HOME` to them, then from `apps/web`:
`npx cap sync android` (with `CAP_SERVER_URL` for a test build) and
`android\gradlew assembleDebug` (APK in `android/app/build/outputs/apk/debug`)
or `bundleRelease` with an upload key for Play. Run `npx cap sync android`
again without `CAP_SERVER_URL` afterwards so the shell points at the live site.

Test mode (`apps/web/src/lib/appSite.ts`): inside the Android app, a platform
admin's console shows "Use the test site in this app", which remembers the
choice on that phone and opens lineup-dev; while there a banner offers "Back to
the live site" (`?appSite=live` turns it off). The live site must carry this
code for the switch to work, so it reaches store builds with a prd release.

Buying plans in the app (Fady, 10/16: option A, `apps/web/src/lib/purchases.ts`):
the store apps sell nothing themselves. Premium locks and the plan table stay;
Subscribe, Manage billing and Resume open the website in the phone's browser
(`@capacitor/browser`: Chrome Custom Tabs, Safari View Controller on iOS) at
`/account?from=app`, where people sign in with the same account and pay with
Stripe. Signing in returns to the page asked for, the website says "go back to
the app" after paying, and the app's Account refreshes the plan when it comes
back to the foreground. Both Google Play and the App Store allow such links on
their US storefronts, so list the apps in the US only until in-app purchase
(Play Billing, StoreKit) is added here, which would turn on the same plan on
the server. For the App Store later: Sign in with Apple is needed only if
sign-in ever offers Google or Facebook (today it is Lineup's own account);
account deletion is already in Account; an iOS build needs a Mac (Xcode) and
the Apple Developer Program ($99 a year).

Ads come from Google AdMob. The app ID sits in `AndroidManifest.xml`, and the
banner unit is in `apps/web/src/lib/ads.ts`. Inside the Android app the bottom
ad slot becomes an adaptive AdMob banner, and the top slot is dropped so only
one banner shows. Real ad units load only when the app is pointed at
`lineup.mahoul.io`; every other host gets Google's test units, so development
never produces invalid traffic. Ads are non-personalised and go through
Google's consent prompt for EEA and UK users. Paid plans see no ads once the
paywall is on. On the web, ads come from Google AdSense (`ca-pub-6869341797976525`)
and render only in slots that have an ad unit configured in `ADSENSE.slots`. The
top slot uses the responsive unit `5115326306` on every screen as a horizontal
banner (`data-ad-format="horizontal"`, full-width responsive) that fills the
page width; the 728x50 fixed unit `8029797086` is no longer used because a
fixed unit cannot stretch. Ads are
non-personalised and marked `data-adtest="on"` everywhere except
`lineup.mahoul.io`. The site is not AMP: Auto ads (including Anchor ads) need
no code, only the AdSense script the site already loads, and are switched on in
the AdSense console. Exclude `lineup-dev.mahoul.io` there, because Auto ads
ignore `data-adtest`.

`app-ads.txt` is served from the site root. It must also be reachable at the
root of the developer website listed in Play Console.

### mahoul.io root site

AdSense only accepts a top-level domain, so the site registered in AdSense is
`mahoul.io`, and ads on `lineup.mahoul.io` are covered by it. `apps/site` is the
static company site for that domain: an About us home page (`/`) and a Help &
support page (`/support`), each carrying the AdSense verification tag and
loader, plus `ads.txt` at the root. It is hosted on its own free Static Web App,
`mahoul-site` in `wus3-shared-rg`. Deploy it from a copy outside the repo, since
running the SWA CLI inside the repo picks up the Lineup app's config:

```bash
cp -r apps/site /tmp/mahoul-site && cd /tmp/mahoul-site
npx @azure/static-web-apps-cli deploy . --deployment-token <mahoul-site token> --env production
```

DNS for `mahoul.io` is on Cloudflare: a flattened apex `CNAME` to the
`mahoul-site` default hostname (DNS only, not proxied) and a `_dnsauth` TXT
record with the token from `az staticwebapp hostname show`.

```bash
npm run android:sync --workspace apps/web   # build web + copy into android/
npm run android:open --workspace apps/web   # open in Android Studio to build/run
```

## Data rights

| Action | Behaviour |
|---|---|
| Export | Full JSON of a team: roster, games, periods, attendance, events |
| Delete team/game | Soft delete, excluded from every query |
| Delete player | Hard delete — a parent asking for removal gets removal |
| Deactivate account | Account → "Deactivate my account" (`POST /api/me/deactivate`): sets `app_user.deactivated_at`, queues a `deletion_request` (kind `deactivate`) due in **1 year**, and stops a Stripe plan renewing. Every API call is refused; `/api/me` answers `ACCOUNT_DEACTIVATED` with `deletesAt`, and the app shows "Your account is deactivated" with **Reactivate my account** (`POST /api/me/reactivate`, clears the flag and cancels queued deletions). The purge job deletes it after the year |
| Delete account | "Delete permanently instead": queued with a 7-day grace window, cancellable (kind `delete`). Kept because app stores and privacy law expect a real delete option |
| Unsubscribe | Token link, no sign-in required |

`access_log` stores salted IP hashes only, trimmed to 90 days by the purge job.

Terms acceptance: the sign-in gate shows the full Terms of Use and Privacy
Policy in a scroll box (`TermsBody` / `PrivacyBody` from `screens/Legal.tsx`);
"I agree" unlocks only once the box has been scrolled to the end. Bump
`TERMS_VERSION` (API) and `LEGAL_EFFECTIVE` (web) together to ask everyone to
accept again. The 2026-10-17 wording (deactivation, permanent deletion) and the
"Delete permanently instead" option were approved by Fady on 10/17.

## Environments

| Branch | Deploys to | Database | How code lands |
|---|---|---|---|
| `dev` | `lineup-dev-webapp` | `lineup-dev` | direct push |
| `main` | `lineup-prd-webapp` | `lineup-prd` | pull request only |

The paywall is **on in dev** (`PAYWALL_ENABLED=true` on `lineup-dev-webapp`
since 10/13, as Fady asked) and still off in production; Fady decided on 10/18
to switch it on at the production launch.

## Performance

The API runs in West US 2 and the database in West US 3, so every database
round trip costs about 38 ms. Most of a click's time is round trips that
wait for each other, so the code keeps those few:

- **Once per request** (`api/src/lib/requestScope.ts`, hooked in by
  `lib/requestHook.ts`): who the caller is, their plan, impersonation,
  memberships, guardian links, access context and team context are looked up
  once per request however many checks ask. Any write through `query()` or
  `transaction()` forgets them, so a request that changes access and reads it
  back sees the new value. `queryQuiet()` is for bookkeeping writes only.
- **No write per click** (`lib/auth.ts`): the account row is read; it is only
  written on first sight, an email change, or when `last_seen_at` is more than
  5 minutes old. Request counts (`usage_daily`) are added up in memory and
  written at most once a minute per person per instance.
- **Housekeeping beside the request**: lapsed trials and due reminders run in
  the background (still throttled to 1 and 5 minutes); chat's 90-day clean-up
  runs at most hourly per team, and reads skip older messages anyway.
- **Reads together**: guards load the team and the caller at once, and the hot
  endpoints (hierarchy, standings, calendar, chat, check-ins, practices, team
  events) read independent things in one `Promise.all`.
- **Warm connections**: the pool keeps idle connections 5 minutes with TCP
  keep-alive, so a click after a pause does not open a new TLS connection.

In the browser:

- Start-up asks for the profile, menu and teams at once (was one after
  another), and only platform admins check the admin console (`me.platformAdmin`).
- `lib/api.ts` remembers the last answer to each GET for the visit: a tab
  opened again shows it immediately and refreshes in the background
  (`peek(apiPath.x(...))`). Any write forgets everything. The same GET asked
  twice while the first is on its way shares one request, an answer under two
  seconds old is reused, and otherwise the app sends the answer's `ETag`: an
  unchanged answer comes back as an empty 304 and the screen does not redraw
  (`lib/requestHook.ts` adds the ETag and `Cache-Control: no-store` to every
  JSON GET, so nothing personal is kept in the browser's disk cache).
- The calendar, RSVPs, practices, team events, games and roster answers are
  also saved in `localStorage` (`lineup.cache.v1`, "saved on this device" in
  `lib/api.ts`, also used by the Android app's web view), so those screens
  open with what was last seen and then only revalidate with the ETag. The
  save belongs to one account (and "view as" role, set from `/me` in
  `App.tsx`), is wiped on sign out, account switch and any write, is capped
  at about 1.5 MB and drops entries older than a week.
- The team Calendar loads games and their RSVPs first (Games is the ticked
  box); practices, team events and snacks load once the games are on
  screen, or at once when their box is ticked.
- A poll vote shows the moment it is tapped (`applyPollVote` in
  `@lineup/shared`) and is saved behind the scenes; the server writes it in
  one statement.
- Pressing a tab starts its data requests on pointer-down, a little before
  the click (`prefetchScreen` in `App.tsx`).
- Team chat refreshes only while the page is visible: every 3 s while busy,
  backing off to 30 s when quiet.
- Every tab except Standings, plus Admin, Organization, Referee, Support,
  legal pages, roles guide and share views, is a separate file loaded on
  first use (`lib/lazyScreen.ts`, `React.lazy`). Once the first screen is up,
  the team tabs' files are fetched in the background while the app is idle, so
  they open without a "Loading…" flash. A page left open across a deploy
  reloads once if a screen's file is gone (`vite:preloadError` in `main.tsx`).
  The website no longer loads the Capacitor library just to ask whether it is
  inside the Android app (`lib/native.ts` reads the shell's `window.Capacitor`).
- Hashed files under `/assets/` are cached for a year (`immutable`);
  `index.html` keeps the 30-second default so a deploy shows up quickly.

Database scale: "teams I can reach" (`REACHABLE_TEAM_IDS_SQL` in
`lib/authz.ts`) and the plan's team count are unions of index lookups rather
than a join over every team, and migration 041 adds indexes for membership by
team, region and organization, attendance by practice, and logos by owner.

Moving the database and API into the same region would remove most of what
is left (about 38 ms to 1-2 ms per round trip), but dev and prd share
`wus3-lineup-pg`, so that is Fady's call. Azure refuses new PostgreSQL
servers in West US 2 (and East US 2) for this subscription, so the database
cannot simply move next to the API: either ask Azure to lift that
restriction, or run the API in West US 3 as a linked Function App.

"Today" is Pacific time everywhere it decides whether something is upcoming
(`api/src/lib/today.ts`), not the database's UTC `current_date`, which turns
over at 5 PM in California and used to hide that day's game from RSVP.

## Uploads

Logos, event flyers and chat photos use one picker
(`components/FilePick.tsx`). On phones, tablets and the Android app it offers
**Take photo** (the camera) and **Choose image** (the library); on computers
it is a drop area: drag a file onto it, or choose one. In team chat up to 4
photos can be chosen at once, or dragged anywhere onto the chat on a computer.

Pictures are stored in the database (`chat_message.image_data`,
`team_event.flyer_data`, `logo.data`) and kept small by shrinking them in the
browser before upload (`apps/web/src/lib/image.ts`): chat photos under 256 KB,
flyer photos under 512 KB, logos a 192 px WebP of a few KB (limit 200 KB).
Pictures already uploaded keep their size.

## Local development

```bash
npm ci
npm run build --workspace packages/shared
npm test --workspace packages/shared

# API (requires Azure Functions Core Tools)
cd api && npm start

# Web, in a second terminal
npm run dev --workspace apps/web
```

Create `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "",
    "DATABASE_URL": "postgres://user:pass@host:5432/lineup-dev?sslmode=require",
    "PAYWALL_ENABLED": "false",
    "IP_HASH_SALT": "change-me",
    "APP_ENV": "local"
  }
}
```

## Migrations

`db/migrate.cjs` applies every file in `db/migrations/` in order and records
each one in `schema_migration`, so re-running it is safe:

```bash
LINEUP_PG_PASSWORD=... node db/migrate.cjs lineup-dev
```

`002` is idempotent and backfills a personal org, region and catalog division
for every pre-existing team.

## Authentication

Google and Facebook, configured as custom providers in
`apps/web/public/staticwebapp.config.json`.

**This requires the Standard SKU**, and registering custom providers disables
the pre-configured Microsoft Entra ID and GitHub options — the config routes
those to 404 explicitly so nothing half-works.

Set these as Static Web App application settings (not repository secrets):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`

Redirect URI for both providers:
`https://<hostname>/.auth/login/<provider>/callback`

Only display name and email are stored.

When the sign-in runs out while the app is open, any API call answers 401
(Static Web Apps rewrites the body to `index.html`); `lib/api.ts` reports it
(`onSessionExpired`) and the app returns to the sign-in screen with "Your
session expired. Please sign in again." (signing in returns to the same page)
instead of showing the error.

### Two-step sign-in (text-message codes)

Optional per person (Fady, 10/19; he approved the per-text charge). Account ›
Two-step sign-in has a switch; with it on, every sign-in to Lineup also asks
for a code sent by text, and the first time the person adds their mobile
number (on the Microsoft-hosted sign-in page, not in Lineup).

It lives in the Lineup Auth tenant and is set up by
`infra/two-step-setup.cjs <dev|prd>` (safe to run again):

- **SMS** is switched on as a second step (Authentication methods, all users,
  not for first-factor sign-in). It is a paid External ID add-on, billed per text
  through the subscription the tenant is linked to.
- **Group** "Lineup two-step sign-in" holds the people who turned it on, and the
  Conditional Access policy "Lineup: text-message code for people who turn on
  two-step sign-in" requires multifactor sign-in for that group on the Lineup Web
  app registration. Nobody else is affected. Dev and prd share the tenant and
  the app registration, so the setting follows the person in both.
- The tenant had **Security defaults** on, which rules out Conditional Access.
  Its protections are kept as two policies: "Lineup Auth: administrators always
  use a second step" and "Lineup Auth: block old sign-in protocols".
- Policies are changed through the app "Lineup ops (sign-in policies)", which
  gets a one-hour secret per run that is removed again at the end.
- The API uses its own app, "Lineup API (two-step sign-in)", with only
  `GroupMember.ReadWrite.All` and `UserAuthenticationMethod.ReadWrite.All`. Its
  credentials and the group id are in Key Vault (`lineup-<env>-graph-client-id`,
  `-graph-client-secret`, `-two-step-group-id`) and reach the app as
  `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` and `TWO_STEP_GROUP_ID` (plus
  `AUTH_TENANT_ID`) through `infra/set-settings.cjs`.

`/api/two-step` (`api/src/functions/twoStep.ts`, `api/src/lib/graph.ts`) GET
says whether it is on and the phone ending (masked); POST `on`, `off` or
`reset-phone` (forget the registered number so the next sign-in asks for a new
one). Without the settings, or for an account outside Lineup Auth, it answers
`available: false` and the card stays hidden. Someone who lost their phone can
be taken out of the group in the Entra admin center (Groups) to sign in again.

## Admin

Two ways in, neither reachable through the API, so an account cannot
self-promote:

- `app_user.is_platform_admin = true`, set directly in the database.
- The caller's Entra object id on `ADMIN_ALLOWLIST`, stored in Key Vault as
  `lineup-<env>-admin-allowlist` and copied in by `infra/set-settings.cjs`.
  Object ids are used because the CIAM tenant does not emit an email claim.

The Admin portal (☰ menu, platform admins only) has no address of its own:
`/admin` redirects to the public roles guide, so the console cannot be found by
URL. It appears only when the endpoint answers. Its API lives under `/api/console` (`/api/console?view=…`,
`/api/console/billing`, `/api/console/notify`, …), not `/api/admin`: Static Web
Apps managed Functions never route `/api/admin*` (requests 404 at the host even
though the function is deployed). Support requests from allowlisted accounts are flagged as
Scout-eligible, meaning Scout may pick them up and remediate them. Each request
has a comment thread (`support_comment`). The requester replies from Help &
support, and a reply on a resolved request reopens it. Support replies and
changes status from the portal.

The **Usage** tab (Fady, 10/19; migration 059 `feature_usage_daily`,
`api/src/functions/usage.ts`, `apps/web/src/lib/usage.ts`) shows the most
visited pages and the most used buttons and features over 7, 30 or 90 days.
The app counts each page it opens and each tap on an action button or tab
(labelled with the page it was on), batches them, and posts them to
`POST /api/usage` every 30 seconds or when the app is hidden. Only per-day
counts are stored: no user, device or anything typed; numbers in names fold to
`#`; rows older than 13 months are cleared as new counts arrive. Menu entries
and chips (team and player names) are not counted.

Email to **support@mahoul.io** joins the same queue (migration 045,
`api/src/lib/supportEmail.ts`, helpers in `packages/shared/src/supportEmail.ts`):
Cloudflare Email Routing passes each message to a small Email Worker
(`infra/cloudflare/support-email-worker.js`, pasted into the Cloudflare
dashboard), which posts the raw message to `POST /api/support/inbound` (an
anonymous route; the `x-lineup-inbound-secret` header must match
`SUPPORT_INBOUND_SECRET`, Key Vault `lineup-<env>-support-inbound-secret`). The
API parses it (`postal-mime`), keeps only the new part of a reply, and either
adds it to the ticket whose `[#xxxxxxxx]` tag is in the subject (same sender
only; reopens a closed ticket) or opens a ticket (`source = 'email'`, linked to
the account whose email matches, otherwise `user_id` NULL; at most 5 new
tickets per address per hour; the same `Message-ID` is never stored twice). The
sender gets an acknowledgement from noreply@mahoul.io (reply-to
support@mahoul.io) unless it looks automated. Replies from support (console) or
Scout (`lineup-ops/ticket.cjs`) on email tickets are emailed back with the tag
(`emailed_at`), at once from the console and ticket.cjs, otherwise by the
background sweep. Email tickets are never Scout-eligible on their own (a From
address can be forged): the console's **Let Scout work on this** turns it on,
and `lineup-ops/support-queue.cjs` lists the others under `forHuman` without
their text.

Setup per environment: create the secret
(`az keyvault secret set --vault-name wus3-shared-kv --name lineup-<env>-support-inbound-secret --value <random>`),
run `infra/set-settings.cjs <env>` (or set `SUPPORT_INBOUND_SECRET` on the Static
Web App), then in Cloudflare (mahoul.io): Email > Email Routing > enable (adds
the MX and SPF records), create a Worker from the script with
`LINEUP_INBOUND_URL` and `LINEUP_INBOUND_SECRET`, and add a custom address
`support@mahoul.io` with the action "Send to a Worker". Email Routing and Email
Workers are free.

Views: platform totals, users by tier, subscriptions, heavy use (accounts over
500 requests or more than 5 distinct address hashes in 24 hours), deletion
queue and support requests.

Users: search by name, email or user id, open an account to see its roles,
teams, activity and admin history, and act on it. **Sign out everywhere** sets
`signout_requested_at`; every API call is refused until `/api/me` acknowledges
it, and the app then sends the browser through `/.auth/logout` (Static Web Apps
cookies cannot be revoked server-side). **Disable** refuses every call with
`ACCOUNT_DISABLED`. **Delete** queues the usual 7-day `deletion_request` and
disables the account at once; **Recover** cancels it and re-enables (and
clears a self-service deactivation). Deactivated accounts show a
"Deactivated" pill. Admins
cannot act on their own account, and every action is written to
`admin_action`.

Notify: send an in-app message to everyone, an organization, a region or a
team, narrowed by role and by plan, with a live recipient count before
sending and a read count afterwards (`notification_broadcast`,
`notification`). Every user sees messages in the header bell
(`/api/notifications`), polled once a minute.

Billing (`/api/console/billing`, migration 020): subscribers per plan, coupons
(`coupon`: percent or dollar off, plans, max uses, end date, on/off) and refund
requests (`refund_request`, raised by subscribers from Help & support, "What is
this about?" Refund, via `/api/refunds`; only once their own plan is cancelled,
otherwise the option is greyed out and the API answers `CANCEL_FIRST`; one open
at a time; approve, decline or mark refunded, and the
user is notified in the bell). Without Stripe these are records only: nothing
charges or pays out. Integrations lists each service (sign-in, database, email,
Stripe, paywall, ads, admin list) from configuration, without ever returning a
secret.

### Stripe

Dev runs against a Stripe **sandbox** (test mode, no real money). Lineup holds
only a restricted key (`rk_test_…`): write on customers, Checkout sessions, the
customer portal, subscriptions, products, prices, coupons, promotion codes,
charges and refunds, and webhook endpoints (sandbox only); read on invoices,
payment intents, events, balance and payouts; everything else off, so it can't
send money anywhere but back to the customer who paid. A live key is refused
outside production (`stripeEnabled` in `api/src/lib/stripe.ts`).

- **Setup** (`node infra/stripe-setup.cjs dev`): one product and yearly price per
  paid plan from the shared catalog (lookup key `lineup_<tier>_yearly`; a changed
  price takes the key over), the customer portal (card, invoices, cancel at the
  end of the term) and the webhook `https://<host>/api/stripe/webhook`, whose
  signing secret goes to Key Vault. Keys live in Key Vault as
  `lineup-<env>-stripe-secret-key` and `lineup-<env>-stripe-webhook-secret` and
  reach the app as `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  (`infra/set-settings.cjs`).
- **Buying** (`POST /api/billing/checkout`, `functions/stripe.ts`): Account's
  Subscribe opens Stripe Checkout for that plan, with promotion codes allowed;
  Organization and Region plans attach to the buyer's trial or the one
  organization or region they direct. One Stripe plan at a time; changes go
  through **Manage billing** (`POST /api/billing/portal`).
- **Webhook** (`/api/stripe/webhook`, anonymous route, signature checked, each
  event handled once via `stripe_event`, migration 040): checkout completed and
  subscription created, updated or deleted keep the person's `entitlement` row in
  step (`external_ref = 'stripe:<subscription>'`; active, cancelled until the end
  of the term, or expired) and convert a free trial; a failed payment tells the
  person in the bell. Account shows only **Manage billing** (cancel in Stripe);
  once the plan is cancelled it shows a green **Resume subscription** instead,
  which clears the subscription's cancel-at-period-end in Stripe.
- **Coupons**: creating one also creates a Stripe coupon and promotion code
  (once, optional plans, max uses, end date); turning it off turns the code off.
- **Refunds**: "Send refund" in the console refunds the latest payment through
  Stripe and, by default, ends the plan. Refunds Lineup sends are capped at $300
  per calendar month (Pacific), checked under a lock; anything over the cap is
  done in the Stripe dashboard. The console shows this month's money in, plans
  paid through Stripe and refunds against the cap.
- Stripe Tax is off. Going live needs a live account (ideally owned by the
  business), a live restricted key with read-only products and prices, and
  `stripe-setup.cjs prd --live`.

Plan gates: with `PAYWALL_ENABLED=true` the API refuses paid features with
402 `UPGRADE_REQUIRED` (match clock, stats beyond goals/assists/cards, share
links beyond 1 day for stats and 7 days for calendars, organization and region
standings below staff level), and the app shows a lock with a link to the plan
comparison. An organization or region plan covers only that scope's staff.

## Deployment authentication

GitHub Actions authenticates to Azure with **OIDC federated credentials**. No
client secret is stored and nothing expires. The Static Web Apps deploy token
is fetched at run time via the Azure CLI rather than kept as a repository
secret.

Repository **variables** (not secrets — these values are not sensitive):

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

/**
 * Sanity checks for the position-aware fair play bias.
 * Run: node packages/shared/test-positions.mjs
 */
import { buildFairLineup, playerSlotAffinity, slotsForFormation } from './dist/index.js';

let fails = 0;
const check = (label, pass, detail) => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) fails++;
};

const slots = slotsForFormation('11v11', '4-4-2');
const byId = Object.fromEntries(slots.map((s) => [s.id, s]));

// --- affinity shape -------------------------------------------------------
check('LB prefers the left defensive slot over the right',
  playerSlotAffinity('LB', null, byId.DEF1) > playerSlotAffinity('LB', null, byId.DEF4),
  `${playerSlotAffinity('LB', null, byId.DEF1).toFixed(2)} vs ${playerSlotAffinity('LB', null, byId.DEF4).toFixed(2)}`);

check('ST has no affinity for a defensive slot',
  playerSlotAffinity('ST', null, byId.DEF1) === 0);

check('only a declared GK has keeper affinity',
  playerSlotAffinity('GK', null, byId.GK) === 1 && playerSlotAffinity('ST', null, byId.GK) === 0);

check('secondary position counts for less than primary',
  playerSlotAffinity(null, 'LB', byId.DEF1) < playerSlotAffinity('LB', null, byId.DEF1));

// --- 11 players, named positions, 2 periods -------------------------------
const squad = [
  ['gk',  'GK'],  ['lb', 'LB'],  ['cb1', 'CB'], ['cb2', 'CB'], ['rb', 'RB'],
  ['lm',  'LM'],  ['cm1', 'CM'], ['cm2', 'CM'], ['rm', 'RM'],
  ['st1', 'ST'],  ['st2', 'ST'],
].map(([id, pos]) => ({ id, name: id, available: true, primaryPos: pos }));

const r = buildFairLineup({
  players: squad, format: '11v11', periods: 2, formations: ['4-4-2'], seed: 7,
});

check('every slot filled in both periods',
  Object.keys(r.assignments['0']).length === 11 && Object.keys(r.assignments['1']).length === 11);
check('playing time is level', r.spread === 0, `spread=${r.spread}`);

const p0 = r.assignments['0'];
const where = (pid) => Object.entries(p0).find(([, v]) => v === pid)?.[0];
check('declared keeper is in goal', where('gk') === 'GK', where('gk'));
check('left back lands on the left', ['DEF1', 'DEF2'].includes(where('lb')), where('lb'));
check('right back lands on the right', ['DEF3', 'DEF4'].includes(where('rb')), where('rb'));
check('strikers land up front',
  [where('st1'), where('st2')].every((s) => s?.startsWith('FWD')),
  `${where('st1')}, ${where('st2')}`);

// --- the "everyone is a striker" degradation ------------------------------
const silly = Array.from({ length: 11 }, (_, i) => ({
  id: `p${i}`, name: `p${i}`, available: true, primaryPos: 'ST',
}));
const s = buildFairLineup({
  players: silly, format: '11v11', periods: 4, formations: ['4-4-2'], seed: 3,
});
const filled = Object.values(s.assignments).map((a) => Object.keys(a).length);
check('all-strikers squad still fills every slot every period',
  filled.every((n) => n === 11), filled.join(','));
check('all-strikers squad still gets fair minutes', s.spread <= 1, `spread=${s.spread}`);

// Nobody should be parked in one position all game.
const posCounts = {};
for (const a of Object.values(s.assignments)) {
  for (const [slot, pid] of Object.entries(a)) {
    const line = slot.replace(/\d+$/, '');
    posCounts[pid] ??= {};
    posCounts[pid][line] = (posCounts[pid][line] ?? 0) + 1;
  }
}
const stuck = Object.entries(posCounts).filter(([, c]) => Object.values(c).some((n) => n === 4));
check('all-strikers squad still rotates positions', stuck.length <= 2,
  `${stuck.length} player(s) in one line all 4 periods`);

// --- a squad with NO positions still behaves as before --------------------
const plain = Array.from({ length: 11 }, (_, i) => ({
  id: `q${i}`, name: `q${i}`, available: true,
}));
const q = buildFairLineup({
  players: plain, format: '11v11', periods: 4, formations: ['4-4-2'], seed: 3,
});
check('squad with no stated positions is unaffected', q.spread <= 1, `spread=${q.spread}`);

// --- never-keeper is still a hard rule ------------------------------------
const nk = [
  { id: 'a', available: true, primaryPos: 'GK', neverKeeper: true },
  ...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, available: true })),
];
const n = buildFairLineup({
  players: nk, format: '11v11', periods: 2, formations: ['4-4-2'], seed: 1,
});
const keepers = Object.values(n.assignments).map((a) => a.GK);
check('never-keeper is never put in goal despite declaring GK',
  !keepers.includes('a'), keepers.join(','));

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);

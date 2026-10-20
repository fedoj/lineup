/**
 * Verifies the two data-loss fixes against a real database, inside a
 * transaction that is always rolled back:
 *
 *   1. Saving game details must not wipe the saved lineup.
 *   2. Saving the roster must keep player ids stable.
 *
 * Usage: node db/verify-fixes.cjs <databaseName>
 */
const { Client } = require('pg');

const database = process.argv[2];
if (!database) {
  console.error('usage: node db/verify-fixes.cjs <databaseName>');
  process.exit(1);
}

const password = process.env.LINEUP_PG_PASSWORD;
if (!password) {
  console.error('LINEUP_PG_PASSWORD is not set');
  process.exit(1);
}

let failures = 0;
function check(label, pass, detail) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
}

(async () => {
  const client = new Client({
    host: 'wus3-lineup-pg.postgres.database.azure.com',
    port: 5432,
    user: 'lineupadmin',
    password,
    database,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 60000,
  });

  await client.connect();
  await client.query('BEGIN');

  try {
    const u = await client.query(
      `INSERT INTO app_user (provider, subject, email, display_name)
       VALUES ('test','verify-fixes','verify@example.com','Verify')
       RETURNING id`,
    );
    const userId = u.rows[0].id;

    const org = await client.query(
      `INSERT INTO organization (name, is_personal, created_by)
       VALUES ('Verify Org', true, $1) RETURNING id`,
      [userId],
    );
    const region = await client.query(
      `INSERT INTO region (org_id, name, is_personal, created_by)
       VALUES ($1,'Default',true,$2) RETURNING id`,
      [org.rows[0].id, userId],
    );

    // ------------------------------------------------- team inherits format
    const cat = await client.query(
      `SELECT id, format, periods, period_length_sec
         FROM division_catalog WHERE id = 'BU14'`,
    );
    const d = cat.rows[0];
    check('division catalog has BU14', Boolean(d), d && `${d.format}/${d.periods}`);

    const team = await client.query(
      `INSERT INTO team (owner_id, name, age_group, season, coach, org_id, region_id,
                         catalog_division_id, gender, age_u,
                         format, periods, period_length_sec)
       VALUES ($1,'Verify FC','Boys U14','',$2,$3,$4,'BU14','boys',14,$5,$6,$7)
       RETURNING id, format, periods, period_length_sec`,
      [userId, 'Coach', org.rows[0].id, region.rows[0].id,
       d.format, d.periods, d.period_length_sec],
    );
    check(
      'team stores division match format',
      team.rows[0].format === '11v11' && team.rows[0].periods === 'halves',
      `${team.rows[0].format}/${team.rows[0].periods}`,
    );
    const teamId = team.rows[0].id;

    // ------------------------------------------------------------- players
    const p1 = await client.query(
      `INSERT INTO player (team_id, number, name, active)
       VALUES ($1,'7','Alice',true) RETURNING id`,
      [teamId],
    );
    const p2 = await client.query(
      `INSERT INTO player (team_id, number, name, active)
       VALUES ($1,'9','Bob',true) RETURNING id`,
      [teamId],
    );
    const aliceId = p1.rows[0].id;
    const bobId = p2.rows[0].id;

    // ---------------------------------------------- game with a saved lineup
    const lineup = { 0: { GK: aliceId, ST: bobId } };

    // Create exactly the way the API does: only teamId and gameNo supplied.
    const UPSERT = `
      INSERT INTO game (team_id, game_no, date, opponent, us, them, is_home,
                        format, periods, period_length_sec, formation, tactic,
                        assignments, notes, updated_at)
      VALUES ($1, $2, $3::date,
              COALESCE($4, ''), COALESCE($5, 0), COALESCE($6, 0),
              COALESCE($7, true), COALESCE($8, '7v7'), COALESCE($9, 'quarters'),
              COALESCE($10, 720), COALESCE($11, '2-3-1'), COALESCE($12, 'balanced'),
              COALESCE($13::jsonb, '{}'::jsonb), $14, now())
      ON CONFLICT (team_id, game_no) DO UPDATE SET
        date = COALESCE($3::date, game.date),
        opponent = COALESCE($4, game.opponent),
        us = COALESCE($5, game.us),
        them = COALESCE($6, game.them),
        is_home = COALESCE($7, game.is_home),
        format = COALESCE($8, game.format),
        periods = COALESCE($9, game.periods),
        period_length_sec = COALESCE($10, game.period_length_sec),
        formation = COALESCE($11, game.formation),
        tactic = COALESCE($12, game.tactic),
        assignments = COALESCE($13::jsonb, game.assignments),
        notes = COALESCE($14, game.notes),
        updated_at = now()
      RETURNING *`;

    const created = await client.query(UPSERT, [
      teamId, 1, null, null, null, null, null,
      d.format, d.periods, d.period_length_sec, '4-4-2', null, null, null,
    ]);
    const gameId = created.rows[0].id;
    check(
      'creating a game with only a team and number works',
      created.rows[0].us === 0 && created.rows[0].them === 0 &&
        created.rows[0].opponent === '' && created.rows[0].is_home === true,
      `${created.rows[0].format} ${created.rows[0].formation}`,
    );
    check(
      'new game inherits the division format',
      created.rows[0].format === '11v11' && created.rows[0].periods === 'halves' &&
        created.rows[0].period_length_sec === d.period_length_sec,
    );

    // Save a lineup on it, the way /api/lineup does.
    await client.query('UPDATE game SET assignments = $2 WHERE id = $1', [
      gameId,
      JSON.stringify(lineup),
    ]);

    // --- FIX 1: a details-only save must preserve assignments -------------
    await client.query(UPSERT, [
      teamId, 1, '2026-10-10', 'New Rivals', null, null, false,
      null, null, null, null, null, null, 'Cup tie',
    ]);

    const after = await client.query(
      'SELECT opponent, date, is_home, notes, formation, assignments FROM game WHERE id = $1',
      [gameId],
    );
    const a = after.rows[0];
    check('game details save keeps the lineup', Object.keys(a.assignments['0'] ?? {}).length === 2,
      JSON.stringify(a.assignments));
    check('game details save keeps the formation', a.formation === '4-4-2', a.formation);
    check('opponent updated', a.opponent === 'New Rivals', a.opponent);
    check('date updated', a.date instanceof Date, String(a.date));
    check('venue updated', a.is_home === false, String(a.is_home));
    check('notes updated', a.notes === 'Cup tie', a.notes);

    // --- FIX 2: roster save must keep player ids stable -------------------
    const keptIds = [aliceId, bobId];
    await client.query(
      `DELETE FROM player
        WHERE team_id = $1
          AND (cardinality($2::uuid[]) = 0 OR NOT (id = ANY($2::uuid[])))`,
      [teamId, keptIds],
    );
    await client.query(
      `UPDATE player SET number = $3, name = $4, active = $5
        WHERE id = $1 AND team_id = $2`,
      [aliceId, teamId, '10', 'Alice Smith', true],
    );

    const roster = await client.query(
      'SELECT id, number, name FROM player WHERE team_id = $1 ORDER BY name',
      [teamId],
    );
    check('roster save keeps player ids', roster.rows.some((r) => r.id === aliceId),
      `${roster.rowCount} players`);
    check('roster edit applied', roster.rows.find((r) => r.id === aliceId)?.name === 'Alice Smith');

    const stillLinked = await client.query(
      'SELECT assignments FROM game WHERE id = $1',
      [gameId],
    );
    check(
      'lineup still references the same players after roster save',
      stillLinked.rows[0].assignments['0'].GK === aliceId,
    );

    // --- new event kinds ---------------------------------------------------
    for (const kind of ['corner', 'foul', 'yellow', 'red', 'goal', 'own_goal']) {
      await client.query(
        `INSERT INTO game_event (game_id, player_id, kind, period_index, clock_sec, against)
         VALUES ($1,$2,$3,0,120,false)`,
        [gameId, kind === 'corner' || kind === 'foul' ? null : aliceId, kind],
      );
    }
    const kinds = await client.query(
      'SELECT kind FROM game_event WHERE game_id = $1 ORDER BY kind',
      [gameId],
    );
    check('all event kinds accepted', kinds.rowCount === 6,
      kinds.rows.map((r) => r.kind).join(','));

    // Scoreline recount: 1 goal for us, 1 own goal by us counts for them.
    await client.query(
      `UPDATE game SET
         us = (SELECT COUNT(*) FROM game_event
                WHERE game_id = $1
                  AND ((kind = 'goal' AND NOT against) OR (kind = 'own_goal' AND against))),
         them = (SELECT COUNT(*) FROM game_event
                  WHERE game_id = $1
                    AND ((kind = 'goal' AND against) OR (kind = 'own_goal' AND NOT against)))
       WHERE id = $1`,
      [gameId],
    );
    const score = await client.query('SELECT us, them FROM game WHERE id = $1', [gameId]);
    check('own goal credits the opposition', score.rows[0].us === 1 && score.rows[0].them === 1,
      `${score.rows[0].us}-${score.rows[0].them}`);

    // --- dropping a player clears them from the lineup --------------------
    const gone = await client.query(
      `DELETE FROM player
        WHERE team_id = $1 AND NOT (id = ANY($2::uuid[]))
      RETURNING id`,
      [teamId, [aliceId]],
    );
    check('removing a player returns the dropped id', gone.rows[0]?.id === bobId);
  } catch (err) {
    console.error('ERROR', err.message);
    failures++;
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

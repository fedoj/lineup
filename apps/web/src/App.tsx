import { useEffect, useState } from 'react';
import { formatPrice } from '@lineup/shared';
import { api, ApiError, type MeResponse } from './lib/api';

type Health = { status: string; database: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const h = await api.health();
        if (!cancelled) setHealth(h);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Health check failed');
        }
      }

      try {
        const m = await api.me();
        if (!cancelled) setMe(m);
      } catch (err) {
        // 401 simply means signed out — not an error state.
        if (!cancelled && !(err instanceof ApiError && err.status === 401)) {
          setError(err instanceof Error ? err.message : 'Failed to load profile');
        }
      }

      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="wrap">
      <header className="bar">
        <div className="brand">
          <span className="ball">⚽</span>
          <div>
            <h1>Lineup</h1>
            <span className="sub">Formations, fair rotation, season tracking</span>
          </div>
        </div>
        {me ? (
          <a className="btn ghost" href="/.auth/logout">
            Sign out
          </a>
        ) : (
          <a className="btn" href="/.auth/login/aad">
            Sign in
          </a>
        )}
      </header>

      {loading && <section className="card">Loading…</section>}

      {error && (
        <section className="card err">
          <strong>Problem:</strong> {error}
        </section>
      )}

      {health && (
        <section className="card">
          <h2>Service</h2>
          <dl className="kv">
            <dt>API</dt>
            <dd>{health.status}</dd>
            <dt>Database</dt>
            <dd>{health.database}</dd>
          </dl>
        </section>
      )}

      {me ? (
        <>
          <section className="card">
            <h2>Your plan</h2>
            <dl className="kv">
              <dt>Signed in</dt>
              <dd>{me.user.email ?? me.user.provider}</dd>
              <dt>Tier</dt>
              <dd>{me.plan.tiers[me.tier].name}</dd>
              <dt>Teams</dt>
              <dd>
                {me.usage.teams ?? 0}
                {me.paywallEnabled ? ` / ${me.limits.teams}` : ' (unlimited)'}
              </dd>
              <dt>Games</dt>
              <dd>
                {me.usage.games ?? 0}
                {me.paywallEnabled ? ` / ${me.limits.games}` : ' (unlimited)'}
              </dd>
            </dl>
            {!me.paywallEnabled && (
              <p className="note">Everything is free while we are in early access.</p>
            )}
          </section>

          <section className="card">
            <h2>Plans</h2>
            <table className="tiers">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Teams</th>
                  <th>Games</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(me.plan.tiers).map((t) => (
                  <tr key={t.id} className={t.id === me.tier ? 'current' : undefined}>
                    <td>{t.name}</td>
                    <td>{t.limits.teams}</td>
                    <td>{t.limits.games}</td>
                    <td>{formatPrice(t.priceCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        !loading && (
          <section className="card">
            <h2>Welcome</h2>
            <p>Sign in to manage your teams, lineups and season.</p>
          </section>
        )
      )}
    </main>
  );
}

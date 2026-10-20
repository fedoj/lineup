import { useEffect, useState } from 'react';
import type { HierarchyOrg, HierarchyRegion, HierarchyTeam, StandingsScope } from '../lib/api';
import { Logo } from './Logo';

type Key = `${StandingsScope}:${string}`;

const COLLAPSED_KEY = 'lineup.menu.collapsed';
const FAVORITES_KEY = 'lineup.menu.favorites';

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** A list of keys kept in localStorage, so the menu opens the way it was left. */
function useStoredSet(key: string) {
  const [items, setItems] = useState<string[]>(() => readList(key));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(items));
    } catch {
      /* private mode: preference just does not persist */
    }
  }, [key, items]);
  const toggle = (k: string) =>
    setItems((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  return [items, setItems, toggle] as const;
}

export interface MenuDrawerProps {
  orgs: HierarchyOrg[];
  /** Standalone regions, shown at the top level with their teams. */
  regions?: HierarchyRegion[];
  teams: HierarchyTeam[];
  selection: { kind: StandingsScope; id: string } | null;
  onSelect: (kind: StandingsScope, id: string) => void;
  onClose: () => void;
  /** Bottom-of-menu items: setup, account, support, admin, sign out. */
  children: React.ReactNode;
  /** Shown at the top, under the favorites: Games (Fady, 10/18; renamed 10/19). */
  top?: React.ReactNode;
  /** Optional quiet "new team" action under the tree. */
  newTeam?: React.ReactNode;
  /** Set-up or upgrade entry for organizations and regions, when there is one. */
  orgUpsell?: React.ReactNode;
}

/**
 * The navigation drawer: Organization › Region › Team as a collapsible tree,
 * with pinned favorites on top. Screens for the selected item (standings,
 * calendar, match day…) live on the page itself, not in here.
 */
export default function MenuDrawer({
  orgs,
  regions = [],
  teams,
  selection,
  onSelect,
  onClose,
  children,
  top,
  newTeam,
  orgUpsell,
}: MenuDrawerProps) {
  const [collapsed, setCollapsed, toggleCollapsed] = useStoredSet(COLLAPSED_KEY);
  const [favorites, , toggleFavorite] = useStoredSet(FAVORITES_KEY);

  // Archived teams sit in their own section at the bottom.
  const active = teams.filter((t) => !t.archived);
  const archivedTeams = teams.filter((t) => t.archived);
  const [showArchived, setShowArchived] = useState(false);

  const standaloneIds = new Set(regions.map((r) => r.id));
  const looseTeams = active.filter((t) => !t.orgId && !(t.regionId && standaloneIds.has(t.regionId)));
  const regionKeys = [...orgs.flatMap((o) => o.regions), ...regions].map((r) => `region:${r.id}`);
  const collapsible = [
    ...orgs.map((o) => `org:${o.id}`),
    ...regionKeys,
    ...(looseTeams.length ? ['section:loose'] : []),
  ];
  const allCollapsed = collapsible.length > 0 && collapsible.every((k) => collapsed.includes(k));

  // Resolve a favorite back to something that still exists and is visible.
  const resolve = (k: string): { kind: StandingsScope; id: string; name: string; logo?: string | null } | null => {
    const [kind, id] = k.split(':') as [StandingsScope, string];
    if (kind === 'org') {
      const o = orgs.find((x) => x.id === id);
      return o ? { kind, id, name: o.name, logo: o.logo } : null;
    }
    if (kind === 'region') {
      const r = [...orgs.flatMap((o) => o.regions), ...regions].find((x) => x.id === id);
      return r ? { kind, id, name: r.name, logo: r.logo } : null;
    }
    const t = teams.find((x) => x.id === id);
    return t ? { kind: 'team', id, name: t.name, logo: t.logo } : null;
  };
  const favs = favorites.map(resolve).filter((x): x is NonNullable<typeof x> => x !== null);

  const isOn = (kind: StandingsScope, id: string) => selection?.kind === kind && selection.id === id;

  function renderNode({
    kind,
    id,
    name,
    logo,
    level,
    childKey,
    keyPrefix = '',
  }: {
    keyPrefix?: string;
    kind: StandingsScope;
    id: string;
    name: string;
    logo?: string | null;
    level: number;
    /** Set when the node has children that can be folded away. */
    childKey?: string;
  }) {
    const key: Key = `${kind}:${id}`;
    const folded = childKey ? collapsed.includes(childKey) : false;
    const pinned = favorites.includes(key);
    return (
      <div key={`${keyPrefix}${key}`} className={`tree-row lvl${level}`}>
        {childKey ? (
          <button
            type="button"
            className="caret"
            aria-label={folded ? `Expand ${name}` : `Collapse ${name}`}
            aria-expanded={!folded}
            onClick={() => toggleCollapsed(childKey)}
          >
            {folded ? '▸' : '▾'}
          </button>
        ) : (
          <span className="caret-spacer" />
        )}
        <button
          type="button"
          className={`item ${isOn(kind, id) ? 'on' : ''}`}
          onClick={() => onSelect(kind, id)}
        >
          <Logo kind={kind} id={id} version={logo} size={20} />
          <span className="item-label">{name}</span>
        </button>
        <button
          type="button"
          className={`pin ${pinned ? 'on' : ''}`}
          title={pinned ? 'Unpin from favorites' : 'Pin to favorites'}
          aria-label={pinned ? `Unpin ${name}` : `Pin ${name} to favorites`}
          aria-pressed={pinned}
          onClick={() => toggleFavorite(key)}
        >
          {pinned ? '★' : '☆'}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <nav className="drawer" aria-label="Menu">
        <div className="drawer-head">
          <strong>Menu</strong>
          <div className="row">
            {collapsible.length > 0 && (
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={() => setCollapsed(allCollapsed ? [] : collapsible)}
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
            )}
            <button type="button" className="chip-x" title="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {favs.length > 0 && (
          <>
            <h3>★ Favorites</h3>
            {favs.map((f) =>
              renderNode({ kind: f.kind, id: f.id, name: f.name, logo: f.logo, level: 0, keyPrefix: 'fav-' }),
            )}
            <div className="divider" />
          </>
        )}

        {top && (
          <>
            {top}
            <div className="divider" />
          </>
        )}

        {orgs.map((o) => {
          const orgFolded = collapsed.includes(`org:${o.id}`);
          const directTeams = active.filter((t) => t.orgId === o.id && !t.regionId);
          return (
            <div key={o.id}>
              {renderNode({
                kind: 'org',
                id: o.id,
                name: o.name,
                logo: o.logo,
                level: 0,
                childKey: `org:${o.id}`,
              })}
              {!orgFolded &&
                o.regions.map((r) => {
                  const regionTeams = active.filter((t) => t.regionId === r.id);
                  const regionFolded = collapsed.includes(`region:${r.id}`);
                  return (
                    <div key={r.id}>
              {renderNode({
                kind: 'region',
                id: r.id,
                name: r.name,
                logo: r.logo,
                level: 1,
                childKey: regionTeams.length ? `region:${r.id}` : undefined,
              })}
                      {!regionFolded &&
                        regionTeams.map((t) =>
                          renderNode({ kind: 'team', id: t.id, name: t.name, logo: t.logo, level: 2 }),
                        )}
                    </div>
                  );
                })}
              {!orgFolded &&
                directTeams.map((t) =>
                  renderNode({ kind: 'team', id: t.id, name: t.name, logo: t.logo, level: 1 }),
                )}
            </div>
          );
        })}

        {regions.map((r) => {
          const regionTeams = active.filter((t) => t.regionId === r.id);
          const regionFolded = collapsed.includes(`region:${r.id}`);
          return (
            <div key={r.id}>
              {renderNode({
                kind: 'region',
                id: r.id,
                name: r.name,
                logo: r.logo,
                level: 0,
                childKey: regionTeams.length ? `region:${r.id}` : undefined,
              })}
              {!regionFolded &&
                regionTeams.map((t) =>
                  renderNode({ kind: 'team', id: t.id, name: t.name, logo: t.logo, level: 1 }),
                )}
            </div>
          );
        })}

        {orgUpsell}

        {looseTeams.length > 0 && (
          <>
            <button
              type="button"
              className="tree-section"
              aria-expanded={!collapsed.includes('section:loose')}
              onClick={() => toggleCollapsed('section:loose')}
            >
              {collapsed.includes('section:loose') ? '▸' : '▾'} {orgs.length || regions.length ? 'Independent teams' : 'My teams'}
            </button>
            {!collapsed.includes('section:loose') &&
              looseTeams.map((t) =>
                renderNode({ kind: 'team', id: t.id, name: t.name, logo: t.logo, level: 0 }),
              )}
          </>
        )}

        {newTeam}

        {archivedTeams.length > 0 && (
          <>
            <button
              type="button"
              className="tree-section"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? '▾' : '▸'} 🗄️ Archived teams ({archivedTeams.length})
            </button>
            {showArchived &&
              archivedTeams.map((t) =>
                renderNode({ kind: 'team', id: t.id, name: t.name, logo: t.logo, level: 0, keyPrefix: 'arch-' }),
              )}
          </>
        )}

        <div className="divider" />
        {children}
      </nav>
    </>
  );
}

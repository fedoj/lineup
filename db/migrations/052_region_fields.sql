-- Fields and field maps for a region (Fady, 10/17).
--
-- A region (standalone or in an organization) keeps up to 10 fields: a name,
-- the location (found with "Find", so it links to the right place on the map)
-- and a field map image (which pitch is where). Game forms offer the region's
-- fields as quick picks, and a game at one of them shows "Field map".

CREATE TABLE IF NOT EXISTS region_field (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   UUID NOT NULL REFERENCES region(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    location    TEXT NOT NULL CHECK (length(location) BETWEEN 1 AND 160),
    map_mime    TEXT CHECK (map_mime IN ('image/jpeg', 'image/png', 'image/webp')),
    map_data    BYTEA,
    created_by  UUID REFERENCES app_user(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS region_field_region_idx ON region_field(region_id);

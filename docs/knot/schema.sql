PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>0)) STRICT;
CREATE TABLE fiscal_period (id TEXT PRIMARY KEY, closed INTEGER NOT NULL CHECK(closed IN (0,1))) STRICT;
CREATE TABLE cost_center (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE skill (id TEXT PRIMARY KEY) STRICT;
CREATE TABLE project (
  id TEXT PRIMARY KEY, name_ja TEXT NOT NULL, name_en TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2),
  status TEXT NOT NULL CHECK(status IN ('planned','active','ready'))
) STRICT;
CREATE TABLE pool (
  id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES project(id),
  period TEXT NOT NULL REFERENCES fiscal_period(id),
  center TEXT NOT NULL REFERENCES cost_center(id),
  skill TEXT NOT NULL REFERENCES skill(id),
  budget INTEGER NOT NULL CHECK(budget>=0), hours INTEGER NOT NULL CHECK(hours>=0),
  min_budget INTEGER NOT NULL CHECK(min_budget>=0), min_hours INTEGER NOT NULL CHECK(min_hours>=0),
  max_budget INTEGER NOT NULL CHECK(max_budget>=min_budget),
  max_hours INTEGER NOT NULL CHECK(max_hours>=min_hours),
  locked INTEGER NOT NULL CHECK(locked IN (0,1)), UNIQUE(project,period,center,skill)
) STRICT;
CREATE TABLE opening (
  pool TEXT PRIMARY KEY REFERENCES pool(id), budget INTEGER NOT NULL, hours INTEGER NOT NULL
) STRICT;
CREATE TABLE commitment (
  id TEXT PRIMARY KEY, pool TEXT NOT NULL REFERENCES pool(id),
  budget INTEGER NOT NULL CHECK(budget>=0), hours INTEGER NOT NULL CHECK(hours>=0),
  status TEXT NOT NULL CHECK(status IN ('approved','canceled'))
) STRICT;
CREATE TABLE dependency (
  project TEXT NOT NULL REFERENCES project(id), prerequisite TEXT NOT NULL REFERENCES project(id),
  period TEXT NOT NULL REFERENCES fiscal_period(id),
  PRIMARY KEY (project,prerequisite,period), CHECK(project<>prerequisite)
) STRICT;
CREATE TABLE route (
  origin TEXT NOT NULL REFERENCES cost_center(id), destination TEXT NOT NULL REFERENCES cost_center(id),
  skill TEXT NOT NULL REFERENCES skill(id), PRIMARY KEY (origin,destination,skill)
) STRICT;
CREATE TABLE batch (
  id TEXT PRIMARY KEY, event TEXT NOT NULL, proposal TEXT NOT NULL,
  revision INTEGER NOT NULL UNIQUE, project TEXT NOT NULL REFERENCES project(id),
  budget INTEGER NOT NULL CHECK(budget>0), hours INTEGER NOT NULL CHECK(hours>0),
  items INTEGER NOT NULL CHECK(items>0)
) STRICT;
CREATE TABLE journal (
  batch TEXT NOT NULL REFERENCES batch(id), item INTEGER NOT NULL CHECK(item>0),
  sign INTEGER NOT NULL CHECK(sign IN (-1,1)), pool TEXT NOT NULL REFERENCES pool(id),
  budget INTEGER NOT NULL CHECK(budget<>0 AND budget*sign>0),
  hours INTEGER NOT NULL CHECK(hours<>0 AND hours*sign>0),
  PRIMARY KEY (batch,item,sign)
) STRICT;
CREATE INDEX pool_by_project ON pool(project);
CREATE INDEX commitments_by_pool ON commitment(pool,status);
CREATE INDEX journal_by_pool ON journal(pool);

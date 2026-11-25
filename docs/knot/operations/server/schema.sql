CREATE TABLE control(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('v1','expanded','v2'))) STRICT;
INSERT INTO control VALUES(1,1,'v1');
CREATE TABLE principal(id TEXT PRIMARY KEY, token_hash BLOB UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('reader','poster','operator'))) STRICT;
CREATE TABLE grant_scope(principal TEXT REFERENCES principal(id), center TEXT, PRIMARY KEY(principal,center)) STRICT;
CREATE TABLE period(id TEXT PRIMARY KEY, closed INTEGER NOT NULL CHECK(closed IN (0,1))) STRICT;
CREATE TABLE project(id TEXT PRIMARY KEY, priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2), ready INTEGER NOT NULL CHECK(ready IN (0,1))) STRICT;
CREATE TABLE dependency(project TEXT REFERENCES project(id), prerequisite TEXT REFERENCES project(id), PRIMARY KEY(project,prerequisite)) STRICT;
CREATE TABLE route(origin TEXT, destination TEXT, skill TEXT, PRIMARY KEY(origin,destination,skill)) STRICT;
CREATE TABLE pool(id TEXT PRIMARY KEY, project TEXT NOT NULL REFERENCES project(id), period TEXT NOT NULL REFERENCES period(id), center TEXT NOT NULL, skill TEXT NOT NULL,
 min_budget INTEGER NOT NULL CHECK(min_budget>=0), min_hours INTEGER NOT NULL CHECK(min_hours>=0), max_budget INTEGER NOT NULL CHECK(max_budget>=min_budget), max_hours INTEGER NOT NULL CHECK(max_hours>=min_hours), locked INTEGER NOT NULL CHECK(locked IN (0,1)), UNIQUE(project,period,center,skill)) STRICT;
CREATE TABLE commitment(id TEXT PRIMARY KEY,pool TEXT NOT NULL REFERENCES pool(id),budget INTEGER NOT NULL CHECK(budget>=0),hours INTEGER NOT NULL CHECK(hours>=0),approved INTEGER NOT NULL CHECK(approved IN (0,1))) STRICT;
CREATE TABLE opening(pool TEXT PRIMARY KEY REFERENCES pool(id),budget INTEGER NOT NULL CHECK(budget>=0), hours INTEGER NOT NULL CHECK(hours>=0)) STRICT;
CREATE TABLE balance_v1(pool TEXT PRIMARY KEY REFERENCES pool(id),budget INTEGER NOT NULL CHECK(budget>=0), hours INTEGER NOT NULL CHECK(hours>=0)) STRICT;
CREATE TABLE receipt(revision INTEGER PRIMARY KEY CHECK(revision>=2), actor TEXT NOT NULL REFERENCES principal(id), request_key TEXT NOT NULL, body_hash TEXT NOT NULL, writer INTEGER NOT NULL CHECK(writer IN (1,2)), schema_phase TEXT NOT NULL CHECK(schema_phase IN ('v1','expanded','v2')), project TEXT NOT NULL REFERENCES project(id), priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2), UNIQUE(actor,request_key)) STRICT;
CREATE TABLE journal(revision INTEGER REFERENCES receipt(revision), item INTEGER NOT NULL CHECK(item>=0), leg INTEGER NOT NULL CHECK(leg IN (-1,1)),pool TEXT NOT NULL REFERENCES pool(id),budget INTEGER NOT NULL CHECK(budget>0),hours INTEGER NOT NULL CHECK(hours>0),PRIMARY KEY(revision,item,leg)) STRICT;
CREATE INDEX journal_by_pool ON journal(pool);

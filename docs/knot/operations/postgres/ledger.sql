BEGIN;
CREATE ROLE knot_owner NOLOGIN;
CREATE ROLE north_writer LOGIN;
CREATE ROLE north_peer LOGIN;
CREATE ROLE north_reader LOGIN;
CREATE ROLE south_writer LOGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC;
CREATE SCHEMA knot_store AUTHORIZATION knot_owner;
CREATE SCHEMA knot_api AUTHORIZATION knot_owner;
SET LOCAL ROLE knot_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE knot_store.scope (
  login name PRIMARY KEY, tenant text NOT NULL, can_post boolean NOT NULL
);
INSERT INTO knot_store.scope VALUES
  ('north_writer','north',true),('north_peer','north',true),
  ('north_reader','north',false),('south_writer','south',true);
CREATE TABLE knot_store.control (id int PRIMARY KEY CHECK(id=1), phase text NOT NULL CHECK(phase IN ('v1','dual','v2')));
INSERT INTO knot_store.control VALUES (1,'v1');
CREATE TABLE knot_store.head (tenant text PRIMARY KEY, revision int NOT NULL CHECK(revision>0));
INSERT INTO knot_store.head VALUES ('north',1),('south',1);
CREATE TABLE knot_store.opening (
  tenant text REFERENCES knot_store.head, pool text,
  budget int NOT NULL, hours int NOT NULL, PRIMARY KEY(tenant,pool)
);
INSERT INTO knot_store.opening VALUES ('north','A',1000,400),('north','B',300,150),('south','A',800,300),('south','B',200,100);
CREATE TABLE knot_store.wide (
  tenant text, pool text, budget int NOT NULL CHECK(budget>=0), hours int NOT NULL CHECK(hours>=0),
  PRIMARY KEY(tenant,pool), FOREIGN KEY(tenant,pool) REFERENCES knot_store.opening
);
INSERT INTO knot_store.wide SELECT * FROM knot_store.opening;
CREATE TABLE knot_store.journal (
  tenant text REFERENCES knot_store.head, request_id text, revision int NOT NULL,
  actor name NOT NULL, client_version int NOT NULL, budget int NOT NULL CHECK(budget>0), hours int NOT NULL CHECK(hours>0),
  PRIMARY KEY (tenant,request_id), UNIQUE(tenant,revision)
);

CREATE FUNCTION knot_store.authorize(t text, writing boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM knot_store.scope s WHERE s.login=session_user AND s.tenant=t AND (NOT writing OR s.can_post)) THEN
    RAISE EXCEPTION 'outside authorized scope' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION knot_api.balance(t text, p text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE mode text; b int; h int;
BEGIN
  PERFORM knot_store.authorize(t,false);
  SELECT phase INTO mode FROM knot_store.control WHERE id=1 FOR SHARE;
  IF mode='v2' THEN
    SELECT max(amount) FILTER (WHERE unit='budget'),max(amount) FILTER (WHERE unit='hours')
      INTO b,h FROM knot_store.amount WHERE tenant=t AND pool=p;
  ELSE
    SELECT w.budget,w.hours INTO b,h FROM knot_store.wide w WHERE w.tenant=t AND w.pool=p;
  END IF;
  RETURN b::text || ',' || h::text;
END $$;

-- All proposals here move positive units from pool A to pool B inside one tenant.
-- An accepted transaction holds a shared cutover gate and the locked tenant revision.
CREATE FUNCTION knot_store.post(v int,t text,req text,expected int,b int,h int) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE mode text; rev int; prev knot_store.journal%ROWTYPE; rem_b int; rem_h int;
BEGIN
  PERFORM knot_store.authorize(t,true);
  IF req IS NULL OR req='' OR expected IS NULL OR b IS NULL OR h IS NULL OR b<=0 OR h<=0 THEN RETURN 'invalid'; END IF;
  SELECT phase INTO mode FROM knot_store.control WHERE id=1 FOR SHARE;
  IF v=1 AND mode='v2' THEN RETURN 'writer-retired'; END IF;
  IF v=2 AND mode='v1' THEN RETURN 'not-expanded'; END IF;
  SELECT revision INTO STRICT rev FROM knot_store.head WHERE tenant=t FOR UPDATE;
  SELECT * INTO prev FROM knot_store.journal j WHERE j.tenant=t AND j.request_id=req;
  IF FOUND THEN
    IF prev.actor=session_user AND prev.budget=b AND prev.hours=h AND prev.revision=expected+1 THEN RETURN 'duplicate'; END IF;
    RETURN 'id-conflict';
  END IF;
  IF expected<>rev THEN RETURN 'stale'; END IF;
  IF v=1 THEN
    SELECT budget,hours INTO STRICT rem_b,rem_h FROM knot_store.wide WHERE tenant=t AND pool='A';
  ELSIF mode='dual' THEN
    -- Wide rows remain current throughout expansion, including rows not yet backfilled.
    SELECT budget,hours INTO STRICT rem_b,rem_h FROM knot_store.wide WHERE tenant=t AND pool='A';
  ELSE
    SELECT max(amount) FILTER (WHERE unit='budget'),max(amount) FILTER (WHERE unit='hours')
      INTO rem_b,rem_h FROM knot_store.amount WHERE tenant=t AND pool='A';
  END IF;
  IF rem_b IS NULL OR rem_h IS NULL THEN RAISE EXCEPTION 'missing balance'; END IF;
  IF rem_b<b OR rem_h<h THEN RETURN 'insufficient'; END IF;
  IF v=1 THEN
    UPDATE knot_store.wide SET budget=budget+CASE WHEN pool='A' THEN -b ELSE b END,
                               hours=hours+CASE WHEN pool='A' THEN -h ELSE h END WHERE tenant=t;
    IF mode='dual' THEN PERFORM knot_store.copy_wide(t); END IF;
  ELSE
    IF mode='dual' THEN PERFORM knot_store.copy_wide(t); END IF;
    UPDATE knot_store.amount SET amount=amount+(CASE WHEN pool='A' THEN -1 ELSE 1 END)*(CASE WHEN unit='budget' THEN b ELSE h END)
      WHERE tenant=t;
    IF mode='dual' THEN
      UPDATE knot_store.wide w SET budget=a.amount,hours=z.amount
      FROM knot_store.amount a JOIN knot_store.amount z USING(tenant,pool)
      WHERE w.tenant=t AND w.tenant=a.tenant AND w.pool=a.pool AND a.unit='budget' AND z.unit='hours';
    END IF;
  END IF;
  INSERT INTO knot_store.journal VALUES(t,req,rev+1,session_user,v,b,h);
  UPDATE knot_store.head SET revision=rev+1 WHERE tenant=t;
  RETURN 'committed';
END $$;

CREATE FUNCTION knot_api.post_v1(t text,req text,expected int,b int,h int) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS 'SELECT knot_store.post(1,$1,$2,$3,$4,$5)';
CREATE FUNCTION knot_api.post_v2(t text,req text,expected int,b int,h int) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS 'SELECT knot_store.post(2,$1,$2,$3,$4,$5)';
GRANT USAGE ON SCHEMA knot_api TO north_writer,north_peer,north_reader,south_writer;
GRANT EXECUTE ON FUNCTION knot_api.balance(text,text) TO north_writer,north_peer,north_reader,south_writer;
GRANT EXECUTE ON FUNCTION knot_api.post_v1(text,text,int,int,int),
  knot_api.post_v2(text,text,int,int,int) TO north_writer,north_peer,south_writer;
COMMIT;

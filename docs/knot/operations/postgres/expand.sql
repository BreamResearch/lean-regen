BEGIN;
SET LOCAL ROLE knot_owner;
SELECT phase FROM knot_store.control WHERE id=1 FOR UPDATE;
CREATE TABLE knot_store.amount (
  tenant text, pool text, unit text CHECK(unit IN ('budget','hours')), amount int NOT NULL CHECK(amount>=0),
  PRIMARY KEY(tenant,pool,unit), FOREIGN KEY(tenant,pool) REFERENCES knot_store.opening
);
CREATE FUNCTION knot_store.copy_wide(t text) RETURNS void LANGUAGE sql SET search_path=pg_catalog,pg_temp AS $$
  INSERT INTO knot_store.amount (tenant,pool,unit,amount)
  SELECT w.tenant,w.pool,v.unit,v.amount FROM knot_store.wide w
  CROSS JOIN LATERAL (VALUES ('budget',w.budget),('hours',w.hours)) v(unit,amount) WHERE w.tenant=t
  ON CONFLICT(tenant,pool,unit) DO UPDATE SET amount=excluded.amount
$$;

CREATE FUNCTION knot_store.backfill(t text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM 1 FROM knot_store.control WHERE id=1 AND phase='dual' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'backfill outside dual mode'; END IF;
  PERFORM 1 FROM knot_store.head WHERE tenant=t FOR UPDATE;
  PERFORM knot_store.copy_wide(t);
END $$;

CREATE FUNCTION knot_store.contract() RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE mode text;
BEGIN
  SELECT phase INTO mode FROM knot_store.control WHERE id=1 FOR UPDATE;
  IF mode<>'dual' THEN RETURN 'wrong-phase'; END IF;
  IF EXISTS (
    WITH delta AS (
      SELECT o.tenant,o.pool,o.budget + (CASE WHEN o.pool='A' THEN -1 ELSE 1 END)*COALESCE(sum(j.budget),0) AS budget,
             o.hours + (CASE WHEN o.pool='A' THEN -1 ELSE 1 END)*COALESCE(sum(j.hours),0) AS hours
      FROM knot_store.opening o LEFT JOIN knot_store.journal j ON j.tenant=o.tenant
      GROUP BY o.tenant,o.pool,o.budget,o.hours
    )
    SELECT 1 FROM delta d LEFT JOIN knot_store.wide w USING(tenant,pool)
    LEFT JOIN knot_store.amount b ON b.tenant=d.tenant AND b.pool=d.pool AND b.unit='budget'
    LEFT JOIN knot_store.amount h ON h.tenant=d.tenant AND h.pool=d.pool AND h.unit='hours'
    WHERE d.budget IS DISTINCT FROM w.budget OR d.hours IS DISTINCT FROM w.hours
       OR d.budget IS DISTINCT FROM b.amount OR d.hours IS DISTINCT FROM h.amount
  ) THEN RETURN 'unreconciled'; END IF;
  DROP TABLE knot_store.wide;
  UPDATE knot_store.control SET phase='v2' WHERE id=1;
  RETURN 'contracted';
END $$;
UPDATE knot_store.control SET phase='dual' WHERE id=1;
COMMIT;

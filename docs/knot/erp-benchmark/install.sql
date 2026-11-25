-- Run only in the freshly provisioned benchmark ERP database. Existing schema aborts installation.
CREATE SCHEMA knot_bench;
CREATE TABLE knot_bench.control (
  singleton boolean PRIMARY KEY CHECK (singleton),
  phase text NOT NULL CHECK (phase IN ('legacy', 'dual', 'normalized'))
);
INSERT INTO knot_bench.control VALUES (true, 'legacy');
LOCK TABLE public.account_analytic_line IN SHARE ROW EXCLUSIVE MODE;
CREATE VIEW knot_bench.erp_lines AS
  SELECT id, name::text, company_id, account_id,
         amount::numeric AS budget, unit_amount::numeric AS hours
  FROM public.account_analytic_line WHERE name LIKE 'KNOTBENCH:%';
CREATE TABLE knot_bench.wide (
  id integer PRIMARY KEY, name text UNIQUE NOT NULL,
  company_id integer NOT NULL, account_id integer NOT NULL,
  budget numeric NOT NULL, hours numeric NOT NULL
);
INSERT INTO knot_bench.wide SELECT * FROM knot_bench.erp_lines;
CREATE VIEW knot_bench.current_lines AS SELECT * FROM knot_bench.wide;

CREATE FUNCTION knot_bench.capture_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE phase_now text; old_scoped boolean := false; new_scoped boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_scoped := OLD.name LIKE 'KNOTBENCH:%'; END IF;
  IF TG_OP <> 'DELETE' THEN new_scoped := NEW.name LIKE 'KNOTBENCH:%'; END IF;
  IF NOT coalesce(old_scoped,false) AND NOT coalesce(new_scoped,false) THEN RETURN NULL; END IF;
  SELECT phase INTO STRICT phase_now FROM knot_bench.control WHERE singleton FOR SHARE;
  IF old_scoped AND (NOT coalesce(new_scoped,false) OR OLD.id <> NEW.id) THEN
    IF phase_now <> 'normalized' THEN DELETE FROM knot_bench.wide WHERE id=OLD.id; END IF;
    IF phase_now <> 'legacy' THEN DELETE FROM knot_bench.line_key WHERE id=OLD.id; END IF;
  END IF;
  IF new_scoped THEN
    IF phase_now <> 'normalized' THEN
      INSERT INTO knot_bench.wide VALUES (NEW.id,NEW.name,NEW.company_id,NEW.account_id,NEW.amount,NEW.unit_amount)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,company_id=excluded.company_id,
        account_id=excluded.account_id,budget=excluded.budget,hours=excluded.hours;
    END IF;
    IF phase_now <> 'legacy' THEN
      INSERT INTO knot_bench.line_key VALUES (NEW.id,NEW.name,NEW.company_id,NEW.account_id)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,company_id=excluded.company_id,account_id=excluded.account_id;
      INSERT INTO knot_bench.line_unit VALUES (NEW.id,'budget',NEW.amount),(NEW.id,'hours',NEW.unit_amount)
      ON CONFLICT(id,unit) DO UPDATE SET amount=excluded.amount;
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION knot_bench.capture_line() FROM PUBLIC;
CREATE TRIGGER knot_benchmark_projection AFTER INSERT OR UPDATE OR DELETE ON public.account_analytic_line
FOR EACH ROW EXECUTE FUNCTION knot_bench.capture_line();

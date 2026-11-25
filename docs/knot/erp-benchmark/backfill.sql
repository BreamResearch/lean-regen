-- Lock source rows for this bounded page. A live edit or deletion after copying
-- fires the same transactional trigger. Newly inserted native lines mirror immediately.
WITH page AS MATERIALIZED (
  SELECT id,name,company_id,account_id,amount::numeric AS budget,unit_amount::numeric AS hours
  FROM public.account_analytic_line
  WHERE id > %s AND id <= %s AND name LIKE 'KNOTBENCH:%%'
  ORDER BY id LIMIT %s FOR SHARE
), keys AS (
  INSERT INTO knot_bench.line_key SELECT id,name,company_id,account_id FROM page
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,company_id=excluded.company_id,account_id=excluded.account_id
  RETURNING id
), units AS (
  INSERT INTO knot_bench.line_unit
  SELECT p.id,v.unit,v.amount FROM page p JOIN keys k USING(id)
  CROSS JOIN LATERAL (VALUES ('budget',p.budget),('hours',p.hours)) v(unit,amount)
  ON CONFLICT(id,unit) DO UPDATE SET amount=excluded.amount RETURNING id
)
SELECT coalesce(max(id),0),count(*) FROM page;

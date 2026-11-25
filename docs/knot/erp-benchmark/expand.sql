CREATE TABLE knot_bench.line_key (
  id integer PRIMARY KEY, name text UNIQUE NOT NULL,
  company_id integer NOT NULL, account_id integer NOT NULL
);
CREATE TABLE knot_bench.line_unit (
  id integer NOT NULL REFERENCES knot_bench.line_key ON DELETE CASCADE,
  unit text NOT NULL CHECK(unit IN ('budget','hours')), amount numeric NOT NULL,
  PRIMARY KEY(id,unit)
);
CREATE VIEW knot_bench.normalized_lines AS
 SELECT k.id,k.name,k.company_id,k.account_id,b.amount AS budget,h.amount AS hours
 FROM knot_bench.line_key k
 LEFT JOIN knot_bench.line_unit b ON b.id=k.id AND b.unit='budget'
 LEFT JOIN knot_bench.line_unit h ON h.id=k.id AND h.unit='hours';
UPDATE knot_bench.control SET phase='dual' WHERE singleton;

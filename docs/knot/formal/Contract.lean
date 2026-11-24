import Knot.Proofs

open Knot

-- Fixed exact theorem statements for the row-policy program and transaction model.
variable (r : Row) (k : Rule) (rows : List Row) (v e : Nat)

example : (fails k).eval r = false ↔ Holds r k := rule_semantics r k
example : k ∈ violations r ↔ ¬ Holds r k := reasons_exact r k
example : rowAccepted r = true ↔ Permitted r := row_exact r
example (h : rowAccepted r = true) : rowResult r = afterPosting r := accepted_row r h
example (h : rowAccepted r = false) : rowResult r = before r := rejected_row r h
example (h : Permitted r) :
  (afterPosting r).budget + r.budgetOut = r.budget + r.budgetIn ∧
  (afterPosting r).hours + r.hoursOut = r.hours + r.hoursIn := accepted_effect r h
example (h : Permitted r) :
  max r.minBudget r.committedBudget ≤ (afterPosting r).budget ∧ (afterPosting r).budget ≤ r.maxBudget ∧
  max r.minHours r.committedHours ≤ (afterPosting r).hours ∧ (afterPosting r).hours ≤ r.maxHours := accepted_bounds r h
example : approved v e rows = true ↔ v = e ∧ Balanced rows ∧ ∀ row ∈ rows, Permitted row := batch_exact v e rows
example (h : approved v e rows = false) : post v e rows = ⟨v,rows.map before⟩ := rejected_batch v e rows h
example (h : approved v e rows = true) : post v e rows = ⟨v+1,rows.map afterPosting⟩ := accepted_batch v e rows h
example (h : v ≠ e) : post v e rows = ⟨v,rows.map before⟩ := stale_snapshot v e rows h
example : total Balance.budget (post v e rows).balances = total Row.budget rows ∧
  total Balance.hours (post v e rows).balances = total Row.hours rows := batch_conserves v e rows
example (reread : List Row) (ok : approved v e rows = true) :
  post (post v e rows).version e reread = ⟨v+1, reread.map before⟩ := consumed_revision v e rows reread ok

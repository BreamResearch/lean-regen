import Knot.Batch

namespace Knot

theorem rule_semantics (r : Row) (k : Rule) : (fails k).eval r = false ↔ Holds r k := by
  cases k <;> cases h : r.locked <;> cases c : r.closed <;>
    simp [fails, Test.eval, Numeric.eval, Field.read, Holds, h, c, Bool.toNat]

theorem reasons_exact (r : Row) (k : Rule) : k ∈ violations r ↔ ¬ Holds r k := by
  have present : k ∈ rules := by cases k <;> simp [rules]
  rw [← rule_semantics]; cases e : (fails k).eval r <;> simp [violations,present,e]

theorem row_exact (r : Row) : rowAccepted r = true ↔ Permitted r := by
  constructor
  · intro ok k
    have nil : violations r = [] := List.isEmpty_iff.mp ok
    rw [← rule_semantics]
    cases e : (fails k).eval r with
    | false => rfl
    | true =>
      have present : k ∈ rules := by cases k <;> simp [rules]
      have member : k ∈ violations r := by simp [violations,present,e]
      simp [nil] at member
  · intro permitted
    cases eq : violations r with
    | nil => simp [rowAccepted,eq]
    | cons k ks =>
      have member : k ∈ violations r := by simp [eq]
      exact False.elim ((reasons_exact r k).mp member (permitted k))

theorem accepted_row (r : Row) (h : rowAccepted r = true) : rowResult r = afterPosting r := by simp [rowResult,h]

theorem rejected_row (r : Row) (h : rowAccepted r = false) : rowResult r = before r := by simp [rowResult,h]

theorem accepted_effect (r : Row) (allowed : Permitted r) :
    (afterPosting r).budget + r.budgetOut = r.budget + r.budgetIn ∧
    (afterPosting r).hours + r.hoursOut = r.hours + r.hoursIn := by
  have hb := allowed .budgetFloor
  have hh := allowed .hoursFloor
  simp only [Holds] at hb hh
  exact ⟨Nat.sub_add_cancel (by omega),Nat.sub_add_cancel (by omega)⟩

theorem accepted_bounds (r : Row) (allowed : Permitted r) :
    max r.minBudget r.committedBudget ≤ (afterPosting r).budget ∧ (afterPosting r).budget ≤ r.maxBudget ∧
    max r.minHours r.committedHours ≤ (afterPosting r).hours ∧ (afterPosting r).hours ≤ r.maxHours := by
  have hb := allowed .budgetFloor
  have hh := allowed .hoursFloor
  have cb := allowed .budgetCeiling
  have ch := allowed .hoursCeiling
  have ⟨b,h⟩ := accepted_effect r allowed
  simp only [Holds] at hb hh cb ch
  exact ⟨by omega,by omega,by omega,by omega⟩

theorem batch_exact (v expected : Nat) (rows : List Row) : approved v expected rows = true ↔
    v = expected ∧ Balanced rows ∧ ∀ r ∈ rows, Permitted r := by
  simp [approved, row_exact, and_assoc]

theorem rejected_batch (v expected : Nat) (rows : List Row) (h : approved v expected rows = false) :
    post v expected rows = ⟨v,rows.map before⟩ := by simp [post,h]

theorem accepted_batch (v expected : Nat) (rows : List Row) (h : approved v expected rows = true) :
    post v expected rows = ⟨v+1,rows.map afterPosting⟩ := by simp [post,h]

theorem stale_snapshot (v expected : Nat) (rows : List Row) (h : v ≠ expected) :
    post v expected rows = ⟨v, rows.map before⟩ := by simp [post,approved,h]

private theorem sum_postings (rows : List Row) (valid : ∀ r ∈ rows, Permitted r) :
    total Balance.budget (rows.map afterPosting) + total Row.budgetOut rows = total Row.budget rows + total Row.budgetIn rows ∧
    total Balance.hours (rows.map afterPosting) + total Row.hoursOut rows = total Row.hours rows + total Row.hoursIn rows := by
  induction rows with
  | nil => simp [total]
  | cons r rs ih =>
    have ⟨b,h⟩ := accepted_effect r (valid r (by simp))
    have ⟨bs,hs⟩ := ih (fun x hx => valid x (by simp [hx]))
    simp only [List.map_cons,total]
    exact ⟨by omega,by omega⟩

private theorem original_totals (rows : List Row) :
    total Balance.budget (rows.map before) = total Row.budget rows ∧
    total Balance.hours (rows.map before) = total Row.hours rows := by
  induction rows with
  | nil => simp [total]
  | cons r rs ih => simp [total,before,ih.1,ih.2]

theorem batch_conserves (v expected : Nat) (rows : List Row) :
    total Balance.budget (post v expected rows).balances = total Row.budget rows ∧
    total Balance.hours (post v expected rows).balances = total Row.hours rows := by
  cases h : approved v expected rows with
  | false => rw [rejected_batch v expected rows h]; exact original_totals rows
  | true =>
    have ⟨_,balanced,valid⟩ := (batch_exact v expected rows).mp h
    have ⟨b,hours⟩ := sum_postings rows valid
    rw [accepted_batch v expected rows h]
    rw [balanced.1] at b
    rw [balanced.2] at hours
    exact ⟨Nat.add_right_cancel b,Nat.add_right_cancel hours⟩

theorem consumed_revision (v expected : Nat) (rows reread : List Row) (ok : approved v expected rows = true) :
    post (post v expected rows).version expected reread = ⟨v+1,reread.map before⟩ := by
  have equal := ((batch_exact v expected rows).mp ok).1
  rw [accepted_batch v expected rows ok]
  exact stale_snapshot (v+1) expected reread (by omega)

end Knot

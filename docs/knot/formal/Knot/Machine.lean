import Knot.Proofs

/-! Fixed-width specialization of Knot's checked account guard. -/
namespace Knot.Machine

/-- The twelve numeric fields are unsigned 32-bit amounts. Flags have exactly two values. -/
structure WordRow where
  budget : UInt32
  hours : UInt32
  budgetIn : UInt32
  hoursIn : UInt32
  budgetOut : UInt32
  hoursOut : UInt32
  minBudget : UInt32
  minHours : UInt32
  maxBudget : UInt32
  maxHours : UInt32
  committedBudget : UInt32
  committedHours : UInt32
  closed : Bool
  locked : Bool
  deriving Repr

def WordRow.toRow (w : WordRow) : Row :=
  ⟨w.budget.toNat, w.hours.toNat, w.budgetIn.toNat, w.hoursIn.toNat,
   w.budgetOut.toNat, w.hoursOut.toNat, w.minBudget.toNat, w.minHours.toNat,
   w.maxBudget.toNat, w.maxHours.toNat, w.committedBudget.toNat,
   w.committedHours.toNat, w.closed, w.locked⟩

@[inline] def wideSum (a b : UInt32) : UInt64 := a.toUInt64 + b.toUInt64

/-- Widening both operands first preserves the mathematical sum, including 2 × (2³²−1). -/
theorem wideSum_exact (a b : UInt32) : (wideSum a b).toNat = a.toNat + b.toNat := by
  have ha : a.toNat < 4294967296 := UInt32.toNat_lt_size a
  have hb : b.toNat < 4294967296 := UInt32.toNat_lt_size b
  simp only [wideSum, UInt64.toNat_add, UInt32.toNat_toUInt64]
  apply Nat.mod_eq_of_lt
  change a.toNat + b.toNat < 18446744073709551616
  omega

@[inline] private def larger (a b : UInt32) := if a ≤ b then b else a

private theorem larger_exact (a b : UInt32) : (larger a b).toNat = max a.toNat b.toNat := by
  by_cases h : a ≤ b
  · rw [larger, if_pos h, Nat.max_eq_right (UInt32.le_iff_toNat_le.mp h)]
  · have hb : b.toNat ≤ a.toNat := by
      have := mt UInt32.le_iff_toNat_le.mpr h
      omega
    rw [larger, if_neg h, Nat.max_eq_left hb]

@[inline] def failed (w : WordRow) : Rule → Bool
  | .closed => w.closed
  | .locked => w.locked && (decide (0 < w.budgetOut) || decide (0 < w.hoursOut))
  | .budgetFloor => decide (wideSum w.budget w.budgetIn < wideSum w.budgetOut (larger w.minBudget w.committedBudget))
  | .hoursFloor => decide (wideSum w.hours w.hoursIn < wideSum w.hoursOut (larger w.minHours w.committedHours))
  | .budgetCeiling => decide (wideSum w.budgetOut w.maxBudget < wideSum w.budget w.budgetIn)
  | .hoursCeiling => decide (wideSum w.hoursOut w.maxHours < wideSum w.hours w.hoursIn)

theorem failed_exact (w : WordRow) (k : Rule) : failed w k = (fails k).eval w.toRow := by
  cases k <;> cases hc : w.closed <;> cases hl : w.locked <;>
    simp [failed, fails, Test.eval, Numeric.eval, Field.read, WordRow.toRow, hc, hl, Bool.toNat,
      UInt32.lt_iff_toNat_lt, UInt64.lt_iff_toNat_lt, wideSum_exact, larger_exact]

@[inline] private def pack (c l bf hf bc hc : Bool) : UInt8 :=
  (if c then 1 else 0) ||| (if l then 2 else 0) |||
  (if bf then 4 else 0) ||| (if hf then 8 else 0) |||
  (if bc then 16 else 0) ||| (if hc then 32 else 0)

@[inline] def mask (w : WordRow) : UInt8 :=
  pack (failed w .closed) (failed w .locked) (failed w .budgetFloor)
       (failed w .hoursFloor) (failed w .budgetCeiling) (failed w .hoursCeiling)

def bit : Rule → UInt8
  | .closed => 1 | .locked => 2 | .budgetFloor => 4 | .hoursFloor => 8
  | .budgetCeiling => 16 | .hoursCeiling => 32

def decode (m : UInt8) : List Rule := rules.filter (fun k => (m &&& bit k) != 0)

private theorem packed_bit (c l bf hf bc hc : Bool) (k : Rule) :
    ((pack c l bf hf bc hc &&& bit k) != 0) =
    (match k with
     | .closed => c | .locked => l | .budgetFloor => bf | .hoursFloor => hf
     | .budgetCeiling => bc | .hoursCeiling => hc) := by
  cases c <;> cases l <;> cases bf <;> cases hf <;> cases bc <;> cases hc <;> cases k <;> rfl

theorem bit_exact (w : WordRow) (k : Rule) : ((mask w &&& bit k) != 0) = (fails k).eval w.toRow := by
  rw [mask, packed_bit, ← failed_exact]
  cases k <;> rfl

/-- This is list equality: all failures and their original public order are preserved. -/
theorem ordered_violations (w : WordRow) : decode (mask w) = violations w.toRow := by
  simp only [decode, violations, bit_exact]

private theorem packed_zero (c l bf hf bc hc : Bool) :
    pack c l bf hf bc hc = 0 ↔ (decode (pack c l bf hf bc hc)).isEmpty = true := by
  cases c <;> cases l <;> cases bf <;> cases hf <;> cases bc <;> cases hc <;> decide

theorem accepted_exact (w : WordRow) : mask w = 0 ↔ Permitted w.toRow := by
  have h : mask w = 0 ↔ (decode (mask w)).isEmpty = true := packed_zero ..
  rw [h, ordered_violations]
  exact row_exact _

theorem no_reserved_bits (w : WordRow) : mask w &&& 192 = 0 := by
  have h (c l bf hf bc hc : Bool) : pack c l bf hf bc hc &&& 192 = 0 := by
    cases c <;> cases l <;> cases bf <;> cases hf <;> cases bc <;> cases hc <;> rfl
  exact h ..

/-- Fixed-width scalar ABI. Callers encode false as 0 and true as 1. -/
@[export knot_word_mask]
def scalarMask (b h bi hi bo ho mb mh xb xh cb ch : UInt32) (closed locked : UInt8) : UInt8 :=
  mask ⟨b, h, bi, hi, bo, ho, mb, mh, xb, xh, cb, ch, closed != 0, locked != 0⟩

theorem scalar_ordered (b h bi hi bo ho mb mh xb xh cb ch : UInt32) (closed locked : UInt8) :
    decode (scalarMask b h bi hi bo ho mb mh xb xh cb ch closed locked) =
      violations (WordRow.toRow ⟨b, h, bi, hi, bo, ho, mb, mh, xb, xh, cb, ch,
        closed != 0, locked != 0⟩) :=
  ordered_violations _

end Knot.Machine

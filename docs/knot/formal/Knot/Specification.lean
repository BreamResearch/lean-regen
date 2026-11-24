import Std

namespace Knot

/-- One participating fiscal-period/work-pool account, after combining all movement lines for its key. -/
structure Row where
  budget : Nat
  hours : Nat
  budgetIn : Nat
  hoursIn : Nat
  budgetOut : Nat
  hoursOut : Nat
  minBudget : Nat
  minHours : Nat
  maxBudget : Nat
  maxHours : Nat
  committedBudget : Nat
  committedHours : Nat
  closed : Bool
  locked : Bool
  deriving Repr, DecidableEq

structure Balance where
  budget : Nat
  hours : Nat
  deriving Repr, DecidableEq

inductive Rule where
  | closed | locked | budgetFloor | hoursFloor | budgetCeiling | hoursCeiling
  deriving Repr, DecidableEq

/-- Independently stated obligations for one proposed account posting. -/
def Holds (r : Row) : Rule → Prop
  | .closed => r.closed = false
  | .locked => r.locked = false ∨ (r.budgetOut = 0 ∧ r.hoursOut = 0)
  | .budgetFloor => r.budgetOut + max r.minBudget r.committedBudget ≤ r.budget + r.budgetIn
  | .hoursFloor => r.hoursOut + max r.minHours r.committedHours ≤ r.hours + r.hoursIn
  | .budgetCeiling => r.budget + r.budgetIn ≤ r.budgetOut + r.maxBudget
  | .hoursCeiling => r.hours + r.hoursIn ≤ r.hoursOut + r.maxHours

def Permitted (r : Row) : Prop := ∀ k : Rule, Holds r k

def before (r : Row) : Balance := ⟨r.budget,r.hours⟩

def afterPosting (r : Row) : Balance := ⟨r.budget + r.budgetIn - r.budgetOut, r.hours + r.hoursIn - r.hoursOut⟩

end Knot

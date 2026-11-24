import Knot.Policy

namespace Knot

def total {α : Type} (f : α → Nat) : List α → Nat
  | [] => 0 | a :: rest => f a + total f rest

def Balanced (rows : List Row) : Prop := total Row.budgetIn rows = total Row.budgetOut rows ∧
  total Row.hoursIn rows = total Row.hoursOut rows

instance (rows : List Row) : Decidable (Balanced rows) := by unfold Balanced; infer_instance

/-- The portfolio revision identifies the snapshot joined to all of the participating accounts. -/
def approved (current expected : Nat) (rows : List Row) : Bool :=
  decide (current = expected) && decide (Balanced rows) && rows.all rowAccepted

structure Posting where
  version : Nat
  balances : List Balance
  deriving Repr, DecidableEq

def post (current expected : Nat) (rows : List Row) : Posting :=
  if approved current expected rows then ⟨current + 1, rows.map afterPosting⟩
  else ⟨current, rows.map before⟩

end Knot

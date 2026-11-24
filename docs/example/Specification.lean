/-
Specification baseline for an aggregate, single-resource inventory pool.
Freeze this file before implementation. No implementation imports belong here.
This example intentionally has no database, identity, reservation IDs, retries,
expiry, stock receipts, shipments, or network effects.
-/
import Std

namespace VerifiedInventory

structure State where
  available : Nat
  reserved : Nat
  deriving Repr, DecidableEq

inductive Result where
  | accepted (state : State)
  | rejected (state : State)
  deriving Repr, DecidableEq

inductive Command where
  | reserve (quantity : Nat)
  | release (quantity : Nat)
  deriving Repr, DecidableEq

def Result.state : Result → State
  | .accepted s => s
  | .rejected s => s

/-- Capacity is an external parameter, not a mutable state field. -/
def WellFormed (capacity : Nat) (s : State) : Prop :=
  s.available + s.reserved = capacity

def ReserveAllowed (s : State) (q : Nat) : Prop :=
  0 < q ∧ q ≤ s.available

def ReleaseAllowed (s : State) (q : Nat) : Prop :=
  0 < q ∧ q ≤ s.reserved

instance (s : State) (q : Nat) : Decidable (ReserveAllowed s q) :=
  inferInstanceAs (Decidable (0 < q ∧ q ≤ s.available))

instance (s : State) (q : Nat) : Decidable (ReleaseAllowed s q) :=
  inferInstanceAs (Decidable (0 < q ∧ q ≤ s.reserved))

/-- Exact observable contract, including justified rejection and no mutation. -/
def ReserveSpec (s : State) (q : Nat) : Result → Prop
  | .accepted s' =>
      ReserveAllowed s q ∧
      s'.available + q = s.available ∧
      s'.reserved = s.reserved + q
  | .rejected s' => ¬ ReserveAllowed s q ∧ s' = s

def ReleaseSpec (s : State) (q : Nat) : Result → Prop
  | .accepted s' =>
      ReleaseAllowed s q ∧
      s'.available = s.available + q ∧
      s'.reserved + q = s.reserved
  | .rejected s' => ¬ ReleaseAllowed s q ∧ s' = s

def StepSpec (s : State) (c : Command) (r : Result) : Prop :=
  match c with
  | .reserve q => ReserveSpec s q r
  | .release q => ReleaseSpec s q r

end VerifiedInventory

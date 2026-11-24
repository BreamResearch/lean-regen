/-
Frozen acceptance challenge. Keep with the approved specification, not in the
implementation producer's writable scope. Its hash must be externally pinned.
Each obligation applies a submitted theorem to the exact expected type.
Changing a theorem to an easier statement must not change this file.
-/
import VerifiedInventory.Proofs

open VerifiedInventory

example (capacity : Nat) :
    initial capacity = { available := capacity, reserved := 0 } :=
  initial_exact capacity

example (capacity : Nat) : WellFormed capacity (initial capacity) :=
  initial_wellFormed capacity

example (s : State) (q : Nat) : ReserveSpec s q (reserve s q) :=
  reserve_refines s q

example (s : State) (q : Nat) : ReleaseSpec s q (release s q) :=
  release_refines s q

example (s : State) (q : Nat) (h : ReserveAllowed s q) :
    reserve s q = .accepted
      { available := s.available - q, reserved := s.reserved + q } :=
  reserve_succeeds s q h

example (s : State) (q : Nat) (h : ReleaseAllowed s q) :
    release s q = .accepted
      { available := s.available + q, reserved := s.reserved - q } :=
  release_succeeds s q h

example (s : State) (q : Nat) (h : ¬ ReserveAllowed s q) :
    reserve s q = .rejected s :=
  reserve_rejects_unchanged s q h

example (s : State) (q : Nat) (h : ¬ ReleaseAllowed s q) :
    release s q = .rejected s :=
  release_rejects_unchanged s q h

example (capacity : Nat) (s : State) (q : Nat)
    (hs : WellFormed capacity s) :
    WellFormed capacity (reserve s q).state :=
  reserve_preserves capacity s q hs

example (capacity : Nat) (s : State) (q : Nat)
    (hs : WellFormed capacity s) :
    WellFormed capacity (release s q).state :=
  release_preserves capacity s q hs

example (s : State) (c : Command) : StepSpec s c (step s c) :=
  step_refines s c

example (capacity : Nat) (s : State) (c : Command)
    (hs : WellFormed capacity s) :
    WellFormed capacity (step s c).state :=
  step_preserves capacity s c hs

example (capacity : Nat) (cs : List Command) (s : State)
    (hs : WellFormed capacity s) :
    WellFormed capacity (run s cs) :=
  run_preserves capacity cs s hs

example (capacity : Nat) (cs : List Command) :
    WellFormed capacity (run (initial capacity) cs) :=
  all_runs_preserve capacity cs

import VerifiedInventory.Implementation

namespace VerifiedInventory

theorem initial_exact (capacity : Nat) :
    initial capacity = { available := capacity, reserved := 0 } := by
  rfl

theorem initial_wellFormed (capacity : Nat) :
    WellFormed capacity (initial capacity) := by
  simp [WellFormed, initial]

theorem reserve_refines (s : State) (q : Nat) :
    ReserveSpec s q (reserve s q) := by
  by_cases h : ReserveAllowed s q
  · simp [reserve, h, ReserveSpec, Nat.sub_add_cancel h.2]
  · simp [reserve, h, ReserveSpec]

theorem release_refines (s : State) (q : Nat) :
    ReleaseSpec s q (release s q) := by
  by_cases h : ReleaseAllowed s q
  · simp [release, h, ReleaseSpec, Nat.sub_add_cancel h.2]
  · simp [release, h, ReleaseSpec]

theorem reserve_succeeds (s : State) (q : Nat) (h : ReserveAllowed s q) :
    reserve s q = .accepted
      { available := s.available - q, reserved := s.reserved + q } := by
  simp [reserve, h]

theorem release_succeeds (s : State) (q : Nat) (h : ReleaseAllowed s q) :
    release s q = .accepted
      { available := s.available + q, reserved := s.reserved - q } := by
  simp [release, h]

theorem reserve_rejects_unchanged
    (s : State) (q : Nat) (h : ¬ ReserveAllowed s q) :
    reserve s q = .rejected s := by
  simp [reserve, h]

theorem release_rejects_unchanged
    (s : State) (q : Nat) (h : ¬ ReleaseAllowed s q) :
    release s q = .rejected s := by
  simp [release, h]

theorem reserve_preserves (capacity : Nat) (s : State) (q : Nat)
    (hs : WellFormed capacity s) :
    WellFormed capacity (reserve s q).state := by
  by_cases h : ReserveAllowed s q
  · simp only [reserve, if_pos h, Result.state, WellFormed]
    have hq := h.2
    dsimp [WellFormed] at hs
    omega
  · simpa only [reserve, if_neg h, Result.state] using hs

theorem release_preserves (capacity : Nat) (s : State) (q : Nat)
    (hs : WellFormed capacity s) :
    WellFormed capacity (release s q).state := by
  by_cases h : ReleaseAllowed s q
  · simp only [release, if_pos h, Result.state, WellFormed]
    have hq := h.2
    dsimp [WellFormed] at hs
    omega
  · simpa only [release, if_neg h, Result.state] using hs

theorem step_refines (s : State) (c : Command) :
    StepSpec s c (step s c) := by
  cases c with
  | reserve q => exact reserve_refines s q
  | release q => exact release_refines s q

theorem step_preserves (capacity : Nat) (s : State) (c : Command)
    (hs : WellFormed capacity s) :
    WellFormed capacity (step s c).state := by
  cases c with
  | reserve q => exact reserve_preserves capacity s q hs
  | release q => exact release_preserves capacity s q hs

theorem run_preserves (capacity : Nat) (cs : List Command) :
    ∀ s, WellFormed capacity s → WellFormed capacity (run s cs) := by
  induction cs with
  | nil =>
      intro s hs
      exact hs
  | cons c cs ih =>
      intro s hs
      exact ih (step s c).state (step_preserves capacity s c hs)

theorem all_runs_preserve (capacity : Nat) (cs : List Command) :
    WellFormed capacity (run (initial capacity) cs) := by
  exact run_preserves capacity cs (initial capacity) (initial_wellFormed capacity)

end VerifiedInventory

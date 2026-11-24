import Knot.Specification

namespace Knot

inductive Field where
  | budget | hours | budgetIn | hoursIn | budgetOut | hoursOut | minBudget | minHours
  | maxBudget | maxHours | committedBudget | committedHours | closed | locked
  deriving Repr, DecidableEq

def Field.read (r : Row) : Field → Nat
  | .budget => r.budget | .hours => r.hours | .budgetIn => r.budgetIn | .hoursIn => r.hoursIn
  | .budgetOut => r.budgetOut | .hoursOut => r.hoursOut | .minBudget => r.minBudget | .minHours => r.minHours
  | .maxBudget => r.maxBudget | .maxHours => r.maxHours | .committedBudget => r.committedBudget
  | .committedHours => r.committedHours | .closed => r.closed.toNat | .locked => r.locked.toNat

inductive Numeric where
  | f (name : Field) | n (literal : Nat) | add (left right : Numeric) | max (left right : Numeric)
  deriving Repr

inductive Test where
  | eq (a b : Numeric) | lt (a b : Numeric) | gt (a b : Numeric)
  | and (a b : Test) | or (a b : Test)
  deriving Repr

def Numeric.eval (r : Row) : Numeric → Nat
  | .f v => v.read r | .n value => value | .add a b => a.eval r + b.eval r | .max a b => Nat.max (a.eval r) (b.eval r)

def Test.eval (r : Row) : Test → Bool
  | .eq a b => decide (a.eval r = b.eval r) | .lt a b => decide (a.eval r < b.eval r)
  | .gt a b => decide (a.eval r > b.eval r) | .and a b => a.eval r && b.eval r | .or a b => a.eval r || b.eval r

open Numeric in
def fails : Rule → Test
  | .closed => .eq (f .closed) (n 1)
  | .locked => .and (.eq (f .locked) (n 1)) (.or (.gt (f .budgetOut) (n 0)) (.gt (f .hoursOut) (n 0)))
  | .budgetFloor => .lt (add (f .budget) (f .budgetIn)) (add (f .budgetOut) (max (f .minBudget) (f .committedBudget)))
  | .hoursFloor => .lt (add (f .hours) (f .hoursIn)) (add (f .hoursOut) (max (f .minHours) (f .committedHours)))
  | .budgetCeiling => .gt (add (f .budget) (f .budgetIn)) (add (f .budgetOut) (f .maxBudget))
  | .hoursCeiling => .gt (add (f .hours) (f .hoursIn)) (add (f .hoursOut) (f .maxHours))

def rules : List Rule := [.closed, .locked, .budgetFloor, .hoursFloor, .budgetCeiling, .hoursCeiling]

def violations (r : Row) := rules.filter (fun k => (fails k).eval r)
def rowAccepted (r : Row) := (violations r).isEmpty
def rowResult (r : Row) := if rowAccepted r then afterPosting r else before r

end Knot

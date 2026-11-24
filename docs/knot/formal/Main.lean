import Lean.Data.Json
import Knot

open Lean Knot

private def fieldName : Field → String
  | .budget => "budget" | .hours => "hours" | .budgetIn => "budgetIn" | .hoursIn => "hoursIn"
  | .budgetOut => "budgetOut" | .hoursOut => "hoursOut" | .minBudget => "minBudget" | .minHours => "minHours"
  | .maxBudget => "maxBudget" | .maxHours => "maxHours" | .committedBudget => "committedBudget"
  | .committedHours => "committedHours" | .closed => "closed" | .locked => "locked"

private def code : Rule → String
  | .closed => "closed" | .locked => "locked" | .budgetFloor => "budget-floor" | .hoursFloor => "hours-floor"
  | .budgetCeiling => "budget-ceiling" | .hoursCeiling => "hours-ceiling"

private def op (name : String) (a b : Json) := Json.arr #[toJson name,a,b]

private def scalarJson : Numeric → Json
  | .f field => toJson (fieldName field) | .n value => toJson value
  | .add a b => op "add" (scalarJson a) (scalarJson b) | .max a b => op "max" (scalarJson a) (scalarJson b)

private def testJson : Test → Json
  | .eq a b => op "eq" (scalarJson a) (scalarJson b) | .lt a b => op "lt" (scalarJson a) (scalarJson b)
  | .gt a b => op "gt" (scalarJson a) (scalarJson b) | .and a b => op "and" (testJson a) (testJson b)
  | .or a b => op "or" (testJson a) (testJson b)

private def policy := Json.mkObj [("version",toJson 1), ("rules",Json.arr (rules.toArray.map fun k =>
  Json.mkObj [("code",toJson (code k)), ("fail",testJson (fails k))]))]

private def parseRows : List Nat → Option (List Row)
  | [] => some []
  | b :: h :: bi :: hi :: bo :: ho :: mb :: mh :: xb :: xh :: cb :: ch :: closed :: locked :: rest => do
    if closed > 1 || locked > 1 then none else
      return ⟨b,h,bi,hi,bo,ho,mb,mh,xb,xh,cb,ch,closed==1,locked==1⟩ :: (← parseRows rest)
  | _ => none

private def balanceJson (b : Balance) := Json.mkObj [("budget",toJson b.budget),("hours",toJson b.hours)]

private def decisionJson (r : Row) := Json.mkObj [
  ("accepted",toJson (rowAccepted r)), ("reasons",toJson ((violations r).map code)),
  ("budget",toJson (rowResult r).budget), ("hours",toJson (rowResult r).hours)]

def main (args : List String) : IO UInt32 := do
  let inputError : IO UInt32 := do
    IO.eprintln "Use policy; row <14 natural fields>; or batch <current revision> <expected revision> <one or more 14-field rows>. Flags are 0 or 1."
    return 2
  match args with
  | ["policy"] => IO.println policy.compress
  | "row" :: fields =>
    let some values := fields.mapM String.toNat? | return ← inputError
    let some [r] := parseRows values | return ← inputError
    IO.println (decisionJson r).compress
  | "batch" :: current :: expected :: fields =>
    let some v := current.toNat? | return ← inputError
    let some e := expected.toNat? | return ← inputError
    let some values := fields.mapM String.toNat? | return ← inputError
    let some rows := parseRows values | return ← inputError
    if rows.isEmpty then return ← inputError
    let result := post v e rows
    IO.println (Json.mkObj [("accepted",toJson (approved v e rows)),("version",toJson result.version),
      ("balances",Json.arr (result.balances.toArray.map balanceJson))]).compress
  | _ => return ← inputError
  return 0

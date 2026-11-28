import Knot.Machine

open Knot Knot.Machine

/-- Each input line uses the public 14-field row order, with two canonical 0/1 flags. -/
private def parseLine (line : String) : Option WordRow := do
  let numbers ← ((line.split Char.isWhitespace).filter (· != "")).mapM String.toNat?
  let [b,h,bi,hi,bo,ho,mb,mh,xb,xh,cb,ch,c,l] := numbers | none
  guard ([b,h,bi,hi,bo,ho,mb,mh,xb,xh,cb,ch].all (· < 2^32))
  guard (c ≤ 1 && l ≤ 1)
  return ⟨b.toUInt32,h.toUInt32,bi.toUInt32,hi.toUInt32,bo.toUInt32,ho.toUInt32,
    mb.toUInt32,mh.toUInt32,xb.toUInt32,xh.toUInt32,cb.toUInt32,ch.toUInt32,c == 1,l == 1⟩

def main : IO UInt32 := do
  let input ← IO.getStdin
  let output ← IO.getStdout
  let mut number := 0
  repeat
    let line ← input.getLine
    if line.isEmpty then break
    number := number + 1
    let some w := parseLine line | do
      IO.eprintln s!"Invalid unsigned row or flag at line {number}"
      return 2
    let m := mask w
    if decode m != violations w.toRow || (m == 0) != rowAccepted w.toRow then
      IO.eprintln s!"Fixed-word and original row results disagree at line {number}"
      return 3
    output.putStrLn (toString m.toNat)
  return 0

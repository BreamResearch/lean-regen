import VerifiedInventory.Specification

namespace VerifiedInventory

def initial (capacity : Nat) : State :=
  { available := capacity, reserved := 0 }

def reserve (s : State) (q : Nat) : Result :=
  if ReserveAllowed s q then
    .accepted { available := s.available - q, reserved := s.reserved + q }
  else
    .rejected s

def release (s : State) (q : Nat) : Result :=
  if ReleaseAllowed s q then
    .accepted { available := s.available + q, reserved := s.reserved - q }
  else
    .rejected s

def step (s : State) : Command → Result
  | .reserve q => reserve s q
  | .release q => release s q

def run (s : State) : List Command → State
  | [] => s
  | c :: cs => run (step s c).state cs

end VerifiedInventory

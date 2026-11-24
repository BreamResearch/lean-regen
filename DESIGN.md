# Keeping a business contract across implementation changes

[日本語](DESIGN.ja.md) · [Run the examples](README.md)

A dependency upgrade can force a team to replace a core function. A coding agent can also propose replacing that function in a single change. In either case, users still depend on which requests succeed, what stays unchanged on rejection and how existing data survives the transition. Lean Regen records those commitments as a specification and acceptance examples. Each replacement brings its own implementation and proofs. Keeping the old source and its evidence makes it possible to reconstruct why a version was accepted.

Eight places are available and two are reserved. A customer asks for all eight. Accept the order and the balances become zero and ten. Reject it and they stay at eight and two. The total is ten either way. A nightly reconciliation could pass while the business quietly loses valid bookings.

The first question belongs with the person who sets booking policy. May a customer take the last available place? For this example, the answer is yes. Lean Regen builds on **Lean Verified SDLC**, an eight-stage method for turning requirements into a checked implementation and evidence a business owner can accept. The booking example shows how a single decision travels through that process. The next developer can replace the reservation algorithm and check whether the same customer can still place the same order.

## Give the business decision an observable result

The model has two natural numbers, `available` and `reserved`. A positive reservation up to and including the available quantity must succeed and move exactly that quantity between the balances. A request for zero or for more than is available must be rejected with both balances intact. A release moves stock in the other direction and is limited by the reserved quantity. A business that needs to cancel a particular customer's reservation would also need to model its identity and owner. [The inventory specification](docs/example/Specification.lean)

The theorem `reserve_succeeds` requires the actual reservation function to return an accepted result with the exact new balances for every allowed request. An implementation that refused every order could conserve stock forever. It would fail this requirement. The contract applies each submitted theorem to its expected type. Its 14 obligations include conservation across any finite sequence of operations. [The required theorem statements](docs/example/Contract.lean)

## What changes in a rewrite?

The reference design fixes nine inputs, including the specification, theorem statements, axiom audit and toolchain settings. Each candidate supplies its implementation and proofs. The original reservation function stores `s.reserved + q`. One replacement stores `q + s.reserved` and its proof uses the commutativity of addition to establish the same postcondition. [Original implementation](docs/example/Implementation.lean) · [Proofs for that implementation](docs/example/Proofs.lean)

| Candidate checked under the same contract | Outcome with Lean 4.19.0 |
| --- | --- |
| Original inventory functions | All 14 theorems checked |
| Reverse the operands of the addition and update the proof | The same 14 theorems checked |
| Change the reservation limit from “at most the available quantity” to “strictly less” | The proof build stops at the required success of an allowed request |

The verifier builds in a fresh directory and uses `#print axioms` to inspect the assumptions of each registered theorem. The report records the contract and source hashes, each theorem’s axioms and the outcomes of the checks. This gives a future maintainer a precise answer about which version met which obligations. A deliberate change in booking policy starts with revised examples and a new contract version.

**Run the comparison.** Extract the reference ZIP, make official Lean/Lake 4.19.0 available on your `PATH`, and use Python 3.11 or later and a working native linker. From the directory containing `compare.py`, run the command below with a fresh output path. On Apple Silicon with macOS 27, first apply the linker settings in the README. [Reference ZIP](https://github.com/BreamResearch/lean-regen/releases/download/reference-design-v0.1.0-alpha.2/lean-regen-reference.zip) · [Environment setup](README.md)

```sh
python3 compare.py --tool-bin "$(lean --print-prefix)/bin" --out ../comparison
```

Open `../comparison/equivalent/result.json` to inspect the rewrite's theorems and axioms. Open `../comparison/boundary-error/result_logs/build.log` to see where the exact-fill proof failed. To try your own implementation, copy the archive's `project/`, edit the implementation and proofs, and follow the archive README to check the copy against the original `contract-lock.json`.

## Try the rule against an existing application

An existing SQL booking system can expose enough information to check this rule without a rewrite. Export the operations for one pool in commit order. For each operation, record the requested quantity, the application's decision and the balances read back after commit. The trace checker compares these observations with results computed by Lean. All 16 operations from the supplied SQLite example matched. A deliberately faulty SQL condition produced a counterexample at operation four when the app rejected a request for the last eight units. [Trace checker and sample journal](https://github.com/BreamResearch/lean-regen/releases/tag/inventory-check-v0.1.0-alpha.2)

A matching journal covers the operations captured. A guarantee that retrying an order books only once would also need a request identity and evidence that the database adapter returns the recorded result on retry. If two callers can claim the last place concurrently, the team also needs evidence about transaction ordering and failure recovery. These questions tell you which behavior to model next and where to run an integration test.

## Eight stages for applying the design

| Stage | What a booking team can take to the next stage |
| --- | --- |
| Discover requirements | Concrete orders such as “reserve everything left” and “reserve zero”, with the results the business expects |
| Write the contract | Success and rejection conditions, exact state changes, and a theorem for each required property |
| Design the boundaries | A state model showing where the quantity calculation ends and identity, storage and transactions begin |
| Implement | A candidate implementation and proofs, plus a way to observe the existing application |
| Check the proofs | Recorded theorem types, axiom dependencies and the identity of the source checked |
| Integrate | Comparisons with actual decisions and committed balances, plus concurrency and recovery tests where relevant |
| Manage change | An account of which assumptions a dependency update affects and which checks must be rerun |
| Accept | The scenarios the business accepts, the version evaluated and the conditions under which it may be used |

**Start another domain.** The checker source ZIP contains the eight Lean Verified SDLC modules, editable worksheets and a project generator. Extract the ZIP, enter `lean-regen-conformance`, and run the command below. It creates a fresh sibling directory called `my-first-contract/`. [Download the source ZIP with the modules and worksheets](https://github.com/BreamResearch/lean-regen/releases/download/inventory-check-v0.1.0-alpha.2/lean-regen-conformance-source.zip)

```sh
python3 packages/lean-verified-sdlc/scripts/new_project.py --dest ../my-first-contract
```

For an expense approval workflow, fill in the generated files in this order.

1. In `worksheets/customer-intake.md`, define the requester, assigned approver and claim state. Establish with the business owner who may approve a claim.
2. In `worksheets/acceptance-scenarios.yaml`, give a successful example in which the assigned approver moves a submitted claim to approved. Add a rejection in which someone else attempts the same operation and the claim remains submitted.
3. In `worksheets/traceability.csv`, connect that requirement to the new authorization predicate, the approval function the application actually calls, its proof obligation and the scenario that exercises it. The stage-by-stage guides are under `packages/lean-verified-sdlc/references/` in the extracted source.

The first acceptance condition is concrete. The business owner confirms the actor, starting state, response and persisted state in each scenario, and the team ties a passing check for those conditions to the version being evaluated. The generated inventory project supplies the starting structure for the domain’s own states, contract, implementation and proofs.

## What happens on the next update?

The proposed update process gives the candidate author write access to the implementation and its proofs. A separate verifier checks those bytes against a contract, axiom policy and toolchain outside the author’s control. The publisher accepts only the artifact identified by a passing result. Under a policy agreed in advance, a routine update could then proceed without a new manual review. A failed proof holds the candidate back. The continued suitability of the old release depends on whether its own assumptions still hold.

# Orchestrate status

Generated: 2026-10-27T07:34:40.495Z

## Units

States: landed=6, ready=1

| ID | Track | State | Branch | PR | SHA | Brief |
| --- | --- | --- | --- | --- | --- | --- |
| u1-core | server | landed |  |  | a4706ac2596609fbd37f1b505ccde7eecc9a7f05 | briefs/u1-core.md |
| u2-private-presence | server | landed |  |  | 6f4e6adcf1de5fb7f717fcc8291131e5a41b9514 | briefs/u2-private-presence.md |
| u3-client-rest | server | landed |  |  | f5b89a305bbdbacc576a55f19d30832e95e766d1 | briefs/u3-client-rest.md |
| u4-selfhost | docs | landed |  |  | 873bc0c79a8020651b7ec3b2984df190470d9460 | briefs/u4-selfhost.md |
| u5-harden | server | landed |  |  | d9a3dbe | briefs/u5-harden.md |
| u6-cache | server | landed | unit/u6-cache |  | ea9b33c | briefs/u6-cache.md |
| u7-history-presence | server | ready |  |  |  | briefs/u7-history-presence.md |

## Verification ledger

Verdicts: unit-test-verified=6

| PR | SHA | Verdict | Evidence | Verifier | Timestamp |
| --- | --- | --- | --- | --- | --- |
| 0 | a4706ac2596609fbd37f1b505ccde7eecc9a7f05 | unit-test-verified | u1-core: scripts/compat.mjs 5/5 official pusher-js 8.6 and pusher 5.3; tests 12/12; check, typecheck, build, dry-run green | coordinator | 2026-10-27T06:20:00Z |
| 0 | 6f4e6adcf1de5fb7f717fcc8291131e5a41b9514 | unit-test-verified | u2-private-presence: compat 10/10; tests 26/26; gates green; presence vector corrected to 31935e7d | coordinator | 2026-10-27T06:20:00Z |
| 0 | f5b89a305bbdbacc576a55f19d30832e95e766d1 | unit-test-verified | u3-client-rest: compat 18/18; tests 66/66; gates green | coordinator | 2026-10-27T06:20:00Z |
| 0 | 873bc0c79a8020651b7ec3b2984df190470d9460 | unit-test-verified | u4-selfhost: README operator manual; DO new_sqlite_classes; nodejs_compat removed; compat 18/18; 66 tests; cf-typegen clean | coordinator | 2026-10-27T06:20:00Z |
| 0 | d9a3dbe | unit-test-verified | u5-harden: compat 28/28 incl raw 4001/4005/4007/4008/4009/4300/4301; tests 93/93; gates green | coordinator | 2026-10-27T06:20:00Z |
| 0 | ea9b33c | unit-test-verified | u6-cache: per-channel Channel DO; compat 34/34 with official pusher-js 8.6 and pusher 5.3; tests 110/110; check, typecheck, build, dry-run green; cache survives DO eviction | coordinator | 2026-10-27T07:34:25Z |

## Frontier

Generation: 0
Lowest unmerged: none

(none)

## Gates

(none)

<!-- orch-summary {"unitStates":{"landed":6,"ready":1},"ledgerVerdicts":{"unit-test-verified":6},"frontierGeneration":0,"openGateIds":[]} -->

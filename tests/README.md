# Verification

Run `node --test --test-concurrency=1 tests/*.test.mjs` and `node node_modules/typescript/bin/tsc --noEmit` from the checkout. Build with the Sites build workflow.

2026-10-10: 43 tests passed (original 36 D1 cases preserved, 5 membership/runtime integration cases, 2 draft-draw cases). TypeScript and Vinext Worker build passed. Tests use synthetic rounds in isolated local D1 with both migrations, never hosted data.

Coverage: anonymous cookies, storage persistence, 30 concurrent votes, account uniqueness across browsers, account-switch privacy, own records only, salts/versioned scrypt, workerd scrypt execution, session rotation/expiry, Origin/CSRF, request bounds, login throttling, exact database cutoff, malformed dates/offsets, DST/early-close draft calculations, immutable releases, private pre-close aggregates, exact decimals, revisions, team scoring and personal percentile/10-participation eligibility.

Draft calendar fixtures test arithmetic and validation; they do not verify actual exchange holidays. Operators must check the official calendar for each release. Hosted CPU limits, hosted migrations, production access controls and free usage availability remain deployment-time checks. No real rounds are enabled. No test accounts are shipped.

## Member privacy and self-service deletion verification (2026-10-09)

51 tests pass, including 8 new isolated Miniflare D1 deletion cases and deletion added to the real workerd scrypt integration flow. All original poll/draw/member cases remain. TypeScript and full lint pass (existing image/unused-import warnings only). No production users or real rounds were created for these tests. A deployable build and browser QA are separate parent-owned release checks.

Deletion coverage: authentication, same Origin and CSRF, same-request current-password check, strict boolean confirmation, cross-account targeting rejection, all-session revocation, account/private-history removal, independent anonymous vote keys with timestamps scrubbed, shared-browser/other-account preservation, unchanged per-choice counts and cumulative team scores, immutable result events, session revocation between password check and transaction, concurrent new-vote rollback and bounded retry, a fixed 9-statement batch across 60 records, unrecoverable history on same-name re-registration, and password-attempt throttling.

UI review also invalidates stale state/vote responses on authentication changes and checks account-instance identity before repainting personal records. Native modal dialogs provide labelled controls, Escape/Cancel dismissal, reset on close, scrollable mobile layout, an explicit deletion checkbox and password re-entry. Deployed browser checks must verify keyboard focus, mobile overflow, wrong-password/cancel/reopen and the completed deletion view; no local browser pass is claimed.

## Global leaderboard verification (2026-10-10)

93/93 Node tests pass, including 10 new isolated D1 leaderboard tests, all existing membership/deletion/release/price cases, TypeScript, full lint (four unchanged warnings, no errors), and the production Worker build. The append-only release preflight passes against 0bfe418de8fa09e5c040af605c27968e3db98447 with zero real rounds/results/opening prices. Migration 0003 is a generated additive index migration with complete Drizzle snapshot metadata.

New coverage includes exact decimal prices, exact equivalent-fraction ties and 64-bit extremes, competition ranks and existing midrank percentile, eligibility at 0/9/10 rounds, pending/flat/void/future/invalid results, corrections, deleted accounts, page clamping and invalid parameters, owner-rank lookup outside the viewed page, expired/foreign sessions, bounded public fields, and a 5,000-account/100,000-vote local scale fixture. An independent SQLite differential review passed 7,096 fraction cases, 1,000 decimal cases, and complete pages for 241 accounts. These are synthetic local fixtures, never production scores.

The command sandbox and dedicated cloud browser are separate machines with no supported local preview forwarding. Local browser interaction is therefore not claimed. Final UI checks are performed read-only on the published Site, without registering production test accounts or seeding scores; authenticated interaction is covered by isolated backend tests and source review. Authentication mutations immediately invalidate previous-account UI before any fallible reload.

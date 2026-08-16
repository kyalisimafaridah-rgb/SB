# Verified Logic Tests

These are REAL, executed tests against the exact shipping functions (copied
verbatim, not reimplemented) from this session's bug fixes. They run with
plain `tsx` — no project dependencies needed, since they only cover pure
logic (no database, no Express, no React rendering).

Run: `npx tsx verified-logic-tests/test_real_logic.ts` (or `tsx` if installed globally)

Last confirmed result: 35 passed, 0 failed.

## What this covers
- CSV formula-injection neutralization (client/src/lib/csv.ts)
- Uganda timezone date calculation (server/db.ts's todayInUganda) — includes
  a direct A/B proof against the old buggy method using a real instant where
  they disagree
- SMS segment counting (client/src/pages/BulkSMS.tsx) — same A/B proof
- Uganda phone number formatting (server/sms.ts)
- Payment allocation math (the split/overpayment logic from recordPayment)
- Subscription-blocked messaging (client/src/pages/SubscriptionBlocked.tsx)

## What this does NOT cover
Anything touching a real database, Express, tRPC, or React rendering — the
multi-tenant schoolId scoping, the payment/void rollback transaction logic,
the actual UI components. Those need `npm install` + `npm run check` +
`npm test` with real dependencies, which this sandbox cannot provide (no
network access — confirmed empirically, not assumed).

Consider adapting these into `server/*.test.ts` with vitest once you have
node_modules — this file is close to that shape already (same assertions,
different runner), but I didn't want to write vitest syntax I couldn't
actually run and verify myself.

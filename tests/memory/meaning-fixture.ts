/**
 * A hand-written code memory for meaning search (#51): 50 records about one fictional payments
 * service, as agents and imports would store them: decisions, observations, attempts, notes,
 * identifiers, file paths and error strings. Nothing here is real data.
 *
 * `key` names the records a test looks for; the rest are the workspace around them.
 */
export interface FixtureRecord {
  key?: string;
  kind: "decision" | "evidence" | "attempt" | "note" | "constraint" | "next_step" | "question" | "reference";
  title?: string;
  body: string;
}

export const PAYMENTS_SERVICE: FixtureRecord[] = [
  { key: "redis", kind: "decision", body: "We dropped Redis for the job queue; background jobs now live in a Postgres table polled with SKIP LOCKED." },
  { key: "sessions", kind: "decision", body: "Login cookies are SameSite=Lax and expire after 7 days; the refresh token rotates on every use." },
  { kind: "note", body: "The admin API paginates with opaque cursors; the page size is capped at 100." },
  { kind: "note", body: "Customer emails go through the notifications service with one template id per locale." },
  { key: "flaky", kind: "evidence", body: "test_refund_partial fails about one run in twenty on CI because two workers share the same sandbox account." },
  { key: "currency", kind: "decision", body: "Amounts are stored as integer minor units with an ISO 4217 code; never floats." },
  { kind: "decision", body: "Merchant webhook endpoints are retried for up to 3 days, then disabled until the merchant fixes them." },
  { key: "oncall", kind: "constraint", body: "Nobody deploys between Friday 16:00 and Monday 09:00 unless the incident commander approves it." },
  { kind: "decision", body: "Stripe webhooks are verified with the signing secret before the body is parsed." },
  { kind: "evidence", body: "POST /v1/charges returned 504 Gateway Timeout three times during the 14:00 load test." },
  { kind: "attempt", body: "Tried raising the gateway timeout to 30 s; the 504s stayed, so the timeout is not the cause." },
  { kind: "decision", body: "Every charge request carries an idempotency key derived from the order id and attempt number." },
  { kind: "note", body: "The retry loop in src/payments/retry.ts uses exponential backoff capped at 8 seconds with full jitter." },
  { key: "econnreset", kind: "evidence", body: "ECONNRESET from the ledger service appears when the connection pool exceeds 50 clients." },
  { kind: "decision", body: "The ledger is append-only: corrections are new entries that reverse the old ones." },
  { kind: "note", body: "createRefund() validates that the refund amount never exceeds the captured amount." },
  { kind: "reference", body: "Runbook for chargebacks: docs/runbooks/chargebacks.md, owned by the risk team." },
  { kind: "next_step", body: "Add a metric for webhook processing lag and alert when it passes five minutes." },
  { kind: "question", body: "Should partial captures release the remaining authorization immediately or at expiry?" },
  { kind: "evidence", body: "Fraud scores above 0.85 were blocked; 12 legitimate customers were blocked last week." },
  { kind: "decision", body: "Card numbers never touch our servers; the checkout page uses hosted fields." },
  { kind: "note", body: "PaymentIntent status transitions are mirrored in the payment_intents table by the webhook handler." },
  { kind: "attempt", body: "Moving the webhook handler to a separate deployment reduced checkout latency by 40 ms." },
  { kind: "evidence", body: "The nightly reconciliation job found 3 payouts missing from the ledger on 2026-09-12." },
  { kind: "decision", body: "Reconciliation runs at 02:00 UTC and compares payouts with ledger entries by payout id." },
  { kind: "note", body: "Feature flags live in config/flags.yaml and are read once at startup." },
  { kind: "constraint", body: "PCI scope: logs must never contain the full PAN or CVV, even in debug mode." },
  { kind: "evidence", body: "Error: duplicate key value violates unique constraint \"charges_idempotency_key_key\" during the retry storm." },
  { key: "advisory", kind: "decision", body: "Use PostgreSQL advisory locks to serialise payouts per merchant." },
  { kind: "note", body: "The merchant onboarding form validates the IBAN checksum before submission." },
  { kind: "attempt", body: "Batching ledger writes in groups of 100 cut reconciliation time from 40 to 9 minutes." },
  { kind: "evidence", body: "Apple Pay tokens fail validation when the merchant domain file is missing from /.well-known." },
  { kind: "decision", body: "Refunds over 10,000 EUR need a second approver in the admin console." },
  { kind: "note", body: "The currency converter caches exchange rates for 15 minutes in memory." },
  { kind: "next_step", body: "Write a migration that backfills merchant_id on old payout rows." },
  { kind: "evidence", body: "Disputes opened within 24 hours of capture are 3x more likely to be fraud." },
  { kind: "decision", body: "Settlement reports are generated as CSV and uploaded to the finance SFTP drop." },
  { kind: "note", body: "handleWebhookEvent() dispatches on event.type and ignores unknown types with a warning." },
  { kind: "attempt", body: "Switching the JSON parser to a streaming one did not change webhook latency." },
  { key: "loadtest", kind: "evidence", body: "Load test: 1,200 charges per minute sustained with p95 latency of 310 ms." },
  { kind: "decision", body: "API keys are hashed with SHA-256 and only the last four characters are shown." },
  { kind: "note", body: "src/payments/ledger.ts exports postEntry(), reverseEntry() and balanceOf()." },
  { kind: "constraint", body: "Payout files must reach the bank before 15:00 CET to settle the same day." },
  { key: "threeds", kind: "evidence", body: "3-D Secure challenges raised conversion drop-off from 4% to 11% on mobile." },
  { kind: "decision", body: "Exemptions for low-value transactions under 30 EUR are requested from the issuer." },
  { kind: "note", body: "The admin console shows merchant balances with a five-minute delay." },
  { kind: "next_step", body: "Split the payouts worker so that one stuck merchant cannot block the others." },
  { kind: "evidence", body: "TypeError: Cannot read properties of undefined (reading 'amount') in createRefund when the charge was voided." },
  { kind: "decision", body: "Voided charges cannot be refunded; the API returns 409 with code charge_voided." },
  { kind: "note", body: "Monthly invoices for merchants are rendered from Handlebars templates in templates/invoices/." },
];

# Design: real trading (NOT implemented)

Status: design only. The program cannot send broker orders: `server/util/http.js` blocks every non-GET request to Alpaca and all order and position endpoints, and a test covers it. Nothing here may be built before the prerequisites are met.

## Prerequisites (outside the code)
1. Written legal advice for each country of operation: licence, who gives the trading instruction, liability, customer agreement, complaints, record keeping.
2. Written permission from the broker for a hosted application acting for customers, and for showing market data to them.
3. Scholar review of the screening limits, settlement, order types and purification.
4. At least 90 days of paper results on live data, independent security test, tested backups and an on-call person.

## Principles
- The customer owns the broker account and authorises access there (OAuth). We never hold money, and ask only for trading rights, never transfers.
- The existing risk engine and Sharia gate decide. The AI only proposes.
- Paper stays the default. Real mode is switched on per account, with two-factor login, small limits, and an expiry.
- Anything unknown stops trading. The broker is the truth for orders and positions; we never guess.

## Components
| Part | Responsibility |
|---|---|
| `BrokerAdapter` | submit, cancel, get order, list orders, positions, account. One class per broker, no strategy |
| Order journal | written to PostgreSQL BEFORE sending: our ID, request, risk checks, approval |
| Reconciler | compares journal, broker orders and positions at start, after each reconnect and every minute |
| Kill switch | per customer and platform-wide: cancels open entries and blocks new ones; protective exits stay |

## Order life cycle
1. Proposal, Sharia gate, risk engine, then (default) the customer's approval with a short expiry.
2. Journal row `INTENT` with a unique client order ID.
3. Submit with that ID. Timeout or lost connection: state `UNKNOWN`; look the ID up at the broker before doing anything else. Never resend blindly.
4. Updates from the broker stream, confirmed by polling. Fills are recorded only from broker executions, in one transaction (`commitTrade`).
5. Stops and targets are placed at the broker as attached orders, so they work when our servers do not.

## Limits (hard, below the paper limits)
Maximum order value, daily value, daily loss, open positions, orders per minute; regular hours only; limit orders only; no margin, shorting, options or borrowing. Stale data, halt, reconciliation difference, storage fault or clock error: no entries.

## Sharia points for the scholar
Cash account only; settled funds and possession before resale; no interest on idle cash; handling of a stock that stops passing (alert, customer decides); purification amounts; crypto assets.

## Records
Append-only audit of every instruction, check, approval, request and answer. Exportable per customer.

## Stages
1. Adapter against the broker's paper environment, with fault injection: lost answers, duplicates, partial fills, out-of-order updates, outages.
2. Shadow mode: read-only broker access, compare what we would have done.
3. The operator's own account, minimal size, approval on every order.
4. Invited customers after legal sign-off. Full automation is a separate, later decision.

Exit criteria for every stage: no unexplained reconciliation difference, every injected fault ends in a safe state, kill switch tested.

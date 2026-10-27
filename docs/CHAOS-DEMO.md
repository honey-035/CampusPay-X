# CampusPay X — controlled chaos demo

All payment operations in this project are simulated. No bank or real payment gateway is contacted.

## Before the demo

1. Use a local copy only. Keep `.env` private and out of Git/ZIP submissions.
2. Configure `MONGODB_URI`, `DB_NAME=campuspayx`, `NODE_ENV=development`, and `ENABLE_CHAOS_CONTROLS=true` in your local `.env`.
3. Run `npm install`, `npm test`, then `npm start` (or start the app with PM2 as described in README).
4. Open `http://localhost:5000/` if `PORT=5000` is configured; otherwise use the port printed by the server.
5. Check `/api/health`, `/api/mock-gateway`, and `/api/circuit-breaker`.

## Demonstration order
### 1. Normal payment

- Submit one payment for ₹120.
- Expected: `SIMULATED_SUCCESS`, followed by `PAYMENT_VERIFIED`.
- Explain that the payment is a simulation only.

### 2. Lost response

- Click **Lost response** once.
- The mock gateway persists a valid outcome but deliberately drops the response.
- Expected: failure detection, lookup of the persisted outcome, transaction update to `SIMULATED_SUCCESS`, and `TRANSACTION_RECONCILED` + `RECOVERY_VERIFIED` events.
- The mock fault window automatically returns to NORMAL. No second payment should be created for recovery.

### 3. Invalid response

- Click **Invalid response** once.
- Expected: invalid response rejected; reconciliation checks the authoritative persisted outcome; original transaction is verified as `SIMULATED_SUCCESS`.
- Explain that the malformed response is never trusted directly.

### 4. Gateway outage and circuit breaker

- Click **Gateway outage** once. The resilience layer performs bounded retries with exponential backoff. The breaker should open after its configured threshold.
- The mock outage automatically ends after a short fault window. The recovery worker retries eligible pending transactions using the SAME idempotency key.
- After cooldown, a single half-open probe is allowed. A valid result closes the breaker. Confirm `/api/circuit-breaker` returns `CLOSED` and the original transaction becomes `SIMULATED_SUCCESS`.
- Do not submit repeated outage clicks; one click represents one logical payment. The internal retry loop supplies the failures needed to exercise the threshold.

### 5. Slow gateway

- Click **Slow gateway** once.
- Expected: the simulated response is delayed, then validated and persisted. The fault window automatically returns to NORMAL.

### 6. Process crash with PM2

Run from the project folder, with the application already managed by PM2:

```powershell
pm2 start ecosystem.config.js
pm2 status
pm2 logs campuspay-x --lines 50
```

Use the local development-only crash endpoint in a second PowerShell window:

```powershell
Invoke-WebRequest -Method POST -Uri "http://localhost:5000/api/dev/crash"
```

The request may end abruptly because the process intentionally exits. Watch PM2 restart it, then check `/api/health`, the `[STARTUP RECOVERY]` log, and the original pending transaction. A process restart alone is not proof of transaction recovery; verify the persisted status and recovery events.


## Known limits / honesty clause

- The gateway is a mock. This does not prove behavior against a real payment provider or a real network partition.
- Circuit-breaker state is in memory and resets when the Node.js process restarts. A distributed production deployment would need shared or intentionally per-instance breaker semantics.
- Transactions with no authoritative gateway outcome remain pending until a safe retry is possible. The system must never mark an unknown outcome successful just to clear the dashboard.
- The local crash endpoint and chaos controls must remain disabled in production.
- PM2 restarts the process; application startup recovery separately reconciles eligible transactions. Both steps must be shown in the evidence.

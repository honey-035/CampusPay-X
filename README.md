# CampusPay X — Self-Healing Campus Payment Simulator

> **Hackathon project | Resilience engineering | Node.js · Express · MongoDB · PM2**
>
> CampusPay X is a simulation-only campus payment workflow built to demonstrate how a software system can detect failures, preserve transaction safety, and recover automatically. It uses a mock gateway only: **no real bank, payment provider, or real money is involved.**

## Project at a glance

CampusPay X models a campus canteen payment where a gateway timeout or lost response must not cause a duplicate payment or an invented success. The application records transaction state and mock-gateway outcomes, classifies failures, and attempts reconciliation when an outcome can be safely verified.

| Area | What the project demonstrates |
|---|---|
| Payment safety | Input validation, transaction persistence, idempotency, and gateway-response validation |
| External-service resilience | Simulated slow responses, lost responses, invalid responses, and gateway unavailability |
| Recovery controls | Bounded retries, circuit breaker, reconciliation, and startup recovery |
| Process supervision | PM2 restarts the Node.js process after an unexpected exit |
| Observability | Persisted reliability events, incident records, transaction history, and benchmark results |
| Safety boundary | Simulation-only payment flow; no real payment processing |

## Contents

- [Architecture](#architecture)
- [Failure scenarios and recovery](#failure-scenarios-and-recovery)
- [Technology stack](#technology-stack)
- [Project structure](#project-structure)
- [Requirements](#requirements)
- [Local setup on Windows](#local-setup-on-windows)
- [Run with PM2](#run-with-pm2)
- [Run the controlled chaos demonstration](#run-the-controlled-chaos-demonstration)
- [API endpoints](#api-endpoints)
- [Benchmark snapshot](#benchmark-snapshot)
- [Evidence and submission documents](#evidence-and-submission-documents)
- [Honesty clause: limitations and unhealed cases](#honesty-clause-limitations-and-unhealed-cases)
- [Security and safe operation](#security-and-safe-operation)
- [Team and AI-use disclosure](#team-and-ai-use-disclosure)

## Architecture

```text
                         ┌──────────────────────────┐
                         │ Browser Control Center   │
                         │ Payment / Dashboard / Lab│
                         └────────────┬─────────────┘
                                      │ HTTP
                                      ▼
                         ┌──────────────────────────┐
                         │ Express payment API      │
                         │ Validation + idempotency│
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Resilience layer         │
                         │ Retry + circuit breaker  │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Simulated payment gateway│
                         │ Fault injection + outcomes│
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ MongoDB                  │
                         │ Transactions + mock      │
                         │ outcomes + incidents     │
                         │ + reliability events     │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │ Reconciliation / startup │
                         │ recovery worker          │
                         └──────────────────────────┘

              PM2 supervises the Node.js process and restarts it
              after an unexpected exit. Transaction recovery is
              a separate application-level responsibility.
```

### Recovery safety principle

A response being missing or malformed is not enough evidence to declare a payment failed or successful. CampusPay X attempts to reconcile the original transaction against the persisted authoritative outcome from its **simulated** gateway. If a safe authoritative outcome cannot be verified, the transaction must remain pending until a safe retry or lookup is possible; the application must not fabricate success.

PM2 process restart and transaction recovery are separate stages. A process returning to `online` does not by itself prove that the original transaction was recovered.

## Failure scenarios and recovery

| Scenario | Detection signal | Intended recovery behaviour | Evidence to capture |
|---|---|---|---|
| Slow gateway | Delayed response / slow-mode timeline | Wait for the simulated response, validate it, then finalize the original transaction | Injection mode, event timeline, and measured elapsed time |
| Lost response | Outcome becomes uncertain; failure classification identifies `GATEWAY_RESPONSE_LOST` | Reconcile the original transaction using the persisted mock outcome; avoid creating a second payment | `TRANSACTION_RECONCILED`, `RECOVERY_VERIFIED`, final status, duration |
| Invalid gateway response | Response validation fails / invalid-response classification | Reject malformed response data; reconcile only if an authoritative simulated outcome is available | Validation failure, reconciliation event, final status |
| Gateway unavailable | Failed attempts and circuit-breaker state | Bounded retries, breaker cooldown, half-open probe, and closure after a successful probe | Retry events, `OPEN` → half-open/probe → `CLOSED`, final transaction status |
| Node.js process crash | Process exits and PM2 detects the exit | PM2 restarts the process; startup recovery separately checks eligible pending transactions | Before/after PM2 status, restart count, health endpoint, same transaction ID, recovery event |

These are the failure modes the project is designed to demonstrate. A scenario should be reported as **passed only when the corresponding run's evidence verifies both the recovery action and the final outcome**. Do not treat a button click, an `online` process status, or an injection label alone as proof of self-healing.

## Technology stack

- **Runtime:** Node.js
- **HTTP server:** Express
- **Database:** MongoDB (Atlas or local MongoDB)
- **Gateway:** Local simulated payment gateway
- **Resilience patterns:** Bounded retry, circuit breaker, reconciliation, idempotency, startup recovery
- **Process supervisor:** PM2
- **Frontend:** HTML, CSS, and browser JavaScript
- **Testing:** Node.js built-in test runner
- **Development environment:** Windows PowerShell instructions are provided below

## Project structure

```text
CampusPay-X/
├── .env.example                 # Safe configuration template; no real secrets
├── .gitignore                   # Excludes local secrets and dependencies
├── README.md                    # Project overview and setup
├── package.json
├── package-lock.json
├── server.js                    # Express API and application orchestration
├── mockGateway.js               # Simulated gateway and controlled fault modes
├── gatewayResilience.js         # Resilience logic
├── ecosystem.config.js           # PM2 process configuration
├── public/
│   ├── index.html               # Main application page
│   ├── app.js
│   ├── style.css
│   ├── dashboard.html
│   ├── dashboard.js
│   ├── dashboard.css
│   ├── lab.html
│   ├── lab.js
│   ├── lab.css
│   ├── benchmark.html
│   ├── benchmark.js
│   └── benchmark.css
├── scripts/
│   └── test-pm2-crash.ps1       # Local-only deliberate crash/recovery test
├── tests/
│   └── gatewayResilience.test.js
└── docs/
    ├── CHAOS-DEMO.md            # Reproducible demo instructions
    ├── Resilience_Report.pdf    # Submission report
    ├── Resilience_Report.docx   # Editable report source
    ├── AI_Use_Declaration.pdf   # AI-use disclosure
    └── evidence/                # Screenshots from recorded test runs
```

`node_modules/` and `.env` are intentionally not part of the GitHub repository. Install dependencies from `package-lock.json` and create a private local `.env` from `.env.example`.

## Requirements

- Node.js 18 or newer (use a supported LTS release where possible)
- npm (bundled with Node.js)
- MongoDB Atlas or a local MongoDB instance
- PM2, included in the project dependencies

Check your installation:

```powershell
node --version
npm --version
```

## Local setup on Windows

Run these commands from the project root — the folder containing `server.js` and `package.json`.

### 1. Create a private environment file

Copy the example file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Configure the values locally. Example shape:

```dotenv
PORT=5000
MONGODB_URI=your_private_mongodb_connection_string
DB_NAME=campuspayx
NODE_ENV=development
ENABLE_CHAOS_CONTROLS=true
```

Replace the MongoDB placeholder with your own private connection string. Never put a working connection string in this README, screenshots, GitHub, or a public issue. Keep chaos controls enabled only for a local development demo.

### 2. Install dependencies and run tests

```powershell
npm install
npm test
```

Optional syntax checks:

```powershell
node --check server.js
node --check gatewayResilience.js
node --check mockGateway.js
node --check public/app.js
```

### 3. Start the application

For ordinary local development:

```powershell
npm start
```

Open:

- Application: `http://localhost:5000/`
- Health: `http://localhost:5000/api/health`

Use the port configured in `.env` if it differs from `5000`. Do not run `npm start` at the same time as PM2 on the same port.

## Run with PM2

PM2 is required for the process-crash demonstration.

### First run (process not registered)

```powershell
pm2 start ecosystem.config.js
pm2 status
pm2 logs campuspay-x --lines 50
```

### Later runs (process already registered)

```powershell
pm2 restart campuspay-x --update-env
pm2 status
```

Confirm that `campuspay-x` is `online`, then check the API:

```powershell
Invoke-RestMethod http://localhost:5000/api/health
Invoke-RestMethod http://localhost:5000/api/mock-gateway
Invoke-RestMethod http://localhost:5000/api/circuit-breaker
```

Useful commands:

```powershell
pm2 status
pm2 describe campuspay-x
pm2 logs campuspay-x --lines 100
pm2 restart campuspay-x
pm2 stop campuspay-x
```

The health endpoint should report a healthy application and a connected database. The precise response fields may depend on the current implementation/configuration.

## Run the controlled chaos demonstration

**Local development only. Never run destructive chaos controls against a production service.** Make sure `.env` is private, the database is the intended test database, and no real payment integration is configured.

Recommended demo order:

1. **Normal payment:** Submit a Canteen payment for ₹120. Confirm `SIMULATED_SUCCESS`, record the transaction ID, refresh the page, and verify persistence.
2. **Slow gateway:** Trigger the slow-gateway mode once. Capture the mode and request timeline; report elapsed time only if measured.
3. **Lost response:** Trigger one lost-response test. Follow the uncertain outcome through reconciliation and verify that the **same transaction** reaches its final state.
4. **Invalid response:** Trigger one invalid-response test. Confirm malformed data is rejected and the application uses an authoritative persisted outcome for recovery, if available.
5. **Gateway outage:** Trigger one outage test. Observe retry attempts and circuit-breaker state. Confirm a successful probe before claiming the breaker has recovered. Changing the mock mode to `NORMAL` does not necessarily reset the breaker immediately.
6. **PM2 crash recovery:** Start the application under PM2 and use the dedicated local test script. Verify the process restart **and** recovery of the original transaction.

For each run, record the date/time, scenario, transaction ID, initial state, detected failure, recovery action, final state, and measured duration. Avoid repeated outage clicks: one click should represent one logical payment while the resilience layer supplies the internal retries.

### PM2 crash-recovery verification

With `campuspay-x` already managed by PM2, open a second PowerShell window in the project root and run:

```powershell
.\scripts\test-pm2-crash.ps1
```

The test intentionally crashes the local Node.js process. It should only be considered a pass if the test confirms that PM2 brought the service back and the original prepared transaction was recovered and verified. Capture the script output, `pm2 status` (including restart count), health response, and transaction-specific recovery event. Do not run it against production.

If PowerShell blocks the local script because of execution policy, do not permanently weaken the machine's policy. Follow your institution/organization's rules; if permitted, use a session-only policy adjustment and close that PowerShell session afterward.

## API endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Application and database health |
| `GET /api/payments` | Recent payment transactions |
| `GET /api/mock-gateway` | Current mock gateway mode |
| `GET /api/circuit-breaker` | Breaker state, cooldown, and probe details |
| `GET /api/reliability/events?limit=80&transactionId=CPX-...` | Reliability events for a transaction |
| `GET /api/incidents` | Incident records |
| `GET /api/reliability/summary` | Recorded reliability counts and recovery-duration summaries |
| `POST /api/recovery/run` | Local recovery/diagnostic scan |
| `POST /api/dev/prepare-crash-recovery` | Prepare the deterministic local crash test |
| `POST /api/dev/crash` | Deliberately crash the local Node.js process |

Development/chaos endpoints must remain unavailable in production. The implementation is intended for a local simulation demo; review and enforce environment and loopback restrictions before any deployment.

## Benchmark snapshot

The supplied benchmark snapshot records a `LOST_RESPONSE` run with sample size **3**, created at `2026-10-26T17:49:31.744Z` (26 October 2026, 23:19:31.744 IST).

| Measure | Baseline at measurement | Self-healing cohort |
|---|---:|---:|
| Transactions attempted | 3 | 3 |
| Recovered at measurement | 0/3 (0%) | 3/3 (100%) |
| Pending at measurement | 3 | 0 |
| Cohort elapsed time | 778 ms | 1,603 ms |
| Per-transaction recovery durations | Not recovered at measurement | 228, 228, 227 ms |
| Mean per-transaction recovery duration | Not applicable | ≈227.7 ms |

**Interpretation:** At the recorded measurement point, immediate reconciliation changed the observed recovery rate from 0% to 100% and the pending count from 3 to 0. The mean of the three recorded self-healing durations is approximately 227.7 ms.

**Qualification:** This is a small, point-in-time experiment. The baseline cohort was measured before immediate reconciliation, and periodic recovery may subsequently heal those transactions. It does not establish that baseline transactions can never recover, nor does it guarantee production latency. Use the transaction-specific event records and benchmark run ID in the report when presenting this result.

## Evidence and submission documents

The `docs/` directory contains:

- `CHAOS-DEMO.md` — demonstration procedure and expected observations.
- `Resilience_Report.pdf` — resilience report for reviewers.
- `Resilience_Report.docx` — editable report source.
- `AI_Use_Declaration.pdf` — disclosure of AI assistance.
- `evidence/` — screenshots for normal payment and failure/recovery scenarios.

Screenshots are supporting evidence, not a substitute for test logs. Keep the file names aligned with what each image actually shows. For a PM2 crash claim, use evidence showing the process crash/restart and original transaction recovery—not a gateway outage screenshot. Do not invent missing durations; label them “not measured” when no exact metric was recorded.

## limitations and unhealed cases

CampusPay X is a controlled educational simulation, not a production payment system. The following limitations must be disclosed in the report and demo:

1. **Simulated gateway only:** no real payment provider, bank, or real network partition was exercised.
2. **Unknown outcome stays pending:** when no authoritative outcome can be verified, the safe result is pending until a safe lookup or retry is available. The application must not fabricate success.
3. **In-memory circuit breaker:** breaker state resets when the Node.js process restarts. A multi-instance production design would need an explicit shared or per-instance breaker strategy.
4. **Recovery is conditional:** recovery depends on an authoritative persisted simulated outcome or a safe future retry. Not every failure is guaranteed to heal immediately.
5. **PM2 is not transaction recovery:** PM2 restarts the process; application startup recovery separately reconciles eligible transactions.
6. **Benchmark scope:** the supplied benchmark has only three transactions and is a point-in-time comparison, not a production service-level guarantee.
7. **Evidence gaps:** do not report a recovery duration for a scenario unless the duration was recorded. If a test did not recover, say so and identify the unresolved state.

## Honesty clause

CampusPay X can detect gateway-related failures and use recovery mechanisms such as retries and circuit-breaker protection. However, if the simulated gateway remains unavailable beyond the configured retry and recovery limits, the system cannot restore the gateway itself. The circuit breaker can stop repeated failing requests, but it cannot make the unavailable service respond.

In this situation, a transaction may remain in a PENDING state until the gateway becomes available and its outcome can be safely reconciled. The system must not assume that a timeout means payment failure or mark an uncertain transaction as successful without verification.

Why it cannot fully heal this failure yet: The application controls its own retry and recovery logic, but it cannot guarantee the availability of an external dependency. If no reliable gateway response or reconciliation result is available, automatic recovery has reached its limit.

Planned improvement: Improve half-open circuit-breaker probing, retry scheduling, pending-transaction reconciliation, and incident escalation so the system can resume safely when the gateway recovers and clearly report cases requiring further investigation.

We acknowledge that self-healing has limits. Our verified PM2 crash-recovery test demonstrates recovery from a process crash, but it does not prove that every gateway failure can be healed automatically. We report this limitation transparently rather than claiming complete recovery in every situation.

## Security and safe operation

- Never commit `.env`, database credentials, tokens, or raw database exports.
- Keep `.env.example` limited to placeholder values.
- Keep `node_modules/` out of Git; use `npm install` to reproduce dependencies.
- Keep chaos controls and deliberate-crash endpoints restricted to local development.
- Use a dedicated test database for demonstrations.
- Do not claim that a screenshot proves more than the visible evidence supports.
- If a real credential was exposed in a public repository or shared archive, rotate it immediately.

## Team and AI-use disclosure

**Team:** Honey Sadnani and Krishna Dhalwal  
**Institution:** Dezyne École College  

AI assistance was used for coding/debugging support and project documentation. Refer to `docs/AI_Use_Declaration.pdf` for the formal declaration and ensure it matches the final submitted work and the hackathon's disclosure requirements.

---

**CampusPay X — simulate the failure, observe the system, verify the recovery.**

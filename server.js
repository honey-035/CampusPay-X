const mockGateway = require("./mockGateway");
const gatewayResilience = require("./gatewayResilience");
let gatewayOutcomes;
let incidents;
let reliabilityEvents;
let benchmarkRuns;
let recoveryRunning = false;
let benchmarkRunning = false;
let gatewayRestoreTimer = null;
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = new MongoClient(process.env.MONGODB_URI || "", {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true
  },
  serverSelectionTimeoutMS: 5000
});

let transactions;
let db;


const processingKeys = new Set();

function demoControlsEnabled() {
  return process.env.NODE_ENV !== "production" && process.env.ENABLE_CHAOS_CONTROLS === "true";
}

function isLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || req.ip || "").toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function demoControlsAllowed(req) {
  return demoControlsEnabled() && isLocalRequest(req);
}

function publicTransaction(tx) {
  return {
    transactionId: tx.transactionId,
    idempotencyKey: tx.idempotencyKey,
    studentName: tx.studentName,
    purpose: tx.purpose,
    amount: tx.amount,
    status: tx.status,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt
  };
}


async function recordReliabilityEvent({
  transactionId = null,
  incidentId = null,
  stage,
  eventType,
  message,
  metadata = {}
}) {
  if (!reliabilityEvents) return;

  try {
    await reliabilityEvents.insertOne({
      eventId: crypto.randomUUID(),
      correlationId: transactionId || incidentId || crypto.randomUUID(),
      transactionId,
      incidentId,
      stage,
      eventType,
      message,
      metadata,
      timestamp: new Date()
    });
  } catch (error) {
    console.error("Reliability event write failed:", error.message);
  }
}

app.get("/api/dev/status", (req, res) => {
  res.json({ controlsEnabled: demoControlsAllowed(req), simulationOnly: true });
});

app.get("/api/health", async (req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({
      status: "healthy",
      database: "connected",
      mode: "SIMULATION_ONLY",
      uptimeSeconds: Math.floor(process.uptime()),
      recoveryWorker: recoveryRunning ? "BUSY" : "IDLE",
      processSupervisor: process.env.PM2_HOME ? "PM2_ENV_DETECTED" : "EXTERNAL_OR_UNKNOWN"
    });
  } catch {
    res.status(503).json({
      status: "degraded",
      database: "unavailable",
      mode: "SIMULATION_ONLY"
    });
  }
});

app.post("/api/payments", async (req, res) => {
  const { studentName, purpose, amount, idempotencyKey } = req.body || {};

  if (
    typeof studentName !== "string" ||
    studentName.trim().length < 2 ||
    studentName.trim().length > 80
  ) {
    return res.status(400).json({
      error: "Enter a name between 2 and 80 characters."
    });
  }

  if (!["Canteen", "College Fee", "Library Fee"].includes(purpose)) {
    return res.status(400).json({ error: "Invalid payment purpose." });
  }

  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 100000
  ) {
    return res.status(400).json({
      error: "Amount must be greater than zero and at most ₹100,000."
    });
  }

  if (
    typeof idempotencyKey !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(idempotencyKey)
  ) {
    return res.status(400).json({
      error: "A valid idempotency key is required."
    });
  }


  const existing = await transactions.findOne({ idempotencyKey });

  if (existing) {
    return res.status(200).json({
      message: "Existing transaction returned; no new transaction created.",
      transaction: publicTransaction(existing),
      duplicateRequest: true
    });
  }

  if (processingKeys.has(idempotencyKey)) {
    return res.status(202).json({
      message: "This transaction is still being processed."
    });
  }

  processingKeys.add(idempotencyKey);

  try {
    const now = new Date();
    const transaction = {
      transactionId: `CPX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      idempotencyKey,
      studentName: studentName.trim(),
      purpose,
      amount: Math.round(amount * 100) / 100,
      status: "PENDING",
      lastError: "PAYMENT_IN_PROGRESS",
      createdAt: now,
      updatedAt: now
    };


    try {
      await transactions.insertOne(transaction);
    } catch (error) {
      if (error.code === 11000) {
        const duplicate = await transactions.findOne({ idempotencyKey });
        return res.status(200).json({
          message: "Existing transaction returned.",
          transaction: publicTransaction(duplicate),
          duplicateRequest: true
        });
      }
      throw error;
    }


await recordReliabilityEvent({
  transactionId: transaction.transactionId,
  stage: "DETECTED",
  eventType: "TRANSACTION_CREATED",
  message: "A simulated payment transaction was created.",
  metadata: { amount: transaction.amount, purpose: transaction.purpose }
});
await recordReliabilityEvent({
  transactionId: transaction.transactionId,
  stage: "RECOVERING",
  eventType: "GATEWAY_REQUEST_STARTED",
  message: "Payment request handed to the resilience layer.",
  metadata: { gatewayMode: mockGateway.getMode() }
});

try {
  const gatewayResult = await gatewayResilience.processPayment({
    idempotencyKey,
    transactionId: transaction.transactionId,
    amount: Number(amount)
  });

  const validResponse =
    gatewayResult &&
    gatewayResult.transactionId === transaction.transactionId &&
    gatewayResult.idempotencyKey === idempotencyKey &&
    gatewayResult.status === "SIMULATED_SUCCESS" &&
    Number(gatewayResult.amount) === Number(amount);

  if (!validResponse) {
    await transactions.updateOne(
      { idempotencyKey, status: "PENDING" },
      {
        $set: {
          updatedAt: new Date(),
          lastError: "INVALID_GATEWAY_RESPONSE",
          failureDetectedAt: new Date()
        }
      }
    );

    await recordReliabilityEvent({
      transactionId: transaction.transactionId,
      stage: "DETECTED",
      eventType: "INVALID_GATEWAY_RESPONSE",
      message: "The gateway response did not match the expected transaction details.",
      metadata: { reason: "INVALID_GATEWAY_RESPONSE" }
    });
    await recordReliabilityEvent({
      transactionId: transaction.transactionId,
      stage: "DIAGNOSING",
      eventType: "RESPONSE_VALIDATION_FAILED",
      message: "Response validation failed; the system will not trust this response.",
      metadata: { safeState: "PENDING" }
    });
    await recordReliabilityEvent({
      transactionId: transaction.transactionId,
      stage: "RECOVERING",
      eventType: "RECONCILIATION_SCHEDULED",
      message: "Transaction left pending for authoritative outcome reconciliation."
    });

    return res.status(202).json({
      message: "Gateway response was invalid. Transaction remains pending verification.",
      transaction: publicTransaction(
        await transactions.findOne({ idempotencyKey })
      ),
      recoveryRequired: true,
      simulationOnly: true
    });
  }

  const updated = await transactions.findOneAndUpdate(
    { idempotencyKey, status: "PENDING" },
    {
      $set: {
        status: "SIMULATED_SUCCESS",
        updatedAt: new Date()
      },
      $unset: {
        lastError: ""
      }
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    return res.status(202).json({
      message: "Transaction state needs verification.",
      transaction: publicTransaction(
        await transactions.findOne({ idempotencyKey })
      ),
      recoveryRequired: true,
      simulationOnly: true
    });
  }

  await recordReliabilityEvent({
    transactionId: transaction.transactionId,
    stage: "VERIFIED",
    eventType: "PAYMENT_VERIFIED",
    message: "Gateway response passed validation and the transaction was saved as successful.",
    metadata: { status: "SIMULATED_SUCCESS" }
  });

  return res.json({
    message: "Simulated payment completed. No real money was involved.",
    transaction: publicTransaction(updated),
    simulationOnly: true
  });
} catch (error) {
  const reason =
  error.code === "GATEWAY_UNAVAILABLE"
    ? "GATEWAY_UNAVAILABLE"
    : error.code === "GATEWAY_RESPONSE_LOST"
      ? "GATEWAY_RESPONSE_LOST"
      : error.code === "GATEWAY_CIRCUIT_OPEN"
        ? "GATEWAY_CIRCUIT_OPEN"
        : "GATEWAY_ERROR";

  await transactions.updateOne(
    { idempotencyKey, status: "PENDING" },
    {
      $set: {
        updatedAt: new Date(),
        lastError: reason,
        failureDetectedAt: new Date()
      }
    }
  );

  const pendingTransaction = await transactions.findOne({
    idempotencyKey
  });

  const wasBlockedBeforeGateway = reason === "GATEWAY_CIRCUIT_OPEN";
  const wasUnavailable = reason === "GATEWAY_UNAVAILABLE";
  await recordReliabilityEvent({
    transactionId: transaction.transactionId,
    stage: "DETECTED",
    eventType: wasBlockedBeforeGateway
      ? "GATEWAY_REQUEST_DEFERRED"
      : wasUnavailable
        ? "GATEWAY_UNAVAILABLE"
        : "PAYMENT_OUTCOME_UNCERTAIN",
    message: wasBlockedBeforeGateway
      ? "The open circuit breaker stopped this request before it reached the mock gateway."
      : wasUnavailable
        ? "The mock gateway was unavailable; no authoritative outcome was returned."
        : "The gateway operation did not produce a safely verifiable response.",
    metadata: { reason }
  });
  await recordReliabilityEvent({
    transactionId: transaction.transactionId,
    stage: "DIAGNOSING",
    eventType: "FAILURE_CLASSIFIED",
    message: `Failure classified as ${reason}.`,
    metadata: { reason, gatewayMode: mockGateway.getMode() }
  });
  await recordReliabilityEvent({
    transactionId: transaction.transactionId,
    stage: "RECOVERING",
    eventType: wasBlockedBeforeGateway || wasUnavailable
      ? "AUTOMATIC_RETRY_SCHEDULED"
      : "RECONCILIATION_REQUIRED",
    message: wasBlockedBeforeGateway || wasUnavailable
      ? "The transaction remains pending and will be retried with the same idempotency key after the gateway is healthy and the breaker permits it."
      : "Transaction remains pending until its authoritative outcome is verified."
  });

  return res.status(202).json({
    message: "The payment outcome needs verification. Do not submit a new payment.",
    transaction: publicTransaction(pendingTransaction),
    recoveryRequired: true,
    reason,
    simulationOnly: true
  });
}


    

  } catch (error) {
    console.error("Payment creation failed:", error.message);
    return res.status(500).json({
      error: "Unable to complete the simulation. Check server logs."
    });
  } finally {
    processingKeys.delete(idempotencyKey);
  }
});



app.post("/api/recovery/run", async (req, res) => {
  if (!demoControlsAllowed(req)) return res.status(403).json({ error: "Manual recovery controls are disabled. Enable local demo controls in development only." });
  try {
    const result = await runRecoveryOnce();
    res.json(result);
  } catch (error) {
    console.error("Manual recovery failed:", error.message);
    res.status(500).json({
      error: "Recovery scan failed"
    });
  }
});

app.get("/api/incidents", async (req, res) => {
  try {
    const records = await incidents
      .find({})
      .sort({ detectedAt: -1 })
      .limit(50)
      .toArray();

    res.json(records);
  } catch (error) {
    console.error("Incident lookup failed:", error.message);
    res.status(500).json({
      error: "Could not retrieve incidents"
    });
  }
});


app.get("/api/reliability/events", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const filter = {};
    if (typeof req.query.transactionId === "string" && req.query.transactionId.trim()) {
      filter.transactionId = req.query.transactionId.trim();
    }
    if (typeof req.query.incidentId === "string" && req.query.incidentId.trim()) {
      filter.incidentId = req.query.incidentId.trim();
    }
    if (typeof req.query.correlationId === "string" && req.query.correlationId.trim()) {
      filter.correlationId = req.query.correlationId.trim();
    }

    const events = await reliabilityEvents
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    res.json(events);
  } catch (error) {
    console.error("Reliability event lookup failed:", error.message);
    res.status(500).json({ error: "Could not retrieve reliability events." });
  }
});

app.get("/api/reliability/summary", async (req, res) => {
  try {
    const [total, successful, pending, incidentRecords, eventRecords] = await Promise.all([
      transactions.countDocuments({}),
      transactions.countDocuments({ status: "SIMULATED_SUCCESS" }),
      transactions.countDocuments({ status: "PENDING" }),
      incidents.find({}).sort({ detectedAt: -1 }).limit(500).toArray(),
      reliabilityEvents.find({}).sort({ timestamp: -1 }).limit(1000).toArray()
    ]);
    const recoveredIncidents = incidentRecords.filter(item => item.status === "RECOVERED");
    const durations = recoveredIncidents.map(item => Number(item.recoveryDurationMs)).filter(Number.isFinite).sort((a,b)=>a-b);
    const percentile = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.ceil(p * arr.length) - 1)] : null;
    const eventCounts = {};
    for (const event of eventRecords) eventCounts[event.eventType] = (eventCounts[event.eventType] || 0) + 1;
    res.json({
      generatedAt: new Date(),
      totals: { transactions: total, successful, pending, incidents: incidentRecords.length, recoveredIncidents: recoveredIncidents.length, unresolvedIncidents: incidentRecords.filter(item => item.status === "UNRESOLVED").length },
      recovery: { sampleSize: durations.length, averageMs: durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : null, p95Ms: percentile(durations, .95), successRatePercent: incidentRecords.length ? Math.round((recoveredIncidents.length / incidentRecords.length) * 1000) / 10 : null },
      eventCounts,
      simulationOnly: true
    });
  } catch (error) {
    console.error("Reliability summary failed:", error.message);
    res.status(500).json({ error: "Could not calculate reliability summary." });
  }
});

app.get("/api/benchmarks", async (req, res) => {
  try {
    const records = await benchmarkRuns.find({}).sort({ createdAt: -1 }).limit(10).toArray();
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: "Could not retrieve benchmark history." });
  }
});

app.get("/api/payments", async (req, res) => {
  try {
    const results = await transactions
      .find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    res.json(results.map(publicTransaction));
  } catch (error) {
    console.error("History query failed:", error.message);
    res.status(500).json({ error: "Unable to load transaction history." });
  }
});



app.get("/api/mock-gateway", (req, res) => {
  res.json({
    mode: mockGateway.getMode(),
    availableModes: mockGateway.getModes(),
    simulationOnly: true
  });
});

app.post("/api/mock-gateway/mode", (req, res) => {
  if (!demoControlsAllowed(req)) return res.status(403).json({ error: "Gateway simulation controls are disabled. Enable local demo controls in development only." });
  try {
    const mode = req.body.mode;
    const selectedMode = mockGateway.setMode(mode);
    if (gatewayRestoreTimer) clearTimeout(gatewayRestoreTimer);
    gatewayRestoreTimer = null;


    const restoreAfterMs = {
      SLOW: 6000,
      LOST_RESPONSE: 1200,
      INVALID_RESPONSE: 1200,
      UNAVAILABLE: 8000
    }[selectedMode];
    if (restoreAfterMs) {
      gatewayRestoreTimer = setTimeout(async () => {
        if (mockGateway.getMode() !== selectedMode) return;
        mockGateway.setMode("NORMAL");
        await recordReliabilityEvent({
          stage: "RECOVERING",
          eventType: "MOCK_GATEWAY_AUTO_RESTORED",
          message: `The simulated ${selectedMode} fault window ended; the mock gateway returned to NORMAL automatically.`,
          metadata: { previousMode: selectedMode, mode: "NORMAL", restoreAfterMs }
        });
        gatewayRestoreTimer = null;
      }, restoreAfterMs);
    }

    res.json({
      message: restoreAfterMs
        ? `Mock gateway mode set to ${selectedMode}; this simulated fault auto-restores after ${restoreAfterMs} ms.`
        : "Mock gateway mode updated",
      mode: selectedMode,
      autoRestoreAfterMs: restoreAfterMs || null,
      simulationOnly: true
    });
  } catch (error) {
    res.status(error.statusCode || 400).json({
      error: error.message
    });
  }
});

app.post("/api/mock-gateway/reset", (req, res) => {
  if (!demoControlsAllowed(req)) return res.status(403).json({ error: "Gateway simulation controls are disabled. Enable local demo controls in development only." });
  mockGateway.setMode("NORMAL");
  if (gatewayRestoreTimer) clearTimeout(gatewayRestoreTimer);
  gatewayRestoreTimer = null;

  res.json({
    message: "Mock gateway restored to NORMAL. The circuit breaker will recover through its cooldown and a successful automatic probe.",
    mode: mockGateway.getMode(),
    circuitBreaker: gatewayResilience.getStatus(),
    simulationOnly: true
  });
});



async function reconcileTransaction(tx) {
  const detectedAt = tx.failureDetectedAt || tx.createdAt || new Date();

  try {
    let outcome = await mockGateway.getOutcome(tx.idempotencyKey);

    if (
      !outcome &&
      ["GATEWAY_UNAVAILABLE", "GATEWAY_CIRCUIT_OPEN", "PAYMENT_IN_PROGRESS", "SIMULATED_PROCESS_CRASH"].includes(tx.lastError) &&
      mockGateway.getMode() === "NORMAL"
    ) {
      await recordReliabilityEvent({
        transactionId: tx.transactionId,
        stage: "RECOVERING",
        eventType: "AUTOMATIC_RETRY_STARTED",
        message: "Gateway is back in NORMAL mode; retrying the same idempotency key through the circuit breaker.",
        metadata: { lastError: tx.lastError }
      });
      try {
        const retryResult = await gatewayResilience.processPayment({
          idempotencyKey: tx.idempotencyKey,
          transactionId: tx.transactionId,
          amount: Number(tx.amount)
        });
        const validRetry = retryResult &&
          retryResult.transactionId === tx.transactionId &&
          retryResult.idempotencyKey === tx.idempotencyKey &&
          retryResult.status === "SIMULATED_SUCCESS" &&
          Number(retryResult.amount) === Number(tx.amount);
        if (validRetry) {
          outcome = await mockGateway.getOutcome(tx.idempotencyKey);
        }
      } catch (retryError) {
        await transactions.updateOne(
          { _id: tx._id, status: "PENDING" },
          { $inc: { recoveryAttempts: 1 }, $set: { lastRecoveryCheckAt: new Date() } }
        );
        return {
          transactionId: tx.transactionId,
          status: "UNRESOLVED",
          retryDeferred: true,
          reason: retryError.code || "GATEWAY_RETRY_FAILED"
        };
      }
    }

    if (!outcome) {
      await transactions.updateOne(
        { _id: tx._id, status: "PENDING" },
        {
          $inc: { recoveryAttempts: 1 },
          $set: {
            lastRecoveryCheckAt: new Date()
          }
        }
      );

      const incidentWrite = await incidents.updateOne(
        {
          transactionId: tx.transactionId,
          type: "TRANSACTION_RECONCILIATION"
        },
        {
          $set: {
            status: "UNRESOLVED",
            actionTaken: "LOOKUP_GATEWAY_OUTCOME",
            lastCheckedAt: new Date(),
            message: "No gateway outcome is available yet."
          },
          $setOnInsert: {
            incidentId: crypto.randomUUID(),
            transactionId: tx.transactionId,
            type: "TRANSACTION_RECONCILIATION",
            detectedAt
          }
        },
        { upsert: true }
      );

      if (incidentWrite.upsertedCount > 0) {
        await recordReliabilityEvent({
          transactionId: tx.transactionId,
          stage: "DIAGNOSING",
          eventType: "GATEWAY_OUTCOME_NOT_FOUND",
          message: "No authoritative gateway outcome exists yet; transaction remains safely pending.",
          metadata: { recoveryAction: "LOOKUP_GATEWAY_OUTCOME" }
        });
      }

      return { transactionId: tx.transactionId, status: "UNRESOLVED" };
    }

    const validOutcome =
      outcome.transactionId === tx.transactionId &&
      outcome.idempotencyKey === tx.idempotencyKey &&
      Number(outcome.amount) === Number(tx.amount) &&
      outcome.status === "SIMULATED_SUCCESS";

    if (!validOutcome) {
      const incidentWrite = await incidents.updateOne(
        {
          transactionId: tx.transactionId,
          type: "TRANSACTION_RECONCILIATION"
        },
        {
          $set: {
            status: "UNRESOLVED",
            actionTaken: "REJECT_INVALID_GATEWAY_OUTCOME",
            lastCheckedAt: new Date(),
            message: "Gateway outcome failed validation."
          },
          $setOnInsert: {
            incidentId: crypto.randomUUID(),
            transactionId: tx.transactionId,
            type: "TRANSACTION_RECONCILIATION",
            detectedAt
          }
        },
        { upsert: true }
      );

      if (incidentWrite.upsertedCount > 0) {
        await recordReliabilityEvent({
          transactionId: tx.transactionId,
          stage: "DIAGNOSING",
          eventType: "GATEWAY_OUTCOME_REJECTED",
          message: "The persisted gateway outcome failed validation and was not trusted.",
          metadata: { recoveryAction: "REJECT_INVALID_GATEWAY_OUTCOME" }
        });
      }

      return { transactionId: tx.transactionId, status: "UNRESOLVED" };
    }

    const recoveredAt = new Date();

    const result = await transactions.updateOne(
      {
        _id: tx._id,
        status: "PENDING",
        idempotencyKey: tx.idempotencyKey
      },
      {
        $set: {
          status: "SIMULATED_SUCCESS",
          updatedAt: recoveredAt,
          reconciledAt: recoveredAt,
          recoveryMethod: "GATEWAY_RECONCILIATION"
        },
        $unset: {
          lastError: ""
        }
      }
    );

    if (result.modifiedCount === 0) {
      const latest = await transactions.findOne({ _id: tx._id });

      return {
        transactionId: tx.transactionId,
        status: latest ? latest.status : "NOT_FOUND"
      };
    }

    const verifiedTransaction = await transactions.findOne({ _id: tx._id });
    if (
      !verifiedTransaction ||
      verifiedTransaction.status !== "SIMULATED_SUCCESS" ||
      verifiedTransaction.recoveryMethod !== "GATEWAY_RECONCILIATION"
    ) {
      await recordReliabilityEvent({
        transactionId: tx.transactionId,
        stage: "DIAGNOSING",
        eventType: "RECOVERY_VERIFICATION_FAILED",
        message: "The persisted transaction did not match the expected recovered state.",
        metadata: { expectedStatus: "SIMULATED_SUCCESS" }
      });
      return {
        transactionId: tx.transactionId,
        status: "UNRESOLVED",
        error: "RECOVERY_VERIFICATION_FAILED"
      };
    }

    await incidents.updateOne(
      {
        transactionId: tx.transactionId,
        type: "TRANSACTION_RECONCILIATION"
      },
      {
        $set: {
          status: "RECOVERED",
          actionTaken: "RECONCILED_GATEWAY_OUTCOME",
          recoveredAt,
          recoveryDurationMs: Math.max(
            0,
            recoveredAt.getTime() - detectedAt.getTime()
          ),
          message: "Original transaction reconciled successfully."
        },
        $setOnInsert: {
          incidentId: crypto.randomUUID(),
          transactionId: tx.transactionId,
          type: "TRANSACTION_RECONCILIATION",
          detectedAt
        }
      },
      { upsert: true }
    );

    await recordReliabilityEvent({
      transactionId: tx.transactionId,
      stage: "RECOVERED",
      eventType: "TRANSACTION_RECONCILED",
      message: "The original pending transaction was reconciled against the persisted gateway outcome.",
      metadata: {
        recoveryMethod: "GATEWAY_RECONCILIATION",
        recoveryDurationMs: Math.max(0, recoveredAt.getTime() - detectedAt.getTime())
      }
    });
    await recordReliabilityEvent({
      transactionId: tx.transactionId,
      stage: "VERIFIED",
      eventType: "RECOVERY_VERIFIED",
      message: "A read-back confirmed that the original transaction is persisted as SIMULATED_SUCCESS.",
      metadata: {
        status: verifiedTransaction.status,
        recoveryMethod: verifiedTransaction.recoveryMethod
      }
    });

    return {
      transactionId: tx.transactionId,
      status: "SIMULATED_SUCCESS",
      recovered: true
    };
  } catch (error) {
    console.error(
      "Reconciliation error:",
      tx.transactionId,
      error.message
    );

    return {
      transactionId: tx.transactionId,
      status: "UNRESOLVED",
      error: "RECONCILIATION_ERROR"
    };
  }
}


async function runRecoveryOnce(options = {})  {
  if (benchmarkRunning && !options.allowDuringBenchmark) {
    return { skipped: true, message: "Recovery worker paused for controlled benchmark" };
  }
  if (recoveryRunning) {
    return { skipped: true, message: "Recovery scan already running" };
  }

  recoveryRunning = true;

  try {
    const staleBefore = new Date(Date.now() - 10000);

    const pendingFilter = options.includeFreshPending
      ? { status: "PENDING" }
      : {
          status: "PENDING",
          $or: [
            { lastError: { $in: ["GATEWAY_UNAVAILABLE", "GATEWAY_CIRCUIT_OPEN", "GATEWAY_RESPONSE_LOST", "INVALID_GATEWAY_RESPONSE", "SIMULATED_PROCESS_CRASH"] } },
            { lastError: "PAYMENT_IN_PROGRESS", updatedAt: { $lt: staleBefore } },
            { lastError: { $exists: false }, createdAt: { $lt: staleBefore } }
          ]
        };
    
    const pendingTransactions = await transactions
      .find(pendingFilter)
      .limit(50)
      .toArray();

    const results = [];

    for (const tx of pendingTransactions) {
      results.push(await reconcileTransaction(tx));
    }

    return {
      scanned: pendingTransactions.length,
      results
    };
  } finally {
    recoveryRunning = false;
  }
}

app.get("/api/circuit-breaker", (req, res) => {
  res.json(gatewayResilience.getStatus());
});

if (demoControlsEnabled()) {
  app.post("/api/dev/prepare-crash-recovery", async (req, res) => {
    if (!demoControlsAllowed(req)) {
      return res.status(403).json({ error: "Crash-recovery preparation is local-development-only." });
    }
    try {
      mockGateway.setMode("NORMAL");
      const now = new Date();
      const idempotencyKey = crypto.randomUUID();
      const transaction = {
        transactionId: `CPX-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        idempotencyKey,
        studentName: "PM2 Recovery Demo",
        purpose: "Canteen",
        amount: 120,
        status: "PENDING",
        lastError: "SIMULATED_PROCESS_CRASH",
        failureDetectedAt: now,
        createdAt: now,
        updatedAt: now
      };
      await transactions.insertOne(transaction);
      await mockGateway.processPayment({
        idempotencyKey,
        transactionId: transaction.transactionId,
        amount: transaction.amount
      });
      await recordReliabilityEvent({
        transactionId: transaction.transactionId,
        stage: "DETECTED",
        eventType: "CRASH_RECOVERY_TEST_PREPARED",
        message: "A pending transaction and its authoritative gateway outcome are persisted; startup recovery must reconcile them after restart.",
        metadata: { simulationOnly: true }
      });
      return res.status(201).json({
        message: "Crash-recovery test prepared. Trigger /api/dev/crash next while PM2 is supervising this process.",
        transaction: publicTransaction(transaction),
        simulationOnly: true
      });
    } catch (error) {
      console.error("Crash-recovery preparation failed:", error.message);
      return res.status(500).json({ error: "Could not prepare crash-recovery test." });
    }
  });

  app.post("/api/dev/crash", (req, res) => {
    if (!demoControlsAllowed(req)) return res.status(403).json({ error: "Crash controls are local-development-only." });
    res.status(202).json({
      message: "Development crash test accepted",
      simulationOnly: true
    });

    res.on("finish", () => {
      setTimeout(() => {
        process.exit(1);
      }, 100);
    });
  });

  app.post("/api/dev/benchmark/recovery", async (req, res) => {
    if (!demoControlsAllowed(req)) return res.status(403).json({ error: "Benchmark controls are local-development-only." });
    if (benchmarkRunning) return res.status(409).json({ error: "A benchmark is already running." });
    benchmarkRunning = true;
    const runId = crypto.randomUUID();
    const sampleSize = Math.min(3, Math.max(1, Number.parseInt(req.body?.sampleSize, 10) || 3));
    const previousMode = mockGateway.getMode();
    const baseline = { attempted: 0, recoveredAtMeasurement: 0, pendingAtMeasurement: 0, elapsedMs: 0 };
    const healing = { attempted: 0, recoveredAtMeasurement: 0, pendingAtMeasurement: 0, elapsedMs: 0, recoveryDurationsMs: [] };
    const startedAt = new Date();
    try {
      mockGateway.setMode("LOST_RESPONSE");
      const baselineStart = Date.now();
      for (let i = 0; i < sampleSize; i++) {
        const idempotencyKey = crypto.randomUUID();
        const transaction = {
          transactionId: `CPX-B-${crypto.randomUUID().slice(0,8).toUpperCase()}`,
          idempotencyKey,
          studentName: "Benchmark Simulation",
          purpose: "Library Fee",
          amount: 1,
          status: "PENDING",
          createdAt: new Date(),
          updatedAt: new Date(),
          benchmarkRunId: runId,
          benchmarkGroup: "BASELINE"
        };
        await transactions.insertOne(transaction);
        baseline.attempted++;
        try {
          await mockGateway.processPayment({ idempotencyKey, transactionId: transaction.transactionId, amount: transaction.amount });
        } catch (error) {
          await transactions.updateOne({ _id: transaction._id }, { $set: { lastError: error.code || "BENCHMARK_ERROR", updatedAt: new Date() } });
        }
        await recordReliabilityEvent({ transactionId: transaction.transactionId, stage: "DETECTED", eventType: "BENCHMARK_BASELINE_OUTCOME_LOST", message: "Baseline cohort recorded a lost response without immediate reconciliation.", metadata: { runId, group: "BASELINE" } });
      }
      baseline.elapsedMs = Date.now() - baselineStart;
      const baselineDocs = await transactions.find({ benchmarkRunId: runId, benchmarkGroup: "BASELINE" }).toArray();
      baseline.recoveredAtMeasurement = baselineDocs.filter(tx => tx.status === "SIMULATED_SUCCESS").length;
      baseline.pendingAtMeasurement = baselineDocs.filter(tx => tx.status === "PENDING").length;

      const healingStart = Date.now();
      for (let i = 0; i < sampleSize; i++) {
        const idempotencyKey = crypto.randomUUID();
        const transaction = {
          transactionId: `CPX-H-${crypto.randomUUID().slice(0,8).toUpperCase()}`,
          idempotencyKey,
          studentName: "Benchmark Simulation",
          purpose: "Library Fee",
          amount: 1,
          status: "PENDING",
          createdAt: new Date(),
          updatedAt: new Date(),
          benchmarkRunId: runId,
          benchmarkGroup: "SELF_HEALING"
        };
        await transactions.insertOne(transaction);
        healing.attempted++;
        try {
          await mockGateway.processPayment({ idempotencyKey, transactionId: transaction.transactionId, amount: transaction.amount });
        } catch (error) {
          await transactions.updateOne({ _id: transaction._id }, { $set: { lastError: error.code || "BENCHMARK_ERROR", updatedAt: new Date() } });
        }
        const pending = await transactions.findOne({ _id: transaction._id });
        const recoveryStart = Date.now();
        const outcome = await reconcileTransaction(pending);
        const finalTx = await transactions.findOne({ _id: transaction._id });
        if (finalTx?.status === "SIMULATED_SUCCESS") {
          healing.recoveredAtMeasurement++;
          healing.recoveryDurationsMs.push(Math.max(0, Date.now() - recoveryStart));
        } else {
          healing.pendingAtMeasurement++;
        }
        await recordReliabilityEvent({ transactionId: transaction.transactionId, stage: finalTx?.status === "SIMULATED_SUCCESS" ? "VERIFIED" : "DIAGNOSING", eventType: "BENCHMARK_HEALING_RESULT", message: `Self-healing cohort result: ${finalTx?.status || outcome.status}.`, metadata: { runId, group: "SELF_HEALING" } });
      }
      healing.elapsedMs = Date.now() - healingStart;
      const report = {
        runId,
        createdAt: new Date(),
        startedAt,
        completedAt: new Date(),
        sampleSize,
        scenario: "LOST_RESPONSE",
        baseline,
        selfHealing: healing,
        comparison: {
          baselineRecoveryRatePercent: Math.round((baseline.recoveredAtMeasurement / Math.max(1, baseline.attempted)) * 1000) / 10,
          selfHealingRecoveryRatePercent: Math.round((healing.recoveredAtMeasurement / Math.max(1, healing.attempted)) * 1000) / 10,
          improvementPercentagePoints: Math.round(((healing.recoveredAtMeasurement / Math.max(1, healing.attempted)) - (baseline.recoveredAtMeasurement / Math.max(1, baseline.attempted))) * 1000) / 10,
          note: "Baseline is measured before immediate reconciliation; the self-healing cohort is reconciled immediately against persisted simulated gateway outcomes. Periodic recovery may later heal baseline transactions."
        },
        simulationOnly: true
      };
      await benchmarkRuns.insertOne(report);
      return res.json(report);
    } catch (error) {
      console.error("Recovery benchmark failed:", error.message);
      return res.status(500).json({ error: "Benchmark failed. Check server logs." });
    } finally {
      mockGateway.setMode("NORMAL");
      gatewayResilience.resetForDemo();
      benchmarkRunning = false;
    }
  });
}

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing. Check your .env file.");
  }

  await client.connect();
  db = client.db(process.env.DB_NAME || "campuspayx");
  transactions = db.collection("transactions");


  gatewayOutcomes = db.collection("gateway_outcomes");
incidents = db.collection("incidents");
reliabilityEvents = db.collection("reliability_events");
benchmarkRuns = db.collection("benchmark_runs");

mockGateway.setCollection(gatewayOutcomes);

await gatewayOutcomes.createIndex(
  { idempotencyKey: 1 },
  { unique: true, name: "unique_gateway_idempotency_key" }
);

await incidents.createIndex(
  { detectedAt: -1 },
  { name: "incidents_detected_at" }
);

await reliabilityEvents.createIndex(
  { timestamp: -1 },
  { name: "reliability_events_timestamp" }
);
await reliabilityEvents.createIndex(
  { transactionId: 1, timestamp: -1 },
  { name: "reliability_events_transaction_timeline" }
);
await reliabilityEvents.createIndex(
  { correlationId: 1, timestamp: -1 },
  { name: "reliability_events_correlation_timeline" }
);
await benchmarkRuns.createIndex(
  { createdAt: -1 },
  { name: "benchmark_runs_created_at" }
);

  await transactions.createIndex(
    { idempotencyKey: 1 },
    { unique: true, name: "unique_idempotency_key" }
  );

  await transactions.createIndex({ createdAt: -1 });

  try {
    const startupRecovery = await runRecoveryOnce({
    includeFreshPending: true
  });

    console.log(
      "[STARTUP RECOVERY]",
      JSON.stringify(startupRecovery)
    );
  } catch (error) {
    console.error(
      "[STARTUP RECOVERY FAILED]",
      error.message
    );
  }


  app.listen(PORT, () => {
    console.log(`CampusPay X running on port ${PORT}`);

    setInterval(() => {
      runRecoveryOnce().catch(error => {
        console.error("Recovery worker error:", error.message);
      });
    }, 5000);
  });
}

start().catch(async error => {
  console.error("Startup failed:", error.message);
  await client.close().catch(() => {});
  process.exit(1);
});


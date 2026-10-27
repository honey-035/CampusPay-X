
const MODES = [
  "NORMAL",
  "SLOW",
  "UNAVAILABLE",
  "LOST_RESPONSE",
  "INVALID_RESPONSE"
];

let currentMode = "NORMAL";
let gatewayOutcomes;
let gatewayCallCount = 0;

function setCollection(collection) {
  gatewayOutcomes = collection;
}

function setMode(mode) {
  if (!MODES.includes(mode)) {
    const error = new Error("Invalid gateway mode");
    error.statusCode = 400;
    throw error;
  }

  currentMode = mode;
  return currentMode;
}

function getMode() {
  return currentMode;
}

function getModes() {
  return [...MODES];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function invalidResponse(transactionId) {
  return {
    transactionId,
    status: "UNKNOWN_UNEXPECTED_STATUS",
    amount: "not-a-number"
  };
}

async function processPayment({
  idempotencyKey,
  transactionId,
  amount
}) {
  gatewayCallCount += 1;
  if (!gatewayOutcomes) {
    throw new Error("Gateway database collection is not initialized");
  }

  
  if (currentMode === "SLOW") {
    await delay(5000);
  }

  const existing = await gatewayOutcomes.findOne({ idempotencyKey });

  if (existing) {
    if (existing.transactionId !== transactionId) {
      throw new Error(
        "Idempotency key is linked to another transaction"
      );
    }

    if (currentMode === "LOST_RESPONSE") {
      const error = new Error(
        "Simulated gateway response was lost"
      );
      error.code = "GATEWAY_RESPONSE_LOST";
      throw error;
    }

    if (currentMode === "INVALID_RESPONSE") {
      return invalidResponse(transactionId);
    }

    return existing;
  }

  if (currentMode === "UNAVAILABLE") {
    const error = new Error("Mock gateway is unavailable");
    error.code = "GATEWAY_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }

  // Persist the gateway outcome before attempting to send the response.
  const outcome = {
    transactionId,
    idempotencyKey,
    amount: Number(amount),
    status: "SIMULATED_SUCCESS",
    processedAt: new Date()
  };

  try {
    await gatewayOutcomes.insertOne(outcome);
  } catch (error) {
    // A concurrent request may have inserted this outcome first.
    if (error.code === 11000) {
      const saved = await gatewayOutcomes.findOne({
        idempotencyKey
      });

      if (
        saved &&
        saved.transactionId === transactionId
      ) {
        if (currentMode === "LOST_RESPONSE") {
          const lost = new Error(
            "Simulated gateway response was lost"
          );
          lost.code = "GATEWAY_RESPONSE_LOST";
          throw lost;
        }

        if (currentMode === "INVALID_RESPONSE") {
          return invalidResponse(transactionId);
        }

        return saved;
      }
    }

    throw error;
  }

  if (currentMode === "LOST_RESPONSE") {
    const error = new Error(
      "Simulated gateway response was lost"
    );
    error.code = "GATEWAY_RESPONSE_LOST";
    throw error;
  }

  if (currentMode === "INVALID_RESPONSE") {
    return invalidResponse(transactionId);
  }

  return outcome;
}

function getStats() {
  return { gatewayCalls: gatewayCallCount };
}

function resetStats() {
  gatewayCallCount = 0;
}

async function getOutcome(idempotencyKey) {
  if (!gatewayOutcomes) {
    throw new Error("Gateway database collection is not initialized");
  }

  return gatewayOutcomes.findOne({ idempotencyKey });
}

module.exports = {
  setCollection,
  setMode,
  getMode,
  getModes,
  processPayment,
  getOutcome,
  getStats,
  resetStats
};

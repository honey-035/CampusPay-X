const mockGateway = require("./mockGateway");

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 10000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

let state = "CLOSED";
let consecutiveFailures = 0;
let openedAt = null;
let probeInProgress = false;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getStatus() {
  const remainingMs = state === "OPEN"
    ? Math.max(0, COOLDOWN_MS - (Date.now() - openedAt))
    : 0;

  return {
    state,
    consecutiveFailures,
    failureThreshold: FAILURE_THRESHOLD,
    cooldownMs: COOLDOWN_MS,
    remainingMs,
    probeInProgress,
    simulationOnly: true
  };
}

function openCircuit() {
  state = "OPEN";
  openedAt = Date.now();
  probeInProgress = false;
}

function closeCircuit() {
  state = "CLOSED";
  consecutiveFailures = 0;
  openedAt = null;
  probeInProgress = false;
}

function recordFailure() {
  consecutiveFailures += 1;
  if (state === "HALF_OPEN" || consecutiveFailures >= FAILURE_THRESHOLD) {
    openCircuit();
  }
}

// Used only by the explicitly local demo reset endpoint, never by recovery logic.
function resetForDemo() {
  closeCircuit();
}

function createCircuitError(message, code = "GATEWAY_CIRCUIT_OPEN") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isValidSuccess(result, payment) {
  return Boolean(
    result &&
    result.transactionId === payment.transactionId &&
    result.idempotencyKey === payment.idempotencyKey &&
    result.status === "SIMULATED_SUCCESS" &&
    Number(result.amount) === Number(payment.amount)
  );
}

async function processPayment(payment) {
  let isProbe = false;

  if (state === "OPEN") {
    const elapsed = Date.now() - openedAt;
    if (elapsed < COOLDOWN_MS) {
      throw createCircuitError("Circuit is open; the gateway cooldown has not elapsed.");
    }
    state = "HALF_OPEN";
    probeInProgress = true;
    isProbe = true;
  } else if (state === "HALF_OPEN") {
    throw createCircuitError("A gateway recovery probe is already in progress.");
  }

  const attemptsAllowed = isProbe ? 1 : MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    try {
      const result = await mockGateway.processPayment(payment);

      // A half-open probe only closes the breaker when the response is valid.
      // Invalid data is a dependency failure, even if reconciliation can later
      // recover the transaction from the authoritative persisted outcome.
      if (isValidSuccess(result, payment)) {
        closeCircuit();
      } else if (isProbe) {
        recordFailure();
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= FAILURE_THRESHOLD) openCircuit();
      }

      return result;
    } catch (error) {
      // Every unsuccessful half-open probe re-opens the circuit. In CLOSED,
      // availability failures use bounded retries with exponential backoff;
      // uncertain responses are not blindly retried by this layer.
      if (isProbe) {
        recordFailure();
        throw error;
      }

      if (error.code !== "GATEWAY_UNAVAILABLE") {
        if (["GATEWAY_RESPONSE_LOST", "GATEWAY_INVALID_RESPONSE"].includes(error.code)) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= FAILURE_THRESHOLD) openCircuit();
        }
        throw error;
      }

      recordFailure();
      if (state === "OPEN" || attempt === attemptsAllowed) throw error;
      await delay(BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }

  throw createCircuitError("Gateway request ended without a verifiable result.", "GATEWAY_ERROR");
}

module.exports = {
  processPayment,
  getStatus,
  resetForDemo
};

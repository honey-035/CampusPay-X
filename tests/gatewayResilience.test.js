const test = require("node:test");
const assert = require("node:assert/strict");
const mockGateway = require("../mockGateway");
const resilience = require("../gatewayResilience");

function memoryCollection() {
  const records = new Map();
  return {
    records,
    async findOne(query) {
      return records.get(query.idempotencyKey) || null;
    },
    async insertOne(document) {
      if (records.has(document.idempotencyKey)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      records.set(document.idempotencyKey, { ...document });
      return { acknowledged: true, insertedId: document.idempotencyKey };
    }
  };
}

function payment(id = "11111111-1111-4111-8111-111111111111") {
  return {
    idempotencyKey: id,
    transactionId: `CPX-${id.slice(0, 8).toUpperCase()}`,
    amount: 120
  };
}

async function setup(mode = "NORMAL") {
  resilience.resetForDemo();
  mockGateway.setMode("NORMAL");
  mockGateway.setCollection(memoryCollection());
  mockGateway.setMode(mode);
}

test("normal gateway returns a valid simulated success and breaker stays closed", async () => {
  await setup("NORMAL");
  const p = payment();
  const result = await resilience.processPayment(p);
  assert.equal(result.status, "SIMULATED_SUCCESS");
  assert.equal(result.transactionId, p.transactionId);
  assert.equal(resilience.getStatus().state, "CLOSED");
});

test("lost response is reported, but the authoritative outcome is persisted", async () => {
  await setup("LOST_RESPONSE");
  const p = payment("22222222-2222-4222-8222-222222222222");
  await assert.rejects(resilience.processPayment(p), error => error.code === "GATEWAY_RESPONSE_LOST");
  const outcome = await mockGateway.getOutcome(p.idempotencyKey);
  assert.equal(outcome.status, "SIMULATED_SUCCESS");
  assert.equal(outcome.transactionId, p.transactionId);
});

test("invalid response is not treated as a valid success, while authoritative outcome exists", async () => {
  await setup("INVALID_RESPONSE");
  const p = payment("33333333-3333-4333-8333-333333333333");
  const result = await resilience.processPayment(p);
  assert.equal(result.status, "UNKNOWN_UNEXPECTED_STATUS");
  assert.equal(resilience.getStatus().state, "CLOSED");
  assert.equal(resilience.getStatus().consecutiveFailures, 1);
  const outcome = await mockGateway.getOutcome(p.idempotencyKey);
  assert.equal(outcome.status, "SIMULATED_SUCCESS");
});

test("unavailable gateway opens breaker, then a successful half-open probe closes it", async () => {
  await setup("UNAVAILABLE");
  const p = payment("44444444-4444-4444-8444-444444444444");
  await assert.rejects(resilience.processPayment(p), error => error.code === "GATEWAY_UNAVAILABLE");
  const status = resilience.getStatus();
  assert.equal(status.state, "OPEN");
  assert.equal(status.consecutiveFailures, status.failureThreshold);
  assert.equal(await mockGateway.getOutcome(p.idempotencyKey), null);

  // Fast-forward the cooldown clock to test the automatic half-open probe
  // without making the unit suite wait ten real seconds.
  mockGateway.setMode("NORMAL");
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + status.cooldownMs + 100;
    const recovered = await resilience.processPayment(p);
    assert.equal(recovered.status, "SIMULATED_SUCCESS");
    assert.equal(resilience.getStatus().state, "CLOSED");
    assert.equal(resilience.getStatus().consecutiveFailures, 0);
    assert.equal((await mockGateway.getOutcome(p.idempotencyKey)).status, "SIMULATED_SUCCESS");
  } finally {
    Date.now = realNow;
  }
});

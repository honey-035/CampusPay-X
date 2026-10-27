const $ = (id) => document.getElementById(id);
let selectedTransactionId = "";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getStatusClass(status) {
  const value = String(status || "").toUpperCase();
  if (value.includes("SUCCESS") || value === "RECOVERED") return "status-success";
  if (value === "CLOSED") return "status-closed";
  if (value === "OPEN" || value.includes("FAILED") || value.includes("ERROR")) return "status-failed";
  if (value === "HALF_OPEN" || value === "PENDING" || value === "UNRESOLVED") return "status-pending";
  return "";
}

function statusBadge(value) {
  const text = String(value || "UNKNOWN");
  return `<span class="status ${getStatusClass(text)}">${escapeHtml(text)}</span>`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return "₹" + amount.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function getList(data, possibleKeys = []) {
  if (Array.isArray(data)) return data;
  for (const key of possibleKeys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function setIndicator(id, state) {
  const element = $(id);
  if (!element) return;
  element.className = "card-indicator";
  if (state === "good") element.classList.add("good");
  if (state === "warn") element.classList.add("warn");
  if (state === "bad") element.classList.add("bad");
}

function setServiceState(id, label, tone = "neutral") {
  const el = $(id);
  if (!el) return;
  el.textContent = label;
  el.className = `service-state ${tone}`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "No data";
  const value = Number(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

function renderServiceMap(health, circuit, gateway) {
  const healthy = health?.status === "healthy";
  const dbConnected = String(health?.database || "").toLowerCase() === "connected";
  const cb = String(circuit?.state || "UNKNOWN").toUpperCase();
  const mode = String(gateway?.mode || "UNKNOWN").toUpperCase();
  setServiceState("serviceApiState", healthy ? "Online" : "Degraded", healthy ? "good" : "bad");
  setText("serviceApiDetail", health ? `Uptime ${Math.floor(health.uptimeSeconds || 0)}s` : "Health unavailable");
  setServiceState("serviceResilienceState", cb.replace(/_/g, " "), cb === "CLOSED" ? "good" : cb === "OPEN" ? "bad" : "warn");
  setText("serviceResilienceDetail", circuit ? `${circuit.consecutiveFailures || 0} consecutive failures` : "Circuit status unavailable");
  setServiceState("serviceGatewayState", mode.replace(/_/g, " "), mode === "NORMAL" ? "good" : mode === "UNAVAILABLE" ? "bad" : "warn");
  setText("serviceGatewayDetail", mode === "NORMAL" ? "Normal simulation mode" : "Fault mode active");
  setServiceState("serviceMongoState", dbConnected ? "Connected" : "Unavailable", dbConnected ? "good" : "bad");
  setServiceState("serviceRecoveryState", health?.recoveryWorker === "BUSY" ? "Working" : healthy ? "Idle / scheduled" : "Unknown", healthy ? "good" : "warn");
  setText("serviceRecoveryDetail", `Worker ${health?.recoveryWorker || "unknown"}; periodic scan`);
}

function renderScorecard(summary) {
  if (!summary) return;
  setText("scoreTotal", Number(summary.totals?.transactions ?? 0).toLocaleString());
  setText("scoreRecovered", Number(summary.totals?.recoveredIncidents ?? 0).toLocaleString());
  setText("scoreAverage", formatDuration(summary.recovery?.averageMs));
  setText("scoreP95", formatDuration(summary.recovery?.p95Ms));
  setText("scoreSample", `${summary.recovery?.sampleSize ?? 0} measured recovery samples`);
  setText("scorecardWindow", `Updated ${formatDate(summary.generatedAt)}`);
}

function showError(message) {
  const box = $("pageError");
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError() {
  $("pageError").classList.add("hidden");
  $("pageError").textContent = "";
}

function renderTransactions(transactions) {
  const rows = $("transactionRows");
  if (!transactions.length) {
    rows.innerHTML = '<tr><td colspan="7" class="empty">No transactions returned by the API.</td></tr>';
    return;
  }

  rows.innerHTML = transactions.map((tx) => {
    const transactionId = tx.transactionId || tx._id || "—";
    return `
      <tr>
        <td>${escapeHtml(transactionId)}</td>
        <td>${escapeHtml(tx.studentName || "—")}</td>
        <td>${escapeHtml(tx.purpose || "—")}</td>
        <td>${escapeHtml(formatAmount(tx.amount))}</td>
        <td>${statusBadge(tx.status)}</td>
        <td>${escapeHtml(formatDate(tx.updatedAt || tx.createdAt))}</td>
        <td><button class="trace-button" data-transaction-id="${escapeHtml(transactionId)}" ${transactionId === "—" ? "disabled" : ""}>View flow ↗</button></td>
      </tr>`;
  }).join("");
}

function renderIncidents(incidents) {
  const rows = $("incidentRows");
  if (!incidents.length) {
    rows.innerHTML = '<tr><td colspan="6" class="empty">No recovery incidents recorded.</td></tr>';
    return;
  }

  rows.innerHTML = incidents.map((incident) => `
    <tr>
      <td>${escapeHtml(incident.incidentId || incident._id || "—")}</td>
      <td>${escapeHtml(incident.transactionId || "—")}</td>
      <td>${escapeHtml(incident.type || "—")}</td>
      <td>${statusBadge(incident.status)}</td>
      <td>${escapeHtml(incident.actionTaken || "—")}</td>
      <td>${escapeHtml(formatDate(incident.detectedAt))}</td>
    </tr>
  `).join("");
}

function updateTransactionMetrics(transactions) {
  const successful = transactions.filter(tx => tx.status === "SIMULATED_SUCCESS").length;
  const pending = transactions.filter(tx => tx.status === "PENDING").length;
  const problems = transactions.filter(tx =>
    ["FAILED", "UNRESOLVED", "ERROR"].includes(String(tx.status || "").toUpperCase())
  ).length;

  setText("totalTransactions", String(transactions.length));
  setText("successfulTransactions", String(successful));
  setText("pendingTransactions", String(pending));
  setText("problemTransactions", String(problems));
}

function eventIcon(stage, type) {
  const normalized = String(stage || "").toUpperCase();
  if (normalized === "RECOVERED" || normalized === "VERIFIED") return "✓";
  if (normalized === "RECOVERING") return "↻";
  if (normalized === "DIAGNOSING") return "⌕";
  if (String(type || "").includes("UNRESOLVED")) return "!";
  return "•";
}

function renderEvents(events) {
  const timeline = $("eventTimeline");
  const filterChip = $("timelineFilter");
  const clearButton = $("clearTimelineFilter");
  filterChip.textContent = selectedTransactionId || "All transactions";
  clearButton.classList.toggle("hidden", !selectedTransactionId);

  if (!events.length) {
    timeline.innerHTML = `
      <div class="timeline-empty">
        <span class="empty-icon">↳</span>
        <strong>No events for this view</strong>
        <p>Submit a simulated payment or select another transaction to inspect its recorded flow.</p>
      </div>`;
    setText("timelineSummary", "0 recorded events in this view");
    return;
  }

  const sorted = [...events].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  timeline.innerHTML = sorted.map((event) => {
    const stage = String(event.stage || "EVENT").toUpperCase();
    const stageClass = stage.toLowerCase();
    const title = String(event.eventType || "SYSTEM_EVENT").replace(/_/g, " ");
    const metadata = event.metadata && typeof event.metadata === "object"
      ? Object.entries(event.metadata)
          .filter(([key, value]) => value !== undefined && value !== null && typeof value !== "object")
          .slice(0, 3)
          .map(([key, value]) => `${key}: ${String(value)}`)
      : [];
    const metadataMarkup = metadata.length
      ? `<div class="event-meta">${metadata.map(item => `<span>${escapeHtml(item)}</span>`).join("")}</div>`
      : "";
    return `
      <article class="event-item">
        <div class="event-marker ${escapeHtml(stageClass)}">${escapeHtml(eventIcon(stage, event.eventType))}</div>
        <div class="event-main">
          <div class="event-title-line"><span class="event-title">${escapeHtml(title)}</span><span class="event-stage ${escapeHtml(stageClass)}">${escapeHtml(stage)}</span></div>
          <p class="event-message">${escapeHtml(event.message || "System event recorded.")}</p>
          <div class="event-meta"><span>${escapeHtml(event.transactionId || "System")}</span>${event.incidentId ? `<span>Incident ${escapeHtml(event.incidentId)}</span>` : ""}</div>
          ${metadataMarkup}
        </div>
        <time class="event-time">${escapeHtml(formatDate(event.timestamp))}</time>
      </article>`;
  }).join("");

  setText("timelineSummary", `${events.length} persistent event${events.length === 1 ? "" : "s"}${selectedTransactionId ? " for selected transaction" : " across recent activity"}`);
}

async function refreshDashboard() {
  $("refreshBtn").disabled = true;
  clearError();

  try {
    const eventUrl = selectedTransactionId
      ? `/api/reliability/events?limit=100&transactionId=${encodeURIComponent(selectedTransactionId)}`
      : "/api/reliability/events?limit=100";

    const results = await Promise.allSettled([
      getJson("/api/health"),
      getJson("/api/circuit-breaker"),
      getJson("/api/mock-gateway"),
      getJson("/api/payments"),
      getJson("/api/incidents"),
      getJson(eventUrl),
      getJson("/api/reliability/summary")
    ]);

    const errors = [];
    const getResult = (index) => results[index].status === "fulfilled" ? results[index].value : null;
    const health = getResult(0);
    const circuit = getResult(1);
    const gateway = getResult(2);
    const transactions = results[3].status === "fulfilled" ? getList(results[3].value, ["transactions", "data", "results"]) : null;
    const incidents = results[4].status === "fulfilled" ? getList(results[4].value, ["incidents", "data", "results"]) : null;
    const events = results[5].status === "fulfilled" ? getList(results[5].value, ["events", "data", "results"]) : null;
    const summary = getResult(6);

    results.forEach(result => {
      if (result.status === "rejected") errors.push(result.reason.message);
    });

    const backendHealthy = Boolean(health && health.status === "healthy");
    setText("backendStatus", backendHealthy ? "Online" : health ? "Degraded" : "Unavailable");
    setIndicator("backendIndicator", backendHealthy ? "good" : "bad");

    const dbStatus = health ? String(health.database || health.dbStatus || health.db || "").toLowerCase() : "";
    const dbHealthy = Boolean(health && (
      dbStatus.includes("connected") || dbStatus.includes("healthy") ||
      dbStatus === "ok" || health.databaseConnected === true || health.database === true
    ));
    setText("databaseStatus", !health ? "Unknown" : dbHealthy ? "Connected" : "Check status");
    setIndicator("databaseIndicator", dbHealthy ? "good" : health ? "warn" : "bad");

    if (circuit) {
      const state = String(circuit.state || "UNKNOWN").toUpperCase();
      setText("circuitStatus", state.replace(/_/g, " "));
      setText("circuitDetail", state === "OPEN"
        ? `Cooldown remaining: ${Math.ceil((circuit.remainingMs || 0) / 1000)} sec`
        : `Consecutive failures: ${circuit.consecutiveFailures ?? 0}`);
      setIndicator("circuitIndicator", state === "CLOSED" ? "good" : state === "OPEN" ? "bad" : "warn");
    } else {
      setText("circuitStatus", "Unavailable");
      setText("circuitDetail", "Circuit endpoint unavailable");
      setIndicator("circuitIndicator", "bad");
    }

    const mode = String(gateway?.mode || "Unavailable");
    setText("gatewayMode", mode.replace(/_/g, " "));
    setIndicator("gatewayIndicator", mode === "NORMAL" ? "good" : mode === "Unavailable" ? "bad" : "warn");

    renderServiceMap(health, circuit, gateway);
    renderScorecard(summary);

    if (transactions !== null) {
      updateTransactionMetrics(transactions);
      renderTransactions(transactions);
    } else {
      ["totalTransactions", "successfulTransactions", "pendingTransactions", "problemTransactions"].forEach(id => setText(id, "—"));
      $("transactionRows").innerHTML = '<tr><td colspan="7" class="empty">Could not load transactions.</td></tr>';
    }

    if (incidents !== null) renderIncidents(incidents);
    else $("incidentRows").innerHTML = '<tr><td colspan="6" class="empty">Could not load incidents.</td></tr>';

    if (events !== null) renderEvents(events);
    else {
      $("eventTimeline").innerHTML = '<div class="timeline-empty"><strong>Could not load reliability events</strong><p>Check the backend endpoint and server logs.</p></div>';
      setText("timelineSummary", "Event API unavailable");
    }

    if (errors.length) showError("Some dashboard data could not be loaded: " + errors.join(" | "));
    setText("lastUpdated", "Updated " + new Date().toLocaleTimeString());
  } catch (error) {
    showError("Dashboard refresh failed: " + error.message);
  } finally {
    $("refreshBtn").disabled = false;
  }
}

$("refreshBtn").addEventListener("click", refreshDashboard);
$("transactionRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-transaction-id]");
  if (!button) return;
  selectedTransactionId = button.getAttribute("data-transaction-id") || "";
  $("timeline").scrollIntoView({ behavior: "smooth", block: "start" });
  refreshDashboard();
});
$("clearTimelineFilter").addEventListener("click", () => {
  selectedTransactionId = "";
  refreshDashboard();
});

refreshDashboard();
setInterval(refreshDashboard, 5000);

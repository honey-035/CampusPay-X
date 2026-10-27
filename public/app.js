const $ = id => document.getElementById(id);
const STORAGE_KEY = "campuspayx_pending_request";
let activeTransactionId = "";
let activeScenario = false;
let lastScenarioMode = null;
let lastEventIds = new Set();
let latestTransactions = [];
let lastEventCounts = {};
let refreshTimer = null;
const stageOrder = ["DETECTED", "DIAGNOSING", "RECOVERING", "VERIFIED"];

function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function money(v) { return new Intl.NumberFormat("en-IN", {style:"currency", currency:"INR", maximumFractionDigits:2}).format(Number(v || 0)); }
function date(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"}); }
function pretty(v) { return String(v || "EVENT").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }
function getPendingRequest() { try { const raw=sessionStorage.getItem(STORAGE_KEY); return raw?JSON.parse(raw):null; } catch { return null; } }
function savePendingRequest(v) { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v)); }
function clearPendingRequest() { sessionStorage.removeItem(STORAGE_KEY); }
function newKey() { return crypto.randomUUID(); }
function setMessage(text, type="") { const el=$("message"); el.textContent=text; el.className=`message ${type}`; }
function setScenarioMessage(text,type="") { const el=$("scenarioMessage"); el.textContent=text; el.className=`scenario-message ${type}`; }
function setBusy(busy) { document.querySelectorAll(".scenario-button,#resetGateway,#payButton").forEach(b=>b.disabled=busy); }
async function request(url, options={}) { const response=await fetch(url,{cache:"no-store",headers:{"Content-Type":"application/json",Accept:"application/json"},...options}); const data=await response.json().catch(()=>({})); return {ok:response.ok,status:response.status,data}; }
async function api(url, options={}) { const r=await request(url,options); if(!r.ok) throw new Error(r.data.error||`${url} returned HTTP ${r.status}`); return r.data; }

function setFlowState(state, explanation) {
  const pill=$("flowState"); pill.textContent=state; pill.className="state-pill";
  if(state==="RUNNING") pill.classList.add("running"); else if(state==="RECOVERED"||state==="SUCCESS") pill.classList.add("recovered"); else if(state==="UNRESOLVED"||state==="FAILED") pill.classList.add("failed");
  if(explanation) $("flowExplanation").innerHTML=`<span class="explanation-icon">i</span><p>${explanation}</p>`;
}
function resetFlow() {
  document.querySelectorAll(".flow-step").forEach(el=>{el.classList.remove("active","complete");el.querySelector(".flow-check").textContent="○";});
  setFlowState("RUNNING", "<b>Scenario started.</b><br>Waiting for backend evidence. Each stage updates as recorded events arrive.");
}
function updateFlow(events, tx) {
  const found = new Set(events.map(e=>String(e.stage||"").toUpperCase()));
  const types = new Set(events.map(e=>String(e.eventType||"").toUpperCase()));
  const hasFailure = [...types].some(t=>/FAIL|LOST|UNAVAILABLE|INVALID|CIRCUIT/.test(t));
  const hasDiagnosis = [...types].some(t=>/CLASSIF|DIAGNOS|VALIDATION_FAILED|RECONCILIATION_REQUIRED|RECONCILIATION_SCHEDULED/.test(t)) || found.has("DIAGNOSING");
  const hasRecovery = [...types].some(t=>/RECONCIL|RECOVER|RETRY|CIRCUIT/.test(t)) || found.has("RECOVERING");
  const verified = [...types].some(t=>/PAYMENT_VERIFIED|RECOVERY_VERIFIED|TRANSACTION_RECONCILED/.test(t)) || (tx && tx.status === "SIMULATED_SUCCESS" && !hasFailure);
  const steps = document.querySelectorAll(".flow-step");
  const normalSuccess = Boolean(verified && !hasFailure);
  let current = 0;
  if (hasFailure || found.has("DETECTED")) current=0;
  if (hasDiagnosis) current=1;
  if (hasRecovery) current=2;
  if (verified) current=3;
  steps.forEach((el,i)=>{
    const skipped = normalSuccess && i===1;
    const isComplete = normalSuccess ? (i===0 || i===2 || i===3) : (i < current || (i===0 && hasDiagnosis) || (i===1 && hasRecovery) || (i===2 && verified) || (i===3 && verified));
    el.classList.toggle("active", i===current && !verified && !normalSuccess);
    el.classList.toggle("complete", isComplete);
    el.classList.toggle("skipped", skipped);
    el.querySelector(".flow-check").textContent=skipped?"—":(isComplete?"✓":(i===current&&!verified?"◌":"○"));
  });
  if(normalSuccess) {
    setFlowState("SUCCESS", "<b>Normal payment completed.</b><br>No failure was injected. The gateway response passed validation and the transaction was persisted successfully.");
  } else if(verified) {
    setFlowState("RECOVERED", "<b>Outcome verified.</b><br>The backend recorded a verified result. Check the event list below to see which recovery action was used.");
  } else if(tx && tx.status==="PENDING") {
    setFlowState("UNRESOLVED", "<b>Still awaiting confirmation.</b><br>The system is preserving a safe pending state instead of guessing that the payment succeeded.");
  } else if(events.length) {
    const last=events[0];
    setFlowState("RUNNING", `<b>${esc(pretty(last.eventType))}.</b><br>${esc(last.message||"Backend event received.")}`);
  }
}
function renderEvents(events, tx) {
  const list=$("liveEvents");
  if(!events.length) { list.innerHTML='<div class="empty-event">No events recorded for this transaction yet.</div>'; return; }
  list.innerHTML=events.slice(0,8).map(e=>`<article class="live-event"><span class="event-stage">${esc(e.stage||"SYSTEM")}</span><div><b>${esc(pretty(e.eventType))}</b><p>${esc(e.message||"")}</p></div><time>${esc(date(e.timestamp))}</time></article>`).join("");
  if(tx) {
    $("activeTransaction").textContent=tx.transactionId||"Transaction selected";
    const status=$("activeTransactionStatus"); status.textContent=String(tx.status||"UNKNOWN").replaceAll("_"," "); status.className="status-chip";
    if(tx.status==="SIMULATED_SUCCESS") status.classList.add("success"); else if(tx.status==="PENDING") status.classList.add("pending"); else status.classList.add("failed");
  }
  updateFlow(events,tx);
}
async function loadTimeline(transactionId=activeTransactionId) {
  try {
    const url=transactionId?`/api/reliability/events?limit=80&transactionId=${encodeURIComponent(transactionId)}`:"/api/reliability/events?limit=12";
    const events=await api(url);
    renderEvents(Array.isArray(events)?events:[], latestTransactions.find(t=>t.transactionId===transactionId));
  } catch(e) {
    $("liveEvents").innerHTML=`<div class="empty-event">Event stream unavailable: ${esc(e.message)}</div>`;
  }
}
async function loadHistory() {
  try {
    const [transactions,summary,health,gateway,circuit]=await Promise.all([
      api("/api/payments"),api("/api/reliability/summary"),api("/api/health"),api("/api/mock-gateway"),api("/api/circuit-breaker")
    ]);
    latestTransactions=Array.isArray(transactions)?transactions:[];
    const totals=summary.totals||{}; const recovery=summary.recovery||{};
    $("metricSuccess").textContent=totals.successful??latestTransactions.filter(t=>t.status==="SIMULATED_SUCCESS").length;
    $("metricPending").textContent=totals.pending??latestTransactions.filter(t=>t.status==="PENDING").length;
    $("metricRecovered").textContent=totals.recoveredIncidents??"—";
    $("metricRecoveryTime").textContent=recovery.averageMs==null?"No data":`${recovery.averageMs} ms`;
    $("metricRecoverySample").textContent=`${recovery.sampleSize||0} measured recovery${recovery.sampleSize===1?"":"ies"}`;
    $("gatewayMode").textContent=gateway.mode||"UNKNOWN";
    const circuitDetail = circuit.state === "OPEN"
      ? (circuit.remainingMs > 0 ? ` · ${Math.ceil(circuit.remainingMs / 1000)}s cooldown` : " · probe eligible")
      : circuit.state === "HALF_OPEN"
        ? (circuit.probeInProgress ? " · probe in progress" : " · testing recovery")
        : "";
    $("circuitMode").textContent = `Circuit: ${circuit.state || "UNKNOWN"}${circuitDetail}`;
    const healthy=health.status==="healthy";
    $("healthDot").className=`health-dot ${healthy?"good":"bad"}`;
    $("healthLabel").textContent=healthy?"Backend connected":"Backend degraded";
    renderHistory(latestTransactions);
    renderOutcomeChart(latestTransactions);
    lastEventCounts=summary.eventCounts||{}; drawEventChart(lastEventCounts);
    if(activeTransactionId) await loadTimeline(activeTransactionId);
  } catch(e) {
    $("healthDot").className="health-dot bad"; $("healthLabel").textContent="Connection issue";
    setScenarioMessage(`Could not refresh live data: ${e.message}`,"error");
  }
}
function renderHistory(rows) {
  const body=$("historyBody");
  if(!rows.length){body.innerHTML='<tr><td colspan="7" class="empty-cell">No payments yet. Create one or run a failure scenario.</td></tr>';return;}
  body.innerHTML=rows.slice(0,12).map(tx=>{
    const state=tx.status==="SIMULATED_SUCCESS"?"success":tx.status==="PENDING"?"pending":"failed";
    return `<tr><td><b>${esc(tx.transactionId)}</b></td><td>${esc(tx.studentName)}</td><td>${esc(tx.purpose)}</td><td>${esc(money(tx.amount))}</td><td><span class="status-badge ${state}">${esc(tx.status)}</span></td><td>${esc(date(tx.createdAt))}</td><td><button class="trace-button" data-trace="${esc(tx.transactionId)}" type="button">Trace flow</button></td></tr>`;
  }).join("");
  body.querySelectorAll("[data-trace]").forEach(btn=>btn.addEventListener("click",()=>{activeTransactionId=btn.dataset.trace;loadTimeline(activeTransactionId);document.querySelector(".flow-panel").scrollIntoView({behavior:"smooth",block:"center"});}));
}
function renderOutcomeChart(rows) {
  const success=rows.filter(t=>t.status==="SIMULATED_SUCCESS").length;
  const pending=rows.filter(t=>t.status==="PENDING").length;
  const problem=rows.filter(t=>!["SIMULATED_SUCCESS","PENDING"].includes(t.status)).length;
  const total=rows.length||0; const deg=total?success/total*360:0; const pendDeg=total?pending/total*360:0;
  $("outcomeRing").style.background=`conic-gradient(var(--green) 0deg ${deg}deg,var(--amber) ${deg}deg ${deg+pendDeg}deg,var(--red) ${deg+pendDeg}deg 360deg)`;
  $("outcomeTotal").textContent=total; $("outcomeSuccess").textContent=success; $("outcomePending").textContent=pending; $("outcomeProblem").textContent=problem;
}
function drawEventChart(counts) {
  const canvas=$("eventChart"), wrap=canvas.parentElement; const width=Math.max(280,wrap.clientWidth); const height=170; const dpr=window.devicePixelRatio||1;
  canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.width="100%";canvas.style.height=`${height}px`;
  const ctx=canvas.getContext("2d");ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
  const labels=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,6).reverse();
  if(!labels.length){$("chartEmpty").classList.remove("hidden");return;} $("chartEmpty").classList.add("hidden");
  const left=12,right=26,top=12,bottom=28,chartW=width-left-right,chartH=height-top-bottom,max=Math.max(1,...labels.map(x=>x[1]));
  ctx.font="10px DM Sans, sans-serif";ctx.textBaseline="middle";
  for(let i=0;i<4;i++){const y=top+i*chartH/3;ctx.strokeStyle="#29372f";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-right,y);ctx.stroke();}
  const slot=chartW/labels.length;const barW=Math.min(30,slot*.5);
  labels.forEach(([label,value],i)=>{const x=left+i*slot+(slot-barW)/2;const h=Math.max(3,value/max*(chartH-6));const y=top+chartH-h;const grad=ctx.createLinearGradient(0,y,0,y+h);grad.addColorStop(0,"#b4f38a");grad.addColorStop(1,"#4e9e6b");ctx.fillStyle=grad;ctx.beginPath();ctx.roundRect(x,y,barW,h,4);ctx.fill();ctx.fillStyle="#d9e8dc";ctx.textAlign="center";ctx.fillText(String(value),x+barW/2,Math.max(7,y-7));ctx.fillStyle="#91a49a";const short=label.replaceAll("_"," ").slice(0,9);ctx.fillText(short,x+barW/2,height-11);});
}
async function pollActiveEvents() {
  if (!activeTransactionId) return;
  await loadTimeline(activeTransactionId);
  if (!lastScenarioMode) return;
  const tx = latestTransactions.find(t => t.transactionId === activeTransactionId);
  if (!tx || tx.status !== "SIMULATED_SUCCESS") return;
  const events = await api(`/api/reliability/events?limit=80&transactionId=${encodeURIComponent(activeTransactionId)}`).catch(() => []);
  const verified = Array.isArray(events) && events.some(e => ["RECOVERY_VERIFIED", "PAYMENT_VERIFIED", "TRANSACTION_RECONCILED"].includes(e.eventType));
  if (verified) {
    setScenarioMessage(`${pretty(lastScenarioMode)}: backend recovery verified automatically. Transaction ${tx.transactionId} is now SIMULATED_SUCCESS.`, "success");
    lastScenarioMode = null;
  }
}
async function runPayment({scenario=null, count=1}={}) {
  if(activeScenario)return; activeScenario=true;setBusy(true);resetFlow();lastEventIds.clear();
  if (scenario) lastScenarioMode = scenario;
  const startedAt = Date.now();
  // Poll the persisted event stream while the request is still in flight so the
  // user sees the real backend events arrive instead of a prewritten animation.
  const watcher = setInterval(async () => {
    try {
      const events = await api("/api/reliability/events?limit=20");
      const created = (Array.isArray(events) ? events : []).find(e => e.eventType === "TRANSACTION_CREATED" && new Date(e.timestamp).getTime() >= startedAt - 1500);
      if (created && created.transactionId && !activeTransactionId) activeTransactionId = created.transactionId;
      if (created && created.transactionId) {
        activeTransactionId = created.transactionId;
        const tx = latestTransactions.find(t => t.transactionId === activeTransactionId) || null;
        const filtered = await api(`/api/reliability/events?limit=80&transactionId=${encodeURIComponent(activeTransactionId)}`);
        renderEvents(Array.isArray(filtered) ? filtered : [], tx);
      }
    } catch {}
  }, 450);
  const formData={studentName:$("studentName").value.trim()||"CampusPay Demo",purpose:$("purpose").value,amount:Number($("amount").value)};
  if(formData.studentName.length<2||!Number.isFinite(formData.amount)||formData.amount<=0||formData.amount>100000){setMessage("Enter a valid name and an amount between ₹1 and ₹100,000.","error");activeScenario=false;setBusy(false);return;}
  if(scenario){setScenarioMessage(`Injecting ${pretty(scenario).toLowerCase()}… the payment and recovery events will appear live.`);}
  else setMessage("Payment request sent. Watching the backend…");
  try {
    if(scenario) {
      const injection = await api("/api/mock-gateway/mode",{method:"POST",body:JSON.stringify({mode:scenario})});
      if (injection.autoRestoreAfterMs) setScenarioMessage(`${pretty(scenario)} injected. The mock fault window auto-restores in about ${Math.ceil(injection.autoRestoreAfterMs / 1000)} seconds; recovery will be verified from backend events.`);
    }
    let tx=null, latestResponse=null;
    for(let i=0;i<count;i++) {
      const payload={...formData,idempotencyKey:newKey()};
      const result=await request("/api/payments",{method:"POST",body:JSON.stringify(payload)});latestResponse=result;
      tx=result.data.transaction||tx;
      if(tx?.transactionId){activeTransactionId=tx.transactionId;$("activeTransaction").textContent=tx.transactionId;}
      await loadHistorySafe();
      if(count>1&&i<count-1)await new Promise(r=>setTimeout(r,180));
    }
    if(!tx) {
      if(latestResponse?.data?.transaction)tx=latestResponse.data.transaction;
      else if(latestResponse?.status===400)throw new Error(latestResponse.data.error||"Payment rejected.");
    }
    if(scenario==="LOST_RESPONSE"||scenario==="INVALID_RESPONSE") {
      setScenarioMessage("Failure observed. Asking the recovery worker to reconcile the stored outcome…");
      await new Promise(r=>setTimeout(r,650));
      await api("/api/recovery/run",{method:"POST",body:"{}"});
    }
    if(scenario==="UNAVAILABLE") {
      setScenarioMessage("Outage attempts sent. Checking the circuit-breaker state…");
    }
    if(scenario==="SLOW") setScenarioMessage("Slow gateway scenario finished. Check the measured events and transaction outcome.","success");
    else if(scenario) setScenarioMessage(`${pretty(scenario)} scenario submitted. The result below is loaded from persisted backend events.`,"success");
    else if(tx?.status==="SIMULATED_SUCCESS")setMessage(`Payment successful. Reference: ${tx.transactionId}`,"success");
    else setMessage(`Transaction status: ${tx?.status||latestResponse?.data?.message||"verification pending"}.`,"error");
    if(tx?.transactionId) activeTransactionId=tx.transactionId;
    await loadHistory(); await loadTimeline(activeTransactionId);
    if(scenario) {
      const currentTx=latestTransactions.find(t=>t.transactionId===activeTransactionId);
      const events=await api(`/api/reliability/events?limit=80&transactionId=${encodeURIComponent(activeTransactionId)}`).catch(()=>[]);
      const verified=(Array.isArray(events)?events:[]).some(e=>["RECOVERY_VERIFIED","PAYMENT_VERIFIED","TRANSACTION_RECONCILED"].includes(e.eventType));
      if(verified) {
        setScenarioMessage(`${pretty(scenario)} completed. The recorded events confirm a verified outcome.`,"success");
        lastScenarioMode = null;
      } else if(currentTx?.status==="PENDING") {
        setScenarioMessage(`${pretty(scenario)} detected. Transaction is pending while the automatic recovery worker retries/reconciles; watch this panel for the verified final state.`,"error");
      }
    }
  } catch(e) {
    setScenarioMessage(e.message,"error");setMessage(e.message,"error");setFlowState("FAILED",`<b>Action could not complete.</b><br>${esc(e.message)} Check backend connectivity and the recorded events.`);
  } finally {
    clearInterval(watcher); activeScenario=false;setBusy(false);await loadHistorySafe();
  }
}
async function loadHistorySafe(){try{const rows=await api("/api/payments");latestTransactions=Array.isArray(rows)?rows:[];renderHistory(latestTransactions);renderOutcomeChart(latestTransactions);}catch{}}
$("paymentForm").addEventListener("submit",async e=>{e.preventDefault();await runPayment();});
document.querySelectorAll("[data-scenario]").forEach(btn=>btn.addEventListener("click",()=>{
  const mode=btn.dataset.scenario;
  // One logical transaction per injection; bounded retries inside the resilience layer exercise the breaker.
  runPayment({scenario:mode,count:1});
}));
$("resetGateway").addEventListener("click",async()=>{try{const result=await api("/api/mock-gateway/reset",{method:"POST",body:"{}"});setScenarioMessage(`Gateway restored to ${result.mode}. The backend recovery worker will retry eligible pending transactions; the breaker closes only after a valid probe succeeds.`,`success`);await loadHistory();}catch(e){setScenarioMessage(e.message,"error");}});
$("refreshButton").addEventListener("click",loadHistory);
$("viewAllEvents").addEventListener("click",()=>window.open("/dashboard.html#timeline","_blank","noopener"));
async function start(){
  try {
    const status=await api("/api/dev/status");
    if(!status.controlsEnabled){document.querySelectorAll("[data-scenario],#resetGateway").forEach(b=>b.disabled=true);setScenarioMessage("Simulation controls are disabled. Enable them only in your local development environment.","error");}
  } catch {}
  await loadHistory();
  if(!activeTransactionId&&latestTransactions.length){activeTransactionId=latestTransactions[0].transactionId;}
  await loadTimeline(activeTransactionId);
  refreshTimer=setInterval(async()=>{if(!activeScenario){await loadHistory();await pollActiveEvents();}},3500);
}
window.addEventListener("resize",()=>drawEventChart(lastEventCounts));
start();

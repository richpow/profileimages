// FastTrack Avatar Refresh - one tap start, auto poll

const AUTH_TOKEN = "YOUR_TOOL_TOKEN_HERE";
const BASE = "https://profileimages-production.up.railway.app";
const TITLE = "Avatar refresh";
const STATE_FILE = "ft_avatar_job_state.json";
const POLL_SECONDS = 20;

const fm = FileManager.local();
const statePath = fm.joinPath(fm.documentsDirectory(), STATE_FILE);
const qp = args.queryParameters || {};
const action = qp.action || "";
const jobParam = qp.job || "";

let state = loadState(); // { job_id, total, completed, updated, failed, finishedAt, at }

// manual run inside Scriptable
if (!config.runsInWidget) {
  const a = new Alert();
  a.title = TITLE;
  a.message = "Choose";
  a.addAction("Start sweep");
  a.addAction("Check status");
  a.addCancelAction("Cancel");
  const i = await a.present();
  if (i === 0) state = await startJob();
  if (i === 1) state = await checkStatus(state.job_id || "");
  saveState(state);
  await showStatus(state);
  Script.complete();
}

// widget mode
if (config.runsInWidget) {
  if (action === "start") {
    state = await startJob();
    saveState(state);
  } else if (action === "status" && (jobParam || state.job_id)) {
    state = await checkStatus(jobParam || state.job_id);
    saveState(state);
  }
  const w = await buildWidget(state);
  Script.setWidget(w);
  Script.complete();
}

/* ---------- helpers ---------- */
async function startJob() {
  const req = new Request(`${BASE}/api/tools/avatar_refresh_start`);
  req.method = "POST";
  req.headers = { "Content-Type": "application/json", "Authorization": `Bearer ${AUTH_TOKEN}` };
  req.body = JSON.stringify({});
  const json = await req.loadJSON();
  if (!json?.ok) return { error: json?.reason || "start failed", at: new Date().toISOString() };
  return { job_id: json.job_id, total: json.total, completed: 0, updated: 0, failed: 0, finishedAt: null, at: new Date().toISOString() };
}
async function checkStatus(jobId) {
  if (!jobId) return { error: "no job", at: new Date().toISOString() };
  const req = new Request(`${BASE}/api/tools/avatar_refresh_status?job_id=${encodeURIComponent(jobId)}`);
  req.headers = { "Authorization": `Bearer ${AUTH_TOKEN}` };
  const json = await req.loadJSON();
  if (!json?.ok) return { error: json?.reason || "status failed", at: new Date().toISOString(), job_id: jobId };
  return {
    job_id: json.job_id,
    total: json.total,
    completed: json.completed,
    updated: json.updated,
    failed: json.failed,
    finishedAt: json.finishedAt || null,
    at: new Date().toISOString()
  };
}
function loadState() { try { if (fm.fileExists(statePath)) return JSON.parse(fm.readString(statePath)); } catch {} return {}; }
function saveState(s) { try { fm.writeString(statePath, JSON.stringify(s)); } catch {} }
async function showStatus(s) {
  const pct = s.total ? Math.floor(((s.completed || 0) / s.total) * 100) : 0;
  const msg = s?.job_id
    ? `Job: ${s.job_id}\nTotal: ${s.total || 0}\nDone: ${s.completed || 0}\nUpdated: ${s.updated || 0}\nFailed: ${s.failed || 0}\n${s.finishedAt ? "Finished" : "Running"} • ${pct}%`
    : (s?.error || "No job");
  const a = new Alert();
  a.title = TITLE;
  a.message = msg;
  a.addAction("OK");
  await a.present();
}

/* ---------- widget ---------- */
async function buildWidget(s) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#0C0D10");
  w.setPadding(12,12,12,12);

  const title = w.addText(TITLE);
  title.textColor = new Color("#E7E9EE");
  title.font = Font.boldSystemFont(14);
  w.addSpacer(6);

  if (!s?.job_id) {
    const hint = w.addText("Tap to start");
    hint.textColor = new Color("#D6B55F");
    hint.font = Font.mediumSystemFont(12);
    w.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&action=start`;
    return w;
  }

  const row = w.addStack(); row.layoutHorizontally();
  addStat(row, "Total", s.total || 0, "#A7AFBD"); addDivider(row);
  addStat(row, "Done", s.completed || 0, "#47D18C"); addDivider(row);
  addStat(row, "Upd", s.updated || 0, "#D6B55F"); addDivider(row);
  addStat(row, "Fail", s.failed || 0, "#E57373");
  w.addSpacer(6);

  const pct = s.total ? Math.floor(((s.completed || 0) / s.total) * 100) : 0;
  const line = w.addText(`${s.finishedAt ? "Finished" : "Running"} • ${pct}%`);
  line.textColor = new Color("#A7AFBD");
  line.font = Font.systemFont(11);

  const ts = w.addText(new Date(s.at || Date.now()).toLocaleString());
  ts.textColor = new Color("#A7AFBD");
  ts.font = Font.systemFont(10);

  w.refreshAfterDate = new Date(Date.now() + POLL_SECONDS * 1000);
  w.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&action=status&job=${encodeURIComponent(s.job_id)}`;
  return w;
}
function addStat(stack, label, val, colorHex) {
  const col = stack.addStack(); col.layoutVertically();
  const v = col.addText(String(val)); v.textColor = new Color(colorHex); v.font = Font.boldSystemFont(16);
  const l = col.addText(label); l.textColor = new Color("#A7AFBD"); l.font = Font.systemFont(10);
  stack.addSpacer(8);
}
function addDivider(stack) {
  const d = stack.addText("|");
  d.textColor = new Color("#2A2F3A");
  d.font = Font.systemFont(12);
  stack.addSpacer(8);
}

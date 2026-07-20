const tokenInput = document.querySelector("#admin-token");
const loginPanel = document.querySelector("#login-panel");
const dashboard = document.querySelector("#dashboard");
const errorNode = document.querySelector("#login-error");
const metrics = document.querySelector("#metrics");
const sourceRows = document.querySelector("#source-rows");
const updatedAt = document.querySelector("#updated-at");
let token = sessionStorage.getItem("rail-admin-token") || "";
let endpoint = "/api/admin/overview";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU");
}

function metric(label, value) {
  const node = document.createElement("article");
  node.className = "metric";
  const caption = document.createElement("span");
  caption.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value == null ? "—" : String(value);
  node.append(caption, number);
  return node;
}

function render(data) {
  metrics.replaceChildren(
    metric("Активных рейсов", data.snapshot?.updates ?? data.runs?.total),
    metric("Рейсов в БД", data.runs?.total),
    metric("Событий в БД", data.events?.total),
    metric("Возраст снимка", data.snapshot?.generatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(data.snapshot.generatedAt)) / 60000)) + " мин" : "—"),
  );
  sourceRows.replaceChildren();
  for (const source of data.sources || []) {
    const row = document.createElement("tr");
    for (const value of [source.source_id, source.status, formatDate(source.checked_at), source.records_count ?? "—", source.error || "—"]) {
      const cell = document.createElement("td");
      cell.textContent = String(value ?? "—");
      row.append(cell);
    }
    row.children[1].className = "status " + String(source.status || "").toLowerCase();
    sourceRows.append(row);
  }
  updatedAt.textContent = "Диагностика получена: " + formatDate(data.checkedAt);
}

async function loadConfig() {
  try {
    const response = await fetch("data/runtime-config.json", { cache: "no-store" });
    const config = await response.json();
    if (config.apiBase) {
      const base = config.apiBase.endsWith("/") ? config.apiBase.slice(0, -1) : config.apiBase;
      endpoint = new URL("/api/admin/overview", base + "/").toString();
    }
  } catch {}
}

async function refresh() {
  errorNode.textContent = "";
  const response = await fetch(endpoint, { cache: "no-store", headers: { Authorization: "Bearer " + token } });
  if (response.status === 401) throw new Error("Неверный ключ администратора");
  if (!response.ok) throw new Error("Backend ответил HTTP " + response.status);
  render(await response.json());
  loginPanel.hidden = true;
  dashboard.hidden = false;
}

async function login() {
  token = tokenInput.value.trim();
  if (!token) return;
  try {
    await refresh();
    sessionStorage.setItem("rail-admin-token", token);
    tokenInput.value = "";
  } catch (error) {
    errorNode.textContent = error.message;
  }
}

document.querySelector("#login-button").addEventListener("click", login);
tokenInput.addEventListener("keydown", (event) => { if (event.key === "Enter") login(); });
document.querySelector("#refresh-button").addEventListener("click", () => refresh().catch((error) => { updatedAt.textContent = error.message; }));
document.querySelector("#logout-button").addEventListener("click", () => {
  token = "";
  sessionStorage.removeItem("rail-admin-token");
  dashboard.hidden = true;
  loginPanel.hidden = false;
});
await loadConfig();
if (token) refresh().catch(() => { sessionStorage.removeItem("rail-admin-token"); token = ""; });
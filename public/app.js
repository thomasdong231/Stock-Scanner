const formFields = [
  "query",
  "sector",
  "minPrice",
  "maxPrice",
  "minVolume",
  "minChange",
  "maxChange",
  "minMarketCap",
  "sortBy",
  "direction",
  "limit"
];

const els = Object.fromEntries(formFields.map((id) => [id, document.getElementById(id)]));
const scanButton = document.getElementById("scanButton");
const refreshButton = document.getElementById("refreshButton");
const exportButton = document.getElementById("exportButton");
const resultCount = document.getElementById("resultCount");
const sourceStatus = document.getElementById("sourceStatus");
const resultsBody = document.getElementById("resultsBody");
const aboveVwap = document.getElementById("aboveVwap");
const ema9AboveEma21 = document.getElementById("ema9AboveEma21");

let currentResults = [];
let sectorLoaded = false;

function formatCurrency(value) {
  if (value == null) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 10 ? 2 : 2
  }).format(value);
}

function formatNumber(value) {
  if (value == null) return "-";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatMarketCap(value) {
  if (value == null) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return formatCurrency(value);
}

function formatPercent(value) {
  if (value == null) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signedClass(value) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "";
}

function paramsFromForm() {
  const params = new URLSearchParams();
  for (const id of formFields) {
    const value = els[id].value.trim();
    if (value !== "") params.set(id, value);
  }
  if (aboveVwap.checked) params.set("aboveVwap", "true");
  if (ema9AboveEma21.checked) params.set("ema9AboveEma21", "true");
  return params;
}

function renderRows(rows) {
  resultCount.textContent = String(rows.length);
  if (!rows.length) {
    resultsBody.innerHTML = `<tr><td colspan="13" class="empty">No stocks matched those criteria.</td></tr>`;
    return;
  }

  resultsBody.innerHTML = rows
    .map((row) => {
      const changeClass = signedClass(row.netChange);
      const percentClass = signedClass(row.percentChange);
      return `
        <tr>
          <td><a class="symbol" href="${row.url}" target="_blank" rel="noreferrer">${row.symbol}</a></td>
          <td class="company">${row.name || "-"}</td>
          <td class="num">${formatCurrency(row.price)}</td>
          <td class="num">${formatCurrency(row.vwap)}</td>
          <td class="num ${signedClass(row.vwapDistancePercent)}">${formatPercent(row.vwapDistancePercent)}</td>
          <td class="num ${row.ema9AboveEma21 ? "positive" : ""}">${formatCurrency(row.ema9)}</td>
          <td class="num">${formatCurrency(row.ema21)}</td>
          <td class="num ${changeClass}">${row.netChange == null ? "-" : `${row.netChange > 0 ? "+" : ""}${row.netChange.toFixed(2)}`}</td>
          <td class="num ${percentClass}">${formatPercent(row.percentChange)}</td>
          <td class="num">${formatNumber(row.volume)}</td>
          <td class="num">${formatMarketCap(row.marketCap)}</td>
          <td>${row.sector || "-"}</td>
          <td>${row.industry || "-"}</td>
        </tr>
      `;
    })
    .join("");
}

function renderSectors(sectors) {
  if (sectorLoaded) return;
  const existing = els.sector.value;
  els.sector.innerHTML = `<option value="">All sectors</option>${sectors
    .map((sector) => `<option value="${sector}">${sector}</option>`)
    .join("")}`;
  els.sector.value = existing;
  sectorLoaded = true;
}

async function scan() {
  scanButton.disabled = true;
  refreshButton.disabled = true;
  sourceStatus.textContent = aboveVwap.checked || ema9AboveEma21.checked
    ? "Applying basic filters and TradingView indicators..."
    : "Scanning U.S. listings...";

  try {
    const response = await fetch(`/api/scan?${paramsFromForm().toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Scan failed");

    currentResults = payload.results || [];
    renderSectors(payload.sectors || []);
    renderRows(currentResults);
    const asOf = payload.asOf ? new Date(payload.asOf).toLocaleString() : "unknown";
    const indicatorSource = payload.vwapAvailable ? "TradingView indicators" : "indicators unavailable";
    sourceStatus.textContent = `Sources: Nasdaq + ${indicatorSource} · Universe: ${formatNumber(payload.totalUniverse)} · Updated: ${asOf}`;
  } catch (error) {
    currentResults = [];
    resultCount.textContent = "0";
    resultsBody.innerHTML = `<tr><td colspan="13" class="empty">${error.message}</td></tr>`;
    sourceStatus.textContent = "Scan failed";
  } finally {
    scanButton.disabled = false;
    refreshButton.disabled = false;
  }
}

function exportCsv() {
  if (!currentResults.length) return;
  const headers = ["Symbol", "Company", "Price", "VWAP", "% vs VWAP", "Daily EMA 9", "Daily EMA 21", "Daily EMA 9 > 21", "Net Change", "% Change", "Volume", "Market Cap", "Sector", "Industry"];
  const rows = currentResults.map((row) => [
    row.symbol,
    row.name,
    row.price,
    row.vwap,
    row.vwapDistancePercent,
    row.ema9,
    row.ema21,
    row.ema9AboveEma21,
    row.netChange,
    row.percentChange,
    row.volume,
    row.marketCap,
    row.sector,
    row.industry
  ]);
  const csv = [headers, ...rows]
    .map((line) => line.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stock-scan-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

scanButton.addEventListener("click", scan);
refreshButton.addEventListener("click", scan);
exportButton.addEventListener("click", exportCsv);

for (const field of formFields) {
  els[field].addEventListener("keydown", (event) => {
    if (event.key === "Enter") scan();
  });
}

aboveVwap.addEventListener("keydown", (event) => {
  if (event.key === "Enter") scan();
});

ema9AboveEma21.addEventListener("keydown", (event) => {
  if (event.key === "Enter") scan();
});

scan();

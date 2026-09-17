import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 4173);
const NASDAQ_URL =
  "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true";
const TRADINGVIEW_URL = "https://scanner.tradingview.com/america/scan";
const CACHE_MS = 60_000;

let cachedAt = 0;
let cachedRows = [];
let cachedVwapAt = 0;
let cachedVwapBySymbol = new Map();

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  Referer: "https://www.nasdaq.com/market-activity/stocks/screener"
};

const tradingViewHeaders = {
  "Content-Type": "application/json",
  "User-Agent": headers["User-Agent"],
  Origin: "https://www.tradingview.com",
  Referer: "https://www.tradingview.com/"
};

const tradingViewBody = {
  filter: [
    {
      left: "exchange",
      operation: "in_range",
      right: ["AMEX", "NASDAQ", "NYSE"]
    }
  ],
  options: { lang: "en" },
  symbols: { query: { types: [] }, tickers: [] },
  columns: ["name", "close", "change", "volume", "VWAP", "EMA9", "EMA21"],
  range: [0, 20_000]
};

function toNumber(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[$,%\s,]/g, "");
  if (cleaned === "" || cleaned.toUpperCase() === "N/A") return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function normalizeRow(row) {
  return {
    symbol: row.symbol || "",
    name: row.name || "",
    price: toNumber(row.lastsale),
    netChange: toNumber(row.netchange),
    percentChange: toNumber(row.pctchange),
    volume: toNumber(row.volume),
    marketCap: toNumber(row.marketCap),
    sector: row.sector || "",
    industry: row.industry || "",
    country: row.country || "",
    ipoYear: row.ipoyear || "",
    url: row.url ? `https://www.nasdaq.com${row.url}` : ""
  };
}

async function loadStocks() {
  const now = Date.now();
  if (cachedRows.length && now - cachedAt < CACHE_MS) return cachedRows;

  const response = await fetch(NASDAQ_URL, { headers });
  if (!response.ok) {
    throw new Error(`Nasdaq request failed with ${response.status}`);
  }

  const payload = await response.json();
  const rows = payload?.data?.rows || payload?.data?.table?.rows || [];
  cachedRows = rows.map(normalizeRow).filter((row) => row.symbol && row.price != null);
  cachedAt = now;
  return cachedRows;
}

async function loadVwapSnapshot() {
  const now = Date.now();
  if (cachedVwapBySymbol.size && now - cachedVwapAt < CACHE_MS) {
    return cachedVwapBySymbol;
  }

  const response = await fetch(TRADINGVIEW_URL, {
    method: "POST",
    headers: tradingViewHeaders,
    body: JSON.stringify(tradingViewBody)
  });
  if (!response.ok) {
    throw new Error(`TradingView VWAP request failed with ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.data)) {
    throw new Error("TradingView returned an invalid VWAP response");
  }

  const vwapBySymbol = new Map();
  for (const item of payload.data) {
    const [symbol, price, percentChange, volume, vwap, ema9, ema21] = item?.d || [];
    if (!symbol || !Number.isFinite(price)) continue;

    const previousClose =
      Number.isFinite(percentChange) && percentChange !== -100
        ? price / (1 + percentChange / 100)
        : null;
    const hasVwap = Number.isFinite(vwap) && vwap > 0;
    vwapBySymbol.set(String(symbol).toUpperCase(), {
      price,
      netChange: previousClose == null ? null : price - previousClose,
      percentChange: Number.isFinite(percentChange) ? percentChange : null,
      volume: Number.isFinite(volume) ? volume : null,
      vwap: hasVwap ? vwap : null,
      vwapDistancePercent: hasVwap ? ((price - vwap) / vwap) * 100 : null,
      aboveVwap: hasVwap ? price > vwap : null,
      ema9: Number.isFinite(ema9) ? ema9 : null,
      ema21: Number.isFinite(ema21) ? ema21 : null,
      ema9AboveEma21: Number.isFinite(ema9) && Number.isFinite(ema21) ? ema9 > ema21 : null
    });
  }

  if (!vwapBySymbol.size) {
    throw new Error("TradingView returned no usable indicator values");
  }

  cachedVwapBySymbol = vwapBySymbol;
  cachedVwapAt = now;
  return cachedVwapBySymbol;
}

function enrichWithVwap(rows, vwapBySymbol) {
  return rows.map((row) => {
    const vwapData = vwapBySymbol.get(row.symbol.toUpperCase());
    return {
      ...row,
      price: vwapData?.price ?? row.price,
      netChange: vwapData?.netChange ?? row.netChange,
      percentChange: vwapData?.percentChange ?? row.percentChange,
      volume: vwapData?.volume ?? row.volume,
      vwap: vwapData?.vwap ?? null,
      vwapDistancePercent: vwapData?.vwapDistancePercent ?? null,
      aboveVwap: vwapData?.aboveVwap ?? null,
      ema9: vwapData?.ema9 ?? null,
      ema21: vwapData?.ema21 ?? null,
      ema9AboveEma21: vwapData?.ema9AboveEma21 ?? null
    };
  });
}

function numberParam(params, key) {
  const raw = params.get(key);
  if (raw == null || raw === "") return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function applyFilters(rows, params) {
  const query = (params.get("query") || "").trim().toUpperCase();
  const sector = params.get("sector") || "";
  const minPrice = numberParam(params, "minPrice");
  const maxPrice = numberParam(params, "maxPrice");
  const minVolume = numberParam(params, "minVolume");
  const minChange = numberParam(params, "minChange");
  const maxChange = numberParam(params, "maxChange");
  const minMarketCap = numberParam(params, "minMarketCap");
  const maxMarketCap = numberParam(params, "maxMarketCap");
  const aboveVwap = params.get("aboveVwap") === "true";
  const ema9AboveEma21 = params.get("ema9AboveEma21") === "true";
  const requestedSort = params.get("sortBy") || "volume";
  const sortableFields = new Set([
    "symbol",
    "price",
    "percentChange",
    "volume",
    "marketCap",
    "vwap",
    "vwapDistancePercent",
    "ema9",
    "ema21"
  ]);
  const sortBy = sortableFields.has(requestedSort) ? requestedSort : "volume";
  const direction = params.get("direction") === "asc" ? 1 : -1;
  const limit = Math.min(Math.max(Number(params.get("limit") || 100), 10), 500);

  const filtered = rows.filter((row) => {
    if (query && !row.symbol.includes(query) && !row.name.toUpperCase().includes(query)) return false;
    if (sector && row.sector !== sector) return false;
    if (minPrice != null && (row.price == null || row.price < minPrice)) return false;
    if (maxPrice != null && (row.price == null || row.price > maxPrice)) return false;
    if (minVolume != null && (row.volume == null || row.volume < minVolume)) return false;
    if (minChange != null && (row.percentChange == null || row.percentChange < minChange)) return false;
    if (maxChange != null && (row.percentChange == null || row.percentChange > maxChange)) return false;
    if (minMarketCap != null && (row.marketCap == null || row.marketCap < minMarketCap)) return false;
    if (maxMarketCap != null && (row.marketCap == null || row.marketCap > maxMarketCap)) return false;
    if (aboveVwap && row.aboveVwap !== true) return false;
    if (ema9AboveEma21 && row.ema9AboveEma21 !== true) return false;
    return true;
  });

  const sorted = filtered.sort((a, b) => {
    const left = a[sortBy];
    const right = b[sortBy];
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === "string" || typeof right === "string") {
      return String(left || "").localeCompare(String(right || "")) * direction;
    }
    return (left - right) * direction;
  });

  return sorted.slice(0, limit);
}

async function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      ext === ".html" ? "text/html; charset=utf-8" : ext === ".css" ? "text/css; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(file);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/scan") {
      const rows = await loadStocks();
      let vwapBySymbol = new Map();
      let vwapError = null;

      try {
        vwapBySymbol = await loadVwapSnapshot();
      } catch (error) {
        vwapError = error;
      }

      const requiresVwap =
        url.searchParams.get("aboveVwap") === "true" ||
        url.searchParams.get("ema9AboveEma21") === "true" ||
        ["vwap", "vwapDistancePercent", "ema9", "ema21"].includes(url.searchParams.get("sortBy"));
      if (requiresVwap && vwapError) {
        return sendJson(res, 503, {
          error: "TradingView indicator data is temporarily unavailable. Basic scanner filters are still available."
        });
      }

      const sectors = [...new Set(rows.map((row) => row.sector).filter(Boolean))].sort();
      return sendJson(res, 200, {
        asOf: new Date(cachedAt).toISOString(),
        vwapAsOf: vwapBySymbol.size ? new Date(cachedVwapAt).toISOString() : null,
        vwapAvailable: vwapBySymbol.size > 0,
        totalUniverse: rows.length,
        sectors,
        results: applyFilters(enrichWithVwap(rows, vwapBySymbol), url.searchParams)
      });
    }

    if (url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true });
    }

    return serveStatic(req, res);
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Stock scanner running at http://localhost:${PORT}`);
});

/* ═══════════════════════════════════════════════════════════════════
 * CÜZZY — BIST fiyat proxy'si  (server.py'nin Cloudflare Pages Function karşılığı)
 *
 * Yol:   /api/bist?symbols=THYAO,GARAN,AKBNK,...
 * Çıktı: { prices: { THYAO: 327.0, ... }, count, requested, source, ok, errorCount }
 *
 * Cloudflare Pages, functions/api/bist.js dosyasını otomatik olarak
 * /api/bist yoluna bağlar. Client zaten relative `/api/bist` çağırıyor,
 * yani aynı origin → CORS gerekmiyor, connect-src değişikliği gerekmiyor.
 * ═══════════════════════════════════════════════════════════════════ */

const CHUNK_SIZE = 20;
const YAHOO_HOSTS = ['query1', 'query2'];

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*', // same-origin'de gereksiz; standalone Worker'a taşırsan işe yarar
};

/* server.py to_float: sayıya çevrilebiliyorsa ve > 0 ise değeri, değilse 0 döner. */
function toFloat(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

/* server.py fetch_yahoo_json: query1 patlarsa query2'yi dener; ikisi de
   başarısızsa son hatayı fırlatır. */
async function fetchYahooJson(path) {
  let lastError = null;
  for (const host of YAHOO_HOSTS) {
    const url = `https://${host}.finance.yahoo.com${path}`;
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        cf: { cacheTtl: 0 }, // Yahoo fiyatını CF kenarında cache'leme
      });
      if (!resp.ok) {
        lastError = new Error(`HTTP ${resp.status} @ ${host}`);
        continue;
      }
      return await resp.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('yahoo fetch failed');
}

/* indicators.quote[0].close dizisindeki son geçerli (>0) kapanışı bulur.
   Hem spark response[0] hem de chart result[0] aynı şekle sahip. */
function lastValidClose(node) {
  const closes = node?.indicators?.quote?.[0]?.close || [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const price = toFloat(closes[i]);
    if (price > 0) return price;
  }
  return 0;
}

/* ── ANA MANTIK (test edilebilir, saf fonksiyon) ────────────────────
   Yahoo'ya erişimi `fetchJson` üzerinden alır; böylece data.json ile
   ağ olmadan lokalde doğrulanabiliyor. */
export async function resolvePrices(symbols, fetchJson) {
  const prices = {};
  const errors = [];

  // 1) Toplu spark sorgusu (20'lik parçalar)
  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk = symbols.slice(i, i + CHUNK_SIZE);
    const query = encodeURIComponent(chunk.map(sym => `${sym}.IS`).join(','));

    let data = null;
    try {
      data = await fetchJson(`/v7/finance/spark?symbols=${query}&range=1d&interval=5m`);
    } catch (err) {
      errors.push(String(err));
    }
    if (!data) continue;

    const results = data?.spark?.result || [];
    for (const item of results) {
      const symbol = String(item?.symbol || '').toUpperCase();
      if (!symbol.endsWith('.IS')) continue;

      const response = (item?.response || [{}])[0] || {};
      let price = toFloat(response?.meta?.regularMarketPrice);
      if (price <= 0) price = lastValidClose(response);
      if (price > 0) prices[symbol.replace('.IS', '')] = price;
    }
  }

  // 2) Spark'ta bulunamayanlar için tekil chart fallback
  const missing = symbols.filter(sym => !(sym in prices));
  for (const sym of missing) {
    try {
      const data = await fetchJson(`/v8/finance/chart/${sym}.IS?range=1d&interval=5m`);
      const result = (data?.chart?.result || [null])[0];
      if (!result) continue;
      let price = toFloat(result?.meta?.regularMarketPrice);
      if (price <= 0) price = lastValidClose(result);
      if (price > 0) prices[sym] = price;
    } catch (err) {
      errors.push(String(err));
    }
  }

  return { prices, errors };
}

/* ── HTTP GİRİŞİ ──────────────────────────────────────────────────── */
export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const rawSymbols = url.searchParams.get('symbols') || '';

  // server.py ile aynı sanitizasyon: strip + upper + sadece [A-Z0-9_]
  const symbols = rawSymbols
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s && /^[A-Z0-9_]+$/.test(s));

  if (symbols.length === 0) {
    return jsonResponse(400, { error: 'symbols param required' });
  }

  const { prices, errors } = await resolvePrices(symbols, fetchYahooJson);
  const count = Object.keys(prices).length;

  return jsonResponse(count > 0 ? 200 : 502, {
    prices,
    count,
    requested: symbols.length,
    source: 'yahoo-spark-via-cf-pages-function',
    ok: count > 0,
    errorCount: errors.length,
  });
}

/* CORS preflight (same-origin'de tetiklenmez ama zararsız) */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
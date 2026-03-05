// netlify/functions/prices.js — v2 con conversión CAD/SEK/GBp/USD
const https = require('https');
const http = require('http');

const ISIN_TO_YAHOO = {
  'ES0134950F36': 'FAE.MC', 'ES0125220311': 'ANA.MC', 'ES0132105018': 'ACX.MC',
  'ES0105687000': 'EST.MC', 'FR0000121485': 'KER.PA', 'FR0000121014': 'MC.PA',
  'DE000PAG9113': 'P911_p.DE', 'SE0015949201': 'LIFCO-B.ST',
  'US6877931096': 'OSCR', 'US0044685008': 'ACLS', 'US01609W1027': 'BABA',
  'US7223041028': 'PDD', 'US02079K3059': 'GOOGL', 'US0231351067': 'AMZN',
  'US0378331005': 'AAPL', 'US0381692070': 'APLD', 'US00217D1000': 'ASTS',
  'CA06849F1080': 'GOLD', 'CA13321L1085': 'CCJ', 'US21036P1084': 'STZ',
  'NL0010556684': 'XPRO', 'BMG9456A1009': 'GLNG', 'US44862P2083': 'HYMC',
  'US4581401001': 'INTC', 'US49177J1025': 'KVUE', 'CA50077N1024': 'PNG.V',
  'IE00BF16M727': 'CIBR.L', 'IE000OJ5TQP4': 'NATO.L', 'IE00BSPLC413': 'ZPRV.DE',
  'IE000YYE6WK5': 'DFND.AS', 'IE00B3XXRP09': 'VUSA.L',
};

const TICKER_CURRENCY = {
  'FAE.MC':'EUR','ANA.MC':'EUR','ACX.MC':'EUR','EST.MC':'EUR',
  'KER.PA':'EUR','MC.PA':'EUR','P911_p.DE':'EUR','ZPRV.DE':'EUR','DFND.AS':'EUR',
  'CIBR.L': 'GBp', 'NATO.L': 'GBp', 'VUSA.L': 'GBp', 'ZEG.L': 'GBp',
  'LIFCO-B.ST':'SEK','PNG.V':'CAD','EURUSD=X': 'RAW',
'GC=F': 'RAW',
'SI=F': 'RAW',
'BTC-USD': 'RAW',
'^GSPC': 'RAW',
'^IXIC': 'RAW',
'^IBEX': 'RAW',
'^STOXX50E': 'RAW',
'URTH': 'RAW',
'IEUR.L': 'RAW',
'^FCHI': 'RAW',
'^GDAXI': 'RAW',
'^EURIBOR3M': 'RAW',
};

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html,application/json,*/*;q=0.8',
        ...extraHeaders
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchYahoo(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetchUrl(url, { 'Accept': 'application/json' });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice || meta.previousClose;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    return { price, change24h: prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0 };
  } catch (e) { return null; }
}

async function fetchFTFund(isin) {
  try {
    const url = `https://markets.ft.com/data/funds/tearsheet/summary?s=${isin}:EUR`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;
    const m1 = res.body.match(/"price"\s*:\s*\{\s*"value"\s*:\s*([\d.]+)/);
    if (m1) return parseFloat(m1[1]);
    const m2 = res.body.match(/class="mod-ui-data-list__value"[^>]*>\s*([\d,\.]+)/);
    if (m2) { const v = parseFloat(m2[1].replace(/,/g,'')); if (!isNaN(v) && v > 0) return v; }
    const m3 = res.body.match(/"lastPrice"\s*:\s*"?([\d.]+)"?/);
    if (m3) { const v = parseFloat(m3[1]); if (!isNaN(v) && v > 0) return v; }
    return null;
  } catch (e) { return null; }
}

async function fetchCrypto(coin) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=eur&include_24hr_change=true`;
    const res = await fetchUrl(url, { 'Accept': 'application/json' });
    if (res.status !== 200) return null;
    const d = JSON.parse(res.body)[coin];
    if (!d) return null;
    return { price: d.eur, change24h: d.eur_24h_change || 0 };
  } catch (e) { return null; }
}

async function fetchFXRates() {
  const rates = { EUR:1, USD:0.92, GBP:1.17, SEK:0.087, CAD:0.68 };
  await Promise.all([['USD','EURUSD=X'],['GBP','EURGBP=X'],['SEK','EURSEK=X'],['CAD','EURCAD=X']].map(async ([cur, ticker]) => {
    try { const d = await fetchYahoo(ticker); if (d && d.price) rates[cur] = 1 / d.price; } catch(e) {}
  }));
  return rates;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const p = event.queryStringParameters || {};
    const isins   = (p.isins   || '').split(',').filter(Boolean);
    const tickers = (p.tickers || '').split(',').filter(Boolean);
    const cryptos = (p.cryptos || '').split(',').filter(Boolean);
    const results = {}, errors = {}, BATCH = 6;

    const fxPromise = fetchFXRates();

    for (let i = 0; i < isins.length; i += BATCH) {
      await Promise.all(isins.slice(i, i+BATCH).map(async isin => {
        const price = await fetchFTFund(isin);
        if (price !== null && price > 0) results[isin] = { price, change24h:0, source:'Financial Times', currency:'EUR' };
        else errors[isin] = 'no data';
      }));
      if (i + BATCH < isins.length) await new Promise(r => setTimeout(r, 300));
    }

    const fxRates = await fxPromise;
    const resolved = tickers.map(t => ({ original:t, yahoo: ISIN_TO_YAHOO[t.toUpperCase()] || t }));

    for (let i = 0; i < resolved.length; i += BATCH) {
      await Promise.all(resolved.slice(i, i+BATCH).map(async ({ original, yahoo }) => {
        const data = await fetchYahoo(yahoo);
        if (data) {
          const cur = TICKER_CURRENCY[yahoo] || 'USD';
          let price = cur === 'GBp' ? (data.price / 100) * fxRates.GBP
                    : cur !== 'EUR' ? data.price * (fxRates[cur] || 1)
                    : data.price;
          results[original] = { price, change24h: data.change24h, source:'Yahoo Finance', currency:cur, originalPrice:data.price };
        } else errors[original] = 'no data';
      }));
    }

    const CRYPTO_MAP = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana' };
    for (const c of cryptos) {
      const data = await fetchCrypto(CRYPTO_MAP[c.toUpperCase()] || c.toLowerCase());
      if (data) results[c] = { price:data.price, change24h:data.change24h, source:'CoinGecko', currency:'EUR' };
      else errors[c] = 'no data';
    }

    return { statusCode:200, headers, body: JSON.stringify({ prices:results, errors, fxRates, usdEur:fxRates.USD, timestamp:new Date().toISOString() }) };
  } catch (e) {
    return { statusCode:500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

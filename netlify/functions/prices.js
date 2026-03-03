// netlify/functions/prices.js
// Fetches fund NAVs from Financial Times and stock prices from Yahoo Finance
// Runs on Netlify's server — no CORS issues

const https = require('https');
const http = require('http');

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        ...headers
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Parse NAV from Financial Times fund page
async function fetchFTFund(isin) {
  try {
    const url = `https://markets.ft.com/data/funds/tearsheet/summary?s=${isin}:EUR`;
    const res = await fetchUrl(url);
    if (res.status !== 200) return null;

    // Extract price from JSON-LD or HTML
    // FT embeds data in a <script type="application/json"> tag
    const jsonMatch = res.body.match(/"price"\s*:\s*{\s*"value"\s*:\s*([\d.]+)/);
    if (jsonMatch) return parseFloat(jsonMatch[1]);

    // Fallback: look for the price in the page HTML
    const priceMatch = res.body.match(/class="mod-ui-data-list__value"[^>]*>\s*([\d,\.]+)/);
    if (priceMatch) {
      const raw = priceMatch[1].replace(/,/g, '');
      const val = parseFloat(raw);
      if (!isNaN(val) && val > 0) return val;
    }

    // Second fallback: look for price in different HTML patterns
    const patterns = [
      /Price\s*<\/[^>]+>\s*<[^>]+>\s*([\d,\.]+)/i,
      /"lastPrice"\s*:\s*"?([\d.]+)"?/,
      /data-price="([\d.]+)"/,
    ];
    for (const pat of patterns) {
      const m = res.body.match(pat);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        if (!isNaN(val) && val > 0) return val;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Parse stock price from Yahoo Finance
async function fetchYahoo(ticker) {
  try {
    // Yahoo Finance API v8
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
    const res = await fetchUrl(url, { 'Accept': 'application/json' });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice || meta.previousClose;
    const prevClose = meta.previousClose || meta.chartPreviousClose;
    const change24h = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    return { price, change24h };
  } catch (e) {
    return null;
  }
}

// Fetch BTC/EUR from CoinGecko
async function fetchCrypto(coin) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=eur&include_24hr_change=true`;
    const res = await fetchUrl(url, { 'Accept': 'application/json' });
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const coinData = data[coin];
    if (!coinData) return null;
    return { price: coinData.eur, change24h: coinData.eur_24h_change || 0 };
  } catch (e) {
    return null;
  }
}

// Yahoo ticker map for Spanish/European stocks
const YAHOO_MAP = {
  'FAE.MC': 'FAE.MC',
  'ANA.MC': 'ANA.MC',
  'ACX.MC': 'ACX.MC',
  'KER.PA': 'KER.PA',
  'MC.PA':  'MC.PA',
  'GOOGL':  'GOOGL',
  'AMZN':   'AMZN',
  'AAPL':   'AAPL',
  'GOLD':   'GOLD',
  'KVUE':   'KVUE',
  // ETFs with Yahoo tickers
  'IE00BF16M727': 'CIBR.L',
  'IE000OJ5TQP4': 'NATO.L',
  'IE00B3XXRP09': 'VUSA.L',
};

// USD tickers that need EUR conversion
const USD_TICKERS = new Set(['GOOGL','AMZN','AAPL','GOLD','KVUE']);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const isins = (params.isins || '').split(',').filter(Boolean);
    const tickers = (params.tickers || '').split(',').filter(Boolean);
    const cryptos = (params.cryptos || '').split(',').filter(Boolean);

    const results = {};
    const errors = {};

    // Fetch USD/EUR rate
    let usdEur = 0.92;
    try {
      const fxRes = await fetchYahoo('EURUSD=X');
      if (fxRes?.price) usdEur = 1 / fxRes.price;
    } catch (e) {}

    // Fetch funds via FT (parallel, max 6 at a time to avoid rate limits)
    const BATCH = 6;
    for (let i = 0; i < isins.length; i += BATCH) {
      const batch = isins.slice(i, i + BATCH);
      const promises = batch.map(async (isin) => {
        const price = await fetchFTFund(isin);
        if (price !== null && price > 0) {
          results[isin] = { price, change24h: 0, source: 'Financial Times' };
        } else {
          errors[isin] = 'no data';
        }
      });
      await Promise.all(promises);
      // Small delay between batches
      if (i + BATCH < isins.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Fetch stocks via Yahoo
    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH);
      const promises = batch.map(async (ticker) => {
        const yahooTicker = YAHOO_MAP[ticker] || ticker;
        const data = await fetchYahoo(yahooTicker);
        if (data) {
          let price = data.price;
          // Convert USD to EUR if needed
          if (USD_TICKERS.has(ticker)) {
            price = price * usdEur;
          }
          results[ticker] = { price, change24h: data.change24h, source: 'Yahoo Finance' };
        } else {
          errors[ticker] = 'no data';
        }
      });
      await Promise.all(promises);
    }

    // Fetch crypto via CoinGecko
    const CRYPTO_MAP = { 'BTC': 'bitcoin', 'ETH': 'ethereum' };
    for (const c of cryptos) {
      const coinId = CRYPTO_MAP[c] || c.toLowerCase();
      const data = await fetchCrypto(coinId);
      if (data) {
        results[c] = { price: data.price, change24h: data.change24h, source: 'CoinGecko' };
      } else {
        errors[c] = 'no data';
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ prices: results, errors, usdEur, timestamp: new Date().toISOString() })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message })
    };
  }
};

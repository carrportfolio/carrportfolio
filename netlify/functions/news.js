const https = require('https');
const http = require('http');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*'
      },
      timeout: 8000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function(){ this.destroy(); reject(new Error('timeout')); });
  });
}

function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = tag => {
      const m = block.match(new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>'));
      return m ? m[1].trim() : '';
    };
    const title = get('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#\d+;/g,'');
    const link = get('link') || get('guid');
    const pubDate = get('pubDate');
    const date = pubDate ? new Date(pubDate).toLocaleDateString('es-ES',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
    const summary = get('description').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').substring(0,200).trim();
    if (title && link) items.push({ title, link, date, summary, source });
    if (items.length >= 12) break;
  }
  return items;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const feeds = [
    { url: 'https://cincodias.elpais.com/seccion/rss/mercados/', source: 'Cinco Días' },
    { url: 'https://www.expansion.com/rss/mercados.xml', source: 'Expansión' },
    { url: 'https://www.expansion.com/rss/empresas.xml', source: 'Expansión Empresas' },
    { url: 'https://www.elconfidencial.com/rss/economia.xml', source: 'El Confidencial' },
    { url: 'https://www.elconfidencial.com/rss/empresas.xml', source: 'El Confidencial Empresas' },
    { url: 'https://es.investing.com/rss/news_11.rss', source: 'Investing Materias Primas' },
    { url: 'https://es.investing.com/rss/news_25.rss', source: 'Investing Bolsa' },
  ];

  try {
    const results = await Promise.allSettled(feeds.map(async f => {
      const xml = await fetchUrl(f.url);
      return parseRSS(xml, f.source);
    }));

    const items = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 40);

    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

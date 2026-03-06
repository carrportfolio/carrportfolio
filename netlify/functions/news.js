const https = require('https');
const http = require('http');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml,application/xml,text/xml' },
      timeout: 8000
    }, (res) => {
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
    const get = tag => { const m = block.match(new RegExp('<'+tag+'[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/'+tag+'>')); return m ? m[1].trim() : ''; };
    const title = get('title').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const link = get('link') || get('guid');
    const date = get('pubDate') ? new Date(get('pubDate')).toLocaleDateString('es-ES',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '';
    const summary = get('description').replace(/<[^>]+>/g,'').substring(0,180).trim();
    if(title && link) items.push({ title, link, date, summary, source });
    if(items.length >= 15) break;
  }
  return items;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const feeds = [
    { url: 'https://www.expansion.com/rss/mercados.xml', source: 'Expansión' },
    { url: 'https://cincodias.elpais.com/seccion/rss/mercados/', source: 'Cinco Días' },
    { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', source: 'WSJ Markets' },
  ];
  try {
    const results = await Promise.allSettled(feeds.map(async f => {
      const xml = await fetchUrl(f.url);
      return parseRSS(xml, f.source);
    }));
    const items = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort(() => Math.random() - 0.5)
      .slice(0, 30);
    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

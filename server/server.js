const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT;
if (!PORT) {
  console.error('ERRO: variável PORT não definida.');
  process.exit(1);
}

const OR_KEY   = process.env.OPENROUTER_API_KEY || '';
const OR_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const OR_URL   = 'https://openrouter.ai/api/v1/chat/completions';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj  = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: Object.assign({
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      }, headers || {}),
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

function toOpenAIMessages(messages, systemPrompt) {
  const out = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  messages.forEach(m => {
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  });
  return out;
}

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: OR_MODEL, port: PORT, hasKey: !!OR_KEY }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/claude') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JSON inválido' }));
        return;
      }

      delete payload._apiKey;

      if (!OR_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OPENROUTER_API_KEY não configurada no servidor.' }));
        return;
      }

      const ts = new Date().toLocaleTimeString('pt-BR');
      console.log(`[${ts}] -> OpenRouter | msgs:${payload.messages?.length}`);

      const orBody = {
        model: OR_MODEL,
        messages: toOpenAIMessages(payload.messages || [], payload.system || ''),
        temperature: 0.8,
        max_tokens: payload.max_tokens || 600,
        top_p: 0.95,
      };

      try {
        const orRes = await httpsPost(OR_URL, orBody, {
          'Authorization': 'Bearer ' + OR_KEY,
          'HTTP-Referer': 'https://orbyta-vox.app',
          'X-Title': 'Orbyta Vox',
        });
        console.log(`[${new Date().toLocaleTimeString('pt-BR')}] <- ${orRes.status}`);

        if (orRes.status !== 200) {
          console.error('OpenRouter erro:', orRes.body.slice(0, 300));
          res.writeHead(orRes.status, { 'Content-Type': 'application/json' });
          res.end(orRes.body);
          return;
        }

        const orData = JSON.parse(orRes.body);
        const text = orData.choices?.[0]?.message?.content || '';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text }],
          model:   OR_MODEL,
          role:    'assistant',
        }));

      } catch (err) {
        console.error('Erro OpenRouter:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Falha OpenRouter: ' + err.message }));
      }
    });
    return;
  }

  let fp = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  fp = path.join(__dirname, 'public', fp);
  if (!fp.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Proibido'); return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Não encontrado'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(handleRequest);
server.on('error', e => { console.error('Erro:', e.message); process.exit(1); });

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=========================================');
  console.log('   Orbyta Vox - Servidor Railway (OpenRouter)');
  console.log('=========================================');
  console.log(`Porta: ${PORT}`);
  console.log(`Modelo: ${OR_MODEL}`);
  console.log(`Chave: ${OR_KEY ? 'OK configurada' : 'AUSENTE'}\n`);
});

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Railway define PORT automaticamente — NUNCA usar porta fixa
const PORT = process.env.PORT;
if (!PORT) {
  console.error('ERRO: variável PORT não definida. Railway deve defini-la automaticamente.');
  process.exit(1);
}

const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = 'gemini-1.5-flash-latest';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

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

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj  = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
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

function toGeminiMessages(messages, systemPrompt) {
  const contents = [];
  if (systemPrompt) {
    contents.push({ role: 'user',  parts: [{ text: systemPrompt }] });
    contents.push({ role: 'model', parts: [{ text: 'Entendido.' }] });
  }
  messages.forEach(m => {
    contents.push({
      role:  m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  });
  return contents;
}

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: GEMINI_MODEL, port: PORT }));
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

      if (!GEMINI_KEY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'GEMINI_API_KEY não configurada.' }));
        return;
      }

      const ts = new Date().toLocaleTimeString('pt-BR');
      console.log(`[${ts}] → Gemini | msgs:${payload.messages?.length}`);

      const geminiBody = {
        contents: toGeminiMessages(payload.messages || [], payload.system || ''),
        generationConfig: {
          temperature:     0.8,
          maxOutputTokens: payload.max_tokens || 600,
          topP: 0.95,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
      };

      try {
        const geminiRes = await httpsPost(GEMINI_URL, geminiBody);
        console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ← ${geminiRes.status}`);

        if (geminiRes.status !== 200) {
          res.writeHead(geminiRes.status, { 'Content-Type': 'application/json' });
          res.end(geminiRes.body);
          return;
        }

        const geminiData = JSON.parse(geminiRes.body);
        const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          content: [{ type: 'text', text }],
          model:   GEMINI_MODEL,
          role:    'assistant',
        }));

      } catch (err) {
        console.error('Erro Gemini:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Falha Gemini: ' + err.message }));
      }
    });
    return;
  }

  // Arquivos estáticos
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
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║   Orbyta Vox — Servidor Railway      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`✅  Porta: ${PORT}`);
  console.log(`🤖  Modelo: ${GEMINI_MODEL}`);
  console.log(`🔑  Chave: ${GEMINI_KEY ? '✓ configurada' : '✗ AUSENTE'}\n`);
});

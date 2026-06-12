const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT;
if (!PORT) {
  console.error('ERRO: variável PORT não definida.');
  process.exit(1);
}

const OR_KEY    = process.env.OPENROUTER_API_KEY || '';
const OR_MODEL  = 'meta-llama/llama-3.3-70b-instruct:free';
const OR_URL    = 'https://openrouter.ai/api/v1/chat/completions';

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
  const langGuard = 'IMPORTANTE: Responda APENAS em português do Brasil. NUNCA escreva em inglês. NUNCA inclua raciocínio, pensamentos, explicações sobre o que você vai fazer, ou tags como <think>. Responda APENAS com a fala direta do personagem, sem nenhum texto adicional antes ou depois.';
  const fullSystem = systemPrompt ? (systemPrompt + '\n\n' + langGuard) : langGuard;
  out.push({ role: 'system', content: fullSystem });
  messages.forEach(m => {
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  });
  return out;
}

async function callOpenRouter(model, messages, maxTokens) {
  const body = {
    model: model,
    messages: messages,
    temperature: 0.7,
    max_tokens: Math.max(maxTokens || 0, 350), // mínimo 350 — evita truncamento
  };
  const r = await httpsPost(OR_URL, body, {
    'Authorization': 'Bearer ' + OR_KEY,
    'HTTP-Referer': 'https://orbyta-vox-server-production.up.railway.app',
    'X-Title': 'Orbyta Vox',
  });
  return r;
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
        res.end(JSON.stringify({ error: 'OPENROUTER_API_KEY não configurada.' }));
        return;
      }

      const ts = new Date().toLocaleTimeString('pt-BR');
      const messages = toOpenAIMessages(payload.messages || [], payload.system || '');
      console.log(`[${ts}] -> OpenRouter | msgs:${messages.length}`);

      // Lista de modelos gratuitos para fallback em cascata
      const models = [
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemini-2.0-flash-exp:free',
        'openrouter/free',
        'openai/gpt-oss-20b:free',
      ];

      let lastError = null;

      for (const model of models) {
        try {
          const orRes = await callOpenRouter(model, messages, payload.max_tokens);
          console.log(`[${new Date().toLocaleTimeString('pt-BR')}] <- ${model} status:${orRes.status}`);

          if (orRes.status === 200) {
            const orData = JSON.parse(orRes.body);
            let text = orData.choices?.[0]?.message?.content || '';

            // Remover blocos de raciocínio (chain-of-thought) que alguns modelos incluem
            text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            text = text.replace(/^(Okay|Let me|I need to|First,)[\s\S]{0,500}?(?=\n\n|"|')/i, '').trim();

            // Detectar meta-comentário em inglês (modelo "narrando" em vez de responder em personagem)
            const metaPatterns = /\b(in character|should respond|needs to respond|the salesperson|max \d+ sentences|stay(ing)? in character|Carlos (needs|should|is)|Now,? the|He should|He's been|cautious about budget)\b/i;
            const isMostlyEnglish = /^[a-zA-Z0-9\s.,'"!?():\-]{60,}$/.test(text.slice(0, 100));

            if (metaPatterns.test(text) || isMostlyEnglish) {
              console.error(`Modelo ${model} retornou meta-comentário/inglês, tentando próximo. Trecho:`, text.slice(0, 150));
              lastError = 'Modelo retornou meta-comentário em inglês';
              continue;
            }

            if (text.trim()) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                content: [{ type: 'text', text }],
                model:   model,
                role:    'assistant',
              }));
              return;
            } else {
              console.error(`Modelo ${model} retornou texto vazio. Body:`, orRes.body.slice(0, 400));
              lastError = 'Resposta vazia do modelo ' + model;
              continue;
            }
          } else {
            console.error(`Modelo ${model} erro ${orRes.status}:`, orRes.body.slice(0, 400));
            lastError = `${model}: ${orRes.status} - ${orRes.body.slice(0,200)}`;
            // Se for erro de rate limit (429), tentar próximo modelo
            // Se for erro de auth (401/403), parar — chave inválida
            if (orRes.status === 401 || orRes.status === 403) {
              res.writeHead(orRes.status, { 'Content-Type': 'application/json' });
              res.end(orRes.body);
              return;
            }
            continue;
          }
        } catch (err) {
          console.error(`Erro de rede com ${model}:`, err.message);
          lastError = err.message;
          continue;
        }
      }

      // Todos os modelos falharam
      console.error('Todos os modelos falharam. Último erro:', lastError);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Todos os modelos IA falharam. Detalhe: ' + lastError }));
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
  console.log('   Orbyta Vox - Servidor Railway (OpenRouter + fallback)');
  console.log('=========================================');
  console.log(`Porta: ${PORT}`);
  console.log(`Modelo principal: ${OR_MODEL}`);
  console.log(`Chave: ${OR_KEY ? 'OK configurada' : 'AUSENTE'}\n`);
});

#!/usr/bin/env node
/**
 * NFe CAPTCHA Solver — GPU Node
 *
 * Conecta ao WebSocket central e resolve CAPTCHAs exclusivamente.
 * Sem certificados, Puppeteer, downloads de XML ou automação ECAC/DEC.
 */

require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════
const WS_URL = process.env.WS_URL || 'wss://log.vidal-app.com/ws';
const WS_SECRET = process.env.WS_SECRET || 'vidal_websocket_secret_key_2025';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3-vl:8b';
const NODE_ID = process.env.NODE_ID || `solver-${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`;

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
let ws = null;
let reconnectTimer = null;
let warmupTimer = null;
const stats = { total: 0, success: 0, failed: 0 };
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════════
// PRE-FLIGHT
// ═══════════════════════════════════════════════════════════════════
async function preFlight() {
  console.log('\n🔧 Pré-voo do Solver GPU...');
  try {
    // Check Ollama
    const ok = await new Promise((resolve) => {
      const req = http.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 }, (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => resolve(data.includes('models')));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (!ok) throw new Error('Ollama não responde em ' + OLLAMA_URL);
    console.log('✅ Ollama OK');

    // Check model
    const { execSync } = require('child_process');
    const list = execSync('ollama list', { encoding: 'utf8', timeout: 10000 });
    if (!list.includes(MODEL)) {
      console.warn(`⚠️ Modelo ${MODEL} não encontrado. Baixando...`);
      execSync(`ollama pull ${MODEL}`, { stdio: 'inherit', timeout: 600000 });
      console.log(`✅ Modelo ${MODEL} baixado`);
    } else {
      console.log(`✅ Modelo ${MODEL} OK`);
    }
  } catch (e) {
    console.error('❌ Pré-voo falhou:', e.message);
    process.exit(1);
  }
  console.log('🔧 Pré-voo concluído\n');
}

// ═══════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════
function connect() {
  const url = `${WS_URL}?token=${encodeURIComponent(WS_SECRET)}`;
  console.log(`[Solver] Conectando em ${WS_URL}...`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[Solver] Conectado');
    send({
      type: 'solver_register',
      data: {
        nodeId: NODE_ID,
        capabilities: { ollama: true, model: MODEL, gpu: true },
        hostname: os.hostname()
      }
    });
    console.log('[Solver] Registrado como solver');
    startWarmup();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'captcha_request') {
        handleRequest(msg.data);
      }
    } catch (e) {
      console.error('[Solver] Mensagem inválida:', e.message);
    }
  });

  ws.on('close', () => {
    console.warn('[Solver] Desconectado. Reconectando em 5s...');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[Solver] Erro WS:', err.message);
  });
}

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

// ═══════════════════════════════════════════════════════════════════
// WARMUP
// ═══════════════════════════════════════════════════════════════════
function startWarmup() {
  if (warmupTimer) return;
  warmupPing();
  warmupTimer = setInterval(() => warmupPing(), 180000); // 3 min
}

async function warmupPing() {
  try {
    await postOllama(JSON.stringify({
      model: MODEL,
      prompt: '',
      images: [],
      stream: false,
      keep_alive: '10m'
    }));
    console.log('[Solver] Warmup OK');
  } catch (e) {
    console.warn('[Solver] Warmup falhou:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CAPTCHA SOLVING
// ═══════════════════════════════════════════════════════════════════
async function handleRequest(data) {
  const { taskId, imageBase64, timestamp } = data || {};
  if (!taskId || !imageBase64) return;

  console.log(`[Solver] Task ${taskId}`);
  const start = Date.now();

  try {
    const imagePath = path.join(tempDir, `task_${taskId}.png`);
    fs.writeFileSync(imagePath, Buffer.from(imageBase64, 'base64'));

    const numbers = await solveWithOllama(imagePath);

    try { fs.unlinkSync(imagePath); } catch (e) {}

    const elapsed = Date.now() - start;
    stats.total++;
    if (numbers.length > 0) stats.success++;
    else stats.failed++;

    console.log(`[Solver] Task ${taskId} em ${elapsed}ms: [${numbers.join(', ') || 'NENHUM'}]`);

    send({
      type: 'captcha_response',
      data: { taskId, numbers, elapsedMs: elapsed, solverId: NODE_ID }
    });
  } catch (err) {
    stats.total++;
    stats.failed++;
    console.error(`[Solver] Erro task ${taskId}:`, err.message);
    send({
      type: 'captcha_response',
      data: { taskId, numbers: [], error: err.message, solverId: NODE_ID }
    });
  }
}

async function solveWithOllama(imagePath) {
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const prompt = `Analise o DESAFIO na parte superior da imagem. Em seguida, identifique quais dos 9 quadrantes na grade inferior (organizados em 3x3, numerados da esquerda para a direita, de cima para baixo: 1,2,3 na primeira linha; 4,5,6 na segunda; 7,8,9 na terceira) correspondem a resposta correta do desafio. IMPORTANTE: Responda APENAS com os numeros separados por virgula, sem nenhum texto adicional. Exemplo: 1, 4, 7`;

  const response = await postOllama(JSON.stringify({
    model: MODEL,
    prompt: prompt,
    images: [imageBase64],
    stream: false,
    keep_alive: '10m',
  }));

  const json = JSON.parse(response);
  return extractNumbers(json.response || '');
}

function postOllama(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${OLLAMA_URL}/api/generate`);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 11434,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 300000, // 5 min
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function extractNumbers(text) {
  const patterns = [
    /(\d+(?:\s*,\s*\d+)+)/,
    /numeros?:\s*([0-9,\s]+)/i,
    /resposta:\s*([0-9,\s]+)/i,
    /imagens?:\s*([0-9,\s]+)/i,
    /([0-9]+[\s,]+[0-9]+[\s,]*[0-9]*)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const nums = match[1].match(/[1-9]/g);
      if (nums && nums.length > 0) {
        return [...new Set(nums.map(Number))].sort((a, b) => a - b);
      }
    }
  }
  const digits = text.match(/[1-9]/g);
  if (digits && digits.length > 0) {
    return [...new Set(digits.map(Number))].sort((a, b) => a - b);
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════
// SHUTDOWN
// ═══════════════════════════════════════════════════════════════════
process.on('SIGINT', () => {
  console.log('\n⏹️ SIGINT');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (warmupTimer) clearInterval(warmupTimer);
  if (ws) ws.terminate();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n⏹️ SIGTERM');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (warmupTimer) clearInterval(warmupTimer);
  if (ws) ws.terminate();
  process.exit(0);
});

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════
preFlight().then(() => {
  connect();
}).catch((err) => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});

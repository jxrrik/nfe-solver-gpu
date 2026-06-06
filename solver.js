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
const jwt = require('jsonwebtoken');
const { execSync } = require('child_process');

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
let logFlushTimer = null;
const stats = { total: 0, success: 0, failed: 0 };
const logBuffer = [];
const activeTasks = new Set(); // Track running tasks for concurrency limit
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
function generateToken() {
  return jwt.sign(
    { id: `nfe-solver-${NODE_ID}`, permissions: ['worker', 'service'] },
    WS_SECRET,
    { expiresIn: '24h' }
  );
}

function connect() {
  const token = generateToken();
  const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
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

// ═══════════════════════════════════════════════════════════════════
// TASK QUEUE — Sequential processing, one CAPTCHA at a time
// ═══════════════════════════════════════════════════════════════════
const solverState = {
  taskQueue: [],
  currentTask: null,
  abortCurrent: false
};

function enqueueTask(data) {
  solverState.taskQueue.push(data);
  processQueue();
}

async function processQueue() {
  if (solverState.currentTask || solverState.taskQueue.length === 0) return;
  solverState.currentTask = solverState.taskQueue.shift();
  solverState.abortCurrent = false;

  try {
    await handleRequest(solverState.currentTask);
  } catch (e) {
    console.error('[Solver] Erro na fila:', e.message);
  } finally {
    solverState.currentTask = null;
    // Process next task in queue
    setImmediate(processQueue);
  }
}

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'captcha_request') {
        enqueueTask(msg.data);
      } else if (msg.type === 'captcha_cancel') {
        const { taskId } = msg.data || {};
        if (solverState.currentTask && solverState.currentTask.taskId === taskId) {
          solverState.abortCurrent = true;
          console.log(`[Solver] 🚫 Tarefa ${taskId} cancelada pelo nó`);
        }
        // Remove from queue if pending
        const idx = solverState.taskQueue.findIndex(t => t.taskId === taskId);
        if (idx >= 0) {
          solverState.taskQueue.splice(idx, 1);
          console.log(`[Solver] 🚫 Tarefa ${taskId} removida da fila`);
        }
      } else if (msg.type === 'remote_update') {
        handleRemoteUpdate(msg.data);
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

function flushLogs() {
  if (!logBuffer.length || !ws || ws.readyState !== WebSocket.OPEN) return;
  const lines = logBuffer.splice(0, 50);
  try {
    send({ type: 'node_logs', data: { lines } });
  } catch (e) { /* ignore */ }
}

function setupLogStreaming() {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  const capture = (chunk) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    const lines = str.split('\n').filter(l => l.trim());
    const ts = new Date().toISOString().slice(11, 19);
    for (const line of lines) {
      if (line.includes('"type":"ping"')) continue;
      logBuffer.push(`[${ts}] ${line.trim().substring(0, 200)}`);
      if (logBuffer.length > 100) logBuffer.shift();
    }
  };

  process.stdout.write = (chunk, ...args) => {
    capture(chunk);
    return origStdout(chunk, ...args);
  };

  process.stderr.write = (chunk, ...args) => {
    capture(chunk);
    return origStderr(chunk, ...args);
  };

  logFlushTimer = setInterval(() => flushLogs(), 2000);
}

function handleRemoteUpdate(data) {
  const branch = data?.branch || 'master';
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  🔄 REMOTE UPDATE — branch: ${branch}`);
  console.log(`${'═'.repeat(60)}\n`);

  const steps = [];
  const run = (cmd, label) => {
    try {
      console.log(`⏳ ${label}...`);
      const output = execSync(cmd, { cwd: __dirname, timeout: 60000, encoding: 'utf8' });
      const trimmed = output.trim().slice(-200);
      console.log(`  ✅ ${trimmed}`);
      steps.push({ step: label, success: true, output: trimmed });
      return true;
    } catch (e) {
      const errMsg = (e.stderr || e.message || '').trim().slice(-200);
      console.error(`  ❌ ${errMsg}`);
      steps.push({ step: label, success: false, error: errMsg });
      return false;
    }
  };

  run('git stash --include-untracked', 'git stash');
  const pulled = run(`git pull origin ${branch}`, 'git pull');
  if (!pulled) {
    run(`git fetch origin ${branch} && git reset --hard origin/${branch}`, 'git reset --hard');
  }

  const updated = pulled || steps.some(s => s.step === 'git reset --hard' && s.success);
  if (updated) {
    run('npm install --production', 'npm install');
  }

  const allOk = steps.filter(s => s.step !== 'git stash').every(s => s.success);
  send({
    type: 'update_result',
    data: { success: allOk, steps, nodeId: NODE_ID, branch }
  });

  console.log(`\n${allOk ? '✅' : '❌'} Update ${allOk ? 'OK' : 'FALHOU'}`);

  if (allOk) {
    console.log('🔄 Reiniciando via PM2 em 3s...');
    setTimeout(() => {
      try {
        // 1. Tentar restart via ecosystem.config.js
        execSync('pm2 restart ecosystem.config.js', { cwd: __dirname, timeout: 15000 });
        console.log('✅ PM2 restart via ecosystem OK');
      } catch (e) {
        console.error('⚠️ PM2 restart ecosystem falhou:', e.message);
        try {
          // 2. Fallback: restart pelo nome
          execSync('pm2 restart nfe-solver', { cwd: __dirname, timeout: 10000 });
          console.log('✅ PM2 restart via nome OK');
        } catch (e2) {
          console.error('⚠️ PM2 restart nome falhou:', e2.message);
          // 3. Último recurso: sair para autorestart
          console.log('⚡ Saindo para autorestart do PM2...');
          process.exit(0);
        }
      }
    }, 3000);
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
    console.log('[Solver] 🌡️  Warmup — mantendo modelo na VRAM...');
    const start = Date.now();
    await postOllama(JSON.stringify({
      model: MODEL,
      prompt: 'warmup',
      stream: false,
      keep_alive: '30m'
    }));
    console.log(`[Solver] 🌡️  Warmup OK em ${Date.now() - start}ms`);
  } catch (e) {
    console.warn('[Solver] Warmup falhou:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CAPTCHA SOLVING
// ═══════════════════════════════════════════════════════════════════
function nowTime() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

async function handleRequest(data) {
  const { taskId, imageBase64, timestamp, nodeId } = data || {};
  if (!taskId || !imageBase64) return;

  const start = Date.now();
  console.log(`[Solver] 📨 Recebido captcha_request: ${taskId} do nó: ${nodeId || '?'} às ${nowTime()}`);

  // 1. Send ACK to confirm we accepted the task
  send({ type: 'captcha_ack', data: { taskId } });
  console.log(`[Solver] 👍 ACK enviado para task ${taskId}`);

  try {
    const imagePath = path.join(tempDir, `task_${taskId}.png`);
    const imgBytes = Buffer.from(imageBase64, 'base64');

    // Check for empty/corrupted image
    if (imgBytes.length < 30000) {
      console.warn(`[Solver] ⚠️ Imagem muito pequena (${imgBytes.length} bytes) — provavelmente vazia`);
      send({
        type: 'captcha_response',
        data: { taskId, numbers: [], error: 'empty_image', solverNode: NODE_ID, timestamp: Date.now() }
      });
      return;
    }

    fs.writeFileSync(imagePath, imgBytes);
    console.log(`[Solver] �️  Imagem salva: ${imgBytes.length} bytes às ${nowTime()}`);

    // Check abort flag
    if (solverState.abortCurrent) {
      console.log(`[Solver] 🚫 Tarefa ${taskId} abortada antes do Ollama`);
      try { fs.unlinkSync(imagePath); } catch (e) {}
      send({
        type: 'captcha_response',
        data: { taskId, numbers: [], error: 'cancelled', solverNode: NODE_ID, timestamp: Date.now() }
      });
      return;
    }

    console.log(`[Solver] 🧠 Enviando para Ollama (${MODEL})...`);
    const ollamaStart = Date.now();
    const numbers = await solveWithOllama(imagePath);
    const ollamaElapsed = Date.now() - ollamaStart;

    try { fs.unlinkSync(imagePath); } catch (e) {}

    const elapsed = Date.now() - start;
    stats.total++;
    if (numbers.length > 0) stats.success++;
    else stats.failed++;

    // Check abort flag after processing
    if (solverState.abortCurrent) {
      console.log(`[Solver] 🚫 Tarefa ${taskId} abortada após Ollama (descartando resultado)`);
      send({
        type: 'captcha_response',
        data: { taskId, numbers: [], error: 'cancelled', solverNode: NODE_ID, timestamp: Date.now() }
      });
      return;
    }

    console.log(`[Solver] ✅ Resposta Ollama: [${numbers.join(', ') || 'NENHUM'}] em ${ollamaElapsed}ms às ${nowTime()}`);
    console.log(`[Solver] 📤 Enviando captcha_response para nó: ${nodeId || '?'} às ${nowTime()}`);

    send({
      type: 'captcha_response',
      data: { taskId, numbers, elapsedMs: elapsed, solverNode: NODE_ID, timestamp: Date.now() }
    });
  } catch (err) {
    stats.total++;
    stats.failed++;
    console.error(`[Solver] ❌ Erro task ${taskId}:`, err.message, `às ${nowTime()}`);
    send({
      type: 'captcha_response',
      data: { taskId, numbers: [], error: err.message, solverNode: NODE_ID, timestamp: Date.now() }
    });
  }
}

async function solveWithOllama(imagePath) {
  const imageBase64 = fs.readFileSync(imagePath).toString('base64');
  const prompt = `Analise o DESAFIO na parte superior da imagem. Em seguida, identifique quais dos 9 quadrantes na grade inferior (organizados em 3x3, numerados da esquerda para a direita, de cima para baixo: 1,2,3 na primeira linha; 4,5,6 na segunda; 7,8,9 na terceira) correspondem a resposta correta do desafio. IMPORTANTE: Responda APENAS com os numeros separados por virgula, sem nenhum texto adicional. Nao inclua palavras, explicacoes ou o exemplo.`;

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
        timeout: 300000, // 5 min — GTX 1070 leva ~60s por inferência; margem de segurança
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
setupLogStreaming();

preFlight().then(() => {
  connect();
}).catch((err) => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});

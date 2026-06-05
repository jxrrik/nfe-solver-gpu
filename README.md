# nfe-solver-gpu

Dedicated GPU CAPTCHA solver for NFe download nodes. Connects to the Vidal WebSocket server, receives CAPTCHA images from download nodes, solves them using Ollama (qwen3-vl:8b), and returns the answer.

## Requirements

- Node.js >= 16
- Ollama installed and running
- GPU with CUDA support recommended (for fast inference)

## Install

```bash
git clone https://github.com/jxrrik/nfe-solver-gpu.git
cd nfe-solver-gpu
npm install
cp .env.example .env
# Edit .env if needed
pm2 start ecosystem.config.js
pm2 save
```

## .env

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_URL` | `wss://log.vidal-app.com/ws` | WebSocket server URL |
| `WS_SECRET` | `vidal_websocket_secret_key_2025` | Auth token |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama API |
| `OLLAMA_MODEL` | `qwen3-vl:8b` | Model to use |

## Logs

```bash
pm2 logs nfe-solver
```

## What it does

1. Connects to the WebSocket server
2. Registers as a `solver` (not a download node)
3. Receives `captcha_request` messages with base64 images
4. Runs the image through Ollama
5. Returns `captcha_response` with the numbers
6. Keeps the model warm in VRAM with periodic pings

No certificates, no Puppeteer, no XML downloads, no ECAC/DEC automation.

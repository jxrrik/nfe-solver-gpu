# Instalação do Solver GPU

Execute esses comandos **dentro da pasta onde quer os arquivos** (ex: `~/nfe-solver-gpu`):

```bash
# 1. Inicializa git e adiciona o remote
git init
git remote add origin https://github.com/jxrrik/nfe-solver-gpu.git

# 2. Baixa os arquivos do repo
git pull origin master

# 3. Instala dependências (só ws e dotenv)
npm install

# 4. Cria o .env
cp .env.example .env

# 5. Inicia com PM2
pm2 start ecosystem.config.js
pm2 save
```

## Pré-requisitos

Ollama precisa estar instalado e o modelo baixado:

```bash
# Instalar Ollama (Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Baixar modelo
ollama pull qwen3-vl:8b
```

## Verificar se está funcionando

```bash
# Logs do solver
pm2 logs nfe-solver

# No servidor, verificar se solver conectou:
tail -f ~/.pm2/logs/websocket-worker-out.log | grep -E "Solver|CAPTCHA"
```

## Atualizar (remote update)

```bash
cd ~/nfe-solver-gpu  # pasta onde clonou
git pull origin master
pm2 restart nfe-solver
```

module.exports = {
  apps: [
    {
      name: 'nfe-solver',
      script: 'solver.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/solver-error.log',
      out_file: './logs/solver-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      kill_timeout: 10000,
      listen_timeout: 5000
    }
  ]
};

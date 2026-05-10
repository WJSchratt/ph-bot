module.exports = {
  apps: [
    {
      name: 'pc-bridge',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 1000,
      restart_delay: 2000,
      watch: false,
      env: {
        PORT: 8080,
        HOST: '0.0.0.0',
        WORKDIR: process.env.USERPROFILE || process.env.HOME,
        REQUEST_TIMEOUT_MS: 600000,
      },
    },
  ],
};

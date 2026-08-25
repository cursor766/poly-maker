const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "poly-maker-api",
      cwd: __dirname,
      script: path.join(__dirname, "node_modules/.bin/tsx"),
      args: "src/web/server.ts",
      interpreter: "none",
      instances: 1,
      autorestart: true,
      max_restarts: 40,
      restart_delay: 2000,
      watch: false,
      out_file: path.join(__dirname, "logs/api.out.log"),
      error_file: path.join(__dirname, "logs/api.err.log"),
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "poly-maker-web",
      cwd: path.join(__dirname, "web"),
      script: path.join(__dirname, "web/node_modules/.bin/next"),
      args: "dev --hostname 127.0.0.1 --port 3000",
      interpreter: "none",
      instances: 1,
      autorestart: true,
      max_restarts: 40,
      restart_delay: 2000,
      watch: false,
      out_file: path.join(__dirname, "logs/web.out.log"),
      error_file: path.join(__dirname, "logs/web.err.log"),
      merge_logs: true,
    },
  ],
};

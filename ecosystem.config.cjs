// NOTE: This file uses .cjs extension because package.json has "type": "module".
// PM2 requires CommonJS for ecosystem config files in ESM projects.
module.exports = {
  apps: [
    {
      name: "discord-bot",
      script: "index.js",
      watch: false,
      autorestart: true,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};

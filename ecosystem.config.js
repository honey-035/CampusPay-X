module.exports = {
  apps: [{
    name: "campuspay-x",
    script: "server.js",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    min_uptime: "5s",
    max_restarts: 10,
    restart_delay: 1000,
    kill_timeout: 5000,
    time: true
  }]
};

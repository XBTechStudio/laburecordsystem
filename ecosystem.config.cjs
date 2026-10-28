module.exports = {
  apps: [
    {
      name: "xbtech70",
      cwd: __dirname,
      script: "npm",
      args: "start",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
        PORT: 3070,
      },
    },
  ],
};

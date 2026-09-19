const http = require("http");
const store = require("./src/store");
const { handle, send } = require("./src/routes");

const PORT = Number(process.env.PORT || 3021);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

store.init().then(() => {
  server.listen(PORT, () => {
    console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
  });
});

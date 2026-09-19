/**
 * 服务入口：启动方式保持原样 `PORT=3021 node server.js`。
 * 接口处理见 lib/http.js，状态计算见 lib/state.js，记录持久化见 lib/store.js。
 */
const { createServer } = require("./lib/http");

const PORT = Number(process.env.PORT || 3021);

const server = createServer();
server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});

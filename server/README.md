# 诗句计数服务（可选）

网站本身是纯静态的。「与你同得这一句的，还有 N 人」需要一个极小的计数服务：每首诗只存一个数字，
**不接收、不保存任何生日、名字、城市或设备信息**。没有配置时，网页上什么都不显示，也不会编造数字。

## 推荐：腾讯云开发 CloudBase（国内可直接访问，将来做小程序也用它）

1. 注册并实名认证腾讯云账号，打开「云开发 CloudBase」控制台，新建一个环境（免费额度够用）。
2. 数据库 → 新建集合 `poem_counts`（权限设为「仅管理端可读写」即可，云函数有管理员权限）。
3. 云函数 → 新建函数 `poemCounter`，运行环境 Node.js 16/18，把 `server/cloudbase/poemCounter/` 里的
   `index.js` 和 `package.json` 上传（控制台在线编辑也行），选择「云端安装依赖」。
4. 环境 → HTTP 访问服务 → 新建路由：路径 `/poem`，关联云函数 `poemCounter`。控制台会显示访问域名，
   形如 `https://<环境ID>-<数字>.ap-shanghai.app.tcloudbase.com`。
5. 在 `index.js` 的 `ORIGINS` 里确认是你的站点域名（换自有域名时要加上）。
6. 把完整地址发给我，或自己改 `src/js/config.js`：
   ```js
   poemStats: { provider: 'http', url: 'https://<访问域名>/poem' },
   ```
   推送后自动上线。

测试：浏览器打开 `https://<访问域名>/poem/count?id=p001`，应返回 `{"id":"p001","count":0}`。

## 备选：Cloudflare Workers + D1

需要一个自己的域名接到 Cloudflare（`*.workers.dev` 在国内经常打不开）。`server/cloudflare/` 里有
`worker.js` 和 `schema.sql`：建 D1 数据库并执行 schema，Worker 绑定名 `DB`，路由到你的子域名，
然后 `poemStats.url` 填 `https://<你的子域名>`。

## 计数规则

- 每个人第一次到达自己的星空时，给他默认拿到的那首诗 +1；同一浏览器、同一个生日只计一次。
- 「换一首」不计数：统计的是「谁天生拿到了这一句」。
- 只接受形如 `p012` 的诗句编号，其他请求一律拒绝。

# USLATIAO 亚洲零食独立站（HICHEN Asian Market）

美国本土仓储发货的亚洲零食独立站。纯静态站点（HTML/CSS/JS），托管在 Cloudflare Pages。

## Cloudflare Pages 部署设置

在 Cloudflare 面板连接本 Git 仓库时，按下面填：

| 设置项 | 填写内容 |
|---|---|
| Framework preset（框架预设） | **None**（无框架） |
| Build command（构建命令） | **留空**（本站无需构建） |
| Build output directory（输出目录） | **`/`**（仓库根目录） |
| Root directory（根目录） | 留空 |

设置完成后推送代码即自动部署，每次 push 触发一次构建（免费档 500 次/月）。

## 目录说明

| 路径 | 说明 |
|---|---|
| `*.html` | 站点页面（首页 / 商店 / 商品详情 / 结账 / 账户 / 后台等） |
| `assets/` | 样式与脚本（改前端后需同步 bump `?v=N` 版本号破缓存） |
| `products.json` | 商品快照（服务端价格基准） |
| `functions/` | Cloudflare Pages Functions（后端接口，后续阶段加入） |
| `deploy/`、`docs/` | 本地部署脚本与内部文档，已在 `.gitignore` 中排除，不会发布 |

## 版本号约定

前端资源引用带 `?v=N`（如 `assets/css/styles.css?v=42`）。改动前端文件后**必须递增版本号并对全部页面同步替换**，否则用户浏览器会用旧缓存。

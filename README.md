# DN11 Panel

DN11 网络管理面板，用于查看路由器与服务器两个节点的运行状态，管理 BGP Peer，以及提供网络诊断工具（Ping、TCPing、Traceroute、NSLookup 等）。

项目针对 **双节点**（一台 OpenWrt 路由器 + 一台 Linux 服务器）的 DN11 BGP 实验网络设计。

## 项目结构

```
dn11-panel/
├── web/                  # 前端（纯静态 HTML/CSS/JS）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── dn11-api              # 路由器端 API（OpenWrt CGI-BIN Shell 脚本）
├── dn11-api.php          # 服务器端 API（PHP）
├── dn11-peer             # 服务器端添加 Peer 的交互式脚本
└── dn11-peer-op          # 路由器端添加 Peer 的交互式脚本（OpenWrt 版）
```

## 各组件说明

### web/ — 前端面板

纯静态前端，使用 Bootstrap 5 + Chart.js 构建，无需编译。直接部署到任意 Web 服务器即可。

功能包括：

- 仪表盘：展示路由器和服务器的 BIRD 状态、接口状态、互联链路健康检查
- BGP Peers：查看路由器和服务器的所有 BGP 邻居状态，支持通过面板添加 Peer
- BIRD 路由查询：类似 Looking Glass 功能
- 系统路由表：查看和搜索路由表
- 网络工具：Ping / TCPing / Traceroute / NSLookup

**配置方法：** 修改 `web/app.js` 顶部的 `API_NODES` 和 `PEER_INFO`，将 IP 地址和标签改为你自己的节点信息。`index.html` 中各 `<select>` 下拉菜单的后端节点选项也需要对应修改（已用注释标记）。

### dn11-api — 路由器端 API

Shell 脚本，部署到 OpenWrt 路由器的 `/www/cgi-bin/dn11-api` 路径。

提供的接口：

| Action | 方法 | 说明 |
|---|---|---|
| `get_peers` | GET | 获取所有 DN11 WireGuard Peer 状态 |
| `get_routes` | GET | 获取系统路由表 |
| `bird_show` | GET | 查询 BIRD 路由/协议/接口/状态 |
| `check_cloud` | GET | 检查路由器到服务器的连接健康状态 |
| `ping` | GET | 执行单次 ICMP Ping |
| `tcping` | GET | 执行单次 TCPing |
| `nslookup` | GET | 执行 DNS 查询 |
| `add_peer` | POST | 添加新的 Peer（需要认证） |

**部署：**

```bash
# 复制到 OpenWrt
scp dn11-api root@<路由器IP>:/www/cgi-bin/dn11-api
ssh root@<路由器IP> "chmod +x /www/cgi-bin/dn11-api"
```

**配置：** 修改脚本顶部的 `API_SECRET`，以及 `check_cloud_connection()` 函数中的接口名、IP 等变量（已用注释标记）。

**依赖：** bird / birdc, wireguard-tools, iproute2, ping, tcping（可选）, host 或 nslookup

### dn11-api.php — 服务器端 API

PHP 脚本，部署到服务器的 Web 服务中（如 Nginx + PHP-FPM）。

提供的接口与路由器端类似，另外增加了 `traceroute`（流式输出）和 `ospf_state` 接口。

**配置：**

- 修改顶部的 `API_SECRET`（需与前端填写的密码对应）
- 修改 `check_access()` 中的域名白名单
- 修改 `check_router_connection()` 中的接口名、IP、协议名等变量（已用注释标记）

**依赖：** PHP 7.4+, bird2 / birdc, wireguard-tools, iproute2, ping, tcping（可选）, host, traceroute

**注意：** PHP 需要通过 `sudo` 执行部分特权命令。需要配置 visudo，为 web 服务运行用户（如 `www-data`）添加 NOPASSWD 权限，至少包括：

```
www-data ALL=(ALL) NOPASSWD: /usr/bin/wg, /usr/bin/birdc, /usr/sbin/ip, /usr/bin/ls, /usr/bin/cat, /usr/bin/ping, /usr/bin/host, /usr/bin/traceroute, /usr/bin/tcping, /path/to/dn11-peer
```

请根据实际安装路径调整。

### dn11-peer — 服务器端添加 Peer 脚本

交互式 Bash 脚本，用于在 Linux 服务器上快速添加 DN11 BGP Peer。支持交互模式和批量模式（`--batch`，供 API 调用）。

执行流程：获取 Peer 信息 -> 生成 WireGuard 配置 -> 配置防火墙 -> 启动接口 -> 追加 BIRD 邻居配置 -> 应用 BIRD 配置。

**配置：** 修改脚本顶部的 `PRIVATE_KEY`（WireGuard 私钥）和 `LOCAL_TUNNEL_IP`（本机隧道 IP）。

**依赖：** wg-quick, firewall-cmd (firewalld), birdc

### dn11-peer-op — 路由器端添加 Peer 脚本（OpenWrt）

与 `dn11-peer` 功能类似，但适配了 OpenWrt 环境。使用 `wg-quick-op` 和 `uci` 管理接口和防火墙。

执行流程：获取 Peer 信息 -> 生成 WireGuard 配置 -> 启动接口验证 -> 配置 UCI（network / dhcp / firewall） -> 重启接口 -> 追加 BIRD 邻居配置 -> 应用 BIRD 配置。

**配置：** 修改脚本顶部的 `PRIVATE_KEY`（WireGuard 私钥）、`LOCAL_TUNNEL_IP`（本机隧道 IP）和 `FW_ZONE_NAME`（防火墙区域名称）。

**依赖：** wg-quick-op, uci, birdc

## 局限性与注意事项

- **仅支持双节点网络：** 本项目围绕"一台 OpenWrt 路由器 + 一台 Linux 服务器"的拓扑设计，前端面板、互联健康检查等均假设只有两个自有节点。如需支持更多节点，需自行扩展。
- **服务器端 Peer 脚本仅适配 firewalld：** `dn11-peer` 使用 `firewall-cmd` 管理防火墙端口。如果服务器使用 iptables、nftables 或 ufw，需要自行修改防火墙相关逻辑。
- **路由器端需要预先创建名为 `dn11_zone` 的防火墙区域：** `dn11-peer-op` 脚本会将新接口加入此区域，如果该区域不存在则会失败。请在 OpenWrt 防火墙设置中提前创建。
- **服务器端 API 需要配置 visudo：** PHP 通过 `sudo` 调用系统命令，必须为 Web 服务用户配置免密码 sudo 权限，否则 API 无法正常工作。
- **服务器端需要安装多种工具：** 包括 bird2、wireguard-tools、iproute2、tcping、traceroute、host (bind-utils / dnsutils) 等，请确保在部署前安装完毕。
- **路由器端需要 `wg-quick-op`：** OpenWrt 上需要安装 WireGuard 相关的 wg-quick-op 包。
- **认证机制：** 添加 Peer 的 API 使用基于 HMAC-SHA256 + 时间戳的简单认证。前后端需要配置相同的 `API_SECRET`。
- **前端为纯静态页面：** 通过浏览器直接访问后端 API，因此需要后端正确设置 CORS 头。

## 快速开始

1. 根据你的网络拓扑，修改各文件中标注了注释的配置项（搜索 `CHANGE_ME` 和中文注释提示）。
2. 将 `dn11-api` 部署到 OpenWrt 路由器的 `/www/cgi-bin/` 目录。
3. 将 `dn11-api.php` 部署到服务器的 Web 目录，配置 PHP 运行环境和 visudo。
4. 将 `dn11-peer` 放到服务器上（建议 `/usr/local/bin/`），将 `dn11-peer-op` 放到路由器上。
5. 将 `web/` 目录部署到任意 Web 服务器（或直接用浏览器打开 `index.html`）。
6. 访问前端页面即可开始使用。



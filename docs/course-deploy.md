# 部署迷你课：把本地那套东西搬到"别人的电脑"上

> 中文写作，因为这是给本人的学习笔记，不是 API 文档。它不是本仓库功能的一部分，是解释本仓库怎么被部署的。
> English summary: a short course on what cloud deployment actually is, anchored to this repository's own stack.

## 0. 你现在的理解与它的边界

你说得对：**部署 = 租一台云端电脑，在它上面跑你自己的程序，然后让外面的人能连到那个端口。**

这句话在 80% 的场景是准确的。剩下的 20% 决定了你以后选平台不会踩坑，所以先把它补全：

| 你以为的 | 实际还差一层 |
|---|---|
| 租电脑 | 电脑有很多种租法：整台虚拟机、只租容器、只租函数 |
| 跑程序 | 程序必须监听 `0.0.0.0` 而不是 `127.0.0.1`，否则外面连不上 |
| 开端口 | 要开**三层**：程序绑定、Docker 映射、云防火墙 |
| 能访问就行 | 还要处理 TLS、域名、以及"关了之后数据还在吗" |

## 1. 三种"云端"，别混着用

| 形态 | 例子 | 你负责什么 | 平台负责什么 | 适合什么 |
|---|---|---|---|---|
| **虚拟机 (IaaS)** | Oracle A1、GCP e2、Hetzner、EC2 | 操作系统、Docker、升级、安全 | 硬件、网络、虚拟化 | 常驻多进程 + 数据库 + 本地磁盘 |
| **托管容器 (PaaS)** | Cloud Run、Fly.io、Render | 一个镜像 + 端口约定 | 一切运维、伸缩 | 无状态 HTTP 服务 |
| **无服务器 (FaaS)** | Cloudflare Workers、Lambda | 一个函数 | 运行时、伸缩到零 | 短请求，无本地状态 |

**为什么本项目几乎只能选 IaaS**：ERPNext 是 8 个常驻进程（web、worker、scheduler、nginx、websocket…）+ MariaDB + Redis + 本地卷。PaaS 假设你只有一个无状态容器；FaaS 连"常驻"都不允许。Codespaces 是个特殊产品：本质是一台**临时虚拟机**，所以它能跑。

判断口诀：**有数据库 + 有本地卷 + 有多个常驻进程 → 只能 IaaS。**

## 2. 端口的三层，缺一层就连不上

以本项目的 `frontend` 为例，一个请求要穿过三层才到 ERPNext：

```
浏览器 → [1] 云防火墙放行 8080
       → [2] Docker 端口映射 127.0.0.1:8080:8080（宿主 → 容器）
       → [3] 容器内 nginx 监听 0.0.0.0:8080
```

- **[3] 程序绑定地址**：绑 `127.0.0.1` 只能本机连；绑 `0.0.0.0` 才能被映射出去。这是最常见的第一坑。
- **[2] Docker 映射**：`-p 宿主IP:宿主端口:容器端口`。本仓库写的是 `127.0.0.1:8080:8080`，意思是**只有宿主本机能访问这个映射**——这是故意的，避免把一个无认证的 demo 暴露到公网。
- **[1] 云防火墙**：Oracle 叫 Security List，AWS 叫 Security Group，GCP 叫 VPC firewall。**它和 [2]/[3] 完全独立**，配了 Docker 没配它，外面还是连不上。

排障顺序固定：容器里 `curl localhost:8080` → 宿主机 `curl 127.0.0.1:8080` → 用公网 IP curl → 换外部机器 curl。**在哪一层失败，就在哪一层修。**

## 3. Codespaces 特殊在哪

Codespaces 不是"给你一个公网 IP 的 VM"，而是"给你一台内网 VM + 一个反向代理"。

```
你的浏览器 → https://xxx-8080.app.github.dev   (GitHub 的代理，自动带 TLS)
           → Codespaces 里的 localhost:8080
           → Docker 映射 → 容器
```

由此推出三条实践结论，也正是为什么本项目的 devcontainer 这样写：

1. **不需要公网 IP，也没有安全组。** 你只要 `forwardPorts: [8080]`，代理就帮你转。所以 `.devcontainer/devcontainer.json` 里只有一个端口。
2. **转发的是"你本机能访问的端口"，不是"容器内部"。** GreenMail 的 3025 没转发，所以你在笔记本上连不到它；但 ERP 容器和 GreenMail 在同一个 docker network 里，容器之间照样通。**网络可达性是有层次的，别默认"能访问"是一个全局属性。**
3. **它是临时的。** 停止 → 代理 URL 失效；删除 → 磁盘全没。这台机器上的一切都要能从 git + 脚本重建，这正是 `infra/start.sh` 存在的理由。

## 4. 状态放在哪：容器、卷、仓库

新手最容易丢的是数据，因为"数据在哪"有三层：

| 层 | 生命周期 | 本项目里的例子 |
|---|---|---|
| 容器文件系统 | 删容器就没了 | 临时文件、`/tmp/seed.py` |
| Docker 卷 | 保留到显式删除 | `sites`、`db-data`、`redis-queue-data` |
| 仓库 | 永久（只要推了） | 代码、seed 脚本、文档 |

所以：
- `docker compose stop` → 停容器，**卷还在**，下次启动几秒就起来；
- `docker compose down` → 删容器和网络，**卷还在**（除非加 `-v`）；
- `docker compose down -v` → **删卷**，数据库、站点、你建的 Inquiry 全没。

本项目的 `infra/stop-wsl.ps1`（以及 `docs/commands.md` 里那两行等价命令）用的是 `stop`，就是为这个。同理，Codespaces 里重建环境要跑 `start.sh`（会复用同名卷），而不是先 `down -v`。

## 5. 配额怎么算（Codespaces 为例）

- **core-hours = 核数 × 小时数**。GitHub Free 每月 120 core-hours，2 核机器就是 60 小时。
- 只要 codespace 处于 running 状态就在计费，**不管你有没有在用**；默认 30 分钟无操作自动停止。
- **storage 按 GB-month 累计**：15 GB-month 意味着"占用 15 GB 持续一个月"，或者"占用 30 GB 持续半个月"。拉一次 ERPNext 镜像约 2 GB，所以别囤一堆 codespace。
- 用完即删是最省的动作。

## 6. 用你自己的三次踩坑做练习

这三个都发生在同一天，且都是"层次搞错"的典型：

| 现象 | 真实原因 | 层次 |
|---|---|---|
| `mail:tests` 发了 7 封，Mailpit 里是空的 | 你设了 `MAILPIT_SMTP=:3025`，邮件进了 GreenMail；Mailpit 只听 1025 | **目标搞错**，不是端口不通 |
| `configurator` / `create-site` 显示 `Exited (0)` | 它们是一次性安装任务，跑完就退出，这是成功 | **把成功当失败** |
| `Cannot convert argument to a ByteString` | `.env.erp` 的 token 里混进了非 ASCII 字符，HTTP 头只允许 Latin-1 | **编码边界** |

练法：每遇到一个现象，先问"这是哪一层的问题"，再动手。这个习惯比记住任何命令都值钱。

## 7. 到一个新环境，按这 6 个问题走

1. **我拿到的是什么？** 一台能 SSH 的 VM，还是被代理的容器？（决定端口怎么暴露）
2. **有 Docker 吗？** `docker version` 能通吗？我能不 `sudo` 就跑吗？
3. **数据存在哪？** 卷名是什么？重建环境会不会丢？
4. **程序绑的是 `0.0.0.0` 还是 `127.0.0.1`？**
5. **防火墙在哪一层？** 我改的是云的规则，还是本机 ufw，还是 Docker 映射？
6. **崩了怎么看到日志？** `docker compose logs <service>`，以及一次性任务的 exit code。

## 8. 术语对照

| 词 | 一句话 |
|---|---|
| VM / 实例 | 一台虚拟的电脑 |
| 容器 | 一个被隔离的进程 + 它的文件系统 |
| 镜像 vs 容器 | 类 vs 对象；镜像是模板，容器是运行中的实例 |
| 卷 (volume) | 挂在容器外面的硬盘，删容器不删它 |
| 端口映射 | 宿主端口 → 容器端口 的转发规则 |
| 反向代理 | 前面那台机器帮你转发并加 TLS（Caddy/nginx） |
| 安全组 | 云平台层的防火墙，和主机内部防火墙互相独立 |
| 幂等 | 跑一次和跑十次结果一样；本项目的两个 seed 脚本都是 |
| 编排 (compose) | 用一份 YAML 描述"哪些容器 + 哪些卷 + 谁依赖谁" |

## 9. 下一步可以自己练的三件事

1. 在 Codespaces 里把 `infra/start.sh` 跑通，然后**故意**把 `127.0.0.1:8080:8080` 改成 `8080:8080`，观察 Ports 面板和访问结果有没有变化——亲手验证第 2 节的三层模型。
2. 用 `docker compose stop` / `down` / `down -v` 各试一次，每次之后数一下 `Inquiry` 还剩几条。
3. 把 `.env.erp` 里的 `ERP_URL` 指向 codespace 的公网 URL，从本地跑 `npm run inquiry:sync`，看权限错误和网络错误分别长什么样。

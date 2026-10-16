# Keel

自托管的 Unity 构建工具。检出工程，用登记过的编辑器调用仓库里的静态方法，归档 `ucl-output/`。

## 启动

需要 Node.js 18 以上和 Git。

```bash
npm install
npm run dev          # 服务端 :7850，前端 :5173
```

```bash
npm run build
npm start            # http://localhost:7850
```

```bash
docker compose up -d --build
```

顺序：设置里添加或下载 Unity，添加项目，新建构建配置，构建。

## 一次构建做什么

```
检出工作区 → 解析已登记的 Unity → 调用 executeMethod → 归档 ucl-output → 后置动作
```

命令是 `-batchmode -quit -projectPath -executeMethod -uclParams -logFile`。Linux 加 `-nographics`。没有内置 BuildPlayer，也不会往仓库里注入脚本。

Git 每次 `fetch` 后 `checkout --force --detach`。构建记录里有这次的 commit。方法没写出 `ucl-output/`，这次构建失败。工作区所在盘剩余不足 20GB，启动 Unity 前失败。

## 项目

- 本地目录必须是 Unity 工程根，包含 `Assets` 和 `ProjectSettings`。同步到工作区时不拷贝原来的 `Library`。
- Git 填仓库和分支。仓库根不是工程时填相对路径，例如 `Client`。需要时勾选子模块和 Git LFS。

Library 默认复用，每个项目的每个目标平台一份：`data/workspaces/project-<id>-<platform>`。缓存键是 `ProjectVersion.txt`、`manifest.json`、`packages-lock.json`、`ProjectSettings.asset`。任一变化就删除重建。同一项目同一平台互斥，不同平台可以同时跑。项目页可以清除 Library。

## 构建配置

`executeMethod` 必填，必须是仓库里已有的静态方法。`BuildCli.Run` 打应用，`BuildCli.RunResources` 只打热更资源包。保存和入队时为空都会拒绝。

Unity 版本必须和 `ProjectVersion.txt` 的完整版本一致，不会用别的已安装版本代替。自定义路径优先于已登记版本。

其余字段：目标平台、场景、Define Symbols、版本号、Development、输出文件名、产物保留天数。自定义参数注入为 `UCL_PARAM_*`，点构建时可以临时覆盖。

默认归档时剔除 `*_BackUpThisFolder_ButDontShipItWithYourGame` 和 `*_BurstDebugInformation_DoNotShip`。需要 IL2CPP 符号化时勾选保留。

## 仓库里的方法

`-uclParams` 的 JSON：

```
buildTarget / outputPath / scenes / defines / versionName / versionCode / development
```

环境变量还有 `UCL_OUTPUT_DIR`、`UCL_VERSION_NAME`、`UCL_PARAM_*`。产物必须写进 `ucl-output/`，Keel 只归档这个目录。失败时 `EditorApplication.Exit` 非 0。

## Unity

设置页只认两件事：

- 添加一个已安装的版本目录，例如 `D:\Unity\2022.3.7f1`。不扫描本机其他安装。移除只删列表，不删文件。
- Linux 上可以搜索版本并下载到「下载安装目录」。模块按次勾选，装过的可以再补。

构建前检查目标平台的 Build Support。工程使用 IL2CPP 时再检查 `il2cpp`。缺了就失败，不进 Unity。

批处理授权三选一：ULF 文件、账号加序列号、已经在这台机器上激活过的 Hub。

## 后置动作

成功、失败或总是，按配置依次执行。单个动作失败不改变构建结果。

| 类型 | 说明 |
|---|---|
| Webhook | POST JSON：`event/status/build/config/project/error` |
| 钉钉 / 飞书 | 机器人消息，secret 可选 |
| 脚本 | PowerShell / Shell / Python |

脚本环境变量：`UCL_BUILD_ID`、`UCL_PROJECT`、`UCL_CONFIG`、`UCL_BUILD_TARGET`、`UCL_UNITY_TARGET`、`UCL_VERSION_NAME`、`UCL_VERSION_CODE`、`UCL_BUILD_STATUS`、`UCL_WORKSPACE`、`UCL_OUTPUT_DIR`、`UCL_ARTIFACT_DIR`、`UCL_PARAM_*`。

## 触发

配置页生成：

```
POST http://<地址>/api/hooks/trigger/<token>
```

链接本身是凭证，不需要 API Token。重置后旧链接失效。

- `?RES_MODE=Online`
- `{"RES_MODE":"Online"}`
- 钉钉 outgoing 的回调地址填这个链接，群消息里的 `RES_MODE=Online` 会变成构建参数

## Agent

主实例在 Windows 或 Linux，iOS / macOS 交给 Mac。Agent 主动连主实例，不需要开放端口。产物传回后，后置动作仍在主实例执行。

```bash
npm run agent -w server -- --server http://<主实例>:7850 --token <token> --name mac-mini
```

等价环境变量：`UCL_SERVER`、`UCL_AGENT_TOKEN`、`UCL_AGENT_NAME`、`UCL_DATA_DIR`。

iOS 必须是 macOS Agent，没有在线 Agent 就继续排队。macOS 优先本机 Mac，否则给 macOS Agent。其他平台优先本机，本机满了才给空闲 Agent。Agent 上用 Git 项目，它自己拉代码。

## 部署

Windows 用 `npm run build && npm start`，数据在 `server/data/`。

Docker 卷 `/data` 保存数据库、仓库缓存、产物、日志和下载的 Unity。镜像含 git、xz 和 Linux Editor 运行依赖。对外暴露时设置 API Token，写操作带 `x-api-token`。触发链接和 Agent 回传不走这个 Token。

## 接口

```
GET/POST        /api/projects                 GET/PUT/DELETE /api/projects/:id
POST            /api/projects/:id/check
POST            /api/projects/:id/clear-cache
GET/POST        /api/configs?projectId=       GET/PUT/DELETE /api/configs/:id
GET/POST        /api/configs/:id/trigger
POST            /api/engine/configs/:id/build
POST            /api/engine/builds/:id/cancel
GET             /api/builds/:id               GET /api/builds/:id/log?offset=
GET             /api/artifacts/:id/download
GET/POST        /api/unity/installations      DELETE /api/unity/installations/:id
GET             /api/unity/releases?version=  POST /api/unity/download
GET/POST/DELETE /api/agents
POST            /api/hooks/trigger/:token
GET/PUT         /api/settings
```

WebSocket：`/ws` 给页面，`/agent` 给 Agent。

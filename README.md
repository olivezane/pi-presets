# presets —— pi 插件预设切换器

按场景切换「装哪些插件」。每个预设是一组 `settings.json` 顶层覆盖项（主要就是 `packages`），
可另带一份 `mcp.json`。切换时写盘 + reload，无需重装。

- 扩展本体：`extensions/presets.ts`（安装后由 pi 托管）
- 数据：`~/.pi/agent/presets.json`
- 改到的文件：`~/.pi/agent/settings.json`、`~/.pi/agent/mcp.json`

## 安装

```bash
pi install git:github.com/<用户名>/pi-presets
```

只想让某个预设用：`/preset add <预设名> git:github.com/<用户名>/pi-presets`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/preset` | 显示用法 + 预设列表 |
| `/preset add <source...>` | 往当前预设加包并 reload（例：`npm:pi-web-access`、`git:github.com/u/r`） |
| `/preset add <名字> <source...>` | 往指定预设加包；名字不存在就新建该预设（非当前预设只写 presets.json） |
| `/preset remove [<名字>] <source...>` | 移除包 |
| `/preset remove <名字>` | 删掉整个预设（二次确认，含其备份） |
| `/preset use [名字]` | 切换；不带名字弹列表 |
| `/preset update [名字\|*]` | 逐个预设跑 `pi update --extensions`（默认全部） |
| `/preset shared` | 看共享包 |
| `/preset shared add\|remove <source...>` | 改共享包，立即生效 |
| `/preset default [名字]` | 查/设默认预设（退出时恢复的目标） |

格式：`/preset <动作> [<预设名>] <插件...>`。`add`/`remove` 的第二个词若是现存预设名就是目标预设，否则当作插件 source（省略即当前预设）。动作永远在最前，切换一律走 `use`；只写 `/preset <预设名>` 会提示该用哪个动作。

`add` 后面跟一个不存在的名字（并且后面还有包）→ 新建该预设。`remove <名字>` 后面没有包 → 删预设，但**当前预设与默认预设不能删**（先 `use`/`default` 换掉），且必须确认；非交互界面（`hasUI: false`）下直接拒绝，不删任何东西。

## presets.json

```json
{
  "active": "web",
  "default": "default",
  "shared": ["npm:billion-context"],
  "presets": {
    "default": { "packages": ["npm:pi-web-access"] },
    "web": { "packages": ["npm:pi-web-access"], "mcp": { "mcpServers": {} } }
  }
}
```

- 实际加载 = `shared` + 该预设的 `packages`，按 source 去重。所有场景都要的插件放 `shared`。
- 预设里除 `mcp` 外的字段都原样写进 `settings.json`（可放 `defaultModel`、`defaultTools` 等）。
- 预设带 `mcp` → 切换时整份写入 `mcp.json`；不带 → 各预设共用现有 `mcp.json`。
- `default` 缺省为 `default`。

## 三种装插件的方式

1. `/preset add ...` —— 只进指定/当前预设。
2. `pi install ...` —— 进当前预设（下次任意 `/preset` 命令会把磁盘真实状态快照回去）。
3. `pi install -l` / `pi config -l` —— 项目级 `.pi/settings.json`，与预设无关，切预设不会清掉。

`/preset update` 只作用于预设里的包；固定版本号按设计不会自动升级。

## 兜底

- 写盘原子化（临时文件 + rename），崩溃不会留下半截 `settings.json`。
- 切换前存 `settings.json.<预设名>.bak` / `mcp.json.<预设名>.bak`；reload 失败自动回滚 settings 与 `active`。
- 非法预设（`packages` 非数组等）、损坏的 `presets.json`（含坏 `shared`）一律拒绝写盘并报错。
- 退出（`reason: "quit"`）自动切回默认预设；reload/new/resume/fork 不触发。
- 每次执行自动清理：残留 `*.json.tmp`、已删除预设留下的 `.bak`（旧命名 `settings.json.bak` 不动）。

## 限制

- 同时开多个 pi 时，写盘最后写入者赢（无锁）。
- 预设名不要含空格——`/preset use <名字>` 按空白切词。
- 切预设=改全局配置，所有会话下一次启动才一致。

## 卸掉

`pi remove git:github.com/<用户名>/pi-presets`，把 `settings.json` 改成想要的包列表；`presets.json` 可选保留。

改完本文件或扩展后需 `/reload` 或重启 pi。

## 开发

```bash
node test/main.mjs
```

`test/main.mjs` 把 `extensions/presets.ts` 复制进临时目录，换掉包导入（假 `getAgentDir`），再用假 `pi` 驱动真命令与钩子。每个场景一套独立临时目录，断言按段落排列：切换/快照/退出、语法、共享包、撞名预设、兜底、清理。


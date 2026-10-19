# Menuconfig for VS Code

在 VS Code 里配置 Kconfig 工程，并用 [Kconfiglib](https://github.com/ulfalizer/Kconfiglib)
生成 C 头文件（`autoconf.h` 风格的宏定义）。

本插件是 [menuconfig.py](./menuconfig.py) 的编辑器版本：扫描工程内所有 `Kconfig`，
生成聚合 `Kconfig.projbuild`，交给 Kconfiglib 解析。

**默认直接运行 Kconfiglib 自带的界面**（`python/vendor/menuconfig.py` 的 ncurses 版
或 `guiconfig.py` 的 Tk 版），在 VS Code 集成终端里使用，按键与 `make menuconfig` 一致：

```
Up/Down or j/k   move          Space  toggle / enter menu
Enter            enter / toggle          q     quit (asks to save)
/                jump to symbol          ?     keys help
F                show help   C  show name   A  show all
```

退出后自动从 `.config` 重新生成头文件。另提供可选的 Webview 面板（`menuconfig.ui = webview`）。

## 依赖

- VS Code 1.85+
- **Python 3.8+**（Kconfiglib 已内置在 `python/vendor/`，不需要 pip 安装）
- ncurses 界面需要 `curses` 模块：
  - Windows：`pip install windows-curses`
  - Linux / macOS：标准库自带
- 没有 `curses` 时自动退到 Tk 界面（`guiconfig`），Linux 上需 `python3-tk`

## 快速开始

1. 用 VS Code 打开包含 `Kconfig` 的工程目录。
2. 点击底部状态栏的 **menuconfig** 按钮（或命令面板 **Menuconfig: Open Configuration**），
   终端里出现 Kconfiglib 的 menuconfig。
3. 改完按 `q` → `y` 保存，退出后头文件自动生成。
4. 产物默认在头文件所在目录（默认工程根）：
   - `Kconfig.projbuild` —— 自动生成的聚合 Kconfig（请勿手改，建议加入 `.gitignore`）
   - `.config` —— 配置值
   - `rts_cfg.h` —— C 头文件（带 `#ifndef _RTS_CFG_H_` 包含保护）

## 命令

| 命令 | 作用 |
| --- | --- |
| `Menuconfig: Open Configuration` | 按 `menuconfig.ui` 打开配置界面（默认 Kconfiglib UI） |
| `Menuconfig: Open Kconfiglib UI (Terminal)` | 强制在集成终端里运行 Kconfiglib 的 menuconfig/guiconfig |
| `Menuconfig: Open Graphical Panel` | 强制打开本扩展的 Webview 面板 |
| `Menuconfig: Save .config` | 写出 `.config`（面板模式用） |
| `Menuconfig: Generate C Header` | 写出 C 头文件 |
| `Menuconfig: Save .config and Generate Header` | 二者一次完成（无需打开界面） |
| `Menuconfig: Reload Kconfig Files` | 重新扫描并解析 |
| `Menuconfig: Show Collected Kconfig Files` | 在输出面板列出扫描结果与警告 |
| `Menuconfig: Show Worker Log` | 查看 Python worker 日志 |

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `menuconfig.showStatusBar` | `true` | 是否在状态栏显示 **menuconfig** 按钮（无打开文件夹时自动隐藏；也可右键该按钮选择隐藏） |
| `menuconfig.ui` | `kconfiglib` | `kconfiglib`：终端里跑 Kconfiglib 自带界面；`webview`：本扩展的面板 |
| `menuconfig.kconfiglibUi` | `auto` | `auto`（优先 curses，不可用则 Tk）/ `menuconfig`（强制 curses）/ `guiconfig`（强制 Tk） |
| `menuconfig.menuconfigStyle` | `default` | `MENUCONFIG_STYLE`：`default` / `monochrome` / `aquatic` |
| `menuconfig.generateHeaderAfterUi` | `true` | Kconfiglib 界面退出后自动生成头文件 |
| `menuconfig.pythonPath` | `""` | Python 解释器路径；留空自动探测 `python` / `py -3` / `python3` |
| `menuconfig.searchRoot` | `${workspaceFolder}` | 扫描 Kconfig 的根目录 |
| `menuconfig.headerPath` | `${workspaceFolder}/rts_cfg.h` | 头文件输出路径；聚合 Kconfig 与默认 `.config` 也在同一目录 |
| `menuconfig.configPath` | `""` | `.config` 路径；留空为 `<头文件目录>/.config` |
| `menuconfig.kconfigName` | `Kconfig` | 扫描时识别的文件名 |
| `menuconfig.aggregateName` | `Kconfig.projbuild` | 聚合 Kconfig 的文件名 |
| `menuconfig.aggregateMode` | `roots` | `roots`：只聚合未被其他文件 `source` 的根文件（避免菜单重复）；`all`：与 `menuconfig.py` 完全一致，聚合全部发现文件 |
| `menuconfig.excludeDirs` | `[".git","build","out"]` | 扫描时跳过的目录名 |
| `menuconfig.env` | `{}` | 额外环境变量，如 `{"ARCH":"arm"}`；`srctree` 自动设置 |
| `menuconfig.includeGuard` | `true` | 是否给头文件加包含保护 |
| `menuconfig.saveOldConfig` | `false` | Webview 面板保存时是否保留 `.config.old`（终端界面由 Kconfiglib 自己写 `.config.old`） |

## 与 menuconfig.py 的对应关系

| menuconfig.py | 插件 |
| --- | --- |
| `find_kconfigs()` | `python/kconfig_worker.py: find_kconfigs()`（也被 `kconfig_ui.py` 复用） |
| `make_generated_kconfig()` | `write_aggregate()`（生成 `Kconfig.projbuild`） |
| `kconfiglib.Kconfig(...)` | 终端 UI 在 `kconfig_ui.py` 中解析；Webview 在常驻 worker 中解析 |
| `subprocess.call(["menuconfig", ...])` | `kconfig_ui.py` 直接调用 `menuconfig.menuconfig(kconf)`（进程内 ncurses） |
| `kconf.load_config(.config)` | 界面启动前加载；退出后重新从磁盘加载 |
| `kconf.write_autoconf(rts_cfg.h)` | 退出后自动生成（`menuconfig.generateHeaderAfterUi`） |
| 头文件包含保护后处理 | `write_header_file()`（内容不变时不重写，mtime 保持稳定） |

## 工作原理

默认（`menuconfig.ui = kconfiglib`）：

```
VS Code 集成终端 (ConPTY / pty)
   └─ python -u python/kconfig_ui.py --root … --header … --config … --ui auto
        ├─ 扫描 root 下所有 Kconfig          (kconfig_worker.find_kconfigs)
        ├─ 生成 Kconfig.projbuild            (kconfig_worker.write_aggregate)
        ├─ kconfiglib.Kconfig(projbuild)  →  Kconfig 对象
        ├─ menuconfig.menuconfig(kconf)  ← ncurses 界面（或 guiconfig 的 Tk 窗口）
        ├─ 退出后重新加载 .config
        └─ write_header_file()  →  带包含保护的 rts_cfg.h
```

可选（`menuconfig.ui = webview`）：扩展面板 + 常驻 worker，用 NDJSON 通信，
改值只回传差量，适合需要搜索/依赖面板/键盘以外的交互。

- `srctree` 被设为扫描根目录，因此 `source "arch/$(SRCARCH)/Kconfig"` 能正确解析。
- `KCONFIG_CONFIG` 指向配置的 `.config`，所以界面读写的就是插件配置文件。
- 符号可见性、`select`/`imply`、`choice` 语义全部由 Kconfiglib 决定，插件不做二次推断。

## 开发与调试

无需 Node.js / npm：扩展是纯 JavaScript，没有构建步骤。

1. 用 VS Code 打开本目录。
2. 按 `F5`（Run Extension）启动 Extension Development Host。
3. 在新窗口打开 `test/fixture`（或在任意 Kconfig 工程上测试）。
4. 底部状态栏应出现 **⚙ menuconfig** 按钮，点击即打开配置界面。

Python 侧可脱离 VS Code 自测：

```powershell
# 1) worker 协议 + 读写 .config + 头文件幂等性
python test\drive_worker.py

# 2) 非交互跑一遍 kconfig_ui 的完整流水线
python python\kconfig_ui.py --root test\fixture --header test\fixture\rts_cfg.h --selftest --set EXTRA=y

# 3) 真正驱动 ncurses 界面（需要 pywinpty；Windows 还需 windows-curses）
pip install pywinpty
python test\drive_curses_ui.py
```

## 已知限制

- 只识别文件名完全等于 `menuconfig.kconfigName`（默认 `Kconfig`）的文件；
  被 `source` 引入的 `Kconfig.*` 仍会经由 `source` 进入配置树。
- `aggregateMode: "all"` 会聚合每一个被发现的文件，若根 `Kconfig` 又 `source` 了子目录，
  树中会出现重复条目；仅在该行为确实需要时使用。
- 头文件为单个 `autoconf.h` 风格文件，不生成内核式 `include/config/*.h` 分片。
- 终端 UI 期间 `.config` 的写入由 Kconfiglib 完成；退出后插件重新读取并生成头文件。
  若在界面里选择"不保存"，头文件仍会按磁盘上现有的 `.config` 重新生成（幂等）。
- 目前没有文件监听：Kconfig 或 `.config` 被外部修改后请执行 **Reload**。
- 面板模式下关闭窗口不会丢弃未保存改动（worker 保留内存模型）；
  执行 **Reload** 才会从磁盘重新加载并覆盖内存模型。

## 目录结构

```
extension.js             扩展入口（纯 JS，无构建）
package.json             贡献点与设置
media/                   Webview 前端（HTML/CSS/JS，可选界面）
python/kconfig_ui.py     在终端里运行 Kconfiglib 自带界面（默认）
python/kconfig_worker.py 常驻 worker，供 Webview 面板使用（NDJSON）
python/vendor/           kconfiglib.py / menuconfig.py / guiconfig.py（ISC）
test/drive_worker.py     Python 侧端到端冒烟测试（worker 协议）
test/drive_curses_ui.py  PTY 驱动真实 ncurses 界面（需 pywinpty）
test/fixture/            测试用 Kconfig 工程
menuconfig.py            原始命令行实现（保留作参考）
plan.md                  开发任务书
```

## 许可证

MIT。`python/vendor/` 下的 kconfiglib、menuconfig、guiconfig 为 ISC 许可，
版权归 Ulf Magnusson / Nordic Semiconductor ASA，详见各文件头与 [NOTICE](./NOTICE)。

# DSH Plugin Hub 页面更正材料

页面：https://dsh-plugin.org/plugins/amoswzw/dsh-macos-menu-bar

本文件供仓库维护者认领或联系市场维护方时使用。市场详情页是独立编写的导读，不会直接显示本仓库 README；更新 README 后，页面中的安装命令、分类和图片仍需由市场方更新。

`awesome-dsh-plugin/awesome-dsh-plugin` 是另一份插件目录；其[投稿指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)要求在本仓库放置 `screenshots.json`。本仓库已按该规则声明两张 PNG 和一张演示 GIF，但这不保证 dsh-plugin.org 的页面自动采用这些图片。它的卡片图标还需在该目录的插件 YAML 条目里声明 `icon: https://raw.githubusercontent.com/amoswzw/dsh-macos-menu-bar/main/assets/icon-180.png`；仅添加图片文件不会自动替换作者头像。

## 图片

请把插件预览图设为：

https://raw.githubusercontent.com/amoswzw/dsh-macos-menu-bar/main/docs/screenshots/market-preview.png

图片由安装版 Desktop 的真实录屏画面及仓库中的刘海、审批预览截图排版而成。审批卡片是示例预览，点击按钮不会授权真实任务。另有[动画演示](https://raw.githubusercontent.com/amoswzw/dsh-macos-menu-bar/main/docs/screenshots/demo.gif)和[设置页截图](https://raw.githubusercontent.com/amoswzw/dsh-macos-menu-bar/main/docs/screenshots/settings.png)。

## 页面内容

- 分类：UI & Experience（当前页面显示为“工具与能力”）。
- 平台：仅 macOS，且仅 Desktop profile。
- 推荐安装命令：`dsh plugin --profile desktop add @amoswzw/dsh-macos-menu-bar`。
- 兼容范围：Node.js 22+；DeepSeek Harness Desktop `>=0.2.2-rc.3 <0.2.3`。
- 安装后须完全退出并重开 Desktop。
- GitHub 源码安装是命令行备选方式：`dsh plugin --profile desktop add github:amoswzw/dsh-macos-menu-bar`。

当前页面展示的 `dsh plugin --profile <your-profile> add github:amoswzw/dsh-macos-menu-bar` 是通用模板，可能引导用户安装到不受支持的 Web profile。页面中的插件市场教程图片也不是本插件截图。

**简短介绍：**把现有 DeepSeek Harness Desktop 窗口变为 macOS 菜单栏弹窗，可选刘海悬停入口和审批卡片；审批默认使用原生确认框，拒绝为默认选择。

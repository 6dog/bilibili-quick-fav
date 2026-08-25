# bilibili-quick-fav

[![version](https://img.shields.io/badge/version-1.63-blue.svg)](./bilibili-quick-fav.user.js)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

给 B 站加两个顺手功能：

- 视频封面载入时提前准备书签按钮，鼠标悬停立即显示并可一键收藏
- 播放页默认 1.5 倍速，并尊重手动切换

## 安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开 [`bilibili-quick-fav.user.js`](./bilibili-quick-fav.user.js)
3. 点击 `Raw` 安装

### 自动更新

v1.62 起脚本内置 GitHub Raw 更新地址。Tampermonkey 会按扩展设置中的
检查周期读取远程 `@version`；发现更高版本后自动下载更新。安装一次 v1.62
后，后续版本不再需要重复打开 Raw 页面。

v1.63 将收藏按钮迁移到独立 Shadow DOM 浮层，不再向 B 站管理的视频卡片、
详情工具栏或顶部栏写入子元素、属性和样式，避免 SPA 重挂载时出现顶部空栏。

自动更新只会获取 `main` 分支已经发布的版本，本地尚未推送的修改不会进入
你的浏览器。

## 功能

### 一键收藏

- 视频卡片悬停时，左上角显示书签按钮
- 点击收藏到你预先选择的快捷收藏夹
- 再点一次即可取消收藏
- 视频详情页工具栏旁也会显示同样的快捷收藏按钮

### 默认倍速

- 视频页默认切到 `1.5x`
- 切换分 P、清晰度或播放器重置后会自动补回
- 如果你手动选了别的倍速，当前视频不再强制接管

## 支持页面

- 首页、热门、排行榜
- 搜索结果、分区页、用户主页
- 动态页、收藏夹页
- 视频详情页、合集、多 P

## 自定义

可以直接修改脚本顶部常量：

```js
const DEFAULT_PLAYBACK_RATE = 1.5;
const ENABLE_DEFAULT_RATE = true;
const PLAYBACK_BOOTSTRAP_DELAY_MS = 1500;
```

## 专用测试浏览器

为了避免自动化测试影响日常 Chrome，可以使用独立测试 profile：

```bash
# 第一次：打开可见窗口，登录 B 站并安装/确认脚本
scripts/open-test-browser.sh

# 之后：启动同一份 profile 的无头浏览器
scripts/start-headless-browser.sh

# 检查无头浏览器是否已登录、脚本是否生效
scripts/check-test-browser.js

# 注入当前工作区脚本，检查 Shadow DOM、顶部栏和悬停显示
scripts/check-test-browser.js --inject-local-script

# 可选：检查语义路由和用户手动改速；真实收藏测试会自动恢复原状态
scripts/check-test-browser.js --inject-local-script --probe-semantic-route
scripts/check-test-browser.js --inject-local-script --probe-manual-rate
scripts/check-test-browser.js --inject-local-script --toggle-detail-favorite
```

默认 profile 存在 `~/.codex-browsers/bilibili-quick-fav`，不会提交到 Git；无头浏览器默认静音。

## 常见问题

**按钮没反应**

请先确认已经登录 B 站。收藏接口依赖登录态。

**想重新选择快捷收藏夹**

清空脚本存储，或在控制台执行：

```js
GM_deleteValue("qfav_folder_id");
```

**不想启用默认倍速**

把 `ENABLE_DEFAULT_RATE` 改成 `false`，或者把 `DEFAULT_PLAYBACK_RATE` 改成 `1`。

## 说明

- 请求只会发往 `api.bilibili.com`
- 本地只保存快捷收藏夹 ID 和名称
- 单文件脚本，无构建步骤

## 反馈

有问题或新需求，欢迎提 [Issue](https://github.com/6dog/bilibili-quick-fav/issues)。

## License

[MIT](./LICENSE)

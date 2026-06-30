# bilibili-quick-fav

[![version](https://img.shields.io/badge/version-1.54-blue.svg)](./bilibili-quick-fav.user.js)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

给 B 站加两个顺手功能：

- 视频封面悬停显示书签按钮，一键收藏到指定收藏夹
- 播放页默认 1.5 倍速，并尊重手动切换

## 安装

1. 安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开 [`bilibili-quick-fav.user.js`](./bilibili-quick-fav.user.js)
3. 点击 `Raw` 安装

## 功能

### 一键收藏

- 视频卡片悬停时，左上角显示书签按钮
- 点击收藏到你预先选择的快捷收藏夹
- 再点一次即可取消收藏
- 视频详情页工具栏也会插入同样的快捷收藏按钮

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
const KEEP_TOP_BAR_VISIBLE = false;
const ENABLE_DEFAULT_RATE = true;
const DOM_BOOTSTRAP_DELAY_MS = 1500;
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

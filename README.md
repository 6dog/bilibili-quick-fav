# bilibili-quick-fav

[![version](https://img.shields.io/badge/version-1.2.1-blue.svg)](./bilibili-quick-fav.user.js)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

一个让 B 站浏览更顺手的油猴脚本。

- 🔖 **一键收藏**：视频封面上悬停就出现书签按钮，一下点进指定收藏夹，不用再点进详情页
- ⚡ **默认 1.5 倍速**：自动把播放速度设成 1.5x，手动改了倍速就尊重你的选择

---

## 安装

1. 先装一个用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/)
2. 点击 [`bilibili-quick-fav.user.js`](./bilibili-quick-fav.user.js) → 右上角 **Raw** 按钮 → 管理器会自动弹出安装确认框
3. 打开 B 站，首次点击收藏按钮时选定一个"快捷收藏夹"即可

---

## 截图

> _待补充：建议放一张视频卡片 hover 出书签按钮的截图、一张详情页工具栏书签按钮的截图。_

---

## 功能与 FAQ

完整功能说明、常见问题、适用页面范围、隐私声明见 [description.md](./description.md)。

---

## 自定义

脚本顶部几个常量可以直接改：

```js
const DEFAULT_PLAYBACK_RATE = 1.5; // 默认倍速
const KEEP_TOP_BAR_VISIBLE = false; // 顶部栏保活（debug 用，建议保持 false）
const ENABLE_DEFAULT_RATE = true; // 整个倍速功能的总开关
const DOM_BOOTSTRAP_DELAY_MS = 1500; // DOM 扫描延迟（避开 B 站 SPA 初始挂载）
```

---

## 开发说明

脚本是单文件 `bilibili-quick-fav.user.js`，没有构建步骤。改完存盘，Tampermonkey 会自动重载。

核心模块：

| 模块                         | 作用                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `scanVideoCards`             | 扫描首页/分区/搜索/收藏夹里的视频卡片，往封面注入书签按钮    |
| `injectDetailButton`         | 往视频详情页工具栏插书签按钮                                 |
| `startEarlyVideoInterceptor` | 在 `<video>` 元素插入 DOM 的瞬间同步写 `defaultPlaybackRate` |
| `startFastRateBootstrap`     | rAF 高频兜底，确保倍速被偶发重置后能立刻再接管               |

---

## 许可

[MIT](./LICENSE) © jesseyun

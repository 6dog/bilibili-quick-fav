# Chrome Web Store 2.0.5 提交资料

## 冻结包

- 上传文件：`dist/release/bilibili-quick-fav-2.0.5.zip`
- SHA-256：`ef581c0e4ba8f7c8f5df1baae59a930e67a465a7ea27296259b6013fdccf9843`
- ZIP 内 10 个文件：`BUILD_VERSION`、`content.js`、`manifest.json`、4 个 PNG 图标、`popup/index.html`、`popup/popup.css`、`popup/popup.js`。
- 运行代码未在真实写入验收后改动；2.0.5 真实收藏测试只更改一个目标收藏夹并恢复。

## 素材与文案

- 扩展图标：ZIP 内 `icons/icon-128.png`，128×128 PNG。
- 小推广图：`dist/store-assets/small-promo-440x280.png`，440×280 PNG。
- 真实截图：`dist/store-assets/picker-1280x800.png`、`cover-1280x800.png`、`screenshot-1280x800.png`，均为 1280×800 PNG。建议按此顺序上传。
- 名称、简短说明、详细说明和用途：`store/listing-zh-CN.md`。
- 审核测试步骤：`store/review-notes.md`。
- 隐私政策：`https://github.com/6dog/bilibili-quick-fav/blob/main/PRIVACY.md`。
- 支持链接：`https://github.com/6dog/bilibili-quick-fav/issues`。

## 隐私字段填写依据

- 单一用途：在 B站普通视频页面提供指定收藏夹的快捷加入与移除，以及可关闭的默认播放倍速。
- `storage` 权限：按 B站账号在 Chrome 本机保存所选收藏夹及默认倍速开关。
- 远程代码：无。扩展仅执行 ZIP 内的本地脚本；B站 API 响应作为数据处理。
- 数据处理：本机保存账号 MID、收藏夹 ID 和名称、倍速开关；处理当前视频编号与收藏状态；收藏写入时临时使用页面 CSRF 值，浏览器向 B站请求时携带其登录 Cookie。扩展不向开发者服务器传送数据。
- Limited Use：按 `PRIVACY.md` 的明确声明勾选与政策一致的认证项。后台数据类别须依据实际界面逐项核对，不能简单选“无数据”。

## 分发和提交

- 公开，全部支持地区。
- 提交审核时取消“审核通过后自动发布”，确认处于暂缓发布状态。
- 开发者账户尚待注册、缴费、接受协议及启用两步验证；完成后才能创建商店条目。

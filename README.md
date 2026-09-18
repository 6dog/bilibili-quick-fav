# B站快捷收藏与默认倍速

1.0 正式版是原油猴脚本的 Chrome Manifest V3 重写版。后续只维护 Chrome 扩展，旧的
`bilibili-quick-fav.user.js` 仅作为 Legacy 回退保留。

## 功能

- 在可识别普通 BVID 的真实视频封面上，悬停显示快捷收藏按钮。
- 收藏和取消只作用于你选定的“快捷收藏夹”，不会修改其他收藏夹。
- 视频详情页在播放器下方提供同一套快捷收藏按钮。
- 普通视频默认使用 1.5 倍速；当前视频手动调速后不再抢回，切换到下一个视频或分 P 后重新应用默认值。
- 不处理直播、文章、广告、首页静音预览和无法映射到普通 BVID 的活动卡片。

## 本地安装

1. 安装 Node.js 22.12 以上的 22.x 版本，或 Node.js 24 及以上版本。
2. 在项目目录运行 `npm install` 和 `npm run package`。
3. 打开 Chrome 的 `chrome://extensions`，启用“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择 `dist/extension`。
5. 禁用旧版油猴脚本，避免两个版本同时注入。

首次点击收藏按钮时会要求选择快捷收藏夹。也可以点击 Chrome 工具栏中的扩展图标重新选择，并开关默认倍速。

## 开发与验证

- `npm run typecheck`：TypeScript 类型检查。
- `npm test`：单元和 DOM 测试。
- `npm run package`：生成扩展目录和确定性商店 ZIP。
- `npm run check`：依次执行上述完整本地门禁。
- `npm run test:release`：从待上传 ZIP 临时安装并执行只读浏览器门禁，不修改真实收藏。
- `npm run test:release:write`：仅在已授权的隔离账号中执行一次加入与撤销；自动选用首次使用时未收藏的目录，或已配置的目标目录。可设置 `QFAV_TEST_FOLDER_ID=收藏夹ID` 限定目录。脚本预检所有目录状态，只恢复本次目标目录。

最终上传文件位于 `dist/release/bilibili-quick-fav-<版本号>.zip`。商店审核使用的版本应当重新从该 ZIP 安装并完成真实浏览器验收。商店截图须取自实际运行页面，不使用示意图。
商店截图来自隔离 Chrome 中安装该 ZIP 后的真实页面：`assets/store-cover.png` 展示封面悬停按钮，`assets/store-picker.png` 展示首次选择框，`assets/store-screenshot.png` 展示视频详情页。若页面或界面改变，应重新截取并核对。

## 隐私

本扩展没有广告、分析、远程代码或开发者服务器。详见 [PRIVACY.md](PRIVACY.md)。

## Legacy 油猴版

旧版 `bilibili-quick-fav.user.js` 保留为只读回退，不迁移 GM 存储，也不再发布功能更新。Chrome 扩展首次使用时需要重新选择快捷收藏夹。

## 反馈与许可

有问题可提交 [Issue](https://github.com/6dog/bilibili-quick-fav/issues)。本项目使用 [MIT License](LICENSE)。

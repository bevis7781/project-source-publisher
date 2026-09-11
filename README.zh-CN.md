# Project Source Publisher

将 ChatGPT Project 会话中当前已加载的 assistant 回复里的 1–10 个 Markdown 文件，发布到由 Google Drive 支持的 Project Sources。

> **状态：GITHUB PUBLIC BETA / EDGE PRE-RELEASE（GitHub 公开 Beta / Edge 预发布）。** 公开源码仓库已上线：[github.com/bevis7781/project-source-publisher](https://github.com/bevis7781/project-source-publisher)。Microsoft Edge Add-ons 仍是首个计划使用的商店渠道，但商店列表尚未公开，目前没有受支持的公开安装链接。项目仍处于 Beta、商店前分发阶段；直接加载任意 Git clone 不是受支持的 OAuth 安装路径。Chrome Web Store 计划后续支持。

## 为什么需要它

把生成的 Markdown 放入 Project Sources，通常需要下载文件、写入 Drive，再逐个手动设置来源。Project Source Publisher 让这条流程更集中、更可预期。

## 工作方式

1. 选择当前已加载、可见且包含文件 artifact 的最新 assistant 批次，不跨不同批次合并文件。
2. 支持 1–10 个 Markdown。首次使用时授权 Google Drive，并在 Project Sources 页面按来源执行 **复制 Drive 链接 → Add**。
3. 来源建立后，只刷新文件名精确匹配的既有来源，保留其 Drive file ID，并通过回读校验写入结果。
4. 自动跟随当前 ChatGPT Project 的上下文；重装恢复前会核对精确的来源身份。
5. 只有每个目标都有完成确认依据时，才显示已发布。

## 功能

- 通过 ChatGPT 生成的下载链接捕获选定的 Markdown 文件。
- 多来源时按文件保留并显示进度。
- 不只凭文件名猜测身份，保留已建立的来源身份。
- 提供中文和英文界面。

## 已知限制

- 只检查当前 ChatGPT Project 会话中已经加载且可见的内容，不是完整历史搜索。
- 首次 Add 可能已经把文件保存到 Drive，但 PSP 无法从可观察的 ChatGPT 状态确认完成。**已保存到 Drive · 暂时无法确认**是已知限制，不代表失败；得到确认前不会显示已发布。
- PSP 不是通用 Source Manager，不会自动添加新文件名，也不执行重命名、删除、合并、拆分或任意上传管理。
- ChatGPT 界面变化可能影响流程；需要 Google Drive、受支持的 Microsoft Edge 浏览器和已登录的 ChatGPT 会话。
- 这份源码不是受支持的公开安装包。直接加载任意 Git clone 不是受支持的 OAuth 安装路径，不应期待这样就能使 Google OAuth 可用。

## 隐私与权限

- Google Drive 只使用 `https://www.googleapis.com/auth/drive.file` scope。
- 扩展使用 `activeTab`、`scripting`、`downloads`、`identity` 和 `storage` 权限，访问范围限于流程所需的 ChatGPT 与 Google API 页面。
- 不运营开发者后端、遥测、广告或数据经纪业务。OAuth access token 只在扩展内暂时处理，不发送到开发者运营的服务器。
- Project Source Publisher 是独立项目，属于非官方工具，不隶属于 OpenAI 或 Google，也未获得其背书或赞助。

详见[隐私政策](PRIVACY.md)、[安全政策](SECURITY.md)和 [MIT 许可证](LICENSE)。

## 发布状态

**GITHUB PUBLIC BETA / EDGE PRE-RELEASE（GitHub 公开 Beta / Edge 预发布）**

GitHub Public Beta 已在 [github.com/bevis7781/project-source-publisher](https://github.com/bevis7781/project-source-publisher) 上线。Microsoft Edge Add-ons 是首个计划使用的商店渠道，但商店列表尚未公开，目前没有受支持的公开安装链接。本地 Edge ZIP 不会作为公开下载提供，也没有 GitHub Release。Chrome Web Store 计划后续支持；以上状态不代表任一商店已审核通过。

## 许可证

MIT

# Project Source Publisher

[English](README.md) | **简体中文**

**Markdown 改好了，让 ChatGPT Project 里的来源也跟着更新。**

这款浏览器扩展将 Project 会话中生成的 Markdown 文件保存到 Google Drive，并刷新你已连接的 Project Sources（项目来源），减少在 ChatGPT 和 Drive 之间反复搬运文件的工作。

**第一次**：逐个连接来源 → **以后**：生成同名修订文件 → **发布**

## 当前能安装吗？

**v0.3.1 · GitHub 公开 Beta · Edge Add-ons 已提交，审核中**

源码已经公开。Edge 安装包已通过包验证并提交审核，这不代表商店审核通过。商店页面尚未上线，因此目前**没有受支持的公开安装链接**，商店安装版本的实际运行测试也尚未进行。

直接将任意 Git clone 作为解压扩展加载，不是受支持的 Google OAuth 安装路径。Chrome Web Store 分发已暂缓，尚未发布。

想试用的话，可以之后回到本节查看正式的 Edge 安装入口；现在也可以到 [Issues 提问或分享使用场景](https://github.com/bevis7781/project-source-publisher/issues)。

## 它省掉哪部分工作？

如果你经常在 ChatGPT Project 中修改计划、规格说明或参考笔记，麻烦的往往不是改内容，而是把每次改好的 Markdown 再更新到项目来源里。

用 PSP 建好来源后，不用每次都手动下载修订文件、替换 Drive 内容，再触发来源刷新。点击**发布**，PSP 会更新既有 Drive 文件并执行刷新。文件名必须完全一致，底层 Drive 文件 ID 保持不变。

例如：先连接 `plan.md`，以后在同一个 Project 中生成新版 `plan.md`，再发布，就能更新这个来源。

## 怎么使用

### 第一次：连接来源

1. 打开 ChatGPT Project 会话，让生成的 Markdown 文件处于已加载、可见状态。
2. 打开 PSP，点击**发布**，按提示授权 Google Drive。
3. 对每个来源，在 Project Sources 页面完成**复制 Drive 链接 → Add**。这一步需要你逐个文件操作。

### 日常更新：发布修订文件

1. 在 Project 会话里生成修订后的 Markdown，保持已建立来源的文件名不变。
2. 打开 PSP，点击**发布**。它会核对已绑定文件的身份，写入更新并回读校验内容，然后刷新来源。
3. 查看每个文件的进度。只有全部目标都有充分的完成确认，整体才会显示**已发布**。

PSP 会自动跟随当前 ChatGPT Project，提供中英文界面；重新安装后，恢复连接前会先核对来源身份。

## 使用边界与已知限制

- **一次处理同一条回复中的 1–10 个 Markdown 文件。** PSP 使用当前已加载、可见且含文件附件的最新一条助手回复，不跨回复拼接，也不搜索完整会话历史。如果较新的附件回复只有非 Markdown 文件，不会退回去寻找旧的 Markdown。
- **日常刷新只更新已建立的来源。** 新文件名或改过的文件名不会在刷新时自动添加，相似名称也不会被当成替代关系。PSP 不是通用来源管理器，不提供重命名、删除、合并、拆分或任意上传。
- **保存到 Drive 不等于来源更新已确认。** 首次 Add 可能显示**已保存到 Drive · 暂时无法确认**（Saved to Drive · confirmation unavailable）。文件已经保存，但 PSP 无法从可观察的 ChatGPT 状态确认最终完成。这不代表保存失败，也不等于已确认发布。
- **平台兼容性可能变化。** 需要 Google Drive，以及已登录且能使用 Drive 来源的 ChatGPT Project 会话。流程依赖 ChatGPT 界面和会话行为，并非官方 OpenAI API 集成；界面或平台政策变化可能影响功能，甚至使其无法运行。

## 隐私与信任

PSP 在浏览器中运行，**没有开发者后端、遥测或广告**。选中的 Markdown 会发送到你的 Google Drive，运行所需的元数据保存在扩展本地。

Google Drive 仅使用 `drive.file` 授权范围，不请求整个 Drive 的访问权限。浏览器权限为 `activeTab`、`scripting`、`downloads`、`identity` 和 `storage`，站点访问限于 ChatGPT 与 Google API。[隐私政策](PRIVACY.md)说明了数据处理、授权和保留方式。

这是独立的非官方项目，不隶属于 OpenAI 或 Google，也未获得其背书或赞助。

[安全政策](SECURITY.md) · [更新日志](CHANGELOG.md) · [MIT 许可证](LICENSE)

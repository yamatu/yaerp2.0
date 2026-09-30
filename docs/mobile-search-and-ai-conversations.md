# 手机表格检索与云端 AI 会话

## 手机交互

- 表格左下角搜索按钮搜索当前页面中的最新内容（包括尚未保存但已结束编辑的值），显示位置和匹配数量；上一条/下一条会选择并滚动到单元格。
- 手机提供撤销、重做和虚拟方向键。方向键先结束当前输入，再移动到相邻单元格；中间的编辑按钮只修改一个单元格，不批量覆盖选区。
- 隐藏占位符不参与内容搜索。编辑继续使用现有单元格权限、保护和保存/审批流程。
- 协作浮窗通过顶部按钮拖动，按钮预先禁用浏览器触摸平移，并捕获指针；拖动结束后的点击不会意外开关浮窗。
- 撤销/重做属于当前编辑器的操作栈，重新加载后的恢复请使用版本历史。

## AI 检索

- 模型启动只接收已授权的工作簿结构，不为上下文预读全部单元格。
- 默认先查当前工作簿、当前表；知道名称/ID时直接缩小范围。只有需要跨工作簿时才扩大范围。
- `search_sheet_content` 和 `search_sheet_rows` 在 PostgreSQL 合并 `rows.data` 与最新 `sheets.config.univerSheetData`，快照中的有效值覆盖旧值，部分快照保留其它物理行。不能退回只查 `rows` 的实现。
- SQL 只传回候选页；服务端再次按用户/部门/行/列/单元格权限和隐藏保护过滤，并仅对可见值进行匹配。权限矩阵只在一次操作内复用，不跨请求缓存内容或权限。
- 搜索限制/候选预算耗尽时明确返回 `has_more`，不能把不完整扫描报告为“没有数据”。公开续查位置不来自隐藏命中的行号。
- 此实现减少快照传输、逐格数据库查询和模型工具往返；并未新增子串索引，SQL 仍需扫描目标表的有效内容。

## 云端会话与后台任务

新增迁移：`backend/migrations/052_ai_conversations.sql`，由现有启动迁移机制执行。

- 会话、消息、进度和最终结果保存在 PostgreSQL，按登录账号隔离；同账号的手机/电脑可以选择同一历史会话继续。
- 页面仅观察任务；关闭面板、浏览器断网或关闭浏览器不会取消已接受的后台任务。只有“停止”按钮调用显式取消接口。
- 新建对话不清空其它会话。首次使用且云端为空时，导入本机旧历史的文字，不导入旧的待执行方案。
- 提交使用 `request_id` 去重；数据库还限制同一会话最多一个活动任务。同账号最多两个活动会话，全局同时执行四个任务；排队及执行共享 30 分钟超时。
- 待确认方案由服务端原子领取；确认后的写入、回执和 Agent 后续步骤也在后台执行，不依赖浏览器回调。执行的方案来自账号拥有的历史消息，不信任客户端重传的写入内容。另一设备不能重复执行相同方案。
- 失败/中断的写入需先核对已执行操作并生成新方案，不能自动重放。排队阶段取消且尚未开始写入的方案可以重新确认。
- 观察使用增量版本轮询，未变化时不重复传输全部历史；只加载最近 40 条历史文字，并限制历史上下文体积，不把整个会话历史传给模型。没有新的页面上下文时复用会话保存的工作簿上下文，并重新校验工具数据权限。
- 当前任务执行器用于**单个后端进程**，不支持多副本共享任务。服务器重启后未完成任务标记为 `interrupted`，保留已保存进度，不自动重放可能已提交的写入。数据库历史不是独立备份。
- 旧 `/ai/chat/stream` API 为兼容保留，其请求绑定的取消语义不变；新的网页面板使用 `/ai/conversations/:id/turns`。

## 验证

```sh
cd backend
# 单测包含账号隔离、幂等提交、观察断线后继续执行、跨设备领取保护。
go test ./internal/service -run 'TestConversation|TestVisibleSearch|TestVisibleRowData|TestChatWorkbookContext' -count=1
go build ./...
go vet ./...
```

```sh
cd frontend
npx tsc --noEmit
```

无 Docker 时，可在仓库外的临时目录安装 PostgreSQL/WASM 测试运行时（不加入生产前端依赖）：

```sh
npm install --prefix <scratch-dir> --no-audit --no-fund @electric-sql/pglite@0.3.14
node scripts/tests/sheet-search-sql.mjs <scratch-dir>/node_modules/@electric-sql/pglite/dist/index.js
node scripts/tests/ai-conversations-sql.mjs <scratch-dir>/node_modules/@electric-sql/pglite/dist/index.js
```

仓库还提供无浏览器的 React/手势契约测试（依赖同样安装在临时目录）：

```sh
npm install --prefix <scratch-front> --no-audit --no-fund react@18.3.1 react-test-renderer@18.3.1
node scripts/tests/frontend-interactions.cjs <scratch-front>/node_modules
```

覆盖跨设备观察、关闭/重新打开、提交去重、显式取消、搜索定位、编辑后方向移动、非画布手势隔离和浮窗指针捕获。

仍应在真实部署手测：手机单指滚动与搜索定位、输入中文后连续方向移动、撤销重做、拖动协作浮窗；提交 AI 任务后关闭网页并用另一台设备查看进度/结果；服务器重启后确认中断提示及没有重放写入。SQL/WASM 和模拟数据库单测不替代浏览器/真实 PostgreSQL 端到端测试。

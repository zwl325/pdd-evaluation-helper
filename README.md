# PDD 评价筛选助手

版本：2026-10-12.1。安装文件：`pdd-evaluation-filter.user.js`。

公开仓库：[zwl325/pdd-evaluation-helper](https://github.com/zwl325/pdd-evaluation-helper)。

**[点击安装 / 更新 Tampermonkey 脚本](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js)**

这一版实现“4星”“5星”“未回复”三个筛选目标的选择操作。脚本在浏览器页面内完成定位、点击、等待和状态核验，这些动作不需要外部 CDP 连接。默认由面板按钮触发，加载页面不会自动改变筛选条件。

## 安装和使用

1. 在已启用 Tampermonkey 的浏览器打开上面的安装链接，在扩展安装界面确认安装。
2. 如果浏览器仅显示源代码，可复制全部内容，在 Tampermonkey 中创建新脚本，替换默认示例代码，保存并启用。
3. 刷新已登录的拼多多商家后台，从首页进入商品评价页面，或打开评价页地址：
   `https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenav`。
4. 在右下角“PDD 评价筛选助手”中，点击三个独立按钮之一，或“一键选择 4星 + 5星 + 未回复”。
5. 等待面板显示实际选中状态和核验结果。需要执行搜索时，再手动点击页面原有的“查询”。

首页上的面板会提示打开评价页；筛选DOM加载完成后，对应操作按钮才可用。后台其他页面默认隐藏面板。在首页与评价页之间进行单页路由切换时，不需要重新连接外部自动化程序。

“检查状态”只读取当前页面。“停止”终止尚未完成的动作与等待，已经选中的条件保留。面板可收起和展开。

## 远程自动更新

元数据已配置两个公开更新源：

| 配置 | 地址 | 用途 |
| --- | --- | --- |
| `@updateURL` | [pdd-evaluation-filter.meta.js](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.meta.js) | Tampermonkey检查版本，下载轻量元数据 |
| `@downloadURL` | [pdd-evaluation-filter.user.js](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js) | 有新版本时下载完整脚本 |

两个地址都跟随 `main` 分支。自动更新的检查周期由本机 Tampermonkey 设置决定；每次推送会触发GitHub Actions检查脚本语法与元数据一致性。

如果此前已手动安装2026-10-12版，需要通过安装链接更新一次，或将本地代码替换为本版，以写入更新源。保留了原有 `@name` 和 `@namespace`，本次版本号提升到2026-10-12.1。之后可在Tampermonkey中手动检查更新，或等待其自动检查。

维护者发布新版本的步骤：

1. 修改业务代码，在 `.user.js` 中同时递增 `@version` 和 `Config.version`。同一天继续发布可使用 `2026-10-12.2`；下一天使用 `2026-10-13`。
2. 运行 `node scripts/sync-metadata.cjs`，自动从主脚本头部生成 `.meta.js`。不要手工分别维护两份元数据。
3. 运行 `node --check pdd-evaluation-filter.user.js` 和 `node scripts/sync-metadata.cjs --check`。有行为变更时运行离线浏览器测试。
4. 使用 `git` 提交并推送到 `main`。Tampermonkey比较版本号后下载新脚本；只提交代码而不递增版本不会形成新的更新版本。

更新机制采用Tampermonkey原生能力，业务脚本没有额外的网络轮询、远程代码执行或`eval`更新逻辑。

## 当前行为

- 按顺序处理：4星 → 5星 → 未回复；独立按钮仅处理指定项。
- 每次动作前都重新定位。定位必须处于可见评价容器内，文字精确匹配且可见目标唯一。
- class 已含 `btn_checked` 的目标跳过点击，重复执行不会主动将已选项切换为未选。
- 每个需要执行的目标最多点击一次；点击后核验选中状态连续稳定 300ms。
- 最终重新联合核验本次要求的目标，避免后面的选择把前面的条件取消。
- 一键执行完成前检查是否仍有 1星、2星、3星或已回复被选中；若有，则报告冲突，供用户手动核查。
- 单次等待上限 6 秒。缺失、禁用、重复目标、超时、页面地址变化或用户停止，都不会触发盲目重试点击。
- 有执行锁，连续点击面板或并发调用接口不会产生两组同时运行的点击动作。

操作不会自动清除未指定的条件。日期、商品ID、查询、分页、回复内容填写及提交均未加入本版动作。原始清单中有关历史日期、条数和回复的记录只是背景材料，没有迁移为可执行业务流程。

## 模块和维护入口

脚本保留为一个可直接安装的文件，内部按职责分为六个模块：

| 模块 | 职责 | 后续维护 |
| --- | --- | --- |
| `Config` | 目标文案、选择器、状态标记、等待时间 | 页面DOM改变时优先更新这里 |
| `DOM` | 可见性、可操作性、唯一定位、只读状态快照 | 增加新的明确作用域定位函数 |
| `Wait` | DOM观察、状态轮询、稳定窗口、超时与取消 | 可供将来的日期、查询等模块复用 |
| `Actions` | 顺序选择、执行锁、跳过已选、最终核验 | 将新增业务拆成独立动作模块 |
| `Panel` | 操作按钮、状态、错误反馈 | Shadow DOM隔离样式，动态文字用textContent |
| `App` | 延迟加载、路由变化、重复注入和页面生命周期 | 管理挂载、解绑与BFCache恢复 |

目前定位依据来自用户提供的 `Tampermonkey-点击动作DOM定位清单.md` 和同目录 `stars-step.js`。清单注明基于历史结构，并非本次真实页面采集。

候选范围：

```css
#mf-mms-goods-container div[class*="evaluation_search_btn"]
```

筛选文字使用 `innerText.trim()` 精确匹配“4星”“5星”“未回复”；选中判断使用 class 中的 `btn_checked` 片段。没有使用按钮序号、长串 `nth-child` 或模糊的全页文本点击。

后续增加回复业务时，应该独立设计记录身份核验、提交锁与提交结果证据，不能直接沿用筛选点击的成功判断。

## 本页接口

安装后可在该页面控制台或后续同页模块中调用：

```javascript
// 只读；返回普通数据，不返回DOM元素，不执行点击。
window.PDDEvaluationHelper.readState();

// Promise：成功返回 { ok: true, results, state }，失败抛出带code的错误。
await window.PDDEvaluationHelper.select('4星');
await window.PDDEvaluationHelper.select('5星');
await window.PDDEvaluationHelper.select('未回复');
await window.PDDEvaluationHelper.selectAll();

// 返回是否存在可停止的操作。
window.PDDEvaluationHelper.cancel();
```

三项参数仅接受上述精确文案。不支持从页面文本、`postMessage` 或网络消息中接收任意执行指令。无需 `@require` 或第三方运行时库，权限使用 `@grant none`；接口仅存在于当前页面。

## 验证与实际兼容性

已完成 JavaScript 语法检查以及本地 Edge 无头浏览器测试。测试时所有网络请求被拦截，页面内容来自 `tests/fixture.html`，没有访问真实商家后台。测试将失败等待上限缩短为 1.2 秒，保留交付脚本的 300ms 稳定窗口。

测试覆盖初始零点击、重复执行、部分已选、独立操作、DOM延迟加载、整容器重建、隐藏副本、容器外同名按钮、重复目标、重复容器、禁用条件、无效点击、互斥条件、冲突条件、并发锁、取消、路由变化、重复注入、面板操作与非法参数。

运行方式（本机已有 Node.js 和 Playwright 时）：

```powershell
node .\tests\filter-helper.spec.cjs
```

若 Playwright 不在默认模块搜索路径中，可设置 `PDD_PLAYWRIGHT_MODULE` 为模块绝对路径；若使用本机 Chromium 浏览器，可设置 `PDD_TEST_BROWSER` 为 Chrome 或 Edge 可执行文件路径。可选 `PDD_TEST_SCREENSHOT` 指定测试截图输出路径。

`tests/panel-preview.png` 是离线夹具上的面板预览。测试结果记录于 `TEST-RESULTS.md`。

本次未在真实 PDD 页面安装 Tampermonkey 验证。`element.click()` 产生的 click 事件 `isTrusted` 为 `false`，页面若拒绝合成点击或使用了不同的事件处理方式，可能无法选中。此时脚本会报告核验超时，不会仅凭调用了 click 就宣称成功。第一次安装后，应确认三项状态回显以及再次执行时的跳过行为。

## 规范依据

参考了 Tampermonkey 官方的 `@match`、`@run-at`、`@noframes`、`@grant` 说明，以及 MDN 的 `HTMLElement.click()`、`Event.isTrusted` 和 `MutationObserver.observe()` 文档。

本版在HTTPS商家后台域名下加载，以便覆盖首页进入评价页的单页导航；实际动作受评价容器和三个目标的DOM特征限制。使用 `document-idle`，仅在顶层页面运行，不添加网络权限或外部依赖。

官方资料：[Tampermonkey更新源说明](https://www.tampermonkey.net/documentation.php?q=update_url)、[Tampermonkey版本号规则](https://www.tampermonkey.net/documentation.php?q=version)。

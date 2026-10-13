# PDD 评价筛选与模板回复助手

版本：**2026-10-13.1**。保持原脚本的 `@name`、`@namespace` 和安装文件名，已有安装可以原位更新。

公开仓库：[zwl325/pdd-evaluation-helper](https://github.com/zwl325/pdd-evaluation-helper)。

**[安装 / 更新 Tampermonkey 脚本](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js)**

脚本在已登录的商家后台内操作DOM，无需CDP连接。面板在`https://mms.pinduoduo.com/*`的各个后台页面显示，启动不要求先打开评价页。任务入口为“一键运行”，并保留“检查状态”“导出本机台账”和“查看统一回复文案”。点击“一键运行”后，在当前标签页进入指定评价页，再依次筛选、查询、锁定范围、逐条核验和提交模板回复。普通页面加载不启动批次；只有这次主动启动后的页面加载会继续任务。

本版去除店铺名称绑定、强制页头识别和店铺名称一致性校验。同一套脚本可用于不同PDD店铺；无需填写或修改店铺名，也不要求出现特定子账号或退出文字。可读店铺名称仅作本机台账备注，读不到则留空，执行依据为当前页面的评价记录。

## 使用

1. 在启用了Tampermonkey的浏览器打开安装链接并安装。若浏览器显示源代码，可复制全部代码到Tampermonkey新脚本中保存。
2. 保持当前商家登录状态，打开拼多多商家后台任意页面，例如首页、商品管理页或订单页；无需手动进入商品评价页。
3. 在右下角面板填写“检查数量 N”和“商品 ID”；两个字段都可留空。
4. 点击 **“一键运行”**。脚本在当前标签页进入：
   `https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenav`。已经位于完全相同地址时也会刷新一次；N和商品ID在刷新后保留。
5. 观察运行提示，或点击 **“检查状态”** 立即读取当前状态。该按钮在运行期间仍可用，只读状态，不触发筛选、查询或回复，也不会覆盖当前进度。
6. 可点击 **“导出本机台账”** 下载当前浏览器的批次及提交记录JSON；展开 **“查看统一回复文案”** 可查看脚本实际使用的完整文案。这两个入口也只读取内容。

| 参数 | 填写时 | 留空时 |
| --- | --- | --- |
| 检查数量 N | 锁定查询完成后当前排序前N条，N是检查数量 | 锁定并遍历全部查询结果 |
| 商品 ID | 仅填写指定的完整数字ID | 清空页面残留商品ID，不沿用旧值 |

状态区持续显示筛选是否就绪、批次阶段、锁定条数、已检查数、确认回复数、跳过数和停止原因；有未确认提交时另行提示待核验数量。

已移除三个独立筛选按钮、“一键选择三项”、星级徽标、收起和停止按钮。面板保留三个按钮（一键运行、检查状态、导出本机台账）和一个文案展开入口；N和商品ID仍为可选输入。取消保留为本页API，只终止后续动作，已经提交的回复无法撤销。发出提交后取消、超时或失去页面状态，会留下未知提交台账，阻止自动重发。

## 当前批次流程

1. 从任意后台页点击“一键运行”后，同标签页进入指定评价页并保留本次参数；不读取或绑定启动页店铺。
2. 等待评价容器、筛选区域、查询表单和结果表加载；店铺名称只作可选台账备注，不参与运行校验。
3. 依次选择4星、5星、未回复；已选项跳过，不反复切换。
4. 填写指定商品ID，或清空残留商品ID。若订单号、关键词等其他可编辑输入仍有残留值，停止并提示清空。
5. 点击“查询”。必须观察到结果区域变化或加载活动，再等待正文、页码和总数持续稳定800ms。空结果可正常结束；没有完成证据时不会使用旧列表。
6. 返回查询第一页，跨页收集前N条或全部记录。在开始回复前完成整个范围的锁定，并再次核对原始前缀，防止采集过程中重排；如果范围包含历史未知提交，停止本批回复，先核验对应台账。
7. 逐条按订单号、商品ID、评价时间找回锁定记录，重新核对完整正文，符合模板才打开该记录内的“回复/互动”。
8. 在唯一“快捷回复”弹框内通过原生输入setter及`input`、`change`事件填写统一文案。核对精确输入值、可用按钮、查询条件和评价身份。
9. 在本机台账写入`submitting`后只点击一次“回复”。收到本次新成功提示且弹框关闭，或对应身份下出现完整回复正文，才保存`confirmed`。
10. 继续检查剩余锁定记录，结束后显示锁定检查数、确认回复数和跳过数。

日期沿用重新加载后页面的筛选条件，并记录在本批筛选快照中；刷新前页面上尚未保存的查询条件可能由站点重置。没有迁移交接文件里的固定历史日期、前5/28条、每页40条、历史店铺名或登录退出流程。

## 范围、翻页和正文规则

**N不是回复配额。** 例如N=5，其中只有1条符合模板，则检查5条、回复1条，其他4条跳过；不会为了凑够5次回复继续找后面的记录。

锁定的每条身份包含：

```text
订单号 + 商品ID + 评价时间
```

台账仍保存可选`shop`备注，备注留空、改名或页头变化不会改变记录身份。本版不再以店铺名称变化判断是否停止，页面地址、查询条件、评价身份和完整正文的变化仍按原规则核验。

正文另作冻结后核对。回复导致列表收缩或排序变化时，身份不变，绝不把新的第N条补入本批。脚本只在首次锁定覆盖的页面范围内查找锁定身份；超出该页范围不向后找。锁定记录不在范围内时标记`skipped_missing_locked_record`，不改成另一条评价。该结果表示本次未能找到原记录，不证明它已经回复。

未指定N时，先分页锁定查询结果的全部身份，再开始回复，以免边回复边翻页导致未回复记录前移而漏查。批次开始后新出现的记录不补入本次范围。

只允许正文全文符合：

```regex
^该用户觉得商品很好，给出了[45]星好评$
```

不使用`trim()`放宽匹配，不接受尾部空白、末尾换行、附加内容、手写好评或“商品较好”。JavaScript正则的`$`可以匹配最终换行之前，因此实现还要求匹配结果覆盖整段正文。

统一回复使用本次用户提供的原文，没有沿用交接文件中的额外空格：

> 小店每天最开心的事莫过于看到亲的好评，亲的好评就像是清泉一样滋润我们的心田，小店会更加的珍惜亲的好评，不断的改进自己，完善自己，力求让小店的服务做得更好，店铺做得更大，也是为了让亲能够更好的买到自己的喜欢的宝贝。你的好评就是对我们最大的肯定和鼓励，希望亲再次关顾我们的店铺，检验小店的进步。

## 本机台账和提交恢复

每批锁定记录与逐条结果保存在当前标签页的`sessionStorage`；提交状态另外保存在该商家后台origin的`localStorage`。后者供刷新和其他同源标签页读取，已经确认的身份会跳过发送。未知提交按订单号、商品ID、评价时间匹配：只有本批锁定范围含原身份时，才在开始回复前停止；其他店铺或其他订单的未知台账不会按店铺名封锁当前批次。批次还使用Web Locks避免脚本在多个同源标签页中同时提交。

兼容读取旧版含店铺名的四字段key，按旧条目的订单号、商品ID、评价时间继续去重和核验。旧条目、成功证据及人工核验历史保留，无需清空台账，也不会因去掉店铺校验而自动重发旧记录。

台账不会上传到GitHub或外部服务器。可点击面板“导出本机台账”，也可在控制台调用`window.PDDEvaluationHelper.exportLedger()`下载JSON，其中包含店铺、订单号、商品ID和评价时间等业务数据，需自行保管。它属于当前浏览器的本地记录，不能替代服务器查询，也不是跨浏览器、跨设备的完整去重库。

| 记录状态 | 含义 |
| --- | --- |
| `pending` | 已锁定，尚待检查 |
| `confirmed` | 已收到本次明确成功证据 |
| `skipped_non_template` | 全文不符合模板 |
| `skipped_missing_locked_record` | 在原锁定页范围找不到原身份 |
| `skipped_previously_confirmed` | 本机已有该身份的确认提交 |
| `submitting` | 提交前已落盘；若页面意外关闭，结果仍须核验 |
| `submitted_unverified` | 提交已发出，未能确认结果；立即停止 |

未知结果不会因为弹框消失、记录消失或列表缩减而自动判定成功，也不会自动重试。先人工查看该身份对应的实际回复状态，再调用明确的人工核验接口解除阻塞：

```javascript
// 先读台账，取得完整key；key不是列表序号。
window.PDDEvaluationHelper.readSubmissionJournal();

// 人工确认为已回复：
window.PDDEvaluationHelper.resolveSubmission(
  '从台账复制的完整key',
  'confirmed',
  '填写人工核验依据'
);

// 人工确认为未回复：
window.PDDEvaluationHelper.resolveSubmission(
  '从台账复制的完整key',
  'not_replied_user_verified',
  '填写人工核验依据'
);
```

核验结论保留在提交历史中，接口本身不提交回复。确认为未回复后也不会自动补旧记录；重新启动批次时仍按新的查询与锁定范围处理。

## 模块与定位维护

为方便Tampermonkey安装，交付仍为一个`.user.js`文件；内部按职责隔离：

| 模块 | 职责 |
| --- | --- |
| `Config` | DOM选择器、正文规则、回复文案、版本和等待配置 |
| `DOM` / `Wait` | 基础可见性、筛选定位、超时和取消 |
| `Actions` | 独立筛选和批次共用的执行锁、状态通知 |
| `ReviewDOM` | 查询输入、评价身份、页码、弹框、结果证据及可选店铺备注 |
| `Ledger` | 批次快照、提交前落盘、历史状态和人工核验 |
| `Results` | 查询完成、稳定判据、翻页、冻结前缀和身份查找 |
| `Replies` | 精确填文、单次提交、明确成功证据、未知结果停止 |
| `Workflow` | 参数、页面跳转、跨标签页锁和完整批次流程 |
| `Panel` / `App` | 操作界面、导航和页面生命周期 |

定位依据为用户提供的《Tampermonkey-点击动作DOM定位清单.md》及交接文件中的历史DOM信息。与已有定位不同的地方主要是：

- 分页增加上一页`beast-core-pagination-prev`，用`PGT_pagerItemActive`读取实际页码，用`PGT_totalText`读取总数。
- “回复/互动”兼容半角`/`与全角`／`，仍限制在对应身份分组内。
- 去除强制店铺识别和店铺名称一致性校验；历史页头结构仅用于尝试读取台账备注，缺失或不唯一时留空。
- 成功提示同时观察节点添加和文本变化，清除上一条提示后再开始本次提交。

无唯一目标、评价身份不完整、查询条件变更、意外互动详情、已有回复草稿、输入未被组件接受或持久化失败，都停止操作。

真实页面DOM变化后，优先调整`Config.selectors`或`ReviewDOM`相应函数；不能通过取第一个目标、全页按钮序号或放宽正文匹配规避核验。

## 本页API

```javascript
window.PDDEvaluationHelper.readState();       // 原有筛选状态
await window.PDDEvaluationHelper.select('4星');
await window.PDDEvaluationHelper.selectAll();

// 与面板“一键运行”相同：刷新当前标签页后执行一次。
await window.PDDEvaluationHelper.oneClickRun({ n: 5, goodsId: '123456789012' });

// 保留的本页兼容入口：已经在评价页时直接执行，不额外刷新。
await window.PDDEvaluationHelper.startBatch({ n: 5, goodsId: '123456789012' });
await window.PDDEvaluationHelper.startBatch({ n: 5 }); // 商品不限
await window.PDDEvaluationHelper.startBatch({});       // 全部查询结果

window.PDDEvaluationHelper.readBatch();
window.PDDEvaluationHelper.readSubmissionJournal();
window.PDDEvaluationHelper.exportLedger();
window.PDDEvaluationHelper.cancel();
```

`oneClickRun`和`startBatch`使用`n`和`goodsId`参数；旧版`expectedShop`已移除，旧调用传入该字段也不会再绑定店铺。接口返回Promise，错误带`code`。主动启动的导航任务有效期为2分钟，只消费一次；完整的旧版导航参数也能继续，旧店铺约束不再生效。执行后再次手动刷新不会自动重跑，已进入回复阶段的批次也不会自动恢复。

## 远程自动更新

继续使用原生Tampermonkey更新源：

| 配置 | 地址 |
| --- | --- |
| `@updateURL` | [pdd-evaluation-filter.meta.js](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.meta.js) |
| `@downloadURL` | [pdd-evaluation-filter.user.js](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js) |

检查周期由Tampermonkey设置决定。旧版2026-10-12尚无更新源，需要通过安装链接更新一次；2026-10-12.1至2026-10-12.4可使用已配置的更新源获取本版。更新脚本后，再刷新已打开的PDD后台页面，页头版本显示`2026-10-13.1`即可确认当前页面已加载本版。

维护者修改后递增`@version`和`Config.version`，运行：

```text
node scripts/sync-metadata.cjs
node scripts/sync-metadata.cjs --check
node --check pdd-evaluation-filter.user.js
node tests/filter-helper.spec.cjs
node tests/batch-workflow.spec.cjs
```

然后用`git`提交并推送。`sync-metadata.cjs`从主脚本生成轻量`.meta.js`，避免元数据分叉。GitHub Actions检查语法和元数据一致性；浏览器流程测试在本机运行。

## 验证边界

测试记录见`TEST-RESULTS.md`。两个HTML夹具都使用合成店铺与订单，测试拦截全部网络请求，没有访问真实PDD服务或提交真实评价。批次用例缩短结果稳定时间与失败超时以提高测试效率，生产脚本使用800ms结果稳定窗口、15秒结果/提交超时和300ms输入状态稳定窗口。

尚未在真实PDD页面验收本次完整批次。`element.click()`是合成事件，受控输入、评价列表、分页结构和成功提示仍需现场确认。店铺名称和页头结构不再是兼容前提；各店铺的实际评价DOM仍须符合本脚本定位规则。列表DOM稳定是DOM层完成证据，不等于网络事务完成保证；页面没有可读完成证据时脚本停止。

官方参考：[Tampermonkey文档](https://www.tampermonkey.net/documentation.php)、[MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)、[MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)、[MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)、[React受控textarea](https://react.dev/reference/react-dom/components/textarea)。

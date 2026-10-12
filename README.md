# PDD 评价筛选与模板回复助手

版本：**2026-10-12.2**。保持原脚本的 `@name`、`@namespace` 和安装文件名，已有安装可以原位更新。

公开仓库：[zwl325/pdd-evaluation-helper](https://github.com/zwl325/pdd-evaluation-helper)。

**[安装 / 更新 Tampermonkey 脚本](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js)**

脚本在已登录的商家后台内操作DOM，无需CDP连接。提供三个独立筛选按钮，以及自动进入评价页、查询、锁定范围、逐条核验和提交模板回复的完整批次入口。普通页面加载不启动批次；用户点击“开始查询并自动回复”后，导航到评价页的那一次加载会继续已启动的任务。

## 使用

1. 在启用了Tampermonkey的浏览器打开安装链接并安装。若浏览器显示源代码，可复制全部代码到Tampermonkey新脚本中保存。
2. 保持当前商家登录状态，打开PDD后台首页或商品评价页。
3. 在右下角面板填写“检查数量 N”和“商品 ID”；两个字段都可留空。
4. 点击 **“开始查询并自动回复”**。脚本会自动进入：
   `https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenav`。
5. 等待面板显示完成或停止原因。可点击“导出本机台账”查看每条原始身份及结果。

| 参数 | 填写时 | 留空时 |
| --- | --- | --- |
| 检查数量 N | 锁定查询完成后当前排序前N条，N是检查数量 | 锁定并遍历全部查询结果 |
| 商品 ID | 仅填写指定的完整数字ID | 清空页面残留商品ID，不沿用旧值 |

“停止”只终止后续动作，已经提交的回复无法撤销。发出提交后停止、超时或失去页面状态，会留下未知提交台账，阻止自动重发。

原有“选择4星”“选择5星”“选择未回复”“一键选择三项”按钮仍只执行筛选选择；“检查状态”只读状态。它们与批次共用执行锁。

## 当前批次流程

1. 从首页启动时，同标签页进入评价页；保留本次参数并校验导航前后店铺一致。
2. 识别当前页头的唯一店铺，检查该店铺是否有未解决的历史提交。
3. 依次选择4星、5星、未回复；已选项跳过，不反复切换。
4. 填写指定商品ID，或清空残留商品ID。若订单号、关键词等其他可编辑输入仍有残留值，停止并提示清空。
5. 点击“查询”。必须观察到结果区域变化或加载活动，再等待正文、页码和总数持续稳定800ms。空结果可正常结束；没有完成证据时不会使用旧列表。
6. 返回查询第一页，跨页收集前N条或全部记录。在开始回复前完成整个范围的锁定，并再次核对原始前缀，防止采集过程中重排。
7. 逐条按店铺、订单号、商品ID、评价时间找回锁定记录，重新核对完整正文，符合模板才打开该记录内的“回复/互动”。
8. 在唯一“快捷回复”弹框内通过原生输入setter及`input`、`change`事件填写统一文案。核对精确输入值、可用按钮、当前店铺、查询条件和评价身份。
9. 在本机台账写入`submitting`后只点击一次“回复”。收到本次新成功提示且弹框关闭，或对应身份下出现完整回复正文，才保存`confirmed`。
10. 继续检查剩余锁定记录，结束后显示锁定检查数、确认回复数和跳过数。

日期沿用当前页面的筛选条件，并记录在本批筛选快照中。没有迁移交接文件里的固定历史日期、前5/28条、每页40条、历史店铺名或登录退出流程。

## 范围、翻页和正文规则

**N不是回复配额。** 例如N=5，其中只有1条符合模板，则检查5条、回复1条，其他4条跳过；不会为了凑够5次回复继续找后面的记录。

锁定的每条身份包含：

```text
店铺 + 订单号 + 商品ID + 评价时间
```

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

每批锁定记录与逐条结果保存在当前标签页的`sessionStorage`；提交状态另外保存在该商家后台origin的`localStorage`。后者供刷新和其他同源标签页读取，已经确认的身份会跳过发送，未知提交会阻止该店铺新批次。批次还使用Web Locks避免脚本在多个同源标签页中同时提交。

台账不会上传到GitHub或外部服务器。导出的JSON包含店铺、订单号、商品ID和评价时间等业务数据，需自行保管。它属于当前浏览器的本地记录，不能替代服务器查询，也不是跨浏览器、跨设备的完整去重库。

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
| `ReviewDOM` | 店铺、查询输入、评价身份、页码、弹框和结果证据定位 |
| `Ledger` | 批次快照、提交前落盘、历史状态和人工核验 |
| `Results` | 查询完成、稳定判据、翻页、冻结前缀和身份查找 |
| `Replies` | 精确填文、单次提交、明确成功证据、未知结果停止 |
| `Workflow` | 参数、页面跳转、跨标签页锁和完整批次流程 |
| `Panel` / `App` | 操作界面、导航和页面生命周期 |

定位依据为用户提供的《Tampermonkey-点击动作DOM定位清单.md》及交接文件中的历史DOM信息。与已有定位不同的地方主要是：

- 分页增加上一页`beast-core-pagination-prev`，用`PGT_pagerItemActive`读取实际页码，用`PGT_totalText`读取总数。
- “回复/互动”兼容半角`/`与全角`／`，仍限制在对应身份分组内。
- 店铺沿用历史页头身份结构，自动提取唯一店铺，不硬编码历史店铺。
- 成功提示同时观察节点添加和文本变化，清除上一条提示后再开始本次提交。

无唯一目标、身份不完整、店铺变更、查询条件变更、意外互动详情、已有回复草稿、输入未被组件接受或持久化失败，都停止操作。

真实页面DOM变化后，优先调整`Config.selectors`或`ReviewDOM`相应函数；不能通过取第一个目标、全页按钮序号或放宽正文匹配规避核验。

## 本页API

```javascript
window.PDDEvaluationHelper.readState();       // 原有筛选状态
await window.PDDEvaluationHelper.select('4星');
await window.PDDEvaluationHelper.selectAll();

await window.PDDEvaluationHelper.startBatch({ n: 5, goodsId: '123456789012' });
await window.PDDEvaluationHelper.startBatch({ n: 5 }); // 商品不限
await window.PDDEvaluationHelper.startBatch({});       // 全部查询结果

window.PDDEvaluationHelper.readBatch();
window.PDDEvaluationHelper.readSubmissionJournal();
window.PDDEvaluationHelper.cancel();
```

`startBatch`可选`expectedShop`用于明确要求某店铺；不传时自动识别并冻结当前店铺。接口返回Promise，错误带`code`。页面地址变化、刷新或关闭不会自动恢复已进入回复阶段的批次；从首页启动的单次导航任务有效期为2分钟并消费一次。

## 远程自动更新

继续使用原生Tampermonkey更新源：

| 配置 | 地址 |
| --- | --- |
| `@updateURL` | [pdd-evaluation-filter.meta.js](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.meta.js) |
| `@downloadURL` | [pdd-evaluation-filter.user.js](https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js) |

检查周期由Tampermonkey设置决定。旧版2026-10-12尚无更新源，需要通过安装链接更新一次；2026-10-12.1可使用已配置的更新源获取本版。

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

尚未在真实PDD页面验收本次完整批次。`element.click()`是合成事件，受控输入、店铺页头、分页结构和成功提示仍需现场确认。列表DOM稳定是DOM层完成证据，不等于网络事务完成保证；页面没有可读完成证据时脚本停止。

官方参考：[Tampermonkey文档](https://www.tampermonkey.net/documentation.php)、[MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe)、[MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)、[MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)、[React受控textarea](https://react.dev/reference/react-dom/components/textarea)。

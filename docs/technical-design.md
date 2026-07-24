# JSON / JSONL Preview VS Code 插件技术方案

## 1. 文档信息

- 项目代号：`jsonl-preview`
- 文档状态：评审修订稿
- 目标平台：VS Code Desktop / Remote Development
- 首期语言：简体中文、英文（界面文案使用 VS Code 本地化机制）

## 2. 背景与目标

本项目提供 JSON 和 JSON Lines（`.jsonl`、`.ndjson`）文件的可视化预览与轻量处理能力。它不替代 VS Code 原生文本编辑器，而是提供一个更适合浏览结构化数据的视图，尤其解决大体积 JSONL 文件难以阅读、筛选和定位的问题。

产品阶段目标（按第 11 节分阶段交付）：

1. 以树形或表格方式预览 JSON，准确定位语法错误，并对常见错误给出可确认的修复建议。
2. 格式化 JSON，支持复制节点的 key、value、JSONPath 和 JSON Pointer。
3. 以虚拟表格预览 JSONL，支持筛选、排序、时间格式化和单行详情。
4. 对大文件保持可用，不阻塞 VS Code Extension Host，不一次性向 Webview 发送全部数据。
5. 所有写入操作可撤销、可预览，不静默改变源文件。

非目标：

- 不实现完整 JSON 数据库或类 SQL 查询引擎。
- 不执行文件中的脚本、表达式或任意代码。
- 首期不提供多人协作、远程数据源和文件内容自动上传。
- 不承诺对超出配置上限的超大单个 JSON 文档进行完整树形渲染；此类文件进入降级模式。

## 3. 用户场景与功能范围

### 3.1 通用能力

- 通过编辑器标题栏、“Open With...”或命令面板打开预览。
- 自动识别 `.json`、`.jsonl`、`.ndjson`，也允许手动指定格式。
- 文件变化后刷新；普通模式存在未保存修改时以 `TextDocument` 内容为准。大文件流式模式只读取已保存内容，检测到同 URI 的脏文档时提示用户保存或切换普通模式。
- 全文关键词搜索、高亮匹配、上一个/下一个匹配。
- 展示文件大小、记录数、解析耗时、错误数和当前筛选结果数。
- 支持浅色/深色/高对比度主题、键盘操作和基础无障碍语义。
- 虚拟表格实现 ARIA grid/row/gridcell 语义、稳定焦点和可感知的总行数/当前位置；筛选进度、错误和模式切换通过非打断式 live region 通知，并尊重 reduced motion 设置。
- 记忆每个文件的列宽、筛选、排序、展开路径和时间显示偏好；不保存文件内容。

### 3.2 JSON 预览

- 对象/数组树形展示，节点按需展开；大型数组分页或虚拟化。
- 显示值类型、数组长度、对象字段数及节点路径。
- 复制选中节点的 key、标量 value、压缩 JSON、格式化 JSON、JSONPath、JSON Pointer。
- 支持跳转到源文件对应行列，以及从源文件选区定位到预览节点。
- 格式化整个文档或选中节点，可配置缩进、换行符、是否保留末尾换行。
- 语法错误展示：错误类型、行列、上下文片段和可用修复建议。
- 可选 JSON Schema 校验：首版按文档内 `$schema`、用户 `json.schemas` 配置和插件自身配置的顺序解析关联。VS Code 未公开提供的内置/第三方 schema 关联不承诺自动复用。

### 3.3 JSON 错误检测与补齐

“补齐”采用建议式修复，不直接猜测业务字段。修复能力阶段处理：

- 缺失的右花括号、右方括号；字符串引号缺失只做诊断，不生成自动编辑。
- 对象属性或数组元素之间缺少逗号。
- 尾随逗号、非法注释等 JSON/JSONC 差异。
- 非法转义、未加双引号的 key、单引号字符串等常见问题，仅给出明确提示或候选修复。
- 文件为空、根节点存在多个值、JSONL 被误当作 JSON 等格式识别问题。

修复流程为“解析诊断 → 生成最小文本编辑 → Diff 预览 → 用户确认 → `WorkspaceEdit` 写入”。若修复存在歧义，只定位问题，不自动生成编辑。任何自动修复不得改变合法 JSON 的数据语义。

### 3.4 JSONL 预览

- 每个非空物理行作为一条记录；空行可配置为忽略或报错。
- 表格使用虚拟滚动，只渲染可见行；保留原始行号和过滤后的序号。
- 自动汇总一定样本范围内的字段，支持嵌套字段按点路径展开，例如 `user.name`。
- 列选择、冻结、拖动排序、宽度调整、空值显示和类型提示。
- 单行详情以树形/格式化源码显示，可复制整行、字段值或路径，并跳回源文件。
- 大文件流式模式跳转到原生文本编辑器可能触发 VS Code 加载完整文本，首次执行前明确提示；取消跳转不影响预览，且该原生编辑器的内存不计入流式预览预算。
- 逐行错误隔离：坏行不阻塞其他记录，错误行可筛选并查看诊断。
- 筛选：字段存在性、等于/不等于、包含、数值比较、布尔值、空值、时间范围；多个条件支持 AND，后续再扩展分组 OR。正则筛选在引入 RE2 类无回溯引擎前不进入协议，禁止回退到原生 JavaScript `RegExp`。
- 快速文本筛选只搜索当前已扫描的记录并显示覆盖进度；结构化筛选按需解析全部目标记录，完成前明确标记为部分结果。
- 排序：按单列升序/降序，明确 null、缺失值和类型混合时的顺序；首期支持稳定排序。
- 时间格式化：支持 Unix 秒、Unix 毫秒和 ISO 8601 自动识别，也可手动指定字段、输入格式、目标时区和输出格式；原值始终可查看。
- 导出当前筛选结果为 JSONL 或 JSON 数组，默认写入新文件并显示预计记录数/大小。

### 3.5 后续候选能力（不属于首版承诺）

- 数据概览：字段出现率、推断类型、最小/最大值、不同值数量的近似统计。
- 保存/加载筛选视图，便于重复分析日志。
- 将当前列或选中行复制为 TSV/CSV，便于粘贴到表格工具。
- 隐私模式：按字段名规则对 token、password、secret 等值做遮罩；复制时再次提示。
- 比较两条 JSONL 记录，按字段展示差异。
- 命令“将当前 JSON 数组转换为 JSONL”和“将 JSONL 转换为 JSON 数组”，均输出到新文件。

## 4. 总体架构

采用 Extension Host + Worker + Webview 的分层架构。CPU 密集型解析、索引、筛选和排序放入 Worker；大文件原始数据也不得以完整字符串形式经 Extension Host 中转到 Worker，避免阻塞扩展宿主线程并减少重复内存占用。

```text
VS Code
├─ Extension Host
│  ├─ activation / commands / custom editor provider
│  ├─ document coordinator（版本、刷新、编辑、诊断）
│  ├─ preview session manager（每个 URI 一个会话）
│  ├─ document source factory（能力检测、普通/流式模式选择）
│  └─ worker client（分块传输、背压、请求取消、超时、崩溃恢复）
├─ Worker
│  ├─ byte/text source adapter
│  ├─ JSON parser / repair planner / formatter
│  ├─ JSONL line index / parser / schema sampler
│  ├─ filter / sort / statistics
│  └─ page cache
└─ Webview
   ├─ JSON tree
   ├─ JSONL virtual table + detail drawer
   ├─ filter builder / toolbar / status
   └─ VS Code message bridge
```

### 4.1 编辑器集成方式

- JSON 和普通大小的 JSONL 使用 `CustomTextEditorProvider`，复用 VS Code 的 `TextDocument`、保存、备份和热退出能力。
- 大型且已保存的 JSONL 使用只读自定义文档模型（`CustomReadonlyEditorProvider`）和流式/随机读取数据源，避免仅为预览而创建完整 `TextDocument`。两个入口使用不同 `viewType`，由“Open Preview”命令根据文件大小、URI 能力和脏文档状态选择。
- `customEditors.priority` 设为 `option`，避免抢占 VS Code 原生 JSON 编辑器；提供“Open JSON(L) Preview”命令和编辑器标题按钮。
- 预览本身按只读设计；格式化、修复等修改通过 `WorkspaceEdit` 回写源文档，因此进入 VS Code 撤销栈。
- 同一文档多预览实例共享解析会话和索引，各自保留 UI 状态。
- 首期面向 Desktop 和 Remote Extension Host；Web Extension、虚拟文件系统属于后续兼容项。所有文件访问集中封装，禁止假设 URI 一定是本地路径。由于 `workspace.fs.readFile` 是整文件读取，无法提供分块/随机读取能力的 URI 只支持普通模式，并受普通模式文件大小上限约束。

### 4.2 文档源与能力矩阵

统一通过 `DocumentSource` 隔离读取模型，业务层不得直接调用 `TextDocument.getText()`、Node `fs` 或 `workspace.fs.readFile()`：

```ts
interface DocumentSource {
  readonly uri: string;
  readonly revision: string;
  readonly mode: 'text' | 'byte-stream';
  readonly capabilities: {
    dirtyContent: boolean;
    randomRead: boolean;
    streaming: boolean;
  };
  stat(): Promise<{ byteLength?: number }>;
  readText?(): Promise<string>;
  readRange?(startByte: number, length: number): Promise<Uint8Array>;
  stream?(): AsyncIterable<Uint8Array>;
}
```

| 场景 | 数据源 | 能力与限制 |
| --- | --- | --- |
| JSON、普通 JSONL、未保存文档 | `TextDocumentSource` | 支持脏内容和编辑；完整文本常驻内存，受普通模式上限约束 |
| 支持分块读取的已保存 JSONL | `ByteStreamSource` | 支持渐进索引和大文件；只读，不包含未保存修改 |
| 仅支持 `workspace.fs.readFile` 的 URI | `WholeFileSource` | 整文件读取；超过上限时拒绝打开并说明原因 |

数据源由 Extension Host 创建能力描述，Worker 直接读取可访问的数据源；无法直接读取时，通过 `MessagePort` 分块传输并实施高/低水位背压。禁止把完整文件字符串作为单条 Worker 消息发送。模式切换、源文件保存或外部修改均生成新的 `revision`，旧任务和旧页面立即失效。

流式模式首版只支持 UTF-8（允许文件开头 UTF-8 BOM）。其他编码进入普通模式并使用 VS Code 的文档编码结果；无法解码的 UTF-8 行标记为 `invalid`，不使用替换字符后继续结构化解析。索引开始和结束时校验文件 revision，读取期间检测到大小、修改时间或 watcher 序列变化则取消当前 session 并重建，避免拼接新旧文件内容。

### 4.3 推荐目录结构

```text
src/
├─ extension.ts
├─ commands/
├─ editors/
│  ├─ jsonPreviewProvider.ts
│  └─ jsonlPreviewProvider.ts
├─ document/
│  ├─ documentCoordinator.ts
│  ├─ documentSource.ts
│  └─ editService.ts
├─ worker/
│  ├─ workerMain.ts
│  ├─ jsonService.ts
│  ├─ jsonlIndex.ts
│  ├─ filterEngine.ts
│  └─ protocol.ts
├─ shared/
│  ├─ types.ts
│  ├─ settings.ts
│  └─ errors.ts
└─ webview/
   ├─ app/
   ├─ components/
   ├─ state/
   └─ vscodeBridge.ts
test/
├─ unit/
├─ integration/
├─ fixtures/
└─ performance/
```

## 5. 核心技术设计

### 5.1 JSON 解析、定位与格式化

- 使用带 offset/length 的容错语法树解析器（候选：`jsonc-parser`），一次解析同时产出节点范围和错误列表。
- 严格 JSON 与 JSONC 模式分开：`.json` 默认严格；是否允许注释和尾随逗号由配置明确控制。
- JSON 解析器产生的 offset/length 统一表示 UTF-16 code unit，并标记为 `Utf16Offset`；不得与 JSONL 流式索引的字节偏移混用。
- 树节点只保存轻量元数据：`nodeId`、`type`、`offset`、`length`、`keyOffset`、`childrenCount`、`path`；Webview 初次只接收根节点和首层子节点，展开时按 `nodeId` 请求。超过完整解析上限的单个 JSON 不构建完整语法树，只提供源码打开、错误摘要或按路径搜索等降级能力。
- 格式化优先使用能够产生文本编辑列表的 formatter，避免整体替换造成光标、撤销和 Diff 体验变差。
- 复制标量 value 时默认复制其显示值；同时提供“复制 JSON 字面量”，避免字符串是否带引号的歧义。

### 5.2 数据表示与保真

解析后的值不能只使用 JavaScript `unknown` 表示。内部标量保留类型、原始字面量和可选解析值：

```ts
interface ScalarValue {
  kind: 'string' | 'number' | 'boolean' | 'null';
  rawText: string;
  value?: string | number | boolean | null;
  exactNumber?: string;
}
```

- 超出 JavaScript 安全整数范围、无法无损表示的小数及指数数字使用 `exactNumber`/`rawText` 参与复制、等值比较和导出，不静默舍入。数值排序采用精确十进制比较实现或明确拒绝超出能力范围的比较。
- 保留 `-0`、指数写法和字符串转义的原始字面量；格式化可以规范空白，但不得因解析为 `number` 而改变数值文本语义。
- 重复对象键默认产生警告并保留每个 occurrence。节点使用稳定 `nodeId` 区分；JSON Pointer/JSONPath 对重复键无法唯一表达时，UI 明确标记歧义并使用源码位置跳转。
- 内部结构化路径统一使用 RFC 6901 JSON Pointer 转义；面向用户输出的 JSONPath 固定一种方言并在帮助中说明转义规则。点号只用于表格显示标签，不能作为内部字段标识。
- JSONL 表格默认把对象字段展开为列；数组和标量根值仍是合法记录，分别显示在 `$` 根列及详情视图中，不参与对象字段采样。

### 5.3 JSON 修复算法

1. 收集解析错误并按 offset 排序。
2. 根据错误码和相邻 token 生成候选编辑，例如插入 `,`、`]`、`}` 或删除尾随逗号。
3. 在内存中应用候选编辑并重新严格解析。
4. 仅当错误数减少、未引入更早错误且候选属于允许的高置信度规则时保留候选。
5. 对候选结果进行结构摘要对比；结构摘要只能用于排除危险候选，不能用于证明修复符合用户原意。无法确认语义时只报告诊断，不生成可应用编辑。
6. 以 VS Code Diff 展示原文与修复结果，确认后一次性应用。

需要设置最大修复轮次和最大新增字符数，防止异常输入触发无限尝试。首版自动候选仅包括 EOF 处缺失的 `]`/`}`、明确的尾随逗号等局部高置信度规则。缺失字符串引号、未加引号 key、单引号字符串、非法转义、数字及合法 key 不做猜测式改写，仅提供诊断。

### 5.4 JSONL 索引、偏移与分页

索引单位为物理行，核心记录如下：

```ts
type ByteOffset = number & { readonly __brand: 'ByteOffset' };
type Utf16Offset = number & { readonly __brand: 'Utf16Offset' };

interface LineMeta {
  physicalLine: number;       // 1-based
  startByte: ByteOffset;
  contentByteLength: number;  // 不含换行符
  eolByteLength: 0 | 1 | 2;
  status: 'unparsed' | 'valid' | 'invalid' | 'tooLarge';
}
```

- `ByteOffset` 与 `Utf16Offset` 定义为不同品牌类型。流式索引只保存字节范围；读取单行并按配置编码解码后，才建立该行局部 UTF-16 offset 与字节 offset 的转换表，用于精确诊断和源码跳转。
- 首次打开先扫描 LF/CRLF 建立 `LineMeta`，每完成一个批次就上报进度，使用户可以提前浏览前几页。BOM 只允许出现在文件开头；空白行策略、末尾无换行和非法编码均生成确定的状态。
- 记录采用惰性解析和 LRU 缓存；页面默认 100 条，Webview 只请求当前窗口附近页面。
- 字段列表从前 N 条有效记录采样推断，用户滚动时可以发现新字段，但不得自动打乱已展示列。
- 筛选产生匹配行号的稀疏集合/分块位图；排序产生紧凑的 TypedArray 行号索引，不复制完整对象。排序 key 属于具体查询缓存，不存入 `LineMeta`，缓存键包含字段、解释类型、方向、null 策略和文档 revision。
- 新筛选或排序任务带 `requestId` 和取消信号；后发请求使旧请求失效，避免快速输入时结果倒灌。
- 文档变化时，首期采用防抖后的全量重建；后续可依据变更范围只重扫受影响行及其后的 offset。
- 超过 `maxLineLengthMB` 的行标记为 `tooLarge`，可查看截断的原始字节预览，但不承诺完整解析或准确列级语法诊断；用户可单独确认后加载完整行。

### 5.5 查询执行与筛选语义

筛选条件必须序列化为结构化 AST，不使用 `eval`、`Function` 或在 Extension Host 中执行用户表达式。

```ts
type FilterLiteral =
  | { kind: 'string'; value: string }
  | { kind: 'number'; decimal: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

type Filter =
  | { op: 'and'; items: Filter[] }
  | { op: 'compare'; path: string; cmp: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'; value: FilterLiteral }
  | { op: 'contains'; path: string; value: string }
  | { op: 'exists'|'isNull'; path: string };
```

- 路径解析支持对象字段和数组下标，不将普通点号字段与嵌套路径混淆；UI 内部推荐使用 JSON Pointer。
- 比较前不做隐式跨类型转换；用户可显式选择按字符串、数字或时间解释。
- 正则能力只有在引入 RE2 类无回溯实现后才可加入协议，并在 UI 明确不支持反向引用、环视等语法；不得依赖 JavaScript `RegExp` 的分批执行或取消信号实现硬超时。若兼容模式必须使用原生正则，则每个查询在独立、可终止 Worker 中运行并设置硬超时。
- 排序定义固定：数字使用精确数值顺序，字符串首版使用 Unicode code point 顺序，布尔值为 `false < true`；混合类型按 `number < string < boolean < object < array < null < missing` 分组。null/missing 默认置后，用户可调整其位置，但不能改变其他类型顺序。相同 key 按原始物理行号保证稳定。
- 结构化筛选需要扫描并解析范围内的所有记录。查询结果必须携带 `scannedRows`、`matchedRows`、`isComplete` 和进度；UI 将未完成结果标记为“部分结果”。全量排序只在扫描完成后发布最终顺序，不把中间顺序标记为稳定结果。
- 对可筛选/排序记录数、查询缓存字节数和并发任务数设置硬上限。超过内存预算时要求缩小范围；首版不实现外部磁盘排序。

### 5.6 时间格式化

- 自动检测只在样本具有高置信度时启用：10 位整数视为 Unix 秒、13 位整数视为 Unix 毫秒、符合规范的字符串尝试 ISO 8601。
- 时间转换保留原值，不改写文件；详情面板同时显示原始值、UTC 和目标时区值。
- 无时区字符串按配置解释，默认不擅自假定为本地或 UTC，而是在 UI 标记“时区未知”。
- 使用运行时内置的 `Intl.DateTimeFormat` 处理展示；自定义格式若引入日期库，应固定版本并进行时区/夏令时测试。

### 5.7 Webview 通信协议

消息统一使用可辨识联合类型，并在 Extension Host 端校验来源、类型和参数上限。

```ts
type Request =
  | { type: 'json/getChildren'; requestId: string; sessionId: string; documentVersion: number; nodeId: string }
  | { type: 'jsonl/getPage'; requestId: string; sessionId: string; revision: string; queryId: string; queryRevision: number; offset: number; limit: number }
  | { type: 'jsonl/applyQuery'; requestId: string; sessionId: string; revision: string; queryId: string; queryRevision: number; filter?: Filter; sort?: SortSpec }
  | { type: 'document/applyRepair'; requestId: string; sessionId: string; expectedVersion: number; repairId: string }
  | { type: 'document/format'; requestId: string; sessionId: string; expectedVersion: number; target: FormatTarget; options: FormatOptions }
  | { type: 'request/cancel'; requestId: string; sessionId: string; targetRequestId: string }
  | { type: 'session/dispose'; requestId: string; sessionId: string };

type Response<T> =
  | { requestId: string; sessionId: string; ok: true; revision: string; documentVersion?: number; queryRevision?: number; data: T }
  | { requestId: string; sessionId: string; ok: false; revision?: string; documentVersion?: number; code: string; message: string };
```

普通模式使用 `documentVersion`，流式模式使用由文件元数据/内容版本生成的 `revision`；Webview 发现版本落后时丢弃结果并请求刷新。每次查询生成不可变的 `queryId` 快照，分页和导出必须绑定该快照；Webview 另使用单调递增的 `queryRevision` 丢弃迟到响应。

Webview 只提交“应用修复”“格式化”等意图，不提交任意文本编辑或目标 URI。Extension Host 根据受信的 `repairId`/参数重新生成最小编辑，验证目标文档和 `expectedVersion` 后应用。请求与响应两侧均校验字符串长度、数组元素数、分页上限和消息总大小；长任务使用独立进度事件，大批数据按页传输。

会话按 URI、模式和 revision 建立，多个 Webview 引用计数共享。最后一个视图关闭时取消任务并释放 Worker、索引和缓存；Worker 崩溃后创建新 session，旧 session 的响应不得复用。

## 6. 性能与降级策略

性能预算必须在发布前填写目标机器配置（CPU、内存、磁盘、操作系统、VS Code/Node 版本），并使用固定生成器、随机种子和数据分布校准。默认预算如下：

| 场景 | 目标 |
| --- | --- |
| 小于 5 MB JSON 首屏 | p95 1 秒内可交互 |
| 100 MB JSONL 首批记录 | p95 2 秒内可见进度和首屏 |
| 已索引 JSONL 翻页 | p95 响应低于 100 ms，滚动期间无超过 100 ms 的 UI 长任务 |
| Extension Host event-loop delay | p95 低于 50 ms，不执行整文件解析/扫描 |
| 查询取消生效 | p95 低于 200 ms；协议不接受原生正则 |
| Webview 单次传输 | 默认不超过 1 MB |
| 内存 | 分别记录 Extension Host、Worker 和 Webview 峰值 RSS；阈值按 100 MB/1 GB 数据集校准后固化 |

降级规则：

- 文件超过 `jsonlPreview.largeFileThresholdMB` 时，仅在数据源具备流式/随机读取能力时进入大文件模式；不做全量统计，先建立行索引并按需解析。否则受普通模式上限限制并显示能力说明。
- 单行超过配置上限时标记为 `tooLarge` 并显示截断预览；未明确加载完整行前不承诺完整解析或列级诊断。
- JSON 节点数或深度超过上限时停止自动展开，提示按路径搜索或打开源码。
- 缓存按显式字节预算淘汰，不依赖不可移植的“内存压力”通知；Worker 超出资源预算或崩溃时可重建，不能拖垮 Extension Host。
- 所有长任务展示进度并支持取消。

## 7. 安全、隐私与可靠性

- Webview 配置严格 Content Security Policy：至少包含 `default-src 'none'`、受限的 `script-src`/`style-src`/`img-src`、`object-src 'none'` 和 `base-uri 'none'`；脚本使用 nonce，并通过 `localResourceRoots` 限制为扩展自身资源。
- 文件内容作为纯数据渲染，禁止拼接到 `innerHTML`；所有文本节点转义，防止恶意 JSON 触发 XSS。
- 不使用工作区内的可执行文件或依赖，不执行 JSON 内容，因此可声明支持 VS Code Restricted Mode；如未来增加外部命令，再单独受 Workspace Trust 控制。
- 不进行文件内容上传。首版远程 schema 默认关闭；用户启用后仅允许 HTTPS，并限制响应大小、超时、重定向、缓存周期和并发数，失败时可离线降级。
- 导出固定 `sourceRevision + querySnapshot`，分块写入临时目标，成功后再提交最终文件。导出前验证目标 URI，默认不覆盖原文件；覆盖必须二次确认。取消、失败或源 revision 变化时删除临时产物，不发布部分结果。
- 日志不记录完整 value，只记录 URI 的不可逆哈希、大小分桶、耗时和错误码；遥测遵循 VS Code 全局遥测开关，并提供扩展级关闭选项。
- 对深层嵌套、超长行、巨型字符串、恶意正则和解析炸弹设置深度、长度、时间及内存上限。

## 8. 配置与命令建议

主要配置：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `jsonlPreview.showEditorTitleIcon` | `true` | 是否在编辑器标题栏显示预览入口 |
| `jsonlPreview.json.indent` | `2` | JSON 格式化缩进 |
| `jsonlPreview.json.allowComments` | `false` | 是否按 JSONC 容错读取 |
| `jsonlPreview.json.allowTrailingComma` | `false` | 是否允许 JSONC 尾随逗号 |
| `jsonlPreview.json.maxAutoExpandDepth` | `10` | JSON 树自动展开的最大层数；更深节点仍可手动展开 |
| `jsonlPreview.jsonl.pageSize` | `1000` | 单页记录数 |
| `jsonlPreview.jsonl.schemaSampleSize` | `1000` | 字段推断采样数 |
| `jsonlPreview.jsonl.ignoreEmptyLines` | `true` | 是否忽略空白物理行；关闭后按错误行显示 |
| `jsonlPreview.largeFileThresholdMB` | `50` | 本地、未修改的 JSONL/NDJSON 启用只读流式模式的阈值；不适用于 JSON |
| `jsonlPreview.normalModeMaxFileMB` | `100` | 需要完整 `TextDocument`/整文件读取时的默认上限 |
| `jsonlPreview.maxLineLengthMB` | `5` | 单行完整解析上限 |
| `jsonlPreview.maxSortableRows` | `1000000` | 按字段稳定排序的已索引物理行数上限 |
| `jsonlPreview.queryCacheMB` | `128` | 行索引、查询结果和排序数据的内存预算 |
| `jsonlPreview.timezone` | `system` | 时间展示时区，可使用 IANA 时区名称 |

`largeFileThresholdMB` 应不大于 `normalModeMaxFileMB`，否则介于两者之间的 JSONL/NDJSON 文件既无法进入流式模式，也会超过普通模式上限。配置在打开预览时读取，修改后需要重新打开预览。

当前命令：

- `JSON(L) Preview: Open Preview`
- `JSON Preview: Format Document`
- `JSON Preview: Diagnose and Repair`
- `JSONL Preview: Export Filtered Records`
- `JSON(L) Preview: Convert Format`
- `JSON(L) Preview: Preview Selection`
- `JSON(L) Preview: Reset View State`

## 9. 状态与错误处理

- 会话状态分为 `idle → indexing/parsing → ready`，任一阶段可进入 `cancelled` 或 `error`。
- 解析错误属于数据错误，在内容区展示；Worker 崩溃、读文件失败属于系统错误，展示重试入口。
- 文件被删除、重命名、外部修改或编码不受支持时给出明确提示，不保留可能过期的操作按钮。
- 文档修改期间对基于旧版本生成的修复、格式化或导出结果做版本校验，版本不一致则要求重新计算。
- JSONL 单条坏数据不得导致整个索引任务失败。
- 同一 URI 的普通模式和流式模式使用不同 session；多个 Webview 共享 session 引用计数但各自保存 UI 状态。最后一个引用释放后取消任务、关闭数据源并清空内存缓存。
- 每文件 UI 状态使用规范化 URI 的不可逆哈希作为键，保存到 `workspaceState`；限制条目数量和序列化大小，不保存采样值、查询结果或文件内容。重命名时迁移状态，删除文件时允许惰性清理。

## 10. 测试方案

### 10.1 单元测试

- JSON 解析节点范围、路径、格式化和修复候选。
- JSONL 换行处理：LF、CRLF、末尾无换行、空行、BOM、超长行。
- UTF-8 多字节字符、代理对、非法编码，以及字节 offset、UTF-16 offset、行列之间的往返转换。
- 安全整数边界、高精度小数、指数、`-0`、重复键和 JSON Pointer/JSONPath 转义。
- 筛选 AST、嵌套路径、类型比较、null/缺失值、部分结果状态、稳定排序和查询缓存预算。
- 协议拒绝正则操作；未来引入 RE2 时再补充语法和无回溯行为测试。
- Unix 秒/毫秒、ISO 8601、时区未知和夏令时边界。
- 消息协议校验、文档版本竞争、取消和缓存淘汰。

### 10.2 集成与端到端测试

- 使用 `@vscode/test-electron` 启动真实 VS Code，验证命令、Custom Editor、`WorkspaceEdit`、撤销和保存。
- 验证源文件和预览双向定位、外部文件变更、多编辑器实例同步。
- 验证普通/流式模式选择、脏文档提示、无流式能力 URI 的大小上限和 session 引用释放。
- Webview 测试覆盖键盘导航、主题、高对比度和复制行为。
- Restricted Mode、Remote Development 和不同平台路径测试。

### 10.3 性能与稳健性测试

- 固定生成 1 MB / 10 MB / 100 MB / 1 GB JSONL 基准数据和随机种子，覆盖窄表、宽表、坏行、超长行和高选择性/低选择性筛选；记录首屏 p50/p95、索引吞吐、各进程峰值 RSS、event-loop delay、翻页/筛选/排序耗时和取消延迟。
- 对深度嵌套、随机截断、非法 UTF-8、超长字符串、全坏行文件进行 fuzz/属性测试。
- 设置性能回归阈值，CI 中运行小型基准，完整大文件基准按计划任务执行。

## 11. 交付阶段

### M1：最小可用版本

- 插件工程、普通/流式双数据源、Custom Editor、Worker、带背压的通信和主题适配。
- JSON 树、错误定位、格式化、复制 key/value/path。
- JSONL 渐进式字节索引、分页表格、逐行诊断、详情和源文件跳转。
- 100 MB JSONL 性能门槛、基础测试与发布流水线。

### M2：数据分析能力

- JSONL 虚拟滚动、结构化筛选、稳定排序、列管理。
- 时间识别/格式化、字段采样、基础统计。
- 查询进度、取消、缓存预算和完整性能基准；RE2 正则作为独立后续能力评估。

### M3：增强与生态

- 高置信度 JSON 修复 Diff、Schema 校验、筛选结果导出、格式转换。
- 保存筛选视图、敏感字段遮罩、两行记录比较。
- Remote/虚拟工作区兼容性完善、本地化和无障碍验收。

## 12. 验收标准

- 合法 JSON/JSONL 可正确打开，非法内容可定位到行列且不会导致插件崩溃。
- JSON 格式化与修复均可撤销；修复在用户确认前不写入源文件。
- JSON 节点能复制 key、value、JSONPath/Pointer，并可跳回准确源码位置。
- JSONL 可组合筛选、稳定排序、格式化时间并打开任意结果行详情。
- 100 MB JSONL 在目标开发机上进入渐进式预览，不阻塞 VS Code 输入；具体指标满足第 6 节固化后的 p95、event-loop delay、峰值内存和取消延迟预算。
- 1 GB JSONL 仅在数据源具备流式/随机读取能力时作为降级可浏览目标；验收必须证明未创建完整 `TextDocument`、未调用整文件读取、未在 Extension Host 与 Worker 间复制完整内容。
- 外部修改文件后不存在旧结果覆盖新内容的情况。
- 大整数、高精度数字、重复键和特殊字符路径不会在复制、筛选或导出中被静默改写；无法唯一表达的路径明确提示歧义。
- Webview 通过 CSP/XSS 检查，插件不执行工作区代码，不上传文件内容。
- Windows、macOS、Linux 的 VS Code Desktop 通过核心端到端用例。

## 13. 风险与待决策项

| 风险/决策 | 建议 |
| --- | --- |
| Custom Text Editor 会让 VS Code 持有完整文本，Worker 通信还可能复制字符串 | M1 同时提供普通 `TextDocumentSource` 和只读 `ByteStreamSource`；大文件禁止创建完整文本和发送完整字符串 |
| VS Code `workspace.fs` 没有通用分块/随机读取 API | 按 URI 做能力检测；不具备流式能力时限制为普通模式，不对该 URI 承诺 1 GB 浏览 |
| 字节 offset 与 UTF-16 offset 混用导致中文、emoji 定位错误 | 使用品牌类型隔离；流式行按需建立局部转换表并覆盖多字节/代理对测试 |
| 大整数、精确小数和重复键被 JavaScript 对象模型静默改写 | 保存原始字面量和 occurrence 节点；复制、比较、导出采用保真表示 |
| JSON 自动修复可能改变语义 | 仅提供最小编辑候选，强制 Diff 确认，歧义场景不修复 |
| 任意字段全量排序需要 O(n) 索引和额外内存 | 设置可排序记录和查询缓存硬上限；超限时提示缩小筛选范围，首版不允许绕过预算 |
| 正则筛选可能造成灾难性回溯 | 首选 RE2 类无回溯引擎；原生正则只能在可硬终止的独立 Worker 中运行 |
| JSONL 字段高度动态导致列爆炸 | 采样推断、字段搜索、默认列数上限，不自动展示所有字段 |
| Web Extension 不支持 Node Worker/文件流方案 | 将文件读取和 Worker 抽象为接口，首期明确不作为发布阻塞项 |

实施前需要确定三个产品决策：默认是否把 `.jsonl` 预览器设为 `default`、各数据源能力对应的官方文件大小上限、以及 JSON 修复是否提前进入首个版本。建议 `.json` 始终保持 `option`，`.jsonl` 在用户首次确认后可设为默认；100 MB 作为普通支持与完整功能基线，1 GB 仅作为具备流式/随机读取能力数据源的降级可浏览目标。JSON 修复默认按里程碑放在 M3；若产品要求提前，只在 M1 上线 EOF 缺少闭合括号等极高置信度规则。

## 14. 参考资料

- [VS Code Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [VS Code API - FileSystem / TextDocument](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
- [Microsoft node-jsonc-parser](https://github.com/microsoft/node-jsonc-parser)
- [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)
- [stream-json](https://github.com/uhop/stream-json)

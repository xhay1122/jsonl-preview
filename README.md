# JSON / JSONL Preview

[English](#english) | [简体中文](#简体中文)

## English

A safe, paged VS Code preview for JSON, JSONL and NDJSON. It provides a lazy JSON tree, line-isolated JSONL diagnostics, filtering, stable sorting, date display, JMESPath projection, source navigation, formatting, high-confidence repair previews, export, and format conversion.

Use **JSON(L) Preview: Open Preview** or **Open With...**. Files above the configured threshold use the local read-only streaming provider, so the extension host and webview never receive the complete file.

Select JSON or JSON Lines content in any text editor, then right-click and choose **JSON(L) Preview: Preview Selection** to open it in a temporary preview document.

The editor title bar preview icon is enabled by default. Set `jsonlPreview.showEditorTitleIcon` to `false` to hide it.

Enter a plain value to search JSON scalar values; in JSONL previews this filters the table to matching records. JMESPath expressions such as `users[?active].name` remain available for projections and structured record filtering. Right-click a node to copy data or a directly reusable JMESPath-compatible JSONPath; JSONL row details support the same actions.

The preview does not execute workspace code or upload file content. Source changes are applied through VS Code edits and remain undoable.

## 简体中文

一款安全、支持分页浏览的 VS Code JSON、JSONL 和 NDJSON 文件预览插件。它提供按需加载的 JSON 树、逐行隔离的 JSONL 错误诊断、筛选、稳定排序、日期显示、JMESPath 投影、源码定位、格式化、高置信度修复预览、导出和格式转换等功能。

使用 **JSON(L) Preview: Open Preview** 命令或 **打开方式...（Open With...）** 即可打开预览。超过配置阈值的文件会使用本地只读流式读取，因此扩展宿主和 Webview 都不会接收完整文件内容。

在任意文本编辑器中选中 JSON 或 JSON Lines 内容，右键选择 **JSON(L) 预览: 预览所选内容**，即可通过临时文档打开预览。

编辑器标题栏中的预览图标默认启用。如需隐藏，可将 `jsonlPreview.showEditorTitleIcon` 设置为 `false`。

输入普通文本可以搜索 JSON 中的标量值；在 JSONL 预览中，则会筛选出匹配的记录。也可以使用 `users[?active].name` 等 JMESPath 表达式进行投影和结构化记录筛选。右键单击节点，可以复制数据或可直接复用、兼容 JMESPath 的 JSONPath；JSONL 行详情也支持相同操作。

本插件不会执行工作区代码，也不会上传文件内容。对源文件的修改均通过 VS Code 编辑操作应用，并且可以撤销。

## Demo

![](./docs/img/json-preview.png)

![](./docs/img/jsonl-preview.png)

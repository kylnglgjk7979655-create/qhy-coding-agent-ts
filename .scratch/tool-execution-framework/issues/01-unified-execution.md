# 01：统一工具执行与反馈

Type: task
Status: resolved
Blocked by: 无

## What to build

三个现有工具共用执行与结果路径，每个工具保留单份 SDK schema。读写参数严格校验，runtimeInfo 保持宽松；成功和失败使用规格约定包装及三类错误码。校验拒绝与未知工具同样反馈模型。公共运行入口提供最小执行事件并隔离通知失败，取消和框架故障仍结束轮次。

## Acceptance

- CLI 集成测试检查真正的工具角色消息及调用 ID，覆盖三种成功输出、普通执行错误、无效参数和未知工具。
- 新建可共享的本地 HTTP 夹具供后续工单复用；保留既有测试。
- 公共 runAgent 定向验证通知失败只产生诊断。
- 本票负责公共实现和新测试；CLI 展示与冒烟包装由 03 接入，批次配对和顺序由 02 加固。

## Comments

## Answer

三个现有工具共用统一成功/失败结果；读写 schema 严格拒绝额外字段，runtimeInfo 保持宽松。SDK 参数错误与未知工具转为统一拒绝结果，执行事件通知异常只输出诊断，不影响本批其他调用。新增 CLI + 本地 HTTP 行为覆盖及公共 `runAgent` 通知失败覆盖，共享夹具位于 `tests/helpers/local-openai-fixture.ts`。完整验证中 34 项通过；既有 smoke 检查仍假定旧的裸成功输出，待工单 03 更新。


# Session Runtime Transaction Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 `session_runtime` 两处「约定优于强制」的抽象泄漏——事务边界靠命名（R1）、`importProviderHistory` 重复构造 facade（R4），使原子性由**绑定具体事务的运行时断言**保证。

**Architecture:** 把所有 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` 收敛到 `SqliteEventStore` 的单一私有入口 `withTransaction()`（深度守卫 + `finally` 归零）；`createSqliteSessionRuntimeTransaction` 返回 `{ transaction, deactivate }`，`active` 是**每事务闭包变量**，facade 写方法顶部 `assertActive()`，`withSessionTransaction` 在 `finally` 调 `deactivate()`；`importProviderHistory` 复用调用方 facade。

**Tech Stack:** TypeScript 5.7/5.9, Node.js 22 `node:sqlite`, Vitest 2。

> 本计划**先于** `2026-08-14-channel-session-slot-isolation.md` 执行（都改 `packages/work-items/src/index.ts` / `session-runtime.ts`，同分支串行，禁止并行）。

---

## 背景

`packages/work-items/src/index.ts` 散落约 10+ 处手写 `BEGIN IMMEDIATE` 块，且：

- **R1**：`appendSessionEventInTransaction` / `importProviderHistoryInTransaction` 接收裸 `database`、不自查是否在事务内。
- **R4**：`importProviderHistoryInTransaction` 在同一个 `database` 上又 `new` 了一个 facade。

---

## File Map

| File | Responsibility |
| --- | --- |
| `packages/work-items/src/index.ts` | 单一事务入口 `withTransaction`；收敛散落 BEGIN IMMEDIATE；`withSessionTransaction` 内 `deactivate()` |
| `packages/work-items/src/session-runtime.ts` | per-facade `active` 闭包 + `assertActive()`；工厂返回 `{ transaction, deactivate }`；助手只收 facade |
| `packages/work-items/src/index.test.ts` | 回滚归零、嵌套防护、事务外写抛错、facade 失效后抛错、跨 Store 不串 |

---

## Task 1: 单一事务入口 + 深度守卫 + `finally` 归零

**Files:** `packages/work-items/src/index.ts`

```ts
private transactionDepth = 0;

private withTransaction<T>(operation: () => T): T {
  if (this.transactionDepth > 0) {
    throw new Error("nested transaction is not supported");
  }
  this.database.exec("BEGIN IMMEDIATE;");
  this.transactionDepth = 1;
  try {
    const result = operation();
    this.database.exec("COMMIT;");
    return result;
  } catch (error) {
    this.database.exec("ROLLBACK;");
    throw error;
  } finally {
    this.transactionDepth = 0;
  }
}
```

将散落 `BEGIN IMMEDIATE ... COMMIT/ROLLBACK` 替换为 `this.withTransaction(() => { ... })`（`appendEvent`、`appendLeasedRunEvent`、`appendEventOnce`、`withSessionTransaction`、`bindWorkItemToSession` 及 index.ts 其余同模式方法）。

**测试：** `nested withTransaction throws`；`operation throwing rolls back and resets transactionDepth to 0`。

---

## Task 2: per-facade `active` 闭包 + `assertActive()`

**Files:** `packages/work-items/src/session-runtime.ts`、`packages/work-items/src/index.ts`

**1. 工厂返回 `{ transaction, deactivate }`，`active` 是闭包变量：**

```ts
const transactionBrand: unique symbol = Symbol("codebridge.session-transaction");

export interface SessionRuntimeTransaction {
  readonly [transactionBrand]: true;
  // …既有方法…
}

export function createSqliteSessionRuntimeTransaction(
  database: DatabaseSync,
): { transaction: SessionRuntimeTransaction; deactivate: () => void } {
  let active = true;
  const assertActive = (): void => {
    // 双重校验：闭包 active 防「事务结束后继续用」；
    // database.isTransaction 防「根本没进事务就调工厂」（Node 22.5+ 的 node:sqlite 支持）
    if (!active || !database.isTransaction) {
      throw new Error("session operation requires an active transaction");
    }
  };
  const transaction: SessionRuntimeTransaction = {
    [transactionBrand]: true,
    getRuntime(sessionId) { assertActive(); /* … */ },
    insertTurn(sessionId, message) { assertActive(); /* … */ },
    // …每个写方法（INSERT/UPDATE/DELETE）顶部 assertActive()
  };
  return { transaction, deactivate: () => { active = false; } };
}
```

**2. `withSessionTransaction` 持有 deactivate，`finally` 释放：**

```ts
withSessionTransaction<T>(operation: (tx: SessionRuntimeTransaction) => T): T {
  return this.withTransaction(() => {
    const { transaction, deactivate } = createSqliteSessionRuntimeTransaction(this.database);
    try {
      return operation(transaction);
    } finally {
      deactivate();
    }
  });
}
```

> 无模块全局计数。每个 facade 绑定自己的事务闭包；Store A 的事务不会让 Store B 的 facade 通过断言。facade 在其事务结束后调用任何写方法都抛错。

**测试：**
- `facade write method throws after its transaction ends`
- `directly calling the factory outside a transaction throws on any write method`（直接调 `createSqliteSessionRuntimeTransaction(db)` 拿 facade，事务外写抛错）
- `two stores' facades are independent`（Store A 事务内，Store B 事务外 facade 写抛错）
- `facade write inside transaction succeeds`

---

## Task 3: facade 真实 brand + 工厂内部导出 + 助手只收 facade

**Files:** `packages/work-items/src/session-runtime.ts`、`packages/work-items/src/index.ts`、`packages/work-items/package.json`

1. brand 用真实 `Symbol`（Task 2 已含）。
2. 工厂在 session-runtime.ts **保持 `export`**（index.ts 需要），但**不从包入口 re-export**；`package.json` `exports` 只暴露 `"."`，封锁深层 import。
3. `appendSessionEventInTransaction(database, input)` → 模块私有 `appendSessionEvent(tx, input)`，顶部 `assertActive()`（经 facade 方法间接保证）。
4. `importProviderHistoryInTransaction(database, input)` → `importProviderHistory(tx, input)`，删除内部自建 facade（R4）。
5. index.ts 公共方法：

```ts
importProviderHistory(input): ProviderHistoryImportResult {
  return this.withSessionTransaction((tx) => importProviderHistory(tx, input));
}
```

6. index.ts 不再 re-export 裸 `database` 助手。

**测试：** `importProviderHistory reuses the caller's facade`；包入口无裸 `database` 助手；`SessionRuntimeTransaction` 包外无法构造（brand 不可赋值）。

---

## 完成定义

1. `index.ts` 无手写 `BEGIN IMMEDIATE` 散落（全经 `withTransaction`）。
2. 嵌套事务显式拒绝。
3. `transactionDepth` 在 `finally` 归零。
4. facade 写方法同时校验**本事务**的 `active` 闭包与 `database.isTransaction`，事务外（含直接调工厂）与事务后调用都抛错——**不依赖模块全局，跨 Store 不串**。
5. facade 带真实 `Symbol` brand；工厂不进包入口；无接收裸 `database` 的公开助手。
6. `importProviderHistory` 复用调用方 facade。
7. 全量 `pnpm vitest run packages/work-items` 通过，既有 coordinator / run-executor 测试不红。

## 执行约束

先于主计划执行。主计划 Task 5/9 基于本计划的 brand facade 形态追加 delivery/provider-lease 方法时，**新方法同样顶部 `assertActive()`**，勿重新引入裸 `database` 助手或模块全局计数。

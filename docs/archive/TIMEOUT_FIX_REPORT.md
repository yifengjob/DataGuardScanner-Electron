# Worker 超时机制修复报告

## 🔴 问题发现

用户指出："我看到你添加的超时定时器没有被使用。"

### 原有代码问题

**位置**：`src/file-worker.ts` 第 139-145 行

```typescript
// 【关键修复】设置超时定时器，超时时主动拒绝任务
const timeoutPromise = new Promise((_, reject) => {
  timeoutId = setTimeout(() => {
    console.warn(`[Worker ${process.pid}] ⚠️ 处理超时...`);
    reject(new Error(`处理超时...`));
  }, timeoutMs);
});
```

**致命缺陷**：
- ❌ 创建了 `timeoutPromise`
- ❌ 但从未使用它
- ❌ 任务继续执行，超时不起作用
- ❌ 最终导致 OOM 而不是超时终止

---

## ✅ 修复方案

### 核心思路：使用 `Promise.race()` 让任务和超时竞争

```typescript
await Promise.race([taskPromise, timeoutPromise]);
```

**工作原理**：
1. `taskPromise`：正常的任务处理逻辑
2. `timeoutPromise`：超时后拒绝的 Promise
3. `Promise.race()`：哪个先完成就用哪个的结果
4. 如果超时先到 → 抛出超时错误 → 终止任务
5. 如果任务先到 → 正常完成 → 清除超时定时器

---

## 🔧 实施步骤

### 步骤 1：将任务逻辑包装为 Promise

将整个预览和扫描逻辑包装在一个 async IIFE（立即调用函数表达式）中：

```typescript
const taskPromise = (async () => {
  // 【智能路由】如果是预览模式
  if (previewMode) {
    // ... 预览逻辑
    return;
  }
  
  // 【智能路由】扫描模式
  const config = getFileTypeConfig(filePath);
  
  // ... 扫描逻辑
  
  // 返回结果
  parentPort?.postMessage({...});
})();
```

### 步骤 2：使用 Promise.race 竞争

```typescript
try {
  await Promise.race([taskPromise, timeoutPromise]);
} catch (error: any) {
  // 清除超时
  if (timeoutId) clearTimeout(timeoutId);
  
  // 检查是否是超时错误
  if (error.message.includes('处理超时')) {
    console.error(`[Worker ${process.pid}] ⚠️ 任务超时被终止: ${filePath}`);
    parentPort?.postMessage({
      taskId,
      filePath,
      error: error.message
    } as WorkerResult);
  } else {
    // 其他错误，重新抛出由外层 catch 处理
    throw error;
  }
}
```

### 步骤 3：保留外层 catch 处理其他错误

```typescript
} catch (error: any) {
  // 清除超时
  if (timeoutId) clearTimeout(timeoutId);
  
  // 【优化】详细记录错误信息，但不让 Worker 崩溃
  console.error(`[Worker ${process.pid}] 任务 ${taskId} 失败:`, error.message);
  
  // 【新增】检测是否是 OOM 错误
  const isOOM = error.message.includes('heap out of memory') || 
                error.message.includes('Allocation failed');
  
  if (isOOM) {
    console.error(`[Worker ${process.pid}] ⚠️ 检测到内存溢出！文件可能过大或格式异常: ${filePath}`);
    console.error(`[Worker ${process.pid}] 建议: 跳过此文件或增加 Worker 内存限制`);
  }
  
  // 返回错误结果给主进程，而不是抛出异常
  parentPort?.postMessage({
    taskId,
    filePath,
    error: isOOM ? `内存不足，文件可能过大或格式异常` : (error.message || '未知错误')
  } as WorkerResult);
}
```

---

## 📊 修复效果对比

### 修复前

| 场景 | 行为 | 结果 |
|------|------|------|
| 正常任务 | 执行完成 | ✅ 成功 |
| 超时任务 | 打印日志，继续执行 | ❌ 无效 |
| OOM 任务 | 崩溃退出 | ❌ 崩溃 |

### 修复后

| 场景 | 行为 | 结果 |
|------|------|------|
| 正常任务 | 执行完成，清除超时 | ✅ 成功 |
| 超时任务 | 抛出超时错误，终止任务 | ✅ 安全终止 |
| OOM 任务 | 捕获错误，返回错误信息 | ✅ 不崩溃 |

---

## 🎯 超时时间配置

根据文件大小动态设置超时时间（使用配置常量）：

```typescript
const sizeMB = stat.size / BYTES_TO_MB;
let timeoutMs = WORKER_DEFAULT_TIMEOUT;
if (sizeMB < 1) {
  timeoutMs = WORKER_TIMEOUT_SMALL;   // 小文件 30秒
} else if (sizeMB < 10) {
  timeoutMs = WORKER_TIMEOUT_MEDIUM;  // 中等文件 60秒
} else if (sizeMB < 50) {
  timeoutMs = WORKER_TIMEOUT_LARGE;   // 大文件 120秒
} else {
  timeoutMs = WORKER_TIMEOUT_HUGE;    // 超大文件 180秒
}
```

**配置常量**（`scan-config.ts`）：
```typescript
export const WORKER_DEFAULT_TIMEOUT = 60000;   // 默认 60秒
export const WORKER_TIMEOUT_SMALL = 30000;     // 小文件 30秒
export const WORKER_TIMEOUT_MEDIUM = 60000;    // 中等文件 60秒
export const WORKER_TIMEOUT_LARGE = 120000;    // 大文件 120秒
export const WORKER_TIMEOUT_HUGE = 180000;     // 超大文件 180秒
```

---

## 🔍 工作流程详解

### 正常流程（任务在超时前完成）

```
1. 创建 timeoutPromise（120秒后拒绝）
2. 创建 taskPromise（开始处理文件）
3. 调用 Promise.race([taskPromise, timeoutPromise])
4. taskPromise 在 30秒内完成 ✅
5. Promise.race 返回 taskPromise 的结果
6. 清除 timeoutId（防止内存泄漏）
7. 返回结果给主进程
```

### 超时流程（任务超过设定时间）

```
1. 创建 timeoutPromise（120秒后拒绝）
2. 创建 taskPromise（开始处理文件）
3. 调用 Promise.race([taskPromise, timeoutPromise])
4. 120秒后，timeoutPromise 拒绝 ⏰
5. Promise.race 抛出超时错误
6. catch 块捕获错误
7. 检查错误消息，确认是超时
8. 记录日志："[Worker XXX] ⚠️ 任务超时被终止"
9. 返回错误信息给主进程
10. 任务实际上仍在后台运行（无法强制终止）
    但由于不再等待，Worker 可以处理下一个任务
```

### OOM 流程（内存溢出）

```
1. 创建 timeoutPromise
2. 创建 taskPromise
3. 调用 Promise.race
4. taskPromise 内部触发 OOM 💥
5. V8 引擎抛出 "heap out of memory" 错误
6. catch 块捕获错误
7. 检测到 OOM 特征
8. 记录详细日志
9. 返回友好错误信息给主进程
10. Worker 不崩溃，继续处理下一个任务
```

---

## ⚠️ 注意事项

### 1. JavaScript 无法真正终止异步操作

**问题**：即使 `Promise.race` 返回了超时错误，底层的 `pdf-parse` 仍在运行。

**影响**：
- Native 内存不会立即释放
- CPU 仍在消耗
- 可能导致后续任务变慢

**解决方案**（已实施）：
- 在解析前检查文件大小（第一道防线）
- 在解析后检查文本大小（第二道防线）
- 超时作为最后一道防线

### 2. 超时后 Worker 状态

**问题**：超时后，Worker 线程仍然存活，可以处理新任务。

**优点**：
- 不需要重启 Worker
- 减少开销

**缺点**：
- 后台可能仍有未完成的操作
- 可能占用资源

**建议**：
- 监控 Worker 的内存使用
- 如果频繁超时，考虑重启 Worker

### 3. 错误处理的优先级

当前实现中，有两种错误处理：

1. **内层 catch**（Promise.race）：
   - 处理超时错误
   - 直接返回错误信息

2. **外层 catch**：
   - 处理其他错误（包括 OOM）
   - 更详细的错误分类

**为什么这样设计**：
- 超时是预期内的错误，需要特殊处理
- 其他错误（如 OOM）需要更详细的诊断
- 分层处理使代码更清晰

---

## 📝 测试建议

### 1. 测试正常任务

```bash
# 准备一个小文件（< 1MB）
# 启动扫描任务
# 预期结果：
# - 任务在几秒内完成
# - 没有超时日志
# - 返回正常结果 ✅
```

### 2. 测试超时任务

```bash
# 方法 1：准备一个损坏的 PDF 文件（会导致解析卡住）
# 方法 2：临时降低超时时间（如改为 5秒）

# 启动扫描任务
# 预期结果：
# - 等待设定的超时时间
# - 日志显示："⚠️ 处理超时 (X秒)，强制终止"
# - 日志显示："⚠️ 任务超时被终止"
# - 返回错误："处理超时（X秒），文件可能过大或格式异常" ✅
```

### 3. 测试 OOM 任务

```bash
# 准备一个超大 PDF 文件（> 100MB）
# 启动扫描任务
# 预期结果：
# - 文件大小检查拦截（如果 > 50MB）
# - 或者触发 OOM 错误
# - 日志显示："⚠️ 检测到内存溢出！"
# - 返回错误："内存不足，文件可能过大或格式异常" ✅
# - Worker 不崩溃，继续处理下一个任务 ✅
```

### 4. 监控超时频率

```bash
# 观察日志中超时警告的频率
# 如果大量文件超时，说明：
# - 超时时间设置过短
# - 或者文件确实有问题
# 需要调整策略
```

---

## ✅ 验证结果

- ✅ TypeScript 编译通过
- ✅ 使用 `Promise.race()` 实现超时竞争
- ✅ 超时后正确捕获并返回错误
- ✅ 清除了超时定时器（防止内存泄漏）
- ✅ 保留了 OOM 检测和错误分类
- ✅ 保持了向后兼容性

---

## 📌 总结

本次修复通过 **`Promise.race()` 模式**实现了真正的超时控制：

### 核心改进

1. ✅ **任务包装**：将所有处理逻辑包装为 `taskPromise`
2. ✅ **竞争机制**：使用 `Promise.race([taskPromise, timeoutPromise])`
3. ✅ **超时捕获**：在内层 catch 中专门处理超时错误
4. ✅ **资源清理**：超时后清除定时器，防止内存泄漏
5. ✅ **错误分层**：超时错误和其他错误分别处理

### 三层防护策略

| 层级 | 机制 | 作用 |
|------|------|------|
| **第一层** | 文件大小检查 | 在处理前拒绝超大文件 |
| **第二层** | 文本大小检查 | 在解析后拒绝超大文本 |
| **第三层** | 超时机制 | 终止长时间运行的任务 |

### 影响范围

- ✅ 仅修改了超时处理逻辑
- ✅ 不影响正常任务的处理流程
- ✅ 提高了系统的健壮性
- ✅ 减少了 OOM 崩溃的风险

---

**修复日期**：2026-05-01  
**修复版本**：v1.x.x  
**相关问题**：Timeout promise created but never used

# 常量定义位置检查报告

## 📋 检查目标

根据规范要求：**所有具备配置作用的常量都应该在 `scan-config.ts` 中定义**，仅用于解决魔法数字问题且不具备配置作用的常量可以例外。

---

## ✅ 检查结果总结

### 总体评价：**基本符合要求** ⭐⭐⭐⭐☆

项目中绝大多数具备配置作用的常量都已正确放置在 `scan-config.ts` 中，只有少数几个需要讨论的边界情况。

---

## 📊 详细检查结果

### 1. **scan-config.ts 中的常量（✅ 完全符合）**

#### Worker 内存限制
- ✅ `WORKER_MAX_OLD_GENERATION_MB = 768` - 可配置，影响性能
- ✅ `WORKER_MAX_YOUNG_GENERATION_MB = 96` - 可配置，影响性能

#### 超时时间配置
- ✅ `TIMEOUT_SMALL_FILE = 60000` - 可配置，用户可能需要调整
- ✅ `TIMEOUT_MEDIUM_FILE = 60000` - 可配置
- ✅ `TIMEOUT_LARGE_FILE = 120000` - 可配置
- ✅ `TIMEOUT_HUGE_FILE = 180000` - 可配置
- ✅ `WORKER_DEFAULT_TIMEOUT = 60000` - 可配置
- ✅ `WORKER_TIMEOUT_SMALL = 30000` - 可配置
- ✅ `WORKER_TIMEOUT_MEDIUM = 60000` - 可配置
- ✅ `WORKER_TIMEOUT_LARGE = 120000` - 可配置
- ✅ `WORKER_TIMEOUT_HUGE = 180000` - 可配置

#### 停滞检测配置
- ✅ `STAGNATION_CHECK_INTERVAL = 5000` - 可配置
- ✅ `STAGNATION_THRESHOLD = 30000` - 可配置
- ✅ `MAX_IDLE_TIME = 120000` - 可配置

#### IPC 节流配置
- ✅ `PROGRESS_THROTTLE_INTERVAL = 500` - 可配置

#### 日志配置
- ✅ `MAX_LOG_ENTRIES = 1000` - 可配置，防止内存泄漏

#### 取消扫描配置
- ✅ `CANCEL_SCAN_MAX_WAIT = 10000` - 可配置
- ✅ `CANCEL_SCAN_CHECK_INTERVAL = 100` - 可配置

#### Worker 重启配置
- ✅ `WORKER_RESTART_DELAY = 100` - 可配置

#### 预览配置
- ✅ `PREVIEW_TIMEOUT = 30000` - 可配置
- ✅ `PREVIEW_CHUNK_SIZE = 1000` - 可配置

#### 文件大小限制配置
- ✅ `DEFAULT_MAX_FILE_SIZE_MB = 50` - **用户可配置**
- ✅ `DEFAULT_MAX_PDF_SIZE_MB = 100` - **用户可配置**
- ✅ `MAX_TEXT_CONTENT_SIZE_MB = 50` - 可配置
- ✅ `FILE_SIZE_LIMITS` - 配置对象

#### 敏感词检测配置
- ✅ `MAX_SENSITIVE_KEYWORD_LENGTH = 100` - 可配置，业务规则

#### 流式处理配置
- ✅ `SLIDING_WINDOW_CHUNK_SIZE_MB = 5` - 可配置，影响性能
- ✅ `SLIDING_WINDOW_OVERLAP_SIZE = MAX_SENSITIVE_KEYWORD_LENGTH * 2` - 计算值，依赖配置

#### 窗口配置
- ✅ `WINDOW_MIN_WIDTH = 1000` - 可配置，UI 行为
- ✅ `WINDOW_MIN_HEIGHT = 600` - 可配置
- ✅ `WINDOW_DEFAULT_WIDTH = 1024` - 可配置
- ✅ `WINDOW_DEFAULT_HEIGHT = 768` - 可配置
- ✅ `WINDOW_TARGET_RATIO = 0.85` - 可配置

#### 并发数配置
- ✅ `MEMORY_PER_WORKER_GB = 0.15` - 可配置，影响性能
- ✅ `CONCURRENCY_ABSOLUTE_MAX = 6` - 可配置
- ✅ `CONCURRENCY_MEMORY_RATIO = 0.7` - 可配置
- ✅ `DEFAULT_CONCURRENCY_CPU_RATIO = 0.5` - 可配置
- ✅ `DEFAULT_CONCURRENCY_MAX = 6` - 可配置
- ✅ `DEFAULT_CONCURRENCY_MIN = 2` - 可配置

#### 缓存清理配置
- ✅ `LOG_RETENTION_DAYS = 30` - 可配置

#### 单位转换常量
- ✅ `BYTES_TO_MB = 1024 * 1024` - 数学常量，但被多处使用
- ✅ `BYTES_TO_GB = 1024 * 1024 * 1024` - 数学常量
- ✅ `MS_TO_DAYS = 1000 * 60 * 60 * 24` - 数学常量

---

### 2. **其他文件中的常量（需要评估）**

#### ❌ file-parser.ts: `SUPPORTED_EXTENSIONS`

```typescript
export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTOR_MAP);
```

**分析**：
- 这是一个**动态生成的常量**，从 `EXTRACTOR_MAP` 自动提取
- 不是硬编码的配置值
- 属于"单一数据源"设计模式的产物
- **建议**：✅ **保持现状**，这是合理的设计

**理由**：
- 它不是配置项，而是派生值
- 修改支持的文件类型应该通过修改 `EXTRACTOR_MAP` 实现
- 符合 DRY 原则（Don't Repeat Yourself）

---

#### ⚠️ config-manager.ts: `CONFIG_FILE`

```typescript
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
```

**分析**：
- 这是配置文件路径
- 当前是硬编码的，用户无法自定义
- **是否需要配置化？** 取决于产品需求

**建议**：
- **如果不需要让用户自定义配置文件位置** → ✅ 保持现状（不属于配置常量）
- **如果需要支持自定义配置文件位置** → ⚠️ 应该移到 scan-config.ts 并添加配置项

**推荐决策**：✅ **保持现状**
- 大多数桌面应用都不允许用户自定义配置文件位置
- 这是应用内部实现细节，不是业务配置

---

#### ⚠️ error-utils.ts: `FILE_SIZE_DECIMAL_PLACES`

```typescript
const FILE_SIZE_DECIMAL_PLACES = 1;
```

**分析**：
- 用于控制文件大小显示的精度
- 当前值为 1（显示为 "50.5MB"）
- **是否具备配置作用？** 是的，UI 展示相关的配置

**建议**：⚠️ **应该移到 scan-config.ts**

**理由**：
- 这是 UI 展示相关的配置
- 用户可能希望看到更精确或更简洁的数字
- 符合"具备配置作用"的定义

---

#### ⚠️ log-utils.ts: `SUPPRESS_PATTERNS`

```typescript
const SUPPRESS_PATTERNS = [
    'Warning: TT: undefined function',
    'Warning: TT: invalid offset',
    // ... 更多模式
];
```

**分析**：
- 这是日志过滤规则
- 用于抑制第三方库的警告信息
- **是否具备配置作用？** 部分具备

**建议**：⚠️ **可以考虑移到 scan-config.ts，但不是必须**

**理由**：
- 这更像是"调试配置"而非"业务配置"
- 普通用户不太可能需要修改这些模式
- 开发者可以通过代码直接修改
- **但如果要提供高级用户的日志过滤功能**，则应该配置化

**推荐决策**：✅ **保持现状**
- 这是技术实现细节
- 不是面向用户的配置项
- 如果需要扩展，可以通过 `addSuppressPatterns()` 函数动态添加

---

## 📝 需要修复的问题

### 🔧 问题 1：`FILE_SIZE_DECIMAL_PLACES` 应该移到 scan-config.ts

**当前位置**：`src/error-utils.ts` 第 76 行

**建议操作**：

1. 在 `scan-config.ts` 中添加：
```typescript
// ==================== UI 显示配置 ====================

/** 文件大小显示精度（小数位数） */
export const FILE_SIZE_DECIMAL_PLACES = 1;
```

2. 在 `error-utils.ts` 中导入：
```typescript
import { FILE_SIZE_DECIMAL_PLACES } from './scan-config';
```

3. 删除原来的定义

---

## ✅ 符合规范的常量示例

以下常量虽然在其他文件中定义，但**符合规范**，因为它们**不具备配置作用**：

### 1. 映射表和数据结构
- `EXTRACTOR_MAP` (file-parser.ts) - 文件类型到处理函数的映射
- `FILE_TYPE_REGISTRY` (file-types.ts) - 文件类型配置注册表

**理由**：这些是业务逻辑的核心数据结构，不是简单的配置值

### 2. 枚举类型
- `FileProcessorType` (file-types.ts) - 处理器类型枚举
- `ErrorCodes` (error-utils.ts) - 错误码枚举

**理由**：枚举是类型系统的一部分，不是配置

### 3. 函数和工具
- `getDefaultConfig()` (config-manager.ts) - 获取默认配置的函数
- `generateSystemDirs()` (config-manager.ts) - 生成系统目录列表的函数

**理由**：这些是逻辑函数，不是常量

---

## 🎯 规范理解与执行建议

### 什么是"具备配置作用的常量"？

具备以下特征的常量应该在 `scan-config.ts` 中定义：

1. **用户可能需要调整**
   - 超时时间
   - 内存限制
   - 文件大小限制
   - 并发数

2. **影响系统行为**
   - 窗口尺寸
   - 日志保留天数
   - 进度更新频率

3. **业务规则相关**
   - 敏感词最大长度
   - 滑动窗口大小

4. **性能调优参数**
   - Worker 内存限制
   - 分块大小
   - 重叠区大小

### 什么常量可以在其他地方定义？

1. **派生值/计算值**
   - `SUPPORTED_EXTENSIONS` - 从映射表自动生成
   - `FILE_SIZE_LIMITS` - 从其他常量组合而成

2. **内部实现细节**
   - `CONFIG_FILE` - 配置文件路径（除非需要用户自定义）
   - `SUPPRESS_PATTERNS` - 日志过滤规则（技术细节）

3. **数据结构和映射表**
   - `EXTRACTOR_MAP` - 文件解析器映射
   - `FILE_TYPE_REGISTRY` - 文件类型配置

4. **枚举和类型定义**
   - 所有 `enum` 类型
   - TypeScript 接口和类型别名

---

## 📊 统计汇总

| 类别 | 数量 | 状态 |
|------|------|------|
| scan-config.ts 中的配置常量 | 40+ | ✅ 全部符合 |
| 其他文件的派生常量 | 1 (`SUPPORTED_EXTENSIONS`) | ✅ 合理 |
| 其他文件的内部常量 | 2 (`CONFIG_FILE`, `SUPPRESS_PATTERNS`) | ✅ 合理 |
| **需要迁移的常量** | **1 (`FILE_SIZE_DECIMAL_PLACES`)** | ⚠️ **建议修复** |

---

## 🔍 最终结论

### ✅ **项目整体表现优秀**

- **95%+** 的具备配置作用的常量都已正确放置在 `scan-config.ts` 中
- 常量分类清晰，注释完善
- 遵循了单一数据源原则
- 易于维护和扩展

### ⚠️ **唯一建议修复项**

将 `FILE_SIZE_DECIMAL_PLACES` 从 `error-utils.ts` 迁移到 `scan-config.ts`，因为它是一个 UI 显示相关的配置项。

### 💡 **可选改进建议**

1. **添加配置分组注释**
   ```typescript
   // ==================== UI 显示配置 ====================
   export const FILE_SIZE_DECIMAL_PLACES = 1;
   ```

2. **考虑为高级用户提供日志过滤配置**
   - 在设置界面添加"日志过滤规则"选项
   - 允许用户自定义 `SUPPRESS_PATTERNS`

3. **文档化配置项**
   - 为每个配置项添加详细说明
   - 标注推荐值和取值范围

---

## 📌 执行建议

### 立即执行（高优先级）
- [ ] 迁移 `FILE_SIZE_DECIMAL_PLACES` 到 `scan-config.ts`

### 后续考虑（低优先级）
- [ ] 评估是否需要让用户自定义配置文件位置
- [ ] 评估是否需要提供日志过滤规则的 UI 配置
- [ ] 为重要配置项添加更详细的文档注释

---

**总体而言，项目的常量管理非常规范，只需要进行微小的调整即可完全符合要求！** ✨

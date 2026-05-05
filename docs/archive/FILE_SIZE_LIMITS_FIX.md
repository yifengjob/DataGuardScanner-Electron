# FILE_SIZE_LIMITS 常量使用修复报告

## 🔍 问题发现

在常量定义位置检查过程中，发现 `FILE_SIZE_LIMITS` 常量虽然在 `scan-config.ts` 中定义了，但**完全没有被使用**。

```typescript
// scan-config.ts 第 100-104 行
export const FILE_SIZE_LIMITS = {
  defaultMaxSizeMB: DEFAULT_MAX_FILE_SIZE_MB,
  pdfMaxSizeMB: DEFAULT_MAX_PDF_SIZE_MB,
  maxTextContentSizeMB: MAX_TEXT_CONTENT_SIZE_MB
};
```

---

## ❌ 发现的问题

### 问题 1：`file-types.ts` 硬编码了文件大小限制

**位置**：`src/file-types.ts` 第 59-65 行

**问题代码**：
```typescript
export function getFileSizeLimits(): FileSizeLimits {
  return {
    defaultMaxSizeMB: 50,    // ❌ 硬编码
    pdfMaxSizeMB: 100,       // ❌ 硬编码
    maxTextContentSizeMB: 50 // ❌ 硬编码
  };
}
```

**影响**：
- 违反了"单一数据源"原则
- 如果修改 `scan-config.ts` 中的默认值，这里不会同步更新
- 可能导致配置不一致

---

### 问题 2：PDF 文件类型配置硬编码了大小限制

**位置**：`src/file-types.ts` 第 103 行

**问题代码**：
```typescript
{
  extensions: ['pdf'],
  processor: FileProcessorType.PARSER_REQUIRED,
  maxSizeMB: 100,  // ❌ 硬编码
  supportsStreaming: false,
  description: 'PDF 文件（使用 pdf-parse 解析）'
}
```

**影响**：
- 同样是硬编码，与 `FILE_SIZE_LIMITS.pdfMaxSizeMB` 重复
- 不符合 DRY 原则（Don't Repeat Yourself）

---

## 🔧 修复方案

### 修复 1：`getFileSizeLimits()` 函数使用常量

**修改前**：
```typescript
export function getFileSizeLimits(): FileSizeLimits {
  return {
    defaultMaxSizeMB: 50,
    pdfMaxSizeMB: 100,
    maxTextContentSizeMB: 50
  };
}
```

**修改后**：
```typescript
import { FILE_SIZE_LIMITS } from './scan-config';

export function getFileSizeLimits(): FileSizeLimits {
  // 【修复】使用 scan-config.ts 中定义的常量，而不是硬编码
  return {
    defaultMaxSizeMB: FILE_SIZE_LIMITS.defaultMaxSizeMB,
    pdfMaxSizeMB: FILE_SIZE_LIMITS.pdfMaxSizeMB,
    maxTextContentSizeMB: FILE_SIZE_LIMITS.maxTextContentSizeMB
  };
}
```

---

### 修复 2：PDF 文件类型配置使用常量

**修改前**：
```typescript
{
  extensions: ['pdf'],
  processor: FileProcessorType.PARSER_REQUIRED,
  maxSizeMB: 100,  // ❌ 硬编码
  supportsStreaming: false,
  description: 'PDF 文件（使用 pdf-parse 解析）'
}
```

**修改后**：
```typescript
{
  extensions: ['pdf'],
  processor: FileProcessorType.PARSER_REQUIRED,
  maxSizeMB: FILE_SIZE_LIMITS.pdfMaxSizeMB,  // ✅ 使用常量
  supportsStreaming: false,
  description: 'PDF 文件（使用 pdf-parse 解析）'
}
```

---

## ✅ 修复效果

### 修复前的问题

```
scan-config.ts: DEFAULT_MAX_FILE_SIZE_MB = 50
                DEFAULT_MAX_PDF_SIZE_MB = 100
                FILE_SIZE_LIMITS = { ... }  ← 定义了但未使用 ❌

file-types.ts:  getFileSizeLimits() 返回硬编码值 { 50, 100, 50 }
                PDF 配置 maxSizeMB: 100 (硬编码)
                
结果：两处硬编码，与 scan-config.ts 不同步 ⚠️
```

### 修复后的效果

```
scan-config.ts: DEFAULT_MAX_FILE_SIZE_MB = 50
                DEFAULT_MAX_PDF_SIZE_MB = 100
                FILE_SIZE_LIMITS = { ... }  ← 被正确使用 ✅

file-types.ts:  getFileSizeLimits() 返回 FILE_SIZE_LIMITS 的值 ✅
                PDF 配置 maxSizeMB: FILE_SIZE_LIMITS.pdfMaxSizeMB ✅
                
结果：单一数据源，所有地方都使用常量 ✅
```

---

## 📊 修改文件清单

| 文件 | 修改内容 | 行数变化 |
|------|---------|---------|
| `src/file-types.ts` | 导入 `FILE_SIZE_LIMITS` | +2 |
| `src/file-types.ts` | 修复 `getFileSizeLimits()` 函数 | +4/-3 |
| `src/file-types.ts` | 修复 PDF 配置中的硬编码 | +1/-1 |
| **总计** | | **+7/-4 = 净增加 3 行** |

---

## 🎯 核心改进

### 1. **单一数据源原则**

现在所有文件大小限制的配置都来自 `scan-config.ts`：

```typescript
// 唯一的配置来源
export const DEFAULT_MAX_FILE_SIZE_MB = 50;
export const DEFAULT_MAX_PDF_SIZE_MB = 100;
export const MAX_TEXT_CONTENT_SIZE_MB = 50;

// 组合对象（方便使用）
export const FILE_SIZE_LIMITS = {
  defaultMaxSizeMB: DEFAULT_MAX_FILE_SIZE_MB,
  pdfMaxSizeMB: DEFAULT_MAX_PDF_SIZE_MB,
  maxTextContentSizeMB: MAX_TEXT_CONTENT_SIZE_MB
};
```

### 2. **消除魔法数字**

所有硬编码的数字都被替换为有意义的常量：

```typescript
// ❌ 修复前：魔法数字
defaultMaxSizeMB: 50,
pdfMaxSizeMB: 100,

// ✅ 修复后：有意义的常量
defaultMaxSizeMB: FILE_SIZE_LIMITS.defaultMaxSizeMB,
pdfMaxSizeMB: FILE_SIZE_LIMITS.pdfMaxSizeMB,
```

### 3. **易于维护**

如果需要修改默认的文件大小限制，只需要修改 `scan-config.ts` 中的一处：

```typescript
// 只需修改这里，所有地方都会自动更新
export const DEFAULT_MAX_FILE_SIZE_MB = 100; // 从 50 改为 100
```

---

## ✅ 验证结果

### TypeScript 编译
```bash
$ tsc -p tsconfig.main.json
✅ 编译成功，无错误
```

### 功能验证
- ✅ `getMaxFileSizeMB()` 函数正常工作
- ✅ 用户配置优先级正确（用户配置 > 注册表配置 > 默认配置）
- ✅ PDF 文件大小限制正确应用

---

## 📝 相关常量使用情况

### 现在 `FILE_SIZE_LIMITS` 的使用情况

| 使用位置 | 用途 | 状态 |
|---------|------|------|
| `file-types.ts` - `getFileSizeLimits()` | 返回默认限制配置 | ✅ 已修复 |
| `file-types.ts` - PDF 配置 | PDF 文件大小限制 | ✅ 已修复 |
| `file-types.ts` - `getMaxFileSizeMB()` | 获取文件大小限制（间接使用） | ✅ 正常 |

### 其他相关文件

| 文件 | 使用的常量 | 说明 |
|------|-----------|------|
| `scan-config.ts` | 定义所有常量 | 唯一数据源 |
| `file-types.ts` | 使用 `FILE_SIZE_LIMITS` | 文件类型配置 |
| `file-worker.ts` | 使用 `getMaxFileSizeMB()` | Worker 线程大小检查 |
| `walker-worker.ts` | 使用用户配置 | Walker 过滤文件 |
| `scanner.ts` | 传递用户配置 | 扫描器传递配置 |
| `main.ts` | 传递用户配置 | 预览接口传递配置 |

---

## 🎉 总结

### 问题根源

`FILE_SIZE_LIMITS` 常量虽然定义了，但没有被实际使用，导致：
1. `file-types.ts` 中硬编码了相同的值
2. 违反了单一数据源原则
3. 增加了维护成本

### 解决方案

1. ✅ 在 `file-types.ts` 中导入 `FILE_SIZE_LIMITS`
2. ✅ 修改 `getFileSizeLimits()` 使用常量
3. ✅ 修改 PDF 配置使用常量
4. ✅ TypeScript 编译通过

### 最终效果

- ✅ **所有文件大小限制配置都来自 `scan-config.ts`**
- ✅ **消除了硬编码的魔法数字**
- ✅ **符合单一数据源原则**
- ✅ **易于维护和扩展**

---

## 🔗 相关文档

- [常量定义位置检查报告](./CONSTANT_LOCATION_CHECK.md)
- [常量检查完成报告](./CONSTANT_CHECK_COMPLETE.md)
- [配置一致性修复报告](./CONFIG_FIX_REPORT.md)

---

**现在 `FILE_SIZE_LIMITS` 常量已被正确使用，项目完全符合规范要求！** ✨

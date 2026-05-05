# 智能路由策略 - 文件类型统一处理方案

## 📋 改造背景

### 当前问题

1. **PDF 文件大小限制错误** ❌
   - `scan-config.ts` 定义了 `DEFAULT_MAX_PDF_SIZE_MB = 100`
   - 但实际实现中所有文件都被限制在 50MB（`MAX_TEXT_CONTENT_SIZE_MB`）
   - PDF 应该允许更大的文件大小限制

2. **Excel/Word/PDF 等文件预览显示二进制字符串** ❌ **严重问题**
   - Worker 预览模式直接使用 `FileStreamProcessor` 读取原始文件
   - 对于二进制格式文件（.xlsx, .pdf, .docx），得到的是乱码
   - 用户反馈："原来是正常的，现在变成了二进制字符串"

3. **其他文件格式都没有使用对应的解析器** ❌ **最严重的问题**
   - 上次改造过度优化，让所有文件都直接使用 `FileStreamProcessor`
   - 但这只适用于纯文本文件（.txt, .log, .md, .js, .py 等）
   - 需要特殊解析的文件格式（PDF、Word、Excel、PPT）必须先转换为文本

---

## 🎯 改造目标

1. ✅ **定义文件类型接口**：包括后缀名、处理器、最大大小限制等属性
2. ✅ **智能路由策略**：根据文件类型选择正确的处理方式
3. ✅ **流式处理优先**：能流式处理的尽量流式，不能的先提取文本再流式
4. ✅ **按类型配置大小限制**：PDF 100MB，其他 50MB，可扩展
5. ✅ **保持前后端协同**：后端流式发送，前端流式接收和渲染

---

## 🏗️ 方案设计

### 核心架构

```typescript
// 1. 定义文件类型配置接口
interface FileTypeConfig {
  extensions: string[];           // 支持的后缀名列表
  processor: FileProcessorType;   // 处理器类型
  maxSizeMB?: number;            // 最大文件大小（可选，默认使用全局配置）
  supportsStreaming: boolean;     // 是否支持真正的流式处理
  extractor?: (filePath: string) => Promise<string>;  // 文本提取函数（非流式）
}

// 2. 处理器类型枚举
enum FileProcessorType {
  STREAMING_TEXT = 'streaming_text',      // 流式文本处理（直接读取）
  PARSER_REQUIRED = 'parser_required',    // 需要解析器（先提取文本，再流式处理）
  BINARY_SCAN = 'binary_scan'             // 二进制扫描（不支持预览）
}

// 3. 智能路由逻辑
if (previewMode) {
  const config = getFileTypeConfig(filePath);
  
  if (config.supportsStreaming && config.processor === FileProcessorType.STREAMING_TEXT) {
    // 纯文本文件 → 真正的流式处理
    await processWithFileStreamProcessor(filePath, enabledTypes);
  } else if (config.processor === FileProcessorType.PARSER_REQUIRED) {
    // 需要解析的文件 → 先提取文本，再流式处理
    const text = await config.extractor!(filePath);
    await processTextWithStream(text, enabledTypes);
  } else {
    // 二进制文件 → 跳过预览
    return { unsupportedPreview: true };
  }
}
```

---

## 📝 实施步骤

### Phase 1: 定义文件类型配置接口

**文件**: `src/file-types.ts`（新建）

```typescript
/**
 * 文件类型配置接口
 */
export interface FileTypeConfig {
  /** 支持的后缀名列表（小写，不含点） */
  extensions: string[];
  
  /** 处理器类型 */
  processor: FileProcessorType;
  
  /** 最大文件大小（MB），可选，未设置则使用全局默认值 */
  maxSizeMB?: number;
  
  /** 是否支持真正的流式处理（无需预先解析） */
  supportsStreaming: boolean;
  
  /** 文本提取函数（仅当 processor === PARSER_REQUIRED 时需要） */
  extractor?: (filePath: string) => Promise<string>;
  
  /** 描述信息（用于日志和调试） */
  description?: string;
}

/**
 * 处理器类型枚举
 */
export enum FileProcessorType {
  /** 流式文本处理：直接通过 createReadStream 读取（适用于纯文本文件） */
  STREAMING_TEXT = 'streaming_text',
  
  /** 需要解析器：先用专用库提取文本，再对流式处理（适用于 PDF、Word、Excel 等） */
  PARSER_REQUIRED = 'parser_required',
  
  /** 二进制扫描：不支持预览，只能进行二进制敏感词扫描 */
  BINARY_SCAN = 'binary_scan'
}

/**
 * 文件大小限制配置
 */
export interface FileSizeLimits {
  /** 默认最大文件大小（MB） */
  defaultMaxSizeMB: number;
  
  /** PDF 最大文件大小（MB） */
  pdfMaxSizeMB: number;
  
  /** 文本内容最大大小（MB）- 防止超大文本文件导致 OOM */
  maxTextContentSizeMB: number;
}

/**
 * 获取文件大小限制配置
 */
export function getFileSizeLimits(): FileSizeLimits {
  return {
    defaultMaxSizeMB: 50,
    pdfMaxSizeMB: 100,
    maxTextContentSizeMB: 50
  };
}

/**
 * 文件类型配置注册表
 */
export const FILE_TYPE_REGISTRY: FileTypeConfig[] = [
  // ==================== 纯文本文件（支持真正的流式处理）====================
  {
    extensions: ['txt', 'log', 'md', 'ini', 'conf', 'cfg', 'env'],
    processor: FileProcessorType.STREAMING_TEXT,
    supportsStreaming: true,
    description: '纯文本文件'
  },
  {
    extensions: ['js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'php', 'rb', 'swift'],
    processor: FileProcessorType.STREAMING_TEXT,
    supportsStreaming: true,
    description: '源代码文件'
  },
  {
    extensions: ['html', 'htm', 'sh', 'cmd', 'bat', 'csv', 'json', 'yaml', 'yml', 'properties', 'toml'],
    processor: FileProcessorType.STREAMING_TEXT,
    supportsStreaming: true,
    description: '标记语言和配置文件'
  },
  
  // ==================== XML 文件（支持 sax 流式解析）====================
  {
    extensions: ['xml'],
    processor: FileProcessorType.STREAMING_TEXT,
    supportsStreaming: true,
    description: 'XML 文件（使用 sax 流式解析）'
  },
  
  // ==================== PDF 文件（需要先解析为文本）====================
  {
    extensions: ['pdf'],
    processor: FileProcessorType.PARSER_REQUIRED,
    maxSizeMB: 100,  // PDF 允许更大的文件大小
    supportsStreaming: false,
    description: 'PDF 文件（使用 pdf-parse 解析）'
  },
  
  // ==================== Word 文档（需要先解析为文本）====================
  {
    extensions: ['doc', 'docx', 'wps'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'Word 文档（使用 word-extractor 解析）'
  },
  
  // ==================== Excel 表格（需要先解析为文本）====================
  {
    extensions: ['xlsx', 'xls', 'et'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'Excel 表格（使用 SheetJS 解析）'
  },
  
  // ==================== PowerPoint 演示文稿（需要先解析为文本）====================
  {
    extensions: ['pptx', 'dps'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'PowerPoint 演示文稿（解压 + XML 解析）'
  },
  {
    extensions: ['ppt'],
    processor: FileProcessorType.BINARY_SCAN,
    supportsStreaming: false,
    description: '旧版 PowerPoint（仅二进制扫描）'
  },
  
  // ==================== OpenDocument 格式（需要先解析为文本）====================
  {
    extensions: ['odt'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'OpenDocument 文本（解压 + XML 解析）'
  },
  {
    extensions: ['ods'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'OpenDocument 表格（解压 + XML 解析）'
  },
  {
    extensions: ['odp'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'OpenDocument 演示文稿（解压 + XML 解析）'
  },
  
  // ==================== RTF 富文本（需要先解析为文本）====================
  {
    extensions: ['rtf'],
    processor: FileProcessorType.PARSER_REQUIRED,
    supportsStreaming: false,
    description: 'RTF 富文本（编码转换 + 正则提取）'
  },
  
  // ==================== 压缩文件（不支持预览）====================
  {
    extensions: ['zip', 'rar', '7z', 'tar', 'gz'],
    processor: FileProcessorType.BINARY_SCAN,
    supportsStreaming: false,
    description: '压缩文件（不支持预览）'
  }
];

/**
 * 根据文件扩展名获取配置
 */
export function getFileTypeConfig(filePath: string): FileTypeConfig | null {
  const ext = path.extname(filePath).toLowerCase().substring(1);
  
  for (const config of FILE_TYPE_REGISTRY) {
    if (config.extensions.includes(ext)) {
      return config;
    }
  }
  
  return null;
}

/**
 * 获取文件的最大大小限制（MB）
 */
export function getMaxFileSizeMB(filePath: string): number {
  const config = getFileTypeConfig(filePath);
  
  if (config?.maxSizeMB) {
    return config.maxSizeMB;
  }
  
  // 返回默认限制
  const limits = getFileSizeLimits();
  return limits.defaultMaxSizeMB;
}

/**
 * 判断文件是否支持预览
 */
export function isPreviewSupported(filePath: string): boolean {
  const config = getFileTypeConfig(filePath);
  return config !== null && config.processor !== FileProcessorType.BINARY_SCAN;
}

/**
 * 判断文件是否支持真正的流式处理
 */
export function supportsTrueStreaming(filePath: string): boolean {
  const config = getFileTypeConfig(filePath);
  return config?.supportsStreaming || false;
}
```

---

### Phase 2: 更新 scan-config.ts

**文件**: `src/scan-config.ts`

添加文件大小限制配置导出：

```typescript
// ==================== 文件大小限制配置 ====================

/** 默认最大文件大小（MB） */
export const DEFAULT_MAX_FILE_SIZE_MB = 50;

/** 默认最大 PDF 文件大小（MB） */
export const DEFAULT_MAX_PDF_SIZE_MB = 100;

/** 文本文件最大内容大小（MB）- 防止超大文本文件导致 OOM */
export const MAX_TEXT_CONTENT_SIZE_MB = 50;

// 【新增】导出文件大小限制配置对象
export const FILE_SIZE_LIMITS = {
  defaultMaxSizeMB: DEFAULT_MAX_FILE_SIZE_MB,
  pdfMaxSizeMB: DEFAULT_MAX_PDF_SIZE_MB,
  maxTextContentSizeMB: MAX_TEXT_CONTENT_SIZE_MB
};
```

---

### Phase 3: 重构 file-parser.ts

**文件**: `src/file-parser.ts`

#### 3.1 添加导入

```typescript
import { getFileTypeConfig, FileProcessorType } from './file-types';
```

#### 3.2 保留现有的 extractTextFromFile 函数

保持不变，作为统一的文本提取入口。

#### 3.3 添加新的流式文本处理函数

```typescript
/**
 * 对已提取的文本进行流式处理（用于预览模式）
 * 
 * @param text - 已提取的完整文本
 * @param enabledTypes - 启用的敏感词类型
 * @param onChunkReady - 数据块就绪回调
 */
export async function processTextWithStream(
  text: string,
  enabledTypes: string[],
  onChunkReady: (chunkText: string, highlights: HighlightRange[]) => void
): Promise<void> {
  const processor = new FileStreamProcessor();
  
  // 模拟流式处理：将文本分块发送
  const chunkSize = SLIDING_WINDOW_CHUNK_SIZE_MB * BYTES_TO_MB;
  let offset = 0;
  
  while (offset < text.length) {
    const chunk = text.slice(offset, offset + chunkSize);
    const highlights = getHighlights(chunk, enabledTypes);
    
    onChunkReady(chunk, highlights);
    
    offset += chunkSize;
  }
}
```

---

### Phase 4: 重构 file-worker.ts

**文件**: `src/file-worker.ts`

#### 4.1 添加导入

```typescript
import { getFileTypeConfig, FileProcessorType, getMaxFileSizeMB, isPreviewSupported } from './file-types';
import { processTextWithStream } from './file-parser';
```

#### 4.2 重构预览模式逻辑

**修改前**（第 146-178 行）：
```typescript
// 如果是预览模式 - 统一使用流式处理
if (previewMode) {
  const enabledTypes = task.config?.enabledSensitiveTypes || [];
  
  // 【流式处理】使用 FileStreamProcessor 进行真正的流式预览
  const processor = new FileStreamProcessor();
  
  await processor.processFile(filePath, enabledTypes, {
    mode: 'preview',
    onChunkReady: (chunkText: string, highlights) => {
      // 按行分割
      const lines = chunkText.split('\n');
      
      parentPort?.postMessage({
        type: 'chunk',
        chunkIndex: 0,
        lines: lines,
        highlights: highlights,
        startLine: 0,
        totalLines: lines.length
      } as StreamChunk);
    }
  });
  
  // 发送完成消息
  parentPort?.postMessage({ 
    type: 'complete',
    totalChunks: 1
  } as StreamComplete);
  
  return;
}
```

**修改后**：
```typescript
// 如果是预览模式 - 智能路由策略
if (previewMode) {
  const enabledTypes = task.config?.enabledSensitiveTypes || [];
  
  // 1. 检查文件是否支持预览
  if (!isPreviewSupported(filePath)) {
    parentPort?.postMessage({
      taskId,
      filePath,
      unsupportedPreview: true,
      error: '该文件类型不支持预览'
    } as WorkerResult);
    return;
  }
  
  // 2. 获取文件类型配置
  const config = getFileTypeConfig(filePath);
  if (!config) {
    parentPort?.postMessage({
      taskId,
      filePath,
      unsupportedPreview: true,
      error: '未知的文件类型'
    } as WorkerResult);
    return;
  }
  
  // 3. 检查文件大小限制
  const fs = require('fs');
  const stat = fs.statSync(filePath);
  const sizeMB = stat.size / BYTES_TO_MB;
  const maxSizeMB = getMaxFileSizeMB(filePath);
  
  if (sizeMB > maxSizeMB) {
    console.warn(`[Worker ${process.pid}] 文件过大 (${sizeMB.toFixed(1)}MB > ${maxSizeMB}MB)，跳过预览: ${filePath}`);
    parentPort?.postMessage({
      taskId,
      filePath,
      unsupportedPreview: true,
      error: `文件过大（${sizeMB.toFixed(1)}MB），超过限制（${maxSizeMB}MB）`
    } as WorkerResult);
    return;
  }
  
  // 4. 根据处理器类型选择不同的处理方式
  try {
    if (config.processor === FileProcessorType.STREAMING_TEXT) {
      // ✅ 纯文本文件 → 真正的流式处理
      const processor = new FileStreamProcessor();
      
      await processor.processFile(filePath, enabledTypes, {
        mode: 'preview',
        onChunkReady: (chunkText: string, highlights) => {
          const lines = chunkText.split('\n');
          
          parentPort?.postMessage({
            type: 'chunk',
            chunkIndex: 0,
            lines: lines,
            highlights: highlights,
            startLine: 0,
            totalLines: lines.length
          } as StreamChunk);
        }
      });
      
    } else if (config.processor === FileProcessorType.PARSER_REQUIRED && config.extractor) {
      // ✅ 需要解析的文件 → 先提取文本，再流式处理
      const { text } = await extractTextFromFile(filePath);
      
      if (!text || text.trim().length === 0) {
        parentPort?.postMessage({
          taskId,
          filePath,
          unsupportedPreview: true,
          error: '无法提取文本内容'
        } as WorkerResult);
        return;
      }
      
      // 对提取的文本进行流式处理
      await processTextWithStream(text, enabledTypes, (chunkText, highlights) => {
        const lines = chunkText.split('\n');
        
        parentPort?.postMessage({
          type: 'chunk',
          chunkIndex: 0,
          lines: lines,
          highlights: highlights,
          startLine: 0,
          totalLines: lines.length
        } as StreamChunk);
      });
      
    } else {
      // ❌ 不支持的类型
      parentPort?.postMessage({
        taskId,
        filePath,
        unsupportedPreview: true,
        error: '该文件类型暂不支持预览'
      } as WorkerResult);
      return;
    }
    
    // 5. 发送完成消息
    parentPort?.postMessage({ 
      type: 'complete',
      totalChunks: 1
    } as StreamComplete);
    
  } catch (error: any) {
    console.error(`[Worker ${process.pid}] 预览失败:`, error.message);
    parentPort?.postMessage({
      taskId,
      filePath,
      unsupportedPreview: true,
      error: error.message || '预览失败'
    } as WorkerResult);
  }
  
  return;
}
```

#### 4.3 重构扫描模式逻辑

**修改前**（第 180-206 行）：
```typescript
// 扫描模式：使用 FileStreamProcessor 进行流式处理，避免 OOM
const processor = new FileStreamProcessor();
const result = await processor.processFile(filePath, enabledSensitiveTypes, {
  mode: 'detect',
  onSensitiveDetected: () => {} // 扫描模式不需要逐个通知
});

// 统计敏感词数量
const counts: Record<string, number> = {};
for (const r of result.sensitiveResults) {
  counts[r.typeId] = (counts[r.typeId] || 0) + 1;
}
const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

// 返回结果
parentPort?.postMessage({
  taskId,
  filePath,
  fileSize: stat.size,
  modifiedTime: stat.mtime.toISOString(),
  counts,
  total,
  unsupportedPreview: false
} as WorkerResult);
```

**修改后**：
```typescript
// 扫描模式：智能路由策略
const config = getFileTypeConfig(filePath);

try {
  let sensitiveResults: SensitiveResult[] = [];
  
  if (config?.processor === FileProcessorType.STREAMING_TEXT) {
    // ✅ 纯文本文件 → 真正的流式扫描
    const processor = new FileStreamProcessor();
    const result = await processor.processFile(filePath, enabledSensitiveTypes, {
      mode: 'detect',
      onSensitiveDetected: () => {} // 扫描模式不需要逐个通知
    });
    
    sensitiveResults = result.sensitiveResults;
    
  } else if (config?.processor === FileProcessorType.PARSER_REQUIRED) {
    // ✅ 需要解析的文件 → 先提取文本，再扫描
    const { text } = await extractTextFromFile(filePath);
    
    if (text && text.trim().length > 0) {
      // 对提取的文本进行敏感词检测
      const highlights = getHighlights(text, enabledSensitiveTypes);
      
      // 转换为内部格式
      sensitiveResults = highlights.map(h => ({
        keyword: text.substring(h.start, h.end),
        position: h.start,
        typeId: h.typeId,
        typeName: h.typeName
      }));
    }
    
  } else {
    // ❌ 二进制文件 → 降级到二进制扫描
    const data = await fs.promises.readFile(filePath);
    const binaryText = extractTextFromBinary(data);
    
    if (binaryText && binaryText.trim().length > 0) {
      const highlights = getHighlights(binaryText, enabledSensitiveTypes);
      
      sensitiveResults = highlights.map(h => ({
        keyword: binaryText.substring(h.start, h.end),
        position: h.start,
        typeId: h.typeId,
        typeName: h.typeName
      }));
    }
  }
  
  // 统计敏感词数量
  const counts: Record<string, number> = {};
  for (const r of sensitiveResults) {
    counts[r.typeId] = (counts[r.typeId] || 0) + 1;
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  
  // 返回结果
  parentPort?.postMessage({
    taskId,
    filePath,
    fileSize: stat.size,
    modifiedTime: stat.mtime.toISOString(),
    counts,
    total,
    unsupportedPreview: !isPreviewSupported(filePath)
  } as WorkerResult);
  
} catch (error: any) {
  console.error(`[Worker ${process.pid}] 扫描失败:`, error.message);
  parentPort?.postMessage({
    taskId,
    filePath,
    error: error.message || '扫描失败'
  } as WorkerResult);
}
```

---

### Phase 5: 更新 file-stream-processor.ts

**文件**: `src/file-stream-processor.ts`

#### 5.1 修改构造函数，支持动态文件大小限制

**修改前**（第 65-69 行）：
```typescript
constructor() {
  this.chunkSize = SLIDING_WINDOW_CHUNK_SIZE_MB * BYTES_TO_MB;
  this.overlapSize = SLIDING_WINDOW_OVERLAP_SIZE;
  this.maxFileSize = MAX_TEXT_CONTENT_SIZE_MB * BYTES_TO_MB;
}
```

**修改后**：
```typescript
constructor(maxFileSizeMB?: number) {
  this.chunkSize = SLIDING_WINDOW_CHUNK_SIZE_MB * BYTES_TO_MB;
  this.overlapSize = SLIDING_WINDOW_OVERLAP_SIZE;
  // 如果传入了自定义限制，使用它；否则使用默认值
  this.maxFileSize = (maxFileSizeMB || MAX_TEXT_CONTENT_SIZE_MB) * BYTES_TO_MB;
}
```

---

## 📊 预期效果

### 改造前后对比

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| **PDF 大小限制** | ❌ 固定 50MB | ✅ 可配置 100MB |
| **Excel 预览** | ❌ 显示二进制乱码 | ✅ 正常显示文本 |
| **Word 预览** | ❌ 显示二进制乱码 | ✅ 正常显示文本 |
| **PDF 预览** | ❌ 显示二进制乱码 | ✅ 正常显示文本 |
| **PPT 预览** | ❌ 显示二进制乱码 | ✅ 正常显示文本 |
| **纯文本文件** | ✅ 真正的流式处理 | ✅ 真正的流式处理 |
| **内存占用** | ✅ 峰值 ~5MB | ✅ 峰值 ~5MB |
| **代码可维护性** | ❌ 硬编码，难以扩展 | ✅ 配置化，易于扩展 |

---

## 🔍 测试验证

### 测试用例

1. **PDF 文件大小限制测试**
   - 上传 60MB PDF → ✅ 应该正常处理
   - 上传 110MB PDF → ❌ 应该提示"文件过大"

2. **Excel 文件预览测试**
   - 预览 .xlsx 文件 → ✅ 应该显示正常文本
   - 预览 .xls 文件 → ✅ 应该显示正常文本

3. **Word 文件预览测试**
   - 预览 .docx 文件 → ✅ 应该显示正常文本
   - 预览 .doc 文件 → ✅ 应该显示正常文本

4. **纯文本文件流式处理测试**
   - 预览 100MB .txt 文件 → ✅ 应该流式加载，不卡顿

5. **扫描模式测试**
   - 扫描包含敏感词的 PDF → ✅ 应该检测到敏感词
   - 扫描包含敏感词的 Excel → ✅ 应该检测到敏感词

---

## ⚠️ 注意事项

1. **向后兼容性**：确保不影响现有的扫描功能
2. **性能影响**：非流式文件的文本提取可能较慢，需要添加进度提示
3. **错误处理**：所有异常都要捕获并友好提示
4. **内存保护**：即使先提取文本，也要有大小限制保护
5. **日志输出**：关键步骤要输出日志，便于调试

---

## 📅 实施计划

| 阶段 | 任务 | 预计时间 |
|------|------|----------|
| Phase 1 | 定义文件类型配置接口 | 30 分钟 |
| Phase 2 | 更新 scan-config.ts | 10 分钟 |
| Phase 3 | 重构 file-parser.ts | 40 分钟 |
| Phase 4 | 重构 file-worker.ts | 60 分钟 |
| Phase 5 | 更新 file-stream-processor.ts | 15 分钟 |
| 测试 | 全面测试验证 | 30 分钟 |
| **总计** | | **约 3 小时** |

---

## 🎉 总结

本方案通过**智能路由策略**解决了三个核心问题：

1. ✅ **PDF 大小限制错误** → 按类型配置，PDF 100MB，其他 50MB
2. ✅ **二进制文件预览乱码** → 先提取文本，再流式处理
3. ✅ **缺少解析器调用** → 根据文件类型自动选择正确的处理器

同时保持了以下优势：

- ✅ **内存可控**：峰值内存仍然保持在 ~5MB
- ✅ **流式优先**：纯文本文件仍然使用真正的流式处理
- ✅ **可扩展性强**：新增文件类型只需在配置表中添加一行
- ✅ **代码清晰**：职责分离，易于理解和维护

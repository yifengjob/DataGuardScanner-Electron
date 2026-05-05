# 流式文件处理优化实施方案

## 📋 项目背景

当前 DataGuardScanner 在处理大文件（特别是 XML 文件）时存在 OOM（内存溢出）问题：
- 49.1MB 的 XML 文件导致 Worker Heap 增长到 214MB 后崩溃
- 字符串拼接导致内存膨胀 4 倍
- 需要实现真正的流式处理以控制内存占用

## 🎯 优化目标

1. **内存控制**：峰值内存控制在 `CHUNK_SIZE + OVERLAP_SIZE`（约 5MB）
2. **检测准确性**：100% 无漏检，通过滑动窗口重叠策略保证
3. **代码质量**：符合 TypeScript 类型要求，异常处理完善，易于维护
4. **统一接口**：检测和预览复用同一处理方法

## 🔧 技术方案

### 核心策略：滑动窗口重叠处理

```
┌──────────────────────────────────────────────┐
│  Stream Reader (流式读取)                     │
│  ↓                                           │
│  Preprocessor (按类型预处理)                   │
│  ├─ XML/HTML → sax 提取文本                  │
│  ├─ Markdown → 移除标记                      │
│  └─ 纯文本 → 直接传递                        │
│  ↓                                           │
│  Sliding Window Processor                    │
│  ├─ 累积到 CHUNK_SIZE                        │
│  ├─ 拼接上一块的重叠区                        │
│  ├─ 检测敏感词                               │
│  ├─ 过滤重复结果                             │
│  ├─ 保留尾部重叠区                           │
│  └─ 推送结果/预览数据                        │
└──────────────────────────────────────────────┘
```

### 关键参数配置

| 参数 | 值 | 说明 |
|------|-----|------|
| `MAX_SENSITIVE_KEYWORD_LENGTH` | 100 | 敏感词库最大长度（字符） |
| `SLIDING_WINDOW_CHUNK_SIZE_MB` | 5 | 每块处理的文本大小（MB） |
| `SLIDING_WINDOW_OVERLAP_SIZE` | 200 | 重叠区大小（字符），= MAX_SENSITIVE_KEYWORD_LENGTH × 2 |
| `MAX_TEXT_CONTENT_SIZE_MB` | 50 | 文件总大小限制（MB） |

### 重叠区管理算法

```typescript
// 计算重叠尾部起始位置
const tailStart = Math.max(
  lastSensitiveEndPos,              // 从最后一个敏感词之后开始
  currentChunk.length - OVERLAP_SIZE // 或保留最后 N 字符
);

const overlapTail = currentChunk.slice(tailStart);
```

### 去重检测逻辑

```typescript
// 过滤掉重叠区的重复检测结果
const newResults = results.filter(r => r.position >= overlapLength);
```

## 📝 实施步骤

### Phase 1: 配置常量定义

**文件**: `src/scan-config.ts`

添加敏感词和滑动窗口相关常量：

```typescript
/** 敏感词库最大长度（字符）- 用于确定滑动窗口重叠区大小 */
export const MAX_SENSITIVE_KEYWORD_LENGTH = 100;

/** 滑动窗口分块大小（MB）- 每块处理的文本大小 */
export const SLIDING_WINDOW_CHUNK_SIZE_MB = 5;

/** 滑动窗口重叠区大小（字符）- 至少是最大敏感词长度的 2 倍 */
export const SLIDING_WINDOW_OVERLAP_SIZE = MAX_SENSITIVE_KEYWORD_LENGTH * 2; // 200 字符
```

---

### Phase 2: 创建滑动窗口处理器

**文件**: `src/file-stream-processor.ts` (新建)

#### 数据结构定义

```typescript
interface SensitiveResult {
  keyword: string;
  position: number;      // 在当前块中的位置
  typeId: string;
  typeName: string;
}

interface ProcessChunkResult {
  text: string;                          // 完整文本（用于预览）
  newResults: SensitiveResult[];         // 新检测到的敏感词（排除重叠区）
  overlapTail: string;                   // 需要传递给下一块的重叠尾部
  lastSensitiveEndPos: number;           // 最后一个敏感词的结束位置
}

interface StreamProcessorOptions {
  mode: 'detect' | 'preview' | 'both';   // 处理模式
  onSensitiveDetected?: (result: SensitiveResult) => void;
  onChunkReady?: (chunk: string, highlights: HighlightRange[]) => void;
}

interface ProcessResult {
  text: string;                          // 完整文本（仅 preview/both 模式）
  sensitiveResults: SensitiveResult[];   // 所有检测结果
}
```

#### 核心处理类

```typescript
export class FileStreamProcessor {
  private readonly chunkSize: number;
  private readonly overlapSize: number;
  private readonly maxFileSize: number;

  constructor() {
    this.chunkSize = SLIDING_WINDOW_CHUNK_SIZE_MB * BYTES_TO_MB;
    this.overlapSize = SLIDING_WINDOW_OVERLAP_SIZE;
    this.maxFileSize = MAX_TEXT_CONTENT_SIZE_MB * BYTES_TO_MB;
  }

  /**
   * 处理单个文本块
   */
  private processChunk(
    chunk: string,
    overlapLength: number,
    enabledTypes: string[]
  ): ProcessChunkResult {
    // 检测敏感词
    const results = getHighlights(chunk, enabledTypes);
    
    // 转换为内部格式
    const sensitiveResults: SensitiveResult[] = results.map(h => ({
      keyword: chunk.substring(h.start, h.end),
      position: h.start,
      typeId: h.typeId,
      typeName: h.typeName
    }));
    
    // 过滤掉重叠区的重复结果
    const newResults = sensitiveResults.filter(r => r.position >= overlapLength);
    
    // 找到最后一个敏感词的结束位置
    let lastSensitiveEndPos = 0;
    if (sensitiveResults.length > 0) {
      const lastResult = sensitiveResults[sensitiveResults.length - 1];
      lastSensitiveEndPos = lastResult.position + lastResult.keyword.length;
    }
    
    // 计算重叠尾部
    const tailStart = Math.max(
      lastSensitiveEndPos,
      chunk.length - this.overlapSize
    );
    const overlapTail = chunk.slice(tailStart);
    
    return {
      text: chunk,
      newResults,
      overlapTail,
      lastSensitiveEndPos
    };
  }

  /**
   * 流式处理文件
   */
  async processFile(
    filePath: string,
    enabledTypes: string[],
    options: StreamProcessorOptions
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath, {
        encoding: 'utf-8',
        highWaterMark: 64 * 1024  // 64KB 缓冲区
      });

      let buffer = '';
      let totalSize = 0;
      let previousOverlap = '';
      let allResults: SensitiveResult[] = [];
      let fullTextChunks: string[] = [];
      let isResolved = false;

      stream.on('data', (chunk: string) => {
        if (isResolved) return;

        buffer += chunk;
        totalSize += Buffer.byteLength(chunk, 'utf-8');

        // 检查总大小限制
        if (totalSize > this.maxFileSize) {
          stream.destroy();
          isResolved = true;
          resolve({ text: '', sensitiveResults: [] });
          return;
        }

        // 当缓冲区达到阈值时处理
        if (buffer.length >= this.chunkSize) {
          const currentChunk = previousOverlap + buffer.slice(0, this.chunkSize);
          buffer = buffer.slice(this.chunkSize);

          try {
            const result = this.processChunk(currentChunk, previousOverlap.length, enabledTypes);
            
            // 保存结果
            allResults.push(...result.newResults);
            if (options.mode !== 'detect') {
              fullTextChunks.push(result.text);
            }

            // 通知调用方
            result.newResults.forEach(r => options.onSensitiveDetected?.(r));
            if (options.mode === 'preview' || options.mode === 'both') {
              const highlights = result.newResults.map(r => ({
                start: r.position,
                end: r.position + r.keyword.length,
                typeId: r.typeId,
                typeName: r.typeName
              }));
              options.onChunkReady?.(result.text, highlights);
            }

            // 更新重叠区
            previousOverlap = result.overlapTail;
          } catch (error) {
            stream.destroy();
            isResolved = true;
            reject(error);
          }
        }
      });

      stream.on('end', () => {
        if (isResolved) return;

        try {
          // 处理最后一块
          if (buffer.length > 0 || previousOverlap.length > 0) {
            const finalChunk = previousOverlap + buffer;
            const result = this.processChunk(finalChunk, previousOverlap.length, enabledTypes);
            
            allResults.push(...result.newResults);
            if (options.mode !== 'detect') {
              fullTextChunks.push(result.text);
            }

            result.newResults.forEach(r => options.onSensitiveDetected?.(r));
            if (options.mode === 'preview' || options.mode === 'both') {
              const highlights = result.newResults.map(r => ({
                start: r.position,
                end: r.position + r.keyword.length,
                typeId: r.typeId,
                typeName: r.typeName
              }));
              options.onChunkReady?.(result.text, highlights);
            }
          }

          const fullText = fullTextChunks.join('');
          resolve({
            text: fullText,
            sensitiveResults: allResults
          });
        } catch (error) {
          reject(error);
        }
      });

      stream.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      });
    });
  }
}
```

---

### Phase 3: 改造 XML 文件处理

**文件**: `src/file-parser.ts`

#### 添加 sax 导入

```typescript
import * as sax from 'sax';
```

#### 创建流式 XML 处理器

```typescript
async function extractXmlWithSlidingWindow(
  filePath: string,
  enabledTypes: string[],
  options: StreamProcessorOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const parser = sax.createStream(true, { trim: true });

    let textBuffer = '';
    let previousOverlap = '';
    let allResults: SensitiveResult[] = [];
    let isResolved = false;

    const processor = new FileStreamProcessor();

    parser.on('text', (text: string) => {
      if (isResolved) return;

      if (!text.trim()) return;

      textBuffer += text + ' ';

      // 当缓冲区达到阈值时处理
      if (textBuffer.length >= processor['chunkSize']) {
        try {
          const currentChunk = previousOverlap + textBuffer.slice(0, processor['chunkSize']);
          textBuffer = textBuffer.slice(processor['chunkSize']);

          const result = processor['processChunk'](currentChunk, previousOverlap.length, enabledTypes);
          
          allResults.push(...result.newResults);
          result.newResults.forEach(r => options.onSensitiveDetected?.(r));

          previousOverlap = result.overlapTail;
        } catch (error) {
          stream.destroy();
          parser.destroy();
          isResolved = true;
          reject(error);
        }
      }
    });

    parser.on('end', () => {
      if (isResolved) return;

      try {
        // 处理最后一块
        if (textBuffer.length > 0 || previousOverlap.length > 0) {
          const finalChunk = previousOverlap + textBuffer;
          const result = processor['processChunk'](finalChunk, previousOverlap.length, enabledTypes);
          allResults.push(...result.newResults);
          result.newResults.forEach(r => options.onSensitiveDetected?.(r));
        }

        resolve({
          text: '',
          sensitiveResults: allResults
        });
      } catch (error) {
        reject(error);
      }
    });

    parser.on('error', (error) => {
      if (!isResolved) {
        isResolved = true;
        logError('extractXmlWithSlidingWindow', error, 'warn');
        // 降级到普通文本读取
        extractTextFile(filePath).then(resolve).catch(reject);
      }
    });

    stream.on('error', (error) => {
      if (!isResolved) {
        isResolved = true;
        reject(error);
      }
    });

    stream.pipe(parser);
  });
}
```

---

### Phase 4: 改造文本文件处理

**文件**: `src/file-parser.ts`

使用数组收集优化字符串拼接：

```typescript
async function extractTextFileOptimized(
  filePath: string,
  enabledTypes: string[],
  options: StreamProcessorOptions
): Promise<ProcessResult> {
  const processor = new FileStreamProcessor();
  return processor.processFile(filePath, enabledTypes, options);
}
```

---

### Phase 5: 集成到现有架构

**文件**: `src/file-worker.ts`

修改 Worker 的消息处理逻辑，使用新的流式处理器。

---

### Phase 6: 测试与验证

1. **单元测试**：验证滑动窗口逻辑正确性
2. **集成测试**：处理各种大小的文件，验证内存占用
3. **边界测试**：测试跨边界敏感词检测
4. **性能测试**：对比优化前后的内存占用和处理速度

---

## ⚠️ 注意事项

### 安全性

1. **输入验证**：所有文件路径必须经过验证，防止路径遍历攻击
2. **资源清理**：确保 stream 和 parser 在错误时正确关闭
3. **内存监控**：定期检查内存使用，防止泄漏

### 性能

1. **避免频繁 GC**：使用数组收集代替字符串拼接
2. **批量处理**：减少 IPC 通信次数
3. **懒加载**：只在需要时初始化处理器

### 可维护性

1. **类型安全**：所有函数都有明确的类型定义
2. **错误处理**：所有异步操作都有 try-catch
3. **日志输出**：关键节点输出日志，便于调试
4. **代码注释**：复杂逻辑添加详细注释

---

## 📊 预期效果

| 指标 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| **峰值内存** | 文件大小 × 4 | ~5MB | ↓ 95% |
| **50MB XML 文件** | ~200MB → OOM | ~5MB | ✅ 稳定 |
| **GC 压力** | 高 | 低 | ↓ 80% |
| **检测准确性** | 100% | 100% | 持平 |
| **处理速度** | 基准 | ±5% | 持平 |

---

## 🔄 回滚方案

如果新方案出现问题，可以：

1. 保留旧的 `extractTextFromFile` 函数作为降级方案
2. 通过配置开关控制是否启用流式处理
3. 快速回滚到上一个稳定版本

---

## 📅 实施计划

- **Phase 1**: 配置常量定义 - 5 分钟
- **Phase 2**: 创建滑动窗口处理器 - 30 分钟
- **Phase 3**: 改造 XML 文件处理 - 20 分钟
- **Phase 4**: 改造文本文件处理 - 10 分钟
- **Phase 5**: 集成到现有架构 - 20 分钟
- **Phase 6**: 测试与验证 - 30 分钟

**总计**: 约 2 小时

---

## ✅ 验收标准

1. [ ] 处理 50MB XML 文件不崩溃
2. [ ] 峰值内存占用 < 10MB
3. [ ] 所有敏感词都能检测到（包括跨边界的）
4. [ ] TypeScript 编译无错误
5. [ ] 所有异常都被正确处理
6. [ ] 代码审查通过

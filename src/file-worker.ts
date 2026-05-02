/**
 * 文件解析 Worker 线程
 * 负责在后台线程中执行 CPU 密集型的文件解析和敏感数据检测
 */

// 【关键】首先导入日志抑制工具（必须在任何其他导入之前）
import './log-utils';

import { parentPort } from 'worker_threads';

// 【修复】添加 Promise.withResolvers polyfill，解决 pdfjs-dist 兼容性问题
if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function() {
    let resolve: any, reject: any;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// 【修复】在 Worker 线程中也定义 DOMMatrix，解决 PDF 解析问题
// Worker 线程有独立的全局作用域，需要单独定义
try {
  const { DOMMatrix } = require('@napi-rs/canvas');
  if (typeof (global as any).DOMMatrix === 'undefined') {
    (global as any).DOMMatrix = DOMMatrix;
  }
} catch (error) {
  // Worker 中静默失败，由主进程的错误处理捕获
}

import { extractTextFromFile } from './file-parser';
import { detectSensitiveData, getHighlights } from './sensitive-detector';
// 【优化】导入配置常量
import { 
  WORKER_DEFAULT_TIMEOUT,
  WORKER_TIMEOUT_SMALL,
  WORKER_TIMEOUT_MEDIUM,
  WORKER_TIMEOUT_LARGE,
  WORKER_TIMEOUT_HUGE,
  BYTES_TO_MB
} from './scan-config';

interface WorkerTask {
  taskId: number;
  filePath: string;
  enabledSensitiveTypes: string[];
  previewMode?: boolean; // 预览模式：只提取文本，不检测敏感数据
  streamMode?: boolean;  // 【方案 D3】流式模式：分块发送
  chunkSize?: number;    // 【方案 D3】每块行数（默认 1000）
  config?: any; // 预览模式下传入配置（包含启用的敏感类型）
}

interface WorkerResult {
  taskId: number;
  filePath: string;
  text?: string; // 预览模式下返回文本内容
  highlights?: Array<{start: number, end: number, typeId: string, typeName: string}>; // 预览模式下返回高亮信息
  fileSize?: number;
  modifiedTime?: string;
  counts?: Record<string, number>;
  total?: number;
  unsupportedPreview?: boolean;
  error?: string;
}

// 【方案 D3】流式数据块接口
interface StreamChunk {
  type: 'chunk';
  chunkIndex: number;
  lines: string[];
  highlights: Array<{start: number, end: number, typeId: string, typeName: string}>;
  startLine: number;
  totalLines: number;
}

interface StreamComplete {
  type: 'complete';
  totalChunks: number;
}

// 【新增】添加全局错误处理器，防止 Worker 因未捕获异常而崩溃
process.on('unhandledRejection', (reason, _promise) => {
  console.error(`[Worker ${process.pid}] 未处理的 Promise Rejection:`, reason);
});

process.on('uncaughtException', (error) => {
  console.error(`[Worker ${process.pid}] 未捕获的异常:`, error.message);
  // 【关键】即使发生未捕获异常，也要通知主进程，而不是直接退出
  parentPort?.postMessage({
    taskId: -1,
    filePath: 'unknown',
    error: `Worker 内部错误: ${error.message}`
  } as WorkerResult);
});

// 监听主线程传来的任务
parentPort?.on('message', async (task: WorkerTask) => {
  const { taskId, filePath, enabledSensitiveTypes, previewMode = false } = task;
  
  // 【优化】设置超时保护（使用配置常量）
  let timeoutId: NodeJS.Timeout | null = null;
  
  try {
    // 【优化】获取文件统计信息（添加错误处理）
    const fs = require('fs');
    let stat: any;
    try {
      stat = fs.statSync(filePath);
    } catch (statError: any) {
      console.error(`[Worker ${process.pid}] 无法读取文件状态: ${filePath}`, statError.message);
      parentPort?.postMessage({
        taskId,
        filePath,
        error: `无法访问文件: ${statError.message}`
      } as WorkerResult);
      return;
    }
    
    // 【D2 优化】根据文件大小动态设置超时时间（使用配置常量）
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
    
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`处理超时 (${Math.floor(timeoutMs / 1000)}秒)`));
      }, timeoutMs);
    });
    
    // 提取文本（CPU 密集型操作）
    const extractPromise = extractTextFromFile(filePath);
    const { text, unsupportedPreview } = await Promise.race([
      extractPromise,
      timeoutPromise
    ]) as { text: string; unsupportedPreview: boolean };
    
    // 清除超时
    if (timeoutId) clearTimeout(timeoutId);
    
    if (unsupportedPreview) {
      // 不支持的文件类型，直接返回
      parentPort?.postMessage({
        taskId,
        filePath,
        text: '', // 预览模式需要返回空文本
        unsupportedPreview: true
      } as WorkerResult);
      return;
    }
    
    // 如果是预览模式，提取文本并计算高亮（在 Worker 中执行，避免阻塞主线程）
    if (previewMode) {
      // 从配置中获取启用的敏感类型
      const enabledTypes = task.config?.enabledSensitiveTypes || [];
      
      // 【方案 D3】流式模式：分块发送
      if (task.streamMode) {
        const lines = text.split('\n');
        const chunkSize = task.chunkSize || 1000;
        const totalLines = lines.length;
        
        // 构建行索引
        const lineStartPositions: number[] = [0];
        let position = 0;
        for (let i = 0; i < lines.length; i++) {
          position += lines[i].length + 1;  // +1 是换行符
          lineStartPositions.push(position);
        }
        
        // 计算全局高亮
        const allHighlights = getHighlights(text, enabledTypes);
        
        // 【关键】连续发送所有块，不等待前端响应
        for (let i = 0; i < lines.length; i += chunkSize) {
          const chunkLines = lines.slice(i, i + chunkSize);
          const chunkHighlights = getHighlightsForLines(
            chunkLines,
            i,
            allHighlights,
            lineStartPositions
          );
          
          parentPort?.postMessage({
            type: 'chunk',
            chunkIndex: Math.floor(i / chunkSize),
            lines: chunkLines,
            highlights: chunkHighlights,
            startLine: i,
            totalLines: totalLines
          } as StreamChunk);
          
          // 每发送 10 块，让出控制权，避免阻塞 Worker
          if (i % (chunkSize * 10) === 0 && i > 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
        
        // 发送完成消息
        parentPort?.postMessage({ 
          type: 'complete',
          totalChunks: Math.ceil(totalLines / chunkSize)
        } as StreamComplete);
        
        return;
      }
      
      // 非流式模式：一次性返回（兼容旧代码）
      const highlights = getHighlights(text, enabledTypes);
      
      parentPort?.postMessage({
        taskId,
        filePath,
        text: text,
        highlights: highlights,
        unsupportedPreview: false
      } as WorkerResult);
      return;
    }
    
    // 扫描模式：检测敏感数据（CPU 密集型操作）
    const counts = detectSensitiveData(text, enabledSensitiveTypes);
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
});

// 通知主线程 Worker 已就绪
parentPort?.postMessage({ type: 'ready' });

// 【方案 D3】辅助函数：按行范围提取高亮
function getHighlightsForLines(
  lines: string[],
  startLineIndex: number,
  allHighlights: Array<{start: number, end: number, typeId: string, typeName: string}>,
  lineStartPositions: number[]
): Array<{start: number, end: number, typeId: string, typeName: string}> {
  const lineStart = lineStartPositions[startLineIndex];
  const lineEnd = startLineIndex + lines.length < lineStartPositions.length 
    ? lineStartPositions[startLineIndex + lines.length] - 1
    : Infinity;
  
  // 筛选出在该行范围内的高亮
  return allHighlights.filter(h => 
    h.start >= lineStart && h.end <= lineEnd
  ).map(h => ({
    ...h,
    // 转换为行内偏移
    start: h.start - lineStart,
    end: h.end - lineStart
  }));
}

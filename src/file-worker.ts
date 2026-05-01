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
import { detectSensitiveData } from './sensitive-detector';
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
}

interface WorkerResult {
  taskId: number;
  filePath: string;
  text?: string; // 预览模式下返回文本内容
  fileSize?: number;
  modifiedTime?: string;
  counts?: Record<string, number>;
  total?: number;
  unsupportedPreview?: boolean;
  error?: string;
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
    
    // 如果是预览模式，只返回文本内容，不检测敏感数据
    if (previewMode) {
      parentPort?.postMessage({
        taskId,
        filePath,
        text: text,
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

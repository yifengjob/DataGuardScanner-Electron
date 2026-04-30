/**
 * 文件解析 Worker 线程
 * 负责在后台线程中执行 CPU 密集型的文件解析和敏感数据检测
 */
import { parentPort } from 'worker_threads';

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
import { WORKER_DEFAULT_TIMEOUT } from './scan-config';

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

// 监听主线程传来的任务
parentPort?.on('message', async (task: WorkerTask) => {
  const { taskId, filePath, enabledSensitiveTypes, previewMode = false } = task;
  
  // 设置超时保护
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('处理超时'));
    }, WORKER_DEFAULT_TIMEOUT);
  });
  
  try {
    // 获取文件统计信息
    const fs = require('fs');
    const stat = fs.statSync(filePath);
    
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
    
    // 发生错误，返回错误信息
    console.error(`[Worker ${process.pid}] 任务失败:`, error.message);
    parentPort?.postMessage({
      taskId,
      filePath,
      error: error.message
    } as WorkerResult);
  }
});

// 通知主线程 Worker 已就绪
parentPort?.postMessage({ type: 'ready' });

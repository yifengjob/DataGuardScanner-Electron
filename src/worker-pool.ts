/**
 * Worker 线程池管理器
 * 管理多个 Worker 线程，实现任务调度和负载均衡
 */
import { Worker } from 'worker_threads';
import * as path from 'path';

interface PendingTask {
  taskId: number;
  filePath: string;
  enabledSensitiveTypes: string[];
  fileSize?: number; // 【新增】文件大小，用于动态计算超时时间
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

interface WorkerInfo {
  worker: Worker;
  busy: boolean;
  currentTaskId?: number;
  taskStartTime?: number; // 【新增】记录任务开始时间
}

export class WorkerPool {
  private workers: WorkerInfo[] = [];
  private taskQueue: PendingTask[] = [];
  private pendingTasks = new Map<number, PendingTask>();  // ← 新增：保存所有待处理的任务
  private taskTimeouts = new Map<number, NodeJS.Timeout>(); // 【新增】保存任务超时定时器
  private nextTaskId = 0;
  private destroyed = false;
  private readonly TASK_TIMEOUT = 180000; // 【新增】单个任务最大执行时间 3 分钟（考虑大文件处理）

  constructor(private poolSize: number) {
    // 创建 Worker 池
    for (let i = 0; i < poolSize; i++) {
      this.createWorker();
    }
  }

  private createWorker() {
    const workerPath = path.join(__dirname, 'file-worker.js');
    
    // 为 Worker 设置内存限制（512 MB）
    // 这是单个 Worker 的 V8 堆内存限制
    const worker = new Worker(workerPath, {
      resourceLimits: {
        maxOldGenerationSizeMb: 512, // 老生代内存限制
        maxYoungGenerationSizeMb: 64, // 新生代内存限制
      }
    });

    const workerInfo: WorkerInfo = {
      worker,
      busy: false
    };

    worker.on('message', (result) => {
      if (result.type === 'ready') {
        // Worker 已就绪，可以接收任务
        return;
      }

      // 找到对应的任务并 resolve
      const taskId = result.taskId;
      
      // 【修复】先清除任务超时定时器
      if (workerInfo.currentTaskId !== undefined) {
        const timeoutId = this.taskTimeouts.get(workerInfo.currentTaskId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          this.taskTimeouts.delete(workerInfo.currentTaskId);
        }
      }
      
      // 从 Map 中查找任务
      const pending = this.pendingTasks.get(taskId);
      
      if (!pending) {
        // 【修复】如果任务已被超时处理删除，忽略此消息
        console.warn(`[WorkerPool] 任务 ${taskId} 已被超时处理或删除，忽略 Worker 返回的结果`);
        
        // 标记 Worker 为空闲
        workerInfo.busy = false;
        workerInfo.currentTaskId = undefined;
        workerInfo.taskStartTime = undefined;
        
        // 调度下一个任务
        this.dispatchNextTask(workerInfo);
        return;
      }
      
      // 从 Map 中删除
      this.pendingTasks.delete(taskId);
      
      // 标记 Worker 为空闲
      workerInfo.busy = false;
      workerInfo.currentTaskId = undefined;
      workerInfo.taskStartTime = undefined;

      // 处理结果
      if (result.error) {
        console.error(`Worker 任务 ${taskId} 失败:`, result.error);
        pending.reject(new Error(result.error));
      } else {
        pending.resolve(result);
      }

      // 调度下一个任务
      this.dispatchNextTask(workerInfo);
    });

    worker.on('error', (error: any) => {
      console.error('Worker 错误:', error.message);
      
      // 【修复】清除任务超时定时器
      if (workerInfo.currentTaskId !== undefined) {
        const timeoutId = this.taskTimeouts.get(workerInfo.currentTaskId);
        if (timeoutId) {
          clearTimeout(timeoutId);
          this.taskTimeouts.delete(workerInfo.currentTaskId);
        }
      }
      
      workerInfo.busy = false;
      
      // 如果当前有任务，reject 它
      if (workerInfo.currentTaskId !== undefined) {
        const pending = this.pendingTasks.get(workerInfo.currentTaskId);
        if (pending) {
          this.pendingTasks.delete(workerInfo.currentTaskId);
          
          // 如果是内存溢出错误，给出更友好的提示
          if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
            console.error(`Worker 内存溢出！文件可能太大或太复杂: ${pending.filePath}`);
            pending.reject(new Error('文件处理失败：内存不足，请尝试降低并发数'));
          } else {
            pending.reject(error);
          }
        }
      }
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Worker 异常退出，代码: ${code}`);
        
        // 【修复】清除任务超时定时器
        if (workerInfo.currentTaskId !== undefined) {
          const timeoutId = this.taskTimeouts.get(workerInfo.currentTaskId);
          if (timeoutId) {
            clearTimeout(timeoutId);
            this.taskTimeouts.delete(workerInfo.currentTaskId);
          }
        }
        
        // 如果 Worker 异常退出，尝试重新创建一个
        // 延迟 100ms 后重新创建，避免频繁重启
        setTimeout(() => {
          if (!this.destroyed) {
            console.log('正在重新创建 Worker...');
            this.createWorker();
          }
        }, 100);
      }
      workerInfo.busy = false;
    });

    this.workers.push(workerInfo);
  }

  /**
   * 提交文件处理任务
   */
  async processFile(
    filePath: string,
    enabledSensitiveTypes: string[],
    fileSize?: number // 【新增】可选的文件大小参数
  ): Promise<any> {
    if (this.destroyed) {
      throw new Error('Worker 池已销毁');
    }

    return new Promise((resolve, reject) => {
      const taskId = this.nextTaskId++;
      
      const task: PendingTask = {
        taskId,
        filePath,
        enabledSensitiveTypes,
        fileSize,
        resolve,
        reject
      };

      this.taskQueue.push(task);
      this.pendingTasks.set(taskId, task);
      this.tryDispatch();
    });
  }

  /**
   * 尝试调度任务
   */
  private tryDispatch() {
    // 遍历所有 Worker，找到空闲的并分配任务
    for (const workerInfo of this.workers) {
      if (!workerInfo.busy && this.taskQueue.length > 0) {
        this.dispatchNextTask(workerInfo);
      }
    }
  }

  /**
   * 【优化】根据文件大小计算动态超时时间
   * - 小文件 (< 1MB): 30 秒（快速失败）
   * - 中文件 (1-10MB): 60 秒
   * - 大文件 (10-50MB): 120 秒
   * - 超大文件 (> 50MB): 180 秒
   */
  private calculateTimeout(fileSize?: number): number {
    if (!fileSize) {
      return 60000; // 默认 1 分钟
    }
    
    const sizeMB = fileSize / 1024 / 1024;
    
    if (sizeMB < 1) {
      return 30000; // 30 秒（小文件应该很快）
    } else if (sizeMB < 10) {
      return 60000; // 1 分钟
    } else if (sizeMB < 50) {
      return 120000; // 2 分钟
    } else {
      return 180000; // 3 分钟
    }
  }

  /**
   * 为指定的 Worker 调度下一个任务
   */
  private dispatchNextTask(workerInfo: WorkerInfo) {
    if (this.taskQueue.length === 0) {
      return;
    }

    // 从队列中取出第一个任务
    const task = this.taskQueue.shift();
    if (!task) {
      return;
    }

    // 标记 Worker 为忙碌
    workerInfo.busy = true;
    workerInfo.currentTaskId = task.taskId;
    workerInfo.taskStartTime = Date.now();

    // 【新增】设置任务级别超时保护（动态超时）
    // 注意：这个超时应该比 Worker 内部的 60 秒超时更长，作为兜底保护
    // 主要针对 Worker 内部超时未触发的极端情况（如死锁、无限循环等）
    const timeout = this.calculateTimeout(task.fileSize);
    const timeoutId = setTimeout(() => {
      const sizeMB = task.fileSize ? Math.round(task.fileSize / 1024 / 1024) : 0;
      console.error(`[WorkerPool] 任务 ${task.taskId} 执行超时（${timeout / 1000}秒）: ${task.filePath} (${sizeMB} MB)`);
      console.warn(`[WorkerPool] 这可能是由于：`);
      console.warn(`  1. 文件太大或太复杂（建议降低并发数）`);
      console.warn(`  2. 文件格式损坏导致解析器卡住`);
      console.warn(`  3. Worker 内部超时机制失效（Bug）`);
      
      // 从 Map 中移除任务
      this.pendingTasks.delete(task.taskId);
      this.taskTimeouts.delete(task.taskId);
      
      // 拒绝任务的 Promise
      task.reject(new Error(`文件处理超时（超过${timeout / 1000}秒），可能是文件太大、格式异常或解析器卡住`));
      
      // 强制终止并重新创建 Worker
      console.warn(`[WorkerPool] 正在终止超时的 Worker...`);
      try {
        workerInfo.worker.terminate();
      } catch (err) {
        console.error(`[WorkerPool] 终止 Worker 失败:`, err);
      }
      
      // 标记 Worker 为空闲
      workerInfo.busy = false;
      workerInfo.currentTaskId = undefined;
      workerInfo.taskStartTime = undefined;
      
      // 重新创建 Worker
      if (!this.destroyed) {
        console.log('[WorkerPool] 正在重新创建 Worker...');
        this.createWorker();
      }
      
      // 继续调度下一个任务
      this.dispatchNextTask(workerInfo);
    }, timeout);
    
    this.taskTimeouts.set(task.taskId, timeoutId);

    // 发送任务到 Worker
    workerInfo.worker.postMessage({
      taskId: task.taskId,
      filePath: task.filePath,
      enabledSensitiveTypes: task.enabledSensitiveTypes
    });
  }

  /**
   * 获取池的大小
   */
  get size(): number {
    return this.workers.length;
  }

  /**
   * 获取繁忙的 Worker 数量
   */
  get busyCount(): number {
    return this.workers.filter(w => w.busy).length;
  }

  /**
   * 获取队列中的任务数
   */
  get queueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * 销毁 Worker 池
   */
  destroy() {
    this.destroyed = true;
    
    // 清除所有任务超时定时器
    for (const timeoutId of this.taskTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.taskTimeouts.clear();
    
    // 拒绝所有待处理的任务（从 Map 中）
    for (const [taskId, task] of this.pendingTasks) {
      task.reject(new Error('Worker 池已销毁'));
    }
    this.pendingTasks.clear();
    this.taskQueue = [];

    // 终止所有 Worker
    for (const workerInfo of this.workers) {
      try {
        workerInfo.worker.terminate();
      } catch (error) {
        console.error('终止 Worker 失败:', error);
      }
    }
    this.workers = [];
  }
}

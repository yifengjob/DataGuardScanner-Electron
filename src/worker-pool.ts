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
  resolve: (result: any) => void;
  reject: (error: any) => void;
}

interface WorkerInfo {
  worker: Worker;
  busy: boolean;
  currentTaskId?: number;
}

export class WorkerPool {
  private workers: WorkerInfo[] = [];
  private taskQueue: PendingTask[] = [];
  private pendingTasks = new Map<number, PendingTask>();  // ← 新增：保存所有待处理的任务
  private nextTaskId = 0;
  private destroyed = false;

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
      
      // 标记 Worker 为空闲
      workerInfo.busy = false;
      workerInfo.currentTaskId = undefined;

      // 处理结果
      if (result.error) {
        console.error(`Worker 任务 ${taskId} 失败:`, result.error);
      }

      // 从 Map 中查找任务（而不是队列）
      const pending = this.pendingTasks.get(taskId);
      
      if (pending) {
        // 从 Map 中删除
        this.pendingTasks.delete(taskId);
        
        if (result.error) {
          pending.reject(new Error(result.error));
        } else {
          pending.resolve(result);
        }
      } else {
        console.error(`[WorkerPool] 未找到任务 ${taskId} 的 Promise!`);
      }

      // 调度下一个任务
      this.dispatchNextTask(workerInfo);
    });

    worker.on('error', (error: any) => {
      console.error('Worker 错误:', error.message);
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
    enabledSensitiveTypes: string[]
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

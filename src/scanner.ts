import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { Worker } from 'worker_threads';
import { ScanConfig, ScanResultItem } from './types';
import { ScanState } from './scan-state';
import { addAllowedPath, clearAllowedPaths } from './file-operations';
import { calculateActualConcurrency } from './config-manager';

export async function startScan(
    config: ScanConfig,
    mainWindow: BrowserWindow,
    scanState: ScanState
): Promise<void> {
    if (scanState.isScanning) {
        throw new Error('扫描正在进行中');
    }

    scanState.isScanning = true;
    scanState.cancelFlag = false;
    scanState.logs = [];

    // 清除旧的允许路径，添加新的扫描路径
    clearAllowedPaths();
    config.selectedPaths.forEach(p => addAllowedPath(p));

    const log = (msg: string) => {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const logWithTime = `[${timeStr}] ${msg}`;

        // 【优化】异步添加到日志数组，避免阻塞
        setImmediate(() => {
            scanState.logs.push(logWithTime);
        });
        
        // 【优化】异步发送日志到前端，避免阻塞主线程
        setImmediate(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scan-log', logWithTime);
            }
        });
    };

    log('开始扫描...');
    log(`扫描路径数: ${config.selectedPaths.length}`);
    log(`文件类型数: ${config.selectedExtensions.length}`);
    log(`选中的扩展名: ${config.selectedExtensions.join(', ')}`);
    log(`敏感检测类型: ${config.enabledSensitiveTypes.join(', ')}`);
    log('---');

    // 计算并发数
    const concurrencyInfo = calculateActualConcurrency(config.scanConcurrency);
    const poolSize = concurrencyInfo.actualConcurrency;
    
    if (config.scanConcurrency && config.scanConcurrency > concurrencyInfo.maxAllowedConcurrency) {
        log(`警告: 配置的并发数 ${config.scanConcurrency} 超过最大值 ${concurrencyInfo.maxAllowedConcurrency}，已自动调整`);
        log(`提示: 系统可用内存 ${concurrencyInfo.freeMemoryGB.toFixed(1)} GB, CPU ${concurrencyInfo.cpuCount} 核, 建议不超过 ${concurrencyInfo.maxAllowedConcurrency}`);
    }

    log(`使用 ${poolSize} 个 Consumer Workers (CPU: ${concurrencyInfo.cpuCount}核, 可用内存: ${concurrencyInfo.freeMemoryGB.toFixed(1)}GB)`);

    // 统计信息
    let walkerTotalCount = 0;      // Walker 找到的文件总数
    let walkerSkippedCount = 0;    // Walker 跳过的文件数
    let consumerProcessedCount = 0; // Consumer 已处理的文件数
    let resultCount = 0;            // 发现的敏感文件数
    let activeWorkerCount = 0;      // 【优化】跟踪活跃的 Worker 数量

    // 创建 Consumer Workers 池
    const consumers: Array<{
        worker: Worker;
        busy: boolean;
        taskId?: number;
    }> = [];

    const pendingTasks = new Map<number, {
        filePath: string;
        resolve: (result: any) => void;
        reject: (error: any) => void;
        timeoutId: NodeJS.Timeout;
    }>();

    let nextTaskId = 0;
    const taskQueue: Array<{ filePath: string; fileSize: number; fileMtime: string }> = [];
    
    // IPC 节流
    let lastProgressTime = 0;

    // 创建 Consumer Worker
    function createConsumer(id: number) {
        const workerPath = path.join(__dirname, 'file-worker.js');
        
        const worker = new Worker(workerPath, {
            resourceLimits: {
                maxOldGenerationSizeMb: 512,
                maxYoungGenerationSizeMb: 64,
            }
        });

        const consumer = {
            worker,
            busy: false,
            taskId: undefined
        };

        worker.on('message', (result) => {
            if (result.type === 'ready') {
                return;
            }

            const taskId = result.taskId;
            const pending = pendingTasks.get(taskId);

            if (!pending) {
                // 【优化】只在调试模式下输出，避免生产环境日志过多
                if (process.env.NODE_ENV === 'development') {
                    console.warn(`[Consumer ${id}] 任务 ${taskId} 已被删除，忽略结果`);
                }
                consumer.busy = false;
                activeWorkerCount--; // 【优化】减少活跃计数
                consumer.taskId = undefined;
                consumerProcessedCount++; // 即使任务已删除也要计数，避免死锁
                tryDispatch();
                return;
            }

            // 清除超时定时器
            clearTimeout(pending.timeoutId);
            pendingTasks.delete(taskId);

            // 标记 Worker 为空闲
            consumer.busy = false;
            consumer.taskId = undefined;
            activeWorkerCount--; // 【优化】减少活跃计数
            consumerProcessedCount++;

            // 【优化】节流发送进度更新（每 200ms 最多一次）
            const now = Date.now();
            if (!lastProgressTime || now - lastProgressTime >= 200) {
                mainWindow.webContents.send('scan-progress', {
                    currentFile: result.filePath || '',
                    scannedCount: consumerProcessedCount,
                    totalCount: walkerTotalCount,
                    skippedCount: walkerSkippedCount
                });
                lastProgressTime = now;
            }

            // 处理结果
            if (result.error) {
                log(`处理文件失败: ${result.error}`);
                pending.reject(new Error(result.error));
            } else {
                if (result.total && result.total > 0) {
                    resultCount++;
                    log(`发现敏感文件 [${resultCount}]: ${result.filePath} (总计: ${result.total} 个敏感项)`);

                    const resultItem: ScanResultItem = {
                        filePath: result.filePath,
                        fileSize: result.fileSize || 0,
                        modifiedTime: result.modifiedTime || new Date().toISOString(),
                        counts: result.counts || {},
                        total: result.total,
                        unsupportedPreview: false
                    };

                    mainWindow.webContents.send('scan-result', resultItem);
                }
                pending.resolve(result);
            }

            // 调度下一个任务
            tryDispatch();
        });

        worker.on('error', (error: any) => {
            // 【优化】只记录到日志文件，不发送到前端
            console.error(`[Consumer ${id}] Worker 错误:`, error.message);
            consumer.busy = false;
            activeWorkerCount--; // 【优化】减少活跃计数
            
            if (consumer.taskId !== undefined) {
                const pending = pendingTasks.get(consumer.taskId);
                if (pending) {
                    clearTimeout(pending.timeoutId);
                    pendingTasks.delete(consumer.taskId);
                    consumerProcessedCount++; // 即使失败也要计数
                    pending.reject(error);
                }
            }
        });

        worker.on('exit', (code) => {
            if (code !== 0 && !scanState.cancelFlag) {
                // 【优化】只记录到日志文件
                console.error(`[Consumer ${id}] Worker 异常退出，代码: ${code}`);
                setTimeout(() => {
                    if (!scanState.cancelFlag) {
                        const index = consumers.findIndex(c => c.worker === worker);
                        if (index > -1) {
                            consumers.splice(index, 1);
                            createConsumer(id);
                        }
                    }
                }, 100);
            }
            consumer.busy = false;
        });

        consumers.push(consumer);
    }

    // 创建所有 Consumer Workers
    for (let i = 0; i < poolSize; i++) {
        createConsumer(i);
    }

    // 计算动态超时时间
    function calculateTimeout(fileSize: number): number {
        const sizeMB = fileSize / 1024 / 1024;
        
        if (sizeMB < 1) {
            return 30000; // 30 秒
        } else if (sizeMB < 10) {
            return 60000; // 1 分钟
        } else if (sizeMB < 50) {
            return 120000; // 2 分钟
        } else {
            return 180000; // 3 分钟
        }
    }

    // 尝试调度任务
    function tryDispatch() {
        for (const consumer of consumers) {
            if (!consumer.busy && taskQueue.length > 0) {
                // 处理 Promise rejection，避免未捕获的错误
                const promise = dispatchNextTask(consumer);
                if (promise) {
                    promise.catch((error) => {
                        console.error(`[TaskQueue] 任务分发失败:`, error.message);
                    });
                }
            }
        }
    }

    // 分发下一个任务
    function dispatchNextTask(consumer: typeof consumers[0]) {
        const task = taskQueue.shift();
        if (!task) {
            return;
        }

        consumer.busy = true;
        activeWorkerCount++; // 【优化】增加活跃计数
        const taskId = nextTaskId++;
        consumer.taskId = taskId;

        // 创建 Promise 并保存
        return new Promise<void>((resolve, reject) => {
            // 设置超时
            const timeout = calculateTimeout(task.fileSize);
            const timeoutId = setTimeout(() => {
                console.error(`[TaskQueue] 任务 ${taskId} 超时 (${timeout / 1000}秒): ${task.filePath}`);
                const pending = pendingTasks.get(taskId);
                if (pending) {
                    pendingTasks.delete(taskId);
                    activeWorkerCount--; // 【优化】减少活跃计数
                    consumerProcessedCount++; // 超时也要计数
                    pending.reject(new Error(`文件处理超时（${timeout / 1000}秒）`));
                }
                
                // 终止并重新创建 Worker
                try {
                    consumer.worker.terminate();
                } catch (err) {
                    console.error('终止 Worker 失败:', err);
                }
                
                const index = consumers.indexOf(consumer);
                if (index > -1) {
                    consumers.splice(index, 1);
                    createConsumer(index);
                }
                
                resolve(); // 超时处理后继续
            }, timeout);

            pendingTasks.set(taskId, {
                filePath: task.filePath,
                resolve,
                reject,
                timeoutId
            });

            // 发送任务到 Worker
            consumer.worker.postMessage({
                taskId,
                filePath: task.filePath,
                enabledSensitiveTypes: config.enabledSensitiveTypes
            });
        });
    }

    // 创建 Walker Worker
    const walkerWorkerPath = path.join(__dirname, 'walker-worker.js');
    const walkerWorker = new Worker(walkerWorkerPath);

    walkerWorker.on('message', (message: any) => {
        if (message.type === 'ready') {
            return;
        }

        if (message.type === 'file-found') {
            walkerTotalCount++;
            
            // 更新进度
            const now = Date.now();
            if (!lastProgressTime || now - lastProgressTime >= 200) {
                mainWindow.webContents.send('scan-progress', {
                    currentFile: message.filePath,
                    scannedCount: consumerProcessedCount,
                    totalCount: walkerTotalCount,
                    skippedCount: walkerSkippedCount
                });
                lastProgressTime = now;
            }

            // 添加到任务队列
            taskQueue.push({
                filePath: message.filePath,
                fileSize: message.stat.size,
                fileMtime: message.stat.mtime
            });

            // 尝试调度
            tryDispatch();
        }

        if (message.type === 'walking-complete') {
            log(`Walker 完成: 找到 ${message.fileCount} 个文件, 跳过 ${message.skippedCount} 个`);
            walkerSkippedCount += message.skippedCount;
            
            // 等待所有任务完成
            waitForCompletion();
        }

        if (message.type === 'walking-error') {
            log(`Walker 错误: ${message.error}`);
            waitForCompletion();
        }
    });

    walkerWorker.on('error', (error: any) => {
        log(`Walker Worker 错误: ${error.message}`);
        waitForCompletion();
    });

    walkerWorker.on('exit', (code) => {
        if (code !== 0) {
            log(`Walker Worker 异常退出，代码: ${code}`);
        }
    });

    // 等待所有任务完成
    function waitForCompletion() {
        let lastProgressCheck = Date.now();
        let lastProcessedCount = consumerProcessedCount;

        const maxIdleTime = 120000; // 2分钟无进展才超时

        const checkCompletion = () => {
            if (scanState.cancelFlag) {
                cleanup();
                return;
            }

            const now = Date.now();
            const currentProcessed = consumerProcessedCount;
            const currentQueue = taskQueue.length;
            
            // 【优化】只在有进展时更新检查时间
            if (currentProcessed > lastProcessedCount) {
                lastProgressCheck = now;
                lastProcessedCount = currentProcessed;
            }

            const idleTime = now - lastProgressCheck;
            if (idleTime > maxIdleTime) {
                log(`警告: 扫描停滞超过${maxIdleTime / 1000}秒，强制结束`);
                cleanup();
                return;
            }

            // 【优化】使用缓存的 activeWorkerCount，避免频繁 filter
            // 检查间隔增加到 200ms，大幅减少 CPU 占用
            if (activeWorkerCount === 0 && currentQueue === 0) {
                log(`扫描完成: 遍历 ${walkerTotalCount} 个文件, 处理 ${consumerProcessedCount} 个, 跳过 ${walkerSkippedCount} 个, 发现 ${resultCount} 个敏感文件`);
                cleanup();
            } else {
                setTimeout(checkCompletion, 200); // 从 50ms 增加到 200ms
            }
        };

        checkCompletion();
    }

    // 清理资源
    function cleanup() {
        // 终止 Walker Worker
        try {
            walkerWorker.terminate();
        } catch (error) {
            console.error('终止 Walker Worker 失败:', error);
        }

        // 终止所有 Consumer Workers
        for (const consumer of consumers) {
            try {
                consumer.worker.terminate();
            } catch (error) {
                console.error('终止 Consumer Worker 失败:', error);
            }
        }

        // 清除所有超时定时器
        for (const pending of pendingTasks.values()) {
            clearTimeout(pending.timeoutId);
        }
        pendingTasks.clear();

        scanState.isScanning = false;
        log('扫描完成');

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-finished');
        }
    }

    // 启动 Walker Worker
    const totalPaths = config.selectedPaths.length;
    let currentPathIndex = 0;

    for (const rootPath of config.selectedPaths) {
        currentPathIndex++;
        
        if (scanState.cancelFlag) {
            log('扫描已取消');
            break;
        }

        log(`正在扫描: ${rootPath} (${currentPathIndex}/${totalPaths})`);

        if (!fs.existsSync(rootPath)) {
            log(`路径不存在: ${rootPath}`);
            continue;
        }

        if (!fs.statSync(rootPath).isDirectory()) {
            log(`路径不是目录: ${rootPath}`);
            continue;
        }

        // 发送配置到 Walker Worker
        walkerWorker.postMessage({
            type: 'start-walking',
            config: {
                rootPath,
                selectedExtensions: config.selectedExtensions,
                ignoreDirNames: config.ignoreDirNames,
                systemDirs: config.systemDirs,
                maxFileSizeMb: config.maxFileSizeMb,
                maxPdfSizeMb: config.maxPdfSizeMb
            }
        });
    }
}

export function cancelScan(scanState: ScanState): void {
    scanState.cancelFlag = true;
}

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { Worker } from 'worker_threads';
import { ScanConfig, ScanResultItem } from './types';
import { ScanState } from './scan-state';
import { addAllowedPath, clearAllowedPaths } from './file-operations';
import { calculateActualConcurrency } from './config-manager';
// 【优化】导入扫描配置常量
import {
    WORKER_MAX_OLD_GENERATION_MB,
    WORKER_MAX_YOUNG_GENERATION_MB,
    TIMEOUT_SMALL_FILE,
    TIMEOUT_MEDIUM_FILE,
    TIMEOUT_LARGE_FILE,
    TIMEOUT_HUGE_FILE,
    STAGNATION_CHECK_INTERVAL,
    STAGNATION_THRESHOLD,
    MAX_IDLE_TIME,
    PROGRESS_THROTTLE_INTERVAL,
    MAX_LOG_ENTRIES,
    WORKER_RESTART_DELAY
} from './scan-config';

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

        // 【修复】限制日志数组大小，防止内存泄漏
        setImmediate(() => {
            scanState.logs.push(logWithTime);
            if (scanState.logs.length > MAX_LOG_ENTRIES) {
                scanState.logs.shift(); // 移除最旧的日志
            }
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
    let totalSensitiveItems = 0;    // 【新增】发现的敏感信息总条数
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
    
    // 【事件驱动】跟踪最后活动时间（必须在前面声明）
    let lastActivityTime = Date.now();

    // 创建 Consumer Worker
    function createConsumer(id: number) {
        const workerPath = path.join(__dirname, 'file-worker.js');
        
        let worker: Worker;
        try {
            worker = new Worker(workerPath, {
                resourceLimits: {
                    maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB,
                    maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GENERATION_MB,
                }
            });
        } catch (error: any) {
            console.error(`[Consumer ${id}] 创建 Worker 失败:`, error.message);
            log(`错误: 无法创建 Worker ${id} - ${error.message}`);
            return; // 跳过这个 Worker
        }

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
            
            // 【事件驱动】更新最后活动时间
            lastActivityTime = Date.now();

            // 【优化】节流发送进度更新，减少 IPC 开销
            const now = Date.now();
            if (!lastProgressTime || now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL) {
                // 【修复】检查窗口是否已销毁
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('scan-progress', {
                        currentFile: result.filePath || '',
                        scannedCount: consumerProcessedCount,
                        totalCount: walkerTotalCount,
                        skippedCount: walkerSkippedCount
                    });
                }
                lastProgressTime = now;
            }

            // 处理结果
            if (result.error) {
                log(`处理文件失败: ${result.error}`);
                pending.reject(new Error(result.error));
            } else {
                if (result.total && result.total > 0) {
                    resultCount++;
                    totalSensitiveItems += result.total; // 【新增】累加敏感信息总条数
                    log(`发现敏感文件 [${resultCount}]: ${result.filePath} (总计: ${result.total} 个敏感项)`);

                    const resultItem: ScanResultItem = {
                        filePath: result.filePath,
                        fileSize: result.fileSize || 0,
                        modifiedTime: result.modifiedTime || new Date().toISOString(),
                        counts: result.counts || {},
                        total: result.total,
                        unsupportedPreview: false
                    };

                    // 【修复】检查窗口是否已销毁
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('scan-result', resultItem);
                    }
                }
                pending.resolve(result);
            }

            // 调度下一个任务
            tryDispatch();
            
            // 【事件驱动】检查是否应该结束
            checkAndComplete();
        });

        worker.on('error', (error: any) => {
            // 【优化】只记录到日志文件，不发送到前端
            console.error(`[Consumer ${id}] Worker 错误:`, error.message);
            
            // 【修复】只有当 consumer 处于 busy 状态时才减少计数
            if (consumer.busy) {
                consumer.busy = false;
                activeWorkerCount--;
                
                if (consumer.taskId !== undefined) {
                    const pending = pendingTasks.get(consumer.taskId);
                    if (pending) {
                        clearTimeout(pending.timeoutId);
                        pendingTasks.delete(consumer.taskId);
                        consumerProcessedCount++;
                        pending.reject(error);
                    }
                }
            }
        });

        worker.on('exit', (code) => {
            if (code !== 0 && !scanState.cancelFlag) {
                // 【优化】只记录到日志文件
                console.error(`[Consumer ${id}] Worker 异常退出，代码: ${code}`);
                
                // 【修复】只有当 consumer 处于 busy 状态时才更新计数
                if (consumer.busy && consumer.taskId !== undefined) {
                    consumer.busy = false;
                    activeWorkerCount--;
                    
                    const pending = pendingTasks.get(consumer.taskId);
                    if (pending) {
                        clearTimeout(pending.timeoutId);
                        pendingTasks.delete(consumer.taskId);
                        consumerProcessedCount++;
                        pending.reject(new Error(`Worker 异常退出（代码: ${code}）`));
                    }
                } else {
                    // Worker 空闲时退出，只需标记
                    consumer.busy = false;
                }
                
                setTimeout(() => {
                    if (!scanState.cancelFlag) {
                        const index = consumers.findIndex(c => c.worker === worker);
                        if (index > -1) {
                            consumers.splice(index, 1);
                            createConsumer(id);
                        }
                    }
                }, WORKER_RESTART_DELAY);
            } else {
                consumer.busy = false;
            }
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
            return TIMEOUT_SMALL_FILE;
        } else if (sizeMB < 10) {
            return TIMEOUT_MEDIUM_FILE;
        } else if (sizeMB < 50) {
            return TIMEOUT_LARGE_FILE;
        } else {
            return TIMEOUT_HUGE_FILE;
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
                
                // 【修复】更新 Consumer 状态
                consumer.busy = false;
                consumer.taskId = undefined;
                
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
            try {
                consumer.worker.postMessage({
                    taskId,
                    filePath: task.filePath,
                    enabledSensitiveTypes: config.enabledSensitiveTypes
                });
            } catch (error: any) {
                console.error(`[TaskQueue] 发送任务失败:`, error.message);
                // 回滚状态
                consumer.busy = false;
                consumer.taskId = undefined;
                activeWorkerCount--;
                pendingTasks.delete(taskId);
                // 将任务放回队列头部
                taskQueue.unshift(task);
            }
        });
    }

    // 创建 Walker Worker
    const walkerWorkerPath = path.join(__dirname, 'walker-worker.js');
    let walkerWorker: Worker;
    try {
        walkerWorker = new Worker(walkerWorkerPath);
    } catch (error: any) {
        log(`错误: 无法创建 Walker Worker - ${error.message}`);
        scanState.isScanning = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan-error', `无法创建 Walker Worker: ${error.message}`);
        }
        return; // 直接退出
    }

    walkerWorker.on('message', (message: any) => {
        if (message.type === 'ready') {
            return;
        }

        if (message.type === 'file-found') {
            walkerTotalCount++;
            
            // 【事件驱动】更新最后活动时间
            lastActivityTime = Date.now();
            
            // 更新进度（与 Consumer 保持一致）
            const now = Date.now();
            if (!lastProgressTime || now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL) {
                // 【修复】检查窗口是否已销毁
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('scan-progress', {
                        currentFile: message.filePath,
                        scannedCount: consumerProcessedCount,
                        totalCount: walkerTotalCount,
                        skippedCount: walkerSkippedCount
                    });
                }
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
            
            // 【事件驱动】检查是否应该结束
            checkAndComplete();
        }

        if (message.type === 'walking-error') {
            log(`Walker 错误: ${message.error}`);
            
            // 【事件驱动】检查是否应该结束
            checkAndComplete();
        }
    });

    walkerWorker.on('error', (error: any) => {
        log(`Walker Worker 错误: ${error.message}`);
        
        // 【事件驱动】检查是否应该结束
        checkAndComplete();
    });

    walkerWorker.on('exit', (code) => {
        if (code !== 0) {
            log(`Walker Worker 异常退出，代码: ${code}`);
        }
    });

    // 【事件驱动】检查是否应该结束扫描
    let completionCheckTimer: NodeJS.Timeout | null = null;
    let isCleaningUp = false; // 【修复】防止 cleanup 被多次调用
    
    // 【优化】多指标停滞检测 - 记录上次检查时的状态快照
    let lastStagnationCheckState = {
        processed: consumerProcessedCount,
        total: walkerTotalCount,
        skipped: walkerSkippedCount,
        results: resultCount,
        sensitiveItems: totalSensitiveItems  // 【新增】敏感信息总条数
    };
    let lastStagnationCheckTime = Date.now();

    function checkAndComplete() {
        // 检查是否取消
        if (scanState.cancelFlag) {
            cleanup();
            return;
        }

        // 【事件驱动】只有在没有活跃 Worker 且队列为空时才完成
        if (activeWorkerCount === 0 && taskQueue.length === 0) {
            log(`扫描完成: 遍历 ${walkerTotalCount} 个文件, 处理 ${consumerProcessedCount} 个, 跳过 ${walkerSkippedCount} 个, 发现 ${resultCount} 个敏感文件`);
            cleanup();
            return;
        }

        // 更新最后活动时间
        lastActivityTime = Date.now();
    }

    // 【优化】多指标停滞检测 - 定期检查
    completionCheckTimer = setInterval(() => {
        const now = Date.now();
        
        // 检查是否有任何实质性进展
        const hasRealProgress = 
            consumerProcessedCount !== lastStagnationCheckState.processed ||
            walkerTotalCount !== lastStagnationCheckState.total ||
            walkerSkippedCount !== lastStagnationCheckState.skipped ||
            resultCount !== lastStagnationCheckState.results ||
            totalSensitiveItems !== lastStagnationCheckState.sensitiveItems;  // 【新增】敏感信息条数变化
        
        if (hasRealProgress) {
            // 有进展，更新状态快照和时间
            lastStagnationCheckState = {
                processed: consumerProcessedCount,
                total: walkerTotalCount,
                skipped: walkerSkippedCount,
                results: resultCount,
                sensitiveItems: totalSensitiveItems  // 【新增】敏感信息总条数
            };
            lastStagnationCheckTime = now;
        } else {
            // 无进展，检查是否应该超时
            const idleTime = now - lastStagnationCheckTime;
            
            // 【保守策略】只有同时满足以下条件才判定为停滞：
            // 1. 超过阈值时间无任何进展
            // 2. 没有活跃的 Worker（activeWorkerCount === 0）
            // 3. 任务队列为空（taskQueue.length === 0）
            // 这样可以避免误杀正在处理大文件的正常任务
            if (idleTime > STAGNATION_THRESHOLD && 
                activeWorkerCount === 0 && 
                taskQueue.length === 0) {
                log(`警告: ${STAGNATION_THRESHOLD / 1000}秒内无任何进展（已处理:${consumerProcessedCount}, 总数:${walkerTotalCount}, 跳过:${walkerSkippedCount}, 敏感文件:${resultCount}, 敏感信息:${totalSensitiveItems}），且系统空闲，强制结束`);
                cleanup();
            }
        }
    }, STAGNATION_CHECK_INTERVAL); // 定期检查

    // 清理资源
    function cleanup() {
        // 【修复】防止重复调用 - 使用原子检查
        if (isCleaningUp) {
            console.warn('[cleanup] 警告: cleanup 已被调用，忽略重复调用');
            return;
        }
        isCleaningUp = true;
        
        console.log('[cleanup] 开始清理资源...');
        
        try {
            // 【事件驱动】清除超时检测定时器
            if (completionCheckTimer) {
                clearInterval(completionCheckTimer);
                completionCheckTimer = null;
            }

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
            
            console.log('[cleanup] 资源清理完成');
        } catch (error) {
            console.error('[cleanup] 清理过程中出错:', error);
            // 即使出错也要标记为完成
            scanState.isScanning = false;
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

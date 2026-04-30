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
    WORKER_RESTART_DELAY,
    BYTES_TO_MB
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
        isTerminating?: boolean; // 【新增】标记是否正在被主动终止
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
    
    // 【新增】统一的进度更新函数，确保前端始终收到最新进度
    function sendProgressUpdate(currentFile: string = '') {
        const now = Date.now();
        if (!lastProgressTime || now - lastProgressTime >= PROGRESS_THROTTLE_INTERVAL) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scan-progress', {
                    currentFile,
                    scannedCount: consumerProcessedCount,
                    totalCount: walkerTotalCount,
                    skippedCount: walkerSkippedCount
                });
            }
            lastProgressTime = now;
        }
    }

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
                // 【性能优化】移除高频日志，只在开发模式下输出
                if (process.env.NODE_ENV === 'development') {
                    console.log(`[Consumer ${id}] Worker 已就绪，等待任务...`);
                }
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

            // 【优化】使用统一的进度更新函数
            sendProgressUpdate(result.filePath || '');

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
            // 【修复】区分主动终止和异常退出
            const consumerRef = consumer as typeof consumers[0];
            if (consumerRef.isTerminating) {
                // 主动终止（超时等情况），不视为异常
                console.log(`[Consumer ${id}] Worker 已终止（代码: ${code}）`);
                consumerRef.isTerminating = false;
                consumerRef.busy = false;
                return;
            }
            
            if (code !== 0 && !scanState.cancelFlag) {
                // 【优化】只记录到日志文件
                console.error(`[Consumer ${id}] Worker 异常退出，代码: ${code}`);
                
                // 【修复】只有当 consumer 处于 busy 状态时才更新计数
                if (consumerRef.busy && consumerRef.taskId !== undefined) {
                    consumerRef.busy = false;
                    activeWorkerCount--;
                    
                    const pending = pendingTasks.get(consumerRef.taskId);
                    if (pending) {
                        clearTimeout(pending.timeoutId);
                        pendingTasks.delete(consumerRef.taskId);
                        consumerProcessedCount++;
                        pending.reject(new Error(`Worker 异常退出（代码: ${code}）`));
                    }
                } else {
                    // Worker 空闲时退出，只需标记
                    consumerRef.busy = false;
                }
                
                // 【关键】延迟重启 Worker，避免频繁创建销毁
                setTimeout(() => {
                    if (!scanState.cancelFlag) {
                        const index = consumers.findIndex(c => c.worker === worker);
                        if (index > -1) {
                            console.log(`[Consumer ${id}] 正在重启 Worker...`);
                            consumers.splice(index, 1);
                            createConsumer(id);
                            // 【关键】重启后立即尝试调度任务，防止停滞
                            setTimeout(() => tryDispatch(), 100);
                        }
                    }
                }, WORKER_RESTART_DELAY);
            } else {
                consumerRef.busy = false;
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
        const sizeMB = fileSize / BYTES_TO_MB;
        
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
        // 【性能优化】移除高频日志，避免 I/O 阻塞主线程
        // console.log(`[tryDispatch] 检查调度: taskQueue=${taskQueue.length}, consumers=${consumers.length}`);
        let dispatched = 0;
        for (const consumer of consumers) {
            if (!consumer.busy && taskQueue.length > 0) {
                // 【优化】只在真正分发时才记录
                // console.log(`[tryDispatch] 分发任务给 Consumer`);
                // 处理 Promise rejection，避免未捕获的错误
                const promise = dispatchNextTask(consumer);
                if (promise) {
                    dispatched++;
                    promise.catch((error) => {
                        console.error(`[TaskQueue] 任务分发失败:`, error.message);
                    });
                }
            }
        }
        // 【优化】移除成功分发的日志，避免频繁输出
        // if (dispatched > 0) {
        //     console.log(`[tryDispatch] 成功分发 ${dispatched} 个任务`);
        // }
        // 【优化】移除无法分发的警告，避免频繁输出
        // else if (taskQueue.length > 0) {
        //     console.warn(`[tryDispatch] 有任务但无法分发: taskQueue=${taskQueue.length}, allBusy=${consumers.every(c => c.busy)}`);
        // }
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
                    
                    // 【修复】发送进度更新，确保前端数字继续动
                    sendProgressUpdate(task.filePath);
                    
                    pending.reject(new Error(`文件处理超时（${timeout / 1000}秒）`));
                }
                
                // 【修复】更新 Consumer 状态
                consumer.busy = false;
                consumer.taskId = undefined;
                consumer.isTerminating = true; // 【新增】标记为主动终止
                
                // 终止并重新创建 Worker
                try {
                    consumer.worker.terminate();
                } catch (err) {
                    console.error('终止 Worker 失败:', err);
                }
                
                const index = consumers.indexOf(consumer);
                if (index > -1) {
                    // 【性能优化】移除高频日志
                    // console.log(`[超时处理] 正在创建新 Worker 替换 Consumer ${index}...`);
                    consumers.splice(index, 1);
                    createConsumer(index);
                    // console.log(`[超时处理] 新 Worker 已创建，当前 Consumers 数量: ${consumers.length}`);
                    // 【关键】立即尝试调度任务
                    setTimeout(() => {
                        // console.log(`[超时处理] 尝试调度任务，队列长度: ${taskQueue.length}, Consumers: ${consumers.length}`);
                        tryDispatch();
                    }, 50);
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
            
            // 【优化】使用统一的进度更新函数
            sendProgressUpdate(message.filePath);

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
            walkerCompleted = true; // 【新增】标记 Walker 已完成
            
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
    let walkerCompleted = false; // 【新增】标记 Walker 是否已完成
    
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

        // 【修复】只有在以下情况才结束扫描：
        // 1. Walker 已经完成（不再有新文件加入队列）
        // 2. 没有活跃的 Worker
        // 3. 任务队列为空
        // 4. 没有待处理的任务
        const hasPendingTasks = pendingTasks.size > 0;
        
        if (walkerCompleted && activeWorkerCount === 0 && taskQueue.length === 0 && !hasPendingTasks) {
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
            
            // 【双层保护策略】
            // 第一层：短时间停滞警告（30秒）
            const hasPendingTasks = pendingTasks.size > 0;
            if (idleTime > STAGNATION_THRESHOLD && 
                idleTime <= MAX_IDLE_TIME &&
                activeWorkerCount === 0 && 
                taskQueue.length === 0 &&
                !hasPendingTasks) {  // 【修复】必须没有待处理的任务
                log(`提示: ${STAGNATION_THRESHOLD / 1000}秒内无任何进展，但仍在等待可能的恢复...`);
            }
            
            // 第二层：长时间停滞强制结束（2分钟）
            if (idleTime > MAX_IDLE_TIME && 
                activeWorkerCount === 0 && 
                taskQueue.length === 0 &&
                !hasPendingTasks) {  // 【修复】必须没有待处理的任务
                log(`警告: ${MAX_IDLE_TIME / 1000}秒内无任何进展（已处理:${consumerProcessedCount}, 总数:${walkerTotalCount}, 跳过:${walkerSkippedCount}, 敏感文件:${resultCount}, 敏感信息:${totalSensitiveItems}），且系统空闲，强制结束`);
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

            // 【修复】终止 Walker Worker 并清除引用
            try {
                walkerWorker.removeAllListeners();
                walkerWorker.terminate();
                (walkerWorker as any) = null;
            } catch (error) {
                console.error('终止 Walker Worker 失败:', error);
            }

            // 【修复】终止所有 Consumer Workers 并清除引用
            for (const consumer of consumers) {
                try {
                    consumer.worker.terminate();
                    // 【关键】清除引用，帮助垃圾回收
                    consumer.worker.removeAllListeners();
                    (consumer as any).worker = null;
                } catch (error) {
                    console.error('终止 Consumer Worker 失败:', error);
                }
            }
            
            // 【关键】清空 consumers 数组，释放内存
            consumers.length = 0;

            // 清除所有超时定时器
            for (const pending of pendingTasks.values()) {
                clearTimeout(pending.timeoutId);
            }
            pendingTasks.clear();
            
            // 【关键】清空任务队列
            taskQueue.length = 0;

            scanState.isScanning = false;
            log('扫描完成');

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scan-finished');
            }
            
            console.log('[cleanup] 资源清理完成');
            
            // 【新增】强制触发垃圾回收（如果可用）
            if ((global as any).gc) {
                console.log('[cleanup] 触发垃圾回收...');
                (global as any).gc();
            }
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

        // 【修复】检查路径是否是文件，如果是文件且在 ignoreDirNames 中，则跳过
        try {
            const stat = fs.statSync(rootPath);
            if (stat.isFile()) {
                const basename = path.basename(rootPath);
                if (config.ignoreDirNames.includes(basename)) {
                    log(`跳过忽略的文件: ${rootPath}`);
                    continue;
                }
            }
        } catch (error: any) {
            log(`无法访问路径: ${rootPath} - ${error.message}`);
            continue;
        }

        log(`正在扫描: ${rootPath} (${currentPathIndex}/${totalPaths})`);

        if (!fs.existsSync(rootPath)) {
            log(`路径不存在: ${rootPath}`);
            continue;
        }

        // 【修复】支持文件和目录，walker-worker 会自行判断
        // if (!fs.statSync(rootPath).isDirectory()) {
        //     log(`路径不是目录: ${rootPath}`);
        //     continue;
        // }

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

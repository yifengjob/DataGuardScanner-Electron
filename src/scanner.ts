import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {BrowserWindow} from 'electron';
import {Worker} from 'worker_threads';
import {ScanConfig, ScanResultItem} from './types';
import {ScanState} from './scan-state';
import {addAllowedPath, clearAllowedPaths} from './file-operations';
import {calculateActualConcurrency} from './config-manager';
// 【优化】导入扫描配置常量
import {
    WORKER_MAX_OLD_GENERATION_MB,
    WORKER_MAX_YOUNG_GENERATION_MB,
    STAGNATION_CHECK_INTERVAL,
    STAGNATION_THRESHOLD,
    MAX_IDLE_TIME,
    PROGRESS_THROTTLE_INTERVAL,
    WORKER_RESTART_DELAY,
    BYTES_TO_MB  // 【A1 优化】用于计算平均文件大小
} from './scan-config';
// 【新增】导入辅助函数
import {
    createLogger,
    createProgressUpdater,
    markConsumerIdle,
    sendToMainWindow,
    calculateTimeout as calcTimeout,
    safelyTerminateWorker,
    LogLevel  // 【新增】日志级别
} from './scanner-helpers';

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

    // 【重构】使用辅助函数创建 logger
    const log = createLogger(scanState, mainWindow);

    log.info('开始扫描...');
    log.info(`扫描路径数: ${config.selectedPaths.length}`);
    log.info(`文件类型数: ${config.selectedExtensions.length}`);
    log.info(`选中的扩展名: ${config.selectedExtensions.join(', ')}`);
    log.info(`敏感检测类型: ${config.enabledSensitiveTypes.join(', ')}`);
    log.info('---');

    // 计算并发数
    const concurrencyInfo = calculateActualConcurrency(config.scanConcurrency);
    const poolSize = concurrencyInfo.actualConcurrency;

    if (config.scanConcurrency && config.scanConcurrency > concurrencyInfo.maxAllowedConcurrency) {
        log.warn(`配置的并发数 ${config.scanConcurrency} 超过最大值 ${concurrencyInfo.maxAllowedConcurrency}，已自动调整`);
        log.info(`系统可用内存 ${concurrencyInfo.freeMemoryGB.toFixed(1)} GB, CPU ${concurrencyInfo.cpuCount} 核, 建议不超过 ${concurrencyInfo.maxAllowedConcurrency}`);
    }

    log.info(`使用 ${poolSize} 个 Consumer Workers (CPU: ${concurrencyInfo.cpuCount}核, 可用内存: ${concurrencyInfo.freeMemoryGB.toFixed(1)}GB)`);

    // 统计信息
    let walkerTotalCount = 0;      // Walker 找到的文件总数
    let walkerSkippedCount = 0;    // Walker 跳过的文件数
    let consumerProcessedCount = 0; // Consumer 已处理的文件数
    let resultCount = 0;            // 发现的敏感文件数
    let totalSensitiveItems = 0;    // 【新增】发现的敏感信息总条数
    let activeWorkerCount = 0;      // 【优化】跟踪活跃的 Worker 数量
    const countedTaskIds = new Set<number>(); // 【修复】防止重复计数

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

    // 【事件驱动】跟踪最后活动时间（必须在前面声明）
    let lastActivityTime = Date.now();

    // 【重构】使用辅助函数创建进度更新器
    const sendProgressUpdate = createProgressUpdater(
        mainWindow,
        () => consumerProcessedCount,
        () => walkerTotalCount,
        () => walkerSkippedCount,
        PROGRESS_THROTTLE_INTERVAL
    );

    // 【重构】防止重复计数的辅助方法
    function incrementConsumerCount(taskId: number): void {
        if (!countedTaskIds.has(taskId)) {
            countedTaskIds.add(taskId);
            consumerProcessedCount++;
        }
    }

    // 【A1 优化】根据系统可用内存和文件大小动态计算每个 Worker 的内存限制
    const freeMemoryMB = os.freemem() / BYTES_TO_MB;

    // 【新增】等待 taskQueue 填充后计算平均文件大小
    // 这里先使用默认值，在 Walker 完成后会重新调整
    // 【修复】降低初始值为 60%，预留 40% 给 V8 内部开销和内存碎片
    let dynamicOldGenMB = Math.floor(WORKER_MAX_OLD_GENERATION_MB * 0.6);  // 768 * 0.6 = 460MB
    let dynamicYoungGenMB = Math.floor(WORKER_MAX_YOUNG_GENERATION_MB * 0.6); // 96 * 0.6 = 57MB

    // 【新增】计算智能内存配置的函数
    function calculateSmartMemoryLimits(avgFileSizeMB: number, workerCount: number): {
        oldGen: number;
        youngGen: number
    } {
        // 根据平均文件大小调整内存分配策略
        let memoryMultiplier = 1.0;

        if (avgFileSizeMB > 50) {
            // 超大文件：增加内存限制，减少并发压力
            memoryMultiplier = 1.5;
            log.info(`【智能内存】检测到大文件（平均 ${avgFileSizeMB.toFixed(1)}MB），增加 Worker 内存至 ${memoryMultiplier}x`);
        } else if (avgFileSizeMB > 10) {
            // 大文件：适度增加内存
            memoryMultiplier = 1.2;
            log.info(`【智能内存】检测到中大文件（平均 ${avgFileSizeMB.toFixed(1)}MB），适度增加 Worker 内存`);
        } else if (avgFileSizeMB < 1) {
            // 小文件：降低内存限制，提高并发效率
            memoryMultiplier = 0.6;
            log.info(`【智能内存】检测到小文件（平均 ${avgFileSizeMB.toFixed(2)}MB），降低 Worker 内存以节省资源`);
        }

        // 基础内存计算：取系统可用内存的 60% / Worker 数量
        const systemBasedLimit = Math.floor(freeMemoryMB * 0.6 / workerCount);

        // 配置限制的内存
        const configBasedLimit = Math.floor(
            (WORKER_MAX_OLD_GENERATION_MB + WORKER_MAX_YOUNG_GENERATION_MB) * memoryMultiplier
        );

        // 取两者中的较小值，确保不超过系统承受能力
        const baseMemoryPerWorker = Math.min(systemBasedLimit, configBasedLimit);

        // 设置最低和最高限制
        const minMemoryPerWorker = 200; // 【修复】最少 512MB（原200MB，防止 PDF/DOCX 解析超时）
        const maxMemoryPerWorker = Math.floor(freeMemoryMB * 0.8 / workerCount); // 最多使用 80% 可用内存

        const finalMemoryPerWorker = Math.max(
            minMemoryPerWorker,
            Math.min(baseMemoryPerWorker, maxMemoryPerWorker)
        );

        return {
            oldGen: Math.floor(finalMemoryPerWorker * 0.8),
            youngGen: Math.floor(finalMemoryPerWorker * 0.2)
        };
    }

    // 初始日志
    log.info(`【内存优化】可用内存: ${freeMemoryMB.toFixed(0)}MB, 初始每 Worker 限制: ${dynamicOldGenMB + dynamicYoungGenMB}MB`);

    // 创建 Consumer Worker
    function createConsumer(id: number, customOldGen?: number, customYoungGen?: number) {
        const workerPath = path.join(__dirname, 'file-worker.js');

        // 使用自定义内存限制或默认值
        const oldGenLimit = customOldGen || dynamicOldGenMB;
        const youngGenLimit = customYoungGen || dynamicYoungGenMB;

        let worker: Worker;
        try {
            worker = new Worker(workerPath, {
                resourceLimits: {
                    maxOldGenerationSizeMb: oldGenLimit,
                    maxYoungGenerationSizeMb: youngGenLimit,
                }
            });
        } catch (error: any) {
            log.error(`无法创建 Worker ${id} - ${error.message}`);
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
                // 【重构】使用辅助函数标记 Consumer 为空闲
                markConsumerIdle(consumer);
                activeWorkerCount--;
                incrementConsumerCount(taskId);

                tryDispatch();
                return;
            }

            // 清除超时定时器
            clearTimeout(pending.timeoutId);
            pendingTasks.delete(taskId);

            // 【重构】使用辅助函数标记 Worker 为空闲
            markConsumerIdle(consumer);
            activeWorkerCount--;
            incrementConsumerCount(taskId);

            // 【事件驱动】更新最后活动时间
            lastActivityTime = Date.now();

            // 【优化】使用统一的进度更新函数
            sendProgressUpdate(result.filePath || '');

            // 处理结果
            if (result.error) {
                log.info(`处理文件失败: ${result.error}`);
                pending.reject(new Error(result.error));
            } else {
                if (result.total && result.total > 0) {
                    resultCount++;
                    totalSensitiveItems += result.total; // 【新增】累加敏感信息总条数
                    log.info(`发现敏感文件 [${resultCount}]: ${result.filePath} (总计: ${result.total} 个敏感项)`);

                    const resultItem: ScanResultItem = {
                        filePath: result.filePath,
                        fileSize: result.fileSize || 0,
                        modifiedTime: result.modifiedTime || new Date().toISOString(),
                        counts: result.counts || {},
                        total: result.total,
                        unsupportedPreview: false
                    };

                    // 【重构】使用辅助函数发送扫描结果
                    sendToMainWindow(mainWindow, 'scan-result', resultItem);
                }
                pending.resolve(result);
            }

            // 调度下一个任务
            tryDispatch();

            // 【事件驱动】检查是否应该结束
            checkAndComplete();
        });

        worker.on('error', (error: any) => {
            log.error(`[Consumer ${id}] Worker 错误: ${error.message}`);

            // 【修复】只有当 consumer 处于 busy 状态时才减少计数
            if (consumer.busy) {
                consumer.busy = false;
                activeWorkerCount--;

                if (consumer.taskId !== undefined) {
                    const pending = pendingTasks.get(consumer.taskId);
                    if (pending) {
                        clearTimeout(pending.timeoutId);
                        pendingTasks.delete(consumer.taskId);
                        incrementConsumerCount(consumer.taskId);
                        pending.reject(error);
                    }
                }
            }
        });

        worker.on('exit', (code: number, signal: string | null) => {
            // 【修复】区分主动终止和异常退出
            const consumerRef = consumer as typeof consumers[0];

            // 【新增】记录详细的退出信息
            if (signal) {
                log.warn(`[Consumer ${id}] Worker 被信号终止: ${signal}, 代码: ${code}`);
            }

            if (consumerRef.isTerminating) {
                // 主动终止（超时等情况），不视为异常
                log.info(`[Consumer ${id}] Worker 已终止（代码: ${code}）`);
                consumerRef.isTerminating = false;
                consumerRef.busy = false;
                return;
            }

            if (code !== 0 && !scanState.cancelFlag) {
                log.error(`[Consumer ${id}] Worker 异常退出，代码: ${code}, 信号: ${signal || 'none'}`);

                // 【新增】检测是否是 OOM 导致的退出
                const isOOM = signal === 'SIGABRT' || code === 134; // 134 是 abort() 的退出码
                if (isOOM) {
                    log.error(`[Consumer ${id}] ⚠️ 检测到 Worker OOM！将重启 Worker 并跳过当前文件`);
                }

                // 【修复】只有当 consumer 处于 busy 状态时才更新计数
                if (consumerRef.busy && consumerRef.taskId !== undefined) {
                    consumerRef.busy = false;
                    activeWorkerCount--;

                    const pending = pendingTasks.get(consumerRef.taskId);
                    if (pending) {
                        clearTimeout(pending.timeoutId);
                        pendingTasks.delete(consumerRef.taskId);
                        incrementConsumerCount(consumerRef.taskId);

                        // 【新增】返回友好的 OOM 错误信息
                        const errorMsg = isOOM
                            ? '内存不足，文件可能过大或格式异常，已跳过'
                            : `Worker 异常退出（代码: ${code}）`;
                        pending.reject(new Error(errorMsg));
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
                            log.info(`[Consumer ${id}] 正在重启 Worker...`);
                            consumers.splice(index, 1);
                            createConsumer(id);

                            // 【新增】Worker 重启后强制 GC，释放内存
                            if ((global as any).gc) {
                                log.info(`[Consumer ${id}] 执行强制垃圾回收...`);
                                (global as any).gc();
                            }
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

    // 【重构】使用智能超时计算函数
    const calculateTimeout = (fileSize: number) => calcTimeout(fileSize);

    // 【关键修复】轮询索引，实现 Round-Robin 调度
    let nextConsumerIndex = 0;

    // 尝试调度任务
    function tryDispatch() {
        let dispatched = 0;

        // 【关键修复】使用轮询调度，从上次结束的位置开始查找
        const startIndex = nextConsumerIndex;
        const totalConsumers = consumers.length;

        for (let i = 0; i < totalConsumers; i++) {
            // 计算当前要检查的 Consumer 索引（循环）
            const currentIndex = (startIndex + i) % totalConsumers;
            const consumer = consumers[currentIndex];

            if (!consumer.busy && taskQueue.length > 0) {
                // 处理 Promise rejection，避免未捕获的错误
                const promise = dispatchNextTask(consumer);
                if (promise) {
                    dispatched++;
                    // 【关键修复】更新轮询索引到下一个位置
                    nextConsumerIndex = (currentIndex + 1) % totalConsumers;
                    promise.catch((error) => {
                        log.info(`[TaskQueue] 任务分发失败: ${error.message}`);
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
                log.warn(`[TaskQueue] 任务 ${taskId} 超时 (${timeout / 1000}秒): ${task.filePath}`);
                const pending = pendingTasks.get(taskId);
                if (pending) {
                    pendingTasks.delete(taskId);
                    activeWorkerCount--; // 【优化】减少活跃计数
                    incrementConsumerCount(taskId);

                    // 【修复】发送进度更新，确保前端数字继续动
                    sendProgressUpdate(task.filePath);

                    pending.reject(new Error(`文件处理超时（${timeout / 1000}秒）`));
                }

                // 【修复】更新 Consumer 状态
                markConsumerIdle(consumer);
                consumer.isTerminating = true; // 【新增】标记为主动终止

                // 【重构】使用辅助函数安全终止 Worker
                safelyTerminateWorker(consumer.worker, consumer, log);

                const index = consumers.indexOf(consumer);
                if (index > -1) {
                    // 【性能优化】移除高频日志
                    // console.log(`[超时处理] 正在创建新 Worker 替换 Consumer ${index}...`);
                    consumers.splice(index, 1);
                    createConsumer(index);
                    // console.log(`[超时处理] 新 Worker 已创建，当前 Consumers 数量: ${consumers.length}`);

                    // 【新增】Worker 重启后强制 GC，释放内存
                    if ((global as any).gc) {
                        log.info(`[超时处理] 执行强制垃圾回收...`);
                        (global as any).gc();
                    }
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
                    enabledSensitiveTypes: config.enabledSensitiveTypes,
                    config: {
                        enabledSensitiveTypes: config.enabledSensitiveTypes,
                        maxFileSizeMb: config.maxFileSizeMb,  // 【修复】传递用户配置
                        maxPdfSizeMb: config.maxPdfSizeMb      // 【修复】传递用户配置
                    }
                });
            } catch (error: any) {
                log.error(`[TaskQueue] 发送任务失败: ${error.message}`);
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
        // 【修复】给 Walker Worker 也设置内存限制，防止 OOM
        walkerWorker = new Worker(walkerWorkerPath, {
            resourceLimits: {
                maxOldGenerationSizeMb: dynamicOldGenMB,
                maxYoungGenerationSizeMb: dynamicYoungGenMB,
            }
        });
    } catch (error: any) {
        log.error(`错误: 无法创建 Walker Worker - ${error.message}`);
        scanState.isScanning = false;
        // 【重构】使用辅助函数发送错误信息
        sendToMainWindow(mainWindow, 'scan-error', `无法创建 Walker Worker: ${error.message}`);
        return; // 直接退出
    }

    walkerWorker.on('message', (message: any) => {
        if (message.type === 'ready') {
            return;
        }

        if (message.type === 'file-found') {
            walkerTotalCount++;

            // 【调试】检测异常计数
            if (walkerTotalCount % 100 === 0) {
                log.info(`[进度] walkerTotalCount=${walkerTotalCount}, consumerProcessedCount=${consumerProcessedCount}, taskQueue=${taskQueue.length}, pendingTasks=${pendingTasks.size}, activeWorkers=${activeWorkerCount}`);
            }

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
            log.info(`Walker 完成: 找到 ${message.fileCount} 个文件, 跳过 ${message.skippedCount} 个`);
            walkerSkippedCount += message.skippedCount;
            walkerCompletedCount++; // 【修复】增加完成计数

            // 【内存安全】防止计数器溢出
            if (walkerCompletedCount > totalWalkerTasks) {
                log.warn(`[Walker] 警告: 完成计数 (${walkerCompletedCount}) 超过总任务数 (${totalWalkerTasks})`);
                walkerCompletedCount = totalWalkerTasks;
            }

            log.info(`[Walker] 已完成 ${walkerCompletedCount}/${totalWalkerTasks} 个任务`);

            // 【A1 优化】Walker 完成后，根据实际文件大小重新计算内存限制
            if (taskQueue.length > 0) {
                const totalSize = taskQueue.reduce((sum, task) => sum + task.fileSize, 0);
                const avgFileSizeMB = (totalSize / taskQueue.length) / BYTES_TO_MB;

                // 计算新的内存限制
                const newLimits = calculateSmartMemoryLimits(avgFileSizeMB, poolSize);
                dynamicOldGenMB = newLimits.oldGen;
                dynamicYoungGenMB = newLimits.youngGen;

                log.info(`【智能内存调整】平均文件大小: ${avgFileSizeMB.toFixed(2)}MB, 新内存限制: 老生代=${dynamicOldGenMB}MB, 新生代=${dynamicYoungGenMB}MB`);

                // 【关键】重启所有空闲的 Consumer Workers 以应用新配置
                // 【修复】延迟 100ms 确保所有 Worker 的状态已同步
                setTimeout(() => {
                    let restartedCount = 0;
                    for (let i = 0; i < consumers.length; i++) {
                        const consumer = consumers[i];
                        if (!consumer.busy) {
                            // 终止旧的 Worker
                            try {
                                consumer.worker.terminate();
                                consumer.worker.removeAllListeners();
                            } catch (e) {
                                // 忽略终止错误
                            }

                            // 创建新的 Worker（使用新内存限制）
                            createConsumer(i, dynamicOldGenMB, dynamicYoungGenMB);
                            restartedCount++;
                        }
                    }

                    if (restartedCount > 0) {
                        log.info(`【智能内存】已重启 ${restartedCount} 个空闲 Worker 以应用新内存配置`);

                        // 【新增】批量重启后强制 GC，释放内存
                        if ((global as any).gc) {
                            log.info(`【智能内存】执行强制垃圾回收...`);
                            (global as any).gc();
                        }
                    }
                }, 100);
            }

            // 【事件驱动】检查是否应该结束
            checkAndComplete();
        }

        if (message.type === 'walking-error') {
            log.error(`Walker 错误: ${message.error}`);

            // 【事件驱动】检查是否应该结束
            checkAndComplete();
        }

        // 【调试】接收 Walker Worker 的日志
        if (message.type === 'walker-log') {
            log.info(message.message);
        }
    });

    walkerWorker.on('error', (error: any) => {
        log.error(`Walker Worker 错误: ${error.message}`);

        // 【事件驱动】检查是否应该结束
        checkAndComplete();
    });

    walkerWorker.on('exit', (code) => {
        if (code !== 0) {
            log.info(`Walker Worker 异常退出，代码: ${code}`);
        }
    });

    // 【事件驱动】检查是否应该结束扫描
    let completionCheckTimer: NodeJS.Timeout | null = null;
    let isCleaningUp = false; // 【修复】防止 cleanup 被多次调用
    let walkerCompletedCount = 0; // 【修复】记录已完成的 Walker 任务数
    const totalWalkerTasks = config.selectedPaths.length; // 【修复】总 Walker 任务数

    // 【优化】多指标停滞检测 - 记录上次检查时的状态快照
    let lastStagnationCheckState = {
        processed: consumerProcessedCount,
        total: walkerTotalCount,
        skipped: walkerSkippedCount,
        results: resultCount,
        sensitiveItems: totalSensitiveItems,  // 【新增】敏感信息总条数
        taskQueueLength: taskQueue.length,     // 【新增】任务队列长度
        pendingTasksSize: pendingTasks.size,   // 【新增】待处理任务数
        activeWorkers: activeWorkerCount       // 【新增】活跃 Worker 数
    };
    let lastStagnationCheckTime = Date.now();

    function checkAndComplete() {
        // 检查是否取消
        if (scanState.cancelFlag) {
            cleanup();
            return;
        }

        // 【修复】只有在以下情况才结束扫描：
        // 1. 所有 Walker 任务都已完成
        // 2. 没有活跃的 Worker
        // 3. 任务队列为空
        // 4. 没有待处理的任务
        const hasPendingTasks = pendingTasks.size > 0;
        const allWalkersCompleted = walkerCompletedCount >= totalWalkerTasks;

        // 【调试】输出详细状态
        if (allWalkersCompleted && (activeWorkerCount > 0 || taskQueue.length > 0 || hasPendingTasks)) {
            log.info(`[checkAndComplete] Walker已完成，但仍在等待: activeWorkers=${activeWorkerCount}, taskQueue=${taskQueue.length}, pendingTasks=${pendingTasks.size}`);
        }

        if (allWalkersCompleted && activeWorkerCount === 0 && taskQueue.length === 0 && !hasPendingTasks) {
            log.info(`扫描完成: 遍历 ${walkerTotalCount} 个文件, 处理 ${consumerProcessedCount} 个, 跳过 ${walkerSkippedCount} 个, 发现 ${resultCount} 个敏感文件`);
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
            totalSensitiveItems !== lastStagnationCheckState.sensitiveItems ||  // 敏感信息条数变化
            taskQueue.length !== lastStagnationCheckState.taskQueueLength ||    // 任务队列变化
            pendingTasks.size !== lastStagnationCheckState.pendingTasksSize ||  // 待处理任务变化
            activeWorkerCount !== lastStagnationCheckState.activeWorkers;       // 活跃 Worker 变化

        if (hasRealProgress) {
            // 有进展，更新状态快照和时间
            lastStagnationCheckState = {
                processed: consumerProcessedCount,
                total: walkerTotalCount,
                skipped: walkerSkippedCount,
                results: resultCount,
                sensitiveItems: totalSensitiveItems,
                taskQueueLength: taskQueue.length,
                pendingTasksSize: pendingTasks.size,
                activeWorkers: activeWorkerCount
            };
            lastStagnationCheckTime = now;
        } else {
            // 无进展，检查是否应该超时
            const idleTime = now - lastStagnationCheckTime;

            // 【双层保护策略】
            // 第一层：短时间停滞警告（30秒）
            if (idleTime > STAGNATION_THRESHOLD &&
                idleTime <= MAX_IDLE_TIME) {
                log.warn(`提示: ${STAGNATION_THRESHOLD / 1000}秒内无任何进展（活跃Worker:${activeWorkerCount}, 队列:${taskQueue.length}, 待处理:${pendingTasks.size}），但仍在等待可能的恢复...`);
            }

            // 第二层：长时间停滞强制结束（2分钟）
            if (idleTime > MAX_IDLE_TIME) {
                log.error(`警告: ${MAX_IDLE_TIME / 1000}秒内无任何进展（已处理:${consumerProcessedCount}, 总数:${walkerTotalCount}, 跳过:${walkerSkippedCount}, 敏感文件:${resultCount}, 敏感信息:${totalSensitiveItems}, 活跃Worker:${activeWorkerCount}, 队列:${taskQueue.length}, 待处理:${pendingTasks.size}），强制结束`);
                // 先清理所有 pendingTasks
                for (const [_taskId, pending] of pendingTasks.entries()) {
                    clearTimeout(pending.timeoutId);
                    pending.reject(new Error('扫描超时强制结束'));
                }
                pendingTasks.clear();
                cleanup();
            }
        }
    }, STAGNATION_CHECK_INTERVAL); // 定期检查

    // 清理资源
    function cleanup() {
        // 【修复】防止重复调用 - 使用原子检查
        if (isCleaningUp) {
            log.info('[cleanup] 警告: cleanup 已被调用，忽略重复调用');
            return;
        }
        isCleaningUp = true;

        log.info('[cleanup] 开始清理资源...');

        try {
            // 【事件驱动】清除超时检测定时器
            if (completionCheckTimer) {
                clearInterval(completionCheckTimer);
                completionCheckTimer = null;
            }

            // 【修复】终止 Walker Worker 并清除引用
            try {
                // 【内存安全】先发送清空队列的信号
                walkerWorker.postMessage({type: 'cancel-all'});
                walkerWorker.removeAllListeners();
                walkerWorker.terminate();
                (walkerWorker as any) = null;
            } catch (error) {
                log.info(`终止 Walker Worker 失败: ${error}`);
            }

            // 【修复】终止所有 Consumer Workers 并清除引用
            for (const consumer of consumers) {
                try {
                    consumer.worker.terminate();
                    // 【关键】清除引用，帮助垃圾回收
                    consumer.worker.removeAllListeners();
                    (consumer as any).worker = null;
                } catch (error) {
                    log.info(`终止 Consumer Worker 失败: ${error}`);
                }
            }

            // 【关键】清空 consumers 数组，释放内存
            consumers.length = 0;

            // 清除所有超时定时器（如果还没有被清理）
            if (pendingTasks.size > 0) {
                for (const pending of pendingTasks.values()) {
                    clearTimeout(pending.timeoutId);
                }
                pendingTasks.clear();
            }

            // 【关键】清空任务队列
            taskQueue.length = 0;

            scanState.isScanning = false;
            log.info('扫描完成');

            // 【重构】使用辅助函数发送扫描完成信号
            sendToMainWindow(mainWindow, 'scan-finished', null);

            log.info('[cleanup] 资源清理完成');

            // 【新增】强制触发垃圾回收（如果可用）
            if ((global as any).gc) {
                log.info('[cleanup] 触发垃圾回收...');
                (global as any).gc();
            }
        } catch (error) {
            log('[cleanup] 清理过程中出错: ' + error);
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
            log.info('扫描已取消');
            break;
        }

        // 【修复】检查路径是否是文件，如果是文件且在 ignoreDirNames 中，则跳过
        try {
            const stat = fs.statSync(rootPath);
            if (stat.isFile()) {
                const basename = path.basename(rootPath);
                if (config.ignoreDirNames.includes(basename)) {
                    log.info(`跳过忽略的文件: ${rootPath}`);
                    continue;
                }
            }
        } catch (error: any) {
            log.info(`无法访问路径: ${rootPath} - ${error.message}`);
            continue;
        }

        log.info(`正在扫描: ${rootPath} (${currentPathIndex}/${totalPaths})`);

        if (!fs.existsSync(rootPath)) {
            log.info(`路径不存在: ${rootPath}`);
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

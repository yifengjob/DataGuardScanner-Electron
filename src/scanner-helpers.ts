/**
 * Scanner 辅助函数模块
 * 用于简化 scanner.ts 中的复杂逻辑，提高代码可读性和可维护性
 */

import {BrowserWindow} from 'electron';
import {ScanState} from './scan-state';
import {BYTES_TO_MB, MAX_LOG_ENTRIES, WORKER_BASE_TIMEOUT, WORKER_TIMEOUT_PER_MB, WORKER_MAX_TIMEOUT} from './scan-config';

/**
 * 创建日志函数
 * @param scanState 扫描状态
 * @param mainWindow 主窗口
 * @returns 日志记录函数
 */
export function createLogger(
    scanState: ScanState,
    mainWindow: BrowserWindow | null
): (msg: string) => void {
    // 【B1 优化】使用环形缓冲区替代数组 shift()
    const logs = new Array<string>(MAX_LOG_ENTRIES);
    let logIndex = 0;
    let logCount = 0;
    
    // 【性能优化】缓存转换后的数组，避免每次日志都重新创建
    let cachedLogsArray: string[] = [];
    let needsUpdate = false;

    return (msg: string) => {
        const now = new Date();
        // 【修复】显式指定 Asia/Shanghai 时区，确保显示北京时间
        const timeStr = now.toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZone: 'Asia/Shanghai'  // 强制使用北京时间
        });
        const logWithTime = `[${timeStr}] ${msg}`;

        // 【修复】限制日志数组大小，防止内存泄漏
        setImmediate(() => {
            // 【B1 优化】环形缓冲区：O(1) 时间复杂度
            logs[logIndex % MAX_LOG_ENTRIES] = logWithTime;
            logIndex++;
            logCount = Math.min(logCount + 1, MAX_LOG_ENTRIES);
            
            // 【性能优化】标记需要更新，但不立即转换
            needsUpdate = true;
        });
        
        // 【性能优化】延迟批量转换，减少数组创建次数
        setImmediate(() => {
            if (needsUpdate) {
                // 将环形缓冲区转换为普通数组（供前端显示）
                if (logCount < MAX_LOG_ENTRIES) {
                    // 未满时，直接截取
                    cachedLogsArray = logs.slice(0, logCount);
                } else {
                    // 已满时，从当前位置开始循环读取
                    const start = logIndex % MAX_LOG_ENTRIES;
                    cachedLogsArray = [
                        ...logs.slice(start),
                        ...logs.slice(0, start)
                    ];
                }
                
                // 更新到 scanState
                scanState.logs = cachedLogsArray;
                needsUpdate = false;
            }
        });

        // 【优化】异步发送日志到前端，避免阻塞主线程
        setImmediate(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scan-log', logWithTime);
            }
        });
    };
}

/**
 * 创建进度更新函数（带自适应节流）
 * @param mainWindow 主窗口
 * @param getConsumerProcessedCount 获取已处理文件数的回调
 * @param getWalkerTotalCount 获取总文件数的回调
 * @param getWalkerSkippedCount 获取跳过文件数的回调
 * @param baseThrottleInterval 基础节流间隔（毫秒）
 * @returns 进度更新函数
 */
export function createProgressUpdater(
    mainWindow: BrowserWindow | null,
    getConsumerProcessedCount: () => number,
    getWalkerTotalCount: () => number,
    getWalkerSkippedCount: () => number,
    baseThrottleInterval: number = 500
): (currentFile?: string) => void {
    let lastProgressTime = 0;
    let lastScannedCount = 0;
    
    // 【B3 优化】自适应节流参数
    const MIN_THROTTLE = 200;   // 最小间隔 200ms（快速更新）
    const MAX_THROTTLE = 1000;  // 最大间隔 1000ms（慢速更新）
    const FAST_THRESHOLD = 50;  // 每秒处理 > 50 个文件视为快速
    const SLOW_THRESHOLD = 10;  // 每秒处理 < 10 个文件视为慢速

    return (currentFile: string = '') => {
        const now = Date.now();
        
        // 【B3 优化】计算当前扫描速度（文件/秒）
        const timeDiff = (now - lastProgressTime) / 1000; // 转换为秒
        const countDiff = getConsumerProcessedCount() - lastScannedCount;
        const speed = timeDiff > 0 ? countDiff / timeDiff : 0;
        
        // 【B3 优化】根据速度动态调整节流间隔
        let adaptiveInterval = baseThrottleInterval;
        if (speed > FAST_THRESHOLD) {
            // 快速扫描：减少更新频率，降低 UI 压力
            adaptiveInterval = Math.min(MAX_THROTTLE, baseThrottleInterval * 1.5);
        } else if (speed < SLOW_THRESHOLD && speed > 0) {
            // 慢速扫描：增加更新频率，提升用户体验
            adaptiveInterval = Math.max(MIN_THROTTLE, baseThrottleInterval * 0.7);
        }
        
        if (!lastProgressTime || now - lastProgressTime >= adaptiveInterval) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scan-progress', {
                    currentFile,
                    scannedCount: getConsumerProcessedCount(),
                    totalCount: getWalkerTotalCount(),
                    skippedCount: getWalkerSkippedCount()
                });
            }
            lastProgressTime = now;
            lastScannedCount = getConsumerProcessedCount();
        }
    };
}

/**
 * 清理待处理任务
 * @param pendingTasks 待处理任务映射
 * @param taskId
 * @param onCleanup 清理回调
 */
export function cleanupPendingTask(
    pendingTasks: Map<number, any>,
    taskId: number,
    onCleanup?: (taskId: number) => void
): void {
    const pending = pendingTasks.get(taskId);
    if (pending) {
        clearTimeout(pending.timeoutId);
        pendingTasks.delete(taskId);
        if (onCleanup) {
            onCleanup(taskId);
        }
    }
}

/**
 * 标记 Consumer 为空闲状态
 * @param consumer Consumer 对象
 */
export function markConsumerIdle(consumer: any): void {
    consumer.busy = false;
    consumer.taskId = undefined;
}

/**
 * 检查窗口是否可用并发送消息
 * @param mainWindow 主窗口
 * @param channel IPC 通道
 * @param data 发送的数据
 * @returns 是否成功发送
 */
export function sendToMainWindow(
    mainWindow: BrowserWindow | null,
    channel: string,
    data: any
): boolean {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
        return true;
    }
    return false;
}

/**
 * 【重构】根据文件大小智能计算超时时间
 * @param fileSize 文件大小（字节）
 * @returns 超时时间（毫秒）
 */
export function calculateTimeout(fileSize: number): number {
    const sizeMB = fileSize / BYTES_TO_MB;
    
    // 基础超时 + 按大小增长的超时
    let timeoutMs = WORKER_BASE_TIMEOUT + (sizeMB * WORKER_TIMEOUT_PER_MB);
    
    // 限制在最大超时范围内
    timeoutMs = Math.min(timeoutMs, WORKER_MAX_TIMEOUT);
    
    // 确保至少为基础超时
    timeoutMs = Math.max(timeoutMs, WORKER_BASE_TIMEOUT);
    
    return Math.floor(timeoutMs);
}

/**
 * 安全地终止 Worker
 * @param worker Worker 对象
 * @param consumer Consumer 对象
 * @param log 日志函数
 */
export function safelyTerminateWorker(
    worker: any,
    consumer: any,
    log: (msg: string) => void
): void {
    try {
        consumer.isTerminating = true;
        worker.terminate();
    } catch (error: any) {
        log(`终止 Worker 失败: ${error.message}`);
    }
}

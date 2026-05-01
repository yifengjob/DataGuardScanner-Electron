/**
 * Scanner 辅助函数模块
 * 用于简化 scanner.ts 中的复杂逻辑，提高代码可读性和可维护性
 */

import {BrowserWindow} from 'electron';
import {ScanState} from './scan-state';
import {BYTES_TO_MB, MAX_LOG_ENTRIES} from './scan-config';

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

    return (msg: string) => {
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
            // 【B1 优化】环形缓冲区：O(1) 时间复杂度
            logs[logIndex % MAX_LOG_ENTRIES] = logWithTime;
            logIndex++;
            logCount = Math.min(logCount + 1, MAX_LOG_ENTRIES);
            
            // 将环形缓冲区转换为普通数组（供前端显示）
            if (logCount < MAX_LOG_ENTRIES) {
                // 未满时，直接截取
                scanState.logs = logs.slice(0, logCount);
            } else {
                // 已满时，从当前位置开始循环读取
                const start = logIndex % MAX_LOG_ENTRIES;
                scanState.logs = [
                    ...logs.slice(start),
                    ...logs.slice(0, start)
                ];
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
 * 创建进度更新函数（带节流）
 * @param mainWindow 主窗口
 * @param getConsumerProcessedCount 获取已处理文件数的回调
 * @param getWalkerTotalCount 获取总文件数的回调
 * @param getWalkerSkippedCount 获取跳过文件数的回调
 * @param throttleInterval 节流间隔（毫秒）
 * @returns 进度更新函数
 */
export function createProgressUpdater(
    mainWindow: BrowserWindow | null,
    getConsumerProcessedCount: () => number,
    getWalkerTotalCount: () => number,
    getWalkerSkippedCount: () => number,
    throttleInterval: number = 500
): (currentFile?: string) => void {
    let lastProgressTime = 0;

    return (currentFile: string = '') => {
        const now = Date.now();
        if (!lastProgressTime || now - lastProgressTime >= throttleInterval) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('scan-progress', {
                    currentFile,
                    scannedCount: getConsumerProcessedCount(),
                    totalCount: getWalkerTotalCount(),
                    skippedCount: getWalkerSkippedCount()
                });
            }
            lastProgressTime = now;
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
 * 根据文件大小计算超时时间
 * @param fileSize 文件大小（字节）
 * @param timeouts 超时配置
 * @returns 超时时间（毫秒）
 */
export function calculateTimeout(
    fileSize: number,
    timeouts: {
        small: number;
        medium: number;
        large: number;
        huge: number;
    }
): number {
    const sizeMB = fileSize / (BYTES_TO_MB);

    if (sizeMB < 1) {
        return timeouts.small;
    } else if (sizeMB < 10) {
        return timeouts.medium;
    } else if (sizeMB < 50) {
        return timeouts.large;
    } else {
        return timeouts.huge;
    }
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

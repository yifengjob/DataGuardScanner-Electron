import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {BrowserWindow} from 'electron';
import walkdir = require('walkdir');
import {ScanConfig, ScanResultItem} from './types';
import {ScanState} from './scan-state';
import {WorkerPool} from './worker-pool';
import {addAllowedPath, clearAllowedPaths} from './file-operations';
import {SUPPORTED_EXTENSIONS} from './file-parser'; // 【新增】导入支持的文件类型

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
        // 【新增】添加时间戳
        const now = new Date();
        const timeStr = now.toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const logWithTime = `[${timeStr}] ${msg}`;

        scanState.logs.push(logWithTime);
        mainWindow.webContents.send('scan-log', logWithTime);
    };

    log('开始扫描...');
    log(`扫描路径数: ${config.selectedPaths.length}`);
    log(`文件类型数: ${config.selectedExtensions.length}`);
    log(`选中的扩展名: ${config.selectedExtensions.join(', ')}`);
    log(`敏感检测类型: ${config.enabledSensitiveTypes.join(', ')}`);
    log('---');

    let scannedCount = 0;
    let processedCount = 0;
    let resultCount = 0;
    let skippedCount = 0;  // ← 新增：跳过的文件数
    let totalCount = 0;     // ← 新增：遍历的文件总数

    // 创建 Worker 池（根据 CPU 核心数和可用内存动态调整）
    const cpuCount = os.cpus().length;
    const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
    const freeMemoryGB = os.freemem() / (1024 * 1024 * 1024);

    // 基于 CPU 的限制
    const maxByCPU = cpuCount;

    // 基于内存的限制（使用可用内存的 40%，每个 Worker 预留 400 MB）
    // ExcelJS 解析大型文件时可能占用 200-400 MB，使用更保守的估计
    const memoryPerWorker = 0.4; // GB（增加到 400 MB）
    const maxByMemory = Math.floor(freeMemoryGB * 0.4 / memoryPerWorker); // 降低到 40%

    // 绝对上限（安全阀，避免极端情况）- 降低到 6
    const absoluteMax = 6;

    // 综合限制：取最小值，确保不会内存溢出
    const calculatedMaxConcurrency = Math.min(maxByCPU, maxByMemory, absoluteMax);

    // 确保至少 2 个并发，最多不超过计算值
    const maxAllowedConcurrency = Math.max(calculatedMaxConcurrency, 2);

    // 默认并发数：2-4 个，根据 CPU 调整
    const defaultConcurrency = Math.min(Math.max(cpuCount, 2), 4);

    // 确定最终使用的并发数
    let configuredConcurrency: number;
    if (config.scanConcurrency && config.scanConcurrency > 0) {
        // 用户配置了并发数，但限制在合理范围内
        configuredConcurrency = Math.min(config.scanConcurrency, maxAllowedConcurrency);
    } else {
        // 使用默认值
        configuredConcurrency = defaultConcurrency;
    }

    // 如果用户配置的值被限制了，给出警告
    if (config.scanConcurrency && config.scanConcurrency > maxAllowedConcurrency) {
        log(`警告: 配置的并发数 ${config.scanConcurrency} 超过最大值 ${maxAllowedConcurrency}，已自动调整`);
        log(`提示: 系统可用内存 ${freeMemoryGB.toFixed(1)} GB, CPU ${cpuCount} 核, 建议不超过 ${maxAllowedConcurrency}`);
    }

    const poolSize = configuredConcurrency;

    log(`使用 ${poolSize} 个 Worker 线程 (CPU: ${cpuCount}核, 总内存: ${totalMemoryGB.toFixed(1)}GB, 可用: ${freeMemoryGB.toFixed(1)}GB, 配置: ${config.scanConcurrency || '默认'})`);

    const workerPool = new WorkerPool(poolSize);
    
    // 【优化】获取路径总数，用于日志显示进度
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

        // 预处理：构建快速查找的忽略目录集合（normalized + lowercase）
        const ignoredDirsNormalized = new Set<string>();
        config.systemDirs.forEach(dir => {
            ignoredDirsNormalized.add(path.normalize(dir).toLowerCase());
        });

        // 使用walkdir遍历目录，添加 filter 选项优化性能
        const walker = walkdir(rootPath, {
            follow_symlinks: false,
            no_recurse: false,
            // 【优化】在 readdir 阶段就过滤掉忽略的目录，避免进入这些目录
            filter: (directory: string, files: string[]) => {
                const dirName = path.basename(directory);

                // 检查是否应该忽略这个目录
                if (shouldIgnoreDirectory(dirName, directory, config)) {
                    return []; // 返回空数组，跳过整个目录
                }

                // 检查当前目录是否在系统目录的子目录下
                const normalizedDir = path.normalize(directory).toLowerCase();
                for (const sysDir of ignoredDirsNormalized) {
                    if (normalizedDir.startsWith(sysDir + path.sep) || normalizedDir === sysDir) {
                        return []; // 跳过系统目录及其子目录
                    }
                }

                // 返回所有文件，让 walkdir 继续遍历
                return files;
            }
        });

        let shouldStop = false;
        let lastActivityTime = Date.now(); // 【优化】最后一次发现文件的时间

        // 并发控制：限制同时处理的文件数
        const maxConcurrency = poolSize * 2;  // 允许队列中的任务数是 Worker 数的 2 倍
        let activeTasks = 0;
        const taskQueue: Array<{ filePath: string, stat: any }> = [];

        // IPC 节流 - 【优化】从 100ms 改为 200ms，减少主线程压力
        let lastProgressTime = 0;

        // 使用 Worker 池处理文件
        const processFileWithWorker = async (filePath: string, stat: any): Promise<void> => {
            // 立即增加计数，确保每个任务都被记录
            processedCount++;

            try {
                if (scanState.cancelFlag) {
                    return;
                }

                // 使用 Worker 池处理文件（不阻塞主线程！）
                // 【优化】移除这里的超时，Worker 内部已有 60 秒超时保护
                // 避免排队时间计入超时导致误判
                const result = await workerPool.processFile(filePath, config.enabledSensitiveTypes) as any;

                if (result.unsupportedPreview) {
                    return;
                }

                if (result.total && result.total > 0) {
                    resultCount++;

                    log(`发现敏感文件 [${resultCount}]: ${filePath} (总计: ${result.total} 个敏感项)`);

                    const resultItem: ScanResultItem = {
                        filePath: result.filePath,
                        fileSize: result.fileSize || stat.size,
                        modifiedTime: result.modifiedTime || stat.mtime.toISOString(),
                        counts: result.counts || {},
                        total: result.total,
                        unsupportedPreview: false
                    };

                    mainWindow.webContents.send('scan-result', resultItem);
                }
            } catch (error: any) {
                if (!scanState.cancelFlag) {
                    log(`处理文件失败 ${filePath}: ${error.message}`);
                    // 【调试】输出错误详情
                    console.error(`[Worker错误] ${filePath}:`, error.message);
                }
            } finally {
                // 任务完成，减少活动任务数
                activeTasks--;
                
                // 【调试】输出状态变化
                if (activeTasks < 0) {
                    console.error(`[严重错误] activeTasks 变为负数: ${activeTasks}，文件: ${filePath}`);
                }

                // 发送进度（基于实际处理的文件数）
                const now = Date.now();
                if (!lastProgressTime || now - lastProgressTime >= 100) {
                    mainWindow.webContents.send('scan-progress', {
                        currentFile: filePath,
                        scannedCount: processedCount,  // ← 使用 processedCount（实际处理数）
                        totalCount: totalCount,         // ← 使用 totalCount（遍历总数）
                        skippedCount: skippedCount
                    });
                    lastProgressTime = now;
                }

                // 从队列中取出下一个任务执行
                if (taskQueue.length > 0 && !shouldStop && !scanState.cancelFlag) {
                    const next = taskQueue.shift();
                    if (next) {
                        activeTasks++;
                        void processFileWithWorker(next.filePath, next.stat);  // ← 异步执行，不等待结果
                    }
                }
            }
        };

        walker.on('path', (filePath: string, stat: any) => {
            // 【优化】更新活动时间，重置空闲计时器
            lastActivityTime = Date.now();

            // 立即检查取消标志，尽早退出
            if (shouldStop || scanState.cancelFlag) {
                if (!shouldStop) {
                    shouldStop = true;
                    log('扫描已取消，正在停止...');
                }
                return false; // 返回 false 停止遍历
            }

            // 【优化】由于已在 filter 中处理，这里不再需要检查忽略目录
            // 只需处理非文件类型
            if (!stat.isFile()) return;

            // 检查扩展名
            const ext = path.extname(filePath).toLowerCase().replace('.', '');

            // 【优化】如果用户选择了 '*'，只扫描支持的文件类型
            if (config.selectedExtensions.includes('*')) {
                // '*' 表示所有支持的类型，过滤掉不支持的文件
                if (!SUPPORTED_EXTENSIONS.includes(ext)) {
                    skippedCount++;
                    return; // 跳过不支持的文件类型
                }
            } else {
                // 用户指定了具体类型，按指定类型过滤
                if (!config.selectedExtensions.includes(ext)) {
                    skippedCount++;
                    return;
                }
            }

            // 检查文件大小
            try {
                const fileSize = stat.size;
                const maxSize = filePath.toLowerCase().endsWith('.pdf')
                    ? config.maxPdfSizeMb * 1024 * 1024
                    : config.maxFileSizeMb * 1024 * 1024;

                if (fileSize > maxSize) {
                    skippedCount++;  // ← 增加跳过计数
                    log(`跳过超大文件: ${filePath} (${Math.round(fileSize / 1024 / 1024)} MB)`);
                    return;
                }
            } catch {
                skippedCount++;  // ← 增加跳过计数
                return;
            }

            scannedCount++;
            totalCount++;  // ← 记录总数

            // 发送进度（遍历阶段，使用 scannedCount）
            const now = Date.now();
            // 【优化】IPC 节流从 100ms 改为 200ms，减少主线程和渲染进程通信开销
            const shouldThrottle = lastProgressTime && (now - lastProgressTime < 200);

            if (!shouldThrottle) {
                mainWindow.webContents.send('scan-progress', {
                    currentFile: filePath,
                    scannedCount: scannedCount,
                    totalCount: totalCount,  // ← 发送总数
                    skippedCount: skippedCount
                });
                lastProgressTime = now;
            }

            // 将任务加入队列或直接执行
            if (activeTasks < maxConcurrency) {
                activeTasks++;
                void processFileWithWorker(filePath, stat);  // ← 异步执行，不等待结果
            } else {
                taskQueue.push({filePath, stat});
            }
        });

        // 【调试】监听 walkdir 错误
        walker.on('error', (err: any) => {
            log(`walkdir 错误: ${err.message}`);
        });

        // 【优化】智能超时检测：监控扫描活动，超过指定时间无新文件则判定为卡住
        await new Promise<void>((resolve) => {
            let pathScanCompleted = false;

            // 空闲超时检查（30秒无新文件即判定为卡住）
            // 【注意】只在遍历阶段检测，避免误判 Worker 处理时间
            let walkerEnded = false;

            const idleCheckInterval = setInterval(() => {
                if (pathScanCompleted || walkerEnded) {
                    clearInterval(idleCheckInterval);
                    return;
                }

                const idleTime = Date.now() - lastActivityTime;
                const idleTimeout = 30000; // 30秒空闲超时

                if (idleTime > idleTimeout && !scanState.cancelFlag) {
                    log(`警告: 路径 ${rootPath} 扫描停滞（${Math.round(idleTime / 1000)}秒无新文件），强制结束`);
                    shouldStop = true;
                    scanState.cancelFlag = true;
                    pathScanCompleted = true;
                    clearInterval(idleCheckInterval);
                    resolve();
                }
            }, 5000); // 每5秒检查一次

            // 【修复】绝对超时保护（20分钟）- 仅针对 walkdir 遍历阶段
            // 遍历结束后会清除此定时器，不影响 Worker 处理时间
            const walkerTimeout = setTimeout(() => {
                if (!pathScanCompleted && !walkerEnded) {
                    log(`警告: 路径 ${rootPath} 遍历超时（20分钟未完成的目录树），强制结束`);
                    shouldStop = true;
                    scanState.cancelFlag = true;
                    pathScanCompleted = true;
                    clearInterval(idleCheckInterval);
                    resolve();
                }
            }, 1200000); // 10分钟

            walker.on('end', async () => {
                // 标记遍历已结束，停止空闲检测和绝对超时
                walkerEnded = true;

                // 【调试】输出 walker.on('end') 时的状态
                log(`walker.on('end') 触发: activeTasks=${activeTasks}, queue=${taskQueue.length}, scanned=${scannedCount}, processed=${processedCount}`);

                // 清理遍历阶段的定时器
                clearInterval(idleCheckInterval);
                clearTimeout(walkerTimeout);

                // 如果被取消，直接退出
                if (scanState.cancelFlag) {
                    pathScanCompleted = true;
                    log(`扫描已取消: 遍历 ${scannedCount} 个文件, 处理 ${processedCount} 个, 发现 ${resultCount} 个敏感文件`);
                    resolve();
                    return;
                }

                // 【优化】智能等待：动态监控任务完成情况，无固定超时限制
                // 只有当长时间（2分钟）没有任何进展时才判定为卡住
                let lastProgressCheck = Date.now();
                let lastProcessedCount = processedCount;
                let lastActiveTasks = activeTasks;
                let lastQueueLength = taskQueue.length;

                const maxIdleTime = 120000; // 2分钟无进展才超时

                const checkCompletion = () => {
                    const now = Date.now();
                    const currentProcessed = processedCount;
                    const currentActive = activeTasks;
                    const currentQueue = taskQueue.length;

                    // 检查是否有进展
                    const hasProgress = (
                        currentProcessed > lastProcessedCount ||
                        currentActive !== lastActiveTasks ||
                        currentQueue !== lastQueueLength
                    );

                    if (hasProgress) {
                        // 有进展，重置计时器
                        lastProgressCheck = now;
                        lastProcessedCount = currentProcessed;
                        lastActiveTasks = currentActive;
                        lastQueueLength = currentQueue;
                        
                        // 【调试】输出进展信息
                        console.log(`[checkCompletion] 进展: active=${currentActive}, queue=${currentQueue}, processed=${currentProcessed}/${scannedCount}`);
                    }

                    // 检查是否超时（长时间无任何进展）
                    const idleTime = now - lastProgressCheck;
                    if (idleTime > maxIdleTime && !scanState.cancelFlag) {
                        log(`警告: 扫描停滞超过${maxIdleTime / 1000 / 60}分钟，强制结束（活动: ${currentActive}, 队列: ${currentQueue}, 已处理: ${currentProcessed}/${scannedCount}）`);
                        pathScanCompleted = true;
                        resolve();
                        return;
                    }

                    // 【修复】只有当没有活动任务且队列为空时才完成
                    // 不需要检查 processedCount >= scannedCount，因为：
                    // 1. processedCount 在 processFileWithWorker 开头就增加了
                    // 2. 即使处理失败，finally 块也会执行，计数已增加
                    // 3. activeTasks === 0 && queue.length === 0 说明所有任务都结束了
                    if (currentActive === 0 && currentQueue === 0) {
                        log(`路径 ${rootPath} 扫描完成: 遍历 ${scannedCount} 个文件, 处理 ${currentProcessed} 个, 发现 ${resultCount} 个敏感文件`);
                        pathScanCompleted = true;
                        resolve();
                    } else {
                        // 继续等待（每 10 秒输出一次状态，便于诊断）
                        const elapsed = Math.floor((now - lastProgressCheck) / 1000);
                        if (elapsed % 10 === 0 && elapsed > 0) {
                            console.log(`[等待] 活动: ${currentActive}, 队列: ${currentQueue}, 已处理: ${currentProcessed}/${scannedCount}, 无进展时间: ${elapsed}秒`);
                        }
                        setTimeout(checkCompletion, 50);
                    }
                };
                checkCompletion();
            });
        });

        // 如果在循环中被取消，跳出外层循环
        if (scanState.cancelFlag) {
            break;
        }
    }

    // 销毁 Worker 池
    try {
        workerPool.destroy();
    } catch (error: any) {
        log(`销毁 Worker 池失败: ${error.message}`);
    }

    // 最后一次检查，确保所有文件都已处理
    if (processedCount < scannedCount) {
        log(`警告: 扫描结束时还有 ${scannedCount - processedCount} 个文件未处理`);
        log(`遍历: ${scannedCount}, 处理: ${processedCount}, 跳过: ${skippedCount}, 总数: ${totalCount}`);
    }

    // 【修复】确保状态一定被重置
    scanState.isScanning = false;
    log('扫描完成');

    // 【修复】确保发送完成事件（即使 mainWindow 已关闭）
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan-finished');
    } else {
        console.warn('窗口已销毁，无法发送 scan-finished 事件');
    }
}

export function cancelScan(scanState: ScanState): void {
    scanState.cancelFlag = true;
}

function shouldIgnoreDirectory(dirName: string, dirPath: string, config: ScanConfig): boolean {
    // 检查是否在忽略目录名列表中
    if (config.ignoreDirNames.includes(dirName)) {
        return true;
    }

    // 检查是否是系统目录（不区分大小写，处理路径分隔符）
    const normalizedDirPath = path.normalize(dirPath).toLowerCase();
    return config.systemDirs.some(sysDir => {
        const normalizedSysDir = path.normalize(sysDir).toLowerCase();
        // 确保匹配完整目录，而不是前缀（例如 C:\Windows 不应匹配 C:\WindowsABC）
        return normalizedDirPath === normalizedSysDir ||
            normalizedDirPath.startsWith(normalizedSysDir + path.sep);
    });
}

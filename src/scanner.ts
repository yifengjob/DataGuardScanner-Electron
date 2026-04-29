import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {BrowserWindow} from 'electron';
import walkdir = require('walkdir');
import {ScanConfig, ScanResultItem} from './types';
import {ScanState} from './scan-state';
import {WorkerPool} from './worker-pool';
import {addAllowedPath, clearAllowedPaths} from './file-operations';

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
        scanState.logs.push(msg);
        mainWindow.webContents.send('scan-log', msg);
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

    for (const rootPath of config.selectedPaths) {
        if (scanState.cancelFlag) {
            log('扫描已取消');
            break;
        }

        log(`正在扫描: ${rootPath}`);

        if (!fs.existsSync(rootPath)) {
            log(`路径不存在: ${rootPath}`);
            continue;
        }

        if (!fs.statSync(rootPath).isDirectory()) {
            log(`路径不是目录: ${rootPath}`);
            continue;
        }

        // 使用walkdir遍历目录
        const walker = walkdir(rootPath, {
            follow_symlinks: false,
            no_recurse: false
        });

        let shouldStop = false;
        // 记录应该跳过的目录
        const ignoredDirs = new Set<string>();
        
        // 并发控制：限制同时处理的文件数
        const maxConcurrency = poolSize * 2;  // 允许队列中的任务数是 Worker 数的 2 倍
        let activeTasks = 0;
        const taskQueue: Array<{filePath: string, stat: any}> = [];
        
        // IPC 节流
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
                // 添加超时保护，防止 Worker 卡住
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('处理超时 (30秒)')), 30000);
                });
                
                const result = await Promise.race([
                    workerPool.processFile(filePath, config.enabledSensitiveTypes),
                    timeoutPromise
                ]) as any;
                
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
                }
            } finally {
                // 任务完成，减少活动任务数
                activeTasks--;
                
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
            // 立即检查取消标志，尽早退出
            if (shouldStop || scanState.cancelFlag) {
                if (!shouldStop) {
                    shouldStop = true;
                    log('扫描已取消，正在停止...');
                }
                return false; // 返回 false 停止遍历
            }

            // 如果是目录，检查是否应该忽略
            if (stat.isDirectory()) {
                const dirName = path.basename(filePath);
                if (shouldIgnoreDirectory(dirName, filePath, config)) {
                    // 标记该目录为忽略，后续其子文件会被跳过
                    ignoredDirs.add(filePath);
                    return;
                }
                
                // 检查当前目录是否在忽略目录的子目录下
                const isInIgnoredDir = Array.from(ignoredDirs).some(ignoredDir => 
                    filePath.startsWith(ignoredDir + path.sep)
                );
                if (isInIgnoredDir) {
                    return; // 跳过忽略目录的子目录
                }
            }

            // 检查文件是否在忽略目录中
            const isInIgnoredDir = Array.from(ignoredDirs).some(ignoredDir => 
                filePath.startsWith(ignoredDir + path.sep)
            );
            if (isInIgnoredDir) {
                return; // 跳过忽略目录中的文件
            }

            if (!stat.isFile()) return;

            // 检查扩展名
            const ext = path.extname(filePath).toLowerCase().replace('.', '');
            if (!config.selectedExtensions.includes('*') && !config.selectedExtensions.includes(ext)) {
                skippedCount++;  // ← 增加跳过计数
                return;
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
            const shouldThrottle = lastProgressTime && (now - lastProgressTime < 100);
            
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

        // 等待所有文件处理完成
        await new Promise<void>((resolve) => {
            walker.on('end', async () => {
                // 如果被取消，直接退出
                if (scanState.cancelFlag) {
                    log(`扫描已取消: 遍历 ${scannedCount} 个文件, 处理 ${processedCount} 个, 发现 ${resultCount} 个敏感文件`);
                    resolve();
                    return;
                }
                
                // 等待所有活动任务完成
                const checkCompletion = () => {
                    if (activeTasks === 0 && taskQueue.length === 0) {
                        log(`路径 ${rootPath} 扫描完成: 遍历 ${scannedCount} 个文件, 处理 ${processedCount} 个, 发现 ${resultCount} 个敏感文件`);
                        
                        // 确保 processedCount 等于 scannedCount（所有文件都已处理）
                        if (processedCount < scannedCount) {
                            log(`警告: 还有 ${scannedCount - processedCount} 个文件未处理完成，继续等待...`);
                            setTimeout(checkCompletion, 100);
                            return;
                        }
                        
                        resolve();
                    } else {
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
    
    scanState.isScanning = false;
    log('扫描完成');
    mainWindow.webContents.send('scan-finished');
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

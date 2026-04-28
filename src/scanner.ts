import * as fs from 'fs';
import * as path from 'path';
import {BrowserWindow} from 'electron';
import walkdir = require('walkdir');
import {ScanConfig, ScanResultItem} from './types';
import {ScanState} from './scan-state';
import {extractTextFromFile} from './file-parser';
import {detectSensitiveData} from './sensitive-detector';
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
            follow_symlinks: false
        });

        let shouldStop = false;
        // 记录应该跳过的目录
        const ignoredDirs = new Set<string>();
        // 使用Promise包装，确保所有异步操作完成
        const pathPromises: Promise<void>[] = [];

        walker.on('path', (filePath: string, stat: any) => {
            if (shouldStop || scanState.cancelFlag) {
                log('扫描已取消');
                return;
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
                return;
            }

            // 检查文件大小
            try {
                const fileSize = stat.size;
                const maxSize = filePath.toLowerCase().endsWith('.pdf')
                    ? config.maxPdfSizeMb * 1024 * 1024
                    : config.maxFileSizeMb * 1024 * 1024;

                if (fileSize > maxSize) {
                    log(`跳过超大文件: ${filePath} (${Math.round(fileSize / 1024 / 1024)} MB)`);
                    return;
                }
            } catch {
                return;
            }

            scannedCount++;

            // 发送进度
            mainWindow.webContents.send('scan-progress', {
                currentFile: filePath,
                scannedCount: scannedCount,
                totalCount: scannedCount
            });

            // 将异步处理包装成Promise并保存
            const processPromise = (async () => {
                processedCount++;
                // 提取文本并检测敏感数据
                try {
                    const {text, unsupportedPreview} = await extractTextFromFile(filePath);

                    if (unsupportedPreview) {
                        return;
                    }

                    const counts = detectSensitiveData(text, config.enabledSensitiveTypes);
                    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

                    if (total > 0) {
                        resultCount++;
                        const modifiedTime = stat.mtime.toISOString();

                        log(`发现敏感文件 [${resultCount}]: ${filePath} (总计: ${total} 个敏感项, 详情: ${JSON.stringify(counts)})`);

                        const result: ScanResultItem = {
                            filePath,
                            fileSize: stat.size,
                            modifiedTime,
                            counts,
                            total,
                            unsupportedPreview: false
                        };

                        mainWindow.webContents.send('scan-result', result);
                    }
                } catch (error: any) {
                    log(`处理文件失败 ${filePath}: ${error.message}`);
                }
            })();
            
            pathPromises.push(processPromise);
        });

        // 等待所有文件处理完成
        await new Promise<void>((resolve) => {
            walker.on('end', async () => {
                // 等待所有异步处理完成
                await Promise.all(pathPromises);
                log(`路径 ${rootPath} 扫描完成: 遍历 ${scannedCount} 个文件, 处理 ${processedCount} 个, 发现 ${resultCount} 个敏感文件`);
                resolve();
            });
        });
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

    // 检查是否是系统目录
    return config.systemDirs.some(sysDir => dirPath.startsWith(sysDir));


}

import {app, BrowserWindow, dialog, ipcMain, nativeImage, Menu, screen} from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// 【关键】首先导入日志抑制工具（必须在任何其他导入之前）
import './log-utils';

// 【新增】设置环境变量抑制 pdfjs-dist 警告
process.env.PDFJS_DISABLE_WARNINGS = '1';
process.env.NODE_NO_WARNINGS = '1';

// 【修复】添加 Promise.withResolvers polyfill，解决 pdfjs-dist 兼容性问题
// pdfjs-dist v5.x+ 使用了 ES2024 的 Promise.withResolvers，需要 polyfill
if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function() {
    let resolve: any, reject: any;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// 【新增】启用 V8 垃圾回收 API（用于扫描完成后释放内存）
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// 【修复】在 Node.js 环境中全局定义 DOMMatrix，解决 pdfjs-dist 的依赖问题
// docstream 使用 pdfjs-dist 解析 PDF，需要 DOMMatrix API
try {
  const { DOMMatrix } = require('@napi-rs/canvas');
  if (typeof (global as any).DOMMatrix === 'undefined') {
    (global as any).DOMMatrix = DOMMatrix;
    console.log('[初始化] DOMMatrix 已全局定义（用于 PDF 解析）');
  }
} catch (error) {
  console.warn('[警告] 无法加载 @napi-rs/canvas，PDF 解析可能失败:', error);
}

import {ScanState} from './scan-state';
import {getDirectoryTree} from './directory-tree';
import {cancelScan, startScan} from './scanner';
import {deleteFile, openFile, openFileLocation} from './file-operations';
import {exportReport} from './report-exporter';
import {loadConfig, saveConfig, calculateRecommendedConcurrency} from './config-manager';
import {checkEnvironment} from './environment-check';
import {getSensitiveRules} from './sensitive-detector';
// 【优化】导入配置常量
import {
    CANCEL_SCAN_MAX_WAIT,
    CANCEL_SCAN_CHECK_INTERVAL,
    WORKER_MAX_OLD_GENERATION_MB,
    WORKER_MAX_YOUNG_GENERATION_MB,
    PREVIEW_TIMEOUT,
    WINDOW_MIN_WIDTH,
    WINDOW_MIN_HEIGHT,
    WINDOW_DEFAULT_WIDTH,
    WINDOW_DEFAULT_HEIGHT,
    WINDOW_TARGET_RATIO,
    MS_TO_DAYS,
    BYTES_TO_MB,
    LOG_RETENTION_DAYS
} from './scan-config';

// 【新增】设置日志文件
function setupLogFile() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  // 【修复】使用北京时间生成日志文件名
  const now = new Date();
  // 直接格式化为北京时间的字符串
  const beijingTimeStr = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  // 将 "2026/5/1 18:45:50" 转换为 "2026-05-01T18-45-50"
  const timeStr = beijingTimeStr
    .replace(/\//g, '-')
    .replace(/ /g, 'T')
    .replace(/:/g, '-');
  const logFile = path.join(logDir, `app-${timeStr}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  
  // 重定向 console 输出到文件
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  
  console.log = function(...args) {
    // 【修复】使用本地时间（北京时间），24小时制
    const timestamp = new Date().toLocaleString('zh-CN', { 
      timeZone: 'Asia/Shanghai',
      hour12: false  // 24小时制
    });
    const message = `[${timestamp}] [INFO] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    logStream.write(message);
    originalLog.apply(console, args);
  };
  
  console.error = function(...args) {
    // 【修复】使用本地时间（北京时间），24小时制
    const timestamp = new Date().toLocaleString('zh-CN', { 
      timeZone: 'Asia/Shanghai',
      hour12: false  // 24小时制
    });
    const message = `[${timestamp}] [ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    logStream.write(message);
    originalError.apply(console, args);
  };
  
  console.warn = function(...args) {
    // 注意：具体的警告过滤已由 log-utils 统一处理
    // 【修复】使用本地时间（北京时间），24小时制
    const timestamp = new Date().toLocaleString('zh-CN', { 
      timeZone: 'Asia/Shanghai',
      hour12: false  // 24小时制
    });
    const message = `[${timestamp}] [WARN] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    logStream.write(message);
    originalWarn.apply(console, args);
  };
  
  console.log(`日志文件已创建: ${logFile}`);
}

// 在应用启动时设置日志文件
setupLogFile();

// 【修复】添加全局未处理异常处理器，防止 Windows 闪退
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[全局错误] 未处理的 Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[全局错误] 未捕获的异常:', error);
  // 【关键】不退出进程，让应用继续运行
  // 注意：某些致命错误（如 OOM）可能无法阻止退出
});

// 【新增】监听进程退出，帮助诊断闪退原因
// 如果闪退时看不到这条日志，说明进程被外部强制终止（如杀毒软件、段错误）
process.on('exit', (code) => {
  // 【修复】使用本地时间（北京时间），24小时制
  const timestamp = new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    hour12: false  // 24小时制
  });
  console.log(`[进程退出] 代码: ${code}, 时间: ${timestamp}`);
});

let mainWindow: BrowserWindow | null = null;
const scanState = new ScanState();

// 【新增】计算窗口位置和尺寸（屏幕的 85%，居中显示）
function getWindowBounds(): { x?: number; y?: number; width: number; height: number } {
    try {
        // 获取鼠标所在的显示器
        const cursorPoint = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursorPoint);
        
        // 获取工作区（排除任务栏/Dock）
        const workArea = display.workArea;
        
        // 计算目标尺寸
        const targetWidth = Math.floor(workArea.width * WINDOW_TARGET_RATIO);
        const targetHeight = Math.floor(workArea.height * WINDOW_TARGET_RATIO);
        
        // 应用尺寸限制
        const width = Math.max(WINDOW_MIN_WIDTH, Math.min(1920, targetWidth));
        const height = Math.max(WINDOW_MIN_HEIGHT, Math.min(1080, targetHeight));
        
        // 居中计算
        const x = workArea.x + Math.floor((workArea.width - width) / 2);
        const y = workArea.y + Math.floor((workArea.height - height) / 2);
        
        console.log(`窗口位置: (${x}, ${y}), 尺寸: ${width}x${height}`);
        console.log(`显示器工作区: ${workArea.width}x${workArea.height}, 缩放: ${display.scaleFactor}x`);
        
        return { x, y, width, height };
    } catch (error) {
        console.error('计算窗口位置失败，使用默认值:', error);
        // 降级方案：使用默认尺寸，系统会自动居中
        return { width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT };
    }
}

function createWindow() {
    // 【新增】计算窗口位置和尺寸
    const bounds = getWindowBounds();
    
    // 加载应用图标
    let icon: any = undefined;
    try {
        // macOS优先使用.icns，其他平台使用.png
        const iconPath = process.platform === 'darwin' 
            ? path.join(__dirname, '../build/icon.icns')
            : path.join(__dirname, '../build/icon.png');
        
        console.log('尝试加载图标，路径:', iconPath);
        if (fs.existsSync(iconPath)) {
            icon = nativeImage.createFromPath(iconPath);
            console.log('✓ 图标加载成功，尺寸:', icon.getSize());
        } else {
            console.warn('⚠ 图标文件不存在:', iconPath);
        }
    } catch (error) {
        console.error('✗ 加载图标失败:', error);
    }

    mainWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        title: 'DataGuard Scanner - 敏感数据扫描工具',
        icon: icon
    });

    // 【新增】隐藏原生菜单栏（Windows/Linux）
    Menu.setApplicationMenu(null);

    // macOS下设置Dock图标（开发模式）
    if (process.platform === 'darwin' && icon && !icon.isEmpty()) {
        app.dock.setIcon(icon);
        console.log('✓ 已设置Dock图标');
    }

    // 检查是否为开发模式
    // 优先使用环境变量，其次检查dist目录是否存在
    const isDev = process.env.NODE_ENV === 'development' || 
                  process.env.ELECTRON_IS_DEV === '1' ||
                  !require('fs').existsSync(path.join(__dirname, '../frontend/dist/index.html'));

    console.log('运行模式:', isDev ? '开发模式 (Vite)' : '生产模式 (文件)');

    if (isDev) {
        console.log('加载开发服务器: http://localhost:1420');
        mainWindow.loadURL('http://localhost:1420').catch((err) => {
            console.error('加载开发服务器失败:', err);
            console.log('尝试加载本地文件...');
            // 如果开发服务器不可用，尝试加载本地文件
            if (mainWindow) {
                mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html')).catch((fileErr) => {
                    console.error('加载本地文件也失败:', fileErr);
                });
            }
        });
        mainWindow.webContents.openDevTools();
    } else {
        // 生产模式：使用 app.getAppPath() 获取正确的路径
        const appPath = app.getAppPath();
        const indexPath = path.join(appPath, 'frontend', 'dist', 'index.html');
        console.log('应用路径:', appPath);
        console.log('加载本地文件:', indexPath);
        
        // 检查文件是否存在
        const fs = require('fs');
        if (!fs.existsSync(indexPath)) {
            console.error('前端文件不存在:', indexPath);
            // 尝试其他可能的路径
            const altPath = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
            console.log('尝试备用路径:', altPath);
            if (fs.existsSync(altPath)) {
                mainWindow.loadFile(altPath).catch((err) => {
                    console.error('加载备用路径失败:', err);
                });
            } else {
                console.error('所有路径都失败，请检查打包配置');
            }
        } else {
            mainWindow.loadFile(indexPath).catch((err) => {
                console.error('加载前端文件失败:', err);
            });
        }
    }

    mainWindow.on('closed', () => {
        // 如果窗口关闭时正在扫描，取消扫描并重置状态
        if (scanState.isScanning) {
            cancelScan(scanState);
            scanState.isScanning = false;
        }
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    const envCheck = checkEnvironment();

    if (!envCheck.isReady) {
        dialog.showErrorBox('系统环境检查失败',
            `发现以下问题:\n\n${envCheck.issues.map(i => `${i.title}\n${i.description}`).join('\n\n')}`
        );
        app.quit();
        return;
    }

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    setupIpcHandlers();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 计算目录大小（字节）
function getDirectorySize(dirPath: string): number {
    const fs = require('fs');
    let totalSize = 0;
    
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = fs.statSync(filePath);
            
            if (stat.isDirectory()) {
                totalSize += getDirectorySize(filePath);
            } else {
                totalSize += stat.size;
            }
        }
    } catch (e) {
        // 忽略无法访问的文件
    }
    
    return totalSize;
}

function setupIpcHandlers() {
    // 获取目录树
    ipcMain.handle('get-directory-tree', async (_, dirPath: string, showHidden: boolean) => {
        try {
            return await getDirectoryTree(dirPath, showHidden);
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 开始扫描
    ipcMain.handle('scan-start', async (_, config: any) => {
        if (!mainWindow) return {error: '窗口未初始化'};

        try {
            // 不 await，让扫描在后台进行
            startScan(config, mainWindow, scanState).catch(error => {
                console.error('扫描异常:', error);
                if (mainWindow) {
                    mainWindow.webContents.send('scan-error', error.message);
                }
            });
            return {success: true};
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 取消扫描
    ipcMain.handle('scan-cancel', async () => {
        if (!scanState.isScanning) {
            return {success: true};
        }
        
        cancelScan(scanState);
        
        // 【修复】等待扫描状态真正重置，避免竞态条件
        // 最多等待一定时间，定期检查状态
        let waitedTime = 0;
        
        while (scanState.isScanning && waitedTime < CANCEL_SCAN_MAX_WAIT) {
            await new Promise(resolve => setTimeout(resolve, CANCEL_SCAN_CHECK_INTERVAL));
            waitedTime += CANCEL_SCAN_CHECK_INTERVAL;
        }
        
        if (scanState.isScanning) {
            console.warn(`[scan-cancel] 警告: 等待 ${CANCEL_SCAN_MAX_WAIT / 1000} 秒后扫描仍未结束，强制重置状态`);
            scanState.isScanning = false;
        } else {
            console.log('[scan-cancel] 扫描已安全取消');
        }
        
        return {success: true};
    });

    // 预览文件（使用 Worker 线程，避免阻塞主进程）
    ipcMain.handle('preview-file', async (_, filePath: string) => {
        try {
            const { Worker } = require('worker_threads');
            const pathModule = require('path');
            
            // 创建单个 Worker 来处理预览
            const workerPath = pathModule.join(__dirname, 'file-worker.js');
            const worker = new Worker(workerPath, {
                resourceLimits: {
                    maxOldGenerationSizeMb: WORKER_MAX_OLD_GENERATION_MB,
                    maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GENERATION_MB,
                }
            });
            
            return new Promise((resolve) => {
                let messageReceived = false;
                
                const timeout = setTimeout(() => {
                    if (!messageReceived) {
                        worker.terminate();
                        resolve({ error: '预览超时，文件可能太大或太复杂' });
                    }
                }, PREVIEW_TIMEOUT);
                
                worker.on('message', async (result: any) => {
                    // 跳过 ready 消息
                    if (result.type === 'ready') {
                        return;
                    }
                    
                    messageReceived = true;
                    clearTimeout(timeout);
                    
                    if (result.error) {
                        worker.terminate();
                        resolve({ error: result.error });
                        return;
                    }
                    
                    // 获取启用的敏感类型
                    const config = await loadConfig();
                    const enabledTypes = config.enabledSensitiveTypes || [];
                    
                    // 生成高亮信息
                    const { getHighlights } = await import('./sensitive-detector');
                    const highlights = getHighlights(result.text || '', enabledTypes);
                    
                    worker.terminate();
                    resolve({
                        content: result.text || '',
                        highlights: highlights,
                        unsupportedPreview: result.unsupportedPreview || false
                    });
                });
                
                worker.on('error', (error: any) => {
                    clearTimeout(timeout);
                    resolve({ error: '预览失败：' + error.message });
                });
                
                worker.on('exit', (code: number) => {
                    if (code !== 0 && !messageReceived) {
                        clearTimeout(timeout);
                        resolve({ error: `预览异常退出 (代码: ${code})` });
                    }
                });
                
                // 发送任务到 Worker
                worker.postMessage({
                    taskId: Date.now(),
                    filePath: filePath,
                    enabledSensitiveTypes: [],
                    previewMode: true // 预览模式：只提取文本
                });
            });
        } catch (error: any) {
            return { error: error.message };
        }
    });

    // 取消预览
    ipcMain.handle('cancel-preview', () => {
        return {success: true};
    });

    // 打开文件
    ipcMain.handle('open-file', async (_, filePath: string) => {
        try {
            await openFile(filePath);
            return {success: true};
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 打开文件位置
    ipcMain.handle('open-file-location', async (_, filePath: string) => {
        try {
            await openFileLocation(filePath);
            return {success: true};
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 删除文件
    ipcMain.handle('delete-file', async (_, filePath: string, toTrash: boolean) => {
        try {
            await deleteFile(filePath, toTrash);
            return {success: true};
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 导出报告
    ipcMain.handle('export-report', async (_, results: any[], format: string, filePath?: string) => {
        try {
            await exportReport(results, format as 'csv' | 'json' | 'excel', filePath);
            return {success: true};
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 获取日志
    ipcMain.handle('get-logs', () => {
        return {logs: scanState.logs};
    });

    // 获取敏感规则
    ipcMain.handle('get-sensitive-rules', () => {
        return getSensitiveRules();
    });

    // 保存配置
    ipcMain.handle('save-config', async (_, config: any) => {
        try {
            await saveConfig(config);
            return {success: true};
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 加载配置
    ipcMain.handle('load-config', async () => {
        try {
            return await loadConfig();
        } catch (error: any) {
            return {error: error.message};
        }
    });

    // 获取推荐的并发数（根据系统硬件智能计算）
    ipcMain.handle('get-recommended-concurrency', () => {
        return calculateRecommendedConcurrency();
    });

    // 检查系统环境
    ipcMain.handle('check-system-environment', () => {
        return checkEnvironment();
    });

    // 保存文件对话框
    ipcMain.handle('show-save-dialog', async (_, options?: any) => {
        return await dialog.showSaveDialog(mainWindow!, {
            filters: options?.filters || []
        });
    });

    // 【新增】消息对话框（确认/提示）
    ipcMain.handle('show-message-box', async (_, options: {
        message: string;
        title?: string;
        type?: 'info' | 'warning' | 'error' | 'question';
        buttons?: string[];
        cancelId?: number;
    }) => {
        const result = await dialog.showMessageBox(mainWindow!, {
            type: options.type || 'info',
            title: options.title || '提示',
            message: options.message,
            buttons: options.buttons || ['确定'],
            cancelId: options.cancelId,
            defaultId: 0
        });
        return { response: result.response };
    });

    // 清理应用缓存
    ipcMain.handle('clear-cache', async () => {
        try {
            const fs = require('fs');
            const os = require('os');
            const userDataPath = app.getPath('userData');
            
            let cleanedSize = 0;
            const cleanedFiles: string[] = [];
            
            // 1. 清理 Chromium 缓存
            const cacheDirs = [
                path.join(userDataPath, 'Cache'),
                path.join(userDataPath, 'GPUCache'),
                path.join(userDataPath, 'Code Cache'),
                path.join(userDataPath, 'Service Worker'),
            ];
            
            for (const cacheDir of cacheDirs) {
                if (fs.existsSync(cacheDir)) {
                    const size = getDirectorySize(cacheDir);
                    fs.rmSync(cacheDir, { recursive: true, force: true });
                    cleanedSize += size;
                    cleanedFiles.push(path.basename(cacheDir));
                }
            }
            
            // 2. 【新增】清理日志文件（保留当前正在使用的日志）
            const logDir = path.join(userDataPath, 'logs');
            if (fs.existsSync(logDir)) {
                const logFiles = fs.readdirSync(logDir);
                const currentLogFile = `app-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
                
                for (const logFile of logFiles) {
                    // 跳过当前正在使用的日志文件
                    if (logFile === currentLogFile) {
                        console.log(`[clear-cache] 保留当前日志: ${logFile}`);
                        continue;
                    }
                    
                    const logFilePath = path.join(logDir, logFile);
                    try {
                        const stat = fs.statSync(logFilePath);
                        if (stat.isFile()) {
                            fs.unlinkSync(logFilePath);
                            cleanedSize += stat.size;
                            cleanedFiles.push(`logs/${logFile}`);
                        }
                    } catch (e) {
                        console.warn(`[clear-cache] 无法删除日志文件 ${logFile}:`, e);
                    }
                }
                
                // 【优化】清空当前日志文件内容（不删除文件本身）
                const currentLogPath = path.join(logDir, currentLogFile);
                if (fs.existsSync(currentLogPath)) {
                    try {
                        fs.writeFileSync(currentLogPath, '');
                        console.log('[clear-cache] 已清空当前日志文件内容');
                    } catch (e) {
                        console.warn('[clear-cache] 清空当前日志失败:', e);
                    }
                }
            }
            
            // 3. 清理系统临时目录中的本应用相关文件
            const tempDir = os.tmpdir();
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                for (const file of files) {
                    // 清理超过指定天数的临时文件
                    const filePath = path.join(tempDir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        const daysOld = (Date.now() - stat.mtimeMs) / MS_TO_DAYS;
                        if (daysOld > LOG_RETENTION_DAYS && stat.isFile()) {
                            fs.unlinkSync(filePath);
                            cleanedSize += stat.size;
                            cleanedFiles.push(`temp/${file}`);
                        }
                    } catch (e) {
                        // 忽略无法删除的文件
                    }
                }
            }
            
            const cleanedSizeMB = Math.round(cleanedSize / BYTES_TO_MB);
            console.log(`[clear-cache] 缓存清理完成，释放 ${cleanedSizeMB} MB 空间`);
            console.log(`[clear-cache] 清理的文件: ${cleanedFiles.join(', ') || '无'}`);
            
            return { success: true, cleanedSize, cleanedFiles };
        } catch (error: any) {
            console.error('[clear-cache] 清理缓存失败:', error);
            return { error: error.message };
        }
    });
    
    // 【新增】打开开发者工具
    ipcMain.handle('open-dev-tools', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.openDevTools();
            return { success: true };
        }
        return { error: '窗口未初始化' };
    });
}

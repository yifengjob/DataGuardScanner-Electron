import {app, BrowserWindow, dialog, ipcMain, nativeImage, Menu} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {ScanState} from './scan-state';
import {getDirectoryTree} from './directory-tree';
import {cancelScan, startScan} from './scanner';
import {deleteFile, openFile, openFileLocation} from './file-operations';
import {exportReport} from './report-exporter';
import {loadConfig, saveConfig} from './config-manager';
import {checkEnvironment} from './environment-check';
import {getSensitiveRules} from './sensitive-detector';

// 抑制pdf-parse的字体警告
const originalWarn = console.warn;
console.warn = function(...args) {
  if (args[0] && typeof args[0] === 'string' && args[0].includes('Warning: TT: undefined function')) {
    return; // 忽略pdf-parse的字体警告
  }
  originalWarn.apply(console, args);
};

let mainWindow: BrowserWindow | null = null;
const scanState = new ScanState();

function createWindow() {
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
        width: 1024,
        height: 768,
        minWidth: 1000,
        minHeight: 600,
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
    ipcMain.handle('scan-cancel', () => {
        cancelScan(scanState);
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
                    maxOldGenerationSizeMb: 512,
                    maxYoungGenerationSizeMb: 64,
                }
            });
            
            return new Promise((resolve) => {
                let messageReceived = false;
                
                const timeout = setTimeout(() => {
                    if (!messageReceived) {
                        worker.terminate();
                        resolve({ error: '预览超时，文件可能太大或太复杂' });
                    }
                }, 30000); // 30秒超时
                
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

    // 清理应用缓存
    ipcMain.handle('clear-cache', async () => {
        try {
            const fs = require('fs');
            const os = require('os');
            const userDataPath = app.getPath('userData');
            
            // 清理 Chromium 缓存
            const cacheDirs = [
                path.join(userDataPath, 'Cache'),
                path.join(userDataPath, 'GPUCache'),
                path.join(userDataPath, 'Code Cache'),
                path.join(userDataPath, 'Service Worker'),
            ];
            
            let cleanedSize = 0;
            for (const cacheDir of cacheDirs) {
                if (fs.existsSync(cacheDir)) {
                    const size = getDirectorySize(cacheDir);
                    fs.rmSync(cacheDir, { recursive: true, force: true });
                    cleanedSize += size;
                }
            }
            
            // 清理系统临时目录中的本应用相关文件
            const tempDir = os.tmpdir();
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                for (const file of files) {
                    // 清理超过7天的临时文件
                    const filePath = path.join(tempDir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        const daysOld = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
                        if (daysOld > 7 && stat.isFile()) {
                            fs.unlinkSync(filePath);
                            cleanedSize += stat.size;
                        }
                    } catch (e) {
                        // 忽略无法删除的文件
                    }
                }
            }
            
            console.log(`缓存清理完成，释放 ${Math.round(cleanedSize / 1024 / 1024)} MB 空间`);
            return { success: true, cleanedSize };
        } catch (error: any) {
            console.error('清理缓存失败:', error);
            return { error: error.message };
        }
    });
}

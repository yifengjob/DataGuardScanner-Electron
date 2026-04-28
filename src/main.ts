import {app, BrowserWindow, dialog, ipcMain, nativeImage} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {ScanState} from './scan-state';
import {getDirectoryTree} from './directory-tree';
import {cancelScan, startScan} from './scanner';
import {extractTextFromFile} from './file-parser';
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
        console.log('加载本地文件:', path.join(__dirname, '../frontend/dist/index.html'));
        mainWindow.loadFile(path.join(__dirname, '../frontend/dist/index.html')).catch((err) => {
            console.error('加载前端文件失败:', err);
        });
    }

    mainWindow.on('closed', () => {
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

    // 预览文件
    ipcMain.handle('preview-file', async (_, filePath: string) => {
        try {
            const { text, unsupportedPreview } = await extractTextFromFile(filePath);
                
            // 获取启用的敏感类型（从配置中读取）
            const config = await loadConfig();
            const enabledTypes = config.enabledSensitiveTypes || [];
                
            // 生成高亮信息
            const { getHighlights } = await import('./sensitive-detector');
            const highlights = getHighlights(text, enabledTypes);
                
            return {
                content: text,
                highlights: highlights,
                unsupportedPreview: unsupportedPreview
            };
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
}

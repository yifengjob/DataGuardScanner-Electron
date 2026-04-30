/**
 * Walker Worker - 专门的目录遍历线程（生产者）
 * 负责遍历目录树，将符合条件的文件发送到主线程
 */
import { parentPort } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
// 【修复】从 file-parser 导入 SUPPORTED_EXTENSIONS，保持单一数据源
import { SUPPORTED_EXTENSIONS } from './file-parser';
// 【优化】导入配置常量
import { BYTES_TO_MB } from './scan-config';

// 动态导入 walkdir（避免顶层 import 导致的问题）
let walkdir: any;

interface WalkerConfig {
  rootPath: string;
  selectedExtensions: string[];
  ignoreDirNames: string[];
  systemDirs: string[];
  maxFileSizeMb: number;
  maxPdfSizeMb: number;
}

/**
 * 检查是否应该忽略目录
 */
function shouldIgnoreDirectory(dirName: string, dirPath: string, config: WalkerConfig): boolean {
  // 检查是否在忽略目录名列表中
  if (config.ignoreDirNames.includes(dirName)) {
    return true;
  }

  // 检查是否是系统目录
  const normalizedDirPath = path.normalize(dirPath).toLowerCase();
  return config.systemDirs.some(sysDir => {
    const normalizedSysDir = path.normalize(sysDir).toLowerCase();
    return normalizedDirPath === normalizedSysDir ||
      normalizedDirPath.startsWith(normalizedSysDir + path.sep);
  });
}

/**
 * 初始化 walkdir
 */
async function initWalkdir() {
  if (!walkdir) {
    const module = await import('walkdir');
    walkdir = module.default || module;
  }
}

/**
 * 开始遍历
 */
async function startWalking(config: WalkerConfig) {
  try {
    await initWalkdir();
    
    const { rootPath, selectedExtensions, ignoreDirNames, systemDirs, maxFileSizeMb, maxPdfSizeMb } = config;
    
    // 【修复】检查 rootPath 是文件还是目录
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(rootPath);
    } catch (error: any) {
      console.error(`[Walker] 无法访问路径: ${rootPath}`, error.message);
      parentPort?.postMessage({
        type: 'walking-error',
        error: `无法访问路径: ${rootPath}`
      });
      return;
    }
    
    // 如果是文件，直接处理该文件
    if (stat.isFile()) {
      console.log(`[Walker] 检测到文件: ${rootPath}, 大小: ${stat.size} bytes`);
      const ext = path.extname(rootPath).toLowerCase().replace('.', '');
      console.log(`[Walker] 文件扩展名: '${ext}'`);
      
      // 检查扩展名
      let shouldProcess = false;
      if (selectedExtensions.includes('*')) {
        shouldProcess = SUPPORTED_EXTENSIONS.includes(ext);
        console.log(`[Walker] 检查扩展名: ${ext} in SUPPORTED_EXTENSIONS=${SUPPORTED_EXTENSIONS.includes(ext)}`);
      } else {
        shouldProcess = selectedExtensions.includes(ext);
        console.log(`[Walker] 检查扩展名: ${ext} in selectedExtensions=${selectedExtensions.includes(ext)}`);
      }
      
      console.log(`[Walker] shouldProcess=${shouldProcess}, size=${stat.size}`);
      
      if (shouldProcess && stat.size > 0) {
        // 检查文件大小
        const maxSize = rootPath.toLowerCase().endsWith('.pdf')
          ? maxPdfSizeMb * BYTES_TO_MB
          : maxFileSizeMb * BYTES_TO_MB;
        
        if (stat.size <= maxSize) {
          parentPort?.postMessage({
            type: 'file-found',
            filePath: rootPath,
            stat: {
              size: stat.size,
              mtime: stat.mtime.toISOString()
            }
          });
        }
      }
      
      // 发送完成信号
      parentPort?.postMessage({
        type: 'walking-complete',
        fileCount: shouldProcess && stat.size > 0 ? 1 : 0,
        skippedCount: shouldProcess && stat.size > 0 ? 0 : 1
      });
      return;
    }
    
    // 如果是目录，使用 walkdir 遍历
    if (!stat.isDirectory()) {
      parentPort?.postMessage({
        type: 'walking-error',
        error: `路径既不是文件也不是目录: ${rootPath}`
      });
      return;
    }
    
    // 【修复】将 walker 事件包装成 Promise
    return new Promise<void>((resolve, reject) => {
      // 预处理：构建快速查找的忽略目录集合
      const ignoredDirsNormalized = new Set<string>();
      systemDirs.forEach(dir => {
        ignoredDirsNormalized.add(path.normalize(dir).toLowerCase());
      });

      let fileCount = 0;
      let skippedCount = 0;

      const walker = walkdir(rootPath, {
      follow_symlinks: false,
      no_recurse: false,
      filter: (directory: string, files: string[]) => {
        const dirName = path.basename(directory);

        // 【调试】输出过滤日志
        if (shouldIgnoreDirectory(dirName, directory, config)) {
          console.log(`[Walker Filter] 跳过忽略目录: ${directory}`);
          return [];
        }

        // 检查当前目录是否在系统目录的子目录下
        const normalizedDir = path.normalize(directory).toLowerCase();
        for (const sysDir of ignoredDirsNormalized) {
          if (normalizedDir.startsWith(sysDir + path.sep) || normalizedDir === sysDir) {
            console.log(`[Walker Filter] 跳过系统目录: ${directory} (匹配: ${sysDir})`);
            return [];
          }
        }

        return files;
      }
    });

    walker.on('path', (filePath: string, stat: any) => {
      // 只处理文件
      if (!stat.isFile()) return;

      // 检查扩展名
      const ext = path.extname(filePath).toLowerCase().replace('.', '');

      // 如果用户选择了 '*'，只扫描支持的文件类型
      if (selectedExtensions.includes('*')) {
        if (!SUPPORTED_EXTENSIONS.includes(ext)) {
          skippedCount++;
          return;
        }
      } else {
        // 用户指定了具体类型，按指定类型过滤
        if (!selectedExtensions.includes(ext)) {
          skippedCount++;
          return;
        }
      }

      // 检查文件大小
      const fileSize = stat.size;
      
      // 跳过 0 字节文件
      if (fileSize === 0) {
        skippedCount++;
        return;
      }

      const maxSize = filePath.toLowerCase().endsWith('.pdf')
        ? maxPdfSizeMb * BYTES_TO_MB
        : maxFileSizeMb * BYTES_TO_MB;

      if (fileSize > maxSize) {
        skippedCount++;
        return;
      }

      // 【新增】检查文件可读性和可打开性（Windows 专用）
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
        
        // Windows 专用：尝试以只读方式打开文件，检测是否被锁定
        if (process.platform === 'win32') {
          const fd = fs.openSync(filePath, 'r');
          fs.closeSync(fd);
        }
      } catch (accessError: any) {
        skippedCount++;
        return;
      }

      // 发送文件信息到主线程
      fileCount++;
      parentPort?.postMessage({
        type: 'file-found',
        filePath,
        stat: {
          size: stat.size,
          mtime: stat.mtime.toISOString()
        }
      });
    });

    walker.on('end', () => {
      console.log(`[Walker] walker 'end' 事件触发: ${rootPath}, fileCount=${fileCount}, skippedCount=${skippedCount}`);
      parentPort?.postMessage({
        type: 'walking-complete',
        fileCount,
        skippedCount
      });
      console.log(`[Walker] 即将 resolve Promise: ${rootPath}`);
      resolve(); // 【修复】Promise resolve
      console.log(`[Walker] Promise 已 resolve: ${rootPath}`);
    });

    walker.on('error', (err: any) => {
      console.error(`[Walker Error] 遍历错误 (${rootPath}):`, err.message);
      parentPort?.postMessage({
        type: 'walking-error',
        error: err.message
      });
      reject(err); // 【修复】Promise reject
    });

    }); // 【修复】关闭 Promise

  } catch (error: any) {
    parentPort?.postMessage({
      type: 'walking-error',
      error: error.message
    });
    throw error; // 【修复】重新抛出错误
  }
}

// 监听主线程消息
let isWalking = false; // 【修复】标记是否正在遍历
const taskQueue: any[] = []; // 【修复】任务队列

parentPort?.on('message', (message: any) => {
  if (message.type === 'start-walking') {
    // 【修复】如果正在遍历，将任务加入队列
    if (isWalking) {
      console.log(`[Walker] 正在遍历中，将任务加入队列: ${message.config.rootPath}`);
      taskQueue.push(message.config);
      return;
    }
    
    // 开始遍历
    isWalking = true;
    console.log(`[Walker] 开始遍历: ${message.config.rootPath}`);
    parentPort?.postMessage({
      type: 'walker-log',
      message: `[Walker] 开始遍历: ${message.config.rootPath}`
    });
    
    // 处理 Promise，捕获可能的错误
    startWalking(message.config).then(() => {
      // 遍历完成，检查队列中是否有待处理的任务
      isWalking = false;
      const queueLength = taskQueue.length;
      console.log(`[Walker] 遍历完成: ${message.config.rootPath}, 队列长度: ${queueLength}`);
      parentPort?.postMessage({
        type: 'walker-log',
        message: `[Walker] 遍历完成: ${message.config.rootPath}, 队列长度: ${queueLength}`
      });
      
      if (taskQueue.length > 0) {
        const nextConfig = taskQueue.shift();
        console.log(`[Walker] 从队列中取出下一个任务: ${nextConfig.rootPath}`);
        parentPort?.postMessage({
          type: 'walker-log',
          message: `[Walker] 从队列中取出下一个任务: ${nextConfig.rootPath}`
        });
        isWalking = true;
        startWalking(nextConfig).catch((error: any) => {
          parentPort?.postMessage({
            type: 'walking-error',
            error: error.message || String(error)
          });
          isWalking = false;
        });
      } else {
        console.log(`[Walker] 队列为空，等待新任务`);
        parentPort?.postMessage({
          type: 'walker-log',
          message: `[Walker] 队列为空，等待新任务`
        });
      }
    }).catch((error: any) => {
      parentPort?.postMessage({
        type: 'walking-error',
        error: error.message || String(error)
      });
      isWalking = false;
      
      // 即使出错也要继续处理队列中的任务
      if (taskQueue.length > 0) {
        const nextConfig = taskQueue.shift();
        console.log(`[Walker] 从队列中取出下一个任务（错误恢复）: ${nextConfig.rootPath}`);
        isWalking = true;
        startWalking(nextConfig).catch((error: any) => {
          parentPort?.postMessage({
            type: 'walking-error',
            error: error.message || String(error)
          });
          isWalking = false;
        });
      }
    });
  } else if (message.type === 'cancel-all') {
    // 【内存安全】清空所有待处理的任务
    console.log(`[Walker] 收到取消信号，清空队列 (${taskQueue.length} 个任务)`);
    taskQueue.length = 0;
    isWalking = false;
  }
});

// 发送就绪信号
parentPort?.postMessage({ type: 'ready' });

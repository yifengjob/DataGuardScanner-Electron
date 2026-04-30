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

        // 检查是否应该忽略这个目录
        if (shouldIgnoreDirectory(dirName, directory, config)) {
          return [];
        }

        // 检查当前目录是否在系统目录的子目录下
        const normalizedDir = path.normalize(directory).toLowerCase();
        for (const sysDir of ignoredDirsNormalized) {
          if (normalizedDir.startsWith(sysDir + path.sep) || normalizedDir === sysDir) {
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
      parentPort?.postMessage({
        type: 'walking-complete',
        fileCount,
        skippedCount
      });
    });

    walker.on('error', (err: any) => {
      parentPort?.postMessage({
        type: 'walking-error',
        error: err.message
      });
    });

  } catch (error: any) {
    parentPort?.postMessage({
      type: 'walking-error',
      error: error.message
    });
  }
}

// 监听主线程消息
parentPort?.on('message', (message: any) => {
  if (message.type === 'start-walking') {
    // 处理 Promise，捕获可能的错误
    startWalking(message.config).catch((error: any) => {
      parentPort?.postMessage({
        type: 'walking-error',
        error: error.message || String(error)
      });
    });
  }
});

// 发送就绪信号
parentPort?.postMessage({ type: 'ready' });

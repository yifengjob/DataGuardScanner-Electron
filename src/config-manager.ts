import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {app} from 'electron';
import {AppConfig} from './types';

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

/**
 * 获取基础系统目录（不包含其他磁盘）
 */
function getBaseSystemDirs(): string[] {
  let systemDirs: string[] = [];
  if (process.platform === 'win32') {
    systemDirs = [
      // Windows 系统目录
      'C:\\Windows', 'C:\\WinNT',
      // 程序安装目录
      'C:\\Program Files', 'C:\\Program Files (x86)',
      // 系统数据和配置
      'C:\\ProgramData',
      // 'C:\\Users\\All Users',
      // 恢复和性能日志
      'C:\\Recovery', 'C:\\PerfLogs',
      // 系统驱动和引导
      'C:\\Boot', 'C:\\EFI',
      // 页面文件和休眠文件（通常在这些位置）
      'C:\\pagefile.sys', 'C:\\hiberfil.sys', 'C:\\swapfile.sys'
    ];
  } else if (process.platform === 'darwin') {
    systemDirs = [
      // macOS 系统目录
      '/System', '/Library', '/private',
      // 应用程序
      '/Applications', '/Applications/Utilities',
      // 用户库（可选，因为可能包含用户数据）
      // '/Users/*/Library', // 不默认添加，避免误伤
      // 虚拟文件系统
      '/dev', '/Volumes'
    ];
  } else if (process.platform === 'linux') {
    systemDirs = [
      // 虚拟文件系统
      '/proc', '/sys', '/dev', '/dev/pts',
      // 运行时数据
      '/run', '/var/run', '/var/lock',
      // 临时文件
      // '/tmp', '/var/tmp',
      // 系统配置和数据
      // '/etc', '/var', '/var/log', '/var/cache',
      // 系统二进制和库
      '/bin', '/sbin', '/lib', '/lib64', '/usr',
      // 引导和内核
      '/boot', '/initrd', '/vmlinuz',
      // 挂载点
      '/mnt', '/media', '/cdrom',
      // 可选应用和服务
      '/opt', '/srv',
      // Snap 和 Flatpak 容器
      '/snap', '/var/lib/snapd',
      '/var/lib/flatpak'
    ];
  }
  return systemDirs;
}

/**
 * 根据配置生成完整的系统目录列表
 */
export function generateSystemDirs(ignoreOtherDrives: boolean = false): string[] {
  const baseDirs = getBaseSystemDirs();
  
  // 仅在 Windows 且启用选项时添加其他磁盘
  if (process.platform === 'win32' && ignoreOtherDrives) {
    const allDirs = [...baseDirs];
    for (let i = 68; i <= 90; i++) { // D-Z
      const drive = String.fromCharCode(i);
      allDirs.push(
        `${drive}:\\Windows`,
        `${drive}:\\Program Files`,
        `${drive}:\\Program Files (x86)`,
        `${drive}:\\ProgramData`
      );
    }
    return allDirs;
  }
  
  return baseDirs;
}

export function getDefaultConfig(): AppConfig {
  const ignoreDirNames = [
    // 版本控制和开发工具
    'node_modules', '.git', '.svn', '.hg', '.bzr', '_darcs',
    // IDE 和编辑器
    '.vscode', '.idea', '.eclipse', '.settings', '.project',
    // 构建和缓存
    // 'dist', 'build', '.next', 'out', '.cache', '__pycache__',
    // 包管理器
    '.npm', '.yarn', '.pnpm-store', 'bower_components',
    // 操作系统隐藏文件和目录
    'System Volume Information',
    // '$RECYCLE.BIN', 'Recycle.Bin',
    '.Spotlight-V100', '.fseventsd', '.DS_Store',
    // '.Trashes',
    // 'lost+found',
    // '.Trash',
    // 临时文件
    // 'tmp', 'temp', '.temp'
  ];
  
  // scanConcurrency: 0 表示使用动态计算（根据 CPU 和内存自动调整）
  // 默认设置为 4，这是一个平衡性能和资源消耗的保守值
  return {
    selectedPaths: [],
    selectedExtensions: ['*'],
    enabledSensitiveTypes: [
      'person_id', 'phone', 'email', 'bank_card',
      'address', 'ip_address', 'password'
    ],
    ignoreDirNames,
    systemDirs: generateSystemDirs(false), // 默认只忽略C盘系统目录
    maxFileSizeMb: 50,
    maxPdfSizeMb: 100,
    scanConcurrency: 4, // 默认并发数，scanner.ts 会根据硬件智能调整
    theme: 'system',
    language: 'zh-CN',
    enableExperimentalParsers: false,
    enableOfficeParsers: true,
    deleteToTrash: false,
    ignoreOtherDrivesSystemDirs: false // 默认不忽略其他磁盘的系统目录（即会扫描）
  };
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = await fs.promises.readFile(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(data);
      const defaultConfig = getDefaultConfig();
      const mergedConfig = { ...defaultConfig, ...config };
      
      // 根据 ignoreOtherDrivesSystemDirs 选项重新生成系统目录
      mergedConfig.systemDirs = generateSystemDirs(mergedConfig.ignoreOtherDrivesSystemDirs);
      
      return mergedConfig;
    }
  } catch (error) {
    console.error('加载配置失败:', error);
  }
  
  return getDefaultConfig();
}

export async function saveConfig(config: AppConfig): Promise<void> {
  try {
    const data = JSON.stringify(config, null, 2);
    await fs.promises.writeFile(CONFIG_FILE, data, 'utf-8');
  } catch (error) {
    console.error('保存配置失败:', error);
    throw error;
  }
}

/**
 * 根据系统硬件资源智能计算推荐的并发数
 */
export function calculateRecommendedConcurrency(): number {
  const cpuCount = os.cpus().length;
  const freeMemoryGB = os.freemem() / (1024 * 1024 * 1024);
  const memoryPerWorker = 0.4; // GB
  const maxByMemory = Math.floor(freeMemoryGB * 0.4 / memoryPerWorker);
  const absoluteMax = 6;
  const calculatedMaxConcurrency = Math.min(cpuCount, maxByMemory, absoluteMax);
  return Math.max(calculatedMaxConcurrency, 2);
}

/**
 * 根据配置和系统资源计算实际使用的并发数
 * @param configuredConcurrency 配置的并发数（0 表示自动）
 * @returns 实际应该使用的并发数
 */
export function calculateActualConcurrency(configuredConcurrency: number): { 
  actualConcurrency: number;
  maxAllowedConcurrency: number;
  cpuCount: number;
  freeMemoryGB: number;
} {
  const cpuCount = os.cpus().length;
  const freeMemoryGB = os.freemem() / (1024 * 1024 * 1024);
  const memoryPerWorker = 0.4; // GB
  const maxByMemory = Math.floor(freeMemoryGB * 0.4 / memoryPerWorker);
  const absoluteMax = 6;
  const calculatedMaxConcurrency = Math.min(cpuCount, maxByMemory, absoluteMax);
  const maxAllowedConcurrency = Math.max(calculatedMaxConcurrency, 2);
  
  let actualConcurrency: number;
  if (configuredConcurrency && configuredConcurrency > 0) {
    actualConcurrency = Math.min(configuredConcurrency, maxAllowedConcurrency);
  } else {
    // 【优化】更保守的默认并发数，避免 CPU 过载
    // Mac M2/M3 等高性能 CPU 也需要限制，避免风扇狂转
    // 使用 CPU 核心数的 1/2，但不超过 4，最少 2
    actualConcurrency = Math.min(Math.max(Math.floor(cpuCount / 2), 2), 4);
  }
  
  return {
    actualConcurrency,
    maxAllowedConcurrency,
    cpuCount,
    freeMemoryGB
  };
}

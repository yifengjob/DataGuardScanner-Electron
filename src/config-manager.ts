import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {app} from 'electron';
import {AppConfig} from './types';
// 【优化】导入配置常量
import {
    DEFAULT_MAX_FILE_SIZE_MB,
    DEFAULT_MAX_PDF_SIZE_MB,
    MEMORY_PER_WORKER_GB,
    CONCURRENCY_ABSOLUTE_MAX,
    CONCURRENCY_MEMORY_RATIO,
    DEFAULT_CONCURRENCY_CPU_RATIO,
    DEFAULT_CONCURRENCY_MAX,
    DEFAULT_CONCURRENCY_MIN,
    BYTES_TO_GB
} from './scan-config';

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
      'C:\\Boot', 'C:\\EFI'
      // 注意：pagefile.sys, hiberfil.sys, swapfile.sys 是文件不是目录，已移除
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
      '/dev'
      // 注意：/Volumes 是外部磁盘挂载点，不应该忽略
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
      // 注意：/mnt, /media, /cdrom 是挂载点，不应该忽略
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
    maxFileSizeMb: DEFAULT_MAX_FILE_SIZE_MB,
    maxPdfSizeMb: DEFAULT_MAX_PDF_SIZE_MB,
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
  const freeMemoryGB = os.freemem() / BYTES_TO_GB;
  const maxByMemory = Math.floor(freeMemoryGB * CONCURRENCY_MEMORY_RATIO / MEMORY_PER_WORKER_GB);
  const calculatedMaxConcurrency = Math.min(cpuCount, maxByMemory, CONCURRENCY_ABSOLUTE_MAX);
  return Math.max(calculatedMaxConcurrency, DEFAULT_CONCURRENCY_MIN);
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
  const freeMemoryGB = os.freemem() / BYTES_TO_GB;
  const maxByMemory = Math.floor(freeMemoryGB * CONCURRENCY_MEMORY_RATIO / MEMORY_PER_WORKER_GB);
  const calculatedMaxConcurrency = Math.min(cpuCount, maxByMemory, CONCURRENCY_ABSOLUTE_MAX);
  const maxAllowedConcurrency = Math.max(calculatedMaxConcurrency, DEFAULT_CONCURRENCY_MIN);
  
  // 【调试】输出详细的计算过程
  console.log(`[并发数计算] CPU: ${cpuCount}核, 可用内存: ${freeMemoryGB.toFixed(1)}GB`);
  console.log(`[并发数计算] 内存限制: ${maxByMemory}, CPU限制: ${cpuCount}, 绝对最大值: ${CONCURRENCY_ABSOLUTE_MAX}`);
  console.log(`[并发数计算] 计算最大值: ${calculatedMaxConcurrency}, 最大允许值: ${maxAllowedConcurrency}`);
  console.log(`[并发数计算] 配置值: ${configuredConcurrency}`);
  
  let actualConcurrency: number;
  if (configuredConcurrency && configuredConcurrency > 0) {
    actualConcurrency = Math.min(configuredConcurrency, maxAllowedConcurrency);
    console.log(`[并发数计算] 使用配置值: min(${configuredConcurrency}, ${maxAllowedConcurrency}) = ${actualConcurrency}`);
  } else {
    // 【优化】更保守的默认并发数，避免 CPU 过载
    // Mac M2/M3 等高性能 CPU 也需要限制，避免风扇狂转
    // 使用 CPU 核心数的比例，但不超过最大值，最少最小值
    actualConcurrency = Math.min(
      Math.max(Math.floor(cpuCount * DEFAULT_CONCURRENCY_CPU_RATIO), DEFAULT_CONCURRENCY_MIN),
      DEFAULT_CONCURRENCY_MAX
    );
    console.log(`[并发数计算] 使用自动计算: min(max(floor(${cpuCount} * ${DEFAULT_CONCURRENCY_CPU_RATIO}), ${DEFAULT_CONCURRENCY_MIN}), ${DEFAULT_CONCURRENCY_MAX}) = ${actualConcurrency}`);
  }
  
  console.log(`[并发数计算] 最终并发数: ${actualConcurrency}`);
  
  return {
    actualConcurrency,
    maxAllowedConcurrency,
    cpuCount,
    freeMemoryGB
  };
}

/**
 * 扫描器配置常量
 * 集中管理所有边界条件、超时时间、内存限制等配置
 */

// ==================== Worker 内存限制 ====================

/** Consumer Worker 最大旧生代内存（MB）- 提高到 768MB，支持超大型文件解析 */
export const WORKER_MAX_OLD_GENERATION_MB = 768;

/** Consumer Worker 最大新生代内存（MB）- 提高到 96MB */
export const WORKER_MAX_YOUNG_GENERATION_MB = 96;

// ==================== 超时时间配置 ====================

/** 文件处理超时 - 小文件 (<1MB) */
export const TIMEOUT_SMALL_FILE = 60000; // 60 秒

/** 文件处理超时 - 中等文件 (1-10MB) */
export const TIMEOUT_MEDIUM_FILE = 60000; // 1 分钟

/** 文件处理超时 - 大文件 (10-50MB) */
export const TIMEOUT_LARGE_FILE = 120000; // 2 分钟

/** 文件处理超时 - 超大文件 (>50MB) */
export const TIMEOUT_HUGE_FILE = 180000; // 3 分钟

/** Worker 线程默认超时（file-worker.ts） */
export const WORKER_DEFAULT_TIMEOUT = 60000; // 60 秒

// ==================== 停滞检测配置 ====================

/** 停滞检测检查间隔（毫秒） */
export const STAGNATION_CHECK_INTERVAL = 5000; // 5 秒

/** 停滞判定阈值（毫秒） */
export const STAGNATION_THRESHOLD = 30000; // 30 秒

/** 兜底超时时间（毫秒）- 保留作为最后保护 */
export const MAX_IDLE_TIME = 120000; // 2 分钟

// ==================== IPC 节流配置 ====================

/** 进度更新节流间隔（毫秒） */
export const PROGRESS_THROTTLE_INTERVAL = 500; // 500ms

// ==================== 日志配置 ====================

/** 日志数组最大长度（防止内存泄漏） */
export const MAX_LOG_ENTRIES = 1000;

// ==================== 取消扫描配置 ====================

/** 取消扫描时最大等待时间（毫秒） */
export const CANCEL_SCAN_MAX_WAIT = 10000; // 10 秒

/** 取消扫描时检查间隔（毫秒） */
export const CANCEL_SCAN_CHECK_INTERVAL = 100; // 100ms

// ==================== Worker 重启配置 ====================

/** Worker 异常退出后重启延迟（毫秒） */
export const WORKER_RESTART_DELAY = 100; // 100ms

// ==================== 预览超时配置 ====================

/** 文件预览超时时间（毫秒） */
export const PREVIEW_TIMEOUT = 30000; // 30 秒

// ==================== 文件大小限制配置 ====================

/** 默认最大文件大小（MB） */
export const DEFAULT_MAX_FILE_SIZE_MB = 50;

/** 默认最大 PDF 文件大小（MB） */
export const DEFAULT_MAX_PDF_SIZE_MB = 100;

// ==================== 窗口配置 ====================

/** 窗口最小宽度（像素） */
export const WINDOW_MIN_WIDTH = 1000;

/** 窗口最小高度（像素） */
export const WINDOW_MIN_HEIGHT = 600;

/** 窗口默认宽度（像素） */
export const WINDOW_DEFAULT_WIDTH = 1024;

/** 窗口默认高度（像素） */
export const WINDOW_DEFAULT_HEIGHT = 768;

/** 窗口目标尺寸比例（屏幕的百分比） */
export const WINDOW_TARGET_RATIO = 0.85;

// ==================== 并发数配置 ====================

/** 每个 Worker 预估内存占用（GB）- 优化为 0.15，SheetJS 非常轻量 */
export const MEMORY_PER_WORKER_GB = 0.15;

/** 并发数绝对最大值 */
export const CONCURRENCY_ABSOLUTE_MAX = 6;

/** 并发数计算时使用的安全内存比例 - 提高到 0.7，充分利用可用内存 */
export const CONCURRENCY_MEMORY_RATIO = 0.7;

/** 默认并发数的 CPU 核心数比例 */
export const DEFAULT_CONCURRENCY_CPU_RATIO = 0.5;

/** 默认并发数最大值 - 优化为 6，充分利用多核性能 */
export const DEFAULT_CONCURRENCY_MAX = 6;

/** 默认并发数最小值 */
export const DEFAULT_CONCURRENCY_MIN = 2;

// ==================== 缓存清理配置 ====================

/** 日志文件保留天数 */
export const LOG_RETENTION_DAYS = 30;

// ==================== 单位转换常量 ====================

/** 字节到 MB 的转换因子 */
export const BYTES_TO_MB = 1024 * 1024;

/** 字节到 GB 的转换因子 */
export const BYTES_TO_GB = 1024 * 1024 * 1024;

/** 毫秒到天的转换因子 */
export const MS_TO_DAYS = 1000 * 60 * 60 * 24;

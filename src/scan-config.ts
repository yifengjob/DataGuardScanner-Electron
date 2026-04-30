/**
 * 扫描器配置常量
 * 集中管理所有边界条件、超时时间、内存限制等配置
 */

// ==================== Worker 内存限制 ====================

/** Consumer Worker 最大旧生代内存（MB） */
export const WORKER_MAX_OLD_GENERATION_MB = 256;

/** Consumer Worker 最大新生代内存（MB） */
export const WORKER_MAX_YOUNG_GENERATION_MB = 32;

// ==================== 超时时间配置 ====================

/** 文件处理超时 - 小文件 (<1MB) */
export const TIMEOUT_SMALL_FILE = 30000; // 30 秒

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

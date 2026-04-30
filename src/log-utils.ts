/**
 * 日志工具 - 统一处理日志过滤和抑制
 */

// 【优化】抑制 pdfjs-dist 的字体警告
// 这些警告不影响文本提取，但会污染日志
const PDFJS_WARN_PATTERNS = [
  'Warning: TT: undefined function',
  'Warning: Ran out of space in font private use area'
];

/**
 * 创建抑制特定警告的 console.warn 包装器
 * @param patterns 要抑制的警告模式数组
 * @returns 原始的 console.warn 函数（用于恢复）
 */
export function suppressWarnings(patterns: string[]): () => void {
  const originalWarn = console.warn;
  
  console.warn = function(...args: any[]) {
    const message = args.join(' ');
    
    // 检查是否匹配任何抑制模式
    const shouldSuppress = patterns.some(pattern => message.includes(pattern));
    
    if (shouldSuppress) {
      return; // 静默丢弃
    }
    
    originalWarn.apply(console, args);
  };
  
  // 返回恢复函数
  return () => {
    console.warn = originalWarn;
  };
}

/**
 * 初始化默认的日志抑制规则
 * 应该在应用启动时调用一次
 */
export function initLogSuppression(): void {
  suppressWarnings(PDFJS_WARN_PATTERNS);
}

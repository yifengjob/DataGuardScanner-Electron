/**
 * 日志工具 - 统一处理日志过滤和抑制
 * 
 * 【重要】此模块必须在其他任何模块导入之前被导入和执行
 * 因为我们需要在 pdfjs-dist 等库加载之前就设置好过滤规则
 */

// 【优化】需要抑制的警告模式
const SUPPRESS_PATTERNS = [
  // pdfjs-dist 的字体警告
  'Warning: TT: undefined function',
  'Warning: Ran out of space in font private use area',
];

// 【关键】立即执行抑制逻辑（在模块加载时就执行）
const originalWarn = console.warn;
console.warn = function(...args: any[]) {
  const message = args.join(' ');
  
  // 检查是否匹配任何抑制模式
  const shouldSuppress = SUPPRESS_PATTERNS.some(pattern => message.includes(pattern));
  
  if (shouldSuppress) {
    return; // 静默丢弃
  }
  
  originalWarn.apply(console, args);
};

// 【新增】拦截 process.stderr.write，彻底抑制 PDF 字体警告
const originalStderrWrite = process.stderr.write.bind(process.stderr);
(process.stderr as any).write = function(chunk: any, ...args: any[]) {
  if (typeof chunk === 'string') {
    const shouldSuppress = SUPPRESS_PATTERNS.some(pattern => chunk.includes(pattern));
    if (shouldSuppress) {
      return true; // 抑制输出
    }
  }
  return originalStderrWrite(chunk, ...args);
};

/**
 * 添加额外的抑制模式
 * @param patterns 要抑制的警告模式数组
 */
export function addSuppressPatterns(patterns: string[]): void {
  SUPPRESS_PATTERNS.push(...patterns);
}

/**
 * 恢复原始的 console.warn（用于调试）
 */
export function restoreConsoleWarn(): void {
  console.warn = originalWarn;
}

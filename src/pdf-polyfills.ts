/**
 * PDF.js 浏览器环境 Polyfill
 * 
 * pdf.js 3.x legacy build 在 Node.js 环境中需要浏览器全局对象
 * 此模块提供完整的 polyfill，确保 pdf.js 能正常工作
 */

/**
 * 为 pdf.js 设置浏览器环境 polyfill
 * 必须在加载 pdf.js 之前调用
 * 
 * @param context - 全局对象上下文（默认为 global）
 */
export function setupPdfJsPolyfills(context: any = global): void {
  // 如果已经设置过，跳过
  if (typeof context.window !== 'undefined') {
    return;
  }

  try {
    // 模拟 window 对象
    context.window = context;

    // DOMException（pdf.js 需要）
    if (typeof context.DOMException === 'undefined') {
      context.DOMException = class DOMException extends Error {
        constructor(message?: string, name?: string) {
          super(message);
          this.name = name || 'DOMException';
        }
      };
    }

    // ReadableStream（pdf.js 需要）
    if (typeof context.ReadableStream === 'undefined') {
      try {
        const { ReadableStream } = require('stream/web');
        context.ReadableStream = ReadableStream;
      } catch (e) {
        // 在开发环境下输出警告，帮助诊断问题
        if (process.env.NODE_ENV === 'development') {
          console.warn('[PDF Polyfill] ReadableStream 不可用，pdf.js 可能无法正常工作');
        }
      }
    }

    // 模拟 document 对象
    context.document = {
      documentElement: { style: {} },
      createElement: () => ({ style: {}, getContext: () => null }),
      createTextNode: () => ({}),
    };

    // 模拟 navigator 对象
    context.navigator = { userAgent: 'Node.js' };

    // 模拟 HTMLElement 类
    context.HTMLElement = class HTMLElement {};
  } catch (error) {
    console.error('[PDF Polyfill] 设置失败:', error);
    throw error;
  }
}

/**
 * 初始化 DOMMatrix（用于 PDF 渲染）
 * 
 * @param context - 全局对象上下文（默认为 global）
 */
export function setupDomMatrix(context: any = global): void {
  if (typeof context.DOMMatrix !== 'undefined') {
    return; // 已存在，跳过
  }

  try {
    const { DOMMatrix } = require('@napi-rs/canvas');
    context.DOMMatrix = DOMMatrix;
  } catch (error) {
    // 静默失败，让 pdf.js 自己处理
  }
}

/**
 * 初始化 Promise.withResolvers polyfill
 * （某些旧版本 Node.js 或库可能需要）
 * 
 * @param context - 全局对象上下文（默认为 global）
 */
export function setupPromiseWithResolvers(context: any = global): void {
  if (typeof (context.Promise as any).withResolvers !== 'undefined') {
    return; // 已存在，跳过
  }

  (context.Promise as any).withResolvers = function() {
    let resolve: any, reject: any;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/**
 * 一次性设置所有 PDF 相关的 polyfill
 * 推荐在应用启动时调用
 * 
 * @param context - 全局对象上下文（默认为 global）
 */
export function setupAllPdfPolyfills(context: any = global): void {
  try {
    setupPromiseWithResolvers(context);
    setupDomMatrix(context);
    setupPdfJsPolyfills(context);
  } catch (error) {
    console.error('[PDF Polyfill] 设置失败:', error);
    throw error;
  }
}

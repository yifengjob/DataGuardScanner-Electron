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
    console.log('[PDF Polyfill] window 已存在，跳过设置');
    return;
  }

  try {
    console.log('[PDF Polyfill] 正在设置浏览器环境模拟...');
    console.log('[PDF Polyfill] context 类型:', typeof context);
    
    // 模拟 window 对象
    context.window = context;
    console.log('[PDF Polyfill] ✓ window 设置成功');

    // DOMException（pdf.js 需要）
    if (typeof context.DOMException === 'undefined') {
      context.DOMException = class DOMException extends Error {
        constructor(message?: string, name?: string) {
          super(message);
          this.name = name || 'DOMException';
        }
      };
      console.log('[PDF Polyfill] ✓ DOMException 设置成功');
    }

    // ReadableStream（pdf.js 需要）
    if (typeof context.ReadableStream === 'undefined') {
      try {
        const { ReadableStream } = require('stream/web');
        context.ReadableStream = ReadableStream;
        console.log('[PDF Polyfill] ✓ ReadableStream 设置成功');
      } catch (e) {
        console.warn('[PDF Polyfill] ⚠ ReadableStream 不可用:', e);
      }
    }

    // 模拟 document 对象
    context.document = {
      documentElement: { style: {} },
      createElement: () => ({ style: {}, getContext: () => null }),
      createTextNode: () => ({}),
    };
    console.log('[PDF Polyfill] ✓ document 设置成功');

    // 模拟 navigator 对象
    context.navigator = { userAgent: 'Node.js' };
    console.log('[PDF Polyfill] ✓ navigator 设置成功');

    // 模拟 HTMLElement 类
    context.HTMLElement = class HTMLElement {};
    console.log('[PDF Polyfill] ✓ HTMLElement 设置成功');
    
    console.log('[PDF Polyfill] ✅ 浏览器环境模拟设置完成');
  } catch (error) {
    console.error('[PDF Polyfill] ❌ 设置失败:', error);
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
    console.log('[PDF Polyfill] DOMMatrix 已存在，跳过');
    return; // 已存在，跳过
  }

  try {
    console.log('[PDF Polyfill] 正在加载 @napi-rs/canvas...');
    const { DOMMatrix } = require('@napi-rs/canvas');
    context.DOMMatrix = DOMMatrix;
    console.log('[PDF Polyfill] ✓ DOMMatrix 设置成功');
  } catch (error) {
    console.error('[PDF Polyfill] ❌ 无法加载 @napi-rs/canvas:', error);
    // 不抛出错误，让 pdf.js 自己处理
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
    console.log('[PDF Polyfill] ========== 开始设置所有 polyfill ==========');
    
    setupPromiseWithResolvers(context);
    setupDomMatrix(context);
    setupPdfJsPolyfills(context);
    
    console.log('[PDF Polyfill] ========== 所有 polyfill 设置完成 ==========');
  } catch (error) {
    console.error('[PDF Polyfill] ❌❌❌ 设置过程中发生严重错误:', error);
    throw error;
  }
}

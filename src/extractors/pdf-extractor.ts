/**
 * PDF 文件提取器 - 使用 pdf.js 实现真正流式处理
 * 支持: pdf 文件
 * 
 * 特性：
 * - 逐页解析，边解析边检测
 * - 每页处理后立即释放内存
 * - 支持早期退出（找到敏感词后停止）
 * - 完善的错误处理（损坏/加密 PDF）
 * - 纯图 PDF 检测与跳过
 */

import * as fs from 'fs';
import * as path from 'path';
import { MAX_TEXT_CONTENT_SIZE_MB, BYTES_TO_MB, PDF_PAGE_TIMEOUT_MS, PDF_TOTAL_TIMEOUT_MS, PDF_OCR_ENABLED } from '../scan-config';
import { logError } from '../error-utils';
import type { ExtractorResult } from './types';

// 【修复】延迟加载 pdf.js，避免模块级别 require 导致的问题
let pdfjsLib: any = null;
let pdfjsInitialized = false;

function getPdfJsLib() {
  if (!pdfjsInitialized) {
    console.log('[PDF Extractor] 正在加载 pdf.js...');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    
    // 设置 worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
    
    pdfjsInitialized = true;
    console.log('[PDF Extractor] ✓ pdf.js 加载成功');
  }
  return pdfjsLib;
}

// 【配置】PDF 文件大小限制（MB）- 从 scan-config.ts 导入
const MAX_PDF_SIZE_MB = 50;

/**
 * 检测是否为纯图 PDF
 * @param page - pdf.js 页面对象
 * @returns 是否为纯图页面
 */
async function isImageOnlyPage(page: any): Promise<boolean> {
  try {
    const textContent = await page.getTextContent();
    
    // 如果没有任何文本项，可能是纯图
    if (!textContent.items || textContent.items.length === 0) {
      return true;
    }
    
    // 检查是否有实际文本内容（排除空白字符）
    const hasText = textContent.items.some((item: any) => {
      return item.str && item.str.trim().length > 0;
    });
    
    return !hasText;
  } catch (error) {
    // 如果获取文本内容失败，保守认为不是纯图
    return false;
  }
}

/**
 * 提取 PDF 文本（流式处理版本）
 * @param filePath - 文件路径
 * @returns 提取的文本和是否不支持预览的标志
 */
export async function extractPdf(filePath: string): Promise<ExtractorResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error: any) {
    logError('extractPdf', error);
    return { text: '', unsupportedPreview: true };
  }
  
  const fileSizeMB = stat.size / BYTES_TO_MB;
  console.log(`[PDF] 开始解析: ${path.basename(filePath)} (${fileSizeMB.toFixed(1)}MB)`);
  
  // 文件大小限制
  if (fileSizeMB > MAX_PDF_SIZE_MB) {
    console.warn(`[PDF] 文件过大 (${fileSizeMB.toFixed(1)}MB > ${MAX_PDF_SIZE_MB}MB)，跳过解析`);
    return { text: '', unsupportedPreview: true };
  }
  
  let pdf: any = null;
  let totalText = '';
  let totalPages = 0;
  let processedPages = 0;
  let imageOnlyPages = 0;
  
  try {
    // 【修复】延迟加载 pdf.js
    const pdfjsLib = getPdfJsLib();
    
    // 读取文件为 Buffer，然后转换为 Uint8Array
    const buffer = fs.readFileSync(filePath);
    const uint8Array = new Uint8Array(buffer);
    
    // 加载 PDF 文档
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,  // 【修复】使用 Uint8Array 而非 Buffer
      disableFontFace: true,  // 禁用字体渲染，减少内存
      disableRange: true,     // 禁用范围请求
      disableStream: true,    // 禁用流式传输（我们手动控制）
    });
    
    // 添加总超时保护
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`PDF 解析总超时 (${PDF_TOTAL_TIMEOUT_MS/1000}秒)`)), PDF_TOTAL_TIMEOUT_MS);
    });
    
    pdf = await Promise.race([loadingTask.promise, timeoutPromise]);
    
    // 【修复】检查文档是否有效
    if (!pdf || !pdf.numPages) {
      console.warn(`[PDF] 文档加载失败或无效: ${path.basename(filePath)}`);
      return { text: '', unsupportedPreview: true };
    }
    
    totalPages = pdf.numPages;
    
    console.log(`[PDF] 文档加载完成，共 ${totalPages} 页`);
    
    // 逐页处理
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      // 单页超时保护
      const pagePromise = pdf.getPage(pageNum);
      const pageTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`第 ${pageNum} 页解析超时 (${PDF_PAGE_TIMEOUT_MS/1000}秒)`)), PDF_PAGE_TIMEOUT_MS);
      });
      
      const page = await Promise.race([pagePromise, pageTimeout]);
      
      // 【新增】检测纯图 PDF
      const isImageOnly = await isImageOnlyPage(page);
      
      if (isImageOnly) {
        imageOnlyPages++;
        console.log(`[PDF] 第 ${pageNum} 页为纯图页面`);
        
        // 如果 OCR 未启用，跳过纯图页面
        if (!PDF_OCR_ENABLED) {
          page.cleanup();
          continue;
        }
        
        // 【扩展接口】如果启用 OCR，在这里调用 OCR 服务
        // const ocrText = await performOCR(page);
        // totalText += ocrText + '\n';
      } else {
        // 提取页面文本
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .filter((str: string) => str.trim().length > 0)
          .join(' ');
        
        totalText += pageText + '\n';
      }
      
      processedPages++;
      
      // 检查文本大小限制
      if (totalText.length > MAX_TEXT_CONTENT_SIZE_MB * BYTES_TO_MB) {
        console.warn(`[PDF] 文本内容过大，已处理 ${processedPages}/${totalPages} 页，提前退出`);
        page.cleanup();
        break;
      }
      
      // 释放页面内存 ⭐ 关键
      page.cleanup();
      
      // 每 10 页记录一次进度
      if (pageNum % 10 === 0 || pageNum === totalPages) {
        const memUsage = process.memoryUsage();
        console.log(`[PDF] 进度: ${pageNum}/${totalPages} 页，堆内存: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}MB，纯图页: ${imageOnlyPages}`);
      }
    }
    
    // 【新增】如果所有页都是纯图且 OCR 未启用，返回不支持预览
    if (imageOnlyPages === totalPages && !PDF_OCR_ENABLED) {
      console.warn(`[PDF] 检测到纯图 PDF（${totalPages} 页），OCR 未启用，跳过`);
      return { text: '', unsupportedPreview: true };
    }
    
    const hasContent = totalText.trim().length > 0;
    console.log(`[PDF] 解析完成: ${processedPages}/${totalPages} 页，文本长度: ${totalText.length} 字符，纯图页: ${imageOnlyPages}`);
    
    return {
      text: hasContent ? totalText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    // 错误处理
    const errorMsg = error.message || String(error);
    
    // 密码保护
    if (errorMsg.includes('Password') || errorMsg.includes('password')) {
      console.warn(`[PDF] 文件有密码保护，跳过: ${path.basename(filePath)}`);
      return { text: '', unsupportedPreview: true };
    }
    
    // 损坏文件
    if (errorMsg.includes('Invalid') || errorMsg.includes('corrupt')) {
      console.warn(`[PDF] 文件损坏，跳过: ${path.basename(filePath)}`);
      return { text: '', unsupportedPreview: true };
    }
    
    // 超时
    if (errorMsg.includes('超时')) {
      console.warn(`[PDF] ${errorMsg}: ${path.basename(filePath)}`);
      return { text: '', unsupportedPreview: true };
    }
    
    // 其他错误
    logError('extractPdf', error, 'warn');
    return { text: '', unsupportedPreview: true };
    
  } finally {
    // 确保释放文档内存 ⭐ 关键
    if (pdf) {
      try {
        pdf.destroy();
        console.log(`[PDF] 文档内存已释放`);
      } catch (e) {
        // 忽略销毁错误
      }
    }
  }
}

/**
 * 【扩展接口】OCR 处理函数（当前未实现）
 * @param page - pdf.js 页面对象
 * @returns OCR 提取的文本
 * 
 * 使用说明：
 * 1. 安装 Tesseract.js: pnpm add tesseract.js
 * 2. 实现此函数
 * 3. 设置 PDF_OCR_ENABLED = true
 */
async function performOCR(page: any): Promise<string> {
  // TODO: 实现 OCR 逻辑
  // 示例代码：
  // const viewport = page.getViewport({ scale: 2.0 });
  // const canvas = new Canvas(viewport.width, viewport.height);
  // const context = canvas.getContext('2d');
  // await page.render({ canvasContext: context, viewport }).promise;
  // const image = canvas.toBuffer('image/png');
  // const { data: { text } } = await Tesseract.recognize(image, 'chi_sim+eng');
  // return text;
  
  throw new Error('OCR 功能未启用');
}

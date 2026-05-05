/**
 * PDF 文件提取器 - 使用 pdfreader 流式解析
 * 支持: pdf 文件
 */

import * as fs from 'fs';
import * as path from 'path';
import { PdfReader } from 'pdfreader';
import { MAX_TEXT_CONTENT_SIZE_MB, BYTES_TO_MB, calculateParserTimeout } from '../scan-config';
import { logError } from '../error-utils';
import type { ExtractorResult } from './types';

export async function extractPdf(filePath: string): Promise<ExtractorResult> {
  // 【关键修复】先获取文件大小，计算智能超时
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error: any) {
    logError('extractPdf', error);
    return { text: '', unsupportedPreview: true };
  }
  
  const timeoutMs = calculateParserTimeout(stat.size);
  let isResolved = false;
  
  return new Promise((resolve, reject) => {
    const textChunks: string[] = [];
    let totalLength = 0;
    const maxTextLength = MAX_TEXT_CONTENT_SIZE_MB * BYTES_TO_MB;
    
    // 【关键修复】添加智能超时保护，防止 pdfreader 卡死
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.warn(`[extractPdf] PDF 解析超时 (${timeoutMs/1000}秒)，跳过: ${path.basename(filePath)}`);
        resolve({ text: '', unsupportedPreview: true });
      }
    }, timeoutMs);
    
    try {
      new PdfReader().parseFileItems(filePath, (err, item) => {
        if (isResolved) return;
        
        if (err) {
          // 解析错误（包括密码保护等）
          clearTimeout(timeoutId);
          isResolved = true;
          
          // 【关键修复】检测密码保护异常
          const errorMsg = typeof err === 'string' ? err : ((err as any).message || String(err));
          if (errorMsg.includes('Password') || errorMsg.includes('password')) {
            console.warn(`[extractPdf] PDF 有密码保护，跳过: ${path.basename(filePath)}`);
          } else {
            logError('extractPdf', err, 'warn');
          }
          
          resolve({ text: '', unsupportedPreview: true });
        } else if (!item) {
          // EOF - 解析完成
          clearTimeout(timeoutId);
          isResolved = true;
          const text = textChunks.join('\n');
          const hasContent = text.trim().length > 0;
          resolve({
            text: hasContent ? text : '',
            unsupportedPreview: !hasContent
          });
        } else if (item.text) {
          // 累积文本
          totalLength += item.text.length;
          
          // 检查文本大小限制，防止 OOM
          if (totalLength > maxTextLength) {
            clearTimeout(timeoutId);
            console.warn(`[extractPdf] PDF 文本内容过大 (${(totalLength / BYTES_TO_MB).toFixed(1)}MB)，跳过解析: ${path.basename(filePath)}`);
            isResolved = true;
            resolve({ text: '', unsupportedPreview: true });
            return;
          }
          
          textChunks.push(item.text);
        }
        // 忽略其他类型的 item（如 page、file 等）
      });
    } catch (error: any) {
      // 【关键修复】捕获同步抛出的异常（如 PasswordException）
      clearTimeout(timeoutId);
      if (!isResolved) {
        isResolved = true;
        const errorMsg = error.message || String(error);
        if (errorMsg.includes('Password') || errorMsg.includes('password')) {
          console.warn(`[extractPdf] PDF 有密码保护，跳过: ${path.basename(filePath)}`);
        } else {
          logError('extractPdf', error, 'warn');
        }
        resolve({ text: '', unsupportedPreview: true });
      }
    }
  });
}

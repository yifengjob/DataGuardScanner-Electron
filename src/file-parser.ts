// 【关键】首先导入日志抑制工具（必须在任何其他导入之前）
import './log-utils';

import * as path from 'path';
// 【重构】从 extractors 模块导入所有提取器
import {
  extractTextFile,
  extractXmlFile,
  extractPdf,
  extractWithWordExtractor,
  extractWithSheetJS,
  extractPptx,
  extractWithBinary,
  extractOdt,
  extractOds,
  extractOdp,
  extractRtf,
  type ExtractorFunction
} from './extractors';
// 【D3 优化】导入错误处理工具
import { logError } from './error-utils';

// 【重构】文件类型到处理函数的映射（单一数据源）
const EXTRACTOR_MAP: Record<string, ExtractorFunction> = {
  // 文本文件
  'txt': extractTextFile,
  'log': extractTextFile,
  'md': extractTextFile,
  'ini': extractTextFile,
  'conf': extractTextFile,
  'cfg': extractTextFile,
  'env': extractTextFile,
  'js': extractTextFile,
  'ts': extractTextFile,
  'py': extractTextFile,
  'java': extractTextFile,
  'c': extractTextFile,
  'cpp': extractTextFile,
  'go': extractTextFile,
  'rs': extractTextFile,
  'php': extractTextFile,
  'rb': extractTextFile,
  'swift': extractTextFile,
  'html': extractTextFile,
  'htm': extractTextFile,
  'sh': extractTextFile,
  'cmd': extractTextFile,
  'bat': extractTextFile,
  'csv': extractTextFile,
  'json': extractTextFile,
  'xml': extractXmlFile,
  'yaml': extractTextFile,
  'yml': extractTextFile,
  'properties': extractTextFile,
  'toml': extractTextFile,
  // PDF
  'pdf': extractPdf,
  // Word 文档
  'docx': extractWithWordExtractor,
  'doc': extractWithWordExtractor,
  'wps': extractWithWordExtractor,
  'dps': extractWithBinary,
  // Excel 表格
  'xlsx': extractWithSheetJS,
  'xls': extractWithSheetJS,
  'et': extractWithSheetJS,
  // PowerPoint
  'pptx': extractPptx,
  'ppt': extractWithBinary,
  // OpenDocument
  'odt': extractOdt,
  'ods': extractOds,
  'odp': extractOdp,
  // RTF
  'rtf': extractRtf,
};

// 从 EXTRACTOR_MAP 自动生成支持的文件类型列表
export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTOR_MAP);

/**
 * 从文件中提取文本的主入口函数
 * @param filePath - 文件路径
 * @returns 提取的文本和是否不支持预览的标志
 */
export async function extractTextFromFile(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  const ext = path.extname(filePath).toLowerCase().substring(1); // 移除开头的点
  
  try {
    // 不支持预览的文件类型（压缩文件等）
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return { text: '', unsupportedPreview: true };
    }
    
    // 使用映射表查找处理函数
    const extractor = EXTRACTOR_MAP[ext];
    if (extractor) {
      return await extractor(filePath);
    }
    
    // 不支持的文件类型
    return { text: '', unsupportedPreview: true };
  } catch (error: any) {
    logError('extractTextFromFile', error);
    throw error;
  }
}

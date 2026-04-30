import * as fs from 'fs';
import * as path from 'path';
// 【重构】使用 @jose.espana/docstream 统一解析所有 Office 文档格式
import docstream from '@jose.espana/docstream';

// 【新增】文件类型到处理函数的映射（单一数据源，便于维护）
type ExtractorFunction = (filePath: string) => Promise<{ text: string; unsupportedPreview: boolean }>;

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
  'xml': extractTextFile,
  'yaml': extractTextFile,
  'yml': extractTextFile,
  'properties': extractTextFile,
  'toml': extractTextFile,
  // 【重构】所有 Office 文档和 PDF 统一使用 docstream 解析
  'pdf': extractWithDocstream,
  'docx': extractWithDocstream,
  'doc': extractWithDocstream,
  'wps': extractWithDocstream,
  'xlsx': extractWithDocstream,
  'xls': extractWithDocstream,
  'et': extractWithDocstream,
  'pptx': extractWithDocstream,
  'ppt': extractWithDocstream,
  'dps': extractWithDocstream,
  'odt': extractWithDocstream,
  'ods': extractWithDocstream,
  'odp': extractWithDocstream,
  'rtf': extractWithDocstream,
};

// 【优化】从 EXTRACTOR_MAP 自动生成支持的文件类型列表（单一数据源）
export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTOR_MAP);

export async function extractTextFromFile(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  const ext = path.extname(filePath).toLowerCase().substring(1); // 移除开头的点
  
  try {
    // 不支持预览的文件类型（压缩文件等）
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
      return { text: '', unsupportedPreview: true };
    }
    
    // 【优化】使用映射表查找处理函数，避免冗长的 switch 语句
    const extractor = EXTRACTOR_MAP[ext];
    if (extractor) {
      return await extractor(filePath);
    }
    
    // 不支持的文件类型
    return { text: '', unsupportedPreview: true };
  } catch (error: any) {
    console.error(`解析文件失败 ${filePath}:`, error);
    throw new Error(`文件解析失败: ${error.message}`);
  }
}

async function extractTextFile(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { text: content, unsupportedPreview: false };
  } catch (error: any) {
    // 【修复】Windows 文件锁定或其他读取错误
    console.error(`读取文本文件失败 ${filePath}:`, error.message);
    throw new Error(`无法读取文件: ${error.message}`);
  }
}

// 【重构】统一使用 docstream 解析 Office 文档和 PDF
async function extractWithDocstream(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 使用 docstream 解析文件（支持 Buffer 输入）
    const ast = await docstream.parseOffice(filePath);
    
    // 提取纯文本
    const text = ast.toText();
    
    // 检查是否有实质性内容
    const hasContent = text && text.trim().length > 0;
    
    return {
      text: hasContent ? text : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    // docstream 解析失败，记录错误
    console.error(`docstream解析失败 ${filePath}:`, error.message);
    
    // 降级到二进制提取作为备选方案
    try {
      const data = await fs.promises.readFile(filePath);
      const text = extractTextFromBinary(data);
      if (text.trim()) {
        return { text, unsupportedPreview: false };
      }
    } catch (e: any) {
      console.error(`二进制提取也失败 ${filePath}:`, e.message);
    }
    
    return { text: '', unsupportedPreview: true };
  }
}

// 从二进制数据中提取可打印文本
function extractTextFromBinary(data: Buffer): string {
  let result = '';
  let currentText = '';
  const minTextLength = 4; // 最少连续字符数
  
  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    
    // 检查是否是可打印字符（ASCII 32-126 或常见中文字符范围）
    if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
      currentText += String.fromCharCode(byte);
    } else {
      // 非可打印字符，检查累积的文本是否足够长
      if (currentText.length >= minTextLength) {
        const cleaned = currentText.trim();
        if (cleaned) {
          result += cleaned + '\n';
        }
      }
      currentText = '';
    }
  }
  
  // 处理最后的文本块
  if (currentText.length >= minTextLength) {
    const cleaned = currentText.trim();
    if (cleaned) {
      result += cleaned;
    }
  }
  
  // 过滤掉太短的行
  return result.split('\n')
      .filter(line => line.length > 2)
      .join('\n');
}

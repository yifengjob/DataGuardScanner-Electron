import * as fs from 'fs';
import * as path from 'path';
// 【重构】弃用 docstream，使用专门的库解析不同格式
import mammoth from 'mammoth';  // .docx
// 【修复】PDF 使用专门的 pdf-parse 库，避免 pdfjs-dist 的 Worker 问题
import pdfParse from 'pdf-parse';
// 【新增】SheetJS 用于快速解析 Excel 文件
import * as XLSX from 'xlsx';
// 【新增】adm-zip 用于解压 .pptx 文件
import AdmZip from 'adm-zip';

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
  // 【修复】PDF 使用专门的 pdf-parse 库
  'pdf': extractPdf,
  // 【优化】Word 文档使用 mammoth（快速、稳定）
  'docx': extractWithMammoth,
  'doc': extractWithBinary,  // .doc 降级到二进制提取
  'wps': extractWithBinary,
  // 【优化】Excel 文件使用 SheetJS，速度更快且不会内存溢出
  'xlsx': extractWithSheetJS,
  'xls': extractWithSheetJS,
  'et': extractWithSheetJS,
  // 【优化】PPT 文件使用自定义解压方案
  'pptx': extractPptx,
  'ppt': extractWithBinary,  // .ppt 降级到二进制提取
  'dps': extractWithBinary,
  // OpenDocument 格式降级到二进制提取
  'odt': extractWithBinary,
  'ods': extractWithBinary,
  'odp': extractWithBinary,
  'rtf': extractWithBinary,
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

// 【修复】PDF 使用 pdf-parse 库解析，避免 docstream 的 pdfjs-dist Worker 问题
async function extractPdf(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const dataBuffer = await fs.promises.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    
    const hasContent = data.text && data.text.trim().length > 0;
    
    return {
      text: hasContent ? data.text : '',
      unsupportedPreview: !hasContent
    };
  } catch (error: any) {
    // PDF 解析失败是正常现象（文件损坏或格式不支持），静默处理
    console.error(`PDF解析失败 ${filePath}:`, error.message);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】使用 mammoth 解析 .docx 文件
async function extractWithMammoth(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 读取文件
    const data = await fs.promises.readFile(filePath);
    
    // 使用 mammoth 提取文本
    const result = await mammoth.extractRawText({ buffer: data });
    
    const text = result.value || '';
    const hasContent = text && text.trim().length > 0;
    
    // 【优化】只有当无法提取文本时才输出警告
    if (!hasContent && result.messages && result.messages.length > 0) {
      console.warn(`mammoth 解析失败 ${filePath}:`, result.messages[0].message);
    }
    
    return {
      text: hasContent ? text : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`mammoth解析失败 ${filePath}:`, error.message);
    
    // 降级到二进制提取
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

// 【新增】使用自定义方案解析 .pptx 文件
async function extractPptx(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 读取文件
    const data = await fs.promises.readFile(filePath);
    
    // 使用 adm-zip 解压
    const zip = new AdmZip(data);
    const zipEntries = zip.getEntries();
    
    let allText = '';
    
    // 查找所有幻灯片 XML 文件
    for (const entry of zipEntries) {
      const entryName = entry.entryName;
      
      // PPTX 的幻灯片内容在 ppt/slides/slide*.xml 中
      if (entryName.startsWith('ppt/slides/slide') && entryName.endsWith('.xml')) {
        try {
          const xmlContent = entry.getData().toString('utf-8');
          
          // 简单提取 <a:t> 标签中的文本（PowerPoint 的文本格式）
          const textMatches = xmlContent.match(/<a:t[^>]*>([^<]*)<\/a:t>/g);
          if (textMatches) {
            const texts = textMatches.map((match: string) => {
              const content = match.match(/<a:t[^>]*>([^<]*)<\/a:t>/);
              return content ? content[1] : '';
            }).filter((t: string) => t.trim());
            
            if (texts.length > 0) {
              allText += '\n' + texts.join(' ');
            }
          }
        } catch (e) {
          // 忽略单个幻灯片的解析错误
        }
      }
    }
    
    const hasContent = allText && allText.trim().length > 0;
    
    return {
      text: hasContent ? allText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`PPTX解析失败 ${filePath}:`, error.message);
    
    // 降级到二进制提取
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

// 【新增】使用 SheetJS 快速解析 Excel 文件
async function extractWithSheetJS(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 读取文件
    const data = await fs.promises.readFile(filePath);
    
    // 使用 SheetJS 解析工作簿
    const workbook = XLSX.read(data, {
      type: 'buffer',
      cellText: true,
      cellDates: true,
    });
    
    // 提取所有工作表的文本
    let allText = '';
    
    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      
      // 将工作表转换为 CSV 格式（保留换行）
      const csv = XLSX.utils.sheet_to_csv(worksheet, {
        FS: '\t', // 字段分隔符：制表符
        RS: '\n', // 记录分隔符：换行符
      });
      
      if (csv && csv.trim()) {
        allText += `\n=== ${sheetName} ===\n${csv}\n`;
      }
    }
    
    // 检查是否有实质性内容
    const hasContent = allText && allText.trim().length > 0;
    
    return {
      text: hasContent ? allText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`SheetJS解析失败 ${filePath}:`, error.message);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】二进制提取（用于 .doc、.ppt 等旧格式）
async function extractWithBinary(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const data = await fs.promises.readFile(filePath);
    const text = extractTextFromBinary(data);
    
    const hasContent = text && text.trim().length > 0;
    
    return {
      text: hasContent ? text : '',
      unsupportedPreview: !hasContent
    };
  } catch (error: any) {
    console.error(`二进制提取失败 ${filePath}:`, error.message);
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

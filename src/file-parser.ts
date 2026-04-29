import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import pdfParse from 'pdf-parse';

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
  // PDF
  'pdf': extractPdf,
  // Office 文档（新版）
  'xlsx': extractExcel,
  'xls': extractExcel,
  'et': extractExcel,
  'docx': (filePath: string) => extractDocxPptx(filePath, 'docx'),
  'pptx': (filePath: string) => extractDocxPptx(filePath, 'pptx'),
  // Office 文档（旧版）
  'doc': (filePath: string) => extractOldOffice(filePath, 'doc'),
  'wps': (filePath: string) => extractOldOffice(filePath, 'wps'),
  'ppt': (filePath: string) => extractOldOffice(filePath, 'ppt'),
  'dps': (filePath: string) => extractOldOffice(filePath, 'dps'),
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
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return { text: content, unsupportedPreview: false };
}

async function extractPdf(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const dataBuffer = await fs.promises.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return { text: data.text, unsupportedPreview: false };
  } catch (error) {
    // PDF 解析失败是正常现象（文件损坏或格式不支持），静默处理
    // 如果需要调试，可以取消下面的注释
    // console.error('PDF解析失败:', filePath, error);
    return { text: '', unsupportedPreview: true };
  }
}

async function extractExcel(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    
    let text = '';
    
    // 遍历所有工作表
    workbook.eachSheet((worksheet, sheetId) => {
      worksheet.eachRow((row, rowNumber) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          let cellValue = '';
          
          if (cell.value) {
            // 处理不同类型的单元格值
            if (typeof cell.value === 'object') {
              // 富文本类型
              if ((cell.value as any).richText) {
                cellValue = (cell.value as any).richText
                  .map((r: any) => r.text || '')
                  .join('');
              }
              // 公式结果
              else if ((cell.value as any).result !== undefined) {
                cellValue = String((cell.value as any).result);
              }
              // 其他对象类型，尝试获取text属性
              else if ((cell.value as any).text) {
                cellValue = String((cell.value as any).text);
              }
              // 默认转换为字符串
              else {
                cellValue = String(cell.value);
              }
            } else {
              // 基本类型（string, number, boolean, date）
              cellValue = String(cell.value);
            }
          }
          
          cells.push(cellValue);
        });
        text += cells.join('\t') + '\n';
      });
      text += '---\n';
    });
    
    return { text, unsupportedPreview: false };
  } catch (error: any) {
    // Excel解析失败，尝试二进制文本提取（静默处理）
    try {
      const data = await fs.promises.readFile(filePath);
      const text = extractTextFromBinary(data);
      if (text.trim()) {
        return { text, unsupportedPreview: false };
      }
    } catch (e) {
      // 忽略二级错误
    }
    return { text: '', unsupportedPreview: true };
  }
}

// 提取 docx/pptx 文件内容
async function extractDocxPptx(filePath: string, ext: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 读取文件到内存
    const zipBuffer = await fs.promises.readFile(filePath);
    
    // 使用 adm-zip 在内存中解压
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipBuffer);
    
    let text = '';
    
    if (ext === 'docx') {
      // 读取 word/document.xml
      const entry = zip.getEntry('word/document.xml');
      if (entry) {
        const content = entry.getData().toString('utf-8');
        text = stripXmlTags(content);
      }
    } else if (ext === 'pptx') {
      // 读取所有幻灯片
      const entries = zip.getEntries();
      const slideEntries = entries
        .filter((e: any) => e.entryName.startsWith('ppt/slides/slide') && e.entryName.endsWith('.xml'))
        .sort((a: any, b: any) => {
          // 按幻灯片编号排序
          const numA = parseInt(a.entryName.match(/slide(\d+)\.xml/)?.[1] || '0');
          const numB = parseInt(b.entryName.match(/slide(\d+)\.xml/)?.[1] || '0');
          return numA - numB;
        });
      
      for (const entry of slideEntries) {
        const content = entry.getData().toString('utf-8');
        text += stripXmlTags(content) + '\n';
      }
    }
    
    if (!text.trim()) {
      // 如果XML解析没有内容，尝试二进制提取作为备选
      const binaryText = extractTextFromBinary(zipBuffer);
      if (binaryText.trim()) {
        return { text: binaryText, unsupportedPreview: false };
      }
      return { text: '', unsupportedPreview: true };
    }
    
    return { text, unsupportedPreview: false };
  } catch (error: any) {
    // ZIP解析失败，尝试二进制文本提取（静默处理，不显示错误）
    try {
      const data = await fs.promises.readFile(filePath);
      const text = extractTextFromBinary(data);
      if (text.trim()) {
        return { text, unsupportedPreview: false };
      }
    } catch (e) {
      // 只有在二进制提取也失败时才记录错误
      console.error(`${ext.toUpperCase()} 文件解析完全失败`);
    }
    return { text: '', unsupportedPreview: true };
  }
}

// 提取旧版 Office 文件（.doc, .ppt, .wps等）
async function extractOldOffice(filePath: string, ext: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const data = await fs.promises.readFile(filePath);
    const text = extractTextFromBinary(data);
    
    if (!text.trim()) {
      return { text: '', unsupportedPreview: true };
    }
    
    return { text, unsupportedPreview: false };
  } catch (error) {
    console.error(`${ext.toUpperCase()}解析失败:`, error);
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

// 去除 XML 标签
function stripXmlTags(xml: string): string {
  let result = '';
  let inTag = false;
  
  for (const ch of xml) {
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      result += ch;
    }
  }
  
  return result;
}

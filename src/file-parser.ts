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
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { text: content, unsupportedPreview: false };
  } catch (error: any) {
    // 【修复】Windows 文件锁定或其他读取错误
    console.error(`读取文本文件失败 ${filePath}:`, error.message);
    throw new Error(`无法读取文件: ${error.message}`);
  }
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
  // 【修复】使用 ExcelJS 流式读取，降低内存占用，避免崩溃
  return new Promise((resolve) => {
    const textParts: string[] = [];
    let hasContent = false;
    
    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        entries: 'ignore'
      }) as any; // 类型断言，因为 TypeScript 定义不完整
      
      (workbook as any).on('worksheet', (worksheet: any) => {
        worksheet.on('row', (row: any) => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
            let cellValue = '';
            
            if (cell.value) {
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
                // 其他对象类型
                else if ((cell.value as any).text) {
                  cellValue = String((cell.value as any).text);
                }
                else {
                  cellValue = String(cell.value);
                }
              } else {
                cellValue = String(cell.value);
              }
            }
            
            cells.push(cellValue);
          });
          
          if (cells.some((c: string) => c.trim())) {
            textParts.push(cells.join('\t'));
            hasContent = true;
          }
        });
      });
      
      (workbook as any).on('end', () => {
        const text = textParts.join('\n');
        resolve({ 
          text: text || '', 
          unsupportedPreview: !hasContent 
        });
      });
      
      (workbook as any).on('error', (error: any) => {
        console.error(`Excel流式读取失败 ${filePath}:`, error.message);
        
        // 降级到二进制提取
        fs.promises.readFile(filePath)
          .then(data => {
            const text = extractTextFromBinary(data);
            resolve({ text: text || '', unsupportedPreview: !text.trim() });
          })
          .catch(() => {
            resolve({ text: '', unsupportedPreview: true });
          });
      });
      
      // 启动读取
      workbook.read();
      
    } catch (error: any) {
      console.error(`Excel流式读取初始化失败 ${filePath}:`, error.message);
      
      // 降级到二进制提取
      fs.promises.readFile(filePath)
        .then(data => {
          const text = extractTextFromBinary(data);
          resolve({ text: text || '', unsupportedPreview: !text.trim() });
        })
        .catch(() => {
          resolve({ text: '', unsupportedPreview: true });
        });
    }
  });
}

// 提取 docx/pptx 文件内容
async function extractDocxPptx(filePath: string, ext: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 【修复】读取文件到内存，添加错误处理
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
    // 【修复】ZIP解析失败，记录错误并尝试二进制提取
    console.error(`${ext.toUpperCase()}解析失败 ${filePath}:`, error.message);
    
    try {
      const data = await fs.promises.readFile(filePath);
      const text = extractTextFromBinary(data);
      if (text.trim()) {
        return { text, unsupportedPreview: false };
      }
    } catch (e: any) {
      // 只有在二进制提取也失败时才记录错误
      console.error(`${ext.toUpperCase()}二进制提取也失败 ${filePath}:`, e.message);
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
  } catch (error: any) {
    // 【修复】Windows 文件锁定或其他读取错误
    console.error(`${ext.toUpperCase()}解析失败 ${filePath}:`, error.message);
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

import * as fs from 'fs';
import * as path from 'path';
// 【重构】弃用 docstream，使用专门的库解析不同格式
import mammoth from 'mammoth';  // .docx
import WordExtractor from 'word-extractor';  // .doc
// 【修复】PDF 使用专门的 pdf-parse 库，避免 pdfjs-dist 的 Worker 问题
import pdfParse from 'pdf-parse';
// 【新增】SheetJS 用于快速解析 Excel 文件
import * as XLSX from 'xlsx';
// 【新增】adm-zip 用于解压 .pptx 文件
import AdmZip from 'adm-zip';
// 【新增】rtf-parser 用于解析 RTF 文件
import * as rtfParser from 'rtf-parser';

// 【优化】抑制 pdfjs-dist 的字体警告（TT: undefined function, Ran out of space）
// 这些警告不影响文本提取，但会污染日志
const originalWarn = console.warn;
console.warn = function(...args: any[]) {
  const message = args.join(' ');
  // 过滤掉 pdfjs-dist 的字体相关警告
  if (message.includes('Warning: TT: undefined function') || 
      message.includes('Warning: Ran out of space in font private use area')) {
    return; // 静默丢弃
  }
  originalWarn.apply(console, args);
};

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
  // 【优化】Word 文档使用专门的解析器
  'docx': extractWithMammoth,
  'doc': extractWithWordExtractor,  // .doc 使用 word-extractor
  'wps': extractWithBinary,  // WPS 旧版格式，降级到二进制提取
  // 【优化】Excel 文件使用 SheetJS，速度更快且不会内存溢出
  'xlsx': extractWithSheetJS,
  'xls': extractWithSheetJS,
  'et': extractWithSheetJS,
  // 【优化】PPT 文件使用自定义解压方案
  'pptx': extractPptx,
  'ppt': extractWithBinary,  // .ppt 降级到二进制提取（旧版格式难以解析）
  'dps': extractWithBinary,  // WPS 演示旧版格式，降级到二进制提取
  // 【优化】OpenDocument 格式使用自定义解压方案
  'odt': extractOdt,
  'ods': extractOds,
  'odp': extractOdp,
  'rtf': extractRtf,  // RTF 使用专门的解析器
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

// 【新增】使用 word-extractor 解析 .doc 文件
async function extractWithWordExtractor(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 创建 extractor 实例
    const extractor = new WordExtractor();
    
    // 提取文本
    const extracted = await extractor.extract(filePath);
    const text = extracted.getBody();
    
    const hasContent = text && text.trim().length > 0;
    
    return {
      text: hasContent ? text : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`word-extractor解析失败 ${filePath}:`, error.message);
    
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

// 【新增】解析 .odt (OpenDocument Text) 文件
async function extractOdt(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const data = await fs.promises.readFile(filePath);
    const zip = new AdmZip(data);
    
    // ODT 的内容在 content.xml 中
    const contentEntry = zip.getEntry('content.xml');
    if (!contentEntry) {
      return { text: '', unsupportedPreview: true };
    }
    
    const xmlContent = contentEntry.getData().toString('utf-8');
    
    // 提取 <text:p> (段落) 和 <text:h> (标题) 标签中的文本
    const textMatches = xmlContent.match(/<text:[ph][^>]*>(.*?)<\/text:[ph]>/gs);
    let allText = '';
    
    if (textMatches) {
      for (const match of textMatches) {
        // 移除内部的 XML 标签，只保留纯文本
        const text = match.replace(/<[^>]+>/g, '').trim();
        if (text) {
          allText += text + '\n';
        }
      }
    }
    
    const hasContent = allText && allText.trim().length > 0;
    
    return {
      text: hasContent ? allText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`ODT解析失败 ${filePath}:`, error.message);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】解析 .ods (OpenDocument Spreadsheet) 文件
async function extractOds(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const data = await fs.promises.readFile(filePath);
    const zip = new AdmZip(data);
    
    // ODS 的内容在 content.xml 中
    const contentEntry = zip.getEntry('content.xml');
    if (!contentEntry) {
      return { text: '', unsupportedPreview: true };
    }
    
    const xmlContent = contentEntry.getData().toString('utf-8');
    
    // 提取表格行和单元格
    const rowMatches = xmlContent.match(/<table:table-row[^>]*>(.*?)<\/table:table-row>/gs);
    let allText = '';
    
    if (rowMatches) {
      for (const rowMatch of rowMatches) {
        // 提取单元格
        const cellMatches = rowMatch.match(/<table:table-cell[^>]*>(.*?)<\/table:table-cell>/gs);
        if (cellMatches) {
          const cells: string[] = [];
          for (const cellMatch of cellMatches) {
            // 提取单元格内的文本
            const textMatches = cellMatch.match(/<text:p[^>]*>(.*?)<\/text:p>/gs);
            if (textMatches) {
              const cellText = textMatches.map(m => m.replace(/<[^>]+>/g, '').trim()).join(' ');
              if (cellText) {
                cells.push(cellText);
              }
            }
          }
          if (cells.length > 0) {
            allText += cells.join('\t') + '\n';
          }
        }
      }
    }
    
    const hasContent = allText && allText.trim().length > 0;
    
    return {
      text: hasContent ? allText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`ODS解析失败 ${filePath}:`, error.message);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】解析 .odp (OpenDocument Presentation) 文件
async function extractOdp(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const data = await fs.promises.readFile(filePath);
    const zip = new AdmZip(data);
    
    // ODP 的内容在 content.xml 中
    const contentEntry = zip.getEntry('content.xml');
    if (!contentEntry) {
      return { text: '', unsupportedPreview: true };
    }
    
    const xmlContent = contentEntry.getData().toString('utf-8');
    
    // 提取 <draw:frame> 中的 <text:p> 标签
    const frameMatches = xmlContent.match(/<draw:frame[^>]*>(.*?)<\/draw:frame>/gs);
    let allText = '';
    
    if (frameMatches) {
      for (const frameMatch of frameMatches) {
        const textMatches = frameMatch.match(/<text:p[^>]*>(.*?)<\/text:p>/gs);
        if (textMatches) {
          for (const textMatch of textMatches) {
            const text = textMatch.replace(/<[^>]+>/g, '').trim();
            if (text) {
              allText += text + '\n';
            }
          }
        }
      }
    }
    
    const hasContent = allText && allText.trim().length > 0;
    
    return {
      text: hasContent ? allText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`ODP解析失败 ${filePath}:`, error.message);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】解析 .rtf (Rich Text Format) 文件
async function extractRtf(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    // 读取文件
    const data = await fs.promises.readFile(filePath, 'utf-8');
    
    // 使用 rtf-parser 解析（正确的 API 是 rtfParser.string）
    const document = await new Promise<any>((resolve, reject) => {
      rtfParser.string(data, (err: any, doc: any) => {
        if (err) reject(err);
        else resolve(doc);
      });
    });
    
    // 提取文本内容
    let allText = '';
    
    // rtf-parser 返回的文档结构中，文本分布在各个节点中
    function extractTextFromNode(node: any): string {
      if (typeof node === 'string') {
        return node;
      }
      
      // 处理 value 字段（可能是十六进制编码的文本）
      if (node.value) {
        const value = node.value;
        // 如果是十六进制字符串，尝试解码
        if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
          try {
            // 将十六进制转换为字节，再转换为 UTF-8 字符串
            const bytes = Buffer.from(value, 'hex');
            return bytes.toString('utf-8');
          } catch (e) {
            // 如果解码失败，直接返回原始值
            return String(value);
          }
        }
        return String(value);
      }
      
      // 处理 text 字段
      if (node.text) {
        return node.text;
      }
      
      // 递归处理 content 或 children
      const items = node.content || node.children;
      if (items && Array.isArray(items)) {
        return items.map(extractTextFromNode).join('');
      }
      
      return '';
    }
    
    // 尝试多种可能的结构
    if (document.content && Array.isArray(document.content)) {
      allText = document.content.map(extractTextFromNode).join('\n');
    } else if (document.children && Array.isArray(document.children)) {
      allText = document.children.map(extractTextFromNode).join('\n');
    } else if (document.text) {
      allText = document.text;
    } else {
      // 如果顶层没有 content/children，尝试直接提取
      allText = extractTextFromNode(document);
    }
    
    // 清理文本：移除多余空白
    allText = allText.replace(/\s+/g, ' ').trim();
    
    const hasContent = allText && allText.length > 0;
    
    // 【调试】输出解析结果
    if (!hasContent) {
      console.warn(`RTF 解析未提取到文本 ${filePath}, 文档结构:`, JSON.stringify(document).substring(0, 200));
    }
    
    return {
      text: hasContent ? allText : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    console.error(`RTF解析失败 ${filePath}:`, error.message);
    
    // 降级到纯文本读取（RTF 本质上是文本格式）
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      // 简单移除 RTF 标记，提取可读文本
      const text = content.replace(/\\[a-z]+[0-9]*|[{}]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text && text.length > 10) {
        console.log(`RTF 降级提取成功，文本长度: ${text.length}`);
        return { text, unsupportedPreview: false };
      }
    } catch (e: any) {
      console.error(`RTF文本提取也失败 ${filePath}:`, e.message);
    }
    
    return { text: '', unsupportedPreview: true };
  }
}

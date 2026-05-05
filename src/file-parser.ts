// 【关键】首先导入日志抑制工具（必须在任何其他导入之前）
import './log-utils';

import * as fs from 'fs';
import { createReadStream } from 'fs';
import * as path from 'path';
// 【重构】弃用 docstream，使用专门的库解析不同格式
import WordExtractor from 'word-extractor';  // .doc 和 .docx 统一使用 word-extractor
// 【优化】PDF 使用 pdfreader 流式解析，大幅降低内存占用
import { PdfReader } from 'pdfreader';
// 【新增】SheetJS 用于快速解析 Excel 文件
import * as XLSX from 'xlsx';
// 【新增】iconv-lite 用于解码 GBK 编码的 RTF 文件
import * as iconv from 'iconv-lite';
// 【新增】sax 流式 XML 解析器，避免大 XML 文件 OOM
import * as sax from 'sax';
// 【新增】ZIP 解压工具（使用 fflate 替代 adm-zip）
import { unzipFile, findZipEntries, extractEntriesText } from './zip-utils';
// 【D3 优化】导入错误处理工具
import {
  logError,
  convertNodeError
} from './error-utils';
// 【内存优化】导入文件大小限制常量
import { MAX_TEXT_CONTENT_SIZE_MB, BYTES_TO_MB, SLIDING_WINDOW_CHUNK_SIZE_MB, calculateParserTimeout } from './scan-config';
// 【新增】导入敏感词检测函数
import { getHighlights } from './sensitive-detector';

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
  'xml': extractXmlFile,  // 【新增】使用流式 XML 解析器
  'yaml': extractTextFile,
  'yml': extractTextFile,
  'properties': extractTextFile,
  'toml': extractTextFile,
  // 【修复】PDF 使用专门的 pdf-parse 库
  'pdf': extractPdf,
  // 【优化】Word 文档统一使用 word-extractor（支持 .doc 和 .docx）
  'docx': extractWithWordExtractor,
  'doc': extractWithWordExtractor,
  // 【修复】WPS 旧版格式是 OLE2，使用 word-extractor 解析（与 .doc 相同）
  'wps': extractWithWordExtractor,
  'dps': extractWithBinary,  // WPS 演示暂时使用二进制扫描
  // 【优化】Excel 文件使用 SheetJS，速度更快且不会内存溢出
  'xlsx': extractWithSheetJS,
  'xls': extractWithSheetJS,
  'et': extractWithSheetJS,   // WPS 表格
  // 【优化】PPT 文件使用自定义解压方案
  'pptx': extractPptx,
  'ppt': extractWithBinary,  // .ppt 旧版格式，暂时使用二进制提取
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
    logError('extractTextFromFile', error);
    throw error;
  }
}

// 【内存优化】流式读取文本文件，防止超大文件导致 OOM
// 【优化】使用数组收集代替字符串拼接，减少内存分配
async function extractTextFile(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { 
      encoding: 'utf-8',
      highWaterMark: 64 * 1024 // 64KB 缓冲区
    });
    
    const textChunks: string[] = [];  // 【优化】使用数组收集
    let totalSize = 0;
    const maxSizeBytes = MAX_TEXT_CONTENT_SIZE_MB * BYTES_TO_MB;
    let isResolved = false;
    
    stream.on('data', (chunk: string | Buffer) => {
      const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      totalSize += Buffer.byteLength(chunkStr, 'utf-8');
      
      if (totalSize > maxSizeBytes) {
        stream.destroy();
        console.warn(`[extractTextFile] 文件内容过大 (${(totalSize / BYTES_TO_MB).toFixed(1)}MB)，跳过解析: ${filePath}`);
        if (!isResolved) {
          isResolved = true;
          resolve({ text: '', unsupportedPreview: true });
        }
        return;
      }
      
      textChunks.push(chunkStr);  // 【优化】推入数组，不拼接
    });
    
    stream.on('end', () => {
      if (!isResolved) {
        isResolved = true;
        // 【优化】一次性 join，减少内存分配
        const text = textChunks.join('');
        const hasContent = text.trim().length > 0;
        resolve({ 
          text: hasContent ? text : '', 
          unsupportedPreview: !hasContent 
        });
      }
    });
    
    stream.on('error', (error: any) => {
      if (!isResolved) {
        isResolved = true;
        logError('extractTextFile', error);
        reject(convertNodeError(error, filePath, '读取文本文件失败'));
      }
    });
  });
}

// 【新增】流式 XML 解析器，使用 sax 边读边解析，避免大文件 OOM
// 【优化】使用数组收集代替字符串拼接，减少内存分配
async function extractXmlFile(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { 
      highWaterMark: 64 * 1024 // 64KB 缓冲区
    });
    
    // 创建严格模式的 sax 解析器
    const parser = sax.createStream(true, { trim: true });
    
    const textChunks: string[] = [];  // 【优化】使用数组收集
    let totalTextLength = 0;
    const maxTextLength = MAX_TEXT_CONTENT_SIZE_MB * BYTES_TO_MB;
    let isResolved = false;
    
    // 监听文本节点事件
    parser.on('text', (text: string) => {
      if (isResolved) return;
      
      const trimmed = text.trim();
      if (trimmed) {
        totalTextLength += trimmed.length + 1;
        
        if (totalTextLength > maxTextLength) {
          stream.destroy();
          parser.destroy();
          console.warn(`[extractXmlFile] XML 文本内容过大 (${(totalTextLength / BYTES_TO_MB).toFixed(1)}MB)，跳过解析: ${filePath}`);
          if (!isResolved) {
            isResolved = true;
            resolve({ text: '', unsupportedPreview: true });
          }
          return;
        }
        
        textChunks.push(trimmed);  // 【优化】推入数组，不拼接
      }
    });
    
    parser.on('end', () => {
      if (!isResolved) {
        isResolved = true;
        // 【优化】一次性 join，减少内存分配
        const textContent = textChunks.join(' ');
        const hasContent = textContent.trim().length > 0;
        resolve({ 
          text: hasContent ? textContent : '', 
          unsupportedPreview: !hasContent 
        });
      }
    });
    
    parser.on('error', (error: any) => {
      if (!isResolved) {
        isResolved = true;
        logError('extractXmlFile', error, 'warn');
        // XML 解析失败时，降级到普通文本读取
        extractTextFile(filePath).then(resolve).catch(reject);
      }
    });
    
    stream.pipe(parser);
    
    stream.on('error', (error: any) => {
      if (!isResolved) {
        isResolved = true;
        logError('extractXmlFile-stream', error);
        reject(convertNodeError(error, filePath, '读取 XML 文件失败'));
      }
    });
  });
}

// 【优化】使用 pdfreader 流式解析 PDF，大幅降低内存占用
async function extractPdf(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
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

// 【新增】使用 word-extractor 解析 .doc 和 .docx 文件
async function extractWithWordExtractor(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  // 【关键修复】添加智能超时保护，防止 word-extractor 卡死
  let isResolved = false;
  
  // 先获取文件大小，然后计算智能超时
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error: any) {
    logError('extractWithWordExtractor', error);
    return { text: '', unsupportedPreview: true };
  }
  
  const timeoutMs = calculateParserTimeout(stat.size);
  
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.warn(`[extractWithWordExtractor] 解析超时 (${timeoutMs/1000}秒)，跳过: ${path.basename(filePath)}`);
        resolve({ text: '', unsupportedPreview: true });
      }
    }, timeoutMs);
    
    (async () => {
      try {
        // 创建 extractor 实例
        const extractor = new WordExtractor();
        
        // 提取文本
        const extracted = await extractor.extract(filePath);
        const text = extracted.getBody();
        
        clearTimeout(timeoutId);
        if (!isResolved) {
          isResolved = true;
          
          const hasContent = text && text.trim().length > 0;
          
          // 【优化】只在解析失败时输出日志
          if (!hasContent) {
            logError('extractWithWordExtractor', `[word-extractor] 未提取到内容: ${path.basename(filePath)}`, 'warn');
          }
          
          resolve({
            text: hasContent ? text : '',
            unsupportedPreview: !hasContent
          });
        }
        
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (!isResolved) {
          isResolved = true;
          logError('extractWithWordExtractor', error);
          
          // 降级到二进制提取
          try {
            const data = await fs.promises.readFile(filePath);
            const text = extractTextFromBinary(data);
            if (text.trim()) {
              resolve({ text, unsupportedPreview: false });
              return;
            }
          } catch (e: any) {
            logError('extractWithWordExtractor-fallback', e);
          }
          
          resolve({ text: '', unsupportedPreview: true });
        }
      }
    })();
  });
}

// 【新增】使用自定义方案解析 .pptx 文件（使用 fflate）
async function extractPptx(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  // 【关键修复】添加智能超时保护，防止 ZIP 解压卡死
  let isResolved = false;
  
  // 先获取文件大小，然后计算智能超时
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error: any) {
    logError('extractPptx', error);
    return { text: '', unsupportedPreview: true };
  }
  
  const timeoutMs = calculateParserTimeout(stat.size);
  
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.warn(`[extractPptx] 解析超时 (${timeoutMs/1000}秒)，跳过: ${path.basename(filePath)}`);
        resolve({ text: '', unsupportedPreview: true });
      }
    }, timeoutMs);
    
    (async () => {
      try {
        // 使用 fflate 解压
        const entries = await unzipFile(filePath);
        
        // 查找所有幻灯片 XML 文件
        const slideEntries = findZipEntries(entries, 'ppt/slides/slide');
        
        let allText = '';
        
        for (const entry of slideEntries) {
          try {
            const xmlContent = extractEntriesText([entry])[0];
            if (!xmlContent) continue;
            
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
        
        clearTimeout(timeoutId);
        if (!isResolved) {
          isResolved = true;
          
          const hasContent = allText && allText.trim().length > 0;
          
          resolve({
            text: hasContent ? allText : '',
            unsupportedPreview: !hasContent
          });
        }
        
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (!isResolved) {
          isResolved = true;
          logError('extractPptx', error);
          
          // 降级到二进制提取
          try {
            const data = await fs.promises.readFile(filePath);
            const text = extractTextFromBinary(data);
            if (text.trim()) {
              resolve({ text, unsupportedPreview: false });
              return;
            }
          } catch (e: any) {
            logError('extractPptx-fallback', e);
          }
          
          resolve({ text: '', unsupportedPreview: true });
        }
      }
    })();
  });
}

// 【新增】使用 SheetJS 快速解析 Excel 文件
async function extractWithSheetJS(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  // 【关键修复】添加智能超时保护，防止 SheetJS 卡死
  let isResolved = false;
  
  // 先获取文件大小，然后计算智能超时
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error: any) {
    logError('extractWithSheetJS', error);
    return { text: '', unsupportedPreview: true };
  }
  
  const timeoutMs = calculateParserTimeout(stat.size);
  
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.warn(`[extractWithSheetJS] 解析超时 (${timeoutMs/1000}秒)，跳过: ${path.basename(filePath)}`);
        resolve({ text: '', unsupportedPreview: true });
      }
    }, timeoutMs);
    
    (async () => {
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
        
        clearTimeout(timeoutId);
        if (!isResolved) {
          isResolved = true;
          
          // 检查是否有实质性内容
          const hasContent = allText && allText.trim().length > 0;
          
          resolve({
            text: hasContent ? allText : '',
            unsupportedPreview: !hasContent
          });
        }
        
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (!isResolved) {
          isResolved = true;
          logError('extractWithSheetJS', error);
          resolve({ text: '', unsupportedPreview: true });
        }
      }
    })();
  });
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
    logError('extractWithBinary', error);
    return { text: '', unsupportedPreview: true };
  }
}

// 从二进制数据中提取可打印文本
export function extractTextFromBinary(data: Buffer): string {
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

// 【新增】解析 .odt (OpenDocument Text) 文件（使用 fflate）
async function extractOdt(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const entries = await unzipFile(filePath);
    
    // ODT 的内容在 content.xml 中
    const contentEntry = entries.find(e => e.name === 'content.xml');
    if (!contentEntry) {
      return { text: '', unsupportedPreview: true };
    }
    
    const xmlContent = extractEntriesText([contentEntry])[0];
    if (!xmlContent) {
      return { text: '', unsupportedPreview: true };
    }
    
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
    logError('extractOdt', error);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】解析 .ods (OpenDocument Spreadsheet) 文件（使用 fflate）
async function extractOds(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const entries = await unzipFile(filePath);
    
    // ODS 的内容在 content.xml 中
    const contentEntry = entries.find(e => e.name === 'content.xml');
    if (!contentEntry) {
      return { text: '', unsupportedPreview: true };
    }
    
    const xmlContent = extractEntriesText([contentEntry])[0];
    if (!xmlContent) {
      return { text: '', unsupportedPreview: true };
    }
    
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
    logError('extractOds', error);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】解析 .odp (OpenDocument Presentation) 文件（使用 fflate）
async function extractOdp(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const entries = await unzipFile(filePath);
    
    // ODP 的内容在 content.xml 中
    const contentEntry = entries.find(e => e.name === 'content.xml');
    if (!contentEntry) {
      return { text: '', unsupportedPreview: true };
    }
    
    const xmlContent = extractEntriesText([contentEntry])[0];
    if (!xmlContent) {
      return { text: '', unsupportedPreview: true };
    }
    
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
    logError('extractOdp', error);
    return { text: '', unsupportedPreview: true };
  }
}

// 【新增】解析 .rtf (Rich Text Format) 文件
// RTF 本质上是文本格式，直接用正则表达式提取可读文本
async function extractRtf(filePath: string): Promise<{ text: string; unsupportedPreview: boolean }> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    
    // 第一步：检测 RTF 文件的编码（从 \ansicpgN 中提取代码页）
    const codePageMatch = content.match(/\\ansicpg(\d+)/i);
    let encoding = 'gbk'; // 默认 GBK（简体中文）
    
    if (codePageMatch) {
      const codePage = parseInt(codePageMatch[1]);
      // 根据代码页映射到 iconv-lite 支持的编码名称
      switch (codePage) {
        case 936:  // 简体中文 GBK
          encoding = 'gbk';
          break;
        case 950:  // 繁体中文 Big5
          encoding = 'big5';
          break;
        case 932:  // 日语 Shift_JIS
          encoding = 'shift_jis';
          break;
        case 949:  // 韩语 EUC-KR
          encoding = 'euc-kr';
          break;
        case 1252: // 西欧 Windows-1252
          encoding = 'windows-1252';
          break;
        case 1251: // 西里尔文 Windows-1251
          encoding = 'windows-1251';
          break;
        case 1250: // 东欧 Windows-1250
          encoding = 'windows-1250';
          break;
        case 65001: // UTF-8
          encoding = 'utf-8';
          break;
        default:
          // 其他代码页尝试使用 GBK（最常见）
          logError('extractRtf', `未知的 RTF 代码页: ${codePage}，尝试使用 GBK 解码`, 'warn');
          encoding = 'gbk';
      }
    }
    
    // 第二步：将十六进制转义序列（\'xx）转换为对应编码的字符
    let text = content.replace(/(\\'[0-9a-fA-F]{2})+/g, (match) => {
      // 提取所有十六进制字节
      const hexPairs = match.match(/\\'([0-9a-fA-F]{2})/g);
      if (!hexPairs) return '';
      
      // 转换为字节数组
      const bytes = hexPairs.map(pair => {
        const hex = pair.substring(2); // 去掉 \'
        return parseInt(hex, 16);
      });
      
      // 使用 iconv-lite 将字节解码为字符串
      try {
        const buffer = Buffer.from(bytes);
        return iconv.decode(buffer, encoding as any);
      } catch (e) {
        logError('extractRtf-decode', `${encoding} 解码失败，尝试 GBK`, 'warn');
        // 降级到 GBK
        try {
          const gbkBuffer = Buffer.from(bytes);
          return iconv.decode(gbkBuffer, 'gbk');
        } catch (e2) {
          return '';
        }
      }
    });
    
    // 第三步：移除其他 RTF 控制字和标记
    text = text
      // 移除 Unicode 转义序列（\uN?）
      .replace(/\\u-?\d+\??/g, '')
      // 移除 RTF 控制字（\word）
      .replace(/\\[a-z]+[0-9]*[ ;]?/g, ' ')
      // 移除花括号
      .replace(/[{}]/g, ' ')
      // 合并多余空白
      .replace(/\s+/g, ' ')
      .trim();
    
    const hasContent = text && text.length > 10;
    
    return {
      text: hasContent ? text : '',
      unsupportedPreview: !hasContent
    };
    
  } catch (error: any) {
    logError('extractRtf', error);
    return { text: '', unsupportedPreview: true };
  }
}

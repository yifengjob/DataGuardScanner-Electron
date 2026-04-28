import * as fs from 'fs';
import { dialog } from 'electron';
import { ScanResultItem } from './types';
import * as ExcelJS from 'exceljs';

export async function exportReport(
  results: ScanResultItem[],
  format: 'csv' | 'json' | 'excel',
  filePath?: string  // 可选的文件路径参数
): Promise<void> {
  let targetPath = filePath;
  
  // 如果没有提供文件路径，则弹出保存对话框
  if (!targetPath) {
    const filters = [
      { name: format === 'csv' ? 'CSV文件' : format === 'json' ? 'JSON文件' : 'Excel文件', extensions: [format] }
    ];
    
    const result = await dialog.showSaveDialog({
      title: '导出报告',
      filters,
      defaultPath: `scan-report.${format}`
    });
    
    if (result.canceled || !result.filePath) {
      return;
    }
    
    targetPath = result.filePath;
  }
  
  try {
    switch (format) {
      case 'csv':
        await exportToCsv(targetPath, results);
        break;
      case 'json':
        await exportToJson(targetPath, results);
        break;
      case 'excel':
        await exportToExcel(targetPath, results);
        break;
      default:
        throw new Error(`不支持的导出格式: ${format}`);
    }
  } catch (error) {
    console.error('[Export] 导出失败:', error);
    throw error;
  }
}

async function exportToCsv(filePath: string, results: ScanResultItem[]): Promise<void> {
  const headers = ['文件路径', '文件大小(MB)', '修改时间', '敏感数据总数', ...Object.keys(results[0]?.counts || {})];
  
  let csvContent = headers.join(',') + '\n';
  
  for (const result of results) {
    const row = [
      `"${result.filePath}"`,
      (result.fileSize / 1024 / 1024).toFixed(2),
      result.modifiedTime,
      result.total.toString(),
      ...Object.values(result.counts).map(c => c.toString())
    ];
    csvContent += row.join(',') + '\n';
  }
  
  // 添加BOM以支持中文
  const bom = '\uFEFF';
  await fs.promises.writeFile(filePath, bom + csvContent, 'utf-8');
}

async function exportToJson(filePath: string, results: ScanResultItem[]): Promise<void> {
  const jsonData = JSON.stringify(results, null, 2);
  await fs.promises.writeFile(filePath, jsonData, 'utf-8');
}

async function exportToExcel(filePath: string, results: ScanResultItem[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('扫描结果');
  
  // 添加表头
  const headers = ['文件路径', '文件大小(MB)', '修改时间', '敏感数据总数'];
  const allTypes = new Set<string>();
  results.forEach(r => Object.keys(r.counts).forEach(t => allTypes.add(t)));
  const typeHeaders = Array.from(allTypes);
  headers.push(...typeHeaders);
  
  worksheet.addRow(headers);
  
  // 设置表头样式
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E0E0' }
  };
  
  // 添加数据行
  for (const result of results) {
    const row = [
      result.filePath,
      (result.fileSize / 1024 / 1024).toFixed(2),
      result.modifiedTime,
      result.total.toString(),
      ...typeHeaders.map(t => (result.counts[t] || 0).toString())
    ];
    worksheet.addRow(row);
  }
  
  // 自动调整列宽
  worksheet.columns.forEach(column => {
    column.width = 20;
  });
  
  // 先写入到Buffer，然后使用fs.writeFile
  const buffer: any = await workbook.xlsx.writeBuffer();
  await fs.promises.writeFile(filePath, Buffer.from(buffer));
}

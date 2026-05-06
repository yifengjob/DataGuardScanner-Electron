import * as fs from 'fs';
import {dialog} from 'electron';
import {ScanResultItem} from './types';
import * as XLSX from 'xlsx'; // 【修改】使用 SheetJS 替代 exceljs
import {getSensitiveRules} from './sensitive-detector';
// 【优化】导入配置常量
import {BYTES_TO_MB} from './scan-config';

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
  // 获取敏感类型规则映射
  const rules = getSensitiveRules();
  const typeMap = new Map(rules);
  
  // 收集所有出现的敏感类型
  const allTypes = new Set<string>();
  results.forEach(r => Object.keys(r.counts).forEach(t => allTypes.add(t)));
  
  // 构建表头：使用中文名称，敏感数据总数放在最后
  const headers = ['文件路径', '文件大小(MB)', '修改时间'];
  const typeHeaders = Array.from(allTypes).map(typeId => typeMap.get(typeId) || typeId);
  headers.push(...typeHeaders, '敏感数据总数');
  
  let csvContent = headers.join(',') + '\n';
  
  for (const result of results) {
    const row = [
      `"${result.filePath}"`,
      (result.fileSize / BYTES_TO_MB).toFixed(2),
      result.modifiedTime,
      ...Array.from(allTypes).map(t => (result.counts[t] || 0).toString()),
      result.total.toString()
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
  // 【修改】使用 SheetJS 生成 Excel
  const rules = getSensitiveRules();
  const typeMap = new Map(rules);
  
  // 收集所有出现的敏感类型
  const allTypes = new Set<string>();
  results.forEach(r => Object.keys(r.counts).forEach(t => allTypes.add(t)));
  const typeHeaders = Array.from(allTypes).map(typeId => typeMap.get(typeId) || typeId);
  
  // 构建表头：敏感数据总数放在最后
  const headers = ['文件路径', '文件大小(MB)', '修改时间', ...typeHeaders, '敏感数据总数'];
  
  // 构建数据行
  const data = [
    headers,  // 表头
    ...results.map(result => [
      result.filePath,
      parseFloat((result.fileSize / BYTES_TO_MB).toFixed(2)),
      result.modifiedTime,
      ...Array.from(allTypes).map(t => result.counts[t] || 0),
      result.total
    ])
  ];
  
  // 创建工作簿和工作表
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(data);
  
  // 【优化】设置列宽（SheetJS 支持）
  worksheet['!cols'] = [
    {wch: 50},  // 文件路径
    {wch: 15},  // 文件大小
    {wch: 20},  // 修改时间
    ...Array(typeHeaders.length).fill({wch: 15}),  // 敏感类型列
    {wch: 15}   // 总计
  ];
  
  // 将工作表添加到工作簿
  XLSX.utils.book_append_sheet(workbook, worksheet, '扫描结果');
  
  // 写入文件
  XLSX.writeFile(workbook, filePath);
}

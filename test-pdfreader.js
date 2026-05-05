#!/usr/bin/env node

/**
 * pdfreader 快速测试脚本
 * 用于验证 pdfreader 是否正确安装和工作
 */

const { PdfReader } = require('pdfreader');
const fs = require('fs');
const path = require('path');

console.log('🧪 pdfreader 快速测试\n');

// 检查 pdfreader 是否正确安装
try {
  console.log('✅ pdfreader 模块加载成功');
  console.log(`   版本: ${require('pdfreader/package.json').version}\n`);
} catch (error) {
  console.error('❌ pdfreader 模块加载失败:', error.message);
  process.exit(1);
}

// 查找测试 PDF 文件
function findTestPdf() {
  const testDirs = [
    process.env.HOME + '/Downloads',
    process.cwd(),
    process.cwd() + '/test',
    process.cwd() + '/tests'
  ];
  
  for (const dir of testDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      
      const files = fs.readdirSync(dir);
      const pdfFile = files.find(f => f.toLowerCase().endsWith('.pdf'));
      
      if (pdfFile) {
        return path.join(dir, pdfFile);
      }
    } catch (e) {
      // 忽略错误
    }
  }
  
  return null;
}

const testPdf = findTestPdf();

if (!testPdf) {
  console.log('⚠️  未找到测试 PDF 文件');
  console.log('   请手动指定一个 PDF 文件路径进行测试\n');
  console.log('使用方法:');
  console.log('  node test-pdfreader.js /path/to/test.pdf\n');
  process.exit(0);
}

console.log(`📄 测试文件: ${path.basename(testPdf)}`);
console.log(`   路径: ${testPdf}\n`);

// 检查文件大小
const stats = fs.statSync(testPdf);
const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
console.log(`📊 文件大小: ${sizeMB} MB\n`);

// 开始测试
console.log('🚀 开始解析...\n');

const startTime = Date.now();
const textChunks = [];
let pageCount = 0;
let totalChars = 0;

new PdfReader().parseFileItems(testPdf, (err, item) => {
  if (err) {
    console.error('❌ 解析错误:', err.message);
    process.exit(1);
  } else if (!item) {
    // EOF
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log('✅ 解析完成!\n');
    console.log('📈 统计信息:');
    console.log(`   页数: ${pageCount}`);
    console.log(`   字符数: ${totalChars.toLocaleString()}`);
    console.log(`   文本大小: ${(totalChars / 1024).toFixed(2)} KB`);
    console.log(`   耗时: ${duration} 秒`);
    console.log(`   速度: ${(totalChars / 1024 / parseFloat(duration)).toFixed(2)} KB/s\n`);
    
    // 显示前 500 个字符作为预览
    const fullText = textChunks.join('\n');
    const preview = fullText.substring(0, 500);
    console.log('👁️  文本预览（前 500 字符）:');
    console.log('─'.repeat(60));
    console.log(preview);
    console.log('─'.repeat(60));
    console.log('\n✨ 测试通过！pdfreader 工作正常。\n');
    
    process.exit(0);
  } else if (item.page) {
    pageCount++;
    console.log(`   📃 处理第 ${pageCount} 页...`);
  } else if (item.text) {
    textChunks.push(item.text);
    totalChars += item.text.length;
  }
});

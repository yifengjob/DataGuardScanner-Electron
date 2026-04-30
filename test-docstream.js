const docstream = require('@jose.espana/docstream');
const fs = require('fs');
const path = require('path');

async function testDocstream() {
    console.log('=== 测试 Docstream 库 ===\n');
    
    // 测试 DOCX 文件
    const testFiles = [
        '/Users/yifeng/数据/开发/项目/ElectronProjects/DataGuardScanner/test-files/sample.docx',
        '/Users/yifeng/数据/开发/项目/ElectronProjects/DataGuardScanner/test-files/sample.xlsx',
        '/Users/yifeng/数据/开发/项目/ElectronProjects/DataGuardScanner/test-files/sample.pdf'
    ];
    
    for (const filePath of testFiles) {
        if (!fs.existsSync(filePath)) {
            console.log(`⚠️  文件不存在: ${filePath}\n`);
            continue;
        }
        
        console.log(`📄 测试文件: ${path.basename(filePath)}`);
        
        try {
            // 测试纯文本提取
            const ast = await docstream.parseOffice(filePath);
            const text = ast.toText();
            
            console.log(`✅ 解析成功`);
            console.log(`   类型: ${ast.type}`);
            console.log(`   文本长度: ${text.length} 字符`);
            console.log(`   前 200 字符: ${text.substring(0, 200)}...`);
            console.log(`   元数据:`, ast.metadata ? Object.keys(ast.metadata).join(', ') : '无');
            console.log();
            
        } catch (error) {
            console.error(`❌ 解析失败:`, error.message);
            console.log();
        }
    }
}

testDocstream().catch(console.error);

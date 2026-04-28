# 应用图标设置指南

## 当前状态

已配置Electron应用图标支持，需要准备以下图标文件：

### 所需图标文件

将以下文件放置在 `build/` 目录中：

1. **icon.png** (512x512 或更大)
   - 用于Linux应用和开发环境窗口图标
   - PNG格式，建议尺寸：512x512像素

2. **icon.ico** (多尺寸ICO文件)
   - 用于Windows应用
   - 包含多个尺寸：16x16, 32x32, 48x48, 256x256

3. **icon.icns** (macOS图标集)
   - 用于macOS应用
   - 包含多个尺寸：16x16到1024x1024

## 从SVG生成图标的方法

### 方法1：使用在线工具（推荐）

1. 访问 https://realfavicongenerator.net/ 或 https://www.iconconverter.com/
2. 上传 `frontend/src/assets/icon.svg`
3. 下载生成的图标包
4. 将对应文件复制到 `build/` 目录

### 方法2：使用ImageMagick命令行工具

```bash
# 安装ImageMagick
brew install imagemagick  # macOS
# 或
sudo apt-get install imagemagick  # Linux

# 生成PNG (512x512)
convert frontend/src/assets/icon.svg -resize 512x512 build/icon.png

# 生成ICO (Windows)
convert frontend/src/assets/icon.svg -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico

# 生成ICNS (macOS) - 需要先安装png2icns
npm install -g png2icns
convert frontend/src/assets/icon.svg -resize 1024x1024 /tmp/icon.png
png2icns build/icon.icns /tmp/icon.png
```

### 方法3：使用Node.js脚本

创建 `scripts/generate-icons.js`:

```javascript
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function generateIcons() {
  const svgPath = path.join(__dirname, '../frontend/src/assets/icon.svg');
  const buildDir = path.join(__dirname, '../build');
  
  if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
  }
  
  // 生成PNG
  await sharp(svgPath)
    .resize(512, 512)
    .png()
    .toFile(path.join(buildDir, 'icon.png'));
  
  console.log('✓ 图标生成完成！');
}

generateIcons().catch(console.error);
```

然后运行：
```bash
npm install sharp
node scripts/generate-icons.js
```

## 临时解决方案

如果暂时无法生成图标文件，应用仍可正常运行，只是会使用Electron默认图标。

## 验证图标

重新编译并运行应用：

```bash
pnpm build
```

或在开发模式：

```bash
pnpm dev
```

窗口标题栏和应用任务栏应显示自定义图标。

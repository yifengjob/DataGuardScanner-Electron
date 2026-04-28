# 快速设置应用图标

## ✅ 已完成配置

1. ✓ main.ts - 已添加图标加载逻辑
2. ✓ package.json - 已配置各平台图标路径
3. ✓ build目录 - 已创建并准备就绪

## 📋 需要准备的图标文件

将以下文件放在 `build/` 目录：

### 必需文件（至少需要一个）

- **icon.png** (512x512像素)
  - macOS开发环境和Linux使用
  - Windows任务栏也会显示

### 可选文件（用于打包发布）

- **icon.ico** - Windows安装包使用
- **icon.icns** - macOS DMG安装包使用

## 🚀 快速获取图标的方法

### 方法1：在线转换工具（最简单）⭐推荐

1. 访问 https://cloudconvert.com/svg-to-png
2. 上传 `frontend/src/assets/icon.svg`
3. 设置尺寸为 512x512
4. 下载并重命名为 `icon.png`
5. 放入 `build/` 目录

**或者使用专门的图标生成器：**
- https://realfavicongenerator.net/
- https://www.favicon-generator.org/
- https://icoconvert.com/

### 方法2：使用macOS预览应用

1. 用"预览"打开 `frontend/src/assets/icon.svg`
2. 菜单：文件 → 导出
3. 格式选择 PNG
4. 分辨率设置为 512x512
5. 保存为 `build/icon.png`

### 方法3：使用命令行（如果安装了ImageMagick）

```bash
brew install imagemagick
convert frontend/src/assets/icon.svg -resize 512x512 build/icon.png
```

### 方法4：使用Node.js脚本

```bash
# 先安装sharp
pnpm add -D sharp

# 运行生成脚本
pnpm generate-icons
```

## 🧪 测试图标

重新编译并运行应用：

```bash
# 编译TypeScript
npx tsc -p tsconfig.main.json

# 启动应用
pnpm start
```

窗口标题栏和Dock应显示您的自定义图标。

## 📦 打包时自动生成完整图标集

对于生产环境打包，可以使用electron-builder的自动图标生成功能：

1. 只需提供一个大尺寸的PNG（如512x512）
2. electron-builder会自动生成ICO和ICNS

在package.json中已配置好相关路径。

## 💡 提示

- 如果没有图标文件，应用会使用Electron默认图标
- 开发阶段只需要 `icon.png` 即可
- 正式发布时才需要 `.ico` 和 `.icns`

# Node.js 版本说明

## 📌 重要概念澄清

### GitHub Actions 中的 Node.js vs Electron 内置的 Node.js

这是两个完全不同的概念！

---

## 🔧 开发环境 Node.js（GitHub Actions）

### 用途
- 运行 `pnpm install` 安装依赖
- 执行 `pnpm build:renderer` 构建前端
- 运行 `npx tsc` 编译 TypeScript
- 执行 `electron-builder` 打包应用

### 当前配置
```yaml
node-version: '20'  # ← 从 18 升级到 20
```

### 为什么选择 Node 20？

| 版本 | 状态 | EOL 时间 | 推荐度 |
|------|------|---------|--------|
| Node 16 | 已停止维护 | 2023-09-11 | ❌ 不推荐 |
| Node 18 | 维护中 | 2025-04-30 | ⚠️ 即将过期 |
| **Node 20** | **Active LTS** | **2026-04-30** | ✅ **推荐** |
| Node 22 | Current | 2025-10-01 (转LTS) | ✅ 可用 |
| Node 24 | 最新 | - | ⚠️ 太新 |

**选择 Node 20 的原因**:
1. ✅ 当前 Active LTS（长期支持）
2. ✅ 稳定可靠，广泛使用
3. ✅ 兼容所有依赖包
4. ✅ GitHub Actions 默认推荐
5. ✅ 支持到 2026 年 4 月

---

## 📦 Electron 内置 Node.js（运行时）

### 用途
- 用户运行应用时实际使用的 Node.js
- 处理文件系统操作
- 执行主进程代码
- **与系统安装的 Node.js 完全无关**

### Electron 22 内置版本
```
Electron 22.3.27 内置:
- Chromium 108
- Node.js 16.17.x
- V8 10.8
```

### 如何查看
在 Electron 应用中执行：
```javascript
console.log(process.versions.node)
// 输出: "16.17.x" (Electron 内置的版本)
```

---

## ❓ 常见误解

### 误解 1: "Node 18 是为了兼容 Windows 7"

**错误！** 

Windows 7 兼容性取决于 **Electron 版本**：
- Electron 22 ✅ 支持 Windows 7
- Electron 23+ ❌ 不支持 Windows 7

与 GitHub Actions 使用的 Node.js 版本 **完全无关**。

### 误解 2: "必须使用与 Electron 内置相同的 Node 版本"

**错误！**

开发环境和运行环境是分离的：
```
开发时: 系统 Node 20 → 构建应用
运行时: Electron 内置 Node 16 → 运行应用
```

两者可以完全不同！

### 误解 3: "GitHub 要求必须用 Node 24"

**不准确！**

- GitHub Actions **支持** Node 24
- 但 **不要求** 必须使用
- Node 20 完全符合要求
- Node 24 太新，可能有兼容性问题

---

## 🎯 版本选择建议

### 对于您的项目（Electron 22 + Windows 7 支持）

#### 开发环境（GitHub Actions）
```yaml
node-version: '20'  # ✅ 推荐
```

**理由**:
- Active LTS，稳定可靠
- 兼容所有依赖
- 支持到 2026 年
- 不是太新也不是太旧

#### 运行时（Electron 内置）
```json
{
  "devDependencies": {
    "electron": "^22.3.27"  // 内置 Node 16
  }
}
```

**保持不变**，因为需要 Windows 7 支持。

---

## 🔄 如果未来升级 Electron

### 场景 1: 放弃 Windows 7 支持

升级到 Electron 28+：
```json
{
  "devDependencies": {
    "electron": "^28.3.3"  // 内置 Node 18
  }
}
```

GitHub Actions 仍可使用 Node 20。

### 场景 2: 升级到最新 Electron

升级到 Electron 41+：
```json
{
  "devDependencies": {
    "electron": "^41.1.1"  // 内置 Node 24
  }
}
```

此时可以考虑将 GitHub Actions 也升级到 Node 22 或 24。

---

## 📊 版本对照表

### Electron 与内置 Node.js 对应关系

| Electron | Chromium | Node.js | Windows 7 |
|----------|----------|---------|-----------|
| 22.x | 108 | 16.17 | ✅ 支持 |
| 23-27.x | 110-118 | 16.18-18.x | ❌ 不支持 |
| 28.x | 120 | 18.18 | ❌ 不支持 |
| 35.x | 134 | 20.x | ❌ 不支持 |
| 41.x | 146 | 24.x | ❌ 不支持 |

### Node.js LTS 时间表

| 版本 | 类型 | 发布 | Active LTS | Maintenance | EOL |
|------|------|------|------------|-------------|-----|
| 16 | LTS | 2021-04 | 2021-10 | 2023-09 | 2023-09 |
| 18 | LTS | 2022-04 | 2022-10 | 2024-04 | **2025-04** |
| **20** | **LTS** | **2023-04** | **2023-10** | **2025-04** | **2026-04** |
| 22 | Current | 2024-04 | 2024-10 | 2026-04 | 2027-04 |
| 24 | Current | 2025-04 | 2025-10 | 2027-04 | 2028-04 |

---

## ✅ 最终配置

### package.json
```json
{
  "devDependencies": {
    "@types/node": "^20.19.39",  // TypeScript 类型定义（可以是任何版本）
    "electron": "^22.3.27"       // 运行时（内置 Node 16）
  }
}
```

### .github/workflows/build.yml
```yaml
- name: Setup Node.js
  uses: actions/setup-node@v5
  with:
    node-version: '20'  # 开发环境（用于构建）
    cache: 'pnpm'
```

---

## 🎯 总结

1. **GitHub Actions 的 Node 20**
   - ✅ 用于开发和构建
   - ✅ 与 Windows 7 无关
   - ✅ 当前最佳选择

2. **Electron 内置的 Node 16**
   - ✅ 用于运行时
   - ✅ 决定 Windows 7 兼容性
   - ✅ 保持不变以支持 Win7

3. **两者互不影响**
   - 开发环境可以用新版本
   - 运行环境用 Electron 内置版本
   - 完全独立

---

<div align="center">

**现在您理解了 Node.js 版本的真正含义！** 🎉

</div>

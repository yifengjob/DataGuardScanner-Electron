import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {ScanResultItem, AppConfig, DirectoryNode} from '../types'

export const useAppStore = defineStore('app', () => {
  // 扫描结果
  const scanResults = ref<ScanResultItem[]>([])
  
  // 扫描状态
  const isScanning = ref(false)
  const scannedCount = ref(0)
  const totalCount = ref(0)      // ← 新增：遍历的文件总数
  const errorCount = ref(0)  // ← 修改为 ref，用于记录跳过文件数
  const currentFile = ref('')
  const logs = ref<string[]>([])
  
  // 配置
  const config = ref<AppConfig>({
    selectedPaths: [],
    selectedExtensions: [
      'txt', 'log', 'md', 'ini', 'conf', 'cfg', 'env',
      'js', 'ts', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'php', 'rb', 'swift',
      'csv', 'json', 'xml', 'yaml', 'yml', 'properties', 'toml',
      'pdf',
    ],
    enabledSensitiveTypes: [
      'person_id', 'phone', 'email', 'bank_card', 
      'address', 'ip_address', 'password'
    ],
    ignoreDirNames: ['node_modules', '.git', 'System Volume Information'],
    systemDirs: [], // 会在加载配置时从后端获取
    maxFileSizeMb: 50,
    maxPdfSizeMb: 100,
    scanConcurrency: 0, // 0 表示使用默认值（根据 CPU 动态计算）
    theme: 'system',
    language: 'zh-CN',
    enableExperimentalParsers: false,
    enableOfficeParsers: true,
    deleteToTrash: false, // 默认永久删除
    ignoreOtherDrivesSystemDirs: false, // 默认不忽略其他磁盘的系统目录（即会扫描）
  })
  
  // 目录树选中状态
  const selectedPaths = ref<Set<string>>(new Set())
  
  // 计算属性
  const sensitiveFilesCount = computed(() => scanResults.value.length)
  const totalSensitiveItems = computed(() => 
    scanResults.value.reduce((sum, item) => sum + item.total, 0)
  )
  
  // 获取节点的选择状态：'checked' | 'unchecked' | 'indeterminate'
  function getNodeCheckState(nodePath: string, allNodes: Map<string, DirectoryNode>): 'checked' | 'unchecked' | 'indeterminate' {
    // 根据路径格式自动判断分隔符
    const separator = nodePath.includes('\\') ? '\\' : '/'
    
    // 查找所有直接子节点（只找一层）
    const directChildren = Array.from(allNodes.values()).filter(n => {
      // 必须是子节点（路径以 nodePath + separator 开头）
      if (!n.path.startsWith(nodePath + separator)) return false
      
      // 排除更深层的子孙节点（路径中只能有一个额外的 separator）
      const relativePath = n.path.substring(nodePath.length + 1)
      return !relativePath.includes(separator)
    })
    
    if (directChildren.length === 0) {
      // 叶子节点，直接返回自身状态
      return selectedPaths.value.has(nodePath) ? 'checked' : 'unchecked'
    }
    
    // 递归检查每个直接子节点的状态
    let checkedCount = 0
    let uncheckedCount = 0
    
    for (const child of directChildren) {
      const childState = getNodeCheckState(child.path, allNodes)
      if (childState === 'checked') {
        checkedCount++
      } else if (childState === 'unchecked') {
        uncheckedCount++
      } else {
        // 有子节点是半选，父节点也应该是半选
        return 'indeterminate'
      }
    }
    
    // 根据直接子节点的状态决定
    if (checkedCount === 0) {
      return 'unchecked'
    } else if (checkedCount === directChildren.length) {
      return 'checked'
    } else {
      return 'indeterminate'
    }
  }
  
  // 方法
  function addScanResult(item: ScanResultItem) {
    scanResults.value.push(item)
  }
  
  function clearScanResults() {
    scanResults.value = []
    scannedCount.value = 0
    totalCount.value = 0      // ← 重置总数
    errorCount.value = 0  // ← 重置跳过文件数
    logs.value = []
  }
  
  function removeResult(filePath: string) {
    const index = scanResults.value.findIndex(r => r.filePath === filePath)
    if (index !== -1) {
      scanResults.value.splice(index, 1)
    }
  }
  
  function togglePath(path: string) {
    if (selectedPaths.value.has(path)) {
      selectedPaths.value.delete(path)
    } else {
      selectedPaths.value.add(path)
    }
  }
  
  // 智能切换节点（考虑父子关系）
  function smartToggleNode(nodePath: string, allNodes: Map<string, DirectoryNode>) {
    const currentState = getNodeCheckState(nodePath, allNodes)
    
    // 根据路径格式自动判断分隔符
    const separator = nodePath.includes('\\') ? '\\' : '/'
    
    if (currentState === 'checked' || currentState === 'indeterminate') {
      // ===== 取消选中：删除自己和所有子孙节点 =====
      selectedPaths.value.delete(nodePath)
      
      // 删除所有子孙节点（包括已加载和通过路径推断的）
      Array.from(selectedPaths.value).forEach(path => {
        if (path.startsWith(nodePath + separator)) {
          selectedPaths.value.delete(path)
        }
      })
    } else {
      // ===== 选中：添加自己和所有已加载的子孙节点 =====
      selectedPaths.value.add(nodePath)
      
      // 添加所有已加载的子孙节点（用于 UI 显示）
      Array.from(allNodes.values()).forEach(n => {
        if (n.path.startsWith(nodePath + separator)) {
          selectedPaths.value.add(n.path)
        }
      })
    }
  }
  
  function selectAllPaths(paths: string[]) {
    paths.forEach(p => selectedPaths.value.add(p))
  }
  
  function deselectAllPaths() {
    selectedPaths.value.clear()
  }
  
  // 全选所有目录
  function selectAllDirectories(allNodes: DirectoryNode[]) {
    allNodes.filter(n => n.isDir).forEach(n => {
      selectedPaths.value.add(n.path)
    })
  }
  
  // 全不选
  function deselectAllDirectories() {
    selectedPaths.value.clear()
  }
  
  // 获取有效的扫描路径（只保留叶子节点，避免重复扫描）
  // 例如：如果 C:\Users 和 C:\Users\John 都选中了，只返回 C:\Users\John
  function getEffectiveScanPaths(): string[] {
    const paths = Array.from(selectedPaths.value)
    
    // 按路径长度排序（短的在前）
    paths.sort((a, b) => a.length - b.length)
    
    const effectivePaths: string[] = []
    
    for (const path of paths) {
      // 检查这个路径是否是其他已选路径的祖先
      // 根据路径格式自动判断分隔符
      const separator = path.includes('\\') ? '\\' : '/'
      const hasDescendantSelected = paths.some(otherPath => 
        otherPath !== path && otherPath.startsWith(path + separator)
      )
      
      // 如果没有子孙节点被选中，则这是一个有效的扫描路径
      if (!hasDescendantSelected) {
        effectivePaths.push(path)
      }
    }
    
    return effectivePaths
  }
  
  return {
    scanResults,
    isScanning,
    scannedCount,
    totalCount,      // ← 导出总数
    currentFile,
    logs,
    config,
    selectedPaths,
    sensitiveFilesCount,
    errorCount,
    totalSensitiveItems,
    addScanResult,
    clearScanResults,
    removeResult,
    togglePath,
    smartToggleNode,
    getNodeCheckState,
    selectAllPaths,
    deselectAllPaths,
    selectAllDirectories,
    deselectAllDirectories,
    getEffectiveScanPaths,
  }
})

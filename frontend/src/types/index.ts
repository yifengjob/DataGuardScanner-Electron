export interface DirectoryNode {
  path: string
  name: string
  isDir: boolean
  isHidden: boolean
  hasChildren: boolean
  children?: DirectoryNode[]
}

export interface ScanConfig {
  selectedPaths: string[]
  selectedExtensions: string[]
  enabledSensitiveTypes: string[]
  ignoreDirNames: string[]           // 忽略目录名（任意位置）
  systemDirs: string[]                // 系统目录完整路径
  maxFileSizeMb: number
  maxPdfSizeMb: number
  scanConcurrency: number
}

export interface ScanResultItem {
  filePath: string
  fileSize: number
  modifiedTime: string
  counts: Record<string, number>
  total: number
  unsupportedPreview: boolean
}

export interface HighlightRange {
  start: number
  end: number
  type_id: string
  type_name: string
}

export interface PreviewResult {
  content: string
  highlights: HighlightRange[]
}

export interface AppConfig {
  selectedPaths: string[]
  selectedExtensions: string[]
  enabledSensitiveTypes: string[]
  ignoreDirNames: string[]           // 忽略目录名（任意位置）
  systemDirs: string[]                // 系统目录完整路径
  maxFileSizeMb: number
  maxPdfSizeMb: number
  scanConcurrency: number
  theme: string
  language: string
  enableExperimentalParsers: boolean
  enableOfficeParsers: boolean
  deleteToTrash: boolean
}

export interface SensitiveRule {
  id: string
  name: string
  enabled_by_default: boolean
}

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { AppConfig } from './types';

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

export function getDefaultConfig(): AppConfig {
  const ignoreDirNames = [
    'node_modules', '.git', '.svn', '.hg', '.vscode', '.idea',
    'System Volume Information', '.Spotlight-V100', '.fseventsd', '.DS_Store', 'lost+found'
  ];
  
  let systemDirs: string[] = [];
  if (process.platform === 'win32') {
    systemDirs = [
      'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
      'C:\\ProgramData', 'C:\\Recovery', 'C:\\PerfLogs'
    ];
  } else if (process.platform === 'darwin') {
    systemDirs = ['/Applications', '/Library', '/System'];
  } else if (process.platform === 'linux') {
    systemDirs = [
      '/proc', '/sys', '/dev', '/run', '/tmp', '/var', '/etc',
      '/bin', '/sbin', '/lib', '/usr', '/boot', '/mnt',
      '/media', '/opt', '/srv'
    ];
  }
  
  return {
    selectedPaths: [],
    selectedExtensions: ['*'],
    enabledSensitiveTypes: [
      'person_id', 'phone', 'email', 'bank_card',
      'address', 'ip_address', 'password'
    ],
    ignoreDirNames,
    systemDirs,
    maxFileSizeMb: 50,
    maxPdfSizeMb: 100,
    scanConcurrency: 8,
    theme: 'system',
    language: 'zh-CN',
    enableExperimentalParsers: false,
    enableOfficeParsers: true,
    deleteToTrash: false
  };
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = await fs.promises.readFile(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(data);
      return { ...getDefaultConfig(), ...config };
    }
  } catch (error) {
    console.error('加载配置失败:', error);
  }
  
  return getDefaultConfig();
}

export async function saveConfig(config: AppConfig): Promise<void> {
  try {
    const data = JSON.stringify(config, null, 2);
    await fs.promises.writeFile(CONFIG_FILE, data, 'utf-8');
  } catch (error) {
    console.error('保存配置失败:', error);
    throw error;
  }
}

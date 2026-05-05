/**
 * 提取器通用类型定义
 */

export type ExtractorResult = {
  text: string;
  unsupportedPreview: boolean;
};

export type ExtractorFunction = (filePath: string) => Promise<ExtractorResult>;

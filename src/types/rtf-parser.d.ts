declare module 'rtf-parser' {
  interface RTFNode {
    text?: string;
    children?: RTFNode[];
    [key: string]: any;
  }
  
  interface RTFDocument {
    children?: RTFNode[];
    [key: string]: any;
  }
  
  export function string(
    rtfString: string,
    callback: (err: any, doc: RTFDocument) => void
  ): void;
  
  export function stream(): any;
}

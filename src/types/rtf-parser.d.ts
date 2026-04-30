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
  
  export function parseString(
    rtfString: string,
    callback: (err: any, doc: RTFDocument) => void
  ): void;
}

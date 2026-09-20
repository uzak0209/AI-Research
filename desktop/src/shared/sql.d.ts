// schema.sql を文字列として import するための宣言
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

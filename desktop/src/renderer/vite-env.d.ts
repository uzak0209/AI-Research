/// <reference types="vite/client" />

// vite が Worker を別ファイルとして出すための import 形式
declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
